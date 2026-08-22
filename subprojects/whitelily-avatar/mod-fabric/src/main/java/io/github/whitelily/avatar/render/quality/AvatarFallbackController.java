package io.github.whitelily.avatar.render.quality;

import java.util.Objects;

/** Maintains the single automatic fallback route for one active render negotiation. */
public final class AvatarFallbackController {
  public enum FallbackStage {
    FULL_QUALITY,
    BASIC_CEL,
    SAME_STYLE_LOW,
    VANILLA_FRAME_ONLY
  }

  public enum FailureType {
    SECONDARY_DYNAMICS_FAILED,
    NONESSENTIAL_TRANSPARENCY_FAILED,
    ADVANCED_MATERIAL_FAILED,
    HIGH_MODEL_FAILED
  }

  public record FallbackState(
      String sessionId,
      String activeModelId,
      FallbackStage stage,
      boolean secondaryDynamicsEnabled,
      boolean nonessentialTransparencyEnabled,
      boolean appearanceAccepted) {}

  private FallbackState state =
      new FallbackState("unbound", "unbound", FallbackStage.FULL_QUALITY, true, true, true);

  public synchronized void beginNegotiation(String sessionId, String validatedActiveModelId) {
    state =
        new FallbackState(
            required(sessionId, "sessionId"),
            required(validatedActiveModelId, "validatedActiveModelId"),
            FallbackStage.FULL_QUALITY,
            true,
            true,
            true);
  }

  public synchronized FallbackStage record(FailureType failure) {
    Objects.requireNonNull(failure, "failure");
    FallbackStage next = switch (state.stage()) {
      case FULL_QUALITY ->
          failure == FailureType.SECONDARY_DYNAMICS_FAILED
                  || failure == FailureType.NONESSENTIAL_TRANSPARENCY_FAILED
              ? FallbackStage.BASIC_CEL
              : FallbackStage.FULL_QUALITY;
      case BASIC_CEL ->
          failure == FailureType.ADVANCED_MATERIAL_FAILED
              ? FallbackStage.SAME_STYLE_LOW
              : FallbackStage.BASIC_CEL;
      case SAME_STYLE_LOW ->
          failure == FailureType.HIGH_MODEL_FAILED
              ? FallbackStage.VANILLA_FRAME_ONLY
              : FallbackStage.SAME_STYLE_LOW;
      case VANILLA_FRAME_ONLY -> FallbackStage.VANILLA_FRAME_ONLY;
    };
    if (next != state.stage()) {
      state =
          new FallbackState(
              state.sessionId(),
              state.activeModelId(),
              next,
              next == FallbackStage.FULL_QUALITY,
              next == FallbackStage.FULL_QUALITY,
              next != FallbackStage.VANILLA_FRAME_ONLY);
    }
    return state.stage();
  }

  public synchronized FallbackStage currentStage() {
    return state.stage();
  }

  public synchronized String activeModelId() {
    return state.activeModelId();
  }

  public synchronized FallbackState currentState() {
    return state;
  }

  private static String required(String value, String name) {
    value = Objects.requireNonNull(value, name);
    if (value.isBlank()) throw new IllegalArgumentException(name + " must not be blank");
    return value;
  }
}
