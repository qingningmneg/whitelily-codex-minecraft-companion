package io.github.whitelily.avatar.render.gltf;

import com.mojang.blaze3d.buffers.BufferType;
import com.mojang.blaze3d.buffers.BufferUsage;
import com.mojang.blaze3d.buffers.GpuBuffer;
import com.mojang.blaze3d.pipeline.RenderPipeline;
import com.mojang.blaze3d.pipeline.RenderTarget;
import com.mojang.blaze3d.pipeline.TextureTarget;
import com.mojang.blaze3d.pipeline.BlendFunction;
import com.mojang.blaze3d.platform.DepthTestFunction;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.shaders.UniformType;
import com.mojang.blaze3d.systems.GpuDevice;
import com.mojang.blaze3d.systems.RenderPass;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.VertexFormat;
import com.mojang.blaze3d.vertex.VertexFormatElement;
import io.github.whitelily.avatar.mixin.RenderTargetAccessor;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.OptionalDouble;
import java.util.OptionalInt;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.resources.ResourceLocation;
import org.joml.Matrix4f;

public final class AvatarGpuResources implements AutoCloseable {
  public static final int MAX_SHADER_JOINTS = 128;
  private static final int VERTEX_BYTES = 56;
  private static final long MAX_INTERLEAVED_BYTES = 256L * 1024 * 1024;
  private static final VertexFormatElement SMOOTH_NORMAL =
      VertexFormatElement.register(
          28,
          0,
          VertexFormatElement.Type.FLOAT,
          VertexFormatElement.Usage.NORMAL,
          3);
  private static final VertexFormatElement SMOOTH_JOINTS =
      VertexFormatElement.register(
          29,
          0,
          VertexFormatElement.Type.USHORT,
          VertexFormatElement.Usage.GENERIC,
          4);
  private static final VertexFormatElement SMOOTH_WEIGHTS =
      VertexFormatElement.register(
          30,
          0,
          VertexFormatElement.Type.FLOAT,
          VertexFormatElement.Usage.GENERIC,
          4);
  private static final VertexFormat SKINNING_VERTEX_FORMAT =
      VertexFormat.builder()
          .add("Position", VertexFormatElement.POSITION)
          .add("Normal", SMOOTH_NORMAL)
          .add("UV0", VertexFormatElement.UV0)
          .add("Joints", SMOOTH_JOINTS)
          .add("Weights", SMOOTH_WEIGHTS)
          .build();
  private static final RenderPipeline SKINNING_PIPELINE = createSkinningPipeline();

  private final GlbMeshDecoder.GlbMesh mesh;
  private Allocation allocation;
  private boolean disposed;

  public AvatarGpuResources(GlbMeshDecoder.GlbMesh mesh) {
    this.mesh = Objects.requireNonNull(mesh, "mesh");
  }

  public synchronized Allocation ensureUploaded(Device device) throws Exception {
    Objects.requireNonNull(device, "device");
    if (disposed) throw new ResourceReleasedException();
    if (allocation == null) {
      Allocation uploaded = Objects.requireNonNull(device.upload(mesh), "uploaded allocation");
      if (disposed) {
        uploaded.close();
        throw new ResourceReleasedException();
      }
      allocation = uploaded;
    }
    return allocation;
  }

  public GlbMeshDecoder.GlbMesh mesh() {
    return mesh;
  }

  public static RenderPipeline skinningPipeline() {
    return SKINNING_PIPELINE;
  }

  public static Device minecraftDevice() {
    return MinecraftDevice.INSTANCE;
  }

