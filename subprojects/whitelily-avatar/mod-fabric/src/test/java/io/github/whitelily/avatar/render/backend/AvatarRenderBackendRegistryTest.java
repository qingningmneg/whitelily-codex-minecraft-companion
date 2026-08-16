package io.github.whitelily.avatar.render.backend;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.whitelily.avatar.control.AvatarCandidateRuntime.PreparedCandidate;
import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import io.github.whitelily.avatar.control.AvatarVisibleFrameResult;
import io.github.whitelily.avatar.theme.ArmorTheme;
import java.util.ArrayDeque;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class AvatarRenderBackendRegistryTest {
  @Test
  void suppressesVanillaOnlyAfterEveryCustomBatchCommits() {
    FakeBackend backend = new FakeBackend();
    FakeContext context = new FakeContext();
    ArrayDeque<AvatarVisibleFrameResult> visibleResults = new ArrayDeque<>();
    AvatarRenderBackendRegistry registry =
        new AvatarRenderBackendRegistry(Map.of("glb", backend), visibleResults::add);
    PreparedCandidate candidate = registry.prepare(descriptor()).toCompletableFuture().join();
    registry.requestCommit(candidate);

    backend.nextResult = AvatarFrameResult.failed("AVATAR_SHADER_FAILED");
    AvatarRenderOutcome failed = registry.render(snapshot(), context);

    assertFalse(failed.suppressVanilla());
    assertTrue(context.lastTransaction.restored);
    assertEquals(AvatarVisibleFrameResult.FAILED, visibleResults.remove());

    registry.requestCommit(candidate);
    backend.nextResult = AvatarFrameResult.complete();
    AvatarRenderOutcome complete = registry.render(snapshot(), context);

    assertTrue(complete.suppressVanilla());
    assertTrue(context.lastTransaction.committed);
    assertEquals(AvatarVisibleFrameResult.COMPLETE, visibleResults.remove());
  }

  @Test
  void neverChoosesTheClassicBackendForAnotherFormatsFailure() {
    FakeBackend classic = new FakeBackend();
    FakeBackend imported = new FakeBackend();
    AvatarRenderBackendRegistry registry =
        new AvatarRenderBackendRegistry(
            Map.of("builtin-classic", classic, "glb", imported), ignored -> {});
    PreparedCandidate candidate = registry.prepare(descriptor()).toCompletableFuture().join();
    registry.requestCommit(candidate);
    imported.nextResult = AvatarFrameResult.failed("AVATAR_MESH_LOAD_FAILED");

    AvatarRenderOutcome outcome = registry.render(snapshot(), new FakeContext());

    assertFalse(outcome.suppressVanilla());
    assertEquals(1, imported.renderCount);
    assertEquals(0, classic.renderCount);
  }

  @Test
  void releaseIsIdempotentAndDisposesOnlyTheOwningBackend() {
    FakeBackend backend = new FakeBackend();
    AvatarRenderBackendRegistry registry =
        new AvatarRenderBackendRegistry(Map.of("glb", backend), ignored -> {});
    PreparedCandidate candidate = registry.prepare(descriptor()).toCompletableFuture().join();

    registry.release(candidate);
    registry.release(candidate);

    assertEquals(1, backend.disposeCount);
  }

  private static AvatarRuntimeDescriptor descriptor() {
    return new AvatarRuntimeDescriptor(
        "user:00000000-0000-4000-8000-000000000001",
        "imported",
        "glb",
        "user/00000000-0000-4000-8000-000000000001/model.glb",
        "a".repeat(64),
        Map.of(),
        "whitelily-humanoid-v1",
        "neutral-only");
  }

  private static AvatarVisualState snapshot() {
    return new AvatarVisualState(
        1,
        "world-0001",
        0.0,
        64.0,
        0.0,
        0.0f,
        0.0f,
        "standing",
        0.5f,
        ArmorTheme.BASE,
        "minecraft:air",
        "minecraft:air",
        false,
        false,
        false,
        false,
        false,
        false,
        "neutral",
        4.0f,
        new AvatarVisualState.GraphicsCapabilities(true, true, 128));
  }

  private static final class FakeBackend implements WhiteLilyAvatarRenderBackend {
    private AvatarFrameResult nextResult = AvatarFrameResult.complete();
    private int renderCount;
    private int disposeCount;

    @Override
    public PreparedAvatarResources prepare(AvatarRuntimeDescriptor descriptor) {
      return () -> descriptor.modelId();
    }

    @Override
    public AvatarFrameResult renderFrame(
        PreparedAvatarResources resources,
        AvatarVisualState state,
        AvatarRenderContext context) {
      renderCount++;
      return nextResult;
    }

    @Override
    public void dispose(PreparedAvatarResources resources) {
      disposeCount++;
    }
  }

  private static final class FakeContext implements AvatarRenderContext {
    private FakeTransaction lastTransaction;

    @Override
    public FrameTransaction beginFrame() {
      lastTransaction = new FakeTransaction();
      return lastTransaction;
    }

    @Override
    public void renderClassic() {}
  }

  private static final class FakeTransaction implements AvatarRenderContext.FrameTransaction {
    private boolean committed;
    private boolean restored;

    @Override
    public void commit() {
      committed = true;
    }

    @Override
    public void restore() {
      restored = true;
    }
  }
}
