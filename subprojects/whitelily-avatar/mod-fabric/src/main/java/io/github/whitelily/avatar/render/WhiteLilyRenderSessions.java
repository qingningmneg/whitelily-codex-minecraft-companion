package io.github.whitelily.avatar.render;

import java.security.SecureRandom;
import java.util.Optional;

public final class WhiteLilyRenderSessions implements WeakNameModeControl {
  private final SecureRandom secureRandom = new SecureRandom();

  private long nextEpoch = 1;
  private volatile RenderSessionId currentSession;
  private volatile boolean weakNameModeEnabled;

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

  public boolean weakNameModeEnabled() {
    return weakNameModeEnabled;
  }

  @Override
  public void setWeakNameModeEnabled(boolean enabled) {
    weakNameModeEnabled = enabled;
  }
}
