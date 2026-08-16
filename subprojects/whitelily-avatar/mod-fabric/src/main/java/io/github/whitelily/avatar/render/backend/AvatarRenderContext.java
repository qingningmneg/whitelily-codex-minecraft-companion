package io.github.whitelily.avatar.render.backend;

public interface AvatarRenderContext {
  FrameTransaction beginFrame();

  void renderClassic();

  interface FrameTransaction {
    void commit();

    void restore();
  }
}
