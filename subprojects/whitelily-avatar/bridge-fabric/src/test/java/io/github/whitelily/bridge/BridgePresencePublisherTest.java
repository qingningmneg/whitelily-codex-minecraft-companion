package io.github.whitelily.bridge;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.lang.reflect.Field;
import java.time.Duration;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BridgePresencePublisherTest {
  @TempDir Path temporaryDirectory;

  @Test
  void publishesTheExactVersionedPresenceDocumentUnderThePidFilename() throws Exception {
    Optional<BridgePresencePublisher> opened =
        assertTimeoutPreemptively(
            Duration.ofSeconds(2),
            () ->
                BridgePresencePublisher.publish(
                    temporaryDirectory, 42_001, 1_725_000_000_123L, 1_725_000_005_678L));

    assertTrue(opened.isPresent());
    Path presence = temporaryDirectory.resolve("42001.json");
    assertEquals(Set.of("42001.json"), fileNames(temporaryDirectory));
    JsonObject document = JsonParser.parseString(Files.readString(presence, UTF_8)).getAsJsonObject();
    assertEquals(
        Set.of(
            "schemaVersion",
            "pid",
            "processStartEpochMs",
            "minecraftVersion",
            "bridgeVersion",
            "writtenAt"),
        document.keySet());
    assertEquals(1, document.get("schemaVersion").getAsInt());
    assertEquals(42_001, document.get("pid").getAsLong());
    assertEquals(1_725_000_000_123L, document.get("processStartEpochMs").getAsLong());
    assertEquals("1.21.5", document.get("minecraftVersion").getAsString());
    assertEquals("0.1.0", document.get("bridgeVersion").getAsString());
    assertEquals(1_725_000_005_678L, document.get("writtenAt").getAsLong());

    opened.orElseThrow().close();
    assertFalse(Files.exists(presence, LinkOption.NOFOLLOW_LINKS));
  }

  @Test
  void anExistingOrdinaryFileIsNeverOverwrittenOrDeleted() throws Exception {
    Path collision = temporaryDirectory.resolve("42001.json");
    Files.writeString(collision, "foreign", UTF_8, StandardOpenOption.CREATE_NEW);

    assertTrue(
        BridgePresencePublisher.publish(
                temporaryDirectory, 42_001, 1_725_000_000_123L, 1_725_000_005_678L)
            .isEmpty());
    assertEquals("foreign", Files.readString(collision, UTF_8));
    assertEquals(Set.of("42001.json"), fileNames(temporaryDirectory));
  }

  @Test
  void aPreexistingSymbolicLinkIsRejectedAndPreservedWhenAvailable() throws Exception {
    Path foreign = temporaryDirectory.resolve("foreign.json");
    Files.writeString(foreign, "foreign", UTF_8, StandardOpenOption.CREATE_NEW);
    Path link = temporaryDirectory.resolve("42001.json");
    try {
      Files.createSymbolicLink(link, foreign);
    } catch (FileSystemException | UnsupportedOperationException unavailable) {
      Assumptions.abort("symbolic-link privilege unavailable");
    }

    assertTrue(
        BridgePresencePublisher.publish(
                temporaryDirectory, 42_001, 1_725_000_000_123L, 1_725_000_005_678L)
            .isEmpty());
    assertTrue(Files.isSymbolicLink(link));
    assertEquals("foreign", Files.readString(foreign, UTF_8));
  }

  @Test
  void aLinkedPresenceDirectoryIsRejectedWithoutWritingThroughIt() throws Exception {
    Path target = Files.createDirectory(temporaryDirectory.resolve("target"));
    Path link = temporaryDirectory.resolve("presence-link");
    try {
      Files.createSymbolicLink(link, target);
    } catch (FileSystemException | UnsupportedOperationException unavailable) {
      Assumptions.abort("symbolic-link privilege unavailable");
    }

    assertTrue(
        BridgePresencePublisher.publish(link, 42_001, 1_725_000_000_123L, 1_725_000_005_678L)
            .isEmpty());
    assertEquals(Set.of(), fileNames(target));
    assertTrue(Files.isSymbolicLink(link));
  }

  @Test
  void aWindowsDirectoryJunctionIsRejectedWithoutWritingThroughIt() throws Exception {
    Path target = Files.createDirectory(temporaryDirectory.resolve("junction-target"));
    Path junction = temporaryDirectory.resolve("presence-junction");
    Process process =
        new ProcessBuilder(
                "cmd.exe", "/c", "mklink", "/J", junction.toString(), target.toString())
            .start();
    assertTrue(process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS));
    Assumptions.assumeTrue(process.exitValue() == 0, "directory junction unavailable");
    try {
      assertTrue(
          BridgePresencePublisher.publish(
                  junction, 42_001, 1_725_000_000_123L, 1_725_000_005_678L)
              .isEmpty());
      assertEquals(Set.of(), fileNames(target));
    } finally {
      Files.deleteIfExists(junction);
    }
  }

  @Test
  void closePreservesAReplacementAndEveryUnrelatedFile() throws Exception {
    Path unrelated = temporaryDirectory.resolve("unrelated.json");
    Files.writeString(unrelated, "unrelated", UTF_8, StandardOpenOption.CREATE_NEW);
    BridgePresencePublisher publisher =
        BridgePresencePublisher.publish(
                temporaryDirectory, 42_001, 1_725_000_000_123L, 1_725_000_005_678L)
            .orElseThrow();
    Path owned = temporaryDirectory.resolve("42001.json");
    Path replacement = temporaryDirectory.resolve("replacement.json");
    Files.writeString(replacement, "replacement", UTF_8, StandardOpenOption.CREATE_NEW);
    Files.delete(owned);
    Files.move(replacement, owned, StandardCopyOption.ATOMIC_MOVE);

    publisher.close();
    publisher.close();

    assertEquals("replacement", Files.readString(owned, UTF_8));
    assertEquals("unrelated", Files.readString(unrelated, UTF_8));
    assertEquals(Set.of("42001.json", "unrelated.json"), fileNames(temporaryDirectory));
  }

  @Test
  void publicationPreservesAReplacementAtTheFinalIdentityBoundary() throws Exception {
    Path presence = temporaryDirectory.resolve("42001.json");
    Path replacement = temporaryDirectory.resolve("replacement.json");
    Files.writeString(replacement, "replacement", UTF_8, StandardOpenOption.CREATE_NEW);
    Field hook = BridgePresencePublisher.class.getDeclaredField("beforePresenceIdentityHook");
    hook.setAccessible(true);
    hook.set(
        null,
        (Runnable)
            () -> {
              try {
                Files.delete(presence);
                Files.move(replacement, presence, StandardCopyOption.ATOMIC_MOVE);
              } catch (java.io.IOException failure) {
                throw new RuntimeException(failure);
              }
            });
    try {
      assertTrue(
          BridgePresencePublisher.publish(
                  temporaryDirectory, 42_001, 1_725_000_000_123L, 1_725_000_005_678L)
              .isEmpty());
      assertEquals("replacement", Files.readString(presence, UTF_8));
    } finally {
      hook.set(null, null);
    }
  }

  @Test
  void publicationNeverDeletesFilesFromAReplacementDirectory() throws Exception {
    Path presenceRoot = Files.createDirectory(temporaryDirectory.resolve("presence-root"));
    Path originalRoot = temporaryDirectory.resolve("original-root");
    Path foreignSource = presenceRoot.resolve("foreign-source.json");
    Path foreignPresence = presenceRoot.resolve("42001.json");
    Path foreignTemporary = presenceRoot.resolve(".42001.json.tmp");
    Field hook = BridgePresencePublisher.class.getDeclaredField("beforeLinkIdentityHook");
    hook.setAccessible(true);
    hook.set(
        null,
        (Runnable)
            () -> {
              try {
                Files.move(presenceRoot, originalRoot, StandardCopyOption.ATOMIC_MOVE);
                Files.createDirectory(presenceRoot);
                Files.writeString(
                    foreignSource, "foreign", UTF_8, StandardOpenOption.CREATE_NEW);
                Files.createLink(foreignPresence, foreignSource);
                Files.createLink(foreignTemporary, foreignSource);
              } catch (java.io.IOException failure) {
                throw new RuntimeException(failure);
              }
            });
    try {
      assertTrue(
          BridgePresencePublisher.publish(
                  presenceRoot, 42_001, 1_725_000_000_123L, 1_725_000_005_678L)
              .isEmpty());
      assertEquals("foreign", Files.readString(foreignPresence, UTF_8));
      assertEquals("foreign", Files.readString(foreignTemporary, UTF_8));
    } finally {
      hook.set(null, null);
    }
  }

  private static Set<String> fileNames(Path root) throws Exception {
    try (var files = Files.list(root)) {
      return files.map(path -> path.getFileName().toString()).collect(java.util.stream.Collectors.toSet());
    }
  }
}
