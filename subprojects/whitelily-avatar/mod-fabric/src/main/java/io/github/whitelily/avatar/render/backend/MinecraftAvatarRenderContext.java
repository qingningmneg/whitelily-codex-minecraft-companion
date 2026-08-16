package io.github.whitelily.avatar.render.backend;

import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.ByteBufferBuilder;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import net.minecraft.client.renderer.MultiBufferSource;

public final class MinecraftAvatarRenderContext implements AvatarRenderContext {
  private static final int FRAME_BUFFER_BYTES = 2 * 1024 * 1024;

  private final Consumer<MultiBufferSource> classicRenderer;
  private ByteBufferBuilder frameBuffer;
  private MultiBufferSource.BufferSource frameSource;
  private AtomicBoolean finished;

  public MinecraftAvatarRenderContext(Consumer<MultiBufferSource> classicRenderer) {
    this.classicRenderer = Objects.requireNonNull(classicRenderer, "classicRenderer");
  }

  @Override
  public FrameTransaction beginFrame() {
    if (frameBuffer != null) throw new IllegalStateException("avatar frame already began");
    float[] shaderColor = RenderSystem.getShaderColor().clone();
    frameBuffer = new ByteBufferBuilder(FRAME_BUFFER_BYTES);
    frameSource = MultiBufferSource.immediate(frameBuffer);
    finished = new AtomicBoolean();
    return new FrameTransaction() {
      @Override
      public void commit() {
        if (!finished.compareAndSet(false, true)) return;
        try {
          frameSource.endBatch();
        } finally {
          closeBuffer(false, shaderColor);
        }
      }

      @Override
      public void restore() {
        if (!finished.compareAndSet(false, true)) return;
        closeBuffer(true, shaderColor);
      }
    };
  }

  @Override
  public void renderClassic() {
    if (frameSource == null || finished == null || finished.get()) {
      throw new IllegalStateException("avatar frame is not writable");
    }
    classicRenderer.accept(frameSource);
  }

  private void closeBuffer(boolean discard, float[] shaderColor) {
    ByteBufferBuilder buffer = frameBuffer;
    frameSource = null;
    frameBuffer = null;
    try {
      if (buffer != null && discard) buffer.discard();
    } finally {
      if (buffer != null) buffer.close();
      RenderSystem.setShaderColor(
          shaderColor[0], shaderColor[1], shaderColor[2], shaderColor[3]);
    }
  }
}
