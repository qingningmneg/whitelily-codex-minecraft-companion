package io.github.whitelily.avatar.control;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.whitelily.avatar.WhiteLilyAvatarClient;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

final class AvatarModelControllerTest {
  private static final String CLASSIC = "builtin:whitelily";
  private static final String FIRST = "user:00000000-0000-4000-8000-000000000001";
  private static final String SECOND = "user:00000000-0000-4000-8000-000000000002";

  @Test
  void neverCommitsBeforeACompleteVisibleFrame() {
    Harness harness = new Harness();
    harness.controller.accept(prepare("switch-0001", FIRST));
    harness.runtime.completePrepared(FIRST);
    harness.controller.tick();
    assertEquals(AvatarModelPhase.READY, harness.lastState().phase());

    harness.controller.accept(commit("switch-0001", FIRST));
    harness.controller.onRenderBoundary();

    assertEquals(CLASSIC, harness.controller.confirmedActiveModelId());
    assertEquals(List.of(FIRST), harness.runtime.commitRequests);

    harness.controller.onVisibleFrameResult(AvatarVisibleFrameResult.COMPLETE);

    assertEquals(FIRST, harness.controller.confirmedActiveModelId());
    assertEquals(AvatarModelPhase.COMMITTED, harness.lastState().phase());
  }

  @Test
  void productionRenderBoundaryMakesAReadyCommitVisibleAndCommitted() {
    Harness harness = new Harness();
    harness.controller.accept(prepare("switch-0001", FIRST));
    harness.runtime.completePrepared(FIRST);
    harness.controller.tick();
    harness.controller.accept(commit("switch-0001", FIRST));

    WhiteLilyAvatarClient.onRenderBoundary(harness.controller);
    harness.controller.onVisibleFrameResult(AvatarVisibleFrameResult.COMPLETE);

    assertEquals(List.of(FIRST), harness.runtime.commitRequests);
    assertEquals(FIRST, harness.controller.confirmedActiveModelId());
    assertEquals(AvatarModelPhase.COMMITTED, harness.lastState().phase());
  }

  @Test
  void restoresTheOldModelWhenTheFirstVisibleFrameFails() {
    Harness harness = new Harness();
    harness.prepareReadyAndCommit("switch-0001", FIRST);

    harness.controller.onVisibleFrameResult(AvatarVisibleFrameResult.FAILED);

    assertEquals(CLASSIC, harness.controller.confirmedActiveModelId());
    assertEquals(AvatarModelPhase.FAILED, harness.lastState().phase());
    assertEquals("AVATAR_FRAME_FAILED", harness.lastState().errorCode());
    assertTrue(harness.runtime.cancelled.contains(FIRST));
    assertTrue(harness.runtime.released.contains(FIRST));
  }

  @Test
  void aNewPrepareCancelsAndReleasesALateSupersededCandidate() {
    Harness harness = new Harness();
    harness.controller.accept(prepare("switch-0001", FIRST));
    harness.controller.accept(prepare("switch-0002", SECOND));

    harness.runtime.completePrepared(FIRST);
    harness.runtime.completePrepared(SECOND);
    harness.controller.tick();

    assertTrue(harness.runtime.released.contains(FIRST));
    assertEquals(AvatarModelPhase.READY, harness.lastState().phase());
    assertEquals(SECOND, harness.lastState().candidateModelId());
  }

  @Test
  void rejectsCommitFromAnotherWorldOrRequest() {
    Harness harness = new Harness();
    harness.controller.accept(prepare("switch-0001", FIRST));
    harness.runtime.completePrepared(FIRST);
    harness.controller.tick();

    harness.controller.accept(commit("switch-other", FIRST));
    harness.controller.accept(commit("switch-0001", FIRST, "world-old"));
    harness.controller.onRenderBoundary();

    assertFalse(harness.runtime.commitRequests.contains(FIRST));
    assertEquals(CLASSIC, harness.controller.confirmedActiveModelId());
  }

  @Test
  void worldChangeCancelsPreparedWorkWithoutAcceptingLateCompletion() {
    Harness harness = new Harness();
    harness.controller.accept(prepare("switch-0001", FIRST));

    harness.controller.cancelForWorldChange();
    harness.runtime.completePrepared(FIRST);
    harness.controller.tick();

    assertEquals(CLASSIC, harness.controller.confirmedActiveModelId());
    assertTrue(harness.runtime.released.contains(FIRST));
    assertEquals(AvatarModelPhase.CANCELLED, harness.lastState().phase());
  }

