package io.github.whitelily.avatar.render.gltf;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import io.github.whitelily.avatar.render.backend.AvatarFrameResult;
import io.github.whitelily.avatar.render.backend.AvatarRenderContext;
import io.github.whitelily.avatar.render.backend.AvatarRenderException;
import io.github.whitelily.avatar.render.backend.AvatarVisualState;
import io.github.whitelily.avatar.render.backend.PreparedAvatarResources;
import io.github.whitelily.avatar.theme.ArmorTheme;
import java.nio.ByteBuffer;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.joml.Matrix4f;
import org.junit.jupiter.api.Test;

final class SmoothMeshRenderBackendTest {
  @Test
  void publicPrepareRejectsNativeSkinDescriptors() {
    SmoothMeshRenderBackend backend = new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"));

    AvatarRenderException error =
        assertThrows(
            AvatarRenderException.class,
            () ->
                backend.prepare(
                    new AvatarRuntimeDescriptor(
                        "builtin:whitelily", "builtin", "minecraft-skin", "slim")));

    assertEquals("AVATAR_BACKEND_MISMATCH", error.code());
  }

  @Test
  void researchSeamUploadsAndSubmitsAnImportedFrame() throws Exception {
    FakeDevice device = new FakeDevice();
    FakeContext context = new FakeContext(device);
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), ignored -> decodedMesh());

    AvatarFrameResult result = backend.renderFrame(backend.prepareLegacyResearch(imported()), state(), context);

    assertTrue(result.successful());
    assertEquals(1, device.uploadCount);
    assertEquals(1, context.prepareCalls);
    assertEquals(1, context.renderCalls);
    assertNotNull(context.frame);
    assertFalse(context.frame.whiteLilyArmorEnabled());
  }

  @Test
  void researchSeamDisposalPreventsUploadAndClosesOnce() throws Exception {
    FakeDevice device = new FakeDevice();
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), ignored -> decodedMesh());
    PreparedAvatarResources resources = backend.prepareLegacyResearch(imported());

    backend.dispose(resources);
    backend.dispose(resources);
    AvatarFrameResult result = backend.renderFrame(resources, state(), new FakeContext(device));

    assertEquals("AVATAR_GPU_RESOURCE_RELEASED", result.errorCode());
    assertEquals(0, device.uploadCount);
    assertEquals(0, device.closeCount);
  }

  @Test
  void researchSeamFallsBackAfterShaderFailureAndReportsStableCodes() throws Exception {
    FakeDevice device = new FakeDevice();
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), ignored -> decodedMesh());
    PreparedAvatarResources resources = backend.prepareLegacyResearch(imported());
    device.uploadFailure = new AvatarGpuResources.ShaderUnavailableException("compile failed");

    AvatarFrameResult failed = backend.renderFrame(resources, state(), new FakeContext(device));
    device.uploadFailure = null;
    FakeContext fallback = new FakeContext(device);
    AvatarFrameResult recovered = backend.renderFrame(resources, state(), fallback);

    assertEquals("AVATAR_SHADER_FAILED", failed.errorCode());
    assertTrue(recovered.successful());
    assertTrue(fallback.frame.basicCelMaterial());
  }

  @Test
  void researchSeamRetainsTheApprovedAssetPathForReaderCoverage() throws Exception {
    List<String> paths = new java.util.ArrayList<>();
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(
            Path.of("C:/WhiteLily"),
            descriptor -> {
              paths.add(descriptor.resourcePath());
              return decodedMesh();
            });

    backend.prepareLegacyResearch(builtin());

    assertEquals(List.of("builtin/whitelily-hd/high.glb"), paths);
  }

  private static SmoothMeshRenderBackend.LegacyMeshDescriptor imported() {
    return descriptor(
        "user:00000000-0000-4000-8000-000000000001",
        "imported",
        "user/00000000-0000-4000-8000-000000000001/model.glb",
        "neutral-only");
  }

  private static SmoothMeshRenderBackend.LegacyMeshDescriptor builtin() {
    return descriptor("builtin:whitelily-hd", "builtin", "builtin/whitelily-hd/high.glb", "full");
  }

  private static SmoothMeshRenderBackend.LegacyMeshDescriptor descriptor(
      String modelId, String origin, String resourcePath, String expressions) {
    return new SmoothMeshRenderBackend.LegacyMeshDescriptor(
        modelId, origin, resourcePath, "a".repeat(64), semanticNames(), expressions);
  }

  private static Map<String, String> semanticNames() {
    return Map.ofEntries(
        Map.entry("hips", "Hips"), Map.entry("chest", "Chest"), Map.entry("neck", "Neck"),
        Map.entry("head", "Head"), Map.entry("leftUpperArm", "LeftUpperArm"),
        Map.entry("leftLowerArm", "LeftLowerArm"), Map.entry("leftHand", "LeftHand"),
        Map.entry("rightUpperArm", "RightUpperArm"), Map.entry("rightLowerArm", "RightLowerArm"),
        Map.entry("rightHand", "RightHand"), Map.entry("leftUpperLeg", "LeftUpperLeg"),
        Map.entry("leftLowerLeg", "LeftLowerLeg"), Map.entry("leftFoot", "LeftFoot"),
        Map.entry("rightUpperLeg", "RightUpperLeg"), Map.entry("rightLowerLeg", "RightLowerLeg"),
        Map.entry("rightFoot", "RightFoot"));
  }

  private static GlbMeshDecoder.GlbMesh decodedMesh() {
    Map<String, Matrix4f> bind = new java.util.LinkedHashMap<>();
    for (String semantic : semanticNames().keySet()) bind.put(semantic, new Matrix4f());
    HumanoidSkeleton skeleton = HumanoidSkeleton.fromSemanticBindPose(bind, true);
    ByteBuffer positions = floats(0, 0, 0, 1, 0, 0, 0, 1, 0);
    ByteBuffer normals = floats(0, 0, 1, 0, 0, 1, 0, 0, 1);
    ByteBuffer texCoords = floats(0, 0, 1, 0, 0, 1);
    ByteBuffer joints = ByteBuffer.allocateDirect(24);
    ByteBuffer weights = floats(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0);
    ByteBuffer indices = ByteBuffer.allocateDirect(6);
    return new GlbMeshDecoder.GlbMesh(
        List.of(new GlbMeshDecoder.GlbPrimitive(
            positions, normals, texCoords, joints, weights, indices, 3, 3, 5123, -1)),
        skeleton, List.of(), "a".repeat(64));
  }

  private static ByteBuffer floats(float... values) {
    ByteBuffer buffer = ByteBuffer.allocateDirect(values.length * Float.BYTES);
    for (float value : values) buffer.putFloat(value);
    return buffer.flip();
  }

  private static AvatarVisualState state() {
    return new AvatarVisualState(
        1, "world-backend", 0, 64, 0, 0, 0, "standing", 0.5f, 4.0f,
        ArmorTheme.DIAMOND, "minecraft:iron_pickaxe", "minecraft:torch", true, false, false,
        false, false, true, "neutral", 4, new AvatarVisualState.GraphicsCapabilities(true, true, 128));
  }

  private static final class FakeDevice implements AvatarGpuResources.Device {
    private int uploadCount;
    private int closeCount;
    private RuntimeException uploadFailure;

    @Override
    public AvatarGpuResources.Allocation upload(GlbMeshDecoder.GlbMesh mesh) {
      uploadCount++;
      if (uploadFailure != null) throw uploadFailure;
      return () -> closeCount++;
    }
  }

  private static final class FakeContext implements AvatarRenderContext {
    private final FakeDevice device;
    private SmoothMeshRenderBackend.SmoothMeshFrame frame;
    private int prepareCalls;
    private int renderCalls;

    private FakeContext(FakeDevice device) { this.device = device; }

    @Override public FrameTransaction beginFrame() { return new FrameTransaction() {
      @Override public void commit() {}
      @Override public void restore() {}
    }; }
    @Override public void renderClassic() {}
    @Override public AvatarGpuResources.Device avatarGpuDevice() { return device; }
    @Override public void prepareSmooth(SmoothMeshRenderBackend.SmoothMeshFrame value) { prepareCalls++; }
    @Override public void renderSmooth(SmoothMeshRenderBackend.SmoothMeshFrame value) { renderCalls++; frame = value; }
  }
}
