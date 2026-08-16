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
  void parsesTheReviewedPrepareFixture() throws Exception {
    AvatarModelControlRequest request = codec.read(fixture("prepare-request.json"));

    assertEquals("switch-0001", request.requestId());
    assertEquals(AvatarModelOperation.PREPARE, request.operation());
    assertEquals("builtin:whitelily-hd", request.modelId());
    assertEquals("builtin/whitelily-hd/high.glb", request.candidate().resourcePath());
  }

  @Test
  void rejectsUnknownKeysAndUppercaseDigests(@TempDir Path temporary) throws Exception {
    String fixture = Files.readString(fixture("prepare-request.json"), UTF_8);
    Path unknown = temporary.resolve("unknown.json");
    Files.writeString(
        unknown,
        fixture.replace("\"schemaVersion\": 1,", "\"schemaVersion\": 1,\n  \"extra\": true,"),
        UTF_8);
    Path uppercaseDigest = temporary.resolve("uppercase.json");
    Files.writeString(
        uppercaseDigest,
        fixture.replace("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        UTF_8);

    assertThrows(AvatarModelControlException.class, () -> codec.read(unknown));
    assertThrows(AvatarModelControlException.class, () -> codec.read(uppercaseDigest));
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
            "builtin:whitelily-classic",
            "builtin:whitelily-hd",
            "world-0001",
            null,
            Instant.parse("2026-08-16T08:00:01Z"));

    String encoded = new String(codec.write(state), UTF_8);

    assertTrue(encoded.contains("\"updatedAt\":\"2026-08-16T08:00:01.000Z\""));
  }

  @Test
  void reportsDuplicateBoneNamesAsAStableProtocolError(@TempDir Path temporary)
      throws Exception {
    String fixture = Files.readString(fixture("prepare-request.json"), UTF_8);
    Path duplicateBones = temporary.resolve("duplicate-bones.json");
    Files.writeString(
        duplicateBones,
        fixture.replace("\"neck\": \"Neck\"", "\"neck\": \"Head\""),
        UTF_8);

    AvatarModelControlException error =
        assertThrows(AvatarModelControlException.class, () -> codec.read(duplicateBones));

    assertEquals("AVATAR_CONTROL_INVALID", error.code());
  }

  @Test
  void rejectsATimestampThatTheDesktopWouldCanonicalizeDifferently(@TempDir Path temporary)
      throws Exception {
    String fixture = Files.readString(fixture("prepare-request.json"), UTF_8);
    Path nonCanonicalTime = temporary.resolve("non-canonical-time.json");
    Files.writeString(
        nonCanonicalTime,
        fixture.replace("2026-08-16T08:00:00.000Z", "2026-08-16T08:00:00Z"),
        UTF_8);

    assertThrows(AvatarModelControlException.class, () -> codec.read(nonCanonicalTime));
  }

  private static Path fixture(String name) {
    return Path.of(System.getProperty("user.dir"), "..", "protocol", "fixtures", name)
        .toAbsolutePath()
        .normalize();
  }
}
