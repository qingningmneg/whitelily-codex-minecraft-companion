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

  @Test
  void flushesExpiredDuplicateSummaryWithoutAnotherFailureAndEvictsQuietWindows() {
    AvatarDiagnosticRateLimiter limiter = new AvatarDiagnosticRateLimiter();
    AvatarRenderDiagnostic diagnostic = diagnostic("AVATAR_SHADER_FAILED", "compile failed");

    limiter.record(diagnostic, 0);
    limiter.record(diagnostic, 1);

    List<AvatarDiagnosticRateLimiter.Emission> emissions = limiter.flushExpired(30_000);

    assertEquals(1, emissions.size());
    assertTrue(emissions.getFirst().summary());
    assertEquals(1, emissions.getFirst().suppressedCount());
    assertTrue(limiter.flushExpired(60_000).isEmpty());
  }

  @Test
  void flushSummaryKeepsTheOriginalDiagnosticMetadata() {
    AvatarDiagnosticRateLimiter limiter = new AvatarDiagnosticRateLimiter();
    AvatarRenderDiagnostic original = diagnostic("AVATAR_ANIMATION_FAILED", "bad helper");
    limiter.record(original, 0);
    limiter.record(original, 1);

    AvatarDiagnosticRateLimiter.Emission summary = limiter.flushExpired(30_000).getFirst();

    assertEquals(original.assetVersion(), summary.diagnostic().assetVersion());
    assertEquals(original.backend(), summary.diagnostic().backend());
    assertEquals(original.modelId(), summary.diagnostic().modelId());
    assertEquals(original.detailLevel(), summary.diagnostic().detailLevel());
    assertEquals(original.armorTheme(), summary.diagnostic().armorTheme());
    assertEquals(original.materialTier(), summary.diagnostic().materialTier());
    assertEquals(original.sessionId(), summary.diagnostic().sessionId());
    assertEquals(original.errorCode(), summary.diagnostic().errorCode());
  }

  @Test
  void sanitizesQuotedJsonBearerApiKeyAndPathsWithSpacesAtTheCodePointBoundary() {
    AvatarRenderDiagnostic diagnostic =
        diagnostic(
            "AVATAR_SHADER_FAILED",
            "{\"token\":\"secret-one\",\"apiKey\":\"secret-two\"} Bearer secret-three "
                + "C:\\Users\\Ada Lovelace\\avatar.glb /home/Ada Lovelace/avatar.glb\u0001"
                + "🙂".repeat(241));

    assertEquals(
            "{\"token\":\"<redacted-token>\",\"apiKey\":\"<redacted-token>\"} <redacted-token> "
            + "<user-path> <user-path>"
            + "🙂".repeat(143),
        diagnostic.sanitizedReason());
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
