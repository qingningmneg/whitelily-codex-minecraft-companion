package io.github.whitelily.bridge;

import com.sun.jna.Pointer;
import com.sun.jna.platform.win32.Kernel32;
import com.sun.jna.platform.win32.WinBase.FILE_DISPOSITION_INFO;
import com.sun.jna.platform.win32.WinBase.FILE_ID_INFO;
import com.sun.jna.platform.win32.WinDef.DWORD;
import com.sun.jna.platform.win32.WinNT;
import com.sun.jna.platform.win32.WinNT.HANDLE;
import com.sun.jna.ptr.IntByReference;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

final class WindowsOwnedFile implements AutoCloseable {
  private static final int FILE_ID_INFO_CLASS = 18;
  private static final int FILE_DISPOSITION_INFO_CLASS = 4;
  private static final int SHARING =
      WinNT.FILE_SHARE_READ | WinNT.FILE_SHARE_WRITE | WinNT.FILE_SHARE_DELETE;

  private final HANDLE handle;
  private final Identity identity;
  private final AtomicBoolean closed = new AtomicBoolean();
  private final AtomicReference<Boolean> dispositionResult = new AtomicReference<>();

  private WindowsOwnedFile(HANDLE handle, Identity identity) {
    this.handle = handle;
    this.identity = identity;
  }

  static Optional<WindowsOwnedFile> create(Path path, byte[] contents) {
    if (!isWindows() || path == null || contents == null) {
      return Optional.empty();
    }
    HANDLE handle =
        Kernel32.INSTANCE.CreateFile(
            path.toString(),
            WinNT.GENERIC_WRITE | WinNT.FILE_READ_ATTRIBUTES | WinNT.DELETE,
            SHARING,
            null,
            WinNT.CREATE_NEW,
            WinNT.FILE_ATTRIBUTE_NORMAL | WinNT.FILE_FLAG_OPEN_REPARSE_POINT,
            null);
    if (invalid(handle)) {
      return Optional.empty();
    }
    boolean accepted = false;
    try {
      IntByReference written = new IntByReference();
      if (!Kernel32.INSTANCE.WriteFile(handle, contents, contents.length, written, null)
          || written.getValue() != contents.length
          || !Kernel32.INSTANCE.FlushFileBuffers(handle)) {
        return Optional.empty();
      }
      Optional<Identity> identity = identity(handle);
      if (identity.isEmpty()) {
        return Optional.empty();
      }
      accepted = true;
      return Optional.of(new WindowsOwnedFile(handle, identity.orElseThrow()));
    } finally {
      if (!accepted) {
        disposeAndClose(handle, null);
      }
    }
  }

  Identity identity() {
    return identity;
  }

  Optional<Boolean> dispositionResult() {
    return Optional.ofNullable(dispositionResult.get());
  }

  static Optional<Identity> identity(Path path, boolean directory) {
    if (!isWindows() || path == null) {
      return Optional.empty();
    }
    int flags = WinNT.FILE_FLAG_OPEN_REPARSE_POINT;
    if (directory) {
      flags |= WinNT.FILE_FLAG_BACKUP_SEMANTICS;
    }
    HANDLE handle =
        Kernel32.INSTANCE.CreateFile(
            path.toString(),
            WinNT.FILE_READ_ATTRIBUTES,
            SHARING,
            null,
            WinNT.OPEN_EXISTING,
            flags,
            null);
    if (invalid(handle)) {
      return Optional.empty();
    }
    try {
      return identity(handle);
    } finally {
      Kernel32.INSTANCE.CloseHandle(handle);
    }
  }

  @Override
  public void close() {
    if (closed.compareAndSet(false, true)) {
      disposeAndClose(handle, dispositionResult);
    }
  }

  static Optional<Identity> identity(HANDLE handle) {
    FILE_ID_INFO information = new FILE_ID_INFO();
    if (!Kernel32.INSTANCE.GetFileInformationByHandleEx(
        handle,
        FILE_ID_INFO_CLASS,
        information.getPointer(),
        new DWORD(information.size()))) {
      return Optional.empty();
    }
    information.read();
    byte[] fileId = new byte[information.FileId.Identifier.length];
    for (int index = 0; index < fileId.length; index++) {
      fileId[index] = information.FileId.Identifier[index].byteValue();
    }
    return Optional.of(new Identity(information.VolumeSerialNumber, fileId));
  }

  private static void disposeAndClose(HANDLE handle, AtomicReference<Boolean> result) {
    FILE_DISPOSITION_INFO disposition = new FILE_DISPOSITION_INFO(true);
    disposition.write();
    try {
      boolean deleted = Kernel32.INSTANCE.SetFileInformationByHandle(
          handle,
          FILE_DISPOSITION_INFO_CLASS,
          disposition.getPointer(),
          new DWORD(disposition.size()));
      if (result != null) {
        result.set(deleted);
      }
    } finally {
      Kernel32.INSTANCE.CloseHandle(handle);
    }
  }

  static boolean invalid(HANDLE handle) {
    return handle == null
        || Pointer.nativeValue(handle.getPointer())
            == Pointer.nativeValue(WinNT.INVALID_HANDLE_VALUE.getPointer());
  }

  static boolean isWindows() {
    return System.getProperty("os.name", "").startsWith("Windows");
  }

  static final class Identity {
    private final long volumeSerialNumber;
    private final byte[] fileId;

    private Identity(long volumeSerialNumber, byte[] fileId) {
      this.volumeSerialNumber = volumeSerialNumber;
      this.fileId = fileId.clone();
    }

    @Override
    public boolean equals(Object other) {
      return other instanceof Identity identity
          && volumeSerialNumber == identity.volumeSerialNumber
          && Arrays.equals(fileId, identity.fileId);
    }

    @Override
    public int hashCode() {
      return 31 * Long.hashCode(volumeSerialNumber) + Arrays.hashCode(fileId);
    }
  }
}
