package io.github.whitelily.avatar.render.backend;

import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;

public interface WhiteLilyAvatarRenderBackend extends AutoCloseable {
  PreparedAvatarResources prepare(AvatarRuntimeDescriptor descriptor) throws AvatarRenderException;

  AvatarFrameResult renderFrame(
      PreparedAvatarResources resources,
      AvatarVisualState state,
      AvatarRenderContext context);

  default AvatarFrameResult onDeferredFrameFailure(
      PreparedAvatarResources resources, AvatarVisualState state, Throwable failure) {
    return AvatarFrameResult.failed("AVATAR_FRAME_FAILED");
  }

  void dispose(PreparedAvatarResources resources);

  @Override
  default void close() {}
}
