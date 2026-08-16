package io.github.whitelily.avatar.render.diagnostics;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/** Emits the first instance of a diagnostic and a bounded summary for its duplicate burst. */
public final class AvatarDiagnosticRateLimiter {
  private static final long WINDOW_MILLIS = 30_000L;

  public record Emission(AvatarRenderDiagnostic diagnostic, boolean summary, int suppressedCount) {
    public Emission {
      Objects.requireNonNull(diagnostic, "diagnostic");
      if (suppressedCount < 0) throw new IllegalArgumentException("suppressedCount must not be negative");
      if (summary == (suppressedCount == 0)) {
        throw new IllegalArgumentException("summary emissions must carry a suppressed count");
      }
    }
  }

  private final Clock clock;
  private final Map<Key, Window> windows = new ConcurrentHashMap<>();

  public AvatarDiagnosticRateLimiter() {
    this(Clock.systemUTC());
  }

  public AvatarDiagnosticRateLimiter(Clock clock) {
    this.clock = Objects.requireNonNull(clock, "clock");
  }

  public List<Emission> record(AvatarRenderDiagnostic diagnostic) {
    return record(diagnostic, clock.millis());
  }

  public synchronized List<Emission> record(AvatarRenderDiagnostic diagnostic, long nowMillis) {
    Objects.requireNonNull(diagnostic, "diagnostic");
    Key key = new Key(diagnostic.sessionId(), diagnostic.modelId(), diagnostic.errorCode());
    Window existing = windows.get(key);
    if (existing == null) {
      windows.put(key, new Window(nowMillis, 0, diagnostic));
      return List.of(new Emission(diagnostic, false, 0));
    }
    if (nowMillis - existing.startedAtMillis < WINDOW_MILLIS) {
      windows.put(
          key,
          new Window(existing.startedAtMillis, existing.suppressedCount + 1, existing.diagnostic));
      return List.of();
    }
    List<Emission> emissions = new ArrayList<>(2);
    if (existing.suppressedCount > 0) {
      emissions.add(new Emission(diagnostic, true, existing.suppressedCount));
    }
    windows.put(key, new Window(nowMillis, 0, diagnostic));
    emissions.add(new Emission(diagnostic, false, 0));
    return List.copyOf(emissions);
  }

  public List<Emission> flushExpired() {
    return flushExpired(clock.millis());
  }

  public synchronized List<Emission> flushExpired(long nowMillis) {
    List<Emission> emissions = new ArrayList<>();
    windows.entrySet().removeIf(
        entry -> {
          Window window = entry.getValue();
          if (nowMillis - window.startedAtMillis < WINDOW_MILLIS) return false;
          if (window.suppressedCount > 0) {
            AvatarRenderDiagnostic original = window.diagnostic;
            emissions.add(
                new Emission(
                    new AvatarRenderDiagnostic(
                        original.assetVersion(),
                        original.backend(),
                        original.modelId(),
                        original.detailLevel(),
                        original.armorTheme(),
                        original.materialTier(),
                        original.sessionId(),
                        original.errorCode(),
                        "duplicate diagnostics suppressed"),
                    true,
                    window.suppressedCount));
          }
          return true;
        });
    return List.copyOf(emissions);
  }

  private record Key(String sessionId, String modelId, String errorCode) {}

  private record Window(long startedAtMillis, int suppressedCount, AvatarRenderDiagnostic diagnostic) {}
}
