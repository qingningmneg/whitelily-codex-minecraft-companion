package io.github.whitelily.avatar.render.quality;

import io.github.whitelily.avatar.render.backend.AvatarVisualState;
import java.util.Objects;

/** Selects a stable detail tier without oscillating around the observer-distance boundary. */
public final class AvatarDetailSelector {
  private static final float INITIAL_HIGH_DISTANCE = 16.0f;
  private static final float HIGH_TO_LOW_DISTANCE = 18.0f;
  private static final float LOW_TO_HIGH_DISTANCE = 14.0f;
  private static final int HIGH_DETAIL_JOINT_MATRICES = 128;

  public enum AvatarDetailLevel {
    HIGH,
    LOW
  }

  public AvatarDetailLevel select(AvatarDetailLevel previous, float observerDistance) {
    validateDistance(observerDistance);
    if (previous == null) {
      return observerDistance <= INITIAL_HIGH_DISTANCE ? AvatarDetailLevel.HIGH : AvatarDetailLevel.LOW;
    }
    if (previous == AvatarDetailLevel.HIGH) {
      return observerDistance > HIGH_TO_LOW_DISTANCE ? AvatarDetailLevel.LOW : AvatarDetailLevel.HIGH;
    }
    return observerDistance < LOW_TO_HIGH_DISTANCE ? AvatarDetailLevel.HIGH : AvatarDetailLevel.LOW;
  }

  public AvatarDetailLevel select(
      AvatarDetailLevel previous,
      float observerDistance,
      AvatarVisualState.GraphicsCapabilities graphics) {
    Objects.requireNonNull(graphics, "graphics");
    if (!graphics.shaders() || graphics.maximumJointMatrices() < HIGH_DETAIL_JOINT_MATRICES) {
      return AvatarDetailLevel.LOW;
    }
    return select(previous, observerDistance);
  }

  private static void validateDistance(float observerDistance) {
    if (!Float.isFinite(observerDistance) || observerDistance < 0.0f) {
      throw new IllegalArgumentException("observer distance must be finite and non-negative");
    }
  }
}
