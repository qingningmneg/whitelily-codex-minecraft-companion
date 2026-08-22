package io.github.whitelily.bridge;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.jna.platform.win32.WinNT.HANDLE;
import com.sun.jna.platform.win32.Kernel32;
import com.sun.jna.platform.win32.WinBase.FILE_DISPOSITION_INFO;
import com.sun.jna.platform.win32.WinDef.DWORD;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
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

  @Test
  void proofOpenClosesItsNativeHandleWhenIdentityAcquisitionThrows() throws Exception {
    Assumptions.assumeTrue(WindowsOwnedFile.isWindows());
    Path file = temporaryDirectory.resolve("proof.json");
    Files.writeString(file, "proof", UTF_8);
    AtomicReference<HANDLE> captured = new AtomicReference<>();
    Field seam = WindowsProofHandle.class.getDeclaredField("identityReader");
    seam.setAccessible(true);
    @SuppressWarnings("unchecked")
    Function<HANDLE, Optional<WindowsOwnedFile.Identity>> original =
        (Function<HANDLE, Optional<WindowsOwnedFile.Identity>>) seam.get(null);
    seam.set(
        null,
        (Function<HANDLE, Optional<WindowsOwnedFile.Identity>>)
            handle -> {
              captured.set(handle);
              throw new IllegalStateException("identity failure");
            });
    try {
      IllegalStateException failure =
          assertThrows(IllegalStateException.class, () -> WindowsProofHandle.open(file));
      assertEquals("identity failure", failure.getMessage());
      assertNotNull(captured.get());
      assertTrue(
          WindowsOwnedFile.identity(captured.get()).isEmpty(),
          "the failed open must not leave its native HANDLE valid");
    } finally {
      seam.set(null, original);
    }
  }

  @Test
  void deletePendingHandleRejectsANewHardLinkBeforeItsFinalClose() throws Exception {
    Assumptions.assumeTrue(WindowsOwnedFile.isWindows());
    Path file = temporaryDirectory.resolve("delete-pending.json");
    Path retained = temporaryDirectory.resolve("retained.json");
    Files.writeString(file, "proof", UTF_8);
    WindowsProofHandle proof = WindowsProofHandle.open(file).orElseThrow();
    Field handleField = WindowsProofHandle.class.getDeclaredField("handle");
    handleField.setAccessible(true);
    HANDLE handle = (HANDLE) handleField.get(proof);
    FILE_DISPOSITION_INFO disposition = new FILE_DISPOSITION_INFO(true);
    disposition.write();
    try {
      assertTrue(
          Kernel32.INSTANCE.SetFileInformationByHandle(
              handle, 4, disposition.getPointer(), new DWORD(disposition.size())));
      assertTrue(proof.linkCount().isEmpty(), "delete-pending is not an ordinary live proof");
      assertThrows(java.io.IOException.class, () -> Files.createLink(retained, file));
      assertFalse(Files.exists(retained));
    } finally {
      proof.close();
    }
    assertFalse(Files.exists(file));
  }
}
