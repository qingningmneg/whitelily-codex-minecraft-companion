package io.github.whitelily.avatar.render.backend;

import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;

public interface WhiteLilyAvatarRenderBackend extends AutoCloseable {
  PreparedAvatarResources prepare(AvatarRuntimeDescriptor descriptor) throws AvatarRenderException;

  AvatarFrameResult renderFrame(
      PreparedAvatarResources resources,
      AvatarVisualState state,
      AvatarRenderContext context);

  void dispose(PreparedAvatarResources resources);

  @Override
  default void close() {}
}
