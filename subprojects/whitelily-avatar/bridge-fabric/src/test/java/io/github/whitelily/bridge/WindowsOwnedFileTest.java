package io.github.whitelily.bridge;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WindowsOwnedFileTest {
  @TempDir Path temporaryDirectory;

  @Test
  void closeRecordsItsNativeDispositionOutcomeAndLeavesNoOwnedFile() {
    Assumptions.assumeTrue(WindowsOwnedFile.isWindows());
    Path file = temporaryDirectory.resolve("owned.json");
    WindowsOwnedFile owned = WindowsOwnedFile.create(file, "owned".getBytes(UTF_8)).orElseThrow();

    owned.close();

    assertEquals(java.util.Optional.of(true), owned.dispositionResult());
    assertFalse(Files.exists(file));
  }

  @Test
  void collisionFailsWithoutClaimingOrDeletingTheForeignFile() throws Exception {
    Assumptions.assumeTrue(WindowsOwnedFile.isWindows());
    Path file = temporaryDirectory.resolve("collision.json");
    Files.writeString(file, "foreign", UTF_8);

    assertTrue(WindowsOwnedFile.create(file, "owned".getBytes(UTF_8)).isEmpty());
    assertEquals("foreign", Files.readString(file, UTF_8));
  }
}
