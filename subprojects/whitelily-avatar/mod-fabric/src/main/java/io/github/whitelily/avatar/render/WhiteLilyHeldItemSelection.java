package io.github.whitelily.avatar.render;

import java.util.Optional;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.item.ItemDisplayContext;

record WhiteLilyHeldItemSelection(
    String boneName,
    InteractionHand interactionHand,
    ItemDisplayContext displayContext) {
  static final String RIGHT_HAND_BONE = "held_item";
  static final String LEFT_HAND_BONE = "left_arm";

  static Optional<WhiteLilyHeldItemSelection> forBone(
      String boneName,
      HumanoidArm mainArm,
      boolean mainHandEmpty,
      boolean offHandEmpty) {
    if (mainArm == null) {
      return Optional.empty();
    }

    HumanoidArm physicalArm;
    ItemDisplayContext context;
    if (RIGHT_HAND_BONE.equals(boneName)) {
      physicalArm = HumanoidArm.RIGHT;
      context = ItemDisplayContext.THIRD_PERSON_RIGHT_HAND;
    } else if (LEFT_HAND_BONE.equals(boneName)) {
      physicalArm = HumanoidArm.LEFT;
      context = ItemDisplayContext.THIRD_PERSON_LEFT_HAND;
    } else {
      return Optional.empty();
    }

    InteractionHand hand =
        physicalArm == mainArm
            ? InteractionHand.MAIN_HAND
            : InteractionHand.OFF_HAND;
    if ((hand == InteractionHand.MAIN_HAND && mainHandEmpty)
        || (hand == InteractionHand.OFF_HAND && offHandEmpty)) {
      return Optional.empty();
    }

    return Optional.of(
        new WhiteLilyHeldItemSelection(boneName, hand, context));
  }
}
