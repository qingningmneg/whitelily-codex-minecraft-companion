package io.github.whitelily.bridge;

import java.util.Optional;

public interface BridgeConnectionAccess {
  void whitelily$setHandshakeProof(String nonce, int port);

  Optional<HandshakeProof> whitelily$takeHandshakeProof();

  void whitelily$clearHandshakeProof();
}
