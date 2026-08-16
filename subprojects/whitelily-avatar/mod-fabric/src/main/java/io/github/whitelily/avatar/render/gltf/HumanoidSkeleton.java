package io.github.whitelily.avatar.render.gltf;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.joml.Matrix4f;

public final class HumanoidSkeleton {
  public static final List<String> REQUIRED_SEMANTICS =
      List.of(
          "hips",
          "chest",
          "neck",
          "head",
          "leftUpperArm",
          "leftLowerArm",
          "leftHand",
          "rightUpperArm",
          "rightLowerArm",
          "rightHand",
          "leftUpperLeg",
          "leftLowerLeg",
          "leftFoot",
          "rightUpperLeg",
          "rightLowerLeg",
          "rightFoot");

  private static final Map<String, String> SEMANTIC_PARENTS =
      Map.ofEntries(
          Map.entry("chest", "hips"),
          Map.entry("neck", "chest"),
          Map.entry("head", "neck"),
          Map.entry("leftUpperArm", "chest"),
          Map.entry("leftLowerArm", "leftUpperArm"),
          Map.entry("leftHand", "leftLowerArm"),
          Map.entry("rightUpperArm", "chest"),
          Map.entry("rightLowerArm", "rightUpperArm"),
          Map.entry("rightHand", "rightLowerArm"),
          Map.entry("leftUpperLeg", "hips"),
          Map.entry("leftLowerLeg", "leftUpperLeg"),
          Map.entry("leftFoot", "leftLowerLeg"),
          Map.entry("rightUpperLeg", "hips"),
          Map.entry("rightLowerLeg", "rightUpperLeg"),
          Map.entry("rightFoot", "rightLowerLeg"));

  private final List<SemanticBone> semanticBones;
  private final Map<String, SemanticBone> bonesBySemantic;
  private final boolean fullExpressions;
  private final int jointCount;
  private final List<JointBinding> joints;

  private HumanoidSkeleton(
      Map<String, BoneBinding> bindings,
      boolean fullExpressions,
      int jointCount,
      List<JointBinding> joints) {
    if (!bindings.keySet().equals(new java.util.LinkedHashSet<>(REQUIRED_SEMANTICS))) {
      throw new IllegalArgumentException("humanoid skeleton requires the reviewed semantics");
    }
    if (jointCount < REQUIRED_SEMANTICS.size() || jointCount > 256) {
      throw new IllegalArgumentException("invalid humanoid joint count");
    }
    List<SemanticBone> ordered = new ArrayList<>(REQUIRED_SEMANTICS.size());
    Map<String, SemanticBone> indexed = new LinkedHashMap<>();
    for (String semantic : REQUIRED_SEMANTICS) {
      BoneBinding binding = Objects.requireNonNull(bindings.get(semantic), semantic);
      SemanticBone bone =
          new SemanticBone(
              semantic,
              SEMANTIC_PARENTS.get(semantic),
              binding.jointIndex(),
              binding.bindLocal(),
              binding.inverseBind());
      ordered.add(bone);
      indexed.put(semantic, bone);
    }
    this.semanticBones = List.copyOf(ordered);
    this.bonesBySemantic = Map.copyOf(indexed);
    this.fullExpressions = fullExpressions;
    this.jointCount = jointCount;
    if (joints.size() != jointCount) throw new IllegalArgumentException("invalid joint bindings");
    for (int index = 0; index < joints.size(); index++) {
      if (joints.get(index).jointIndex() != index) {
        throw new IllegalArgumentException("joint bindings are not indexed");
      }
    }
    this.joints = List.copyOf(joints);
  }