  public static void renderMinecraft(
      SmoothMeshRenderBackend.SmoothMeshFrame frame,
      Matrix4f modelMatrix,
      Runnable heldItemDraw) {
    Objects.requireNonNull(frame, "frame");
    Objects.requireNonNull(modelMatrix, "modelMatrix");
    Objects.requireNonNull(heldItemDraw, "heldItemDraw");
    if (!(frame.allocation() instanceof MinecraftAllocation allocation)) {
      throw new IllegalArgumentException("avatar allocation belongs to another GPU device");
    }
    RenderTarget main = Minecraft.getInstance().getMainRenderTarget();
    TextureTarget staged =
        new TextureTarget(
            "WhiteLily avatar staged frame",
            main.width,
            main.height,
            main.getDepthTexture() != null);
    try {
      commitDiscardable(
          new MinecraftDrawTransaction(main, staged),
          () -> allocation.render(frame, modelMatrix, main),
          heldItemDraw);
    } finally {
      staged.destroyBuffers();
    }
  }

  private static final class MinecraftDrawTransaction implements DrawTransaction {
    private final RenderTarget main;
    private final TextureTarget staged;
    private final com.mojang.blaze3d.textures.GpuTexture originalColor;
    private final com.mojang.blaze3d.textures.GpuTexture originalDepth;
    private boolean swapped;

    private MinecraftDrawTransaction(RenderTarget main, TextureTarget staged) {
      this.main = main;
      this.staged = staged;
      this.originalColor = main.getColorTexture();
      this.originalDepth = main.getDepthTexture();
    }

    @Override
    public void begin() {
      main.blitAndBlendToTexture(staged.getColorTexture());
      if (originalDepth != null) staged.copyDepthFrom(main);
      RenderTargetAccessor accessor = (RenderTargetAccessor) main;
      accessor.whitelily$setColorTexture(staged.getColorTexture());
      accessor.whitelily$setDepthTexture(staged.getDepthTexture());
      swapped = true;
    }

    @Override
    public void rollback() {
      restoreMainTextures();
    }

    @Override
    public void compose() {
      restoreMainTextures();
      staged.blitAndBlendToTexture(originalColor);
      if (originalDepth != null) main.copyDepthFrom(staged);
    }

    private void restoreMainTextures() {
      if (!swapped) return;
      RenderTargetAccessor accessor = (RenderTargetAccessor) main;
      accessor.whitelily$setColorTexture(originalColor);
      accessor.whitelily$setDepthTexture(originalDepth);
      swapped = false;
    }
  }

  static List<Matrix4f> paletteMatrices(
      GlbMeshDecoder.GlbPrimitive primitive, HumanoidAnimator.AvatarPose pose) {
    Objects.requireNonNull(primitive, "primitive");
    Objects.requireNonNull(pose, "pose");
    return paletteMatrices(
        primitive.nodeTransform(), primitive.jointPalette(), pose.jointMatrices());
  }

  private static List<Matrix4f> paletteMatrices(
      Matrix4f nodeTransform,
      List<Integer> jointPalette,
      List<Matrix4f> global) {
    Matrix4f inverseMesh = new Matrix4f(nodeTransform).invert();
    List<Matrix4f> local = new ArrayList<>(jointPalette.size());
    for (int joint : jointPalette) {
      if (joint < 0 || joint >= global.size()) {
        throw new IllegalArgumentException("avatar draw palette is invalid");
      }
      local.add(new Matrix4f(inverseMesh).mul(global.get(joint)));
    }
    return List.copyOf(local);
  }

  interface DrawTransaction {
    void begin();

    void rollback();

    void compose();
  }

  static void commitDiscardable(
      DrawTransaction transaction, Runnable meshDraw, Runnable itemDraw) {
    Objects.requireNonNull(transaction, "transaction");
    try {
      transaction.begin();
      Objects.requireNonNull(meshDraw, "meshDraw").run();
      Objects.requireNonNull(itemDraw, "itemDraw").run();
      transaction.compose();
    } catch (Throwable failure) {
      try {
        transaction.rollback();
      } catch (Throwable cleanupFailure) {
        if (cleanupFailure != failure) failure.addSuppressed(cleanupFailure);
      }
      throwUnchecked(failure);
    }
  }

