package io.github.whitelily.avatar.render;

import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.item.ItemStack;

final class WhiteLilyHeldItems {
  private final ItemStack mainHand;
  private final ItemStack offHand;
  private final HumanoidArm mainArm;

  private WhiteLilyHeldItems(
      ItemStack mainHand, ItemStack offHand, HumanoidArm mainArm) {
    this.mainHand = safeCopy(mainHand);
    this.offHand = safeCopy(offHand);
    this.mainArm = mainArm;
  }

  static WhiteLilyHeldItems capture(
      ItemStack mainHand, ItemStack offHand, HumanoidArm mainArm) {
    return new WhiteLilyHeldItems(mainHand, offHand, mainArm);
  }

  HumanoidArm mainArm() {
    return mainArm;
  }

  boolean isEmpty(InteractionHand hand) {
    return stack(hand).isEmpty();
  }

  ItemStack copyForRender(InteractionHand hand) {
    return stack(hand).copy();
  }

  @Override
  public String toString() {
    return "WhiteLilyHeldItems[mainHand=<redacted>, offHand=<redacted>, mainArm="
        + mainArm
        + "]";
  }

  private ItemStack stack(InteractionHand hand) {
    return hand == InteractionHand.MAIN_HAND ? mainHand : offHand;
  }

  private static ItemStack safeCopy(ItemStack stack) {
    return stack == null ? ItemStack.EMPTY : stack.copy();
  }
}
