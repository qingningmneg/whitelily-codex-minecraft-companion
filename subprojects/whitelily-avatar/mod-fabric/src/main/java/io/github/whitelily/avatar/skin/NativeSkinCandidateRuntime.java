package io.github.whitelily.avatar.skin;

import com.mojang.blaze3d.platform.NativeImage;
import io.github.whitelily.avatar.control.AvatarCandidateRuntime;
import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.client.resources.PlayerSkin;
import net.minecraft.resources.ResourceLocation;

/** Candidate runtime for vanilla bundled and allowlisted dynamic player skins. */
public final class NativeSkinCandidateRuntime implements AvatarCandidateRuntime {
  private final Set<NativeCandidate> liveCandidates = ConcurrentHashMap.newKeySet();
  private final AtomicReference<NativeCandidate> awaitingVisible = new AtomicReference<>();
  private final ApprovedSkinCatalog approvedCatalog;
  private final WhiteLilySkinCatalog visibleCatalog;
  private final NativeSkinRegistrar registrar;

  /** Builtin-only constructor retained for protocol tests and fail-closed startup. */
  public NativeSkinCandidateRuntime() {
    this(null, new WhiteLilySkinCatalog(), approved ->
        CompletableFuture.failedFuture(new IllegalStateException("user skin catalog is unavailable")));
  }

  public NativeSkinCandidateRuntime(
      ApprovedSkinCatalog approvedCatalog,
      WhiteLilySkinCatalog visibleCatalog,
      NativeSkinRegistrar registrar) {
    this.approvedCatalog = approvedCatalog;
    this.visibleCatalog = java.util.Objects.requireNonNull(visibleCatalog, "visibleCatalog");
    this.registrar = java.util.Objects.requireNonNull(registrar, "registrar");
  }

  public static NativeSkinCandidateRuntime forMinecraft(
      ApprovedSkinCatalog approvedCatalog, WhiteLilySkinCatalog visibleCatalog) {
    return new NativeSkinCandidateRuntime(approvedCatalog, visibleCatalog, minecraftRegistrar());
  }

  @Override
  public CompletionStage<PreparedCandidate> prepare(AvatarRuntimeDescriptor descriptor) {
    if (!isSupported(descriptor)) {
      return CompletableFuture.failedFuture(
          new IllegalArgumentException("native skin runtime does not support this descriptor"));
    }
    if ("builtin".equals(descriptor.origin())) {
      NativeCandidate candidate = new NativeCandidate(this, descriptor.modelId(), null);
      liveCandidates.add(candidate);
      return CompletableFuture.completedFuture(candidate);
    }
    if (approvedCatalog == null) {
      return CompletableFuture.failedFuture(
          new IllegalStateException("approved user skin catalog is unavailable"));
    }
    final ApprovedSkinCatalog.ApprovedSkin approved;
    try {
      approved = approvedCatalog.resolve(descriptor.modelId());
      PlayerSkin.Model expected = "slim".equals(descriptor.armModel())
          ? PlayerSkin.Model.SLIM : PlayerSkin.Model.WIDE;
      if (approved.model() != expected) {
        throw new IllegalArgumentException("approved skin arm model changed");
      }
    } catch (Exception error) {
      return CompletableFuture.failedFuture(error);
    }
    return registrar.register(approved).thenApply(registered -> {
      NativeCandidate candidate = new NativeCandidate(this, descriptor.modelId(), registered);
      liveCandidates.add(candidate);
      return candidate;
    });
  }

  @Override
  public synchronized void requestCommit(PreparedCandidate candidate) {
    NativeCandidate nativeCandidate = owned(candidate);
    if (!liveCandidates.contains(nativeCandidate)) {
      throw new IllegalStateException("native skin candidate was released");
    }
    NativeCandidate previous = awaitingVisible.getAndSet(nativeCandidate);
    if (previous != null && previous != nativeCandidate) rollback(previous);
    nativeCandidate.previous = visibleCatalog.activate(
        nativeCandidate.modelId,
        nativeCandidate.registered == null ? null : nativeCandidate.registered.skin());
    nativeCandidate.activated = true;
  }

  @Override
  public synchronized void cancel(PreparedCandidate candidate) {
    NativeCandidate nativeCandidate = owned(candidate);
    awaitingVisible.compareAndSet(nativeCandidate, null);
    rollback(nativeCandidate);
  }

