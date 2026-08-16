package io.github.whitelily.avatar.control;

import io.github.whitelily.avatar.control.AvatarCandidateRuntime.PreparedCandidate;
import java.time.Clock;
import java.time.Instant;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CompletionStage;
import java.util.function.Consumer;

public final class AvatarModelController {
  private final AvatarCandidateRuntime runtime;
  private final Consumer<AvatarModelControlState> statePublisher;
  private final Clock clock;
  private final ConcurrentLinkedQueue<Runnable> completions = new ConcurrentLinkedQueue<>();

  private String confirmedActiveModelId;
  private PreparedCandidate activeCandidate;
  private PreparedCandidate oldCandidate;
  private String oldActiveModelId;
  private PreparedCandidate readyCandidate;
  private PreparedCandidate visibleCandidate;
  private AvatarModelControlRequest pendingRequest;
  private CompletableFuture<PreparedCandidate> preparation;
  private boolean commitRequested;
  private boolean worldAvailable;
  private String worldSessionId;
  private long generation;

  public AvatarModelController(
      AvatarCandidateRuntime runtime,
      Consumer<AvatarModelControlState> statePublisher,
      String initialActiveModelId,
      String worldSessionId) {
    this(runtime, statePublisher, initialActiveModelId, worldSessionId, Clock.systemUTC());
  }

  AvatarModelController(
      AvatarCandidateRuntime runtime,
      Consumer<AvatarModelControlState> statePublisher,
      String initialActiveModelId,
      String worldSessionId,
      Clock clock) {
    this.runtime = Objects.requireNonNull(runtime, "runtime");
    this.statePublisher = Objects.requireNonNull(statePublisher, "statePublisher");
    this.confirmedActiveModelId = Objects.requireNonNull(initialActiveModelId, "initialActiveModelId");
    this.worldSessionId = worldSessionId;
    this.worldAvailable = worldSessionId != null;
    this.clock = Objects.requireNonNull(clock, "clock");
  }

  public synchronized void accept(AvatarModelControlRequest request) {
    Objects.requireNonNull(request, "request");
    if (!worldAvailable || request.schemaVersion() != 1) return;
    if (worldSessionId == null) {
      if (request.operation() != AvatarModelOperation.PREPARE) return;
      worldSessionId = request.worldSessionId();
    }
    if (!worldSessionId.equals(request.worldSessionId())) return;
    switch (request.operation()) {
      case PREPARE -> prepare(request);
      case COMMIT -> requestCommit(request);
      case CANCEL -> cancel(request);
    }
  }

  public void tick() {
    Runnable completion;
    while ((completion = completions.poll()) != null) completion.run();
  }

  public synchronized void onRenderBoundary() {
    if (!commitRequested || readyCandidate == null || pendingRequest == null) return;
    PreparedCandidate candidate = readyCandidate;
    try {
      runtime.requestCommit(candidate);
      oldCandidate = activeCandidate;
      oldActiveModelId = confirmedActiveModelId;
      activeCandidate = candidate;
      visibleCandidate = candidate;
      readyCandidate = null;
      commitRequested = false;
    } catch (RuntimeException error) {
      runtime.cancel(candidate);
      runtime.release(candidate);
      readyCandidate = null;
      commitRequested = false;
      publish(AvatarModelPhase.FAILED, pendingRequest, "AVATAR_COMMIT_FAILED");
      pendingRequest = null;
    }
  }

  public synchronized void onVisibleFrameResult(AvatarVisibleFrameResult result) {
    if (visibleCandidate == null || pendingRequest == null) return;
    PreparedCandidate candidate = visibleCandidate;
    AvatarModelControlRequest request = pendingRequest;
    visibleCandidate = null;
    pendingRequest = null;
    if (result == AvatarVisibleFrameResult.COMPLETE) {
      confirmedActiveModelId = candidate.modelId();
      publish(AvatarModelPhase.COMMITTED, request, null);
      if (oldCandidate != null) runtime.release(oldCandidate);
      oldCandidate = null;
      oldActiveModelId = null;
      return;
    }
    runtime.cancel(candidate);
    runtime.release(candidate);
    activeCandidate = oldCandidate;
    confirmedActiveModelId = oldActiveModelId == null ? confirmedActiveModelId : oldActiveModelId;
    oldCandidate = null;
    oldActiveModelId = null;
    publish(AvatarModelPhase.FAILED, request, "AVATAR_FRAME_FAILED");
  }

