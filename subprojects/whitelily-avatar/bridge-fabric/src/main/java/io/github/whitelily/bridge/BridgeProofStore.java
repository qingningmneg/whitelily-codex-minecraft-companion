package io.github.whitelily.bridge;

import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.IOException;
import java.io.StringReader;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Optional;
import java.util.Set;

public final class BridgeProofStore {
  private static final int MAX_REQUEST_BYTES = 4096;
  private static final Set<String> REQUIRED_KEYS =
      Set.of("schemaVersion", "username", "port", "issuedAt", "expiresAt", "nonce");
  private static volatile Runnable beforeClaimHook;
  private static volatile Runnable beforeSuccessCleanupHook;
  private static volatile Runnable afterRequestRemovalHook;
  private static volatile Runnable afterClaimRemovalHook;

  private final Path root;

  public BridgeProofStore(Path root) {
    this.root = root == null ? null : root.toAbsolutePath().normalize();
  }

  public Optional<BridgeRequest> consume(String nonce, BridgeAuthorizationContext context) {
    if (root == null || !WindowsOwnedFile.isWindows() || !BridgeNonce.isCanonical(nonce)) {
      return Optional.empty();
    }
    try {
      if (!ordinaryAncestorChain(root)) {
        return Optional.empty();
      }
      Path request = root.resolve(digest(nonce) + ".json").normalize();
      if (!request.getParent().equals(root)) {
        return Optional.empty();
      }
      Path claim = request.resolveSibling(request.getFileName() + ".claim");
      Path anchor = request.resolveSibling(request.getFileName() + ".anchor");
      try (WindowsProofHandle proof = WindowsProofHandle.open(request).orElse(null)) {
        if (proof == null
            || ordinaryFile(request) == null
            || !proof.matches(request)
            || !hasLinkCount(proof, 1)) {
          return Optional.empty();
        }
        byte[] bytes = proof.read(MAX_REQUEST_BYTES).orElse(null);
        if (bytes == null) {
          return Optional.empty();
        }
        BridgeRequest parsed = parseStrict(bytes);
        if (parsed == null || !nonce.equals(parsed.nonce())) {
          return Optional.empty();
        }
        Optional<BridgeRequest> authorized = BridgeAuthorizationPolicy.authorize(parsed, context);
        if (authorized.isEmpty()) {
          return Optional.empty();
        }
        Files.createLink(claim, request);
        if (!sameClaimedFile(proof, request, claim, 2)) {
          return Optional.empty();
        }
        try {
          Files.createLink(anchor, claim);
        } catch (FileAlreadyExistsException collision) {
          deleteOwnedLink(proof.identity(), claim, 2);
          return Optional.empty();
        }
        if (!sameClaimedFile(proof, request, claim, anchor, 3)) {
          return Optional.empty();
        }
        runHook(beforeClaimHook);
        if (!sameClaimedFile(proof, request, claim, anchor, 3) || !ordinaryAncestorChain(root)) {
          return Optional.empty();
        }
        runHook(beforeSuccessCleanupHook);
        if (!sameClaimedFile(proof, request, claim, anchor, 3) || !ordinaryAncestorChain(root)) {
          return Optional.empty();
        }
        WindowsOwnedFile.Identity identity = proof.identity();
        if (!proof.deleteIfExactLinkCount(3)) {
          return Optional.empty();
        }
        runHook(afterRequestRemovalHook);
        if (!deleteOwnedLink(identity, claim, 2)) {
          return Optional.empty();
        }
        runHook(afterClaimRemovalHook);
        return deleteOwnedLink(identity, anchor, 1) ? authorized : Optional.empty();
      } catch (FileAlreadyExistsException ignored) {
        return Optional.empty();
      }
    } catch (IOException | RuntimeException ignored) {
      return Optional.empty();
    }
  }

