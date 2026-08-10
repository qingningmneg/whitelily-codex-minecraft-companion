package io.github.whitelily.bridge;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

public final class BridgePresencePublisher implements AutoCloseable {
  public static final String MINECRAFT_VERSION = "1.21.5";
  public static final String BRIDGE_VERSION = "0.1.0";

  private static volatile Runnable beforePresenceIdentityHook;
  private static volatile Runnable beforeLinkIdentityHook;

  private final Path presence;
  private final BasicFileAttributes identity;
  private final AtomicBoolean closed = new AtomicBoolean();

  private BridgePresencePublisher(Path presence, BasicFileAttributes identity) {
    this.presence = presence;
    this.identity = identity;
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

    BasicFileAttributes temporaryIdentity = null;
    try {
      BasicFileAttributes rootIdentity = ordinaryDirectory(root);
      if (rootIdentity == null || !ordinaryAncestorChain(root)) {
        return Optional.empty();
      }
      byte[] document = document(pid, processStartEpochMs, writtenAt).getBytes(StandardCharsets.UTF_8);
      try (FileChannel channel =
          FileChannel.open(
              temporary,
              StandardOpenOption.CREATE_NEW,
              StandardOpenOption.WRITE,
              LinkOption.NOFOLLOW_LINKS)) {
        ByteBuffer bytes = ByteBuffer.wrap(document);
        while (bytes.hasRemaining()) {
          channel.write(bytes);
        }
        channel.force(true);
      }
      temporaryIdentity = ordinaryFile(temporary);
      if (temporaryIdentity == null
          || !sameDirectoryIdentity(rootIdentity, ordinaryDirectory(root))
          || !ordinaryAncestorChain(root)) {
        return Optional.empty();
      }
      Files.createLink(presence, temporary);
      runHook(beforeLinkIdentityHook);
      if (!sameDirectoryIdentity(rootIdentity, ordinaryDirectory(root))
          || !ordinaryAncestorChain(root)
          || !sameIdentity(temporaryIdentity, ordinaryFile(temporary))
          || !sameIdentity(temporaryIdentity, ordinaryFile(presence))
          || !Files.isSameFile(presence, temporary)) {
        return Optional.empty();
      }
      deleteIfOwned(temporary, temporaryIdentity);
      if (Files.exists(temporary, LinkOption.NOFOLLOW_LINKS)) {
        return Optional.empty();
      }
      runHook(beforePresenceIdentityHook);
      BasicFileAttributes presenceIdentity = ordinaryFile(presence);
      if (!sameIdentity(temporaryIdentity, presenceIdentity)
          || !sameDirectoryIdentity(rootIdentity, ordinaryDirectory(root))
          || !ordinaryAncestorChain(root)) {
        deleteIfOwned(presence, temporaryIdentity);
        return Optional.empty();
      }
      return Optional.of(new BridgePresencePublisher(presence, temporaryIdentity));
    } catch (FileAlreadyExistsException ignored) {
      return Optional.empty();
    } catch (IOException | SecurityException ignored) {
      return Optional.empty();
    } finally {
      if (temporaryIdentity != null) {
        deleteIfOwned(temporary, temporaryIdentity);
      }
    }
  }

  @Override
  public void close() {
    if (closed.compareAndSet(false, true)) {
      deleteIfOwned(presence, identity);
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

  private static boolean sameIdentity(
      BasicFileAttributes expected, BasicFileAttributes actual) {
    if (expected == null || actual == null) {
      return false;
    }
    if (expected.fileKey() != null && actual.fileKey() != null) {
      return expected.fileKey().equals(actual.fileKey());
    }
    return expected.creationTime().equals(actual.creationTime())
        && expected.lastModifiedTime().equals(actual.lastModifiedTime())
        && expected.size() == actual.size();
  }

  private static boolean sameDirectoryIdentity(
      BasicFileAttributes expected, BasicFileAttributes actual) {
    if (expected == null || actual == null) {
      return false;
    }
    if (expected.fileKey() != null && actual.fileKey() != null) {
      return expected.fileKey().equals(actual.fileKey());
    }
    return expected.creationTime().equals(actual.creationTime());
  }

  private static void runHook(Runnable hook) {
    if (hook != null) {
      hook.run();
    }
  }

  private static void deleteIfOwned(Path path, BasicFileAttributes expected) {
    try {
      BasicFileAttributes actual = ordinaryFile(path);
      if (sameIdentity(expected, actual) && expected.size() == actual.size()) {
        Files.delete(path);
      }
    } catch (IOException | SecurityException ignored) {
      // Best-effort cleanup never deletes an ambiguous replacement.
    }
  }
}
