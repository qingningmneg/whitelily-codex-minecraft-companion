package io.github.whitelily.avatar.render.gltf;

import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import io.github.whitelily.avatar.render.backend.AvatarFrameResult;
import io.github.whitelily.avatar.render.backend.AvatarRenderContext;
import io.github.whitelily.avatar.render.backend.AvatarRenderException;
import io.github.whitelily.avatar.render.backend.AvatarVisualState;
import io.github.whitelily.avatar.render.backend.PreparedAvatarResources;
import io.github.whitelily.avatar.render.backend.WhiteLilyAvatarRenderBackend;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Objects;

public final class SmoothMeshRenderBackend implements WhiteLilyAvatarRenderBackend {
  private final Path dataRoot;
  private final MeshLoader loader;
  private final HumanoidAnimator animator = new HumanoidAnimator();

  public SmoothMeshRenderBackend(Path dataRoot) {
    this.dataRoot = normalizeRoot(dataRoot);
    this.loader = this::read;
  }

  SmoothMeshRenderBackend(Path dataRoot, MeshLoader loader) {
    this.dataRoot = normalizeRoot(dataRoot);
    this.loader = Objects.requireNonNull(loader, "loader");
  }

  private static Path normalizeRoot(Path dataRoot) {
    return Objects.requireNonNull(dataRoot, "dataRoot").toAbsolutePath().normalize();
  }

  @Override
  public PreparedAvatarResources prepare(AvatarRuntimeDescriptor descriptor)
      throws AvatarRenderException {
    validateDescriptor(descriptor);
    GlbMeshDecoder.GlbMesh mesh = loader.load(descriptor);
    if (!descriptor.modelId().equals(mesh.modelId()) && !mesh.modelId().equals(descriptor.sha256())) {
      throw new AvatarRenderException("AVATAR_MESH_LOAD_FAILED", "avatar mesh identity is invalid");
    }
    return new SmoothResources(
        descriptor.modelId(),
        descriptor.origin(),
        descriptor.expressions(),
        mesh,
        new AvatarGpuResources(mesh));
  }

  @Override
  public AvatarFrameResult renderFrame(
      PreparedAvatarResources resources,
      AvatarVisualState state,
      AvatarRenderContext context) {
    if (!(resources instanceof SmoothResources smooth)) {
      return AvatarFrameResult.failed("AVATAR_BACKEND_MISMATCH");
    }
    if (smooth.gpuResources().disposed()) {
      return AvatarFrameResult.failed("AVATAR_GPU_RESOURCE_RELEASED");
    }
    if (!state.graphics().shaders()
        || smooth.mesh().primitives().stream()
            .anyMatch(
                primitive ->
                    primitive.jointPalette().size()
                        > state.graphics().maximumJointMatrices())) {
      return AvatarFrameResult.failed("AVATAR_SHADER_FAILED");
    }
    try {
      AvatarGpuResources.Allocation allocation =
          smooth.gpuResources().ensureUploaded(context.avatarGpuDevice());
      HumanoidAnimator.AvatarPose pose =
          animator.evaluate(
              state,
              smooth.mesh().skeleton(),
              state.animationTick() / 20.0f);
      SmoothMeshFrame frame =
          new SmoothMeshFrame(
              smooth.modelId(),
              smooth.gpuResources(),
              allocation,
              pose,
              state,
              state.mainHandItem(),
              state.offHandItem(),
              "builtin".equals(smooth.origin()));
      context.prepareSmooth(frame);
      context.renderSmooth(frame);
      return AvatarFrameResult.complete();
    } catch (AvatarGpuResources.ResourceReleasedException error) {
      return AvatarFrameResult.failed("AVATAR_GPU_RESOURCE_RELEASED");
    } catch (AvatarGpuResources.ShaderUnavailableException error) {
      return AvatarFrameResult.failed("AVATAR_SHADER_FAILED");
    } catch (UnsupportedOperationException error) {
      return AvatarFrameResult.failed("AVATAR_SHADER_FAILED");
    } catch (Exception | LinkageError error) {
      return AvatarFrameResult.failed("AVATAR_MESH_LOAD_FAILED");
    }
  }

