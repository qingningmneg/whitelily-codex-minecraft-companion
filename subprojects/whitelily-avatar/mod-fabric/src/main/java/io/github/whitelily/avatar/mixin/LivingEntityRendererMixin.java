package io.github.whitelily.avatar.mixin;

import com.mojang.blaze3d.vertex.PoseStack;
import io.github.whitelily.avatar.WhiteLilyAvatarClient;
import io.github.whitelily.avatar.render.WhiteLilyCapturedRender;
import io.github.whitelily.avatar.render.WhiteLilyPlayerRenderStateAccess;
import io.github.whitelily.avatar.render.WhiteLilyPlayerRendererAccess;
import io.github.whitelily.avatar.render.WhiteLilyRenderPose;
import io.github.whitelily.avatar.render.backend.AvatarRenderBackendRegistry;
import io.github.whitelily.avatar.render.backend.AvatarRenderOutcome;
import io.github.whitelily.avatar.render.backend.MinecraftAvatarRenderContext;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.entity.LivingEntityRenderer;
import net.minecraft.client.renderer.entity.state.LivingEntityRenderState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(LivingEntityRenderer.class)
public abstract class LivingEntityRendererMixin {
  @Inject(
      method =
          "render(Lnet/minecraft/client/renderer/entity/state/LivingEntityRenderState;"
              + "Lcom/mojang/blaze3d/vertex/PoseStack;"
              + "Lnet/minecraft/client/renderer/MultiBufferSource;I)V",
      at = @At("HEAD"),
      cancellable = true)
  private void whitelily$replaceMatchedPlayer(
      LivingEntityRenderState renderState,
      PoseStack poseStack,
      MultiBufferSource bufferSource,
      int packedLight,
      CallbackInfo callback) {
    if (!((Object) this instanceof WhiteLilyPlayerRendererAccess rendererAccess)
        || !(renderState instanceof WhiteLilyPlayerRenderStateAccess stateAccess)) {
      return;
    }

    WhiteLilyCapturedRender captured = stateAccess.whitelily$getCapturedRender();
    if (captured == null) {
      return;
    }

    PoseStack customPoseStack = WhiteLilyRenderPose.independentCopy(poseStack);
    AvatarRenderBackendRegistry registry = WhiteLilyAvatarClient.renderBackendRegistry();
    if (registry == null) return;
    AvatarRenderOutcome[] outcome = new AvatarRenderOutcome[1];
    boolean customCompleted =
        WhiteLilyAvatarClient.renderRuntime()
            .runCustom(
                captured.decision(),
                () ->
                    outcome[0] =
                        registry.render(
                            captured.visualState(),
                            new MinecraftAvatarRenderContext(
                                isolatedBufferSource ->
                                rendererAccess
                                    .whitelily$getGeoRenderer()
                                    .renderCaptured(
                                        captured.renderState(),
                                        customPoseStack,
                                        isolatedBufferSource,
                                        packedLight))));
    if (customCompleted && outcome[0] != null && outcome[0].suppressVanilla()) {
      callback.cancel();
    }
  }
}
