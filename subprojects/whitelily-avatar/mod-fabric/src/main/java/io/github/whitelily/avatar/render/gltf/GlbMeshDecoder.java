package io.github.whitelily.avatar.render.gltf;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import io.github.whitelily.avatar.render.backend.AvatarRenderException;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.joml.Matrix4f;
import org.joml.Quaternionf;

public final class GlbMeshDecoder {
  private static final int MAX_NODES = 4_096;
  private static final int MAX_JOINTS = 256;
  private static final int MAX_PRIMITIVES = 2_048;
  private static final int MAX_ACTIVE_DRAWS = 16_384;
  private static final int MAX_MATERIALS = 128;
  private static final int MAX_TEXTURES = 128;
  private static final int MAX_ACCESSORS = 65_536;
  private static final long MAX_DECODED_BYTES = 256L * 1024 * 1024;
  private static final int MAX_TEXTURE_DIMENSION = 16_384;
  private static final long MAX_TEXTURE_PIXELS = 64L * 1024 * 1024;

  GlbMesh decode(
      GlbDocumentReader.Document document,
      Map<String, String> boneMapping,
      boolean fullExpressions)
      throws AvatarRenderException {
    try {
      JsonObject json = document.json();
      JsonObject asset = object(json, "asset");
      if (!"2.0".equals(string(asset, "version"))) invalid("avatar glTF asset version is invalid");
      validateExtensions(json);

      JsonArray buffers = array(json, "buffers", 1);
      if (buffers.size() != 1) invalid("avatar glTF must contain one embedded buffer");
      JsonObject buffer = object(buffers.get(0), "buffer");
      int declaredBytes = integer(buffer, "byteLength", 1, Integer.MAX_VALUE);
      ByteBuffer binary = document.binary();
      if (declaredBytes > binary.remaining() || binary.remaining() - declaredBytes > 3) {
        invalid("avatar glTF buffer length is invalid");
      }

      List<BufferView> views = decodeViews(json, declaredBytes);
      List<Accessor> accessors = decodeAccessors(json, views);
      List<Node> nodes = decodeNodes(json);
      validateAnimations(json, accessors, nodes);
      List<Skin> skins = decodeSkins(json, accessors, nodes, views, binary);
      if (skins.size() != 1) invalid("avatar glTF must contain one humanoid skin");
      Skin skin = skins.getFirst();
      HumanoidSkeleton skeleton =
          decodeSkeleton(nodes, skin, boneMapping, false);
      List<GlbImage> images = decodeImages(json, views, binary);
      List<Integer> materialImages = decodeMaterialImages(json, images.size());
      DecodedMeshes decoded =
          decodePrimitives(
              json,
              accessors,
              views,
              binary,
              skin.joints().size(),
              materialImages,
              fullExpressions);
      List<GlbPrimitive> primitives =
          instantiateActiveScene(json, nodes, decoded.meshes(), skins.size());
      if (primitives.isEmpty()) invalid("avatar glTF contains no mesh primitives");
      return new GlbMesh(
          primitives, skeleton, images, document.digest(), decoded.decodedBytes());
    } catch (AvatarRenderException error) {
      throw error;
    } catch (RuntimeException error) {
      throw GlbDocumentReader.failure(
          "AVATAR_GLB_INVALID", "avatar glTF document could not be decoded", error);
    }
  }

  private static List<BufferView> decodeViews(JsonObject json, int bufferLength)
      throws AvatarRenderException {
    JsonArray values = optionalArray(json, "bufferViews", MAX_ACCESSORS);
    List<BufferView> views = new ArrayList<>(values.size());
    for (JsonElement value : values) {
      GlbDocumentReader.cancellationCheckpoint();
      JsonObject view = object(value, "bufferView");
      if (integer(view, "buffer", 0, 0) != 0) invalid("avatar bufferView buffer is invalid");
      int offset = optionalInteger(view, "byteOffset", 0, 0, bufferLength);
      int length = integer(view, "byteLength", 1, bufferLength);
      int stride = optionalInteger(view, "byteStride", 0, 0, 252);
      if (stride != 0 && (stride < 4 || (stride & 3) != 0)) {
        invalid("avatar bufferView stride is invalid");
      }
      if ((long) offset + length > bufferLength) invalid("avatar bufferView is out of bounds");
      int target = optionalInteger(view, "target", 0, 0, 34963);
      if (target != 0 && target != 34962 && target != 34963) {
        invalid("avatar bufferView target is invalid");
      }
      views.add(new BufferView(offset, length, stride));
    }
    return List.copyOf(views);
  }

  private static List<Accessor> decodeAccessors(JsonObject json, List<BufferView> views)
      throws AvatarRenderException {
    JsonArray values = optionalArray(json, "accessors", MAX_ACCESSORS);
    List<Accessor> accessors = new ArrayList<>(values.size());
    for (JsonElement value : values) {
      GlbDocumentReader.cancellationCheckpoint();
      JsonObject accessor = object(value, "accessor");
      if (accessor.has("sparse")) invalid("sparse avatar accessors are unsupported");
      int viewIndex = integer(accessor, "bufferView", 0, views.size() - 1);
      int componentType = integer(accessor, "componentType", 5120, 5126);
      int componentBytes = componentBytes(componentType);
      int count = integer(accessor, "count", 1, Integer.MAX_VALUE);
      String type = string(accessor, "type");
      int components = components(type);
      int byteOffset = optionalInteger(accessor, "byteOffset", 0, 0, Integer.MAX_VALUE);
      boolean normalized = optionalBoolean(accessor, "normalized", false);
      if (byteOffset % componentBytes != 0
          || (views.get(viewIndex).offset() + byteOffset) % componentBytes != 0) {
        invalid("avatar accessor alignment is invalid");
      }
      int elementBytes = elementBytes(type, componentBytes);
      BufferView view = views.get(viewIndex);
      int stride = view.stride() == 0 ? elementBytes : view.stride();
      if (stride < elementBytes) invalid("avatar accessor stride is too small");
      long required = (long) byteOffset + (long) stride * (count - 1) + elementBytes;
      if (required > view.length()) invalid("avatar accessor is out of bounds");
      accessors.add(
          new Accessor(
              viewIndex,
              byteOffset,
              componentType,
              componentBytes,
              count,
              type,
              components,
              normalized,
              stride));
    }
    return List.copyOf(accessors);
  }

  private static List<Node> decodeNodes(JsonObject json) throws AvatarRenderException {
    JsonArray values = optionalArray(json, "nodes", MAX_NODES);
    List<MutableNode> mutable = new ArrayList<>(values.size());
    for (JsonElement value : values) {
      GlbDocumentReader.cancellationCheckpoint();
      JsonObject node = object(value, "node");
      String name = optionalString(node, "name", "");
      if (name.codePointCount(0, name.length()) > 256 || hasControls(name)) {
        invalid("avatar node name is invalid");
      }
      List<Integer> children = integerList(node, "children", values.size(), MAX_NODES);
      if (new HashSet<>(children).size() != children.size()) {
        invalid("avatar node children are duplicated");
      }
      int mesh = optionalInteger(node, "mesh", -1, 0, MAX_NODES);
      int skin = optionalInteger(node, "skin", -1, 0, MAX_NODES);
      mutable.add(new MutableNode(name, children, localTransform(node), mesh, skin, -1));
    }
    for (int parent = 0; parent < mutable.size(); parent++) {
      cancellationCheckpoint(parent);
      for (int child : mutable.get(parent).children()) {
        if (child == parent || child < 0 || child >= mutable.size() || mutable.get(child).parent() >= 0) {
          invalid("avatar node hierarchy is invalid");
        }
        mutable.set(child, mutable.get(child).withParent(parent));
      }
    }
    for (int start = 0; start < mutable.size(); start++) {
      cancellationCheckpoint(start);
      Set<Integer> visited = new HashSet<>();
      int current = start;
      while (current >= 0) {
        if (!visited.add(current)) invalid("avatar node hierarchy contains a cycle");
        current = mutable.get(current).parent();
      }
    }
    return mutable.stream()
        .map(node -> new Node(node.name(), node.children(), node.local(), node.mesh(), node.skin(), node.parent()))
        .toList();
  }

