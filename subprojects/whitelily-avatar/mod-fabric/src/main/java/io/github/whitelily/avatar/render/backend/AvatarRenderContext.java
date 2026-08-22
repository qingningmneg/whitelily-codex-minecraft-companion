package io.github.whitelily.avatar.render.backend;

import io.github.whitelily.avatar.render.gltf.AvatarGpuResources;
import io.github.whitelily.avatar.render.gltf.SmoothMeshRenderBackend;

public interface AvatarRenderContext {
  FrameTransaction beginFrame();

  void renderClassic();

  default AvatarGpuResources.Device avatarGpuDevice() {
    throw new UnsupportedOperationException("smooth avatar GPU upload is unavailable");
  }

  default void renderSmooth(SmoothMeshRenderBackend.SmoothMeshFrame frame) {
    throw new UnsupportedOperationException("smooth avatar rendering is unavailable");
  }

  default void prepareSmooth(SmoothMeshRenderBackend.SmoothMeshFrame frame) {
    frame.resources().prepareFrame(frame);
  }

  interface FrameTransaction {
    void commit();

    void restore();
  }
}
