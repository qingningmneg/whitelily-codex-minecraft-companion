package io.github.whitelily.avatar.control;

import java.time.Instant;

public record AvatarModelControlRequest(
    int schemaVersion,
    String requestId,
    AvatarModelOperation operation,
    String modelId,
    String worldSessionId,
    AvatarRuntimeDescriptor candidate,
    Instant issuedAt) {}
