package io.github.whitelily.avatar.render.backend;

import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;

public final class ClassicGeckoRenderBackend implements WhiteLilyAvatarRenderBackend {
  @Override
  public PreparedAvatarResources prepare(AvatarRuntimeDescriptor descriptor)
      throws AvatarRenderException {
    throw new AvatarRenderException(
        "AVATAR_BACKEND_MISMATCH", "classic Gecko rendering is unavailable for native skin descriptors");
  }

  @Override
  public AvatarFrameResult renderFrame(
      PreparedAvatarResources resources,
      AvatarVisualState state,
      AvatarRenderContext context) {
    if (!(resources instanceof ClassicResources)) {
      return AvatarFrameResult.failed("AVATAR_BACKEND_MISMATCH");
    }
    context.renderClassic();
    return AvatarFrameResult.complete();
  }

  @Override
  public void dispose(PreparedAvatarResources resources) {}

  private record ClassicResources(String modelId) implements PreparedAvatarResources {}
}
