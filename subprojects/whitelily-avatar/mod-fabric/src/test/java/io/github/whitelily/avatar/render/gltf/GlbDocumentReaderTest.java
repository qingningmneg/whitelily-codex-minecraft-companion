package io.github.whitelily.avatar.render.gltf;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.github.whitelily.avatar.WhiteLilyAvatarClient;
import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import io.github.whitelily.avatar.render.backend.PreparedAvatarResources;
import io.github.whitelily.avatar.render.backend.WhiteLilyAvatarRenderBackend;
import io.github.whitelily.avatar.render.backend.AvatarVisualState;
import io.github.whitelily.avatar.render.backend.AvatarRenderException;
import io.github.whitelily.avatar.theme.ArmorTheme;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class GlbDocumentReaderTest {
  private static final List<String> SEMANTICS =
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
  private static final List<String> NODE_NAMES =
      List.of(
          "Hips",
          "Chest",
          "Neck",
          "Head",
          "LeftUpperArm",
          "LeftLowerArm",
          "LeftHand",
          "RightUpperArm",
          "RightLowerArm",
          "RightHand",
          "LeftUpperLeg",
          "LeftLowerLeg",
          "LeftFoot",
          "RightUpperLeg",
          "RightLowerLeg",
          "RightFoot");

  @TempDir Path temporaryDirectory;

  @Test
  void decodesAReviewedSkinnedTriangleIntoReadOnlyDirectBuffers() throws Exception {
    byte[] bytes = resourceFixture();
    Path path = write("humanoid.glb", bytes);

    GlbMeshDecoder.GlbMesh mesh =
        new GlbDocumentReader().read(path, sha256(bytes), boneMapping(), false);

    assertEquals(1, mesh.primitives().size());
    assertEquals(16, mesh.skeleton().semanticBones().size());
    GlbMeshDecoder.GlbPrimitive primitive = mesh.primitives().getFirst();
    assertTrue(primitive.skinned());
    assertTrue(primitive.positions().isDirect());
    assertTrue(primitive.positions().isReadOnly());
    assertTrue(primitive.weights().isDirect());
    assertTrue(primitive.weights().isReadOnly());
  }

  @Test
  void deepActiveSceneHierarchyUsesIterativeWorldTransforms() throws Exception {
    byte[] bytes =
        mutate(
            fixture(16, false, false),
            json -> {
              JsonArray nodes = json.getAsJsonArray("nodes");
              int child = nodes.size() - 1;
              for (int depth = 0; depth < 1024; depth++) {
                JsonObject wrapper = new JsonObject();
                wrapper.add("children", new Gson().toJsonTree(List.of(child)));
                wrapper.add("translation", new Gson().toJsonTree(List.of(0.001f, 0.0f, 0.0f)));
                nodes.add(wrapper);
                child = nodes.size() - 1;
              }
              json.getAsJsonArray("scenes")
                  .get(0)
                  .getAsJsonObject()
                  .add("nodes", new Gson().toJsonTree(List.of(child)));
            });

    GlbMeshDecoder.GlbMesh mesh =
        new GlbDocumentReader()
            .read(write("deep-scene.glb", bytes), sha256(bytes), boneMapping(), false);

    assertEquals(1.024f, mesh.primitives().getFirst().nodeTransform().m30(), 0.001f);
  }

  @Test
  void managedReadNeverFollowsTheFinalModelSymlink() throws Exception {
    Path managedRoot = temporaryDirectory.resolve("models");
    Files.createDirectories(managedRoot);
    byte[] bytes = resourceFixture();
    Path outside = write("outside.glb", bytes);
    Path link = managedRoot.resolve("model.glb");
    try {
      Files.createSymbolicLink(link, outside);
    } catch (Exception error) {
      assumeTrue(false, "symbolic links unavailable: " + error.getClass().getSimpleName());
    }

    assertCode(
        "AVATAR_GLB_INVALID",
        () ->
            new GlbDocumentReader()
                .read(link, managedRoot, sha256(bytes), boneMapping(), false));
  }

  @Test
  void managedReadRejectsARegularFileOutsideTheModelsRoot() throws Exception {
    Path managedRoot = temporaryDirectory.resolve("models");
    Files.createDirectories(managedRoot);
    byte[] bytes = resourceFixture();
    Path outside = write("outside-regular.glb", bytes);

    assertCode(
        "AVATAR_GLB_INVALID",
        () ->
            new GlbDocumentReader()
                .read(outside, managedRoot, sha256(bytes), boneMapping(), false));
  }

  @Test
  void productionBackendResolvesDescriptorsFromTheRealModelsRoot() throws Exception {
    Path dataRoot = temporaryDirectory.resolve("WhiteLily");
    Path model =
        dataRoot
            .resolve("models")
            .resolve("00000000-0000-4000-8000-000000000001")
            .resolve("model.glb");
    Files.createDirectories(model.getParent());
    byte[] bytes = fixture(16, false, false);
    Files.write(model, bytes);
    var factory =
        WhiteLilyAvatarClient.class.getDeclaredMethod("smoothBackends", Path.class);
    factory.setAccessible(true);
    @SuppressWarnings("unchecked")
    Map<String, WhiteLilyAvatarRenderBackend> backends =
        (Map<String, WhiteLilyAvatarRenderBackend>) factory.invoke(null, dataRoot);
    AvatarRuntimeDescriptor descriptor =
        new AvatarRuntimeDescriptor(
            sha256(bytes),
            "imported",
            "glb",
            "00000000-0000-4000-8000-000000000001/model.glb",
            sha256(bytes),
            boneMapping(),
            "whitelily-humanoid-v1",
            "neutral-only");

    PreparedAvatarResources prepared = backends.get("glb").prepare(descriptor);

    assertEquals(descriptor.modelId(), prepared.modelId());
    backends.get("glb").dispose(prepared);
  }

  @Test
  void normalizesFourInfluencesPerVertexBeforeUpload() throws Exception {
    byte[] bytes = fixture(16, false, false);
    GlbMeshDecoder.GlbMesh mesh =
        new GlbDocumentReader()
            .read(write("weights.glb", bytes), sha256(bytes), boneMapping(), false);

    ByteBuffer weights = mesh.primitives().getFirst().weights().order(ByteOrder.LITTLE_ENDIAN);

    assertEquals(0.25f, weights.getFloat(0), 0.0001f);
    assertEquals(1.0f, weights.getFloat(0) + weights.getFloat(4) + weights.getFloat(8)
        + weights.getFloat(12), 0.0001f);
  }

  @Test
  void rejectsCorruptionDigestDriftExternalUrisAndJointOverflow() throws Exception {
    byte[] valid = fixture(16, false, false);
    byte[] corrupt = valid.clone();
    corrupt[0] = 0;
    assertCode(
        "AVATAR_GLB_INVALID",
        () ->
            new GlbDocumentReader()
                .read(write("corrupt.glb", corrupt), sha256(corrupt), boneMapping(), false));
    assertCode(
        "AVATAR_DIGEST_MISMATCH",
        () ->
            new GlbDocumentReader()
                .read(write("digest.glb", valid), "0".repeat(64), boneMapping(), false));

    byte[] external = fixture(16, true, false);
    assertCode(
        "AVATAR_EXTERNAL_RESOURCE",
        () ->
            new GlbDocumentReader()
                .read(write("external.glb", external), sha256(external), boneMapping(), false));

    byte[] tooManyJoints = fixture(257, false, false);
    assertCode(
        "AVATAR_GLB_INVALID",
        () ->
            new GlbDocumentReader()
                .read(
                    write("joints.glb", tooManyJoints),
                    sha256(tooManyJoints),
                    boneMapping(),
                    false));
  }

  @Test
  void rejectsZeroSumSkinWeights() throws Exception {
    byte[] zeroWeights = fixture(16, false, true);

    assertCode(
        "AVATAR_GLB_INVALID",
        () ->
            new GlbDocumentReader()
                .read(
                    write("zero-weights.glb", zeroWeights),
                    sha256(zeroWeights),
                    boneMapping(),
                    false));
  }

  @Test
  void rejectsMeshNodesThatPointOutsideTheDecodedMeshTable() throws Exception {
    byte[] invalidMeshNode = fixture(16, false, false, true);

    assertCode(
        "AVATAR_GLB_INVALID",
        () ->
            new GlbDocumentReader()
                .read(
                    write("invalid-mesh-node.glb", invalidMeshNode),
                    sha256(invalidMeshNode),
                    boneMapping(),
                    false));
  }

  @Test
  void rejectsASecondJointAndWeightSetBeyondFourInfluences() throws Exception {
    byte[] extraInfluences = fixture(16, false, false, false, true);

    assertCode(
        "AVATAR_GLB_INVALID",
        () ->
            new GlbDocumentReader()
                .read(
                    write("extra-influences.glb", extraInfluences),
                    sha256(extraInfluences),
                    boneMapping(),
                    false));
  }

  @Test
  void traversesOnlyTheActiveSceneAndPreservesMeshInstanceTransform() throws Exception {
    byte[] transformed =
        mutate(
            fixture(16, false, false),
            json -> {
              JsonArray nodes = json.getAsJsonArray("nodes");
              nodes.get(nodes.size() - 1)
                  .getAsJsonObject()
                  .add("translation", new Gson().toJsonTree(List.of(2.0f, 3.0f, 4.0f)));
              JsonObject inactive = new JsonObject();
              inactive.addProperty("name", "InactiveBody");
              inactive.addProperty("mesh", 0);
              inactive.addProperty("skin", 0);
              inactive.add("translation", new Gson().toJsonTree(List.of(99.0f, 0.0f, 0.0f)));
              nodes.add(inactive);
            });

    GlbMeshDecoder.GlbMesh mesh =
        new GlbDocumentReader()
            .read(write("active-scene.glb", transformed), sha256(transformed), boneMapping(), false);

    assertEquals(1, mesh.primitives().size());
    assertEquals(2.0f, mesh.primitives().getFirst().nodeTransform().m30(), 0.0001f);
    assertEquals(3.0f, mesh.primitives().getFirst().nodeTransform().m31(), 0.0001f);
  }

  @Test
  void supportsTwoHundredFiftySixTotalJointsWithASmallPerDrawPalette() throws Exception {
    byte[] bytes = fixture(256, false, false);

    GlbMeshDecoder.GlbMesh mesh =
        new GlbDocumentReader()
            .read(write("joint-palette.glb", bytes), sha256(bytes), boneMapping(), false);

    assertEquals(256, mesh.skeleton().jointCount());
    assertEquals(List.of(0, 1, 2, 3), mesh.primitives().getFirst().jointPalette());
  }

  @Test
  void nonTopologicalSkinJointOrderStillEvaluatesTheFullHierarchy() throws Exception {
    byte[] bytes =
        mutate(
            resourceFixture(),
            json -> {
              List<Integer> reversed = new ArrayList<>();
              for (int joint = 15; joint >= 0; joint--) reversed.add(joint);
              json.getAsJsonArray("skins")
                  .get(0)
                  .getAsJsonObject()
                  .add("joints", new Gson().toJsonTree(reversed));
            });
    GlbMeshDecoder.GlbMesh mesh =
        new GlbDocumentReader()
            .read(write("reversed-joints.glb", bytes), sha256(bytes), boneMapping(), false);

    HumanoidAnimator.AvatarPose pose =
        new HumanoidAnimator().evaluate(animationState(), mesh.skeleton(), 0.5f);

    assertTrue(Float.isFinite(pose.rightHand().m30()));
  }

  @Test
  void reusesCanonicalAccessorDataAcrossRepeatedPrimitives() throws Exception {
    byte[] repeated =
        mutate(
            fixture(16, false, false),
            json -> {
              JsonObject primitive =
                  json.getAsJsonArray("meshes")
                      .get(0)
                      .getAsJsonObject()
                      .getAsJsonArray("primitives")
                      .get(0)
                      .getAsJsonObject();
              JsonArray primitives = new JsonArray();
              for (int index = 0; index < 512; index++) primitives.add(primitive.deepCopy());
              json.getAsJsonArray("meshes")
                  .get(0)
                  .getAsJsonObject()
                  .add("primitives", primitives);
            });

    GlbMeshDecoder.GlbMesh mesh =
        new GlbDocumentReader()
            .read(write("reused.glb", repeated), sha256(repeated), boneMapping(), false);

    assertEquals(512, mesh.primitives().size());
    assertTrue(mesh.decodedBytes() < 512);
  }

  @Test
  void rejectsOversizedPngDimensionsBeforeNativeImageDecode() throws Exception {
    ByteBuffer png = ByteBuffer.allocate(24).order(ByteOrder.BIG_ENDIAN);
    png.putLong(0x89504e470d0a1a0aL).putInt(13).putInt(0x49484452);
    png.putInt(100_000).putInt(100_000);
    byte[] oversized =
        mutateWithBinary(
            fixture(16, false, false),
            png.array(),
            (json, offset) -> {
              json.getAsJsonArray("bufferViews")
                  .add(new Gson().toJsonTree(view(offset, png.capacity())));
              json.add(
                  "images",
                  new Gson()
                      .toJsonTree(
                          List.of(
                              Map.of(
                                  "bufferView",
                                  json.getAsJsonArray("bufferViews").size() - 1,
                                  "mimeType",
                                  "image/png"))));
            });

    assertCode(
        "AVATAR_GLB_INVALID",
        () ->
            new GlbDocumentReader()
                .read(write("oversized.png.glb", oversized), sha256(oversized), boneMapping(), false));
  }

  @Test
  void rejectsUnsupportedRequiredExtensions() throws Exception {
    byte[] bytes =
        mutate(
            fixture(16, false, false),
            json -> json.add("extensionsRequired", new Gson().toJsonTree(List.of("KHR_materials_unlit"))));
    assertCode(
        "AVATAR_GLB_INVALID",
        () -> new GlbDocumentReader().read(write("extensions.glb", bytes), sha256(bytes), boneMapping(), false));
  }

  @Test
  void rejectsInvalidAnimationSamplerReferences() throws Exception {
    byte[] bytes =
        mutate(
            fixture(16, false, false),
            json ->
                json.add(
                    "animations",
                    new Gson()
                        .toJsonTree(
                            List.of(
                                Map.of(
                                    "samplers",
                                    List.of(Map.of("input", 999, "output", 0, "interpolation", "LINEAR")),
                                    "channels",
                                    List.of(Map.of("sampler", 0, "target", Map.of("node", 0, "path", "translation"))))))));
    assertCode(
        "AVATAR_GLB_INVALID",
        () -> new GlbDocumentReader().read(write("animation.glb", bytes), sha256(bytes), boneMapping(), false));
  }

  @Test
  void rejectsUnsupportedAdvancedMaterialModes() throws Exception {
    byte[] bytes =
        mutate(
            fixture(16, false, false),
            json -> {
              json.add("materials", new Gson().toJsonTree(List.of(Map.of("alphaMode", "BLEND"))));
              json.getAsJsonArray("meshes")
                  .get(0)
                  .getAsJsonObject()
                  .getAsJsonArray("primitives")
                  .get(0)
                  .getAsJsonObject()
                  .addProperty("material", 0);
            });
    assertCode(
        "AVATAR_GLB_INVALID",
        () -> new GlbDocumentReader().read(write("material.glb", bytes), sha256(bytes), boneMapping(), false));
  }

  @Test
  void fullExpressionDescriptorRejectsUnimplementedMorphTargets() throws Exception {
    byte[] bytes =
        mutate(
            fixture(16, false, false),
            json -> {
              JsonObject target = new JsonObject();
              target.addProperty("POSITION", 0);
              JsonArray targets = new JsonArray();
              targets.add(target);
              json.getAsJsonArray("meshes")
                  .get(0)
                  .getAsJsonObject()
                  .getAsJsonArray("primitives")
                  .get(0)
                  .getAsJsonObject()
                  .add("targets", targets);
            });
    assertCode(
        "AVATAR_GLB_INVALID",
        () -> new GlbDocumentReader().read(write("morph.glb", bytes), sha256(bytes), boneMapping(), true));
  }

  @Test
  void fullExpressionDescriptorWithoutUsableMorphsBecomesNeutralOnly() throws Exception {
    byte[] bytes = resourceFixture();

    GlbMeshDecoder.GlbMesh mesh =
        new GlbDocumentReader()
            .read(write("neutral-only.glb", bytes), sha256(bytes), boneMapping(), true);

    assertTrue(!mesh.skeleton().fullExpressions());
  }

  @Test
  void rejectsJsonBeyondTheStreamingDepthLimit() throws Exception {
    byte[] bytes =
        mutate(
            fixture(16, false, false),
            json -> {
              JsonObject root = new JsonObject();
              JsonObject cursor = root;
              for (int depth = 0; depth < 129; depth++) {
                JsonObject child = new JsonObject();
                cursor.add("child", child);
                cursor = child;
              }
              json.add("extras", root);
            });
    assertCode(
        "AVATAR_GLB_INVALID",
        () -> new GlbDocumentReader().read(write("deep.glb", bytes), sha256(bytes), boneMapping(), false));
  }

  @Test
  void validatesCombinedBufferViewAndAccessorAlignment() throws Exception {
    byte[] bytes =
        mutate(
            fixture(16, false, false),
            json ->
                json.getAsJsonArray("bufferViews")
                    .get(0)
                    .getAsJsonObject()
                    .addProperty("byteOffset", 1));
    assertCode(
        "AVATAR_GLB_INVALID",
        () -> new GlbDocumentReader().read(write("alignment.glb", bytes), sha256(bytes), boneMapping(), false));
  }

  private Path write(String name, byte[] bytes) throws Exception {
    Path path = temporaryDirectory.resolve(name);
    Files.write(path, bytes);
    return path;
  }

  private static byte[] resourceFixture() throws Exception {
    try (var input =
        GlbDocumentReaderTest.class.getResourceAsStream("/avatar/minimal-humanoid.glb")) {
      if (input == null) throw new IllegalStateException("minimal humanoid fixture is missing");
      return input.readAllBytes();
    }
  }

  private static Map<String, String> boneMapping() {
    Map<String, String> mapping = new LinkedHashMap<>();
    for (int index = 0; index < SEMANTICS.size(); index++) {
      mapping.put(SEMANTICS.get(index), NODE_NAMES.get(index));
    }
    return mapping;
  }

  private static AvatarVisualState animationState() {
    return new AvatarVisualState(
        1,
        "world-test",
        0,
        64,
        0,
        0,
        0,
        "standing",
        0.5f,
        10.5f,
        ArmorTheme.BASE,
        "minecraft:air",
        "minecraft:air",
        true,
        false,
        false,
        false,
        false,
        false,
        "neutral",
        1,
        new AvatarVisualState.GraphicsCapabilities(true, true, 128));
  }

  private static void assertCode(String code, ThrowingOperation operation) {
    AvatarRenderException error = assertThrows(AvatarRenderException.class, operation::run);
    assertEquals(code, error.code());
  }

  private static String sha256(byte[] bytes) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
  }

  private static byte[] fixture(int jointCount, boolean externalBuffer, boolean zeroWeights) {
    return fixture(jointCount, externalBuffer, zeroWeights, false);
  }

  private static byte[] fixture(
      int jointCount,
      boolean externalBuffer,
      boolean zeroWeights,
      boolean invalidMeshNode) {
    return fixture(jointCount, externalBuffer, zeroWeights, invalidMeshNode, false);
  }

  private static byte[] fixture(
      int jointCount,
      boolean externalBuffer,
      boolean zeroWeights,
      boolean invalidMeshNode,
      boolean extraInfluences) {
    int positionsOffset = 0;
    int normalsOffset = positionsOffset + 36;
    int texCoordsOffset = normalsOffset + 36;
    int jointsOffset = texCoordsOffset + 24;
    int weightsOffset = jointsOffset + 24;
    int indicesOffset = weightsOffset + 48;
    int inverseBindOffset = alignFour(indicesOffset + 6);
    int binaryLength = inverseBindOffset + jointCount * 64;
    ByteBuffer binary = ByteBuffer.allocate(binaryLength).order(ByteOrder.LITTLE_ENDIAN);
    binary.putFloat(-0.5f).putFloat(0.0f).putFloat(0.0f);
    binary.putFloat(0.5f).putFloat(0.0f).putFloat(0.0f);
    binary.putFloat(0.0f).putFloat(1.0f).putFloat(0.0f);
    for (int index = 0; index < 3; index++) binary.putFloat(0).putFloat(0).putFloat(1);
    binary.putFloat(0).putFloat(0).putFloat(1).putFloat(0).putFloat(0.5f).putFloat(1);
    for (int vertex = 0; vertex < 3; vertex++) {
      binary.putShort((short) 0).putShort((short) 1).putShort((short) 2).putShort((short) 3);
    }
    for (int vertex = 0; vertex < 3; vertex++) {
      float weight = zeroWeights ? 0.0f : 0.5f;
      binary.putFloat(weight).putFloat(weight).putFloat(weight).putFloat(weight);
    }
    binary.putShort((short) 0).putShort((short) 1).putShort((short) 2);
    binary.position(inverseBindOffset);
    for (int joint = 0; joint < jointCount; joint++) {
      for (int element = 0; element < 16; element++) {
        binary.putFloat(element % 5 == 0 ? 1.0f : 0.0f);
      }
    }

    List<Map<String, Object>> nodes = humanoidNodes();
    while (nodes.size() < jointCount) {
      nodes.add(Map.of("name", "ExtraJoint" + nodes.size()));
    }
    nodes.add(Map.of("name", "BodyMesh", "mesh", invalidMeshNode ? 99 : 0, "skin", 0));
    List<Integer> jointIndices = new ArrayList<>(jointCount);
    for (int index = 0; index < jointCount; index++) jointIndices.add(index);

    Map<String, Object> buffer = new LinkedHashMap<>();
    buffer.put("byteLength", binaryLength);
    if (externalBuffer) buffer.put("uri", "model.bin");
    Map<String, Object> document = new LinkedHashMap<>();
    document.put("asset", Map.of("version", "2.0"));
    document.put("buffers", List.of(buffer));
    document.put(
        "bufferViews",
        List.of(
            view(positionsOffset, 36),
            view(normalsOffset, 36),
            view(texCoordsOffset, 24),
            view(jointsOffset, 24),
            view(weightsOffset, 48),
            view(indicesOffset, 6),
            view(inverseBindOffset, jointCount * 64)));
    document.put(
        "accessors",
        List.of(
            accessor(0, 5126, 3, "VEC3"),
            accessor(1, 5126, 3, "VEC3"),
            accessor(2, 5126, 3, "VEC2"),
            accessor(3, 5123, 3, "VEC4"),
            accessor(4, 5126, 3, "VEC4"),
            accessor(5, 5123, 3, "SCALAR"),
            accessor(6, 5126, jointCount, "MAT4")));
    Map<String, Integer> attributes = new LinkedHashMap<>();
    attributes.put("POSITION", 0);
    attributes.put("NORMAL", 1);
    attributes.put("TEXCOORD_0", 2);
    attributes.put("JOINTS_0", 3);
    attributes.put("WEIGHTS_0", 4);
    if (extraInfluences) {
      attributes.put("JOINTS_1", 3);
      attributes.put("WEIGHTS_1", 4);
    }
    document.put(
        "meshes",
        List.of(
            Map.of(
                "primitives",
                List.of(
                    Map.of(
                        "attributes", attributes,
                        "indices", 5,
                        "mode", 4)))));
    document.put("nodes", nodes);
    document.put(
        "skins", List.of(Map.of("joints", jointIndices, "inverseBindMatrices", 6, "skeleton", 0)));
    document.put("scenes", List.of(Map.of("nodes", List.of(nodes.size() - 1))));
    document.put("scene", 0);

    byte[] json = pad(new Gson().toJson(document).getBytes(StandardCharsets.UTF_8), (byte) 0x20);
    byte[] bin = pad(binary.array(), (byte) 0);
    ByteBuffer glb =
        ByteBuffer.allocate(12 + 8 + json.length + 8 + bin.length).order(ByteOrder.LITTLE_ENDIAN);
    glb.putInt(0x46546c67).putInt(2).putInt(glb.capacity());
    glb.putInt(json.length).putInt(0x4e4f534a).put(json);
    glb.putInt(bin.length).putInt(0x004e4942).put(bin);
    return glb.array();
  }

  private static List<Map<String, Object>> humanoidNodes() {
    List<Map<String, Object>> nodes = new ArrayList<>();
    nodes.add(node("Hips", List.of(1, 10, 13), 0.0f, 1.0f, 0.0f));
    nodes.add(node("Chest", List.of(2, 4, 7), 0.0f, 0.5f, 0.0f));
    nodes.add(node("Neck", List.of(3), 0.0f, 0.35f, 0.0f));
    nodes.add(node("Head", List.of(), 0.0f, 0.25f, 0.0f));
    nodes.add(node("LeftUpperArm", List.of(5), 0.3f, 0.25f, 0.0f));
    nodes.add(node("LeftLowerArm", List.of(6), 0.35f, 0.0f, 0.0f));
    nodes.add(node("LeftHand", List.of(), 0.3f, 0.0f, 0.0f));
    nodes.add(node("RightUpperArm", List.of(8), -0.3f, 0.25f, 0.0f));
    nodes.add(node("RightLowerArm", List.of(9), -0.35f, 0.0f, 0.0f));
    nodes.add(node("RightHand", List.of(), -0.3f, 0.0f, 0.0f));
    nodes.add(node("LeftUpperLeg", List.of(11), 0.15f, -0.4f, 0.0f));
    nodes.add(node("LeftLowerLeg", List.of(12), 0.0f, -0.5f, 0.0f));
    nodes.add(node("LeftFoot", List.of(), 0.0f, -0.4f, 0.1f));
    nodes.add(node("RightUpperLeg", List.of(14), -0.15f, -0.4f, 0.0f));
    nodes.add(node("RightLowerLeg", List.of(15), 0.0f, -0.5f, 0.0f));
    nodes.add(node("RightFoot", List.of(), 0.0f, -0.4f, 0.1f));
    return nodes;
  }

  private static Map<String, Object> node(
      String name, List<Integer> children, float x, float y, float z) {
    Map<String, Object> node = new LinkedHashMap<>();
    node.put("name", name);
    node.put("translation", List.of(x, y, z));
    if (!children.isEmpty()) node.put("children", children);
    return node;
  }

  private static Map<String, Object> view(int byteOffset, int byteLength) {
    return Map.of("buffer", 0, "byteOffset", byteOffset, "byteLength", byteLength);
  }

  private static Map<String, Object> accessor(
      int bufferView, int componentType, int count, String type) {
    return Map.of(
        "bufferView", bufferView,
        "componentType", componentType,
        "count", count,
        "type", type);
  }

  private static int alignFour(int value) {
    return (value + 3) & ~3;
  }

  private static byte[] pad(byte[] input, byte padding) {
    byte[] output = new byte[alignFour(input.length)];
    System.arraycopy(input, 0, output, 0, input.length);
    for (int index = input.length; index < output.length; index++) output[index] = padding;
    return output;
  }

  private static byte[] mutate(byte[] glb, Consumer<JsonObject> mutation) {
    return mutateWithBinary(glb, new byte[0], (json, ignored) -> mutation.accept(json));
  }

  private static byte[] mutateWithBinary(
      byte[] glb, byte[] appended, BinaryMutation mutation) {
    ByteBuffer source = ByteBuffer.wrap(glb).order(ByteOrder.LITTLE_ENDIAN);
    source.position(12);
    int jsonLength = source.getInt();
    source.getInt();
    byte[] jsonBytes = new byte[jsonLength];
    source.get(jsonBytes);
    int binaryLength = source.getInt();
    source.getInt();
    byte[] binary = new byte[binaryLength];
    source.get(binary);
    JsonObject json =
        JsonParser.parseString(new String(jsonBytes, StandardCharsets.UTF_8).stripTrailing())
            .getAsJsonObject();
    mutation.accept(json, binary.length);
    byte[] merged = new byte[alignFour(binary.length + appended.length)];
    System.arraycopy(binary, 0, merged, 0, binary.length);
    System.arraycopy(appended, 0, merged, binary.length, appended.length);
    json.getAsJsonArray("buffers").get(0).getAsJsonObject().addProperty("byteLength", merged.length);
    byte[] nextJson = pad(new Gson().toJson(json).getBytes(StandardCharsets.UTF_8), (byte) 0x20);
    ByteBuffer output =
        ByteBuffer.allocate(12 + 8 + nextJson.length + 8 + merged.length)
            .order(ByteOrder.LITTLE_ENDIAN);
    output.putInt(0x46546c67).putInt(2).putInt(output.capacity());
    output.putInt(nextJson.length).putInt(0x4e4f534a).put(nextJson);
    output.putInt(merged.length).putInt(0x004e4942).put(merged);
    return output.array();
  }

  @FunctionalInterface
  private interface BinaryMutation {
    void accept(JsonObject json, int appendedOffset);
  }

  @FunctionalInterface
  private interface ThrowingOperation {
    void run() throws Exception;
  }
}