  private static Matrix4f localTransform(JsonObject node) throws AvatarRenderException {
    boolean hasMatrix = node.has("matrix");
    if (hasMatrix && (node.has("translation") || node.has("rotation") || node.has("scale"))) {
      invalid("avatar node mixes matrix and TRS transforms");
    }
    if (hasMatrix) {
      float[] matrix = floatTuple(node, "matrix", 16, null);
      return new Matrix4f().set(matrix);
    }
    float[] translation = floatTuple(node, "translation", 3, new float[] {0, 0, 0});
    float[] rotation = floatTuple(node, "rotation", 4, new float[] {0, 0, 0, 1});
    float[] scale = floatTuple(node, "scale", 3, new float[] {1, 1, 1});
    if (Math.abs(Math.abs(scale[0]) - Math.abs(scale[1])) > 0.00001f
        || Math.abs(Math.abs(scale[1]) - Math.abs(scale[2])) > 0.00001f) {
      invalid("avatar node non-uniform scale is unsupported");
    }
    Quaternionf quaternion = new Quaternionf(rotation[0], rotation[1], rotation[2], rotation[3]);
    if (quaternion.lengthSquared() < 0.000001f) invalid("avatar node rotation is invalid");
    quaternion.normalize();
    return new Matrix4f()
        .translation(translation[0], translation[1], translation[2])
        .rotate(quaternion)
        .scale(scale[0], scale[1], scale[2]);
  }

  private static List<Skin> decodeSkins(
      JsonObject json,
      List<Accessor> accessors,
      List<Node> nodes,
      List<BufferView> views,
      ByteBuffer binary)
      throws AvatarRenderException {
    JsonArray values = optionalArray(json, "skins", MAX_NODES);
    List<Skin> skins = new ArrayList<>(values.size());
    for (JsonElement value : values) {
      GlbDocumentReader.cancellationCheckpoint();
      JsonObject skin = object(value, "skin");
      List<Integer> joints = integerList(skin, "joints", nodes.size(), MAX_JOINTS);
      if (joints.isEmpty() || new HashSet<>(joints).size() != joints.size()) {
        invalid("avatar skin joints are invalid");
      }
      if (joints.size() > MAX_JOINTS) invalid("avatar skin has too many joints");
      if (skin.has("skeleton")) integer(skin, "skeleton", 0, nodes.size() - 1);
      List<Matrix4f> inverseBind = new ArrayList<>(joints.size());
      if (skin.has("inverseBindMatrices")) {
        Accessor accessor = accessors.get(integer(skin, "inverseBindMatrices", 0, accessors.size() - 1));
        if (!"MAT4".equals(accessor.type())
            || accessor.componentType() != 5126
            || accessor.count() != joints.size()) {
          invalid("avatar inverse bind matrices accessor is invalid");
        }
        for (int index = 0; index < joints.size(); index++) {
          cancellationCheckpoint(index);
          float[] values16 = readFloatElement(accessor, index, views, binary);
          inverseBind.add(new Matrix4f().set(values16));
        }
      } else {
        List<Matrix4f> world = worldTransforms(nodes);
        for (int joint : joints) {
          Matrix4f inverse = new Matrix4f(world.get(joint)).invert();
          inverseBind.add(inverse);
        }
      }
      skins.add(new Skin(joints, inverseBind));
    }
    return List.copyOf(skins);
  }

  private static HumanoidSkeleton decodeSkeleton(
      List<Node> nodes,
      Skin skin,
      Map<String, String> mapping,
      boolean fullExpressions)
      throws AvatarRenderException {
    if (!mapping.keySet().equals(new LinkedHashSet<>(HumanoidSkeleton.REQUIRED_SEMANTICS))
        || new HashSet<>(mapping.values()).size() != HumanoidSkeleton.REQUIRED_SEMANTICS.size()) {
      requiredBone("avatar humanoid mapping is incomplete or duplicated");
    }
    Map<String, List<Integer>> nodesByName = new HashMap<>();
    for (int index = 0; index < nodes.size(); index++) {
      cancellationCheckpoint(index);
      nodesByName.computeIfAbsent(nodes.get(index).name(), ignored -> new ArrayList<>()).add(index);
    }
    Map<String, Integer> indices = new LinkedHashMap<>();
    for (String semantic : HumanoidSkeleton.REQUIRED_SEMANTICS) {
      GlbDocumentReader.cancellationCheckpoint();
      String nodeName = mapping.get(semantic);
      List<Integer> matches = nodesByName.getOrDefault(nodeName, List.of());
      if (nodeName == null || nodeName.isBlank() || matches.size() != 1) {
        requiredBone("avatar required bone is missing or ambiguous");
      }
      indices.put(semantic, matches.getFirst());
    }
    Map<Integer, Integer> jointPosition = new HashMap<>();
    for (int index = 0; index < skin.joints().size(); index++) {
      jointPosition.put(skin.joints().get(index), index);
    }
    for (String semantic : HumanoidSkeleton.REQUIRED_SEMANTICS) {
      int node = indices.get(semantic);
      if (!jointPosition.containsKey(node)) requiredBone("avatar required bone is not skinned");
      String parentSemantic = HumanoidSkeleton.parentSemantic(semantic);
      if (parentSemantic != null && !isDescendant(node, indices.get(parentSemantic), nodes)) {
        requiredBone("avatar humanoid hierarchy is invalid");
      }
    }
    validateLeftAndRightSides(indices, nodes);

    List<Matrix4f> world = worldTransforms(nodes);
    Map<String, HumanoidSkeleton.BoneBinding> bindings = new LinkedHashMap<>();
    for (String semantic : HumanoidSkeleton.REQUIRED_SEMANTICS) {
      int nodeIndex = indices.get(semantic);
      Matrix4f nodeWorld = world.get(nodeIndex);
      String parentSemantic = HumanoidSkeleton.parentSemantic(semantic);
      Matrix4f relative =
          parentSemantic == null
              ? new Matrix4f(nodeWorld)
              : new Matrix4f(world.get(indices.get(parentSemantic)))
                  .invert(new Matrix4f())
                  .mul(nodeWorld);
      int jointIndex = jointPosition.get(nodeIndex);
      bindings.put(
          semantic,
          new HumanoidSkeleton.BoneBinding(
              jointIndex, relative, skin.inverseBind().get(jointIndex)));
    }
    List<HumanoidSkeleton.JointBinding> jointBindings = new ArrayList<>(skin.joints().size());
    for (int jointPositionIndex = 0; jointPositionIndex < skin.joints().size(); jointPositionIndex++) {
      cancellationCheckpoint(jointPositionIndex);
      int nodeIndex = skin.joints().get(jointPositionIndex);
      int parentNode = nodes.get(nodeIndex).parent();
      while (parentNode >= 0 && !jointPosition.containsKey(parentNode)) {
        parentNode = nodes.get(parentNode).parent();
      }
      int parentJoint = parentNode < 0 ? -1 : jointPosition.get(parentNode);
      Matrix4f local =
          parentNode < 0
              ? new Matrix4f(world.get(nodeIndex))
              : new Matrix4f(world.get(parentNode)).invert().mul(world.get(nodeIndex));
      jointBindings.add(
          new HumanoidSkeleton.JointBinding(
              jointPositionIndex, parentJoint, local, skin.inverseBind().get(jointPositionIndex)));
    }
    return HumanoidSkeleton.fromDecoded(bindings, fullExpressions, jointBindings);
  }