  @Test
  void bindsTheDesktopSessionOnlyAfterAWorldBegins() {
    FakeRuntime runtime = new FakeRuntime();
    List<AvatarModelControlState> states = new ArrayList<>();
    AvatarModelController controller =
        new AvatarModelController(runtime, states::add, CLASSIC, null);

    controller.accept(prepare("ignored-before-world", FIRST));
    controller.beginWorldSession();
    controller.accept(prepare("switch-0001", FIRST));
    runtime.completePrepared(FIRST);
    controller.tick();

    assertEquals(2, states.size());
    assertEquals(AvatarModelPhase.READY, states.get(1).phase());
    assertEquals("world-0001", states.get(1).worldSessionId());
  }

  @Test
  void slowRuntimePrepareDoesNotHoldTheControllerMonitor() throws Exception {
    CountDownLatch entered = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    AvatarCandidateRuntime runtime =
        new AvatarCandidateRuntime() {
          @Override
          public CompletionStage<PreparedCandidate> prepare(AvatarRuntimeDescriptor descriptor) {
            entered.countDown();
            try {
              release.await();
            } catch (InterruptedException ignored) {
              Thread.currentThread().interrupt();
            }
            return CompletableFuture.completedFuture(new Candidate(descriptor.modelId()));
          }

          @Override
          public void requestCommit(PreparedCandidate candidate) {}

          @Override
          public void cancel(PreparedCandidate candidate) {}

          @Override
          public void release(PreparedCandidate candidate) {}
        };
    AvatarModelController controller =
        new AvatarModelController(runtime, ignored -> {}, CLASSIC, "world-0001");
    ExecutorService executor = Executors.newFixedThreadPool(2);
    try {
      executor.submit(() -> controller.accept(prepare("switch-0001", FIRST)));
      assertTrue(entered.await(2, TimeUnit.SECONDS));

      assertTrue(
          executor.submit(() -> controller.cancelForWorldChange()).get(500, TimeUnit.MILLISECONDS)
              == null);
    } finally {
      release.countDown();
      executor.shutdownNow();
    }
  }

  private static AvatarModelControlRequest prepare(String requestId, String modelId) {
    return new AvatarModelControlRequest(
        1,
        requestId,
        AvatarModelOperation.PREPARE,
        modelId,
        "world-0001",
        descriptor(modelId),
        Instant.parse("2026-08-16T08:00:00Z"));
  }

  private static AvatarModelControlRequest commit(String requestId, String modelId) {
    return commit(requestId, modelId, "world-0001");
  }

  private static AvatarModelControlRequest commit(
      String requestId, String modelId, String worldSessionId) {
    return new AvatarModelControlRequest(
        1,
        requestId,
        AvatarModelOperation.COMMIT,
        modelId,
        worldSessionId,
        null,
        Instant.parse("2026-08-16T08:00:01Z"));
  }

  private static AvatarRuntimeDescriptor descriptor(String modelId) {
    return new AvatarRuntimeDescriptor(
        modelId,
        "imported",
        "minecraft-skin",
        "wide");
  }

  private static final class Harness {
    private final FakeRuntime runtime = new FakeRuntime();
    private final List<AvatarModelControlState> states = new ArrayList<>();
    private final AvatarModelController controller =
        new AvatarModelController(runtime, states::add, CLASSIC, "world-0001");

    private AvatarModelControlState lastState() {
      return states.get(states.size() - 1);
    }

    private void prepareReadyAndCommit(String requestId, String modelId) {
      controller.accept(prepare(requestId, modelId));
      runtime.completePrepared(modelId);
      controller.tick();
      controller.accept(commit(requestId, modelId));
      controller.onRenderBoundary();
    }
  }

  private static final class FakeRuntime implements AvatarCandidateRuntime {
    private final Map<String, CompletableFuture<PreparedCandidate>> preparations =
        new LinkedHashMap<>();
    private final List<String> commitRequests = new ArrayList<>();
    private final List<String> cancelled = new ArrayList<>();
    private final List<String> released = new ArrayList<>();

    @Override
    public CompletionStage<PreparedCandidate> prepare(AvatarRuntimeDescriptor descriptor) {
      CompletableFuture<PreparedCandidate> future = new NonCancellableFuture<>();
      preparations.put(descriptor.modelId(), future);
      return future;
    }

    @Override
    public void requestCommit(PreparedCandidate candidate) {
      commitRequests.add(candidate.modelId());
    }

    @Override
    public void cancel(PreparedCandidate candidate) {
      cancelled.add(candidate.modelId());
    }

    @Override
    public void release(PreparedCandidate candidate) {
      released.add(candidate.modelId());
    }

    private void completePrepared(String modelId) {
      preparations.get(modelId).complete(new Candidate(modelId));
    }
  }

  private static final class NonCancellableFuture<T> extends CompletableFuture<T> {
    @Override
    public boolean cancel(boolean mayInterruptIfRunning) {
      return false;
    }
  }

  private record Candidate(String modelId) implements AvatarCandidateRuntime.PreparedCandidate {}
}
