package io.github.whitelily.avatar.render.backend;

public record AvatarRenderOutcome(boolean suppressVanilla, String errorCode) {
  public static AvatarRenderOutcome customComplete() {
    return new AvatarRenderOutcome(true, null);
  }

  public static AvatarRenderOutcome vanilla(String errorCode) {
    return new AvatarRenderOutcome(false, errorCode);
  }
}
