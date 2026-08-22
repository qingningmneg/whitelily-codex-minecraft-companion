package io.github.whitelily.avatar.render.backend;

import io.github.whitelily.avatar.control.AvatarCandidateRuntime;
import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import io.github.whitelily.avatar.control.AvatarVisibleFrameResult;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

public final class AvatarRenderBackendRegistry implements AvatarCandidateRuntime, AutoCloseable {
  private final Map<String, WhiteLilyAvatarRenderBackend> backends;
  private final Consumer<AvatarVisibleFrameResult> visibleFrameListener;
  private final ExecutorService prepareExecutor;
  private final Map<CompletableFuture<PreparedCandidate>, Future<?>> preparations =
      new ConcurrentHashMap<>();
  private final AtomicBoolean closed = new AtomicBoolean();
  private RegistryCandidate active;
  private RegistryCandidate previous;
  private RegistryCandidate awaitingVisible;

  public AvatarRenderBackendRegistry(
      Map<String, WhiteLilyAvatarRenderBackend> backends,
      Consumer<AvatarVisibleFrameResult> visibleFrameListener) {
    this.backends = Map.copyOf(backends);
    this.visibleFrameListener = Objects.requireNonNull(visibleFrameListener, "visibleFrameListener");
    this.prepareExecutor =
        new ThreadPoolExecutor(
            1,
            1,
            0L,
            TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(16),
            runnable -> {
              Thread thread = new Thread(runnable, "whitelily-avatar-decode");
              thread.setDaemon(true);
              return thread;
            },
            new ThreadPoolExecutor.AbortPolicy());
  }

  @Override
  public CompletionStage<PreparedCandidate> prepare(AvatarRuntimeDescriptor descriptor) {
    WhiteLilyAvatarRenderBackend backend = backends.get(descriptor.worldRenderer());
    if (backend == null) {
      return CompletableFuture.failedFuture(
          new IllegalArgumentException("no avatar backend accepts this world renderer"));
    }
    if (closed.get()) {
      return CompletableFuture.failedFuture(new IllegalStateException("avatar registry is closed"));
    }
    CompletableFuture<PreparedCandidate> result = new CompletableFuture<>();
    final Future<?> task;
    try {
      task =
          prepareExecutor.submit(
              () -> {
                RegistryCandidate candidate = null;
                try {
                  PreparedAvatarResources resources = backend.prepare(descriptor);
                  if (resources == null || !descriptor.modelId().equals(resources.modelId())) {
                    throw new AvatarRenderException(
                        "AVATAR_PREPARE_FAILED",
                        "avatar backend returned invalid prepared resources");
                  }
                  candidate = new RegistryCandidate(descriptor.modelId(), backend, resources);
                  if (!result.complete(candidate)) dispose(candidate);
                } catch (AvatarRenderException | RuntimeException error) {
                  result.completeExceptionally(error);
                } finally {
                  preparations.remove(result);
                }
              });
    } catch (RejectedExecutionException error) {
      return CompletableFuture.failedFuture(error);
    }
    preparations.put(result, task);
    if (result.isDone()) preparations.remove(result, task);
    result.whenComplete(
        (ignored, failure) -> {
          if (result.isCancelled()) task.cancel(true);
        });
    return result;
  }

  @Override
  public synchronized void requestCommit(PreparedCandidate candidate) {
    RegistryCandidate owned = owned(candidate);
    if (owned.disposed.get()) throw new IllegalStateException("avatar candidate was disposed");
    previous = active;
    active = owned;
    awaitingVisible = owned;
  }

  public synchronized void activateInitial(PreparedCandidate candidate) {
    RegistryCandidate owned = owned(candidate);
    if (active != null || owned.disposed.get()) {
      throw new IllegalStateException("initial avatar backend is already active");
    }
    active = owned;
  }

  @Override
  public synchronized void cancel(PreparedCandidate candidate) {
    RegistryCandidate owned = owned(candidate);
    if (active == owned && awaitingVisible == owned) {
      active = previous;
      previous = null;
      awaitingVisible = null;
    }
  }

  @Override
  public void release(PreparedCandidate candidate) {
    RegistryCandidate owned = owned(candidate);
    synchronized (this) {
      if (active == owned) active = null;
      if (previous == owned) previous = null;
      if (awaitingVisible == owned) awaitingVisible = null;
    }
    dispose(owned);
  }