  private static void validateLeftAndRightSides(
      Map<String, Integer> indices, List<Node> nodes) throws AvatarRenderException {
    List<Matrix4f> world = worldTransforms(nodes);
    float hipsX = world.get(indices.get("hips")).m30();
    List<List<String>> pairs =
        List.of(
            List.of("leftUpperArm", "rightUpperArm"),
            List.of("leftHand", "rightHand"),
            List.of("leftUpperLeg", "rightUpperLeg"),
            List.of("leftFoot", "rightFoot"));
    int leftDirection = 0;
    for (List<String> pair : pairs) {
      float left = world.get(indices.get(pair.get(0))).m30() - hipsX;
      float right = world.get(indices.get(pair.get(1))).m30() - hipsX;
      if (Math.abs(left) < 0.000001f
          || Math.abs(right) < 0.000001f
          || Math.signum(left) == Math.signum(right)) {
        requiredBone("avatar left and right rest pose is invalid");
      }
      int direction = left > 0 ? 1 : -1;
      if (leftDirection == 0) leftDirection = direction;
      else if (leftDirection != direction) {
        requiredBone("avatar left and right rest pose is inconsistent");
      }
    }
  }

  private static boolean isDescendant(int child, int ancestor, List<Node> nodes) {
    int current = nodes.get(child).parent();
    while (current >= 0) {
      if (current == ancestor) return true;
      current = nodes.get(current).parent();
    }
    return false;
  }

  private static List<Matrix4f> worldTransforms(List<Node> nodes) throws AvatarRenderException {
    Matrix4f[] world = new Matrix4f[nodes.size()];
    for (int start = 0; start < nodes.size(); start++) {
      cancellationCheckpoint(start);
      if (world[start] != null) continue;
      ArrayDeque<Integer> chain = new ArrayDeque<>();
      int current = start;
      while (current >= 0 && world[current] == null) {
        chain.push(current);
        current = nodes.get(current).parent();
      }
      Matrix4f parent = current < 0 ? new Matrix4f() : world[current];
      while (!chain.isEmpty()) {
        int node = chain.pop();
        parent = new Matrix4f(parent).mul(nodes.get(node).local());
        world[node] = parent;
      }
    }
    return java.util.Arrays.stream(world).map(Matrix4f::new).toList();
  }

  private static void validateExtensions(JsonObject json) throws AvatarRenderException {
    JsonArray used = optionalArray(json, "extensionsUsed", 128);
    JsonArray required = optionalArray(json, "extensionsRequired", 128);
    if (!required.isEmpty() || !used.isEmpty()) {
      invalid("avatar glTF extensions are unsupported");
    }
  }

  private static void validateAnimations(
      JsonObject json, List<Accessor> accessors, List<Node> nodes) throws AvatarRenderException {
    JsonArray animations = optionalArray(json, "animations", 128);
    for (JsonElement value : animations) {
      GlbDocumentReader.cancellationCheckpoint();
      JsonObject animation = object(value, "animation");
      JsonArray samplers = array(animation, "samplers", 1024);
      List<AnimationSampler> decodedSamplers = new ArrayList<>(samplers.size());
      for (JsonElement samplerValue : samplers) {
        JsonObject sampler = object(samplerValue, "animation sampler");
        int input = integer(sampler, "input", 0, accessors.size() - 1);
        int output = integer(sampler, "output", 0, accessors.size() - 1);
        if (!"SCALAR".equals(accessors.get(input).type())
            || accessors.get(input).componentType() != 5126
            || accessors.get(output).componentType() != 5126
            || !Set.of("LINEAR", "STEP").contains(optionalString(sampler, "interpolation", "LINEAR"))) {
          invalid("avatar animation sampler is unsupported");
        }
        decodedSamplers.add(new AnimationSampler(accessors.get(input), accessors.get(output)));
      }
      JsonArray channels = array(animation, "channels", 4096);
      for (JsonElement channelValue : channels) {
        JsonObject channel = object(channelValue, "animation channel");
        AnimationSampler sampler =
            decodedSamplers.get(integer(channel, "sampler", 0, samplers.size() - 1));
        JsonObject target = object(channel, "target");
        int nodeIndex = integer(target, "node", 0, nodes.size() - 1);
        String path = string(target, "path");
        if (!Set.of("translation", "rotation", "scale", "weights").contains(path)) {
          invalid("avatar animation target path is invalid");
        }
        String outputType = switch (path) {
          case "translation", "scale" -> "VEC3";
          case "rotation" -> "VEC4";
          case "weights" -> "SCALAR";
          default -> throw new IllegalStateException("validated animation path");
        };
        long expectedOutputCount = sampler.input().count();
        if ("weights".equals(path)) {
          expectedOutputCount *= morphTargetCount(json, nodes.get(nodeIndex));
        }
        if (!outputType.equals(sampler.output().type())
            || sampler.output().count() != expectedOutputCount) {
          invalid("avatar animation output accessor is invalid");
        }
      }
    }
  }

  private static int morphTargetCount(JsonObject json, Node node)
      throws AvatarRenderException {
    JsonArray meshes = optionalArray(json, "meshes", MAX_NODES);
    if (node.mesh() < 0 || node.mesh() >= meshes.size()) {
      invalid("avatar animation weights target is not a mesh node");
    }
    JsonArray primitives =
        array(object(meshes.get(node.mesh()), "mesh"), "primitives", MAX_PRIMITIVES);
    int count = -1;
    for (JsonElement value : primitives) {
      JsonArray targets =
          optionalArray(object(value, "primitive"), "targets", 128);
      if (targets.isEmpty() || (count >= 0 && count != targets.size())) {
        invalid("avatar animation morph target count is invalid");
      }
      count = targets.size();
    }
    if (count < 1) invalid("avatar animation weights target has no morph targets");
    return count;
  }

  private static ImageDimensions imageDimensions(ByteBuffer encoded, String mimeType)
      throws AvatarRenderException {
    ByteBuffer bytes = encoded.order(ByteOrder.BIG_ENDIAN);
    if ("image/png".equals(mimeType)) {
      if (bytes.remaining() < 24
          || bytes.getLong(0) != 0x89504e470d0a1a0aL
          || bytes.getInt(12) != 0x49484452) {
        invalid("avatar PNG header is invalid");
      }
      return new ImageDimensions(bytes.getInt(16), bytes.getInt(20));
    }
    if (bytes.remaining() < 4
        || Byte.toUnsignedInt(bytes.get(0)) != 0xff
        || Byte.toUnsignedInt(bytes.get(1)) != 0xd8) {
      invalid("avatar JPEG header is invalid");
    }
    int offset = 2;
    while (offset + 9 < bytes.limit()) {
      GlbDocumentReader.cancellationCheckpoint();
      if (Byte.toUnsignedInt(bytes.get(offset)) != 0xff) invalid("avatar JPEG marker is invalid");
      int marker = Byte.toUnsignedInt(bytes.get(offset + 1));
      if (marker == 0xc0 || marker == 0xc1 || marker == 0xc2) {
        return new ImageDimensions(
            Short.toUnsignedInt(bytes.getShort(offset + 7)),
            Short.toUnsignedInt(bytes.getShort(offset + 5)));
      }
      if (offset + 4 > bytes.limit()) break;
      int length = Short.toUnsignedInt(bytes.getShort(offset + 2));
      if (length < 2 || offset + 2L + length > bytes.limit()) break;
      offset += 2 + length;
    }
    throw invalidException("avatar JPEG dimensions are missing");
  }

