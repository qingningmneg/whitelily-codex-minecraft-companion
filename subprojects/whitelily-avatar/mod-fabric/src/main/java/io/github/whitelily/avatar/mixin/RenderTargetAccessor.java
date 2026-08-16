package io.github.whitelily.avatar.mixin;

import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.textures.GpuTexture;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(RenderTarget.class)
public interface RenderTargetAccessor {
  @Accessor("colorTexture")
  void whitelily$setColorTexture(GpuTexture texture);

  @Accessor("depthTexture")
  void whitelily$setDepthTexture(GpuTexture texture);
}