  public AvatarRenderOutcome render(AvatarVisualState state, AvatarRenderContext context) {
    RegistryCandidate candidate;
    synchronized (this) {
      candidate = active;
    }
    if (candidate == null || candidate.disposed.get()) {
      return AvatarRenderOutcome.vanilla("AVATAR_BACKEND_UNAVAILABLE");
    }
    AvatarRenderContext.FrameTransaction transaction;
    try {
      transaction = context.beginFrame();
    } catch (RuntimeException error) {
      failVisibleCandidate(candidate);
      return AvatarRenderOutcome.vanilla("AVATAR_GRAPHICS_STATE_FAILED");
    }
    try {
      AvatarFrameResult result = candidate.backend.renderFrame(candidate.resources, state, context);
      if (result != null && result.successful()) {
        try {
          transaction.commit();
        } catch (Exception | LinkageError error) {
          transaction.restore();
          AvatarFrameResult deferred =
              candidate.backend.onDeferredFrameFailure(candidate.resources, state, error);
          failVisibleCandidate(candidate);
          return AvatarRenderOutcome.vanilla(
              deferred == null ? "AVATAR_FRAME_FAILED" : deferred.errorCode());
        }
        completeVisibleCandidate(candidate);
        return AvatarRenderOutcome.customComplete();
      }
      transaction.restore();
      failVisibleCandidate(candidate);
      return AvatarRenderOutcome.vanilla(
          result == null ? "AVATAR_FRAME_FAILED" : result.errorCode());
    } catch (Exception | LinkageError error) {
      transaction.restore();
      failVisibleCandidate(candidate);
      return AvatarRenderOutcome.vanilla("AVATAR_FRAME_FAILED");
    }
  }

  @Override
  public void close() {
    if (!closed.compareAndSet(false, true)) return;
    for (Map.Entry<CompletableFuture<PreparedCandidate>, Future<?>> preparation :
        preparations.entrySet()) {
      preparation.getKey().cancel(true);
      preparation.getValue().cancel(true);
    }
    preparations.clear();
    prepareExecutor.shutdownNow();
    Set<RegistryCandidate> candidates = new HashSet<>();
    synchronized (this) {
      if (active != null) candidates.add(active);
      if (previous != null) candidates.add(previous);
      if (awaitingVisible != null) candidates.add(awaitingVisible);
      active = null;
      previous = null;
      awaitingVisible = null;
    }
    for (RegistryCandidate candidate : candidates) dispose(candidate);
    for (WhiteLilyAvatarRenderBackend backend : new HashSet<>(backends.values())) backend.close();
  }

  private void completeVisibleCandidate(RegistryCandidate candidate) {
    RegistryCandidate retired;
    synchronized (this) {
      if (awaitingVisible != candidate) return;
      retired = previous;
      previous = null;
      awaitingVisible = null;
    }
    visibleFrameListener.accept(AvatarVisibleFrameResult.COMPLETE);
    if (retired != null) dispose(retired);
  }

  private void failVisibleCandidate(RegistryCandidate candidate) {
    synchronized (this) {
      if (awaitingVisible != candidate) return;
      active = previous;
      previous = null;
      awaitingVisible = null;
    }
    visibleFrameListener.accept(AvatarVisibleFrameResult.FAILED);
  }

  private static void dispose(RegistryCandidate candidate) {
    if (candidate.disposed.compareAndSet(false, true)) {
      candidate.backend.dispose(candidate.resources);
    }
  }

  private static RegistryCandidate owned(PreparedCandidate candidate) {
    if (candidate instanceof RegistryCandidate owned) return owned;
    throw new IllegalArgumentException("avatar candidate belongs to another runtime");
  }

  private static final class RegistryCandidate implements PreparedCandidate {
    private final String modelId;
    private final WhiteLilyAvatarRenderBackend backend;
    private final PreparedAvatarResources resources;
    private final AtomicBoolean disposed = new AtomicBoolean();

    private RegistryCandidate(
        String modelId,
        WhiteLilyAvatarRenderBackend backend,
        PreparedAvatarResources resources) {
      this.modelId = modelId;
      this.backend = backend;
      this.resources = resources;
    }

    @Override
    public String modelId() {
      return modelId;
    }
  }
}
