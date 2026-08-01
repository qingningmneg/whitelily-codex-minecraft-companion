package io.github.whitelily.avatar.render;

public final class RendererSessionHealth {
  private RenderSessionId failedSession;

  public synchronized boolean isHealthy(RenderSessionId session) {
    return session != null && !session.equals(failedSession);
  }

  public synchronized boolean recordFailure(RenderSessionId session) {
    if (session == null || session.equals(failedSession)) {
      return false;
    }
    failedSession = session;
    return true;
  }
}
