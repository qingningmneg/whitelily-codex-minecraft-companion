package io.github.whitelily.bridge;

import java.nio.file.Path;
import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import net.fabricmc.api.ClientModInitializer;

public final class WhiteLilyBridgeClient implements ClientModInitializer {
  private static final AtomicBoolean INITIALIZED = new AtomicBoolean();
  private static volatile BridgePresencePublisher presencePublisher;

  @Override
  public void onInitializeClient() {
    if (!INITIALIZED.compareAndSet(false, true)) {
      return;
    }
    Path presenceDirectory = BridgeRuntime.preparePresenceDirectory();
    Optional<Instant> processStart = ProcessHandle.current().info().startInstant();
    if (presenceDirectory == null || processStart.isEmpty()) {
      return;
    }
    BridgePresencePublisher.publish(
            presenceDirectory,
            ProcessHandle.current().pid(),
            processStart.orElseThrow().toEpochMilli(),
            System.currentTimeMillis())
        .ifPresent(
            publisher -> {
              presencePublisher = publisher;
              Runtime.getRuntime()
                  .addShutdownHook(new Thread(WhiteLilyBridgeClient::closePresence, "whitelily-bridge-presence"));
            });
  }

  private static void closePresence() {
    BridgePresencePublisher publisher = presencePublisher;
    if (publisher != null) {
      publisher.close();
    }
  }
}
