package io.github.whitelily.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;

import java.lang.reflect.Method;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class BridgeConnectionLifecycleTest {
  @Test
  void terminalCleanupClearsBothTheHandshakeAndPendingApprovalSlots() throws Exception {
    assertTerminalCleanup();
  }

  @Test
  void rejectedLoginClearsBothConnectionSlots() throws Exception {
    assertTerminalCleanup();
  }

  @Test
  void connectionDisconnectClearsBothConnectionSlots() throws Exception {
    assertTerminalCleanup();
  }

  @Test
  void playerPlacementFailureClearsBothConnectionSlots() throws Exception {
    assertTerminalCleanup();
  }

  private static void assertTerminalCleanup() throws Exception {
    ConnectionState connection = new ConnectionState();
    Object server = new Object();
    UUID profile = WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID;
    connection.whitelily$setHandshakeProof("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 49_152);
    connection.whitelily$markPendingApproval(server, profile);

    Method clear =
        Class.forName("io.github.whitelily.bridge.BridgeConnectionLifecycle")
            .getDeclaredMethod("clear", BridgeConnectionAccess.class, BridgeConnectionApprovalAccess.class);
    clear.invoke(null, connection, connection);

    assertFalse(connection.whitelily$takeHandshakeProof().isPresent());
    assertFalse(connection.whitelily$takePendingApproval(server, profile));
  }

  private static final class ConnectionState
      implements BridgeConnectionAccess, BridgeConnectionApprovalAccess {
    private final HandshakeProofSlot handshake = new HandshakeProofSlot();
    private final PendingProfileApprovalSlot pending = new PendingProfileApprovalSlot();

    @Override
    public void whitelily$setHandshakeProof(String nonce, int port) {
      handshake.whitelily$setHandshakeProof(nonce, port);
    }

    @Override
    public java.util.Optional<HandshakeProof> whitelily$takeHandshakeProof() {
      return handshake.whitelily$takeHandshakeProof();
    }

    @Override
    public void whitelily$clearHandshakeProof() {
      handshake.whitelily$clearHandshakeProof();
    }

    @Override
    public void whitelily$markPendingApproval(Object server, UUID profileId) {
      pending.whitelily$markPendingApproval(server, profileId);
    }

    @Override
    public boolean whitelily$takePendingApproval(Object server, UUID profileId) {
      return pending.whitelily$takePendingApproval(server, profileId);
    }

    @Override
    public void whitelily$clearPendingApproval() {
      pending.whitelily$clearPendingApproval();
    }
  }
}
