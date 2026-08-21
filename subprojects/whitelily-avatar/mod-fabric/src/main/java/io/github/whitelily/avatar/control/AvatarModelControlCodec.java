package io.github.whitelily.avatar.control;

import static java.nio.charset.StandardCharsets.UTF_8;
import static java.nio.file.StandardOpenOption.READ;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.format.DateTimeParseException;
import java.util.Set;
import java.util.regex.Pattern;

public final class AvatarModelControlCodec {
  public static final int MAX_DOCUMENT_BYTES = 64 * 1024;

  private static final Pattern MODEL_ID =
      Pattern.compile(
          "^(?:builtin:whitelily|user:[0-9a-f]{8}-[0-9a-f]{4}-"
              + "[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$");
  private static final Pattern REQUEST_ID = Pattern.compile("^[A-Za-z0-9_-]{1,64}$");
  private static final Pattern WORLD_ID = Pattern.compile("^[A-Za-z0-9_-]{1,128}$");
  private static final Pattern CANONICAL_INSTANT =
      Pattern.compile("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$");
  private static final DateTimeFormatter MILLISECOND_INSTANT =
      new DateTimeFormatterBuilder().appendInstant(3).toFormatter();

  public AvatarModelControlRequest read(Path path) throws AvatarModelControlException {
    byte[] bytes = readBoundedOrdinaryFile(path);
    final JsonObject document;
    try {
      JsonElement parsed = JsonParser.parseString(new String(bytes, UTF_8));
      if (!parsed.isJsonObject()) {
        throw invalid("avatar control request must be an object");
      }
      document = parsed.getAsJsonObject();
    } catch (AvatarModelControlException error) {
      throw error;
    } catch (RuntimeException error) {
      throw new AvatarModelControlException(
          "AVATAR_CONTROL_INVALID", "avatar control request is invalid", error);
    }
    return parseRequest(document);
  }

  public byte[] write(AvatarModelControlState state) throws AvatarModelControlException {
    validateModelId(state.activeModelId());
    validateRequestId(state.requestId());
    validateWorldId(state.worldSessionId());
    if ((state.phase() == AvatarModelPhase.FAILED) != (state.errorCode() != null)
        || (Set.of(
                    AvatarModelPhase.PREPARING,
                    AvatarModelPhase.READY,
                    AvatarModelPhase.VISIBLE,
                    AvatarModelPhase.COMMITTED)
                .contains(state.phase())
            && state.candidateModelId() == null)
        || (state.phase() == AvatarModelPhase.COMMITTED
            && !state.activeModelId().equals(state.candidateModelId()))) {
      throw invalid("avatar state semantics are invalid");
    }
    JsonObject document = new JsonObject();
    document.addProperty("schemaVersion", 1);
    document.addProperty("requestId", state.requestId());
    document.addProperty("phase", state.phase().name().toLowerCase(java.util.Locale.ROOT));
    document.addProperty("activeModelId", state.activeModelId());
    if (state.candidateModelId() != null) {
      validateModelId(state.candidateModelId());
      document.addProperty("candidateModelId", state.candidateModelId());
    }
    document.addProperty("worldSessionId", state.worldSessionId());
    if (state.errorCode() != null) {
      if (!state.errorCode().matches("^AVATAR_[A-Z0-9_]{1,64}$")) {
        throw invalid("avatar state error code is invalid");
      }
      document.addProperty("errorCode", state.errorCode());
    }
    document.addProperty("updatedAt", MILLISECOND_INSTANT.format(state.updatedAt()));
    byte[] bytes = (document + "\n").getBytes(UTF_8);
    if (bytes.length > MAX_DOCUMENT_BYTES) throw invalid("avatar state is too large");
    return bytes;
  }

  private AvatarModelControlRequest parseRequest(JsonObject document)
      throws AvatarModelControlException {
    String operationText = requiredString(document, "operation", 16);
    AvatarModelOperation operation =
        switch (operationText) {
          case "prepare" -> AvatarModelOperation.PREPARE;
          case "commit" -> AvatarModelOperation.COMMIT;
          case "finalize" -> AvatarModelOperation.FINALIZE;
          case "cancel" -> AvatarModelOperation.CANCEL;
          default -> throw invalid("avatar control operation is invalid");
        };
    Set<String> expected =
        operation == AvatarModelOperation.PREPARE
            ? Set.of(
                "schemaVersion", "requestId", "operation", "modelId", "worldSessionId",
                "candidate", "issuedAt")
            : Set.of(
                "schemaVersion", "requestId", "operation", "modelId", "worldSessionId",
                "issuedAt");
    requireKeys(document, expected);
    if (requiredInt(document, "schemaVersion") != 1) {
      throw invalid("avatar control schema version is invalid");
    }
    String requestId = requiredString(document, "requestId", 64);
    String modelId = requiredString(document, "modelId", 64);
    String worldSessionId = requiredString(document, "worldSessionId", 128);
    validateRequestId(requestId);
    validateModelId(modelId);
    validateWorldId(worldSessionId);
    Instant issuedAt = requiredInstant(document, "issuedAt");
    AvatarRuntimeDescriptor candidate = null;
    if (operation == AvatarModelOperation.PREPARE) {
      JsonElement candidateValue = document.get("candidate");
      if (candidateValue == null || !candidateValue.isJsonObject()) {
        throw invalid("avatar candidate is invalid");
      }
      candidate = parseCandidate(candidateValue.getAsJsonObject());
      if (!modelId.equals(candidate.modelId())) {
        throw invalid("avatar candidate model id does not match");
      }
    }
    return new AvatarModelControlRequest(
        1, requestId, operation, modelId, worldSessionId, candidate, issuedAt);
  }

