package io.github.whitelily.avatar.render;

import com.mojang.blaze3d.vertex.PoseStack;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import software.bernie.geckolib.constant.DataTickets;
import software.bernie.geckolib.renderer.GeoReplacedEntityRenderer;

public final class WhiteLilyGeoRenderer
    extends GeoReplacedEntityRenderer<
        WhiteLilyAnimatable, AbstractClientPlayer, WhiteLilyGeoRenderState> {
  public WhiteLilyGeoRenderer(EntityRendererProvider.Context context) {
    super(context, new WhiteLilyGeoModel(), new WhiteLilyAnimatable());
    addRenderLayer(new WhiteLilyHeldItemGeoLayer(this));
  }

  @Override
  protected WhiteLilyGeoRenderState createBaseRenderState(AbstractClientPlayer player) {
    return new WhiteLilyGeoRenderState();
  }

  public WhiteLilyGeoRenderState captureRenderState(
      AbstractClientPlayer player, float partialTick, WhiteLilyRenderDecision decision) {
    WhiteLilyGeoRenderState state = createRenderState(player, partialTick);
    state.setArmorTheme(decision.armorTheme());
    return state;
  }

  public void renderCaptured(
      WhiteLilyGeoRenderState state,
      PoseStack poseStack,
      MultiBufferSource bufferSource,
      int packedLight) {
    state.addGeckolibData(DataTickets.PACKED_LIGHT, packedLight);
    render(state, poseStack, bufferSource, packedLight);
  }
}