  public static HumanoidSkeleton fromSemanticBindPose(
      Map<String, Matrix4f> bindPose, boolean fullExpressions) {
    Objects.requireNonNull(bindPose, "bindPose");
    Map<String, BoneBinding> bindings = new LinkedHashMap<>();
    int index = 0;
    for (String semantic : REQUIRED_SEMANTICS) {
      Matrix4f local = Objects.requireNonNull(bindPose.get(semantic), semantic);
      bindings.put(semantic, new BoneBinding(index++, local, new Matrix4f()));
    }
    List<JointBinding> joints = new ArrayList<>(REQUIRED_SEMANTICS.size());
    for (String semantic : REQUIRED_SEMANTICS) {
      BoneBinding binding = bindings.get(semantic);
      String parent = SEMANTIC_PARENTS.get(semantic);
      joints.add(
          new JointBinding(
              binding.jointIndex(),
              parent == null ? -1 : bindings.get(parent).jointIndex(),
              binding.bindLocal(),
              binding.inverseBind()));
    }
    return new HumanoidSkeleton(
        bindings, fullExpressions, REQUIRED_SEMANTICS.size(), joints);
  }

  static HumanoidSkeleton fromDecoded(
      Map<String, BoneBinding> bindings,
      boolean fullExpressions,
      List<JointBinding> joints) {
    return new HumanoidSkeleton(bindings, fullExpressions, joints.size(), joints);
  }

  public List<SemanticBone> semanticBones() {
    return semanticBones;
  }

  public SemanticBone bone(String semantic) {
    SemanticBone bone = bonesBySemantic.get(semantic);
    if (bone == null) throw new IllegalArgumentException("unknown humanoid semantic");
    return bone;
  }

  public boolean fullExpressions() {
    return fullExpressions;
  }

  public int jointCount() {
    return jointCount;
  }

  List<JointBinding> joints() {
    return joints;
  }

  static String parentSemantic(String semantic) {
    return SEMANTIC_PARENTS.get(semantic);
  }

  static record BoneBinding(int jointIndex, Matrix4f bindLocal, Matrix4f inverseBind) {
    BoneBinding {
      if (jointIndex < 0 || jointIndex >= 256) throw new IllegalArgumentException("invalid joint");
      bindLocal = new Matrix4f(Objects.requireNonNull(bindLocal, "bindLocal"));
      inverseBind = new Matrix4f(Objects.requireNonNull(inverseBind, "inverseBind"));
    }

    @Override
    public Matrix4f bindLocal() {
      return new Matrix4f(bindLocal);
    }

    @Override
    public Matrix4f inverseBind() {
      return new Matrix4f(inverseBind);
    }
  }

  static record JointBinding(
      int jointIndex, int parentJointIndex, Matrix4f bindLocal, Matrix4f inverseBind) {
    JointBinding {
      if (jointIndex < 0
          || jointIndex >= 256
          || parentJointIndex >= 256
          || parentJointIndex == jointIndex) {
        throw new IllegalArgumentException("invalid joint hierarchy");
      }
      bindLocal = new Matrix4f(Objects.requireNonNull(bindLocal, "bindLocal"));
      inverseBind = new Matrix4f(Objects.requireNonNull(inverseBind, "inverseBind"));
    }

    @Override
    public Matrix4f bindLocal() {
      return new Matrix4f(bindLocal);
    }

    @Override
    public Matrix4f inverseBind() {
      return new Matrix4f(inverseBind);
    }
  }

  public static final class SemanticBone {
    private final String semantic;
    private final String parentSemantic;
    private final int jointIndex;
    private final Matrix4f bindLocal;
    private final Matrix4f inverseBind;

    private SemanticBone(
        String semantic,
        String parentSemantic,
        int jointIndex,
        Matrix4f bindLocal,
        Matrix4f inverseBind) {
      this.semantic = semantic;
      this.parentSemantic = parentSemantic;
      this.jointIndex = jointIndex;
      this.bindLocal = new Matrix4f(bindLocal);
      this.inverseBind = new Matrix4f(inverseBind);
    }

    public String semantic() {
      return semantic;
    }

    public String parentSemantic() {
      return parentSemantic;
    }

    public int jointIndex() {
      return jointIndex;
    }

    public Matrix4f bindLocal() {
      return new Matrix4f(bindLocal);
    }

    public Matrix4f inverseBind() {
      return new Matrix4f(inverseBind);
    }
  }
}
