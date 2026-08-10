package io.github.whitelily.bridge;

final class BridgeConnectionLifecycle {
  private BridgeConnectionLifecycle() {}

  static void clear(
      BridgeConnectionAccess handshakeAccess, BridgeConnectionApprovalAccess approvalAccess) {
    if (handshakeAccess != null) {
      handshakeAccess.whitelily$clearHandshakeProof();
    }
    if (approvalAccess != null) {
      approvalAccess.whitelily$clearPendingApproval();
    }
  }
}
