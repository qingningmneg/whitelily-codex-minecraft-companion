package io.github.whitelily.avatar;

import io.github.whitelily.avatar.control.AvatarModelControlException;
import io.github.whitelily.avatar.control.AvatarModelController;
import io.github.whitelily.avatar.control.AvatarModelMailbox;
import io.github.whitelily.avatar.control.AvatarVisibleFrameResult;
import io.github.whitelily.avatar.render.WhiteLilyRenderRuntime;
import io.github.whitelily.avatar.skin.NativeSkinCandidateRuntime;
import io.github.whitelily.avatar.skin.ApprovedSkinCatalog;
import io.github.whitelily.avatar.skin.WhiteLilySkinCatalog;
import java.nio.file.Path;
import java.util.Optional;
import java.util.concurrent.ArrayBlockingQueue;
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
  public static final String COMPONENT_VERSION = "0.1.1";
  public static final String NATIVE_SKIN_FAILURE_CODE = NativeSkinFailureDiagnostics.CODE;

  private static final WhiteLilyRenderRuntime RENDER_RUNTIME =
      new WhiteLilyRenderRuntime();
  private static final NativeSkinFailureDiagnostics NATIVE_SKIN_FAILURE_DIAGNOSTICS =
      new NativeSkinFailureDiagnostics(System.err::println);
  private static final WhiteLilySkinCatalog SKIN_CATALOG = new WhiteLilySkinCatalog();
  private static volatile NativeSkinCandidateRuntime candidateRuntime =
      new NativeSkinCandidateRuntime(null, SKIN_CATALOG, approved ->
          java.util.concurrent.CompletableFuture.failedFuture(
              new IllegalStateException("approved skin runtime is unavailable")));
  private static final long CONTROL_POLL_NANOS = 250_000_000L;
  private static final AtomicBoolean CONTROL_POLL_IN_FLIGHT = new AtomicBoolean();
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

  public static WhiteLilySkinCatalog skinCatalog() {
    return SKIN_CATALOG;
  }

  public static void onRenderBoundary(AvatarModelController controller) {
    if (controller != null) controller.onRenderBoundary();
  }

  public static void onNativeSkinFrameVisible() {
    onNativeSkinFrameVisible(candidateRuntime, modelController);
  }

  /** Narrow composition seam for the native candidate's first-visible-frame handoff. */
  public static void onNativeSkinFrameVisible(
      NativeSkinCandidateRuntime runtime, AvatarModelController controller) {
    if (runtime == null || controller == null) return;
    try {
      runtime
          .consumeVisibleCommit()
          .ifPresent(ignored -> controller.onVisibleFrameResult(AvatarVisibleFrameResult.COMPLETE));
    } catch (RuntimeException error) {
      reportNativeSkinFailure(error);
    }
  }

  public static void reportNativeSkinFailure(RuntimeException error) {
    AvatarModelController controller = modelController;
    if (controller != null) controller.onVisibleFrameResult(AvatarVisibleFrameResult.FAILED);
    NATIVE_SKIN_FAILURE_DIAGNOSTICS.report(error);
  }

  private static void initializeModelControl() {
    Optional<Path> dataRoot = dataRoot();
    if (dataRoot.isEmpty()) return;
    try {
      AvatarModelMailbox mailbox = new AvatarModelMailbox(dataRoot.get());
      NativeSkinCandidateRuntime runtime = NativeSkinCandidateRuntime.forMinecraft(
          new ApprovedSkinCatalog(dataRoot.get()), SKIN_CATALOG);
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
              runtime,
              state ->
                  submitControl(
                      () -> {
                        try {
                          mailbox.publish(state);
                        } catch (AvatarModelControlException error) {
                          reportControlFailure(error);
                        }
                      }),
              "builtin:whitelily",
              null);
      modelMailbox = mailbox;
      candidateRuntime = runtime;
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

}