  private static List<GlbPrimitive> instantiateActiveScene(
      JsonObject json, List<Node> nodes, List<List<GlbPrimitive>> meshes, int skinCount)
      throws AvatarRenderException {
    validateMeshNodes(nodes, meshes.size(), skinCount);
    JsonArray scenes = array(json, "scenes", MAX_NODES);
    int activeScene = optionalInteger(json, "scene", 0, 0, scenes.size() - 1);
    List<Integer> roots = integerList(object(scenes.get(activeScene), "scene"), "nodes", nodes.size(), MAX_NODES);
    List<Matrix4f> world = worldTransforms(nodes);
    boolean[] visited = new boolean[nodes.size()];
    ArrayDeque<Integer> pending = new ArrayDeque<>();
    for (int index = roots.size() - 1; index >= 0; index--) pending.push(roots.get(index));
    List<GlbPrimitive> instances = new ArrayList<>();
    while (!pending.isEmpty()) {
      GlbDocumentReader.cancellationCheckpoint();
      int nodeIndex = pending.pop();
      if (visited[nodeIndex]) invalid("avatar active scene references a node more than once");
      visited[nodeIndex] = true;
      Node node = nodes.get(nodeIndex);
      if (node.mesh() >= 0) {
        if (node.skin() != 0) invalid("avatar active mesh uses an unsupported skin");
        List<GlbPrimitive> definitions = meshes.get(node.mesh());
        if (definitions.size() > MAX_ACTIVE_DRAWS - instances.size()) {
          invalid("avatar active scene has too many draw instances");
        }
        for (GlbPrimitive primitive : definitions) {
          instances.add(primitive.withNodeTransform(world.get(nodeIndex)));
        }
      }
      for (int index = node.children().size() - 1; index >= 0; index--) {
        pending.push(node.children().get(index));
      }
    }
    return List.copyOf(instances);
  }

  private static List<GlbImage> decodeImages(
      JsonObject json, List<BufferView> views, ByteBuffer binary) throws AvatarRenderException {
    JsonArray values = optionalArray(json, "images", MAX_TEXTURES);
    List<GlbImage> images = new ArrayList<>(values.size());
    long totalPixels = 0;
    for (JsonElement value : values) {
      GlbDocumentReader.cancellationCheckpoint();
      JsonObject image = object(value, "image");
      int viewIndex = integer(image, "bufferView", 0, views.size() - 1);
      String mimeType = string(image, "mimeType");
      if (!Set.of("image/png", "image/jpeg").contains(mimeType)) {
        invalid("avatar image MIME type is invalid");
      }
      BufferView view = views.get(viewIndex);
      ByteBuffer encoded = slice(binary, view.offset(), view.length());
      ImageDimensions dimensions = imageDimensions(encoded, mimeType);
      long pixels = (long) dimensions.width() * dimensions.height();
      if (dimensions.width() < 1
          || dimensions.height() < 1
          || dimensions.width() > MAX_TEXTURE_DIMENSION
          || dimensions.height() > MAX_TEXTURE_DIMENSION
          || pixels > MAX_TEXTURE_PIXELS - totalPixels) {
        invalid("avatar texture dimensions exceed the decoded budget");
      }
      totalPixels += pixels;
      images.add(new GlbImage(encoded, mimeType, dimensions.width(), dimensions.height()));
    }
    return List.copyOf(images);
  }

  private static List<Integer> decodeMaterialImages(JsonObject json, int imageCount)
      throws AvatarRenderException {
    JsonArray samplers = optionalArray(json, "samplers", MAX_TEXTURES);
    for (JsonElement value : samplers) object(value, "sampler");
    JsonArray textures = optionalArray(json, "textures", MAX_TEXTURES);
    List<Integer> textureImages = new ArrayList<>(textures.size());
    for (JsonElement value : textures) {
      GlbDocumentReader.cancellationCheckpoint();
      JsonObject texture = object(value, "texture");
      textureImages.add(integer(texture, "source", 0, imageCount - 1));
      if (texture.has("sampler")) integer(texture, "sampler", 0, samplers.size() - 1);
    }
    JsonArray materials = optionalArray(json, "materials", MAX_MATERIALS);
    List<Integer> materialImages = new ArrayList<>(materials.size());
    for (JsonElement value : materials) {
      GlbDocumentReader.cancellationCheckpoint();
      JsonObject material = object(value, "material");
      if (!"OPAQUE".equals(optionalString(material, "alphaMode", "OPAQUE"))
          || optionalBoolean(material, "doubleSided", false)
          || material.has("normalTexture")
          || material.has("occlusionTexture")
          || material.has("emissiveTexture")
          || material.has("extensions")) {
        invalid("avatar material mode is unsupported");
      }
      int imageIndex = -1;
      if (material.has("pbrMetallicRoughness")) {
        JsonObject pbr = object(material, "pbrMetallicRoughness");
        if (pbr.has("baseColorTexture")) {
          JsonObject texture = object(pbr, "baseColorTexture");
          imageIndex = textureImages.get(integer(texture, "index", 0, textures.size() - 1));
        }
      }
      materialImages.add(imageIndex);
    }
    return List.copyOf(materialImages);
  }

