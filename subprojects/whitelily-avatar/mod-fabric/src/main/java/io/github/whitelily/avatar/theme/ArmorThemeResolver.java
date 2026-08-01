package io.github.whitelily.avatar.theme;

import java.util.Map;

public final class ArmorThemeResolver {
  private static final Map<String, ArmorTheme> HELMET_THEMES = Map.ofEntries(
      Map.entry("minecraft:leather_helmet", ArmorTheme.LEATHER),
      Map.entry("minecraft:chainmail_helmet", ArmorTheme.IRON),
      Map.entry("minecraft:iron_helmet", ArmorTheme.IRON),
      Map.entry("minecraft:golden_helmet", ArmorTheme.GOLD),
      Map.entry("minecraft:diamond_helmet", ArmorTheme.DIAMOND),
      Map.entry("minecraft:netherite_helmet", ArmorTheme.NETHERITE));

  private static final Map<String, ArmorTheme> CHESTPLATE_THEMES = Map.ofEntries(
      Map.entry("minecraft:leather_chestplate", ArmorTheme.LEATHER),
      Map.entry("minecraft:chainmail_chestplate", ArmorTheme.IRON),
      Map.entry("minecraft:iron_chestplate", ArmorTheme.IRON),
      Map.entry("minecraft:golden_chestplate", ArmorTheme.GOLD),
      Map.entry("minecraft:diamond_chestplate", ArmorTheme.DIAMOND),
      Map.entry("minecraft:netherite_chestplate", ArmorTheme.NETHERITE));

  private static final Map<String, ArmorTheme> LEGGINGS_THEMES = Map.ofEntries(
      Map.entry("minecraft:leather_leggings", ArmorTheme.LEATHER),
      Map.entry("minecraft:chainmail_leggings", ArmorTheme.IRON),
      Map.entry("minecraft:iron_leggings", ArmorTheme.IRON),
      Map.entry("minecraft:golden_leggings", ArmorTheme.GOLD),
      Map.entry("minecraft:diamond_leggings", ArmorTheme.DIAMOND),
      Map.entry("minecraft:netherite_leggings", ArmorTheme.NETHERITE));

  private static final Map<String, ArmorTheme> BOOTS_THEMES = Map.ofEntries(
      Map.entry("minecraft:leather_boots", ArmorTheme.LEATHER),
      Map.entry("minecraft:chainmail_boots", ArmorTheme.IRON),
      Map.entry("minecraft:iron_boots", ArmorTheme.IRON),
      Map.entry("minecraft:golden_boots", ArmorTheme.GOLD),
      Map.entry("minecraft:diamond_boots", ArmorTheme.DIAMOND),
      Map.entry("minecraft:netherite_boots", ArmorTheme.NETHERITE));

  private static final Map<ArmorTheme, Integer> PRIORITY = Map.of(
      ArmorTheme.BASE, 0,
      ArmorTheme.LEATHER, 1,
      ArmorTheme.IRON, 2,
      ArmorTheme.GOLD, 3,
      ArmorTheme.DIAMOND, 4,
      ArmorTheme.NETHERITE, 5);

  public ArmorTheme resolve(EquipmentThemeInput input) {
    if (input == null) {
      return ArmorTheme.BASE;
    }

    ArmorTheme chestplateTheme = themeFor(input.chestplate(), CHESTPLATE_THEMES);
    if (chestplateTheme != ArmorTheme.BASE) {
      return chestplateTheme;
    }

    ArmorTheme theme = ArmorTheme.BASE;
    theme = higherPriority(theme, themeFor(input.helmet(), HELMET_THEMES));
    theme = higherPriority(theme, themeFor(input.leggings(), LEGGINGS_THEMES));
    return higherPriority(theme, themeFor(input.boots(), BOOTS_THEMES));
  }

  private static ArmorTheme themeFor(String itemId, Map<String, ArmorTheme> themes) {
    if (itemId == null) {
      return ArmorTheme.BASE;
    }
    return themes.getOrDefault(itemId, ArmorTheme.BASE);
  }

  private static ArmorTheme higherPriority(ArmorTheme first, ArmorTheme second) {
    return PRIORITY.get(second) > PRIORITY.get(first) ? second : first;
  }
}
