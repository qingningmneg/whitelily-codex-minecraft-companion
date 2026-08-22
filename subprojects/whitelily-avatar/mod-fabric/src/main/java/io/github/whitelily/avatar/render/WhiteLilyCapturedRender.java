package io.github.whitelily.avatar.render;

import io.github.whitelily.avatar.render.backend.AvatarVisualState;

public record WhiteLilyCapturedRender(
    WhiteLilyRenderDecision decision,
    WhiteLilyGeoRenderState renderState,
    AvatarVisualState visualState) {
  @Override
  public String toString() {
    return "WhiteLilyCapturedRender[redacted]";
  }
}
