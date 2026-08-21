package io.github.whitelily.avatar.skin;

import io.github.whitelily.avatar.theme.ArmorTheme;
import java.util.EnumMap;
import java.util.Locale;
import java.util.Map;
import net.minecraft.client.resources.PlayerSkin;
import net.minecraft.resources.ResourceLocation;

public final class WhiteLilySkinCatalog {
  private static final String NAMESPACE = "whitelily_avatar";

  private final Map<ArmorTheme, PlayerSkin> skins;

  public WhiteLilySkinCatalog() {
    EnumMap<ArmorTheme, PlayerSkin> built = new EnumMap<>(ArmorTheme.class);
    for (ArmorTheme theme : ArmorTheme.values()) {
      String name = theme.name().toLowerCase(Locale.ROOT);
      ResourceLocation texture =
          ResourceLocation.fromNamespaceAndPath(NAMESPACE, "textures/skin/" + name + ".png");
      built.put(theme, new PlayerSkin(texture, null, null, null, PlayerSkin.Model.SLIM, true));
    }
    skins = Map.copyOf(built);
  }

  public PlayerSkin skinFor(ArmorTheme theme) {
    return skins.getOrDefault(theme == null ? ArmorTheme.BASE : theme, skins.get(ArmorTheme.BASE));
  }
}
