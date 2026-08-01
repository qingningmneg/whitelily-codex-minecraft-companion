package io.github.whitelily.avatar.render;

public record WhiteLilyCapturedRender(
    WhiteLilyRenderDecision decision, WhiteLilyGeoRenderState renderState) {
  @Override
  public String toString() {
    return "WhiteLilyCapturedRender[redacted]";
  }
}
