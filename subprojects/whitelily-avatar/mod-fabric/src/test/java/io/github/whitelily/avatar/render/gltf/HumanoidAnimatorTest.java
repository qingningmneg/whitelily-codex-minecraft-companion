package io.github.whitelily.avatar.render.gltf;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.whitelily.avatar.render.backend.AvatarVisualState;
import io.github.whitelily.avatar.theme.ArmorTheme;
import java.util.LinkedHashMap;
import java.util.Map;
import org.joml.Matrix4f;
import org.junit.jupiter.api.Test;

final class HumanoidAnimatorTest {
  @Test
  void neutralOnlyModelsKeepANeutralFaceWhileBodyWorkAnimationRuns() {
    HumanoidSkeleton skeleton = skeleton(false);

    HumanoidAnimator.AvatarPose pose =
        new HumanoidAnimator().evaluate(state(false, true, true), skeleton, 0.25f);

    assertFalse(pose.bone("rightUpperArm").equals(new Matrix4f(), 0.0001f));
    assertEquals(HumanoidAnimator.ExpressionWeights.NEUTRAL, pose.expressions());
  }

  @Test
  void fullExpressionModelsSpeakWithoutStoppingTheWalkingCycle() {
    HumanoidSkeleton skeleton = skeleton(true);

    HumanoidAnimator.AvatarPose pose =
        new HumanoidAnimator().evaluate(state(true, true, false), skeleton, 0.375f);

    assertTrue(pose.expressions().weight("talk") > 0.0f);
    assertFalse(pose.bone("leftUpperLeg").equals(pose.bone("rightUpperLeg"), 0.0001f));
    assertFalse(pose.leftHand().equals(pose.rightHand(), 0.0001f));
  }

  private static HumanoidSkeleton skeleton(boolean fullExpressions) {
    Map<String, Matrix4f> bindPose = new LinkedHashMap<>();
    bindPose.put("hips", new Matrix4f().translation(0, 1, 0));
    bindPose.put("chest", new Matrix4f().translation(0, 0.5f, 0));
    bindPose.put("neck", new Matrix4f().translation(0, 0.35f, 0));
    bindPose.put("head", new Matrix4f().translation(0, 0.25f, 0));
    bindPose.put("leftUpperArm", new Matrix4f().translation(0.3f, 0.25f, 0));
    bindPose.put("leftLowerArm", new Matrix4f().translation(0.35f, 0, 0));
    bindPose.put("leftHand", new Matrix4f().translation(0.3f, 0, 0));
    bindPose.put("rightUpperArm", new Matrix4f().translation(-0.3f, 0.25f, 0));
    bindPose.put("rightLowerArm", new Matrix4f().translation(-0.35f, 0, 0));
    bindPose.put("rightHand", new Matrix4f().translation(-0.3f, 0, 0));
    bindPose.put("leftUpperLeg", new Matrix4f().translation(0.15f, -0.4f, 0));
    bindPose.put("leftLowerLeg", new Matrix4f().translation(0, -0.5f, 0));
    bindPose.put("leftFoot", new Matrix4f().translation(0, -0.4f, 0.1f));
    bindPose.put("rightUpperLeg", new Matrix4f().translation(-0.15f, -0.4f, 0));
    bindPose.put("rightLowerLeg", new Matrix4f().translation(0, -0.5f, 0));
    bindPose.put("rightFoot", new Matrix4f().translation(0, -0.4f, 0.1f));
    return HumanoidSkeleton.fromSemanticBindPose(bindPose, fullExpressions);
  }

  private static AvatarVisualState state(boolean speaking, boolean moving, boolean working) {
    return new AvatarVisualState(
        1,
        "world-animator",
        0,
        64,
        0,
        0,
        12,
        "standing",
        0.5f,
        0.5f,
        ArmorTheme.DIAMOND,
        "minecraft:iron_pickaxe",
        "minecraft:torch",
        moving,
        false,
        false,
        false,
        speaking,
        working,
        "happy",
        4,
        new AvatarVisualState.GraphicsCapabilities(true, true, 128));
  }
}
