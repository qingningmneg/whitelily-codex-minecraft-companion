package io.github.whitelily.avatar.render.gltf;

import io.github.whitelily.avatar.render.backend.AvatarVisualState;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.joml.Matrix4f;

public final class HumanoidAnimator {
  public AvatarPose evaluate(
      AvatarVisualState state, HumanoidSkeleton skeleton, float elapsedSeconds) {
    Objects.requireNonNull(state, "state");
    Objects.requireNonNull(skeleton, "skeleton");
    if (!Float.isFinite(elapsedSeconds)) throw new IllegalArgumentException("invalid animation time");

    List<Matrix4f> localJoints =
        skeleton.joints().stream().map(HumanoidSkeleton.JointBinding::bindLocal).toList();
    Map<String, Matrix4f> local = new LinkedHashMap<>();
    for (HumanoidSkeleton.SemanticBone bone : skeleton.semanticBones())
      local.put(bone.semantic(), localJoints.get(bone.jointIndex()));
    float cycle = (float) Math.sin(elapsedSeconds * 8.0f);
    if (state.moving()) {
      rotateX(local, "leftUpperArm", cycle * 0.55f);
      rotateX(local, "rightUpperArm", -cycle * 0.55f);
      rotateX(local, "leftUpperLeg", -cycle * 0.7f);
      rotateX(local, "rightUpperLeg", cycle * 0.7f);
    }
    if (state.working()) {
      rotateX(local, "rightUpperArm", -1.05f + cycle * 0.25f);
      rotateX(local, "rightLowerArm", -0.55f);
    }
    if (state.swimming()) {
      rotateX(local, "leftUpperArm", -1.2f - cycle * 0.4f);
      rotateX(local, "rightUpperArm", -1.2f + cycle * 0.4f);
      rotateX(local, "leftUpperLeg", cycle * 0.3f);
      rotateX(local, "rightUpperLeg", -cycle * 0.3f);
    }
    if (state.sleeping()) rotateZ(local, "hips", (float) (Math.PI / 2.0));
    if (state.hurt()) rotateZ(local, "chest", cycle * 0.12f + 0.1f);
    rotateX(local, "head", (float) Math.toRadians(state.headPitch()));

    Matrix4f[] jointWorld = new Matrix4f[skeleton.jointCount()];
    for (int start = 0; start < skeleton.jointCount(); start++) {
      if (jointWorld[start] != null) continue;
      ArrayDeque<Integer> chain = new ArrayDeque<>();
      int current = start;
      while (current >= 0 && jointWorld[current] == null) {
        chain.push(current);
        current = skeleton.joints().get(current).parentJointIndex();
      }
      Matrix4f parent = current < 0 ? new Matrix4f() : jointWorld[current];
      while (!chain.isEmpty()) {
        int joint = chain.pop();
        parent = new Matrix4f(parent).mul(localJoints.get(joint));
        jointWorld[joint] = parent;
      }
    }
    List<Matrix4f> joints = new ArrayList<>(skeleton.jointCount());
    for (HumanoidSkeleton.JointBinding binding : skeleton.joints()) {
      joints.add(
          new Matrix4f(jointWorld[binding.jointIndex()]).mul(binding.inverseBind()));
    }
    Map<String, Matrix4f> world = new LinkedHashMap<>();
    for (HumanoidSkeleton.SemanticBone bone : skeleton.semanticBones()) {
      world.put(bone.semantic(), jointWorld[bone.jointIndex()]);
    }
    ExpressionWeights expressions =
        skeleton.fullExpressions()
            ? expressiveWeights(state, elapsedSeconds)
            : ExpressionWeights.NEUTRAL;
    return new AvatarPose(
        world, joints, expressions, world.get("leftHand"), world.get("rightHand"));
  }

  private static ExpressionWeights expressiveWeights(
      AvatarVisualState state, float elapsedSeconds) {
    Map<String, Float> weights = new LinkedHashMap<>();
    if (state.speaking()) {
      weights.put("talk", 0.5f + 0.5f * (float) Math.sin(elapsedSeconds * 12.0f));
    }
    if (!"neutral".equals(state.expression())) weights.put(state.expression(), 1.0f);
    return weights.isEmpty() ? ExpressionWeights.NEUTRAL : new ExpressionWeights(weights);
  }

  private static void rotateX(Map<String, Matrix4f> local, String bone, float radians) {
    local.get(bone).rotateX(radians);
  }

  private static void rotateZ(Map<String, Matrix4f> local, String bone, float radians) {
    local.get(bone).rotateZ(radians);
  }

  public static final class AvatarPose {
    private final Map<String, Matrix4f> bones;
    private final List<Matrix4f> jointMatrices;
    private final ExpressionWeights expressions;
    private final Matrix4f leftHand;
    private final Matrix4f rightHand;

    private AvatarPose(
        Map<String, Matrix4f> bones,
        List<Matrix4f> jointMatrices,
        ExpressionWeights expressions,
        Matrix4f leftHand,
        Matrix4f rightHand) {
      Map<String, Matrix4f> copiedBones = new LinkedHashMap<>();
      bones.forEach((semantic, matrix) -> copiedBones.put(semantic, new Matrix4f(matrix)));
      this.bones = Map.copyOf(copiedBones);
      this.jointMatrices = jointMatrices.stream().map(Matrix4f::new).toList();
      this.expressions = expressions;
      this.leftHand = new Matrix4f(leftHand);
      this.rightHand = new Matrix4f(rightHand);
    }

    public Matrix4f bone(String semantic) {
      Matrix4f matrix = bones.get(semantic);
      if (matrix == null) throw new IllegalArgumentException("unknown humanoid semantic");
      return new Matrix4f(matrix);
    }

    public List<Matrix4f> jointMatrices() {
      return jointMatrices.stream().map(Matrix4f::new).toList();
    }

    public ExpressionWeights expressions() {
      return expressions;
    }

    public Matrix4f leftHand() {
      return new Matrix4f(leftHand);
    }

    public Matrix4f rightHand() {
      return new Matrix4f(rightHand);
    }
  }

  public static final class ExpressionWeights {
    public static final ExpressionWeights NEUTRAL = new ExpressionWeights(Map.of());

    private final Map<String, Float> weights;

    private ExpressionWeights(Map<String, Float> weights) {
      this.weights = Map.copyOf(weights);
    }

    public float weight(String expression) {
      return weights.getOrDefault(expression, 0.0f);
    }

    public Map<String, Float> asMap() {
      return weights;
    }
  }
}
