package io.github.whitelily.avatar.render;

import static org.junit.jupiter.api.Assertions.assertEquals;

import io.github.whitelily.avatar.theme.EquipmentThemeInput;
import java.util.Map;
import net.minecraft.world.entity.EquipmentSlot;
import org.junit.jupiter.api.Test;

final class EquipmentThemeInputAdapterTest {
  @Test
  void mapsTheFourOfficialArmorSlotsExactlyWithoutAnItemStackDependency() {
    Map<EquipmentSlot, String> ids =
        Map.of(
            EquipmentSlot.HEAD, "minecraft:diamond_helmet",
            EquipmentSlot.CHEST, "minecraft:leather_chestplate",
            EquipmentSlot.LEGS, "minecraft:netherite_leggings",
            EquipmentSlot.FEET, "minecraft:golden_boots");

    EquipmentThemeInput input = EquipmentThemeInputAdapter.fromSlotIds(ids::get);

    assertEquals("minecraft:diamond_helmet", input.helmet());
    assertEquals("minecraft:leather_chestplate", input.chestplate());
    assertEquals("minecraft:netherite_leggings", input.leggings());
    assertEquals("minecraft:golden_boots", input.boots());
  }
}