  @Override
  public synchronized void release(PreparedCandidate candidate) {
    NativeCandidate nativeCandidate = owned(candidate);
    awaitingVisible.compareAndSet(nativeCandidate, null);
    liveCandidates.remove(nativeCandidate);
    if (nativeCandidate.registered != null && !nativeCandidate.released) {
      nativeCandidate.released = true;
      nativeCandidate.registered.release().run();
    }
  }

  /** Consumes the candidate waiting for its first successfully applied vanilla frame. */
  public synchronized Optional<PreparedCandidate> consumeVisibleCommit() {
    NativeCandidate candidate = awaitingVisible.getAndSet(null);
    if (candidate != null) candidate.committed = true;
    return Optional.ofNullable(candidate);
  }

  private void rollback(NativeCandidate candidate) {
    if (!candidate.activated || candidate.committed || candidate.previous == null) return;
    visibleCatalog.restore(candidate.previous);
    candidate.activated = false;
  }

  private static boolean isSupported(AvatarRuntimeDescriptor descriptor) {
    if (descriptor == null || descriptor.modelId() == null || descriptor.origin() == null
        || descriptor.worldRenderer() == null || descriptor.armModel() == null
        || !"minecraft-skin".equals(descriptor.worldRenderer())
        || !Set.of("slim", "wide").contains(descriptor.armModel())) {
      return false;
    }
    if ("builtin".equals(descriptor.origin())) {
      return "builtin:whitelily".equals(descriptor.modelId())
          && "slim".equals(descriptor.armModel());
    }
    return "imported".equals(descriptor.origin()) && descriptor.modelId().matches(
        "^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
  }

  private NativeCandidate owned(PreparedCandidate candidate) {
    if (candidate instanceof NativeCandidate nativeCandidate && nativeCandidate.owner == this) {
      return nativeCandidate;
    }
    throw new IllegalArgumentException("native skin candidate has no runtime owner");
  }

  private static NativeSkinRegistrar minecraftRegistrar() {
    return approved -> {
      CompletableFuture<RegisteredSkin> result = new CompletableFuture<>();
      Minecraft client = Minecraft.getInstance();
      client.execute(() -> {
        NativeImage image = null;
        DynamicTexture texture = null;
        try {
          image = NativeImage.read(new ByteArrayInputStream(approved.pngBytes()));
          if (image.getWidth() != 64 || image.getHeight() != 64) {
            throw new IOException("approved dynamic skin dimensions changed");
          }
          texture = new DynamicTexture(() -> "WhiteLily approved user skin", image);
          image = null;
          ResourceLocation location = ResourceLocation.fromNamespaceAndPath(
              "whitelily_avatar", "dynamic/user/" + UUID.randomUUID().toString().replace("-", ""));
          client.getTextureManager().register(location, texture);
          texture = null;
          PlayerSkin skin = new PlayerSkin(location, null, null, null, approved.model(), true);
          result.complete(new RegisteredSkin(
              skin, () -> client.execute(() -> client.getTextureManager().release(location))));
        } catch (IOException | RuntimeException | LinkageError error) {
          if (texture != null) texture.close();
          if (image != null) image.close();
          result.completeExceptionally(error);
        }
      });
      return result;
    };
  }

  @FunctionalInterface
  public interface NativeSkinRegistrar {
    CompletionStage<RegisteredSkin> register(ApprovedSkinCatalog.ApprovedSkin approved);
  }

  public record RegisteredSkin(PlayerSkin skin, Runnable release) {
    public RegisteredSkin {
      java.util.Objects.requireNonNull(skin, "skin");
      java.util.Objects.requireNonNull(release, "release");
    }
  }

  private static final class NativeCandidate implements PreparedCandidate {
    private final NativeSkinCandidateRuntime owner;
    private final String modelId;
    private final RegisteredSkin registered;
    private WhiteLilySkinCatalog.Selection previous;
    private boolean activated;
    private boolean committed;
    private boolean released;

    private NativeCandidate(
        NativeSkinCandidateRuntime owner, String modelId, RegisteredSkin registered) {
      this.owner = owner;
      this.modelId = modelId;
      this.registered = registered;
    }

    @Override
    public String modelId() { return modelId; }
  }
}
