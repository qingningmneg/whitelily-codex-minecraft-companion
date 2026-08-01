package io.github.whitelily.avatar.render;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.math.Axis;
import net.minecraft.world.item.ItemDisplayContext;

final class WhiteLilyHeldItemPose {
  static final double LEFT_HAND_OFFSET_X = -2.0 / 16.0;
  static final double LEFT_HAND_OFFSET_Y = -9.0 / 16.0;
  static final double LEFT_HAND_OFFSET_Z = -1.0 / 16.0;

  private WhiteLilyHeldItemPose() {}

  static void withTransform(
      PoseStack poseStack,
      String boneName,
      ItemDisplayContext displayContext,
      boolean shield,
      Runnable renderOperation) {
    poseStack.pushPose();
    try {
      if (WhiteLilyHeldItemSelection.LEFT_HAND_BONE.equals(boneName)) {
        poseStack.translate(
            LEFT_HAND_OFFSET_X,
            LEFT_HAND_OFFSET_Y,
            LEFT_HAND_OFFSET_Z);
      }

      if (displayContext == ItemDisplayContext.THIRD_PERSON_RIGHT_HAND) {
        poseStack.mulPose(Axis.XN.rotationDegrees(90));
        poseStack.translate(0, 0.125, -0.0625);
        if (shield) {
          poseStack.translate(0, 0.125, -0.25);
        }
      } else {
        poseStack.mulPose(Axis.XP.rotationDegrees(-90));
        poseStack.translate(0, 0.125, -0.0625);
        if (shield) {
          poseStack.translate(0, 0.125, 0.25);
          poseStack.mulPose(Axis.YP.rotationDegrees(180));
        }
      }
      renderOperation.run();
    } finally {
      poseStack.popPose();
    }
  }
}
