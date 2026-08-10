package io.github.whitelily.bridge;

import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.IOException;
import java.io.StringReader;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
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

  private final Path root;

  public BridgeProofStore(Path root) {
    this.root = root == null ? null : root.toAbsolutePath().normalize();
  }

  public Optional<BridgeRequest> consume(String nonce, BridgeAuthorizationContext context) {
    if (root == null || !validNonce(nonce)) {
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
      boolean claimCreated = false;
      boolean anchorCreated = false;
      boolean requestRemoved = false;
      try {
        Files.createLink(claim, request);
        claimCreated = true;
        Files.createLink(anchor, claim);
        anchorCreated = true;
        BasicFileAttributes captured = ordinaryFile(claim);
        if (captured == null || !sameOwnedFile(request, claim, anchor)) {
          return Optional.empty();
        }
        byte[] bytes = readStable(claim, captured);
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
        runHook(beforeClaimHook);
        if (!sameOwnedFile(request, claim, anchor)
            || !sameAttributes(captured, ordinaryFile(claim))
            || !ordinaryAncestorChain(root)
            || !sameOwnedFile(request, claim, anchor)) {
          return Optional.empty();
        }
        Files.delete(request);
        requestRemoved = true;
        if (!deleteSuccessfulPair(claim, anchor)) {
          return Optional.empty();
        }
        return authorized;
      } catch (FileAlreadyExistsException ignored) {
        return Optional.empty();
      } finally {
        if (!requestRemoved) {
          if (anchorCreated) {
            deleteOwnedLink(anchor, claim);
          }
          if (claimCreated) {
            deleteOwnedLink(claim, request);
          }
        }
      }
    } catch (IOException | IllegalArgumentException | SecurityException ignored) {
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

  private static byte[] readStable(Path path, BasicFileAttributes before) throws IOException {
    int size = Math.toIntExact(before.size());
    ByteBuffer bytes = ByteBuffer.allocate(size);
    try (FileChannel channel = FileChannel.open(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
      if (channel.size() != size) {
        return null;
      }
      while (bytes.hasRemaining()) {
        if (channel.read(bytes) < 0) {
          return null;
        }
      }
    }
    return sameAttributes(before, ordinaryFile(path)) ? bytes.array() : null;
  }

  private static boolean sameAttributes(BasicFileAttributes expected, BasicFileAttributes actual) {
    if (actual == null || expected.size() != actual.size()) {
      return false;
    }
    return expected.fileKey() == null || actual.fileKey() == null || expected.fileKey().equals(actual.fileKey());
  }

  private static boolean sameOwnedFile(Path request, Path claim, Path anchor) {
    try {
      return Files.isSameFile(request, claim) && Files.isSameFile(claim, anchor);
    } catch (IOException | SecurityException ignored) {
      return false;
    }
  }

  private static void deleteOwnedLink(Path candidate, Path proof) {
    try {
      if (Files.exists(candidate, LinkOption.NOFOLLOW_LINKS)
          && Files.exists(proof, LinkOption.NOFOLLOW_LINKS)
          && Files.isSameFile(candidate, proof)) {
        Files.delete(candidate);
      }
    } catch (IOException | SecurityException ignored) {
      // A collision or replacement remains in place and blocks reuse.
    }
  }

  private static boolean deleteSuccessfulPair(Path claim, Path anchor) {
    try {
      runHook(beforeSuccessCleanupHook);
      if (!Files.exists(claim, LinkOption.NOFOLLOW_LINKS)
          || !Files.exists(anchor, LinkOption.NOFOLLOW_LINKS)
          || !Files.isSameFile(claim, anchor)) {
        return false;
      }
      Files.delete(claim);
      Files.delete(anchor);
      return true;
    } catch (IOException | SecurityException ignored) {
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

  private static boolean validNonce(String nonce) {
    return nonce != null && nonce.matches("[A-Za-z0-9_-]{43}");
  }

  private static String digest(String nonce) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(nonce.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
}
