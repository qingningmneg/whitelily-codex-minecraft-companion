package io.github.whitelily.avatar.render.backend;

import io.github.whitelily.avatar.theme.ArmorTheme;
import java.util.Objects;

public record AvatarVisualState(
    long renderSessionEpoch,
    String worldSessionId,
    double x,
    double y,
    double z,
    float bodyYaw,
    float headPitch,
    String minecraftPose,
    float partialTick,
    ArmorTheme armorTheme,
    String mainHandItem,
    String offHandItem,
    boolean moving,
    boolean swimming,
    boolean sleeping,
    boolean hurt,
    boolean speaking,
    boolean working,
    String expression,
    float observerDistance,
    GraphicsCapabilities graphics) {
  public AvatarVisualState {
    worldSessionId = bounded(worldSessionId, 128, "worldSessionId");
    minecraftPose = bounded(minecraftPose, 64, "minecraftPose");
    mainHandItem = bounded(mainHandItem, 256, "mainHandItem");
    offHandItem = bounded(offHandItem, 256, "offHandItem");
    expression = bounded(expression, 64, "expression");
    armorTheme = Objects.requireNonNull(armorTheme, "armorTheme");
    graphics = Objects.requireNonNull(graphics, "graphics");
    if (renderSessionEpoch < 1
        || !Double.isFinite(x)
        || !Double.isFinite(y)
        || !Double.isFinite(z)
        || !Float.isFinite(bodyYaw)
        || !Float.isFinite(headPitch)
        || !Float.isFinite(partialTick)
        || partialTick < 0.0f
        || partialTick > 1.0f
        || !Float.isFinite(observerDistance)
        || observerDistance < 0.0f) {
      throw new IllegalArgumentException("invalid avatar visual state");
    }
  }

  public record GraphicsCapabilities(
      boolean shaders, boolean translucentMaterials, int maximumJointMatrices) {
    public GraphicsCapabilities {
      if (maximumJointMatrices < 0 || maximumJointMatrices > 256) {
        throw new IllegalArgumentException("invalid avatar graphics capabilities");
      }
    }
  }

  private static String bounded(String value, int maximumCodePoints, String name) {
    Objects.requireNonNull(value, name);
    if (value.isEmpty()
        || value.codePointCount(0, value.length()) > maximumCodePoints
        || value.codePoints().anyMatch(codePoint -> codePoint < 0x20 || codePoint == 0x7f)) {
      throw new IllegalArgumentException("invalid " + name);
    }
    return value;
  }
}
