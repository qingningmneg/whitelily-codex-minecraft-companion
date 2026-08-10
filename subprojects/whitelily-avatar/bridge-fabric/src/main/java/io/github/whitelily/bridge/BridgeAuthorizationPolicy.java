package io.github.whitelily.bridge;

import java.util.Base64;
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
        || request.issuedAt() > context.now()
        || context.now() >= request.expiresAt()
        || !isNonce(request.nonce())) {
      return Optional.empty();
    }
    return Optional.of(request);
  }

  private static boolean isNonce(String nonce) {
    if (nonce == null || !nonce.matches("[A-Za-z0-9_-]{43}")) {
      return false;
    }
    try {
      return Base64.getUrlDecoder().decode(nonce).length == 32;
    } catch (IllegalArgumentException ignored) {
      return false;
    }
  }
}