  private static boolean ordinaryAncestorChain(Path path) throws IOException {
    for (Path current = path; current != null; current = current.getParent()) {
      BasicFileAttributes attributes = Files.readAttributes(
          current, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      if (!attributes.isDirectory() || attributes.isSymbolicLink() || attributes.isOther()) {
        return false;
      }
    }
    return true;
  }

  private static BasicFileAttributes ordinaryFile(Path path) throws IOException {
    BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    if (!attributes.isRegularFile()
        || attributes.isSymbolicLink()
        || attributes.isOther()
        || attributes.size() < 1
        || attributes.size() > MAX_REQUEST_BYTES) {
      return null;
    }
    return attributes;
  }

  private static boolean hasLinkCount(WindowsProofHandle proof, int expected) {
    return proof.linkCount().filter(count -> count == expected).isPresent();
  }

  private static boolean sameClaimedFile(
      WindowsProofHandle proof, Path request, Path claim, int expectedLinkCount) throws IOException {
    return ordinaryFile(request) != null
        && ordinaryFile(claim) != null
        && proof.matches(request)
        && proof.matches(claim)
        && hasLinkCount(proof, expectedLinkCount);
  }

  private static boolean sameClaimedFile(
      WindowsProofHandle proof, Path request, Path claim, Path anchor, int expectedLinkCount)
      throws IOException {
    return sameClaimedFile(proof, request, claim, expectedLinkCount)
        && ordinaryFile(anchor) != null
        && proof.matches(anchor)
        && hasLinkCount(proof, expectedLinkCount);
  }

  private static boolean deleteOwnedLink(
      WindowsOwnedFile.Identity expectedIdentity, Path candidate, int expectedLinkCount) {
    try (WindowsProofHandle candidateHandle = WindowsProofHandle.open(candidate).orElse(null)) {
      return candidateHandle != null
          && expectedIdentity.equals(candidateHandle.identity())
          && candidateHandle.deleteIfExactLinkCount(expectedLinkCount);
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  private static void runHook(Runnable hook) {
    if (hook != null) {
      hook.run();
    }
  }

  private static BridgeRequest parseStrict(byte[] bytes) {
    if (hasBom(bytes)) {
      return null;
    }
    String json = decodeUtf8(bytes);
    if (json == null) {
      return null;
    }
    try (JsonReader reader = new JsonReader(new StringReader(json))) {
      reader.setStrictness(Strictness.STRICT);
      if (reader.peek() != JsonToken.BEGIN_OBJECT) {
        return null;
      }
      Long schemaVersion = null;
      String username = null;
      Long port = null;
      Long issuedAt = null;
      Long expiresAt = null;
      String nonce = null;
      Set<String> seen = new HashSet<>();
      reader.beginObject();
      while (reader.hasNext()) {
        String name = reader.nextName();
        if (!REQUIRED_KEYS.contains(name) || !seen.add(name)) {
          return null;
        }
        switch (name) {
          case "schemaVersion" -> schemaVersion = nextCanonicalLong(reader);
          case "username" -> username = nextString(reader);
          case "port" -> port = nextCanonicalLong(reader);
          case "issuedAt" -> issuedAt = nextCanonicalLong(reader);
          case "expiresAt" -> expiresAt = nextCanonicalLong(reader);
          case "nonce" -> nonce = nextString(reader);
          default -> throw new IllegalStateException("validated key");
        }
      }
      reader.endObject();
      if (!seen.equals(REQUIRED_KEYS)
          || reader.peek() != JsonToken.END_DOCUMENT
          || schemaVersion == null
          || username == null
          || port == null
          || issuedAt == null
          || expiresAt == null
          || nonce == null
          || schemaVersion > Integer.MAX_VALUE
          || port > Integer.MAX_VALUE) {
        return null;
      }
      return new BridgeRequest(schemaVersion.intValue(), username, port.intValue(), issuedAt, expiresAt, nonce);
    } catch (IOException | IllegalStateException ignored) {
      return null;
    }
  }

  private static Long nextCanonicalLong(JsonReader reader) throws IOException {
    if (reader.peek() != JsonToken.NUMBER) {
      return null;
    }
    String literal = reader.nextString();
    if (!literal.matches("0|[1-9][0-9]*")) {
      return null;
    }
    try {
      return Long.parseLong(literal);
    } catch (NumberFormatException ignored) {
      return null;
    }
  }

  private static String nextString(JsonReader reader) throws IOException {
    return reader.peek() == JsonToken.STRING ? reader.nextString() : null;
  }

  private static String decodeUtf8(byte[] bytes) {
    CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT);
    try {
      return decoder.decode(ByteBuffer.wrap(bytes)).toString();
    } catch (CharacterCodingException ignored) {
      return null;
    }
  }

  private static boolean hasBom(byte[] bytes) {
    return (bytes.length >= 3 && bytes[0] == (byte) 0xef && bytes[1] == (byte) 0xbb && bytes[2] == (byte) 0xbf)
        || (bytes.length >= 2 && bytes[0] == (byte) 0xff && bytes[1] == (byte) 0xfe)
        || (bytes.length >= 2 && bytes[0] == (byte) 0xfe && bytes[1] == (byte) 0xff);
  }

  private static String digest(String nonce) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(nonce.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
}
