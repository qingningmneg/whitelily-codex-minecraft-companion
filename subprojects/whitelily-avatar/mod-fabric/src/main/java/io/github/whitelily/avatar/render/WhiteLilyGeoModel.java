package io.github.whitelily.avatar.render;

import java.util.Locale;
import net.minecraft.resources.ResourceLocation;
import software.bernie.geckolib.model.GeoModel;
import software.bernie.geckolib.renderer.base.GeoRenderState;

public final class WhiteLilyGeoModel extends GeoModel<WhiteLilyAnimatable> {
  private static final String MOD_ID = "whitelily_avatar";
  private static final ResourceLocation MODEL =
      ResourceLocation.fromNamespaceAndPath(MOD_ID, "whitelily");
  private static final ResourceLocation FUTURE_ANIMATION_RESOURCE =
      ResourceLocation.fromNamespaceAndPath(MOD_ID, "whitelily");

  @Override
  public ResourceLocation getModelResource(GeoRenderState renderState) {
    return MODEL;
  }

  @Override
  public ResourceLocation getTextureResource(GeoRenderState renderState) {
    String theme = "base";
    if (renderState instanceof WhiteLilyGeoRenderState state) {
      theme = state.armorTheme().name().toLowerCase(Locale.ROOT);
    }
    return ResourceLocation.fromNamespaceAndPath(
        MOD_ID, "textures/entity/" + theme + ".png");
  }

  @Override
  public ResourceLocation getAnimationResource(WhiteLilyAnimatable animatable) {
    // No controller references this until Task 7 provides the animation resource.
    return FUTURE_ANIMATION_RESOURCE;
  }
}
