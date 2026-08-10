package io.github.whitelily.bridge;

import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

final class HandshakeProofSlot implements BridgeConnectionAccess {
  private final AtomicReference<HandshakeProof> proof = new AtomicReference<>();

  @Override
  public void whitelily$setHandshakeProof(String nonce, int port) {
    proof.compareAndSet(null, new HandshakeProof(nonce, port));
  }

  @Override
  public Optional<HandshakeProof> whitelily$takeHandshakeProof() {
    return Optional.ofNullable(proof.getAndSet(null));
  }

  @Override
  public void whitelily$clearHandshakeProof() {
    proof.set(null);
  }

  @Override
  public String toString() {
    return "HandshakeProofSlot[redacted]";
  }
}