  public synchronized void cancelForWorldChange() {
    AvatarModelControlRequest request = pendingRequest;
    if (request != null) {
      discardPending();
      publish(AvatarModelPhase.CANCELLED, request, null);
    }
    worldAvailable = false;
    worldSessionId = null;
  }

  public synchronized void beginWorldSession() {
    if (pendingRequest != null) discardPending();
    worldSessionId = null;
    worldAvailable = true;
  }

  public synchronized String confirmedActiveModelId() {
    return confirmedActiveModelId;
  }

  private void prepare(AvatarModelControlRequest request) {
    if (request.candidate() == null || !request.modelId().equals(request.candidate().modelId())) {
      return;
    }
    if (pendingRequest != null) discardPending();
    pendingRequest = request;
    long capturedGeneration = ++generation;
    publish(AvatarModelPhase.PREPARING, request, null);
    final CompletionStage<PreparedCandidate> stage;
    try {
      stage = runtime.prepare(request.candidate());
      preparation = stage.toCompletableFuture();
    } catch (RuntimeException error) {
      publish(AvatarModelPhase.FAILED, request, "AVATAR_PREPARE_FAILED");
      pendingRequest = null;
      return;
    }
    stage.whenComplete(
        (candidate, failure) ->
            completions.add(() -> completePreparation(capturedGeneration, request, candidate, failure)));
  }

  private synchronized void completePreparation(
      long capturedGeneration,
      AvatarModelControlRequest request,
      PreparedCandidate candidate,
      Throwable failure) {
    if (capturedGeneration != generation || pendingRequest != request) {
      if (candidate != null) runtime.release(candidate);
      return;
    }
    preparation = null;
    if (failure != null || candidate == null || !request.modelId().equals(candidate.modelId())) {
      if (candidate != null) runtime.release(candidate);
      publish(AvatarModelPhase.FAILED, request, "AVATAR_PREPARE_FAILED");
      pendingRequest = null;
      return;
    }
    readyCandidate = candidate;
    publish(AvatarModelPhase.READY, request, null);
  }

  private void requestCommit(AvatarModelControlRequest request) {
    if (pendingRequest == null
        || readyCandidate == null
        || !pendingRequest.requestId().equals(request.requestId())
        || !pendingRequest.modelId().equals(request.modelId())) {
      return;
    }
    commitRequested = true;
  }

  private void cancel(AvatarModelControlRequest request) {
    if (pendingRequest == null
        || !pendingRequest.requestId().equals(request.requestId())
        || !pendingRequest.modelId().equals(request.modelId())) {
      return;
    }
    discardPending();
    publish(AvatarModelPhase.CANCELLED, request, null);
  }

  private void discardPending() {
    generation++;
    if (preparation != null) preparation.cancel(true);
    preparation = null;
    commitRequested = false;
    if (readyCandidate != null) {
      runtime.cancel(readyCandidate);
      runtime.release(readyCandidate);
      readyCandidate = null;
    }
    if (visibleCandidate != null) {
      runtime.cancel(visibleCandidate);
      runtime.release(visibleCandidate);
      activeCandidate = oldCandidate;
      if (oldActiveModelId != null) confirmedActiveModelId = oldActiveModelId;
      oldCandidate = null;
      oldActiveModelId = null;
      visibleCandidate = null;
    }
    pendingRequest = null;
  }

  private void publish(
      AvatarModelPhase phase, AvatarModelControlRequest request, String errorCode) {
    String candidateModelId =
        switch (phase) {
          case PREPARING, READY, COMMITTED -> request.modelId();
          case CANCELLED, FAILED -> request.modelId();
        };
    statePublisher.accept(
        new AvatarModelControlState(
            1,
            request.requestId(),
            phase,
            phase == AvatarModelPhase.COMMITTED ? request.modelId() : confirmedActiveModelId,
            candidateModelId,
            request.worldSessionId(),
            errorCode,
            Instant.now(clock)));
  }
}
