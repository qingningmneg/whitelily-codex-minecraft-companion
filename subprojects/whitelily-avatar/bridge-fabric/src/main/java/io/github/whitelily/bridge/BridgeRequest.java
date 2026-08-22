package io.github.whitelily.bridge;

public record BridgeRequest(
    int schemaVersion,
    String username,
    int port,
    long issuedAt,
    long expiresAt,
    String nonce) {}
