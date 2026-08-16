package io.github.whitelily.avatar;

import io.github.whitelily.avatar.control.AvatarCandidateRuntime;
import io.github.whitelily.avatar.control.AvatarModelControlException;
import io.github.whitelily.avatar.control.AvatarModelController;
import io.github.whitelily.avatar.control.AvatarModelMailbox;
import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import io.github.whitelily.avatar.render.WhiteLilyRenderRuntime;
import java.nio.file.Path;
import java.util.Optional;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientWorldEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;

public final class WhiteLilyAvatarClient implements ClientModInitializer {
  public static final String COMPONENT_VERSION = "0.1.0";

  private static final WhiteLilyRenderRuntime RENDER_RUNTIME =
      new WhiteLilyRenderRuntime();
  private static final long CONTROL_POLL_NANOS = 250_000_000L;
  private static final AtomicBoolean CONTROL_POLL_IN_FLIGHT = new AtomicBoolean();
  private static volatile AvatarCandidateRuntime candidateRuntime =
      new UnavailableCandidateRuntime();
  private static volatile AvatarModelController modelController;
  private static volatile AvatarModelMailbox modelMailbox;
  private static volatile ExecutorService controlExecutor;
  private static volatile long nextControlPollNanos;

  @Override
  public void onInitializeClient() {
    initializeModelControl();
    ClientPlayConnectionEvents.JOIN.register(
        (handler, sender, client) -> {
          RENDER_RUNTIME.beginSession();
          AvatarModelController controller = modelController;
          if (controller != null) controller.beginWorldSession();
        });
    ClientPlayConnectionEvents.DISCONNECT.register(
        (handler, client) -> {
          AvatarModelController controller = modelController;
          if (controller != null) controller.cancelForWorldChange();
          RENDER_RUNTIME.endSession();
        });
    ClientWorldEvents.AFTER_CLIENT_WORLD_CHANGE.register(
        (client, world) -> {
          AvatarModelController controller = modelController;
          if (controller != null) controller.cancelForWorldChange();
          if (world == null) {
            RENDER_RUNTIME.endSession();
          } else {
            RENDER_RUNTIME.beginSession();
            if (controller != null) controller.beginWorldSession();
          }
        });
    ClientTickEvents.END_CLIENT_TICK.register(
        client -> {
          AvatarModelController controller = modelController;
          if (controller == null) return;
          controller.tick();
          if (client.level == null) return;
          pollModelMailbox(controller);
        });
  }

  public static WhiteLilyRenderRuntime renderRuntime() {
    return RENDER_RUNTIME;
  }

  public static AvatarModelController modelController() {
    return modelController;
  }

  public static void installCandidateRuntime(AvatarCandidateRuntime runtime) {
    if (runtime == null) throw new IllegalArgumentException("avatar candidate runtime is required");
    candidateRuntime = runtime;
  }

  private static void initializeModelControl() {
    Optional<Path> dataRoot = dataRoot();
    if (dataRoot.isEmpty()) return;
    try {
      AvatarModelMailbox mailbox = new AvatarModelMailbox(dataRoot.get());
      ExecutorService executor =
          new ThreadPoolExecutor(
              1,
              1,
              0L,
              TimeUnit.MILLISECONDS,
              new ArrayBlockingQueue<>(16),
              runnable -> {
                Thread thread = new Thread(runnable, "whitelily-avatar-control");
                thread.setDaemon(true);
                return thread;
              },
              new ThreadPoolExecutor.AbortPolicy());
      AvatarModelController controller =
          new AvatarModelController(
              new DelegatingCandidateRuntime(),
              state ->
                  submitControl(
                      () -> {
                        try {
                          mailbox.publish(state);
                        } catch (AvatarModelControlException error) {
                          reportControlFailure(error);
                        }
                      }),
              "builtin:whitelily-classic",
              null);
      modelMailbox = mailbox;
      controlExecutor = executor;
      modelController = controller;
      Runtime.getRuntime()
          .addShutdownHook(new Thread(WhiteLilyAvatarClient::shutdownControl, "whitelily-avatar-control-stop"));
    } catch (AvatarModelControlException | RuntimeException error) {
      reportControlFailure(error);
    }
  }