  static <T> T createAfterAllocated(
      AutoCloseable alreadyAllocated, Supplier<T> nextAllocation) {
    Objects.requireNonNull(alreadyAllocated, "alreadyAllocated");
    Objects.requireNonNull(nextAllocation, "nextAllocation");
    try {
      return nextAllocation.get();
    } catch (Throwable failure) {
      try {
        alreadyAllocated.close();
      } catch (Throwable cleanupFailure) {
        if (cleanupFailure != failure) failure.addSuppressed(cleanupFailure);
      }
      return throwUnchecked(failure);
    }
  }

  @SuppressWarnings("unchecked")
  private static <T, E extends Throwable> T throwUnchecked(Throwable failure) throws E {
    throw (E) failure;
  }

  public synchronized void prepareFrame(SmoothMeshRenderBackend.SmoothMeshFrame frame) {
    if (disposed || allocation == null || frame.allocation() != allocation) {
      throw new ResourceReleasedException();
    }
    allocation.prepareFrame(mesh, frame.pose());
  }

  public synchronized boolean uploaded() {
    return allocation != null;
  }

  public synchronized boolean disposed() {
    return disposed;
  }

  @Override
  public synchronized void close() {
    if (disposed) return;
    disposed = true;
    Allocation owned = allocation;
    allocation = null;
    if (owned != null) owned.close();
  }

  @FunctionalInterface
  public interface Device {
    Allocation upload(GlbMeshDecoder.GlbMesh mesh) throws Exception;
  }

  @FunctionalInterface
  public interface Allocation extends AutoCloseable {
    default void prepareFrame(
        GlbMeshDecoder.GlbMesh mesh, HumanoidAnimator.AvatarPose pose) {}

    @Override
    void close();
  }

  static void closeAllBestEffort(List<? extends AutoCloseable> resources) {
    RuntimeException failure = null;
    for (AutoCloseable resource : resources) {
      try {
        if (resource != null) resource.close();
      } catch (Throwable error) {
        RuntimeException next =
            error instanceof RuntimeException runtime
                ? runtime
                : new RuntimeException("avatar resource cleanup failed", error);
        if (failure == null) failure = next;
        else failure.addSuppressed(next);
      }
    }
    if (failure != null) throw failure;
  }

  public static final class ResourceReleasedException extends IllegalStateException {
    private ResourceReleasedException() {
      super("avatar GPU resources were released");
    }
  }

  public static final class ShaderUnavailableException extends RuntimeException {
    public ShaderUnavailableException(String message) {
      super(message);
    }
  }

  private static RenderPipeline createSkinningPipeline() {
    ResourceLocation shader =
        ResourceLocation.fromNamespaceAndPath("whitelily_avatar", "avatar_skinning");
    RenderPipeline.Builder builder =
        RenderPipeline.builder()
            .withLocation(
                ResourceLocation.fromNamespaceAndPath(
                    "whitelily_avatar", "pipeline/avatar_skinning"))
            .withVertexShader(shader)
            .withFragmentShader(shader)
            .withSampler("Sampler0")
            .withUniform("ModelMat", UniformType.MATRIX4X4)
            .withUniform("ViewMat", UniformType.MATRIX4X4)
            .withUniform("ProjMat", UniformType.MATRIX4X4)
            .withUniform("AdvancedMaterial", UniformType.FLOAT)
            .withUniform("LowDetail", UniformType.FLOAT)
            .withUniform("OpaqueTransparency", UniformType.FLOAT)
            .withDepthTestFunction(DepthTestFunction.LEQUAL_DEPTH_TEST)
            .withBlend(BlendFunction.TRANSLUCENT)
            .withDepthWrite(true)
            .withCull(false)
            .withVertexFormat(SKINNING_VERTEX_FORMAT, VertexFormat.Mode.TRIANGLES);
    for (int joint = 0; joint < MAX_SHADER_JOINTS; joint++) {
      builder.withUniform("JointMatrices[" + joint + "]", UniformType.MATRIX4X4);
    }
    return builder.build();
  }

