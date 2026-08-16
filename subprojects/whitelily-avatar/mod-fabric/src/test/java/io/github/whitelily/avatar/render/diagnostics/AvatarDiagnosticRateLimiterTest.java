package io.github.whitelily.avatar.render.diagnostics;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import org.junit.jupiter.api.Test;

final class AvatarDiagnosticRateLimiterTest {
  @Test
  void logsTheFirstDiagnosticThenSummarizesDuplicatesAtTheThirtySecondBoundary() {
    AvatarDiagnosticRateLimiter limiter =
        new AvatarDiagnosticRateLimiter(Clock.fixed(Instant.ofEpochMilli(1_000), ZoneOffset.UTC));
    AvatarRenderDiagnostic diagnostic = diagnostic("AVATAR_SHADER_FAILED", "compile failed");

    assertEquals(1, limiter.record(diagnostic, 1_000).size());
    assertTrue(limiter.record(diagnostic, 2_000).isEmpty());
    assertTrue(limiter.record(diagnostic, 30_999).isEmpty());

    List<AvatarDiagnosticRateLimiter.Emission> emissions = limiter.record(diagnostic, 31_000);

    assertEquals(2, emissions.size());
    assertTrue(emissions.getFirst().summary());
    assertEquals(2, emissions.getFirst().suppressedCount());
    assertFalse(emissions.get(1).summary());
  }

  @Test
  void isolatesLimitsBySessionModelAndErrorCode() {
    AvatarDiagnosticRateLimiter limiter = new AvatarDiagnosticRateLimiter();

    assertEquals(1, limiter.record(diagnostic("AVATAR_SHADER_FAILED", "one"), 0).size());
    assertEquals(1, limiter.record(diagnostic("AVATAR_MESH_LOAD_FAILED", "two"), 1).size());
  }

  @Test
  void diagnosticReasonRemovesUserPathsTokensControlsAndCapsLength() {
    AvatarRenderDiagnostic diagnostic =
        diagnostic(
            "AVATAR_MESH_LOAD_FAILED",
            "C:\\Users\\Admin\\secret.glb token=super-secret\n" + "x".repeat(300));

    assertFalse(diagnostic.sanitizedReason().contains("C:\\Users\\Admin"));
    assertFalse(diagnostic.sanitizedReason().contains("super-secret"));
    assertFalse(diagnostic.sanitizedReason().contains("\n"));
    assertTrue(diagnostic.sanitizedReason().codePointCount(0, diagnostic.sanitizedReason().length()) <= 240);
  }

  private static AvatarRenderDiagnostic diagnostic(String errorCode, String reason) {
    return new AvatarRenderDiagnostic(
        "0.1.0",
        "smooth-mesh",
        "user:model",
        "HIGH",
        "DIAMOND",
        "advanced",
        "session-one",
        errorCode,
        reason);
  }
}
