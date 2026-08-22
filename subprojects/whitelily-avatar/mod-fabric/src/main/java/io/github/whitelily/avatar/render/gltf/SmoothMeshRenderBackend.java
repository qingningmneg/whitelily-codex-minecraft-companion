package io.github.whitelily.avatar.render.gltf;

import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import io.github.whitelily.avatar.render.backend.AvatarFrameResult;
import io.github.whitelily.avatar.render.backend.AvatarRenderContext;
import io.github.whitelily.avatar.render.backend.AvatarRenderException;
import io.github.whitelily.avatar.render.backend.AvatarVisualState;
import io.github.whitelily.avatar.render.backend.PreparedAvatarResources;
import io.github.whitelily.avatar.render.backend.WhiteLilyAvatarRenderBackend;
import io.github.whitelily.avatar.render.diagnostics.AvatarDiagnosticRateLimiter;
import io.github.whitelily.avatar.render.diagnostics.AvatarRenderDiagnostic;
import io.github.whitelily.avatar.render.quality.AvatarDetailSelector;
import io.github.whitelily.avatar.render.quality.AvatarFallbackController;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class SmoothMeshRenderBackend implements WhiteLilyAvatarRenderBackend {
  private static final Logger LOGGER = LoggerFactory.getLogger("whitelily_avatar");
  private final Path dataRoot;
  private final MeshLoader loader;
  private final HumanoidAnimator animator = new HumanoidAnimator();
  private final AvatarDetailSelector detailSelector = new AvatarDetailSelector();
  private final AvatarDiagnosticRateLimiter diagnosticRateLimiter = new AvatarDiagnosticRateLimiter();
  private final ConcurrentMap<QualityKey, Negotiation> negotiations = new ConcurrentHashMap<>();

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
    throw new AvatarRenderException(
        "AVATAR_BACKEND_MISMATCH", "smooth mesh rendering is unavailable for native skin descriptors");
  }

  /** Package-private research seam; production native-skin control never invokes it. */
  PreparedAvatarResources prepareLegacyResearch(LegacyMeshDescriptor descriptor)
      throws AvatarRenderException {
    validateLegacyDescriptor(descriptor);
    GlbMeshDecoder.GlbMesh mesh;
    try {
      mesh = loader.load(descriptor);
    } catch (AvatarRenderException error) {
      throw new AvatarRenderException("AVATAR_MESH_LOAD_FAILED", "avatar mesh could not be loaded", error);
    }
    if (!descriptor.modelId().equals(mesh.modelId()) && !mesh.modelId().equals(descriptor.sha256())) {
      throw new AvatarRenderException("AVATAR_MESH_LOAD_FAILED", "avatar mesh identity is invalid");
    }
    negotiations.keySet().removeIf(key -> key.modelId().equals(descriptor.modelId()));
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
    emitExpiredDiagnostics();
    Negotiation negotiation = negotiationFor(smooth.modelId(), state);
    AvatarGpuResources gpuResources = smooth.gpuResources();
    GlbMeshDecoder.GlbMesh mesh = smooth.mesh();
    if (gpuResources.disposed()) {
      return AvatarFrameResult.failed("AVATAR_GPU_RESOURCE_RELEASED");
    }
    if (negotiation.fallback.currentStage()
        == AvatarFallbackController.FallbackStage.VANILLA_FRAME_ONLY) {
      diagnose(state, smooth.modelId(), negotiation, "AVATAR_FRAME_FALLBACK", "quality fallback exhausted");
      return AvatarFrameResult.failed("AVATAR_FRAME_FALLBACK");
    }
    if (!state.graphics().shaders()
        || mesh.primitives().stream()
            .anyMatch(
                primitive ->
                    primitive.jointPalette().size()
                        > state.graphics().maximumJointMatrices())) {
      return fail(state, smooth.modelId(), negotiation, "AVATAR_SHADER_FAILED", "shader capabilities are unavailable");
    }
    try {
      AvatarGpuResources.Allocation allocation =
          gpuResources.ensureUploaded(context.avatarGpuDevice());
      HumanoidAnimator.AvatarPose pose;
      try {
        pose =
            animator.evaluate(
                state,
                mesh.skeleton(),
                state.animationTick() / 20.0f,
                negotiation.fallback.currentState().secondaryDynamicsEnabled());
      } catch (RuntimeException error) {
        return fail(state, smooth.modelId(), negotiation, "AVATAR_ANIMATION_FAILED", error.getMessage());
      }
      SmoothMeshFrame frame =
          new SmoothMeshFrame(
              smooth.modelId(),
              gpuResources,
              allocation,
              pose,
              state,
              state.mainHandItem(),
              state.offHandItem(),
              "builtin".equals(smooth.origin()),
              negotiation.detailLevel,
              negotiation.fallback.currentStage(),
              negotiation.fallback.currentStage() != AvatarFallbackController.FallbackStage.FULL_QUALITY,
              negotiation.fallback.currentState().secondaryDynamicsEnabled(),
              negotiation.fallback.currentState().nonessentialTransparencyEnabled());
      context.prepareSmooth(frame);
      context.renderSmooth(frame);
      return AvatarFrameResult.complete();
    } catch (AvatarGpuResources.ResourceReleasedException error) {
      return AvatarFrameResult.failed("AVATAR_GPU_RESOURCE_RELEASED");
    } catch (AvatarGpuResources.ShaderUnavailableException error) {
      return fail(state, smooth.modelId(), negotiation, "AVATAR_SHADER_FAILED", error.getMessage());
    } catch (UnsupportedOperationException error) {
      return fail(state, smooth.modelId(), negotiation, "AVATAR_SHADER_FAILED", error.getMessage());
    } catch (Exception | LinkageError error) {
      return fail(state, smooth.modelId(), negotiation, "AVATAR_MESH_LOAD_FAILED", error.getMessage());
    }
  }

  @Override
  public void dispose(PreparedAvatarResources resources) {
    if (resources instanceof SmoothResources smooth) {
      smooth.gpuResources().close();
    }
  }

  @Override
  public AvatarFrameResult onDeferredFrameFailure(
      PreparedAvatarResources resources, AvatarVisualState state, Throwable failure) {
    if (!(resources instanceof SmoothResources smooth)) {
      return AvatarFrameResult.failed("AVATAR_FRAME_FAILED");
    }
    String code =
        failure instanceof AvatarGpuResources.ShaderUnavailableException
            ? "AVATAR_SHADER_FAILED"
            : "AVATAR_MESH_LOAD_FAILED";
    return fail(state, smooth.modelId(), negotiationFor(smooth.modelId(), state), code, failure.getMessage());
  }

  @Override
  public void close() {
    emitExpiredDiagnostics();
    negotiations.clear();
  }

  private Negotiation negotiationFor(String modelId, AvatarVisualState state) {
    QualityKey key = new QualityKey(state.worldSessionId(), state.renderSessionEpoch(), modelId);
    Negotiation negotiation =
        negotiations.computeIfAbsent(
            key,
            ignored -> {
              AvatarFallbackController fallback = new AvatarFallbackController();
              fallback.beginNegotiation(state.worldSessionId() + "-" + state.renderSessionEpoch(), modelId);
              return new Negotiation(fallback, null);
            });
    negotiation.detailLevel =
        detailSelector.select(negotiation.detailLevel, state.observerDistance(), state.graphics());
    if (negotiation.fallback.currentStage()
        == AvatarFallbackController.FallbackStage.SAME_STYLE_LOW) {
      negotiation.detailLevel = AvatarDetailSelector.AvatarDetailLevel.LOW;
    }
    return negotiation;
  }

  private AvatarFrameResult fail(
      AvatarVisualState state,
      String modelId,
      Negotiation negotiation,
      String errorCode,
      String reason) {
    AvatarFallbackController.FailureType failure =
        switch (negotiation.fallback.currentStage()) {
          case FULL_QUALITY -> AvatarFallbackController.FailureType.SECONDARY_DYNAMICS_FAILED;
          case BASIC_CEL -> AvatarFallbackController.FailureType.ADVANCED_MATERIAL_FAILED;
          case SAME_STYLE_LOW -> AvatarFallbackController.FailureType.HIGH_MODEL_FAILED;
          case VANILLA_FRAME_ONLY -> AvatarFallbackController.FailureType.HIGH_MODEL_FAILED;
        };
    AvatarFallbackController.FallbackStage stage = negotiation.fallback.record(failure);
    String resultingCode =
        stage == AvatarFallbackController.FallbackStage.VANILLA_FRAME_ONLY
            ? "AVATAR_FRAME_FALLBACK"
            : errorCode;
    diagnose(state, modelId, negotiation, resultingCode, reason);
    return AvatarFrameResult.failed(resultingCode);
  }

  private void diagnose(
      AvatarVisualState state,
      String modelId,
      Negotiation negotiation,
      String errorCode,
      String reason) {
    AvatarRenderDiagnostic diagnostic =
        new AvatarRenderDiagnostic(
            "0.1.0",
            "smooth-mesh",
            modelId,
            negotiation.detailLevel.name(),
            state.armorTheme().name(),
            negotiation.fallback.currentStage().name(),
            state.worldSessionId() + "-" + state.renderSessionEpoch(),
            errorCode,
            reason);
    for (AvatarDiagnosticRateLimiter.Emission emission : diagnosticRateLimiter.record(diagnostic)) {
      LOGGER.error("{} {}", emission.diagnostic().errorCode(), emission);
    }
  }

  private void emitExpiredDiagnostics() {
    for (AvatarDiagnosticRateLimiter.Emission emission : diagnosticRateLimiter.flushExpired()) {
      LOGGER.error("{} {}", emission.diagnostic().errorCode(), emission);
    }
  }

  private void validateLegacyDescriptor(LegacyMeshDescriptor descriptor)
      throws AvatarRenderException {
    if (descriptor == null
        || !java.util.Set.of("builtin", "imported").contains(descriptor.origin())
        || descriptor.modelId() == null
        || descriptor.resourcePath() == null
        || descriptor.sha256() == null
        || descriptor.boneMapping() == null
        || !java.util.Set.of("full", "neutral-only").contains(descriptor.expressions())) {
      throw new AvatarRenderException(
          "AVATAR_ASSET_VALIDATION_FAILED", "invalid smooth mesh research descriptor");
    }
  }

  private GlbMeshDecoder.GlbMesh read(LegacyMeshDescriptor descriptor)
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
    GlbMeshDecoder.GlbMesh load(LegacyMeshDescriptor descriptor) throws AvatarRenderException;
  }

  record LegacyMeshDescriptor(
      String modelId,
      String origin,
      String resourcePath,
      String sha256,
      Map<String, String> boneMapping,
      String expressions) {}

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
      boolean whiteLilyArmorEnabled,
      AvatarDetailSelector.AvatarDetailLevel detailLevel,
      AvatarFallbackController.FallbackStage fallbackStage,
      boolean basicCelMaterial,
      boolean secondaryDynamicsEnabled,
      boolean nonessentialTransparencyEnabled) {
    public SmoothMeshFrame {
      Objects.requireNonNull(modelId, "modelId");
      Objects.requireNonNull(resources, "resources");
      Objects.requireNonNull(allocation, "allocation");
      Objects.requireNonNull(pose, "pose");
      Objects.requireNonNull(state, "state");
      Objects.requireNonNull(mainHandItem, "mainHandItem");
      Objects.requireNonNull(offHandItem, "offHandItem");
      Objects.requireNonNull(detailLevel, "detailLevel");
      Objects.requireNonNull(fallbackStage, "fallbackStage");
    }

    public org.joml.Matrix4f leftHand() {
      return pose.leftHand();
    }

    public org.joml.Matrix4f rightHand() {
      return pose.rightHand();
    }
  }

  private record QualityKey(String worldSessionId, long renderSessionEpoch, String modelId) {}

  private static final class Negotiation {
    private final AvatarFallbackController fallback;
    private volatile AvatarDetailSelector.AvatarDetailLevel detailLevel;

    private Negotiation(
        AvatarFallbackController fallback, AvatarDetailSelector.AvatarDetailLevel detailLevel) {
      this.fallback = fallback;
      this.detailLevel = detailLevel;
    }
  }
}
