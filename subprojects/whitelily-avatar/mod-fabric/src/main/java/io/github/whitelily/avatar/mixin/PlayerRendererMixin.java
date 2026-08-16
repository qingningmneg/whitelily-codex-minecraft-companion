package io.github.whitelily.avatar.mixin;

import io.github.whitelily.avatar.WhiteLilyAvatarClient;
import io.github.whitelily.avatar.render.WhiteLilyCapturedRender;
import io.github.whitelily.avatar.render.WhiteLilyGeoRenderState;
import io.github.whitelily.avatar.render.WhiteLilyGeoRenderer;
import io.github.whitelily.avatar.render.WhiteLilyPlayerRenderStateAccess;
import io.github.whitelily.avatar.render.WhiteLilyPlayerRendererAccess;
import io.github.whitelily.avatar.render.WhiteLilyRenderDecision;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.entity.player.PlayerRenderer;
import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(PlayerRenderer.class)
public abstract class PlayerRendererMixin
    implements WhiteLilyPlayerRendererAccess {
  @Unique private WhiteLilyGeoRenderer whitelily$geoRenderer;

  @Inject(
      method =
          "<init>(Lnet/minecraft/client/renderer/entity/EntityRendererProvider$Context;Z)V",
      at = @At("RETURN"))
  private void whitelily$createRenderer(
      EntityRendererProvider.Context context, boolean slim, CallbackInfo callback) {
    whitelily$geoRenderer = new WhiteLilyGeoRenderer(context);
  }

  @Inject(
      method =
          "extractRenderState(Lnet/minecraft/client/player/AbstractClientPlayer;"
              + "Lnet/minecraft/client/renderer/entity/state/PlayerRenderState;F)V",
      at = @At("RETURN"))
  private void whitelily$captureRenderState(
      AbstractClientPlayer player,
      PlayerRenderState playerRenderState,
      float partialTick,
      CallbackInfo callback) {
    WhiteLilyPlayerRenderStateAccess access =
        (WhiteLilyPlayerRenderStateAccess) playerRenderState;
    access.whitelily$setCapturedRender(null);

    WhiteLilyRenderDecision decision =
        WhiteLilyAvatarClient.renderRuntime().captureDecision(player);
    if (!decision.usesCustomRenderer()) {
      return;
    }

    WhiteLilyGeoRenderState[] capturedState = new WhiteLilyGeoRenderState[1];
    boolean captured =
        WhiteLilyAvatarClient.renderRuntime()
            .runCustom(
                decision,
                () ->
                    capturedState[0] =
                        whitelily$geoRenderer.captureRenderState(
                            player, partialTick, decision));
    if (captured) {
      access.whitelily$setCapturedRender(
          new WhiteLilyCapturedRender(
              decision,
              capturedState[0],
              WhiteLilyAvatarClient.renderRuntime()
                  .captureVisualState(player, partialTick, decision)));
    }
  }

  @Override
  public WhiteLilyGeoRenderer whitelily$getGeoRenderer() {
    return whitelily$geoRenderer;
  }
}
