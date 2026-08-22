package io.github.whitelily.avatar.control;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class AvatarModelControlCodecTest {
  private final AvatarModelControlCodec codec = new AvatarModelControlCodec();

  @Test
  void parsesTheNativeSkinPrepareCandidate(@TempDir Path temporary) throws Exception {
    AvatarModelControlRequest request = codec.read(writeCandidate(temporary, "candidate.json", ""));

    assertEquals("switch-0001", request.requestId());
    assertEquals(AvatarModelOperation.PREPARE, request.operation());
    assertEquals("builtin:whitelily", request.modelId());
    assertEquals("minecraft-skin", request.candidate().worldRenderer());
    assertEquals("slim", request.candidate().armModel());
  }

  @Test
  void parsesPathFreeFinalizeWithinMailboxSchemaVersionOne(@TempDir Path temporary)
      throws Exception {
    Path path = temporary.resolve("finalize.json");
    Files.writeString(
        path,
        """
        {
          "schemaVersion": 1,
          "requestId": "switch-0001",
          "operation": "finalize",
          "modelId": "builtin:whitelily",
          "worldSessionId": "world-0001",
          "issuedAt": "2026-08-21T00:00:02.000Z"
        }
        """,
        UTF_8);

    AvatarModelControlRequest request = codec.read(path);

    assertEquals(1, request.schemaVersion());
    assertEquals(AvatarModelOperation.FINALIZE, request.operation());
    assertEquals(null, request.candidate());
  }

  @Test
  void rejectsCandidatesWithSkinOrLegacy3dFields(@TempDir Path temporary) throws Exception {
    for (String extra :
        new String[] {
          ",\n  \"skinAsset\": \"builtin/whitelily/skin/base.png\"",
          ",\n  \"boneMapping\": {}",
          ",\n  \"bodyAnimation\": \"whitelily-humanoid-v1\"",
          ",\n  \"expressions\": \"full\"",
          ",\n  \"skinAsset\": \"C:/outside.png\""
        }) {
      AvatarModelControlException error =
          assertThrows(
              AvatarModelControlException.class,
              () ->
                  codec.read(
                      writeCandidate(
                          temporary, "candidate-" + extra.hashCode() + ".json", extra)));
      assertEquals("AVATAR_CONTROL_INVALID", error.code());
    }
  }

  @Test
  void rejectsUnknownKeysAndNonNativeSkinCandidates(@TempDir Path temporary) throws Exception {
    Path unknown = writeCandidate(temporary, "unknown.json", ",\n  \"extra\": true");
    Path renderer = temporary.resolve("renderer-invalid.json");
    Files.writeString(
        renderer,
        Files.readString(writeCandidate(temporary, "renderer-source.json", ""), UTF_8)
            .replace("minecraft-skin", "vrm"),
        UTF_8);

    assertThrows(AvatarModelControlException.class, () -> codec.read(unknown));
    assertThrows(AvatarModelControlException.class, () -> codec.read(renderer));
  }

  @Test
  void rejectsTheWideArmModelForBuiltinWhiteLily(@TempDir Path temporary) throws Exception {
    Path candidate = temporary.resolve("wide-arm.json");
    Files.writeString(
        candidate,
        Files.readString(writeCandidate(temporary, "wide-arm-source.json", ""), UTF_8)
            .replace("\"armModel\": \"slim\"", "\"armModel\": \"wide\""),
        UTF_8);

    AvatarModelControlException error =
        assertThrows(AvatarModelControlException.class, () -> codec.read(candidate));

    assertEquals("AVATAR_CONTROL_INVALID", error.code());
  }

  @Test
  void rejectsOversizedAndNonRegularRequestFiles(@TempDir Path temporary) throws Exception {
    Path oversized = temporary.resolve("oversized.json");
    Files.writeString(oversized, " ".repeat(65 * 1024), UTF_8);
    Path directory = temporary.resolve("directory.json");
    Files.createDirectory(directory);

    assertThrows(AvatarModelControlException.class, () -> codec.read(oversized));
    assertThrows(AvatarModelControlException.class, () -> codec.read(directory));
  }

  @Test
  void writesTheCanonicalMillisecondTimestampExpectedByTheDesktopSchema() throws Exception {
    AvatarModelControlState state =
        new AvatarModelControlState(
            1,
            "switch-0001",
            AvatarModelPhase.READY,
            "builtin:whitelily",
            "builtin:whitelily",
            "world-0001",
            null,
            Instant.parse("2026-08-21T00:00:01Z"));

    String encoded = new String(codec.write(state), UTF_8);

    assertTrue(encoded.contains("\"updatedAt\":\"2026-08-21T00:00:01.000Z\""));
  }

  @Test
  void writesTheReversibleVisiblePhaseWithinMailboxSchemaVersionOne() throws Exception {
    AvatarModelControlState state =
        new AvatarModelControlState(
            1,
            "switch-0001",
            AvatarModelPhase.VISIBLE,
            "builtin:whitelily",
            "user:00000000-0000-4000-8000-000000000001",
            "world-0001",
            null,
            Instant.parse("2026-08-21T00:00:01Z"));

    String encoded = new String(codec.write(state), UTF_8);

    assertTrue(encoded.contains("\"schemaVersion\":1"));
    assertTrue(encoded.contains("\"phase\":\"visible\""));
    assertTrue(!encoded.contains("skinAsset"));
  }

  private static Path writeCandidate(Path directory, String name, String candidateExtra)
      throws Exception {
    Path path = directory.resolve(name);
    Files.writeString(
        path,
        """
        {
          "schemaVersion": 1,
          "requestId": "switch-0001",
          "operation": "prepare",
          "modelId": "builtin:whitelily",
          "worldSessionId": "world-0001",
          "candidate": {
            "modelId": "builtin:whitelily",
            "origin": "builtin",
            "worldRenderer": "minecraft-skin",
            "armModel": "slim"%s
          },
          "issuedAt": "2026-08-21T00:00:00.000Z"
        }
        """.formatted(candidateExtra),
        UTF_8);
    return path;
  }
}
