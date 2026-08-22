package io.github.whitelily.avatar.render;

import java.security.SecureRandom;
import java.util.Optional;

public final class WhiteLilyRenderSessions {
  private final SecureRandom secureRandom = new SecureRandom();

  private long nextEpoch = 1;
  private volatile RenderSessionId currentSession;

  public synchronized RenderSessionId beginSession() {
    RenderSessionId session = RenderSessionId.generate(nextEpoch++, secureRandom);
    currentSession = session;
    return session;
  }

  public synchronized void endSession() {
    currentSession = null;
  }

  public Optional<RenderSessionId> currentSession() {
    return Optional.ofNullable(currentSession);
  }

}