  private static void pollModelMailbox(AvatarModelController controller) {
    long now = System.nanoTime();
    if (now < nextControlPollNanos || !CONTROL_POLL_IN_FLIGHT.compareAndSet(false, true)) return;
    nextControlPollNanos = now + CONTROL_POLL_NANOS;
    submitControl(
        () -> {
          try {
            AvatarModelMailbox mailbox = modelMailbox;
            if (mailbox != null) mailbox.poll().ifPresent(controller::accept);
          } catch (AvatarModelControlException error) {
            reportControlFailure(error);
          } finally {
            CONTROL_POLL_IN_FLIGHT.set(false);
          }
        });
  }

  private static void submitControl(Runnable operation) {
    ExecutorService executor = controlExecutor;
    if (executor == null) {
      CONTROL_POLL_IN_FLIGHT.set(false);
      return;
    }
    try {
      executor.execute(operation);
    } catch (RejectedExecutionException ignored) {
      CONTROL_POLL_IN_FLIGHT.set(false);
    }
  }

  private static Optional<Path> dataRoot() {
    String configured = System.getenv("WHITELILY_DATA_ROOT");
    if (configured != null && !configured.isBlank()) {
      Path path = Path.of(configured);
      return path.isAbsolute() ? Optional.of(path.normalize()) : Optional.empty();
    }
    String localAppData = System.getenv("LOCALAPPDATA");
    if (localAppData == null || localAppData.isBlank()) return Optional.empty();
    return Optional.of(Path.of(localAppData).toAbsolutePath().normalize().resolve("WhiteLily"));
  }

  private static void shutdownControl() {
    ExecutorService executor = controlExecutor;
    controlExecutor = null;
    if (executor != null) executor.shutdownNow();
  }

  private static void reportControlFailure(Throwable error) {
    String code =
        error instanceof AvatarModelControlException controlError
            ? controlError.code()
            : "AVATAR_CONTROL_FAILED";
    System.err.println(code);
  }

  private static final class DelegatingCandidateRuntime implements AvatarCandidateRuntime {
    @Override
    public CompletionStage<PreparedCandidate> prepare(AvatarRuntimeDescriptor descriptor) {
      AvatarCandidateRuntime owner = candidateRuntime;
      return owner.prepare(descriptor).thenApply(candidate -> new OwnedCandidate(owner, candidate));
    }

    @Override
    public void requestCommit(PreparedCandidate candidate) {
      OwnedCandidate owned = owned(candidate);
      owned.owner().requestCommit(owned.candidate());
    }

    @Override
    public void cancel(PreparedCandidate candidate) {
      OwnedCandidate owned = owned(candidate);
      owned.owner().cancel(owned.candidate());
    }

    @Override
    public void release(PreparedCandidate candidate) {
      OwnedCandidate owned = owned(candidate);
      owned.owner().release(owned.candidate());
    }

    private static OwnedCandidate owned(PreparedCandidate candidate) {
      if (candidate instanceof OwnedCandidate owned) return owned;
      throw new IllegalArgumentException("avatar candidate has no runtime owner");
    }
  }

  private record OwnedCandidate(
      AvatarCandidateRuntime owner, AvatarCandidateRuntime.PreparedCandidate candidate)
      implements AvatarCandidateRuntime.PreparedCandidate {
    @Override
    public String modelId() {
      return candidate.modelId();
    }
  }

  private static final class UnavailableCandidateRuntime implements AvatarCandidateRuntime {
    @Override
    public CompletionStage<PreparedCandidate> prepare(AvatarRuntimeDescriptor descriptor) {
      return CompletableFuture.failedFuture(new IllegalStateException("avatar renderer unavailable"));
    }

    @Override
    public void requestCommit(PreparedCandidate candidate) {
      throw new IllegalStateException("avatar renderer unavailable");
    }

    @Override
    public void cancel(PreparedCandidate candidate) {}

    @Override
    public void release(PreparedCandidate candidate) {}
  }

}
