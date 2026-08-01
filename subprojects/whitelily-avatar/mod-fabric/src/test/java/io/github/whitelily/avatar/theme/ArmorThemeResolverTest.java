package io.github.whitelily.avatar.theme;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

final class ArmorThemeResolverTest {
  private final ArmorThemeResolver resolver = new ArmorThemeResolver();

  @Test
  void chestplateWinsOverHigherPriorityBoots() {
    assertEquals(
        ArmorTheme.DIAMOND,
        resolver.resolve(input(null, "minecraft:diamond_chestplate", null, "minecraft:netherite_boots")));
  }

  @Test
  void recognizedLeatherChestplateBeatsNetheriteBoots() {
    assertEquals(
        ArmorTheme.LEATHER,
        resolver.resolve(input(null, "minecraft:leather_chestplate", null, "minecraft:netherite_boots")));
  }

  @Test
  void mapsChainmailChestplateToIron() {
    assertEquals(
        ArmorTheme.IRON,
        resolver.resolve(input(null, "minecraft:chainmail_chestplate", null, null)));
  }

  @Test
  void unknownChestplateDoesNotBlockRecognizedHelmet() {
    assertEquals(
        ArmorTheme.DIAMOND,
        resolver.resolve(input("minecraft:diamond_helmet", "minecraft:elytra", null, null)));
  }

  @Test
  void ignoresTurtleShellAndOtherUnknownArmor() {
    assertEquals(
        ArmorTheme.BASE,
        resolver.resolve(input("minecraft:turtle_helmet", "example:unknown_chestplate", null, null)));
  }

  @Test
  void choosesHighestRecognizedNonChestplateTheme() {
    assertEquals(
        ArmorTheme.NETHERITE,
        resolver.resolve(input("minecraft:diamond_helmet", null, "minecraft:netherite_leggings", "minecraft:golden_boots")));
  }

  @Test
  void mapsChainmailInEveryNonChestplateSlotToIron() {
    assertEquals(ArmorTheme.IRON, resolver.resolve(input("minecraft:chainmail_helmet", null, null, null)));
    assertEquals(ArmorTheme.IRON, resolver.resolve(input(null, null, "minecraft:chainmail_leggings", null)));
    assertEquals(ArmorTheme.IRON, resolver.resolve(input(null, null, null, "minecraft:chainmail_boots")));
  }

  @Test
  void rejectsArmorIdsInTheWrongSlot() {
    assertEquals(
        ArmorTheme.BASE,
        resolver.resolve(input("minecraft:diamond_chestplate", null, "minecraft:golden_helmet", "minecraft:iron_leggings")));
  }

  @Test
  void rejectsNearMissesAndNonLowercaseIds() {
    assertEquals(
        ArmorTheme.BASE,
        resolver.resolve(input("minecraft:diamond_helmet_extra", "minecraft:DIAMOND_CHESTPLATE", null, null)));
  }

  @Test
  void treatsNullAndBlankIdsAsUnknown() {
    assertEquals(ArmorTheme.BASE, resolver.resolve(input(null, "", " ", "\t")));
  }

  @Test
  void treatsNullInputAsBase() {
    assertEquals(ArmorTheme.BASE, resolver.resolve(null));
  }

  @Test
  void resolvesRepeatedCallsDeterministically() {
    EquipmentThemeInput input = input(
        "minecraft:golden_helmet", "example:unknown_chestplate", "minecraft:diamond_leggings", "minecraft:iron_boots");

    assertEquals(ArmorTheme.DIAMOND, resolver.resolve(input));
    assertEquals(ArmorTheme.DIAMOND, resolver.resolve(input));
  }

  private static EquipmentThemeInput input(String helmet, String chestplate, String leggings, String boots) {
    return new EquipmentThemeInput(helmet, chestplate, leggings, boots);
  }
}