  private enum MinecraftDevice implements Device {
    INSTANCE;

    @Override
    public Allocation upload(GlbMeshDecoder.GlbMesh mesh) throws Exception {
      RenderSystem.assertOnRenderThread();
      return new MinecraftAllocation(mesh);
    }
  }

  private static final class MinecraftAllocation implements Allocation {
    private final List<PrimitiveAllocation> primitives = new ArrayList<>();
    private final List<GeometryAllocation> geometries = new ArrayList<>();
    private final List<DynamicTexture> textures = new ArrayList<>();
    private final DynamicTexture whiteTexture;
    private final AtomicBoolean closed = new AtomicBoolean();

    private MinecraftAllocation(GlbMeshDecoder.GlbMesh mesh) throws IOException {
      GpuDevice device = RenderSystem.getDevice();
      if (!device
          .precompilePipeline(
              SKINNING_PIPELINE,
              Minecraft.getInstance().getShaderManager()::getShader)
          .isValid()) {
        throw new ShaderUnavailableException("avatar skinning shader is unavailable");
      }
      DynamicTexture fallback = null;
      try {
        Map<Object, GeometryAllocation> geometryByKey = new IdentityHashMap<>();
        long interleavedBytes = 0;
        for (int index = 0; index < mesh.primitives().size(); index++) {
          int allocationIndex = index;
          GlbMeshDecoder.GlbPrimitive primitive = mesh.primitives().get(index);
          GeometryAllocation geometry = geometryByKey.get(primitive.geometryKey());
          if (geometry == null) {
            long geometryBytes =
                Math.addExact(
                    Math.multiplyExact((long) primitive.vertexCount(), VERTEX_BYTES),
                    primitive.indices().remaining());
            if (interleavedBytes > MAX_INTERLEAVED_BYTES - geometryBytes) {
              throw new IOException("avatar interleaved data exceeds the memory budget");
            }
            interleavedBytes += geometryBytes;
            GpuBuffer vertices =
                device.createBuffer(
                    () -> "WhiteLily avatar vertices " + allocationIndex,
                    BufferType.VERTICES,
                    BufferUsage.STATIC_WRITE,
                    interleave(primitive));
            GpuBuffer indices =
                createAfterAllocated(
                    vertices,
                    () ->
                        device.createBuffer(
                            () -> "WhiteLily avatar indices " + allocationIndex,
                            BufferType.INDICES,
                            BufferUsage.STATIC_WRITE,
                            primitive.indices()));
            geometry = new GeometryAllocation(vertices, indices);
            geometryByKey.put(primitive.geometryKey(), geometry);
            geometries.add(geometry);
          }
          primitives.add(
              new PrimitiveAllocation(
                  geometry,
                  primitive.indexCount(),
                  primitive.indexComponentType() == 5123
                      ? VertexFormat.IndexType.SHORT
                      : VertexFormat.IndexType.INT,
                  primitive.materialIndex(),
                  primitive.nodeTransform(),
                  primitive.jointPalette()));
        }
        int maximumTextureSize = device.getMaxTextureSize();
        for (int index = 0; index < mesh.images().size(); index++) {
          int textureIndex = index;
          GlbMeshDecoder.GlbImage image = mesh.images().get(index);
          NativeImage decoded = null;
          DynamicTexture texture = null;
          try {
            decoded = NativeImage.read(image.encoded());
            if (decoded.getWidth() != image.width()
                || decoded.getHeight() != image.height()
                || decoded.getWidth() > maximumTextureSize
                || decoded.getHeight() > maximumTextureSize) {
              throw new IOException("avatar texture dimensions are invalid");
            }
            texture =
                new DynamicTexture(() -> "WhiteLily avatar texture " + textureIndex, decoded);
            decoded = null;
            texture.upload();
            textures.add(texture);
            texture = null;
          } finally {
            if (texture != null) texture.close();
            if (decoded != null) decoded.close();
          }
        }
        NativeImage white = new NativeImage(1, 1, false);
        try {
          white.setPixelABGR(0, 0, 0xffffffff);
          fallback = new DynamicTexture(() -> "WhiteLily avatar fallback texture", white);
          white = null;
          fallback.upload();
          whiteTexture = fallback;
        } finally {
          if (white != null) white.close();
        }
      } catch (IOException | RuntimeException | LinkageError error) {
        List<AutoCloseable> cleanup = new ArrayList<>();
        cleanup.add(this::closeAll);
        if (fallback != null) cleanup.add(fallback);
        try {
          closeAllBestEffort(cleanup);
        } catch (RuntimeException cleanupFailure) {
          error.addSuppressed(cleanupFailure);
        }
        throw error;
      }
    }

