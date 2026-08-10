package io.github.whitelily.bridge;

import com.sun.jna.platform.win32.Kernel32;
import com.sun.jna.platform.win32.WinBase.FILE_DISPOSITION_INFO;
import com.sun.jna.platform.win32.WinBase.FILE_STANDARD_INFO;
import com.sun.jna.platform.win32.WinDef.DWORD;
import com.sun.jna.platform.win32.WinNT;
import com.sun.jna.platform.win32.WinNT.HANDLE;
import com.sun.jna.ptr.IntByReference;
import java.nio.file.Path;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

final class WindowsProofHandle implements AutoCloseable {
  private static final int FILE_STANDARD_INFO_CLASS = 1;
  private static final int FILE_DISPOSITION_INFO_CLASS = 4;
  private static final int SHARING =
      WinNT.FILE_SHARE_READ | WinNT.FILE_SHARE_WRITE | WinNT.FILE_SHARE_DELETE;

  private final HANDLE handle;
  private final WindowsOwnedFile.Identity identity;
  private final AtomicBoolean closed = new AtomicBoolean();

  private WindowsProofHandle(HANDLE handle, WindowsOwnedFile.Identity identity) {
    this.handle = handle;
    this.identity = identity;
  }

  static Optional<WindowsProofHandle> open(Path path) {
    if (!WindowsOwnedFile.isWindows() || path == null) {
      return Optional.empty();
    }
    HANDLE handle =
        Kernel32.INSTANCE.CreateFile(
            path.toString(),
            WinNT.GENERIC_READ | WinNT.FILE_READ_ATTRIBUTES | WinNT.DELETE,
            SHARING,
            null,
            WinNT.OPEN_EXISTING,
            WinNT.FILE_ATTRIBUTE_NORMAL | WinNT.FILE_FLAG_OPEN_REPARSE_POINT,
            null);
    if (WindowsOwnedFile.invalid(handle)) {
      return Optional.empty();
    }
    Optional<WindowsOwnedFile.Identity> identity = WindowsOwnedFile.identity(handle);
    if (identity.isEmpty()) {
      Kernel32.INSTANCE.CloseHandle(handle);
      return Optional.empty();
    }
    return Optional.of(new WindowsProofHandle(handle, identity.orElseThrow()));
  }

  boolean matches(Path path) {
    return identity.equals(WindowsOwnedFile.identity(path, false).orElse(null));
  }

  WindowsOwnedFile.Identity identity() {
    return identity;
  }

  Optional<Integer> linkCount() {
    FILE_STANDARD_INFO information = new FILE_STANDARD_INFO();
    if (!Kernel32.INSTANCE.GetFileInformationByHandleEx(
        handle,
        FILE_STANDARD_INFO_CLASS,
        information.getPointer(),
        new DWORD(information.size()))) {
      return Optional.empty();
    }
    information.read();
    return information.DeletePending || information.Directory || information.NumberOfLinks < 1
        ? Optional.empty()
        : Optional.of(information.NumberOfLinks);
  }

  boolean deleteIfExactLinkCount(int expectedLinkCount) {
    if (!linkCount().filter(count -> count == expectedLinkCount).isPresent()) {
      return false;
    }
    return disposeAndClose();
  }

  Optional<byte[]> read(int maximumBytes) {
    Optional<Integer> size = size();
    if (size.isEmpty() || size.orElseThrow() < 1 || size.orElseThrow() > maximumBytes) {
      return Optional.empty();
    }
    byte[] bytes = new byte[size.orElseThrow()];
    IntByReference read = new IntByReference();
    return Kernel32.INSTANCE.ReadFile(handle, bytes, bytes.length, read, null)
            && read.getValue() == bytes.length
        ? Optional.of(bytes)
        : Optional.empty();
  }

  boolean deleteOwnedFile() {
    return deleteIfExactLinkCount(1);
  }

  private boolean disposeAndClose() {
    if (!closed.compareAndSet(false, true)) {
      return false;
    }
    FILE_DISPOSITION_INFO disposition = new FILE_DISPOSITION_INFO(true);
    disposition.write();
    try {
      return Kernel32.INSTANCE.SetFileInformationByHandle(
          handle,
          FILE_DISPOSITION_INFO_CLASS,
          disposition.getPointer(),
          new DWORD(disposition.size()));
    } finally {
      Kernel32.INSTANCE.CloseHandle(handle);
    }
  }

  @Override
  public void close() {
    if (closed.compareAndSet(false, true)) {
      Kernel32.INSTANCE.CloseHandle(handle);
    }
  }

  private Optional<Integer> size() {
    FILE_STANDARD_INFO information = new FILE_STANDARD_INFO();
    if (!Kernel32.INSTANCE.GetFileInformationByHandleEx(
        handle,
        FILE_STANDARD_INFO_CLASS,
        information.getPointer(),
        new DWORD(information.size()))) {
      return Optional.empty();
    }
    information.read();
    long size = information.EndOfFile.getValue();
    return information.DeletePending
            || information.Directory
            || size < 0
            || size > Integer.MAX_VALUE
        ? Optional.empty()
        : Optional.of((int) size);
  }
}
