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
  private boolean awaitingFinalization;
  private boolean finalizedCheckpoint;
  private boolean worldAvailable;
  private String worldSessionId;
  private TerminalReceipt terminalReceipt;
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

  public void accept(AvatarModelControlRequest request) {
    Objects.requireNonNull(request, "request");
    PreparationLaunch launch = null;
    synchronized (this) {
      if (request.schemaVersion() != 1) return;
      if (replayTerminalReceipt(request)) return;
      if (!worldAvailable) return;
      if (worldSessionId == null) {
        if (request.operation() != AvatarModelOperation.PREPARE) return;
        worldSessionId = request.worldSessionId();
      }
      if (!worldSessionId.equals(request.worldSessionId())) return;
      switch (request.operation()) {
        case PREPARE -> launch = beginPreparation(request);
        case COMMIT -> requestCommit(request);
        case FINALIZE -> finalizeCommit(request);
        case CANCEL -> cancel(request);
      }
    }
    if (launch != null) startPreparation(launch);
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
      rememberCancelled(pendingRequest);
      pendingRequest = null;
    }
  }

  public synchronized void onVisibleFrameResult(AvatarVisibleFrameResult result) {
    if (visibleCandidate == null || pendingRequest == null) return;
    PreparedCandidate candidate = visibleCandidate;
    AvatarModelControlRequest request = pendingRequest;
    if (result == AvatarVisibleFrameResult.COMPLETE) {
      awaitingFinalization = true;
      publish(AvatarModelPhase.VISIBLE, request, null);
      return;
    }
    runtime.cancel(candidate);
    runtime.release(candidate);
    activeCandidate = oldCandidate;
    confirmedActiveModelId = oldActiveModelId == null ? confirmedActiveModelId : oldActiveModelId;
    oldCandidate = null;
    oldActiveModelId = null;
    visibleCandidate = null;
    pendingRequest = null;
    publish(AvatarModelPhase.FAILED, request, "AVATAR_FRAME_FAILED");
    rememberCancelled(request);
  }

  public synchronized void cancelForWorldChange() {
    AvatarModelControlRequest request = pendingRequest;
    if (request != null) {
      if (finalizedCheckpoint) {
        sealFinalizedCheckpoint();
      } else {
        discardPending();
        rememberCancelled(request);
        publish(AvatarModelPhase.CANCELLED, request, null);
      }
    }
    worldAvailable = false;
    worldSessionId = null;
  }

  public synchronized void beginWorldSession() {
    AvatarModelControlRequest request = pendingRequest;
    if (request != null) {
      if (finalizedCheckpoint) sealFinalizedCheckpoint();
      else {
        discardPending();
        rememberCancelled(request);
        publish(AvatarModelPhase.CANCELLED, request, null);
      }
    }
    worldSessionId = null;
    worldAvailable = true;
  }

  public synchronized String confirmedActiveModelId() {
    return confirmedActiveModelId;
  }

  public synchronized String currentWorldSessionId() {
    return worldSessionId;
  }

  private PreparationLaunch beginPreparation(AvatarModelControlRequest request) {
    if (request.candidate() == null || !request.modelId().equals(request.candidate().modelId())) {
      return null;
    }
    if (pendingRequest != null) {
      if (finalizedCheckpoint) sealFinalizedCheckpoint();
      else discardPending();
    }
    terminalReceipt = null;
    pendingRequest = request;
    long capturedGeneration = ++generation;
    publish(AvatarModelPhase.PREPARING, request, null);
    return new PreparationLaunch(capturedGeneration, request);
  }

  private void startPreparation(PreparationLaunch launch) {
    final CompletionStage<PreparedCandidate> stage;
    try {
      stage = runtime.prepare(launch.request().candidate());
    } catch (RuntimeException error) {
      synchronized (this) {
        if (launch.generation() == generation && pendingRequest == launch.request()) {
          publish(AvatarModelPhase.FAILED, launch.request(), "AVATAR_PREPARE_FAILED");
          rememberCancelled(launch.request());
          pendingRequest = null;
        }
      }
      return;
    }
    CompletableFuture<PreparedCandidate> future = stage.toCompletableFuture();
    boolean current;
    synchronized (this) {
      current = launch.generation() == generation && pendingRequest == launch.request();
      if (current) preparation = future;
    }
    stage.whenComplete(
        (candidate, failure) ->
            completions.add(
                () ->
                    completePreparation(
                        launch.generation(), launch.request(), candidate, failure)));
    if (!current) future.cancel(true);
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
      rememberCancelled(request);
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
    rememberCancelled(request);
    publish(AvatarModelPhase.CANCELLED, request, null);
  }

  private void finalizeCommit(AvatarModelControlRequest request) {
    if (pendingRequest == null
        || visibleCandidate == null
        || !awaitingFinalization
        || !pendingRequest.requestId().equals(request.requestId())
        || !pendingRequest.modelId().equals(request.modelId())) {
      return;
    }
    confirmedActiveModelId = visibleCandidate.modelId();
    terminalReceipt = TerminalReceipt.committed(request);
    publish(AvatarModelPhase.COMMITTED, request, null);
    awaitingFinalization = false;
    finalizedCheckpoint = true;
  }

  private void discardPending() {
    generation++;
    if (preparation != null) preparation.cancel(true);
    preparation = null;
    commitRequested = false;
    awaitingFinalization = false;
    finalizedCheckpoint = false;
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

  private void sealFinalizedCheckpoint() {
    if (oldCandidate != null) runtime.release(oldCandidate);
    oldCandidate = null;
    oldActiveModelId = null;
    visibleCandidate = null;
    pendingRequest = null;
    finalizedCheckpoint = false;
  }

  private boolean replayTerminalReceipt(AvatarModelControlRequest request) {
    TerminalReceipt receipt = terminalReceipt;
    if (receipt == null || !receipt.matches(request)) return false;
    publish(receipt.phase(), request, null);
    return true;
  }

  private void rememberCancelled(AvatarModelControlRequest request) {
    terminalReceipt = TerminalReceipt.cancelled(request);
  }

  private void publish(
      AvatarModelPhase phase, AvatarModelControlRequest request, String errorCode) {
    String candidateModelId =
        switch (phase) {
          case PREPARING, READY, VISIBLE, COMMITTED -> request.modelId();
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

  private record PreparationLaunch(
      long generation, AvatarModelControlRequest request) {}

  private record TerminalReceipt(
      String requestId,
      String modelId,
      String worldSessionId,
      AvatarModelOperation operation,
      AvatarModelPhase phase) {
    private static TerminalReceipt cancelled(AvatarModelControlRequest request) {
      return new TerminalReceipt(
          request.requestId(),
          request.modelId(),
          request.worldSessionId(),
          AvatarModelOperation.CANCEL,
          AvatarModelPhase.CANCELLED);
    }

    private static TerminalReceipt committed(AvatarModelControlRequest request) {
      return new TerminalReceipt(
          request.requestId(),
          request.modelId(),
          request.worldSessionId(),
          AvatarModelOperation.FINALIZE,
          AvatarModelPhase.COMMITTED);
    }

    private boolean matches(AvatarModelControlRequest request) {
      return operation == request.operation()
          && requestId.equals(request.requestId())
          && modelId.equals(request.modelId())
          && worldSessionId.equals(request.worldSessionId());
    }
  }
}
