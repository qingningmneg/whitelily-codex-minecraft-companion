package io.github.whitelily.avatar.render.gltf;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.mojang.blaze3d.pipeline.RenderPipeline;
import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import io.github.whitelily.avatar.render.backend.AvatarFrameResult;
import io.github.whitelily.avatar.render.backend.AvatarRenderContext;
import io.github.whitelily.avatar.render.backend.AvatarRenderBackendRegistry;
import io.github.whitelily.avatar.render.backend.AvatarRenderException;
import io.github.whitelily.avatar.render.backend.AvatarVisualState;
import io.github.whitelily.avatar.render.backend.PreparedAvatarResources;
import io.github.whitelily.avatar.theme.ArmorTheme;
import java.nio.ByteBuffer;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.client.renderer.RenderPipelines;
import org.joml.Matrix4f;
import org.junit.jupiter.api.Test;

final class SmoothMeshRenderBackendTest {
  @Test
  void skinningPipelineBindsFourInfluencesAndAllOneHundredTwentyEightJointMatrices() {
    RenderPipeline pipeline = AvatarGpuResources.skinningPipeline();

    assertEquals("whitelily_avatar:avatar_skinning", pipeline.getVertexShader().toString());
    assertEquals("whitelily_avatar:avatar_skinning", pipeline.getFragmentShader().toString());
    assertTrue(pipeline.getVertexFormat().getElementAttributeNames().contains("Joints"));
    assertTrue(pipeline.getVertexFormat().getElementAttributeNames().contains("Weights"));
    assertTrue(pipeline.getBlendFunction().isPresent());
    assertTrue(
        pipeline.getUniforms().stream()
            .anyMatch(uniform -> uniform.name().equals("JointMatrices[127]")));
    assertEquals(List.of("Sampler0"), pipeline.getSamplers());
    assertFalse(RenderPipelines.getStaticPipelines().contains(pipeline));
  }