  private static DecodedMeshes decodePrimitives(
      JsonObject json,
      List<Accessor> accessors,
      List<BufferView> views,
      ByteBuffer binary,
      int jointCount,
      List<Integer> materialImages,
      boolean fullExpressions)
      throws AvatarRenderException {
    JsonArray meshes = optionalArray(json, "meshes", MAX_NODES);
    List<List<GlbPrimitive>> decodedMeshes = new ArrayList<>();
    int primitiveCount = 0;
    DecodeCache cache = new DecodeCache();
    Map<GeometrySignature, Object> geometryKeys = new HashMap<>();
    for (JsonElement meshValue : meshes) {
      GlbDocumentReader.cancellationCheckpoint();
      JsonObject mesh = object(meshValue, "mesh");
      JsonArray primitives = array(mesh, "primitives", MAX_PRIMITIVES);
      if (primitives.isEmpty()) invalid("avatar mesh contains no primitives");
      List<GlbPrimitive> decoded = new ArrayList<>();
      for (JsonElement primitiveValue : primitives) {
        GlbDocumentReader.cancellationCheckpoint();
        if (++primitiveCount > MAX_PRIMITIVES) invalid("avatar has too many primitives");
        JsonObject primitive = object(primitiveValue, "primitive");
        if (optionalInteger(primitive, "mode", 4, 0, 6) != 4) {
          invalid("avatar mesh primitive is not TRIANGLES");
        }
        JsonObject attributes = object(primitive, "attributes");
        for (String attributeName : attributes.keySet()) {
          if ((attributeName.startsWith("JOINTS_") && !"JOINTS_0".equals(attributeName))
              || (attributeName.startsWith("WEIGHTS_") && !"WEIGHTS_0".equals(attributeName))) {
            invalid("avatar vertices may have at most four skin influences");
          }
        }
        Accessor positions = attribute(attributes, "POSITION", accessors, "VEC3", 5126);
        Accessor normals = attribute(attributes, "NORMAL", accessors, "VEC3", 5126);
        Accessor texCoords = attribute(attributes, "TEXCOORD_0", accessors, "VEC2", 5126);
        Accessor joints = attribute(attributes, "JOINTS_0", accessors, "VEC4", 5121, 5123);
        Accessor weights = attribute(attributes, "WEIGHTS_0", accessors, "VEC4", 5126, 5121, 5123);
        if (positions.normalized()
            || normals.normalized()
            || texCoords.normalized()
            || joints.normalized()) {
          invalid("avatar mesh attribute normalization is invalid");
        }
        int vertices = positions.count();
        if (normals.count() != vertices
            || texCoords.count() != vertices
            || joints.count() != vertices
            || weights.count() != vertices) {
          invalid("avatar mesh vertex attributes have different counts");
        }
        validateMorphTargets(primitive, accessors, vertices, fullExpressions);
        ByteBuffer positionBytes = cache.floats(positions, views, binary);
        ByteBuffer normalBytes = cache.floats(normals, views, binary);
        ByteBuffer texCoordBytes = cache.floats(texCoords, views, binary);
        ByteBuffer weightBytes = cache.weights(weights, views, binary);
        JointBuffer jointBuffer =
            cache.joints(joints, weights, weightBytes, views, binary, jointCount);
        Accessor indexAccessor = accessors.get(integer(primitive, "indices", 0, accessors.size() - 1));
        if (!"SCALAR".equals(indexAccessor.type())
            || !Set.of(5121, 5123, 5125).contains(indexAccessor.componentType())) {
          invalid("avatar index accessor is invalid");
        }
        IndexBuffer indexBuffer = cache.indices(indexAccessor, views, binary, vertices);
        int baseColorImage =
            primitive.has("material")
                ? materialImages.get(integer(primitive, "material", 0, materialImages.size() - 1))
                : -1;
        Object geometryKey =
            geometryKeys.computeIfAbsent(
                new GeometrySignature(
                    positions, normals, texCoords, joints, weights, indexAccessor),
                ignored -> new Object());
        decoded.add(
            new GlbPrimitive(
                positionBytes,
                normalBytes,
                texCoordBytes,
                jointBuffer.bytes(),
                weightBytes,
                indexBuffer.bytes(),
                vertices,
                indexAccessor.count(),
                indexBuffer.componentType(),
                baseColorImage,
                new Matrix4f(),
                jointBuffer.palette(),
                geometryKey));
      }
      decodedMeshes.add(List.copyOf(decoded));
    }
    return new DecodedMeshes(List.copyOf(decodedMeshes), cache.decodedBytes());
  }

  private static void validateMorphTargets(
      JsonObject primitive, List<Accessor> accessors, int vertexCount, boolean fullExpressions)
      throws AvatarRenderException {
    if (!primitive.has("targets")) return;
    JsonArray targets = array(primitive, "targets", 128);
    for (JsonElement value : targets) {
      JsonObject target = object(value, "morph target");
      for (String attribute : target.keySet()) {
        if (!Set.of("POSITION", "NORMAL", "TANGENT").contains(attribute)) {
          invalid("avatar morph target attribute is unsupported");
        }
        Accessor accessor =
            accessors.get(integer(target, attribute, 0, accessors.size() - 1));
        if (!"VEC3".equals(accessor.type())
            || accessor.componentType() != 5126
            || accessor.normalized()
            || accessor.count() != vertexCount) {
          invalid("avatar morph target accessor is invalid");
        }
      }
    }
    if (fullExpressions) invalid("avatar morph expressions are unsupported");
  }

  private static Accessor attribute(
      JsonObject attributes,
      String name,
      List<Accessor> accessors,
      String type,
      int... allowedComponents)
      throws AvatarRenderException {
    Accessor accessor = accessors.get(integer(attributes, name, 0, accessors.size() - 1));
    if (!type.equals(accessor.type())
        || java.util.Arrays.stream(allowedComponents)
            .noneMatch(component -> component == accessor.componentType())) {
      invalid("avatar mesh attribute " + name + " is invalid");
    }
    return accessor;
  }

  private static ByteBuffer canonicalFloats(
      Accessor accessor, List<BufferView> views, ByteBuffer binary, boolean normalize)
      throws AvatarRenderException {
    ByteBuffer output =
        ByteBuffer.allocateDirect(accessor.count() * accessor.components() * Float.BYTES)
            .order(ByteOrder.LITTLE_ENDIAN);
    for (int index = 0; index < accessor.count(); index++) {
      cancellationCheckpoint(index);
      float[] values = readFloatElement(accessor, index, views, binary);
      for (float value : values) {
        if (!Float.isFinite(value)) invalid("avatar mesh contains a non-finite value");
        output.putFloat(value);
      }
    }
    return readOnly(output.flip());
  }

  private static ByteBuffer canonicalGlobalJoints(
      Accessor accessor,
      List<BufferView> views,
      ByteBuffer binary,
      int jointCount)
      throws AvatarRenderException {
    ByteBuffer output =
        ByteBuffer.allocateDirect(accessor.count() * 4 * Short.BYTES).order(ByteOrder.LITTLE_ENDIAN);
    for (int index = 0; index < accessor.count(); index++) {
      cancellationCheckpoint(index);
      int base = elementOffset(accessor, index, views);
      for (int component = 0; component < 4; component++) {
        int joint = readUnsigned(binary, base + component * accessor.componentBytes(), accessor.componentType());
        if (joint >= jointCount) invalid("avatar mesh joint index is out of bounds");
        output.putShort((short) joint);
      }
    }
    return readOnly(output.flip());
  }

  static PaletteRemap remapJointPalette(
      ByteBuffer globalJoints, ByteBuffer weights, int jointCount)
      throws AvatarRenderException {
    ByteBuffer sourceJoints = globalJoints.duplicate().order(ByteOrder.LITTLE_ENDIAN);
    ByteBuffer sourceWeights = weights.duplicate().order(ByteOrder.LITTLE_ENDIAN);
    if (jointCount < 1
        || sourceJoints.remaining() % (4 * Short.BYTES) != 0
        || sourceWeights.remaining() != sourceJoints.remaining() * 2) {
      invalid("avatar joint palette input is invalid");
    }
    int vertices = sourceJoints.remaining() / (4 * Short.BYTES);
    ByteBuffer output =
        ByteBuffer.allocateDirect(sourceJoints.remaining()).order(ByteOrder.LITTLE_ENDIAN);
    Map<Integer, Integer> palette = new LinkedHashMap<>();
    for (int vertex = 0; vertex < vertices; vertex++) {
      cancellationCheckpoint(vertex);
      int jointOffset = sourceJoints.position() + vertex * 4 * Short.BYTES;
      int weightOffset = sourceWeights.position() + vertex * 4 * Float.BYTES;
      for (int component = 0; component < 4; component++) {
        int joint =
            Short.toUnsignedInt(sourceJoints.getShort(jointOffset + component * Short.BYTES));
        if (joint >= jointCount) invalid("avatar mesh joint index is out of bounds");
        float weight = sourceWeights.getFloat(weightOffset + component * Float.BYTES);
        int local = 0;
        if (weight > 0.0f) {
          Integer mapped = palette.get(joint);
          if (mapped == null) {
            if (palette.size() >= AvatarGpuResources.MAX_SHADER_JOINTS) {
              invalid("avatar primitive uses too many active joints");
            }
            mapped = palette.size();
            palette.put(joint, mapped);
          }
          local = mapped;
        }
        output.putShort((short) local);
      }
    }
    if (palette.isEmpty()) invalid("avatar primitive has no active joints");
    return new PaletteRemap(readOnly(output.flip()), List.copyOf(palette.keySet()));
  }

