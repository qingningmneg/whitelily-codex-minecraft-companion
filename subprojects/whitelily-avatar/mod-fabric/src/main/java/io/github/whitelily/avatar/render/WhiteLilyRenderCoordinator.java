package io.github.whitelily.avatar.render;

import java.util.Objects;

public final class WhiteLilyRenderCoordinator {
  private final RendererSessionHealth sessionHealth;
  private final Runnable firstFailureReporter;

  public WhiteLilyRenderCoordinator(
      RendererSessionHealth sessionHealth, Runnable firstFailureReporter) {
    this.sessionHealth = Objects.requireNonNull(sessionHealth);
    this.firstFailureReporter = Objects.requireNonNull(firstFailureReporter);
  }

  public boolean render(
      WhiteLilyRenderDecision decision,
      RenderSessionId currentSession,
      Runnable customRenderer) {
    if (decision == null
        || !decision.canRenderCustomIn(currentSession)
        || !sessionHealth.isHealthy(currentSession)) {
      return false;
    }

    try {
      customRenderer.run();
      return true;
    } catch (Exception | LinkageError renderFailure) {
      if (sessionHealth.recordFailure(currentSession)) {
        firstFailureReporter.run();
      }
      return false;
    }
  }
}
