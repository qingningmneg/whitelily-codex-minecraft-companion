package io.github.whitelily.avatar.render.gltf;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import io.github.whitelily.avatar.render.backend.AvatarRenderException;
import java.io.IOException;
import java.io.StringReader;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;

public final class GlbDocumentReader {
  private static final int GLB_MAGIC = 0x46546c67;
  private static final int JSON_CHUNK = 0x4e4f534a;
  private static final int BINARY_CHUNK = 0x004e4942;
  private static final long MAX_SOURCE_BYTES = 128L * 1024 * 1024;
  private static final int MAX_JSON_BYTES = 8 * 1024 * 1024;
  private static final int MAX_JSON_DEPTH = 128;
  private static final int MAX_JSON_TOKENS = 200_000;

  public GlbMeshDecoder.GlbMesh read(
      Path path,
      String expectedSha256,
      Map<String, String> boneMapping,
      boolean fullExpressions)
      throws AvatarRenderException {
    return read(path, path.toAbsolutePath().normalize().getParent(), expectedSha256, boneMapping, fullExpressions);
  }

  public GlbMeshDecoder.GlbMesh read(
      Path path,
      Path managedRoot,
      String expectedSha256,
      Map<String, String> boneMapping,
      boolean fullExpressions)
      throws AvatarRenderException {
    Objects.requireNonNull(path, "path");
    Objects.requireNonNull(managedRoot, "managedRoot");
    Objects.requireNonNull(expectedSha256, "expectedSha256");
    Objects.requireNonNull(boneMapping, "boneMapping");
    try {
      Path normalizedRoot = managedRoot.toAbsolutePath().normalize();
      Path normalizedPath = path.toAbsolutePath().normalize();
      if (!normalizedPath.startsWith(normalizedRoot)
          || !Files.isRegularFile(normalizedPath, LinkOption.NOFOLLOW_LINKS)) {
        throw failure("AVATAR_GLB_INVALID", "avatar GLB is not a regular file");
      }
      Path realRoot = normalizedRoot.toRealPath(LinkOption.NOFOLLOW_LINKS);
      Path realParent = normalizedPath.getParent().toRealPath();
      if (!realParent.startsWith(realRoot)) {
        throw failure("AVATAR_GLB_INVALID", "avatar GLB escapes the managed root");
      }
      BasicFileAttributes before =
          Files.readAttributes(
              normalizedPath, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      long size = before.size();
      if (size < 28 || size > MAX_SOURCE_BYTES) {
        throw failure("AVATAR_GLB_INVALID", "avatar GLB size is invalid");
      }
      byte[] bytes = readBounded(normalizedPath, before);
      String digest = sha256(bytes);
      if (!digest.equals(expectedSha256)) {
        throw failure("AVATAR_DIGEST_MISMATCH", "avatar GLB digest changed");
      }
      Document document = parse(bytes, digest);
      return new GlbMeshDecoder().decode(document, boneMapping, fullExpressions);
    } catch (AvatarRenderException error) {
      throw error;
    } catch (IOException | RuntimeException error) {
      throw failure("AVATAR_GLB_INVALID", "avatar GLB could not be decoded", error);
    }
  }

  private static Document parse(byte[] bytes, String digest) throws AvatarRenderException {
    cancellationCheckpoint();
    ByteBuffer container = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
    if (container.getInt() != GLB_MAGIC
        || container.getInt() != 2
        || Integer.toUnsignedLong(container.getInt()) != bytes.length) {
      throw failure("AVATAR_GLB_INVALID", "avatar GLB header is invalid");
    }
    byte[] jsonBytes = null;
    byte[] binaryBytes = null;
    while (container.hasRemaining()) {
      cancellationCheckpoint();
      if (container.remaining() < 8) {
        throw failure("AVATAR_GLB_INVALID", "avatar GLB chunk header is truncated");
      }
      int length = container.getInt();
      int type = container.getInt();
      if (length <= 0 || (length & 3) != 0 || length > container.remaining()) {
        throw failure("AVATAR_GLB_INVALID", "avatar GLB chunk length is invalid");
      }
      byte[] chunk = new byte[length];
      container.get(chunk);
      if (type == JSON_CHUNK) {
        if (jsonBytes != null || binaryBytes != null || length > MAX_JSON_BYTES) {
          throw failure("AVATAR_GLB_INVALID", "avatar GLB JSON chunk is invalid");
        }
        jsonBytes = chunk;
      } else if (type == BINARY_CHUNK) {
        if (jsonBytes == null || binaryBytes != null) {
          throw failure("AVATAR_GLB_INVALID", "avatar GLB binary chunk order is invalid");
        }
        binaryBytes = chunk;
      } else {
        throw failure("AVATAR_GLB_INVALID", "avatar GLB contains an unsupported chunk");
      }
    }
    if (jsonBytes == null || binaryBytes == null) {
      throw failure("AVATAR_GLB_INVALID", "avatar GLB required chunks are missing");
    }

    String jsonText;
    try {
      jsonText =
          StandardCharsets.UTF_8
              .newDecoder()
              .onMalformedInput(CodingErrorAction.REPORT)
              .onUnmappableCharacter(CodingErrorAction.REPORT)
              .decode(ByteBuffer.wrap(jsonBytes))
              .toString()
              .stripTrailing();
    } catch (CharacterCodingException error) {
      throw failure("AVATAR_GLB_INVALID", "avatar GLB JSON is not UTF-8", error);
    }
    validateJsonStream(jsonText);
    JsonElement parsed;
    try {
      parsed = JsonParser.parseString(jsonText);
    } catch (RuntimeException error) {
      throw failure("AVATAR_GLB_INVALID", "avatar GLB JSON is invalid", error);
    }
    if (!parsed.isJsonObject()) {
      throw failure("AVATAR_GLB_INVALID", "avatar glTF document is not an object");
    }
    ByteBuffer binary = ByteBuffer.allocateDirect(binaryBytes.length).order(ByteOrder.LITTLE_ENDIAN);
    binary.put(binaryBytes).flip();
    return new Document(parsed.getAsJsonObject(), binary.asReadOnlyBuffer(), digest);
  }

  private static byte[] readBounded(Path path, BasicFileAttributes before)
      throws IOException, AvatarRenderException {
    try (FileChannel channel =
        FileChannel.open(path, java.nio.file.StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
      if (channel.size() != before.size()) {
        throw failure("AVATAR_GLB_INVALID", "avatar GLB changed while being read");
      }
      ByteBuffer output = ByteBuffer.allocate(Math.toIntExact(before.size()));
      while (output.hasRemaining()) {
        cancellationCheckpoint();
        if (channel.read(output) < 0) {
          throw failure("AVATAR_GLB_INVALID", "avatar GLB changed while being read");
        }
      }
      if (channel.read(ByteBuffer.allocate(1)) != -1) {
        throw failure("AVATAR_GLB_INVALID", "avatar GLB changed while being read");
      }
      BasicFileAttributes after =
          Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      if (after.size() != before.size()
          || (before.fileKey() != null && !before.fileKey().equals(after.fileKey()))) {
        throw failure("AVATAR_GLB_INVALID", "avatar GLB identity changed while being read");
      }
      return output.array();
    }
  }

  private static void validateJsonStream(String json) throws AvatarRenderException {
    try {
      JsonReader reader = new JsonReader(new StringReader(json));
      int depth = 0;
      int tokens = 0;
      while (reader.peek() != JsonToken.END_DOCUMENT) {
        if ((tokens & 0x3ff) == 0) cancellationCheckpoint();
        if (++tokens > MAX_JSON_TOKENS) {
          throw failure("AVATAR_GLB_INVALID", "avatar JSON structure is too complex");
        }
        switch (reader.peek()) {
          case BEGIN_ARRAY -> {
            reader.beginArray();
            if (++depth > MAX_JSON_DEPTH) {
              throw failure("AVATAR_GLB_INVALID", "avatar JSON nesting is too deep");
            }
          }
          case END_ARRAY -> {
            reader.endArray();
            depth--;
          }
          case BEGIN_OBJECT -> {
            reader.beginObject();
            if (++depth > MAX_JSON_DEPTH) {
              throw failure("AVATAR_GLB_INVALID", "avatar JSON nesting is too deep");
            }
          }
          case END_OBJECT -> {
            reader.endObject();
            depth--;
          }
          case NAME -> {
            if ("uri".equalsIgnoreCase(reader.nextName())) {
              throw failure("AVATAR_EXTERNAL_RESOURCE", "avatar contains an external resource URI");
            }
          }
          case STRING, NUMBER -> reader.nextString();
          case BOOLEAN -> reader.nextBoolean();
          case NULL -> reader.nextNull();
          default -> throw failure("AVATAR_GLB_INVALID", "avatar JSON token is invalid");
        }
      }
    } catch (AvatarRenderException error) {
      throw error;
    } catch (IOException | RuntimeException error) {
      throw failure("AVATAR_GLB_INVALID", "avatar GLB JSON is invalid", error);
    }
  }

  private static String sha256(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException("SHA-256 unavailable", error);
    }
  }

  static AvatarRenderException failure(String code, String message) {
    return new AvatarRenderException(code, message);
  }

  static AvatarRenderException failure(String code, String message, Throwable cause) {
    return new AvatarRenderException(code, message, cause);
  }

  static void cancellationCheckpoint() throws AvatarRenderException {
    if (Thread.currentThread().isInterrupted()) {
      throw failure("AVATAR_PREPARE_CANCELLED", "avatar preparation was cancelled");
    }
  }

  record Document(JsonObject json, ByteBuffer binary, String digest) {
    Document {
      Objects.requireNonNull(json, "json");
      binary = binary.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN);
      Objects.requireNonNull(digest, "digest");
    }

    @Override
    public ByteBuffer binary() {
      return binary.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN);
    }
  }
}
