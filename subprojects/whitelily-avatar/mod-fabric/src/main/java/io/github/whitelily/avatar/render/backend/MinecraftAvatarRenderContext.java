package io.github.whitelily.avatar.render.backend;

import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.ByteBufferBuilder;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.math.Axis;
import io.github.whitelily.avatar.render.WhiteLilyGeoRenderState;
import io.github.whitelily.avatar.render.gltf.AvatarGpuResources;
import io.github.whitelily.avatar.render.gltf.SmoothMeshRenderBackend;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.MultiBufferSource;

public final class MinecraftAvatarRenderContext implements AvatarRenderContext {
  private static final int FRAME_BUFFER_BYTES = 2 * 1024 * 1024;

  private final Consumer<MultiBufferSource> classicRenderer;
  private final PoseStack smoothPoseStack;
  private final WhiteLilyGeoRenderState smoothRenderState;
  private final int packedLight;
  private ByteBufferBuilder frameBuffer;
  private MultiBufferSource.BufferSource frameSource;
  private AtomicBoolean finished;
  private SmoothMeshRenderBackend.SmoothMeshFrame pendingSmoothFrame;
  private org.joml.Matrix4f pendingSmoothModelMatrix;

  public MinecraftAvatarRenderContext(Consumer<MultiBufferSource> classicRenderer) {
    this(classicRenderer, null, null, 0);
  }

  public MinecraftAvatarRenderContext(
      Consumer<MultiBufferSource> classicRenderer,
      PoseStack smoothPoseStack,
      WhiteLilyGeoRenderState smoothRenderState,
      int packedLight) {
    this.classicRenderer = Objects.requireNonNull(classicRenderer, "classicRenderer");
    this.smoothPoseStack = smoothPoseStack;
    this.smoothRenderState = smoothRenderState;
    this.packedLight = packedLight;
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
        boolean submitted = false;
        try {
          Runnable smoothDraw =
              pendingSmoothFrame != null && pendingSmoothModelMatrix != null
                  ? () ->
                      AvatarGpuResources.renderMinecraft(
                          pendingSmoothFrame,
                          pendingSmoothModelMatrix,
                          frameSource::endBatch)
                  : frameSource::endBatch;
          smoothDraw.run();
          submitted = true;
        } finally {
          closeBuffer(!submitted, shaderColor);
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

  @Override
  public AvatarGpuResources.Device avatarGpuDevice() {
    return AvatarGpuResources.minecraftDevice();
  }

  @Override
  public void renderSmooth(SmoothMeshRenderBackend.SmoothMeshFrame frame) {
    if (frameSource == null || finished == null || finished.get()) {
      throw new IllegalStateException("avatar frame is not writable");
    }
    if (smoothPoseStack == null || smoothRenderState == null) {
      throw new UnsupportedOperationException("smooth avatar context is unavailable");
    }
    smoothPoseStack.pushPose();
    try {
      smoothPoseStack.mulPose(
          Axis.YP.rotationDegrees(180.0f - frame.state().bodyYaw()));
      pendingSmoothFrame = frame;
      pendingSmoothModelMatrix = new org.joml.Matrix4f(smoothPoseStack.last().pose());
      var mainTarget = Minecraft.getInstance().getMainRenderTarget();
      MultiBufferSource stagedOnly =
          renderType -> {
            if (renderType.getRenderTarget() != mainTarget) {
              throw new UnsupportedOperationException(
                  "smooth held item render type escapes the staged target");
            }
            return frameSource.getBuffer(renderType);
          };
      smoothRenderState.renderSmoothHeldItems(
          smoothPoseStack,
          frame.leftHand(),
          frame.rightHand(),
          stagedOnly,
          packedLight);
    } finally {
      smoothPoseStack.popPose();
    }
  }

  private void closeBuffer(boolean discard, float[] shaderColor) {
    ByteBufferBuilder buffer = frameBuffer;
    pendingSmoothFrame = null;
    pendingSmoothModelMatrix = null;
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

  static void commitPreparedDraws(Runnable offscreenSkinning, Runnable heldItemBatch) {
    Objects.requireNonNull(offscreenSkinning, "offscreenSkinning").run();
    Objects.requireNonNull(heldItemBatch, "heldItemBatch").run();
  }
}
