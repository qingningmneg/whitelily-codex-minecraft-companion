package io.github.whitelily.bridge;

final class BridgeLoginSelector {
  private static final String HOST_PREFIX = "127.0.0.1\0WL1\0";

  private final BridgeProofStore proofStore;

  BridgeLoginSelector(BridgeProofStore proofStore) {
    this.proofStore = proofStore;
  }

  static boolean captureHandshake(
      String hostname, int port, boolean loopbackRemote, BridgeConnectionAccess connection) {
    if (!WindowsOwnedFile.isWindows()
        || !loopbackRemote
        || connection == null
        || hostname == null
        || port < 1
        || port > 65_535) {
      return false;
    }
    if (!hostname.startsWith(HOST_PREFIX) || hostname.length() != HOST_PREFIX.length() + 43) {
      return false;
    }
    String nonce = hostname.substring(HOST_PREFIX.length());
    if (!BridgeNonce.isCanonical(nonce)) {
      return false;
    }
    connection.whitelily$setHandshakeProof(nonce, port);
    return true;
  }

  BridgeLoginDecision select(
      BridgeConnectionAccess connection,
      boolean integratedServer,
      boolean loopbackRemote,
      int localPort,
      int publishedPort,
      String username,
      long now) {
    if (connection == null) {
      return BridgeLoginDecision.VANILLA;
    }
    var candidate = connection.whitelily$takeHandshakeProof();
    if (localPort != publishedPort) {
      return BridgeLoginDecision.VANILLA;
    }
    return candidate
        .flatMap(
            proof ->
                proofStore.consume(
                    proof.nonce(),
                    new BridgeAuthorizationContext(
                        integratedServer,
                        loopbackRemote,
                        proof.port(),
                        publishedPort,
                        username,
                        now)))
        .map(ignored -> BridgeLoginDecision.BRIDGE_OFFLINE_PROFILE)
        .orElse(BridgeLoginDecision.VANILLA);
  }

}
