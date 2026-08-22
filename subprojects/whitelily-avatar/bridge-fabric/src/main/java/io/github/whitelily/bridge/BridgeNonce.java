package io.github.whitelily.bridge;

import java.util.Base64;

final class BridgeNonce {
  private BridgeNonce() {}

  static boolean isCanonical(String nonce) {
    if (nonce == null || !nonce.matches("[A-Za-z0-9_-]{43}")) {
      return false;
    }
    try {
      byte[] decoded = Base64.getUrlDecoder().decode(nonce);
      return decoded.length == 32
          && nonce.equals(Base64.getUrlEncoder().withoutPadding().encodeToString(decoded));
    } catch (IllegalArgumentException ignored) {
      return false;
    }
  }
}
