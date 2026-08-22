package io.github.whitelily.avatar.skin;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.whitelily.avatar.control.AvatarCandidateRuntime.PreparedCandidate;
import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import org.junit.jupiter.api.Test;

final class NativeSkinCandidateRuntimeTest {
  @Test
  void preparesTheBuiltinNativeSkinDescriptor() {
    NativeSkinCandidateRuntime runtime = new NativeSkinCandidateRuntime();

    PreparedCandidate candidate = runtime.prepare(descriptor("builtin", "minecraft-skin", "slim"))
        .toCompletableFuture().join();

    assertEquals("builtin:whitelily", candidate.modelId());
  }

  @Test
  void rejectsNonNativeOrNonBuiltinDescriptors() {
    NativeSkinCandidateRuntime runtime = new NativeSkinCandidateRuntime();

    for (AvatarRuntimeDescriptor descriptor :
        new AvatarRuntimeDescriptor[] {
          descriptor("builtin", "vrm", "slim"),
          descriptor("builtin", "minecraft-skin", "wide"),
          new AvatarRuntimeDescriptor("builtin:whitelily", "builtin", "minecraft-skin", null)
        }) {
      CompletionException failure =
          org.junit.jupiter.api.Assertions.assertThrows(
              CompletionException.class, () -> runtime.prepare(descriptor).toCompletableFuture().join());
      assertInstanceOf(IllegalArgumentException.class, failure.getCause());
    }
  }

  @Test
  void commitBecomesVisibleExactlyOnce() {
    NativeSkinCandidateRuntime runtime = new NativeSkinCandidateRuntime();
    PreparedCandidate candidate = runtime.prepare(descriptor("builtin", "minecraft-skin", "slim"))
        .toCompletableFuture().join();

    runtime.requestCommit(candidate);

    assertEquals(candidate, runtime.consumeVisibleCommit().orElseThrow());
    assertTrue(runtime.consumeVisibleCommit().isEmpty());
  }

  @Test
  void cancelRestoresThePreviousSkinAfterTheCandidateBecameVisible() {
    WhiteLilySkinCatalog visible = new WhiteLilySkinCatalog();
    visible.activate("user:00000000-0000-4000-8000-000000000002", null);
    NativeSkinCandidateRuntime runtime = new NativeSkinCandidateRuntime(
        null,
        visible,
        approved -> CompletableFuture.failedFuture(new AssertionError("registrar is unused")));
    PreparedCandidate candidate = runtime.prepare(descriptor("builtin", "minecraft-skin", "slim"))
        .toCompletableFuture().join();

    runtime.requestCommit(candidate);
    assertEquals(candidate, runtime.consumeVisibleCommit().orElseThrow());
    runtime.cancel(candidate);

    assertEquals("user:00000000-0000-4000-8000-000000000002", visible.activeModelId());
  }

  @Test
  void releasingThePreviousCheckpointDoesNotRollBackTheFinalizedVisibleSkin() {
    WhiteLilySkinCatalog visible = new WhiteLilySkinCatalog();
    NativeSkinCandidateRuntime runtime = new NativeSkinCandidateRuntime(
        null,
        visible,
        approved -> CompletableFuture.failedFuture(new AssertionError("registrar is unused")));
    PreparedCandidate first = runtime.prepare(descriptor("builtin", "minecraft-skin", "slim"))
        .toCompletableFuture().join();
    runtime.requestCommit(first);
    assertEquals(first, runtime.consumeVisibleCommit().orElseThrow());
    PreparedCandidate second = runtime.prepare(descriptor("builtin", "minecraft-skin", "slim"))
        .toCompletableFuture().join();
    runtime.requestCommit(second);
    assertEquals(second, runtime.consumeVisibleCommit().orElseThrow());

    runtime.release(first);

    assertEquals("builtin:whitelily", visible.activeModelId());
  }

  private static AvatarRuntimeDescriptor descriptor(String origin, String renderer, String armModel) {
    String modelId = "builtin".equals(origin)
        ? "builtin:whitelily"
        : "user:00000000-0000-4000-8000-000000000001";
    return new AvatarRuntimeDescriptor(modelId, origin, renderer, armModel);
  }
}
