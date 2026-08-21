package io.github.whitelily.avatar.control;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class AvatarModelMailboxTest {
  @Test
  void pollsEachAtomicRequestIdentityOnceAndPublishesAnExactState(@TempDir Path dataRoot)
      throws Exception {
    AvatarModelMailbox mailbox = new AvatarModelMailbox(dataRoot.toAbsolutePath());
    Path bridgeRoot = dataRoot.resolve("bridge").resolve("avatar-model");
    Files.writeString(
        bridgeRoot.resolve("request.json"),
        """
        {"schemaVersion":1,"requestId":"switch-0001","operation":"prepare","modelId":"builtin:whitelily","worldSessionId":"world-0001","candidate":{"modelId":"builtin:whitelily","origin":"builtin","worldRenderer":"minecraft-skin","armModel":"slim"},"issuedAt":"2026-08-21T00:00:00.000Z"}
        """,
        UTF_8);

    AvatarModelControlRequest request = mailbox.poll().orElseThrow();

    assertEquals("switch-0001", request.requestId());
    assertTrue(mailbox.poll().isEmpty());

    mailbox.publish(
        new AvatarModelControlState(
            1,
            request.requestId(),
            AvatarModelPhase.READY,
            "builtin:whitelily",
            request.modelId(),
            request.worldSessionId(),
            null,
            Instant.parse("2026-08-16T08:00:01Z")));

    JsonObject state =
        JsonParser.parseString(Files.readString(bridgeRoot.resolve("state.json"), UTF_8))
            .getAsJsonObject();
    assertEquals(
        Set.of(
            "schemaVersion", "requestId", "phase", "activeModelId", "candidateModelId",
            "worldSessionId", "updatedAt"),
        state.keySet());
    assertEquals("ready", state.get("phase").getAsString());
    try (var entries = Files.list(bridgeRoot)) {
      assertFalse(entries.anyMatch(path -> path.getFileName().toString().endsWith(".tmp")));
    }
  }

  private static Path fixture(String name) {
    return Path.of(System.getProperty("user.dir"), "..", "protocol", "fixtures", name)
        .toAbsolutePath()
        .normalize();
  }
}
