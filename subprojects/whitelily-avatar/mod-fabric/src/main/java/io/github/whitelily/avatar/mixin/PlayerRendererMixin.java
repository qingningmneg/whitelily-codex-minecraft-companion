package io.github.whitelily.avatar.mixin;

import io.github.whitelily.avatar.WhiteLilyAvatarClient;
import io.github.whitelily.avatar.render.NativeSkinStateApplication;
import io.github.whitelily.avatar.render.WhiteLilyRenderDecision;
import io.github.whitelily.avatar.skin.WhiteLilySkinCatalog;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.entity.player.PlayerRenderer;
import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import net.minecraft.client.resources.PlayerSkin;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(PlayerRenderer.class)
public abstract class PlayerRendererMixin {
  private static final WhiteLilySkinCatalog SKINS = new WhiteLilySkinCatalog();

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
    PlayerSkin original = playerRenderState.skin;
    try {
      WhiteLilyAvatarClient.onRenderBoundary(WhiteLilyAvatarClient.modelController());
      WhiteLilyRenderDecision decision =
          WhiteLilyAvatarClient.renderRuntime().captureDecision(player);
      if (!decision.usesNativeSkin()) return;
      playerRenderState.skin =
          NativeSkinStateApplication.apply(original, decision, SKINS::skinFor);
    } catch (RuntimeException error) {
      playerRenderState.skin = original;
    }
  }
}
