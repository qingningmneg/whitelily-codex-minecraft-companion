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
import java.nio.channels.FileChannel;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

public final class BridgeProofStore {
  private static final int MAX_REQUEST_BYTES = 4096;
  private static final Set<String> REQUIRED_KEYS =
      Set.of("schemaVersion", "username", "port", "issuedAt", "expiresAt", "nonce");

  private final Path root;
  private final AtomicMover mover;

  public BridgeProofStore(Path root) {
    this(root, (source, consumed) -> Files.move(source, consumed, StandardCopyOption.ATOMIC_MOVE));
  }

  // Test-only seam: production composition always uses the atomic Files.move constructor above.
  BridgeProofStore(Path root, AtomicMover mover) {
    this.root = root == null ? null : root.toAbsolutePath().normalize();
    this.mover = mover;
  }

  public Optional<BridgeRequest> consume(String nonce, BridgeAuthorizationContext context) {
    if (root == null || mover == null || !validNonce(nonce)) {
      return Optional.empty();
    }
    try {
      if (!isOrdinaryDirectory(root) || root.getParent() == null || !isOrdinaryDirectory(root.getParent())) {
        return Optional.empty();
      }
      Path request = root.resolve(digest(nonce) + ".json").normalize();
      if (!request.getParent().equals(root)) {
        return Optional.empty();
      }

      BasicFileAttributes original = ordinaryFile(request);
      if (original == null) {
        return Optional.empty();
      }
      byte[] bytes = readStable(request, original);
      if (bytes == null) {
        return Optional.empty();
      }
      BridgeRequest parsed = parseStrict(bytes);
      if (parsed == null || !nonce.equals(parsed.nonce())) {
        return Optional.empty();
      }
      Optional<BridgeRequest> authorized = BridgeAuthorizationPolicy.authorize(parsed, context);
      if (authorized.isEmpty() || !sameFile(original, ordinaryFile(request))) {
        return Optional.empty();
      }

      Path consumed = request.resolveSibling(request.getFileName() + ".consumed");
      Path reservation = consumed.resolveSibling(consumed.getFileName() + ".lock");
      boolean reserved = false;
      boolean moved = false;
      try {
        try (FileChannel ignored = FileChannel.open(
            reservation,
            StandardOpenOption.CREATE_NEW,
            StandardOpenOption.WRITE,
            LinkOption.NOFOLLOW_LINKS)) {
          reserved = true;
        }
        if (Files.exists(consumed, LinkOption.NOFOLLOW_LINKS)) {
          return Optional.empty();
        }
        mover.move(request, consumed);
        moved = true;
        return authorized;
      } catch (AtomicMoveNotSupportedException | java.nio.file.FileAlreadyExistsException ignored) {
        return Optional.empty();
      } finally {
        if (moved) {
          try {
            Files.deleteIfExists(consumed);
          } catch (IOException ignored) {
            // A consumed proof is never approved a second time, even if cleanup is delayed.
          }
        }
        if (reserved) {
          try {
            Files.deleteIfExists(reservation);
          } catch (IOException ignored) {
            // A stale reservation can only deny this one proof, never approve it.
          }
        }
      }
    } catch (IOException | IllegalArgumentException | SecurityException ignored) {
      return Optional.empty();
    }
  }

  private static boolean isOrdinaryDirectory(Path path) throws IOException {
    BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    return attributes.isDirectory() && !attributes.isSymbolicLink() && !attributes.isOther();
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
    BasicFileAttributes after = ordinaryFile(path);
    if (!sameFile(before, after)) {
      return null;
    }
    return bytes.array();
  }

  private static boolean sameFile(BasicFileAttributes expected, BasicFileAttributes actual) {
    return actual != null
        && expected.size() == actual.size()
        && Objects.equals(expected.fileKey(), actual.fileKey());
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
      Integer schemaVersion = null;
      String username = null;
      Integer port = null;
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
          case "schemaVersion" -> schemaVersion = nextInt(reader);
          case "username" -> username = nextString(reader);
          case "port" -> port = nextInt(reader);
          case "issuedAt" -> issuedAt = nextLong(reader);
          case "expiresAt" -> expiresAt = nextLong(reader);
          case "nonce" -> nonce = nextString(reader);
          default -> throw new IllegalStateException("validated key");
        }
      }
      reader.endObject();
      if (!seen.equals(REQUIRED_KEYS) || reader.peek() != JsonToken.END_DOCUMENT) {
        return null;
      }
      if (schemaVersion == null || username == null || port == null || issuedAt == null || expiresAt == null || nonce == null) {
        return null;
      }
      return new BridgeRequest(schemaVersion, username, port, issuedAt, expiresAt, nonce);
    } catch (IOException | IllegalStateException ignored) {
      return null;
    }
  }

  private static Integer nextInt(JsonReader reader) throws IOException {
    return reader.peek() == JsonToken.NUMBER ? reader.nextInt() : null;
  }

  private static Long nextLong(JsonReader reader) throws IOException {
    return reader.peek() == JsonToken.NUMBER ? reader.nextLong() : null;
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

  @FunctionalInterface
  interface AtomicMover {
    void move(Path source, Path consumed) throws IOException;
  }
}
