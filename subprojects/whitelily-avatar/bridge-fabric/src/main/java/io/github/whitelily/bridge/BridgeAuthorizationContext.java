package io.github.whitelily.bridge;

public record BridgeAuthorizationContext(
    boolean integratedServer,
    boolean loopbackRemote,
    int handshakePort,
    int publishedPort,
    String username,
    long now) {}