  private AvatarRuntimeDescriptor parseCandidate(JsonObject candidate)
      throws AvatarModelControlException {
    requireKeys(
        candidate,
        Set.of("modelId", "origin", "worldRenderer", "armModel"));
    String modelId = requiredString(candidate, "modelId", 64);
    String origin = requiredString(candidate, "origin", 16);
    String worldRenderer = requiredString(candidate, "worldRenderer", 32);
    String armModel = requiredString(candidate, "armModel", 16);
    validateModelId(modelId);
    if (!Set.of("builtin", "imported").contains(origin)
        || !"minecraft-skin".equals(worldRenderer)
        || !Set.of("slim", "wide").contains(armModel)
        || ("builtin:whitelily".equals(modelId) && !"slim".equals(armModel))) {
      throw invalid("avatar candidate properties are invalid");
    }
    validateCoherentIdentity(modelId, origin);
    return new AvatarRuntimeDescriptor(modelId, origin, worldRenderer, armModel);
  }

  private static byte[] readBoundedOrdinaryFile(Path path)
      throws AvatarModelControlException {
    Path absolute = path.toAbsolutePath().normalize();
    try {
      BasicFileAttributes before =
          Files.readAttributes(
              absolute, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      if (!before.isRegularFile() || before.isSymbolicLink() || before.isOther()
          || before.size() > MAX_DOCUMENT_BYTES
          || !absolute.toRealPath().equals(absolute)) {
        throw invalid("avatar control request is not a bounded ordinary file");
      }
      ByteArrayOutputStream output = new ByteArrayOutputStream((int) before.size());
      try (SeekableByteChannel channel =
          Files.newByteChannel(
              absolute, Set.<OpenOption>of(READ, LinkOption.NOFOLLOW_LINKS))) {
        ByteBuffer buffer = ByteBuffer.allocate(8192);
        while (channel.read(buffer) >= 0) {
          buffer.flip();
          if (output.size() + buffer.remaining() > MAX_DOCUMENT_BYTES) {
            throw invalid("avatar control request is too large");
          }
          output.write(buffer.array(), buffer.position(), buffer.remaining());
          buffer.clear();
        }
      }
      BasicFileAttributes after =
          Files.readAttributes(
              absolute, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      if (!after.isRegularFile()
          || after.isSymbolicLink()
          || after.isOther()
          || !java.util.Objects.equals(before.fileKey(), after.fileKey())
          || before.size() != after.size()) {
        throw invalid("avatar control request changed while reading");
      }
      return output.toByteArray();
    } catch (AvatarModelControlException error) {
      throw error;
    } catch (IOException | RuntimeException error) {
      throw new AvatarModelControlException(
          "AVATAR_CONTROL_INVALID", "avatar control request could not be read", error);
    }
  }

  private static void validateCoherentIdentity(String modelId, String origin)
      throws AvatarModelControlException {
    boolean coherent;
    if (modelId.equals("builtin:whitelily")) {
      coherent = origin.equals("builtin");
    } else {
      coherent = origin.equals("imported");
    }
    if (!coherent) throw invalid("avatar candidate identity is incoherent");
  }

  private static void validateModelId(String value) throws AvatarModelControlException {
    if (value == null || !MODEL_ID.matcher(value).matches()) {
      throw invalid("avatar model id is invalid");
    }
  }

  private static void validateRequestId(String value) throws AvatarModelControlException {
    if (value == null || !REQUEST_ID.matcher(value).matches()) {
      throw invalid("avatar request id is invalid");
    }
  }

  private static void validateWorldId(String value) throws AvatarModelControlException {
    if (value == null || !WORLD_ID.matcher(value).matches()) {
      throw invalid("avatar world session id is invalid");
    }
  }

  private static void requireKeys(JsonObject object, Set<String> expected)
      throws AvatarModelControlException {
    if (!object.keySet().equals(expected)) throw invalid("avatar control keys are invalid");
  }

  private static int requiredInt(JsonObject object, String key)
      throws AvatarModelControlException {
    try {
      JsonElement value = object.get(key);
      if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
        throw invalid("avatar control number is invalid");
      }
      return value.getAsInt();
    } catch (AvatarModelControlException error) {
      throw error;
    } catch (RuntimeException error) {
      throw invalid("avatar control number is invalid");
    }
  }

  private static String requiredString(JsonObject object, String key, int maximumCodePoints)
      throws AvatarModelControlException {
    try {
      JsonElement value = object.get(key);
      if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
        throw invalid("avatar control string is invalid");
      }
      String text = value.getAsString();
      if (text.isEmpty()
          || text.codePointCount(0, text.length()) > maximumCodePoints
          || text.codePoints().anyMatch(codePoint -> codePoint < 0x20 || codePoint == 0x7f)) {
        throw invalid("avatar control string is invalid");
      }
      return text;
    } catch (AvatarModelControlException error) {
      throw error;
    } catch (RuntimeException error) {
      throw invalid("avatar control string is invalid");
    }
  }

  private static Instant requiredInstant(JsonObject object, String key)
      throws AvatarModelControlException {
    String value = requiredString(object, key, 64);
    if (!CANONICAL_INSTANT.matcher(value).matches()) {
      throw invalid("avatar control timestamp is invalid");
    }
    try {
      return Instant.parse(value);
    } catch (DateTimeParseException error) {
      throw new AvatarModelControlException(
          "AVATAR_CONTROL_INVALID", "avatar control timestamp is invalid", error);
    }
  }

  private static AvatarModelControlException invalid(String message) {
    return new AvatarModelControlException("AVATAR_CONTROL_INVALID", message);
  }
}
