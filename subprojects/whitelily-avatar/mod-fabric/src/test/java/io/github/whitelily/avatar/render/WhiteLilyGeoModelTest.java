package io.github.whitelily.avatar.render;

import static org.junit.jupiter.api.Assertions.assertEquals;

import io.github.whitelily.avatar.theme.ArmorTheme;
import net.minecraft.resources.ResourceLocation;
import org.junit.jupiter.api.Test;

final class WhiteLilyGeoModelTest {
  private final WhiteLilyGeoModel model = new WhiteLilyGeoModel();

  @Test
  void selectsTheSharedGeckoModelAndExactThemeTexture() {
    WhiteLilyGeoRenderState state = new WhiteLilyGeoRenderState();
    state.setArmorTheme(ArmorTheme.DIAMOND);

    assertEquals(
        ResourceLocation.fromNamespaceAndPath("whitelily_avatar", "whitelily"),
        model.getModelResource(state));
    assertEquals(
        ResourceLocation.fromNamespaceAndPath(
            "whitelily_avatar", "textures/entity/diamond.png"),
        model.getTextureResource(state));
  }

  @Test
  void defaultsToTheBaseTextureForAnUninitializedRenderState() {
    WhiteLilyGeoRenderState state = new WhiteLilyGeoRenderState();

    assertEquals(
        ResourceLocation.fromNamespaceAndPath(
            "whitelily_avatar", "textures/entity/base.png"),
        model.getTextureResource(state));
  }
}
