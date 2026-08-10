package io.github.whitelily.bridge;

final class HandshakeProof {
  private final String nonce;
  private final int port;

  HandshakeProof(String nonce, int port) {
    this.nonce = nonce;
    this.port = port;
  }

  String nonce() {
    return nonce;
  }

  int port() {
    return port;
  }

  @Override
  public String toString() {
    return "HandshakeProof[redacted]";
  }
}
