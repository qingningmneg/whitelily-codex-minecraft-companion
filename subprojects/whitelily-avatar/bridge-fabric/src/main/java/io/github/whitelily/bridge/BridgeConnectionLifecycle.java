package io.github.whitelily.bridge;

public final class BridgeConnectionLifecycle {
  private BridgeConnectionLifecycle() {}

  public static void clear(
      BridgeConnectionAccess handshakeAccess, BridgeConnectionApprovalAccess approvalAccess) {
    if (handshakeAccess != null) {
      handshakeAccess.whitelily$clearHandshakeProof();
    }
    if (approvalAccess != null) {
      approvalAccess.whitelily$clearPendingApproval();
    }
  }
}
