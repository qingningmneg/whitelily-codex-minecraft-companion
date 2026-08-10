package io.github.whitelily.bridge;

import java.util.Optional;

interface BridgeConnectionAccess {
  void whitelily$setHandshakeProof(String nonce, int port);

  Optional<HandshakeProof> whitelily$takeHandshakeProof();
}
