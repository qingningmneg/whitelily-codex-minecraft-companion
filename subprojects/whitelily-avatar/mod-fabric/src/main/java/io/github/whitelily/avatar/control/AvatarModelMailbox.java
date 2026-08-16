package io.github.whitelily.avatar.control;

import static java.nio.file.StandardCopyOption.ATOMIC_MOVE;
import static java.nio.file.StandardCopyOption.REPLACE_EXISTING;
import static java.nio.file.StandardOpenOption.CREATE_NEW;
import static java.nio.file.StandardOpenOption.WRITE;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Optional;
import java.util.UUID;

public final class AvatarModelMailbox {
  private final Path root;
  private final Path requestPath;
  private final Path statePath;
  private final AvatarModelControlCodec codec;
  private Object lastRequestFileKey;
  private long lastRequestModified = Long.MIN_VALUE;
  private long lastRequestSize = Long.MIN_VALUE;

  public AvatarModelMailbox(Path dataRoot) throws AvatarModelControlException {
    this(dataRoot, new AvatarModelControlCodec());
  }

  AvatarModelMailbox(Path dataRoot, AvatarModelControlCodec codec)
      throws AvatarModelControlException {
    if (dataRoot == null || !dataRoot.isAbsolute()) {
      throw new AvatarModelControlException(
          "AVATAR_MAILBOX_PATH_INVALID", "avatar mailbox data root is invalid");
    }
    this.root = dataRoot.toAbsolutePath().normalize().resolve("bridge").resolve("avatar-model");
    this.requestPath = root.resolve("request.json");
    this.statePath = root.resolve("state.json");
    this.codec = codec;
    prepareRoot();
  }

  public Optional<AvatarModelControlRequest> poll() throws AvatarModelControlException {
    try {
      if (!Files.exists(requestPath, LinkOption.NOFOLLOW_LINKS)) return Optional.empty();
      BasicFileAttributes attributes =
          Files.readAttributes(
              requestPath, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      long modified = attributes.lastModifiedTime().toMillis();
      if (java.util.Objects.equals(lastRequestFileKey, attributes.fileKey())
          && lastRequestModified == modified
          && lastRequestSize == attributes.size()) {
        return Optional.empty();
      }
      AvatarModelControlRequest request = codec.read(requestPath);
      lastRequestFileKey = attributes.fileKey();
      lastRequestModified = modified;
      lastRequestSize = attributes.size();
      return Optional.of(request);
    } catch (AvatarModelControlException error) {
      throw error;
    } catch (IOException | RuntimeException error) {
      throw new AvatarModelControlException(
          "AVATAR_MAILBOX_READ_FAILED", "avatar mailbox request could not be read", error);
    }
  }

  public void publish(AvatarModelControlState state) throws AvatarModelControlException {
    byte[] bytes = codec.write(state);
    prepareRoot();
    Path temporary = root.resolve(".state.json." + UUID.randomUUID() + ".tmp");
    try {
      if (Files.exists(statePath, LinkOption.NOFOLLOW_LINKS)) assertOrdinaryFile(statePath);
      try (FileChannel channel = FileChannel.open(temporary, CREATE_NEW, WRITE)) {
        ByteBuffer buffer = ByteBuffer.wrap(bytes);
        while (buffer.hasRemaining()) channel.write(buffer);
        channel.force(true);
      }
      assertOrdinaryFile(temporary);
      Files.move(temporary, statePath, ATOMIC_MOVE, REPLACE_EXISTING);
      assertOrdinaryFile(statePath);
    } catch (IOException | RuntimeException error) {
      throw new AvatarModelControlException(
          "AVATAR_MAILBOX_WRITE_FAILED", "avatar mailbox state could not be published", error);
    } finally {
      try {
        Files.deleteIfExists(temporary);
      } catch (IOException ignored) {
        // A failed untrusted temporary cleanup must not replace the primary failure.
      }
    }
  }

  private void prepareRoot() throws AvatarModelControlException {
    try {
      Files.createDirectories(root);
      assertOrdinaryDirectoryChain(root);
    } catch (IOException | RuntimeException error) {
      throw new AvatarModelControlException(
          "AVATAR_MAILBOX_PATH_INVALID", "avatar mailbox root is invalid", error);
    }
  }

  private static void assertOrdinaryFile(Path path) throws IOException {
    BasicFileAttributes attributes =
        Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    if (!attributes.isRegularFile() || attributes.isSymbolicLink() || attributes.isOther()) {
      throw new IOException("avatar mailbox file is not ordinary");
    }
  }

  private static void assertOrdinaryDirectoryChain(Path path) throws IOException {
    for (Path current = path; current != null; current = current.getParent()) {
      BasicFileAttributes attributes =
          Files.readAttributes(current, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      if (!attributes.isDirectory()
          || attributes.isSymbolicLink()
          || attributes.isOther()
          || !current.toRealPath().equals(current)) {
        throw new IOException("avatar mailbox path contains a reparse directory");
      }
    }
  }
}