    private void render(
        SmoothMeshRenderBackend.SmoothMeshFrame frame,
        Matrix4f modelMatrix,
        RenderTarget target) {
      if (closed.get()) throw new ResourceReleasedException();
      RenderSystem.assertOnRenderThread();
      RenderPass pass =
          target.getDepthTexture() == null
              ? RenderSystem.getDevice()
                  .createCommandEncoder()
                  .createRenderPass(target.getColorTexture(), OptionalInt.empty())
              : RenderSystem.getDevice()
                  .createCommandEncoder()
                  .createRenderPass(
                      target.getColorTexture(),
                      OptionalInt.empty(),
                      target.getDepthTexture(),
                      OptionalDouble.empty());
      try (pass) {
        pass.setPipeline(SKINNING_PIPELINE);
        pass.setUniform("ViewMat", RenderSystem.getModelViewMatrix());
        pass.setUniform("ProjMat", RenderSystem.getProjectionMatrix());
        pass.setUniform("AdvancedMaterial", advancedMaterial(frame));
        pass.setUniform("LowDetail", lowDetailSampling(frame));
        pass.setUniform("OpaqueTransparency", opaqueTransparency(frame));
        Matrix4f identity = new Matrix4f();
        List<Matrix4f> globalJoints = frame.pose().jointMatrices();
        for (int primitiveIndex : drawOrder(frame, primitives.size())) {
          PrimitiveAllocation primitive = primitives.get(primitiveIndex);
          List<Matrix4f> joints =
              paletteMatrices(
                  primitive.nodeTransform(), primitive.jointPalette(), globalJoints);
          pass.setUniform(
              "ModelMat", new Matrix4f(modelMatrix).mul(primitive.nodeTransform()));
          for (int joint = 0; joint < MAX_SHADER_JOINTS; joint++) {
            pass.setUniform(
                "JointMatrices[" + joint + "]",
                joint < joints.size() ? joints.get(joint) : identity);
          }
          DynamicTexture texture =
              primitive.materialIndex() >= 0 && primitive.materialIndex() < textures.size()
                  ? textures.get(primitive.materialIndex())
                  : whiteTexture;
          pass.bindSampler("Sampler0", texture.getTexture());
          pass.setVertexBuffer(0, primitive.geometry().vertices());
          pass.setIndexBuffer(primitive.geometry().indices(), primitive.indexType());
          pass.drawIndexed(0, primitive.indexCount());
        }
      }
    }


    @Override
    public void prepareFrame(
        GlbMeshDecoder.GlbMesh mesh, HumanoidAnimator.AvatarPose pose) {
      if (closed.get()) throw new ResourceReleasedException();
      List<Matrix4f> joints = pose.jointMatrices();
      for (GlbMeshDecoder.GlbPrimitive primitive : mesh.primitives()) {
        for (int joint : primitive.jointPalette()) {
          if (joint < 0 || joint >= joints.size()) {
            throw new IllegalArgumentException("avatar draw palette is invalid");
          }
        }
      }
    }

    @Override
    public void close() {
      if (!closed.compareAndSet(false, true)) return;
      closeAllBestEffort(List.of((AutoCloseable) this::closeAll, whiteTexture));
    }