  private static ByteBuffer canonicalWeights(
      Accessor accessor, List<BufferView> views, ByteBuffer binary) throws AvatarRenderException {
    ByteBuffer output =
        ByteBuffer.allocateDirect(accessor.count() * 4 * Float.BYTES).order(ByteOrder.LITTLE_ENDIAN);
    for (int index = 0; index < accessor.count(); index++) {
      cancellationCheckpoint(index);
      float[] weights = readFloatElement(accessor, index, views, binary);
      float total = 0;
      for (float weight : weights) {
        if (!Float.isFinite(weight) || weight < 0) invalid("avatar skin weight is invalid");
        total += weight;
      }
      if (!Float.isFinite(total) || total <= 0.000001f) {
        invalid("avatar skin weights have no influence");
      }
      for (float weight : weights) output.putFloat(weight / total);
    }
    return readOnly(output.flip());
  }

  private static IndexBuffer canonicalIndices(
      Accessor accessor, List<BufferView> views, ByteBuffer binary, int vertexCount)
      throws AvatarRenderException {
    int outputType = vertexCount <= 65_535 ? 5123 : 5125;
    ByteBuffer output =
        ByteBuffer.allocateDirect(accessor.count() * (outputType == 5123 ? 2 : 4))
            .order(ByteOrder.LITTLE_ENDIAN);
    for (int index = 0; index < accessor.count(); index++) {
      cancellationCheckpoint(index);
      int value =
          readUnsigned(binary, elementOffset(accessor, index, views), accessor.componentType());
      if (value < 0 || value >= vertexCount) invalid("avatar mesh index is out of bounds");
      if (outputType == 5123) output.putShort((short) value);
      else output.putInt(value);
    }
    return new IndexBuffer(readOnly(output.flip()), outputType);
  }

  private static float[] readFloatElement(
      Accessor accessor, int index, List<BufferView> views, ByteBuffer binary)
      throws AvatarRenderException {
    float[] output = new float[accessor.components()];
    int base = elementOffset(accessor, index, views);
    for (int component = 0; component < output.length; component++) {
      int offset = base + component * accessor.componentBytes();
      output[component] = readComponent(binary, offset, accessor.componentType(), accessor.normalized());
    }
    return output;
  }

  private static int elementOffset(Accessor accessor, int index, List<BufferView> views) {
    BufferView view = views.get(accessor.view());
    return view.offset() + accessor.byteOffset() + index * accessor.stride();
  }

  private static float readComponent(
      ByteBuffer binary, int offset, int componentType, boolean normalized)
      throws AvatarRenderException {
    return switch (componentType) {
      case 5120 -> {
        byte value = binary.get(offset);
        yield normalized ? Math.max(value / 127.0f, -1.0f) : value;
      }
      case 5121 -> {
        int value = Byte.toUnsignedInt(binary.get(offset));
        yield normalized ? value / 255.0f : value;
      }
      case 5122 -> {
        short value = binary.getShort(offset);
        yield normalized ? Math.max(value / 32767.0f, -1.0f) : value;
      }
      case 5123 -> {
        int value = Short.toUnsignedInt(binary.getShort(offset));
        yield normalized ? value / 65535.0f : value;
      }
      case 5125 -> Integer.toUnsignedLong(binary.getInt(offset));
      case 5126 -> binary.getFloat(offset);
      default -> throw invalidException("avatar accessor component type is invalid");
    };
  }

  private static int readUnsigned(ByteBuffer binary, int offset, int componentType)
      throws AvatarRenderException {
    return switch (componentType) {
      case 5121 -> Byte.toUnsignedInt(binary.get(offset));
      case 5123 -> Short.toUnsignedInt(binary.getShort(offset));
      case 5125 -> {
        long value = Integer.toUnsignedLong(binary.getInt(offset));
        if (value > Integer.MAX_VALUE) invalid("avatar index exceeds the supported range");
        yield (int) value;
      }
      default -> throw invalidException("avatar unsigned accessor type is invalid");
    };
  }

  private static void validateMeshNodes(List<Node> nodes, int meshCount, int skinCount)
      throws AvatarRenderException {
    for (Node node : nodes) {
      GlbDocumentReader.cancellationCheckpoint();
      if (node.mesh() >= 0 && node.skin() < 0) invalid("avatar mesh node is not skinned");
      if (node.mesh() >= meshCount) invalid("avatar node mesh is out of bounds");
      if (node.skin() >= skinCount) invalid("avatar node skin is out of bounds");
    }
  }

  private static int components(String type) throws AvatarRenderException {
    return switch (type) {
      case "SCALAR" -> 1;
      case "VEC2" -> 2;
      case "VEC3" -> 3;
      case "VEC4", "MAT2" -> 4;
      case "MAT3" -> 9;
      case "MAT4" -> 16;
      default -> throw invalidException("avatar accessor type is invalid");
    };
  }

  private static int componentBytes(int componentType) throws AvatarRenderException {
    return switch (componentType) {
      case 5120, 5121 -> 1;
      case 5122, 5123 -> 2;
      case 5125, 5126 -> 4;
      default -> throw invalidException("avatar accessor component type is invalid");
    };
  }

  private static int elementBytes(String type, int componentBytes) throws AvatarRenderException {
    if (type.startsWith("MAT")) {
      int dimension = Integer.parseInt(type.substring(3));
      int columnBytes = alignFour(dimension * componentBytes);
      return dimension * columnBytes;
    }
    return components(type) * componentBytes;
  }

  private static ByteBuffer slice(ByteBuffer source, int offset, int length) {
    return readOnly(source.slice(offset, length).order(ByteOrder.LITTLE_ENDIAN));
  }

