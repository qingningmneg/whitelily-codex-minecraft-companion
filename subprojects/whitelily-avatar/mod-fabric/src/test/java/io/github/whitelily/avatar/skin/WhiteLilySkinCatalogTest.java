package io.github.whitelily.avatar.skin;

import static org.junit.jupiter.api.Assertions.assertEquals;

import io.github.whitelily.avatar.theme.ArmorTheme;
import java.util.Locale;
import net.minecraft.client.resources.PlayerSkin;
import net.minecraft.resources.ResourceLocation;
import org.junit.jupiter.api.Test;

final class WhiteLilySkinCatalogTest {
  @Test
  void mapsEveryThemeToItsBundledSlimSkin() {
    WhiteLilySkinCatalog catalog = new WhiteLilySkinCatalog();

    for (ArmorTheme theme : ArmorTheme.values()) {
      PlayerSkin skin = catalog.skinFor(theme);

      assertEquals(PlayerSkin.Model.SLIM, skin.model());
      assertEquals(
          ResourceLocation.fromNamespaceAndPath(
              "whitelily_avatar", "textures/skin/" + theme.name().toLowerCase(Locale.ROOT) + ".png"),
          skin.texture());
    }
  }

  @Test
  void fallsBackToBaseForMissingTheme() {
    assertEquals(
        ResourceLocation.fromNamespaceAndPath("whitelily_avatar", "textures/skin/base.png"),
        new WhiteLilySkinCatalog().skinFor(null).texture());
  }
}
