package io.github.whitelily.bridge;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;

final class BridgeRuntime {
  private static final Path BRIDGE_ROOT = bridgeRoot();
  private static final BridgeLoginSelector LOGIN_SELECTOR =
      new BridgeLoginSelector(
          new BridgeProofStore(BRIDGE_ROOT == null ? null : BRIDGE_ROOT.resolve("requests")));

  private BridgeRuntime() {}

  static BridgeLoginSelector loginSelector() {
    return LOGIN_SELECTOR;
  }

  static Path preparePresenceDirectory() {
    if (BRIDGE_ROOT == null) {
      return null;
    }
    Path presence = BRIDGE_ROOT.resolve("presence").normalize();
    if (!presence.startsWith(BRIDGE_ROOT)) {
      return null;
    }
    try {
      Path localAppData = BRIDGE_ROOT.getParent().getParent();
      if (!ordinaryAncestorChain(localAppData)) {
        return null;
      }
      ensureOrdinaryDirectory(BRIDGE_ROOT.getParent());
      ensureOrdinaryDirectory(BRIDGE_ROOT);
      ensureOrdinaryDirectory(presence);
      return ordinaryAncestorChain(presence) ? presence : null;
    } catch (IOException | SecurityException ignored) {
      return null;
    }
  }

  private static Path bridgeRoot() {
    String localAppData = System.getenv("LOCALAPPDATA");
    if (localAppData == null || localAppData.isBlank()) {
      return null;
    }
    try {
      Path base = Path.of(localAppData);
      if (!base.isAbsolute()) {
        return null;
      }
      base = base.toAbsolutePath().normalize();
      Path bridge = base.resolve("WhiteLily").resolve("bridge").normalize();
      return bridge.startsWith(base) ? bridge : null;
    } catch (IllegalArgumentException | SecurityException ignored) {
      return null;
    }
  }

  private static void ensureOrdinaryDirectory(Path directory) throws IOException {
    if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
      Files.createDirectory(directory);
    }
    if (ordinaryDirectory(directory) == null) {
      throw new IOException("bridge directory unavailable");
    }
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
}
