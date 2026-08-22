package io.github.whitelily.avatar.mixin;

import io.github.whitelily.avatar.WhiteLilyAvatarClient;
import io.github.whitelily.avatar.render.NativeSkinStateApplication;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.entity.player.PlayerRenderer;
import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(PlayerRenderer.class)
public abstract class PlayerRendererMixin {
  @Inject(
      method =
          "extractRenderState(Lnet/minecraft/client/player/AbstractClientPlayer;"
              + "Lnet/minecraft/client/renderer/entity/state/PlayerRenderState;F)V",
      at = @At("RETURN"))
  private void whitelily$applyNativeSkin(
      AbstractClientPlayer player,
      PlayerRenderState playerRenderState,
      float partialTick,
      CallbackInfo callback) {
    NativeSkinStateApplication.ApplicationResult result =
        NativeSkinStateApplication.apply(
            playerRenderState,
            () -> {
              WhiteLilyAvatarClient.onRenderBoundary(WhiteLilyAvatarClient.modelController());
              return WhiteLilyAvatarClient.renderRuntime().captureDecision(player);
            },
            WhiteLilyAvatarClient.skinCatalog()::skinFor);
    result.onApplied(WhiteLilyAvatarClient::onNativeSkinFrameVisible);
    result.reportFailure(WhiteLilyAvatarClient::reportNativeSkinFailure);
  }
}