  private static ByteBuffer readOnly(ByteBuffer buffer) {
    return buffer.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN);
  }

  private static int alignFour(int value) {
    return (value + 3) & ~3;
  }

  private static JsonArray array(JsonObject object, String key, int maximum)
      throws AvatarRenderException {
    JsonElement value = object.get(key);
    if (value == null || !value.isJsonArray() || value.getAsJsonArray().size() > maximum) {
      invalid("avatar " + key + " is invalid");
    }
    return value.getAsJsonArray();
  }

  private static JsonArray optionalArray(JsonObject object, String key, int maximum)
      throws AvatarRenderException {
    return object.has(key) ? array(object, key, maximum) : new JsonArray();
  }

  private static JsonObject object(JsonObject parent, String key) throws AvatarRenderException {
    return object(parent.get(key), key);
  }

  private static JsonObject object(JsonElement value, String label) throws AvatarRenderException {
    if (value == null || !value.isJsonObject()) invalid("avatar " + label + " is invalid");
    return value.getAsJsonObject();
  }

  private static String string(JsonObject object, String key) throws AvatarRenderException {
    JsonElement value = object.get(key);
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
      invalid("avatar " + key + " is invalid");
    }
    return value.getAsString();
  }

  private static String optionalString(JsonObject object, String key, String fallback)
      throws AvatarRenderException {
    return object.has(key) ? string(object, key) : fallback;
  }

  private static int integer(JsonObject object, String key, int minimum, int maximum)
      throws AvatarRenderException {
    JsonElement value = object.get(key);
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
      invalid("avatar " + key + " is invalid");
    }
    try {
      BigDecimal number = value.getAsBigDecimal();
      int decoded = number.intValueExact();
      if (decoded < minimum || decoded > maximum) invalid("avatar " + key + " is out of bounds");
      return decoded;
    } catch (ArithmeticException error) {
      throw invalidException("avatar " + key + " is invalid");
    }
  }

  private static int optionalInteger(
      JsonObject object, String key, int fallback, int minimum, int maximum)
      throws AvatarRenderException {
    return object.has(key) ? integer(object, key, minimum, maximum) : fallback;
  }

  private static boolean optionalBoolean(JsonObject object, String key, boolean fallback)
      throws AvatarRenderException {
    if (!object.has(key)) return fallback;
    JsonElement value = object.get(key);
    if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean()) {
      invalid("avatar " + key + " is invalid");
    }
    return value.getAsBoolean();
  }

  private static List<Integer> integerList(
      JsonObject object, String key, int bound, int maximum) throws AvatarRenderException {
    JsonArray values = optionalArray(object, key, maximum);
    List<Integer> decoded = new ArrayList<>(values.size());
    for (JsonElement value : values) {
      GlbDocumentReader.cancellationCheckpoint();
      JsonObject holder = new JsonObject();
      holder.add("value", value);
      decoded.add(integer(holder, "value", 0, bound - 1));
    }
    return List.copyOf(decoded);
  }

  private static float[] floatTuple(
      JsonObject object, String key, int length, float[] fallback) throws AvatarRenderException {
    if (!object.has(key)) return Objects.requireNonNull(fallback, key).clone();
    JsonElement value = object.get(key);
    if (!value.isJsonArray() || value.getAsJsonArray().size() != length) {
      invalid("avatar " + key + " is invalid");
    }
    float[] result = new float[length];
    for (int index = 0; index < length; index++) {
      JsonElement entry = value.getAsJsonArray().get(index);
      if (!entry.isJsonPrimitive() || !entry.getAsJsonPrimitive().isNumber()) {
        invalid("avatar " + key + " is invalid");
      }
      result[index] = entry.getAsFloat();
      if (!Float.isFinite(result[index])) invalid("avatar " + key + " is invalid");
    }
    return result;
  }

  private static boolean hasControls(String value) {
    return value.codePoints().anyMatch(codePoint -> codePoint < 0x20 || codePoint == 0x7f);
  }

  private static void requiredBone(String message) throws AvatarRenderException {
    throw GlbDocumentReader.failure("AVATAR_REQUIRED_BONE_MISSING", message);
  }

  private static void invalid(String message) throws AvatarRenderException {
    throw invalidException(message);
  }

  private static AvatarRenderException invalidException(String message) {
    return GlbDocumentReader.failure("AVATAR_GLB_INVALID", message);
  }

  private record BufferView(int offset, int length, int stride) {}

  private record Accessor(
      int view,
      int byteOffset,
      int componentType,
      int componentBytes,
      int count,
      String type,
      int components,
      boolean normalized,
      int stride) {}

  private record AnimationSampler(Accessor input, Accessor output) {}

  private record MutableNode(
      String name, List<Integer> children, Matrix4f local, int mesh, int skin, int parent) {
    private MutableNode withParent(int nextParent) {
      return new MutableNode(name, children, local, mesh, skin, nextParent);
    }
  }

  private record Node(
      String name, List<Integer> children, Matrix4f local, int mesh, int skin, int parent) {
    private Node {
      children = List.copyOf(children);
      local = new Matrix4f(local);
    }

    @Override
    public Matrix4f local() {
      return new Matrix4f(local);
    }
  }

  private record Skin(List<Integer> joints, List<Matrix4f> inverseBind) {
    private Skin {
      joints = List.copyOf(joints);
      inverseBind = inverseBind.stream().map(Matrix4f::new).toList();
    }

    @Override
    public List<Matrix4f> inverseBind() {
      return inverseBind.stream().map(Matrix4f::new).toList();
    }
  }

  private record IndexBuffer(ByteBuffer bytes, int componentType) {}

  private record JointBuffer(ByteBuffer bytes, List<Integer> palette) {}

  record PaletteRemap(ByteBuffer joints, List<Integer> palette) {
    PaletteRemap {
      joints = readOnly(joints);
      palette = List.copyOf(palette);
    }

    @Override
    public ByteBuffer joints() {
      return joints.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN);
    }
  }

  private record ImageDimensions(int width, int height) {}

  private record DecodedMeshes(List<List<GlbPrimitive>> meshes, long decodedBytes) {}

  private static final class DecodeCache {
    private final Map<Accessor, ByteBuffer> floats = new HashMap<>();
    private final Map<Accessor, ByteBuffer> globalJoints = new HashMap<>();
    private final Map<JointWeightKey, JointBuffer> joints = new HashMap<>();
    private final Map<Accessor, ByteBuffer> weights = new HashMap<>();
    private final Map<IndexKey, IndexBuffer> indices = new HashMap<>();
    private long decodedBytes;

    private ByteBuffer floats(
        Accessor accessor, List<BufferView> views, ByteBuffer binary)
        throws AvatarRenderException {
      ByteBuffer cached = floats.get(accessor);
      if (cached != null) return cached;
      reserve((long) accessor.count() * accessor.components() * Float.BYTES);
      ByteBuffer decoded = canonicalFloats(accessor, views, binary, false);
      floats.put(accessor, decoded);
      return decoded;
    }

    private JointBuffer joints(
        Accessor accessor,
        Accessor weightAccessor,
        ByteBuffer decodedWeights,
        List<BufferView> views,
        ByteBuffer binary,
        int jointCount)
        throws AvatarRenderException {
      JointWeightKey key = new JointWeightKey(accessor, weightAccessor);
      JointBuffer cached = joints.get(key);
      if (cached != null) return cached;
      ByteBuffer decodedGlobal = globalJoints.get(accessor);
      if (decodedGlobal == null) {
        reserve((long) accessor.count() * 4 * Short.BYTES);
        decodedGlobal = canonicalGlobalJoints(accessor, views, binary, jointCount);
        globalJoints.put(accessor, decodedGlobal);
      }
      reserve((long) accessor.count() * 4 * Short.BYTES);
      PaletteRemap remap = remapJointPalette(decodedGlobal, decodedWeights, jointCount);
      JointBuffer decoded = new JointBuffer(remap.joints(), remap.palette());
      joints.put(key, decoded);
      return decoded;
    }

    private ByteBuffer weights(
        Accessor accessor, List<BufferView> views, ByteBuffer binary)
        throws AvatarRenderException {
      ByteBuffer cached = weights.get(accessor);
      if (cached != null) return cached;
      reserve((long) accessor.count() * 4 * Float.BYTES);
      ByteBuffer decoded = canonicalWeights(accessor, views, binary);
      weights.put(accessor, decoded);
      return decoded;
    }

    private IndexBuffer indices(
        Accessor accessor, List<BufferView> views, ByteBuffer binary, int vertexCount)
        throws AvatarRenderException {
      IndexKey key = new IndexKey(accessor, vertexCount <= 65_535 ? 5123 : 5125);
      IndexBuffer cached = indices.get(key);
      if (cached != null) return cached;
      reserve((long) accessor.count() * (key.outputType() == 5123 ? 2 : 4));
      IndexBuffer decoded = canonicalIndices(accessor, views, binary, vertexCount);
      indices.put(key, decoded);
      return decoded;
    }

    private void reserve(long bytes) throws AvatarRenderException {
      if (bytes < 0 || decodedBytes > MAX_DECODED_BYTES - bytes) {
        invalid("avatar decoded data exceeds the memory budget");
      }
      decodedBytes += bytes;
    }

    private long decodedBytes() {
      return decodedBytes;
    }
  }

  private record IndexKey(Accessor accessor, int outputType) {}

  private record JointWeightKey(Accessor joints, Accessor weights) {}

  private static void cancellationCheckpoint(int index) throws AvatarRenderException {
    if ((index & 0x3ff) == 0) GlbDocumentReader.cancellationCheckpoint();
  }

  private record GeometrySignature(
      Accessor positions,
      Accessor normals,
      Accessor texCoords,
      Accessor joints,
      Accessor weights,
      Accessor indices) {}

  public static final class GlbPrimitive {
    private final ByteBuffer positions;
    private final ByteBuffer normals;
    private final ByteBuffer texCoords;
    private final ByteBuffer joints;
    private final ByteBuffer weights;
    private final ByteBuffer indices;
    private final int vertexCount;
    private final int indexCount;
    private final int indexComponentType;
    private final int materialIndex;
    private final Matrix4f nodeTransform;
    private final List<Integer> jointPalette;
    private final Object geometryKey;

    public GlbPrimitive(
        ByteBuffer positions,
        ByteBuffer normals,
        ByteBuffer texCoords,
        ByteBuffer joints,
        ByteBuffer weights,
        ByteBuffer indices,
        int vertexCount,
        int indexCount,
        int indexComponentType,
        int materialIndex) {
      this(
          positions,
          normals,
          texCoords,
          joints,
          weights,
          indices,
          vertexCount,
          indexCount,
          indexComponentType,
          materialIndex,
          new Matrix4f(),
          inferPalette(joints),
          new Object());
    }

    public GlbPrimitive(
        ByteBuffer positions,
        ByteBuffer normals,
        ByteBuffer texCoords,
        ByteBuffer joints,
        ByteBuffer weights,
        ByteBuffer indices,
        int vertexCount,
        int indexCount,
        int indexComponentType,
        int materialIndex,
        Matrix4f nodeTransform,
        List<Integer> jointPalette) {
      this(
          positions,
          normals,
          texCoords,
          joints,
          weights,
          indices,
          vertexCount,
          indexCount,
          indexComponentType,
          materialIndex,
          nodeTransform,
          jointPalette,
          new Object());
    }

    private GlbPrimitive(
        ByteBuffer positions,
        ByteBuffer normals,
        ByteBuffer texCoords,
        ByteBuffer joints,
        ByteBuffer weights,
        ByteBuffer indices,
        int vertexCount,
        int indexCount,
        int indexComponentType,
        int materialIndex,
        Matrix4f nodeTransform,
        List<Integer> jointPalette,
        Object geometryKey) {
      this.positions = immutable(positions);
      this.normals = immutable(normals);
      this.texCoords = immutable(texCoords);
      this.joints = immutable(joints);
      this.weights = immutable(weights);
      this.indices = immutable(indices);
      this.vertexCount = vertexCount;
      this.indexCount = indexCount;
      this.indexComponentType = indexComponentType;
      this.materialIndex = materialIndex;
      this.nodeTransform = new Matrix4f(Objects.requireNonNull(nodeTransform, "nodeTransform"));
      this.jointPalette = List.copyOf(jointPalette);
      this.geometryKey = geometryKey;
      if (vertexCount < 1 || indexCount < 1 || indexCount % 3 != 0) {
        throw new IllegalArgumentException("invalid avatar primitive counts");
      }
      if (this.jointPalette.isEmpty()
          || this.jointPalette.size() > AvatarGpuResources.MAX_SHADER_JOINTS
          || this.jointPalette.stream().anyMatch(joint -> joint < 0 || joint >= 256)) {
        throw new IllegalArgumentException("invalid avatar joint palette");
      }
    }

    public ByteBuffer positions() {
      return immutable(positions);
    }

    public ByteBuffer normals() {
      return immutable(normals);
    }

    public ByteBuffer texCoords() {
      return immutable(texCoords);
    }

    public ByteBuffer joints() {
      return immutable(joints);
    }

    public ByteBuffer weights() {
      return immutable(weights);
    }

    public ByteBuffer indices() {
      return immutable(indices);
    }

    public int vertexCount() {
      return vertexCount;
    }

    public int indexCount() {
      return indexCount;
    }

    public int indexComponentType() {
      return indexComponentType;
    }

    public int materialIndex() {
      return materialIndex;
    }

    public Matrix4f nodeTransform() {
      return new Matrix4f(nodeTransform);
    }

    public List<Integer> jointPalette() {
      return jointPalette;
    }

    Object geometryKey() {
      return geometryKey;
    }

    private GlbPrimitive withNodeTransform(Matrix4f transform) {
      return new GlbPrimitive(
          positions,
          normals,
          texCoords,
          joints,
          weights,
          indices,
          vertexCount,
          indexCount,
          indexComponentType,
          materialIndex,
          transform,
          jointPalette,
          geometryKey);
    }

    public boolean skinned() {
      return joints.hasRemaining() && weights.hasRemaining();
    }

    private static List<Integer> inferPalette(ByteBuffer joints) {
      ByteBuffer values = joints.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN);
      LinkedHashSet<Integer> palette = new LinkedHashSet<>();
      while (values.remaining() >= Short.BYTES) palette.add(Short.toUnsignedInt(values.getShort()));
      return palette.isEmpty() ? List.of(0) : List.copyOf(palette);
    }
  }

  public static final class GlbImage {
    private final ByteBuffer encoded;
    private final String mimeType;

    private final int width;
    private final int height;

    public GlbImage(ByteBuffer encoded, String mimeType) {
      this(encoded, mimeType, -1, -1);
    }

    public GlbImage(ByteBuffer encoded, String mimeType, int width, int height) {
      this.encoded = immutable(encoded);
      this.mimeType = Objects.requireNonNull(mimeType, "mimeType");
      this.width = width;
      this.height = height;
    }

    public ByteBuffer encoded() {
      return immutable(encoded);
    }

    public String mimeType() {
      return mimeType;
    }

    public int width() {
      return width;
    }

    public int height() {
      return height;
    }
  }

  public static final class GlbMesh {
    private final List<GlbPrimitive> primitives;
    private final HumanoidSkeleton skeleton;
    private final List<GlbImage> images;
    private final String modelId;
    private final long decodedBytes;

    public GlbMesh(
        List<GlbPrimitive> primitives,
        HumanoidSkeleton skeleton,
        List<GlbImage> images,
        String modelId) {
      this(primitives, skeleton, images, modelId, 0);
    }

    public GlbMesh(
        List<GlbPrimitive> primitives,
        HumanoidSkeleton skeleton,
        List<GlbImage> images,
        String modelId,
        long decodedBytes) {
      this.primitives = List.copyOf(primitives);
      this.skeleton = Objects.requireNonNull(skeleton, "skeleton");
      this.images = List.copyOf(images);
      this.modelId = Objects.requireNonNull(modelId, "modelId");
      this.decodedBytes = decodedBytes;
    }

    public List<GlbPrimitive> primitives() {
      return primitives;
    }

    public HumanoidSkeleton skeleton() {
      return skeleton;
    }

    public List<GlbImage> images() {
      return images;
    }

    public String modelId() {
      return modelId;
    }

    public long decodedBytes() {
      return decodedBytes;
    }
  }

  private static ByteBuffer immutable(ByteBuffer source) {
    Objects.requireNonNull(source, "source");
    ByteBuffer duplicate = source.asReadOnlyBuffer().order(ByteOrder.LITTLE_ENDIAN);
    duplicate.position(0);
    return duplicate;
  }
}
