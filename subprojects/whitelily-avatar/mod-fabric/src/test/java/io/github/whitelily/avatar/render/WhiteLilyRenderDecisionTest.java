package io.github.whitelily.avatar.render;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.whitelily.avatar.identity.IdentityDecision;
import io.github.whitelily.avatar.theme.ArmorTheme;
import org.junit.jupiter.api.Test;

final class WhiteLilyRenderDecisionTest {
  @Test
  void noneAlwaysDelegatesToVanilla() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId session = sessions.beginSession();

    WhiteLilyRenderDecision decision =
        WhiteLilyRenderDecision.capture(
            IdentityDecision.NONE, ArmorTheme.DIAMOND, session, session);

    assertFalse(decision.usesCustomRenderer());
    assertFalse(decision.canRenderCustomIn(session));
    assertFalse(decision.expressionCapable());
    assertFalse(decision.hidesVanillaArmor());
    assertFalse(decision.rendersHeldItem());
  }

  @Test
  void fullAndBasicNameOnlyUseTheCustomRenderer() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId session = sessions.beginSession();

    assertTrue(
        WhiteLilyRenderDecision.capture(
                IdentityDecision.FULL, ArmorTheme.BASE, session, session)
            .usesCustomRenderer());
    assertTrue(
        WhiteLilyRenderDecision.capture(
                IdentityDecision.BASIC_NAME_ONLY, ArmorTheme.IRON, session, session)
            .usesCustomRenderer());
  }

  @Test
  void onlyFullIdentityCanReceiveLaterPrivateExpressions() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId session = sessions.beginSession();

    assertTrue(
        WhiteLilyRenderDecision.capture(
                IdentityDecision.FULL, ArmorTheme.BASE, session, session)
            .expressionCapable());
    assertFalse(
        WhiteLilyRenderDecision.capture(
                IdentityDecision.BASIC_NAME_ONLY, ArmorTheme.BASE, session, session)
            .expressionCapable());
  }

  @Test
  void matchedCustomRenderHidesVanillaArmorAndKeepsHeldItems() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId session = sessions.beginSession();

    WhiteLilyRenderDecision decision =
        WhiteLilyRenderDecision.capture(
            IdentityDecision.FULL, ArmorTheme.NETHERITE, session, session);

    assertTrue(decision.hidesVanillaArmor());
    assertTrue(decision.rendersHeldItem());
  }

  @Test
  void captureAndCurrentSessionMismatchDelegatesToVanilla() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId capturedSession = sessions.beginSession();
    RenderSessionId currentSession = sessions.beginSession();

    WhiteLilyRenderDecision decision =
        WhiteLilyRenderDecision.capture(
            IdentityDecision.FULL, ArmorTheme.DIAMOND, capturedSession, currentSession);

    assertFalse(decision.usesCustomRenderer());
    assertFalse(decision.canRenderCustomIn(currentSession));
  }

  @Test
  void staleDecisionDelegatesToVanillaWhenTheSessionChangesBeforeRender() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId capturedSession = sessions.beginSession();
    WhiteLilyRenderDecision decision =
        WhiteLilyRenderDecision.capture(
            IdentityDecision.FULL, ArmorTheme.GOLD, capturedSession, capturedSession);

    RenderSessionId laterSession = sessions.beginSession();

    assertFalse(decision.canRenderCustomIn(laterSession));
  }

  @Test
  void decisionStringDoesNotExposeTheOpaqueSessionToken() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId session = sessions.beginSession();
    WhiteLilyRenderDecision decision =
        WhiteLilyRenderDecision.capture(
            IdentityDecision.FULL, ArmorTheme.LEATHER, session, session);

    assertFalse(decision.toString().contains(session.matcherToken()));
  }
}
