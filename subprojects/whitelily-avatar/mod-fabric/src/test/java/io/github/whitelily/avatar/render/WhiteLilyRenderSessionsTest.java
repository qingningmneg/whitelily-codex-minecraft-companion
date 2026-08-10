package io.github.whitelily.avatar.render;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class WhiteLilyRenderSessionsTest {
  @Test
  void eachConnectionOrWorldSessionGetsANewOpaqueSafeRandomIdentityAndEpoch() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();

    RenderSessionId first = sessions.beginSession();
    RenderSessionId second = sessions.beginSession();

    assertNotEquals(first, second);
    assertNotEquals(first.matcherToken(), second.matcherToken());
    assertTrue(first.matcherToken().matches("[A-Za-z0-9_-]{43}"));
    assertTrue(second.epoch() > first.epoch());
    assertFalse(first.toString().contains(first.matcherToken()));
  }

  @Test
  void endingAConnectionRemovesTheCurrentSession() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    sessions.beginSession();

    sessions.endSession();

    assertTrue(sessions.currentSession().isEmpty());
  }
}
