package io.github.whitelily.avatar;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/** Emits the native skin diagnostic at most once without affecting the render caller. */
public final class NativeSkinFailureDiagnostics {
  public static final String CODE = "WL_AVATAR_SKIN_001";

  private final Consumer<String> sink;
  private final AtomicBoolean reported = new AtomicBoolean();

  public NativeSkinFailureDiagnostics(Consumer<String> sink) {
    this.sink = sink;
  }

  public void report(RuntimeException error) {
    if (!reported.compareAndSet(false, true)) return;
    try {
      sink.accept(CODE);
    } catch (RuntimeException ignored) {
      // Diagnostics must not escape to the render loop.
    }
  }
}
