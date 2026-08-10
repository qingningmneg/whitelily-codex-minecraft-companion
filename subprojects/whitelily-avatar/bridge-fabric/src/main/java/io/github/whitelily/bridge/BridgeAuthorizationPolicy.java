package io.github.whitelily.bridge;

import java.util.Optional;

public final class BridgeAuthorizationPolicy {
  private static final String USERNAME = "WhiteLily";

  private BridgeAuthorizationPolicy() {}

  public static Optional<BridgeRequest> authorize(
      BridgeRequest request, BridgeAuthorizationContext context) {
    if (request == null
        || context == null
        || request.schemaVersion() != 1
        || !USERNAME.equals(request.username())
        || !USERNAME.equals(context.username())
        || !context.integratedServer()
        || !context.loopbackRemote()
        || request.port() != context.handshakePort()
        || request.port() != context.publishedPort()
        || request.issuedAt() < 0
        || request.expiresAt() < request.issuedAt()
        || request.expiresAt() - request.issuedAt() != 30_000
        || request.issuedAt() > context.now()
        || context.now() >= request.expiresAt()
        || !BridgeNonce.isCanonical(request.nonce())) {
      return Optional.empty();
    }
    return Optional.of(request);
  }

}
