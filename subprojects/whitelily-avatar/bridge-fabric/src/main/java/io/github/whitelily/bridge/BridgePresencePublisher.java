package io.github.whitelily.bridge;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

public final class BridgePresencePublisher implements AutoCloseable {
  public static final String MINECRAFT_VERSION = "1.21.5";
  public static final String BRIDGE_VERSION = "0.1.2";

  private static volatile Runnable beforePresenceIdentityHook;
  private static volatile Runnable beforeLinkIdentityHook;
  private static volatile Runnable beforeOwnedHandleCloseHook;

  private final WindowsOwnedFile ownership;
  private final AtomicBoolean closed = new AtomicBoolean();

  private BridgePresencePublisher(WindowsOwnedFile ownership) {
    this.ownership = ownership;
  }

  public static Optional<BridgePresencePublisher> publish(
      Path directory, long pid, long processStartEpochMs, long writtenAt) {
    if (directory == null || pid < 1 || processStartEpochMs < 0 || writtenAt < 0) {
      return Optional.empty();
    }
    Path root = directory.toAbsolutePath().normalize();
    Path presence = root.resolve(pid + ".json").normalize();
    Path temporary = root.resolve("." + pid + ".json.tmp").normalize();
    if (!root.equals(presence.getParent()) || !root.equals(temporary.getParent())) {
      return Optional.empty();
    }

    WindowsOwnedFile ownership = null;
    try {
      WindowsOwnedFile.Identity rootIdentity =
          WindowsOwnedFile.identity(root, true).orElse(null);
      if (ordinaryDirectory(root) == null
          || rootIdentity == null
          || !ordinaryAncestorChain(root)) {
        return Optional.empty();
      }
      byte[] document = document(pid, processStartEpochMs, writtenAt).getBytes(StandardCharsets.UTF_8);
      ownership = WindowsOwnedFile.create(temporary, document).orElse(null);
      if (ownership == null
          || ordinaryFile(temporary) == null
          || !ownership.identity().equals(WindowsOwnedFile.identity(temporary, false).orElse(null))
          || !rootIdentity.equals(WindowsOwnedFile.identity(root, true).orElse(null))
          || !ordinaryAncestorChain(root)) {
        return Optional.empty();
      }
      Files.move(temporary, presence);
      runHook(beforeLinkIdentityHook);
      if (ordinaryFile(presence) == null
          || !rootIdentity.equals(WindowsOwnedFile.identity(root, true).orElse(null))
          || !ordinaryAncestorChain(root)
          || !ownership.identity().equals(WindowsOwnedFile.identity(presence, false).orElse(null))) {
        return Optional.empty();
      }
      runHook(beforePresenceIdentityHook);
      if (ordinaryFile(presence) == null
          || !ownership.identity().equals(WindowsOwnedFile.identity(presence, false).orElse(null))
          || !rootIdentity.equals(WindowsOwnedFile.identity(root, true).orElse(null))
          || !ordinaryAncestorChain(root)) {
        return Optional.empty();
      }
      WindowsOwnedFile publishedOwnership = ownership;
      ownership = null;
      return Optional.of(new BridgePresencePublisher(publishedOwnership));
    } catch (IOException | RuntimeException ignored) {
      return Optional.empty();
    } finally {
      closeOwnedFile(ownership);
    }
  }

  @Override
  public void close() {
    if (closed.compareAndSet(false, true)) {
      try {
        runHook(beforeOwnedHandleCloseHook);
      } finally {
        closeOwnedFile(ownership);
      }
    }
  }

  private static String document(long pid, long processStartEpochMs, long writtenAt) {
    return "{\"schemaVersion\":1,\"pid\":"
        + pid
        + ",\"processStartEpochMs\":"
        + processStartEpochMs
        + ",\"minecraftVersion\":\""
        + MINECRAFT_VERSION
        + "\",\"bridgeVersion\":\""
        + BRIDGE_VERSION
        + "\",\"writtenAt\":"
        + writtenAt
        + "}\n";
  }

  private static boolean ordinaryAncestorChain(Path path) throws IOException {
    for (Path current = path; current != null; current = current.getParent()) {
      if (ordinaryDirectory(current) == null) {
        return false;
      }
    }
    return true;
  }

  private static BasicFileAttributes ordinaryDirectory(Path path) throws IOException {
    BasicFileAttributes attributes =
        Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    return attributes.isDirectory() && !attributes.isSymbolicLink() && !attributes.isOther()
        ? attributes
        : null;
  }

  private static BasicFileAttributes ordinaryFile(Path path) throws IOException {
    BasicFileAttributes attributes =
        Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    return attributes.isRegularFile() && !attributes.isSymbolicLink() && !attributes.isOther()
        ? attributes
        : null;
  }

  private static void runHook(Runnable hook) {
    if (hook != null) {
      hook.run();
    }
  }

  private static void closeOwnedFile(WindowsOwnedFile ownership) {
    if (ownership == null) {
      return;
    }
    ownership.close();
  }
}