  @Override
  public void dispose(PreparedAvatarResources resources) {
    if (resources instanceof SmoothResources smooth) smooth.gpuResources().close();
  }

  private void validateDescriptor(AvatarRuntimeDescriptor descriptor) throws AvatarRenderException {
    if (descriptor == null
        || !java.util.Set.of("glb", "vrm", "builtin-hd").contains(descriptor.format())
        || !java.util.Set.of("builtin", "imported").contains(descriptor.origin())
        || !"whitelily-humanoid-v1".equals(descriptor.bodyAnimation())
        || !java.util.Set.of("full", "neutral-only").contains(descriptor.expressions())) {
      throw new AvatarRenderException("AVATAR_BACKEND_MISMATCH", "invalid smooth avatar descriptor");
    }
  }

  private GlbMeshDecoder.GlbMesh read(AvatarRuntimeDescriptor descriptor)
      throws AvatarRenderException {
    Path relative;
    try {
      relative = Path.of(descriptor.resourcePath());
    } catch (RuntimeException error) {
      throw new AvatarRenderException("AVATAR_MESH_LOAD_FAILED", "invalid avatar resource path", error);
    }
    if (relative.isAbsolute()) {
      throw new AvatarRenderException("AVATAR_MESH_LOAD_FAILED", "avatar resource path is absolute");
    }
    Path resolved = dataRoot.resolve(relative).normalize();
    if (!resolved.startsWith(dataRoot)
        || !Files.isRegularFile(resolved, LinkOption.NOFOLLOW_LINKS)
        || Files.isSymbolicLink(resolved)) {
      throw new AvatarRenderException("AVATAR_MESH_LOAD_FAILED", "avatar resource is unmanaged");
    }
    try {
      Path cursor = dataRoot;
      for (Path segment : dataRoot.relativize(resolved)) {
        cursor = cursor.resolve(segment);
        BasicFileAttributes attributes =
            Files.readAttributes(
                cursor, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes.isSymbolicLink() || attributes.isOther()) {
          throw new AvatarRenderException(
              "AVATAR_MESH_LOAD_FAILED", "avatar resource crosses a reparse boundary");
        }
      }
      if (!resolved.toRealPath().startsWith(dataRoot.toRealPath())) {
        throw new AvatarRenderException(
            "AVATAR_MESH_LOAD_FAILED", "avatar resource escapes the managed root");
      }
    } catch (java.io.IOException error) {
      throw new AvatarRenderException(
          "AVATAR_MESH_LOAD_FAILED", "avatar resource path could not be verified", error);
    }
    return new GlbDocumentReader()
        .read(
            resolved,
            dataRoot,
            descriptor.sha256(),
            descriptor.boneMapping(),
            "full".equals(descriptor.expressions()));
  }

  @FunctionalInterface
  interface MeshLoader {
    GlbMeshDecoder.GlbMesh load(AvatarRuntimeDescriptor descriptor) throws AvatarRenderException;
  }

  private record SmoothResources(
      String modelId,
      String origin,
      String expressions,
      GlbMeshDecoder.GlbMesh mesh,
      AvatarGpuResources gpuResources)
      implements PreparedAvatarResources {}

  public record SmoothMeshFrame(
      String modelId,
      AvatarGpuResources resources,
      AvatarGpuResources.Allocation allocation,
      HumanoidAnimator.AvatarPose pose,
      AvatarVisualState state,
      String mainHandItem,
      String offHandItem,
      boolean whiteLilyArmorEnabled) {
    public SmoothMeshFrame {
      Objects.requireNonNull(modelId, "modelId");
      Objects.requireNonNull(resources, "resources");
      Objects.requireNonNull(allocation, "allocation");
      Objects.requireNonNull(pose, "pose");
      Objects.requireNonNull(state, "state");
      Objects.requireNonNull(mainHandItem, "mainHandItem");
      Objects.requireNonNull(offHandItem, "offHandItem");
    }

    public org.joml.Matrix4f leftHand() {
      return pose.leftHand();
    }

    public org.joml.Matrix4f rightHand() {
      return pose.rightHand();
    }
  }
}
