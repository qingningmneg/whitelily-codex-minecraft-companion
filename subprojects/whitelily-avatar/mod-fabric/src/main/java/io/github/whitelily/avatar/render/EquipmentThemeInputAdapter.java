package io.github.whitelily.avatar.render;

import io.github.whitelily.avatar.theme.EquipmentThemeInput;
import java.util.Objects;
import java.util.function.Function;
import net.minecraft.world.entity.EquipmentSlot;

public final class EquipmentThemeInputAdapter {
  private EquipmentThemeInputAdapter() {}

  public static EquipmentThemeInput fromSlotIds(
      Function<EquipmentSlot, String> itemIdBySlot) {
    Objects.requireNonNull(itemIdBySlot);
    return new EquipmentThemeInput(
        itemIdBySlot.apply(EquipmentSlot.HEAD),
        itemIdBySlot.apply(EquipmentSlot.CHEST),
        itemIdBySlot.apply(EquipmentSlot.LEGS),
        itemIdBySlot.apply(EquipmentSlot.FEET));
  }
}