  @Test
  void importedFramesUseRealHandAnchorsAndNeverEnableWhiteLilyArmorMeshes() throws Exception {
    FakeDevice device = new FakeDevice();
    FakeContext context = new FakeContext(device);
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), descriptor -> decodedMesh(false));
    PreparedAvatarResources resources = backend.prepare(descriptor("imported"));

    AvatarFrameResult result = backend.renderFrame(resources, state(), context);

    assertTrue(result.successful());
    assertEquals(1, device.uploadCount);
    assertNotNull(context.frame);
    assertFalse(context.frame.whiteLilyArmorEnabled());
    assertEquals("minecraft:iron_pickaxe", context.frame.mainHandItem());
    assertEquals("minecraft:torch", context.frame.offHandItem());
    assertFalse(context.frame.leftHand().equals(context.frame.rightHand(), 0.0001f));
  }

  @Test
  void disposingBeforeTheFirstFramePreventsUploadAndIsIdempotent() throws Exception {
    FakeDevice device = new FakeDevice();
    FakeContext context = new FakeContext(device);
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), descriptor -> decodedMesh(false));
    PreparedAvatarResources resources = backend.prepare(descriptor("imported"));

    backend.dispose(resources);
    backend.dispose(resources);
    AvatarFrameResult result = backend.renderFrame(resources, state(), context);

    assertFalse(result.successful());
    assertEquals("AVATAR_GPU_RESOURCE_RELEASED", result.errorCode());
    assertEquals(0, device.uploadCount);
    assertEquals(0, device.closeCount);
  }

  @Test
  void uploadedResourcesAreReleasedExactlyOnce() throws Exception {
    FakeDevice device = new FakeDevice();
    FakeContext context = new FakeContext(device);
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), descriptor -> decodedMesh(true));
    PreparedAvatarResources resources = backend.prepare(descriptor("builtin"));
    assertTrue(backend.renderFrame(resources, state(), context).successful());

    backend.dispose(resources);
    backend.dispose(resources);

    assertEquals(1, device.closeCount);
    assertTrue(context.frame.whiteLilyArmorEnabled());
  }

  @Test
  void reportsShaderCompilationFailureWithAStableShaderErrorCode() throws Exception {
    FakeDevice device = new FakeDevice();
    device.uploadFailure = new AvatarGpuResources.ShaderUnavailableException("compile failed");
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), descriptor -> decodedMesh(false));

    AvatarFrameResult result =
        backend.renderFrame(
            backend.prepare(descriptor("imported")), state(), new FakeContext(device));

    assertFalse(result.successful());
    assertEquals("AVATAR_SHADER_FAILED", result.errorCode());
  }

  @Test
  void negotiatedFallbackChangesTheSubmittedFrameMaterialAndLowDetailSampling() throws Exception {
    FakeDevice device = new FakeDevice();
    device.uploadFailure = new AvatarGpuResources.ShaderUnavailableException("compile failed");
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), descriptor -> decodedMesh(false));
    PreparedAvatarResources resources = backend.prepare(descriptor("imported"));

    assertEquals(
        "AVATAR_SHADER_FAILED", backend.renderFrame(resources, state(), new FakeContext(device)).errorCode());
    device.uploadFailure = null;
    FakeContext celContext = new FakeContext(device);
    assertTrue(backend.renderFrame(resources, state(), celContext).successful());
    assertTrue(celContext.frame.basicCelMaterial());
    assertEquals(0.0f, AvatarGpuResources.advancedMaterial(celContext.frame));

    FakeContext lowContext = new FakeContext(device);
    assertTrue(backend.renderFrame(resources, stateAtDistance(20.0f), lowContext).successful());
    assertEquals(1.0f, AvatarGpuResources.lowDetailSampling(lowContext.frame));
  }

  @Test
  void builtinHighModelsDoNotLoadAnUnverifiedSiblingLowResource() throws Exception {
    List<String> loadedPaths = new java.util.ArrayList<>();
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(
            Path.of("C:/WhiteLily"),
            descriptor -> {
              loadedPaths.add(descriptor.resourcePath());
              return decodedMesh(false);
            });

    backend.prepare(descriptor("builtin"));

    assertEquals(
        List.of("builtin/whitelily-hd/high.glb"), loadedPaths);
  }

  @Test
  void sameStyleLowForcesLowDetailAfterFailuresEvenWhenTheObserverIsNear() throws Exception {
    FakeDevice device = new FakeDevice();
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), descriptor -> decodedMesh(false));
    PreparedAvatarResources resources = backend.prepare(descriptor("imported"));
    device.uploadFailure = new AvatarGpuResources.ShaderUnavailableException("first");
    assertEquals("AVATAR_SHADER_FAILED", backend.renderFrame(resources, state(), new FakeContext(device)).errorCode());
    device.uploadFailure = new AvatarGpuResources.ShaderUnavailableException("second");
    assertEquals("AVATAR_SHADER_FAILED", backend.renderFrame(resources, state(), new FakeContext(device)).errorCode());
    device.uploadFailure = null;
    FakeContext low = new FakeContext(device);

    assertTrue(backend.renderFrame(resources, state(), low).successful());
    assertEquals(
        io.github.whitelily.avatar.render.quality.AvatarDetailSelector.AvatarDetailLevel.LOW,
        low.frame.detailLevel());
    assertEquals(1.0f, AvatarGpuResources.lowDetailSampling(low.frame));
  }

  @Test
  void disabledSecondaryDynamicsChangesTheProducedAnimatedPose() throws Exception {
    FakeDevice highDevice = new FakeDevice();
    SmoothMeshRenderBackend highBackend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), descriptor -> decodedMesh(false));
    PreparedAvatarResources highResources = highBackend.prepare(descriptor("imported"));
    FakeContext high = new FakeContext(highDevice);
    assertTrue(highBackend.renderFrame(highResources, state(7.0f), high).successful());

    FakeDevice fallbackDevice = new FakeDevice();
    SmoothMeshRenderBackend fallbackBackend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), descriptor -> decodedMesh(false));
    PreparedAvatarResources fallbackResources = fallbackBackend.prepare(descriptor("imported"));
    fallbackDevice.uploadFailure = new AvatarGpuResources.ShaderUnavailableException("first");
    fallbackBackend.renderFrame(fallbackResources, state(7.0f), new FakeContext(fallbackDevice));
    fallbackDevice.uploadFailure = null;
    FakeContext fallback = new FakeContext(fallbackDevice);
    assertTrue(fallbackBackend.renderFrame(fallbackResources, state(7.0f), fallback).successful());

    assertFalse(
        high.frame
            .pose()
            .bone("rightUpperArm")
            .equals(fallback.frame.pose().bone("rightUpperArm"), 0.0001f));
    assertEquals(0.0f, AvatarGpuResources.opaqueTransparency(high.frame));
    assertEquals(1.0f, AvatarGpuResources.opaqueTransparency(fallback.frame));
    assertEquals(List.of(0, 1), AvatarGpuResources.drawOrder(fallback.frame, 2));
  }

  @Test
  void invalidDescriptorUsesTheStableAssetValidationDiagnosticCode() {
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), descriptor -> decodedMesh(false));
    AvatarRuntimeDescriptor invalid =
        new AvatarRuntimeDescriptor(
            "user:model", "imported", "obj", "models/model.obj", "a".repeat(64), Map.of(), "other", "full");

    AvatarRenderException error = assertThrows(AvatarRenderException.class, () -> backend.prepare(invalid));

    assertEquals("AVATAR_ASSET_VALIDATION_FAILED", error.code());
  }

  @Test
  void animationAdvancesWithEntityAgeInsteadOfRenderSessionEpoch() throws Exception {
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), descriptor -> decodedMesh(false));
    PreparedAvatarResources resources = backend.prepare(descriptor("imported"));
    FakeContext first = new FakeContext(new FakeDevice());
    FakeContext second = new FakeContext(new FakeDevice());

    assertTrue(backend.renderFrame(resources, state(0.0f), first).successful());
    assertTrue(backend.renderFrame(resources, state(10.0f), second).successful());

    assertFalse(
        first.frame
            .pose()
            .bone("rightUpperArm")
            .equals(second.frame.pose().bone("rightUpperArm"), 0.0001f));
  }

  @Test
  void fallibleMeshPreparationCompletesBeforeAnyFrameSubmission() throws Exception {
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(Path.of("C:/WhiteLily"), descriptor -> decodedMesh(false));
    FakeContext context = new FakeContext(new FakeDevice());
    context.prepareFailure = new IllegalStateException("late mesh failure");

    AvatarFrameResult result =
        backend.renderFrame(backend.prepare(descriptor("imported")), state(1.0f), context);

    assertFalse(result.successful());
    assertEquals(1, context.prepareCalls);
    assertEquals(0, context.renderCalls);
    assertEquals(null, context.frame);
  }

  @Test
  void bestEffortCleanupClosesEveryResourceAndAggregatesFailures() {
    int[] closed = new int[3];
    AutoCloseable first = () -> { closed[0]++; throw new IllegalStateException("first"); };
    AutoCloseable second = () -> closed[1]++;
    AutoCloseable third = () -> { closed[2]++; throw new IllegalArgumentException("third"); };

    RuntimeException failure =
        assertThrows(
            RuntimeException.class,
            () -> AvatarGpuResources.closeAllBestEffort(List.of(first, second, third)));

    assertEquals(List.of(1, 1, 1), List.of(closed[0], closed[1], closed[2]));
    assertEquals(1, failure.getSuppressed().length);
  }

  @Test
  void meshNodeTransformIsRemovedFromJointPaletteBeforeModelTransform() {
    GlbMeshDecoder.GlbMesh mesh = decodedMesh(false);
    GlbMeshDecoder.GlbPrimitive source = mesh.primitives().getFirst();
    GlbMeshDecoder.GlbPrimitive transformed =
        new GlbMeshDecoder.GlbPrimitive(
            source.positions(),
            source.normals(),
            source.texCoords(),
            source.joints(),
            source.weights(),
            source.indices(),
            source.vertexCount(),
            source.indexCount(),
            source.indexComponentType(),
            source.materialIndex(),
            new Matrix4f().translation(2.0f, 0.0f, 0.0f),
            source.jointPalette());
    HumanoidAnimator.AvatarPose pose =
        new HumanoidAnimator().evaluate(state(), mesh.skeleton(), 0.0f);

    Matrix4f palette = AvatarGpuResources.paletteMatrices(transformed, pose).getFirst();

    assertEquals(-2.0f, palette.m30(), 0.0001f);
  }

  @Test
  void heldItemFailureRollsBackTheDiscardableTargetBeforeMainComposition() {
    String[] main = {"original"};
    String[] staged = {null};
    AvatarGpuResources.DrawTransaction transaction =
        new AvatarGpuResources.DrawTransaction() {
          @Override
          public void begin() {
            staged[0] = main[0];
          }

          @Override
          public void rollback() {
            staged[0] = null;
          }

          @Override
          public void compose() {
            main[0] = staged[0];
          }
        };

    assertThrows(
        IllegalStateException.class,
        () ->
            AvatarGpuResources.commitDiscardable(
                transaction,
                () -> staged[0] = "mesh",
                () -> {
                  staged[0] = "held-item";
                  throw new IllegalStateException("item upload failed");
                }));

    assertEquals("original", main[0]);
    assertEquals(null, staged[0]);
  }

  @Test
  void indexAllocationErrorClosesTheUnregisteredVertexBufferAndRethrowsOriginal() {
    int[] closed = {0};
    AutoCloseable vertices = () -> closed[0]++;
    LinkageError marker = new LinkageError("index device linkage failed");

    LinkageError thrown =
        assertThrows(
            LinkageError.class,
            () ->
                AvatarGpuResources.createAfterAllocated(
                    vertices,
                    () -> {
                      throw marker;
                    }));

    assertSame(marker, thrown);
    assertEquals(1, closed[0]);
  }

  @Test
  void cancelledDecodeYieldsTheBoundedWorkerToTheNextPrepare() throws Exception {
    AtomicInteger calls = new AtomicInteger();
    CountDownLatch firstStarted = new CountDownLatch(1);
    SmoothMeshRenderBackend backend =
        new SmoothMeshRenderBackend(
            Path.of("C:/WhiteLily"),
            descriptor -> {
              if (calls.getAndIncrement() == 0) {
                firstStarted.countDown();
                while (true) GlbDocumentReader.cancellationCheckpoint();
              }
              return decodedMesh(false);
            });
    AvatarRenderBackendRegistry registry =
        new AvatarRenderBackendRegistry(Map.of("glb", backend), ignored -> {});
    try {
      var first = registry.prepare(descriptor("imported")).toCompletableFuture();
      assertTrue(firstStarted.await(2, TimeUnit.SECONDS));
      assertTrue(first.cancel(true));

      var second =
          registry
              .prepare(descriptor("imported"))
              .toCompletableFuture()
              .get(2, TimeUnit.SECONDS);

      assertNotNull(second);
    } finally {
      registry.close();
    }
  }

  private static AvatarRuntimeDescriptor descriptor(String origin) {
    return new AvatarRuntimeDescriptor(
        origin.equals("builtin")
            ? "builtin:whitelily-hd"
            : "user:00000000-0000-4000-8000-000000000001",
        origin,
        origin.equals("builtin") ? "builtin-hd" : "glb",
        origin.equals("builtin")
            ? "builtin/whitelily-hd/high.glb"
            : "models/00000000-0000-4000-8000-000000000001/model.glb",
        "a".repeat(64),
        semanticNames(),
        "whitelily-humanoid-v1",
        origin.equals("builtin") ? "full" : "neutral-only");
  }

  private static Map<String, String> semanticNames() {
    return Map.ofEntries(
        Map.entry("hips", "Hips"),
        Map.entry("chest", "Chest"),
        Map.entry("neck", "Neck"),
        Map.entry("head", "Head"),
        Map.entry("leftUpperArm", "LeftUpperArm"),
        Map.entry("leftLowerArm", "LeftLowerArm"),
        Map.entry("leftHand", "LeftHand"),
        Map.entry("rightUpperArm", "RightUpperArm"),
        Map.entry("rightLowerArm", "RightLowerArm"),
        Map.entry("rightHand", "RightHand"),
        Map.entry("leftUpperLeg", "LeftUpperLeg"),
        Map.entry("leftLowerLeg", "LeftLowerLeg"),
        Map.entry("leftFoot", "LeftFoot"),
        Map.entry("rightUpperLeg", "RightUpperLeg"),
        Map.entry("rightLowerLeg", "RightLowerLeg"),
        Map.entry("rightFoot", "RightFoot"));
  }

  private static GlbMeshDecoder.GlbMesh decodedMesh(boolean fullExpressions) {
    Map<String, Matrix4f> bind = new java.util.LinkedHashMap<>();
    for (String semantic : semanticNames().keySet()) bind.put(semantic, new Matrix4f());
    bind.put("leftHand", new Matrix4f().translation(0.5f, 1, 0));
    bind.put("rightHand", new Matrix4f().translation(-0.5f, 1, 0));
    HumanoidSkeleton skeleton = HumanoidSkeleton.fromSemanticBindPose(bind, fullExpressions);
    ByteBuffer positions = directFloats(0, 0, 0, 1, 0, 0, 0, 1, 0);
    ByteBuffer normals = directFloats(0, 0, 1, 0, 0, 1, 0, 0, 1);
    ByteBuffer texCoords = directFloats(0, 0, 1, 0, 0, 1);
    ByteBuffer joints = ByteBuffer.allocateDirect(24);
    ByteBuffer weights = directFloats(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0);
    ByteBuffer indices = ByteBuffer.allocateDirect(6);
    return new GlbMeshDecoder.GlbMesh(
        List.of(
            new GlbMeshDecoder.GlbPrimitive(
                positions, normals, texCoords, joints, weights, indices, 3, 3, 5123, -1)),
        skeleton,
        List.of(),
        "a".repeat(64));
  }

  private static ByteBuffer directFloats(float... values) {
    ByteBuffer buffer = ByteBuffer.allocateDirect(values.length * Float.BYTES);
    for (float value : values) buffer.putFloat(value);
    return buffer.flip();
  }

  private static AvatarVisualState state() {
    return state(4.0f);
  }

  private static AvatarVisualState state(float animationTick) {
    return new AvatarVisualState(
        1,
        "world-backend",
        0,
        64,
        0,
        0,
        0,
        "standing",
        0.5f,
        animationTick,
        ArmorTheme.DIAMOND,
        "minecraft:iron_pickaxe",
        "minecraft:torch",
        true,
        false,
        false,
        false,
        false,
        true,
        "neutral",
        4,
        new AvatarVisualState.GraphicsCapabilities(true, true, 128));
  }

  private static AvatarVisualState stateAtDistance(float observerDistance) {
    AvatarVisualState base = state();
    return new AvatarVisualState(
        base.renderSessionEpoch(),
        base.worldSessionId(),
        base.x(),
        base.y(),
        base.z(),
        base.bodyYaw(),
        base.headPitch(),
        base.minecraftPose(),
        base.partialTick(),
        base.animationTick(),
        base.armorTheme(),
        base.mainHandItem(),
        base.offHandItem(),
        base.moving(),
        base.swimming(),
        base.sleeping(),
        base.hurt(),
        base.speaking(),
        base.working(),
        base.expression(),
        observerDistance,
        base.graphics());
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
    private RuntimeException prepareFailure;
    private int prepareCalls;
    private int renderCalls;

    private FakeContext(FakeDevice device) {
      this.device = device;
    }

    @Override
    public FrameTransaction beginFrame() {
      return new FrameTransaction() {
        @Override
        public void commit() {}

        @Override
        public void restore() {}
      };
    }

    @Override
    public void renderClassic() {}

    @Override
    public AvatarGpuResources.Device avatarGpuDevice() {
      return device;
    }

    @Override
    public void prepareSmooth(SmoothMeshRenderBackend.SmoothMeshFrame frame) {
      prepareCalls++;
      if (prepareFailure != null) throw prepareFailure;
    }

    @Override
    public void renderSmooth(SmoothMeshRenderBackend.SmoothMeshFrame frame) {
      renderCalls++;
      this.frame = frame;
    }
  }
}
