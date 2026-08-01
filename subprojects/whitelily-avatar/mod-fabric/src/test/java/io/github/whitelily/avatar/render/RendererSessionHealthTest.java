package io.github.whitelily.avatar.render;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.whitelily.avatar.identity.IdentityDecision;
import io.github.whitelily.avatar.theme.ArmorTheme;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

final class RendererSessionHealthTest {
  @Test
  void healthyCurrentSessionCompletesCustomRenderAndCancelsVanilla() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId session = sessions.beginSession();
    AtomicInteger renders = new AtomicInteger();
    WhiteLilyRenderCoordinator coordinator =
        new WhiteLilyRenderCoordinator(new RendererSessionHealth(), () -> {});

    boolean cancelVanilla =
        coordinator.render(
            fullDecision(session), session, renders::incrementAndGet);

    assertTrue(cancelVanilla);
    assertEquals(1, renders.get());
  }

  @Test
  void currentCustomExceptionKeepsVanillaAndTripsOnlyThatSession() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId failedSession = sessions.beginSession();
    AtomicInteger fixedFailureReports = new AtomicInteger();
    AtomicInteger laterAttempts = new AtomicInteger();
    WhiteLilyRenderCoordinator coordinator =
        new WhiteLilyRenderCoordinator(
            new RendererSessionHealth(), fixedFailureReports::incrementAndGet);

    boolean firstFrameCancel =
        coordinator.render(
            fullDecision(failedSession),
            failedSession,
            () -> {
              throw new IllegalStateException("render failed");
            });
    boolean laterFrameCancel =
        coordinator.render(
            fullDecision(failedSession), failedSession, laterAttempts::incrementAndGet);

    assertFalse(firstFrameCancel);
    assertFalse(laterFrameCancel);
    assertEquals(0, laterAttempts.get());
    assertEquals(1, fixedFailureReports.get());
  }

  @Test
  void linkageFailureUsesTheSamePerSessionCircuitBreaker() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId session = sessions.beginSession();
    AtomicInteger reports = new AtomicInteger();
    WhiteLilyRenderCoordinator coordinator =
        new WhiteLilyRenderCoordinator(new RendererSessionHealth(), reports::incrementAndGet);

    assertFalse(
        coordinator.render(
            fullDecision(session),
            session,
            () -> {
              throw new NoClassDefFoundError("geckolib linkage");
            }));
    assertFalse(coordinator.render(fullDecision(session), session, () -> {}));
    assertEquals(1, reports.get());
  }

  @Test
  void newSessionResetsTheFailureWithoutRetryingTheFailedSession() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId failedSession = sessions.beginSession();
    AtomicInteger successfulRenders = new AtomicInteger();
    WhiteLilyRenderCoordinator coordinator =
        new WhiteLilyRenderCoordinator(new RendererSessionHealth(), () -> {});

    assertFalse(
        coordinator.render(
            fullDecision(failedSession),
            failedSession,
            () -> {
              throw new IllegalArgumentException("bad model");
            }));

    RenderSessionId newSession = sessions.beginSession();

    assertTrue(
        coordinator.render(
            fullDecision(newSession), newSession, successfulRenders::incrementAndGet));
    assertEquals(1, successfulRenders.get());
  }

  @Test
  void staleDecisionNeverInvokesTheCustomRenderer() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId capturedSession = sessions.beginSession();
    WhiteLilyRenderDecision decision = fullDecision(capturedSession);
    RenderSessionId currentSession = sessions.beginSession();
    AtomicInteger renders = new AtomicInteger();
    WhiteLilyRenderCoordinator coordinator =
        new WhiteLilyRenderCoordinator(new RendererSessionHealth(), () -> {});

    assertFalse(coordinator.render(decision, currentSession, renders::incrementAndGet));
    assertEquals(0, renders.get());
  }

  @Test
  @SuppressWarnings("removal")
  void seriousVmAndThreadTerminationErrorsAreNotSwallowedOrCircuitBroken() {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId session = sessions.beginSession();
    WhiteLilyRenderCoordinator coordinator =
        new WhiteLilyRenderCoordinator(new RendererSessionHealth(), () -> {});

    assertThrows(
        ThreadDeath.class,
        () ->
            coordinator.render(
                fullDecision(session),
                session,
                () -> {
                  throw new ThreadDeath();
                }));
    assertThrows(
        OutOfMemoryError.class,
        () ->
            coordinator.render(
                fullDecision(session),
                session,
                () -> {
                  throw new OutOfMemoryError("test");
                }));
    assertTrue(coordinator.render(fullDecision(session), session, () -> {}));
  }

  private static WhiteLilyRenderDecision fullDecision(RenderSessionId session) {
    return WhiteLilyRenderDecision.capture(
        IdentityDecision.FULL, ArmorTheme.BASE, session, session);
  }
}
