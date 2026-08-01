package io.github.whitelily.avatar.render;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;

import com.mojang.blaze3d.vertex.PoseStack;
import org.joml.Matrix3f;
import org.joml.Matrix4f;
import org.junit.jupiter.api.Test;

final class WhiteLilyRenderPoseTest {
  @Test
  void customRenderUsesAnIndependentCopySoFailureCannotCorruptVanillaPose() {
    PoseStack vanillaPose = new PoseStack();
    vanillaPose.translate(2, 3, 4);
    Matrix4f expectedPose = new Matrix4f(vanillaPose.last().pose());
    Matrix3f expectedNormal = new Matrix3f(vanillaPose.last().normal());

    PoseStack customPose = WhiteLilyRenderPose.independentCopy(vanillaPose);
    customPose.translate(10, 20, 30);

    assertNotSame(vanillaPose, customPose);
    assertEquals(expectedPose, vanillaPose.last().pose());
    assertEquals(expectedNormal, vanillaPose.last().normal());
  }
}