    private void closeAll() {
      List<AutoCloseable> owned = new ArrayList<>(geometries);
      owned.addAll(textures);
      primitives.clear();
      geometries.clear();
      textures.clear();
      closeAllBestEffort(owned);
    }
  }

  static float advancedMaterial(SmoothMeshRenderBackend.SmoothMeshFrame frame) {
    return frame.basicCelMaterial() ? 0.0f : 1.0f;
  }

  static float lowDetailSampling(SmoothMeshRenderBackend.SmoothMeshFrame frame) {
    return frame.detailLevel() == io.github.whitelily.avatar.render.quality.AvatarDetailSelector.AvatarDetailLevel.LOW
        ? 1.0f
        : 0.0f;
  }

  static float opaqueTransparency(SmoothMeshRenderBackend.SmoothMeshFrame frame) {
    return frame.nonessentialTransparencyEnabled() ? 0.0f : 1.0f;
  }

  static List<Integer> drawOrder(SmoothMeshRenderBackend.SmoothMeshFrame frame, int primitiveCount) {
    Objects.requireNonNull(frame, "frame");
    if (primitiveCount < 0) throw new IllegalArgumentException("primitiveCount must not be negative");
    List<Integer> order = new ArrayList<>(primitiveCount);
    for (int primitive = 0; primitive < primitiveCount; primitive++) order.add(primitive);
    return List.copyOf(order);
  }

  private record PrimitiveAllocation(
      GeometryAllocation geometry,
      int indexCount,
      VertexFormat.IndexType indexType,
      int materialIndex,
      Matrix4f nodeTransform,
      List<Integer> jointPalette) {
    private PrimitiveAllocation {
      nodeTransform = new Matrix4f(nodeTransform);
      jointPalette = List.copyOf(jointPalette);
    }
  }

  private record GeometryAllocation(GpuBuffer vertices, GpuBuffer indices)
      implements AutoCloseable {
    @Override
    public void close() {
      closeAllBestEffort(List.of(vertices, indices));
    }
  }

  private static ByteBuffer interleave(GlbMeshDecoder.GlbPrimitive primitive) {
    ByteBuffer positions = primitive.positions().order(ByteOrder.LITTLE_ENDIAN);
    ByteBuffer normals = primitive.normals().order(ByteOrder.LITTLE_ENDIAN);
    ByteBuffer texCoords = primitive.texCoords().order(ByteOrder.LITTLE_ENDIAN);
    ByteBuffer joints = primitive.joints().order(ByteOrder.LITTLE_ENDIAN);
    ByteBuffer weights = primitive.weights().order(ByteOrder.LITTLE_ENDIAN);
    ByteBuffer output =
        ByteBuffer.allocateDirect(primitive.vertexCount() * VERTEX_BYTES)
            .order(ByteOrder.LITTLE_ENDIAN);
    for (int vertex = 0; vertex < primitive.vertexCount(); vertex++) {
      int positionOffset = vertex * 3 * Float.BYTES;
      int texCoordOffset = vertex * 2 * Float.BYTES;
      int jointOffset = vertex * 4 * Short.BYTES;
      int weightOffset = vertex * 4 * Float.BYTES;
      for (int component = 0; component < 3; component++) {
        output.putFloat(positions.getFloat(positionOffset + component * Float.BYTES));
      }
      for (int component = 0; component < 3; component++) {
        output.putFloat(normals.getFloat(positionOffset + component * Float.BYTES));
      }
      for (int component = 0; component < 2; component++) {
        output.putFloat(texCoords.getFloat(texCoordOffset + component * Float.BYTES));
      }
      for (int component = 0; component < 4; component++) {
        output.putShort(joints.getShort(jointOffset + component * Short.BYTES));
      }
      for (int component = 0; component < 4; component++) {
        output.putFloat(weights.getFloat(weightOffset + component * Float.BYTES));
      }
    }
    return output.flip();
  }
}
