package io.github.whitelily.avatar.control;

import java.time.Instant;

public record AvatarModelControlState(
    int schemaVersion,
    String requestId,
    AvatarModelPhase phase,
    String activeModelId,
    String candidateModelId,
    String worldSessionId,
    String errorCode,
    Instant updatedAt) {}
