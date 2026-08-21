package io.github.whitelily.avatar.skin;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.whitelily.avatar.control.AvatarCandidateRuntime.PreparedCandidate;
import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionException;
import org.junit.jupiter.api.Test;

final class NativeSkinCandidateRuntimeTest {
  @Test
  void preparesOnlyCoherentBuiltinNativeSkinAliasesWithoutReadingTheirResourcePaths() {
    NativeSkinCandidateRuntime runtime = new NativeSkinCandidateRuntime();

    for (AvatarRuntimeDescriptor descriptor :
        List.of(
            descriptor("builtin:whitelily", "minecraft-skin"),
            descriptor("builtin:whitelily-hd", "minecraft-skin"),
            descriptor("builtin:whitelily-classic", "minecraft-skin"),
            descriptor("builtin:whitelily-hd", "builtin-hd"),
            descriptor("builtin:whitelily-classic", "builtin-classic"))) {
      PreparedCandidate candidate = runtime.prepare(descriptor).toCompletableFuture().join();

      assertEquals(descriptor.modelId(), candidate.modelId());
    }
  }

  @Test
  void commitBecomesVisibleExactlyOnce() {
    NativeSkinCandidateRuntime runtime = new NativeSkinCandidateRuntime();
    PreparedCandidate candidate =
        runtime.prepare(descriptor("builtin:whitelily", "minecraft-skin"))
            .toCompletableFuture()
            .join();

    runtime.requestCommit(candidate);

    assertEquals(candidate, runtime.consumeVisibleCommit().orElseThrow());
    assertTrue(runtime.consumeVisibleCommit().isEmpty());
  }

  @Test
  void cancelAndReleaseClearOnlyTheMatchingPendingCommit() {
    NativeSkinCandidateRuntime runtime = new NativeSkinCandidateRuntime();
    PreparedCandidate first = prepare(runtime, "builtin:whitelily-hd", "builtin-hd");
    PreparedCandidate second = prepare(runtime, "builtin:whitelily-classic", "builtin-classic");

    runtime.requestCommit(first);
    runtime.cancel(second);
    runtime.release(second);
    assertEquals(first, runtime.consumeVisibleCommit().orElseThrow());

    runtime.requestCommit(first);
    runtime.cancel(first);
    assertTrue(runtime.consumeVisibleCommit().isEmpty());

    runtime.requestCommit(first);
    runtime.release(first);
    assertTrue(runtime.consumeVisibleCommit().isEmpty());
  }

  @Test
  void rejectsUserGeometryAndIncoherentBuiltinDescriptors() {
    NativeSkinCandidateRuntime runtime = new NativeSkinCandidateRuntime();

    for (AvatarRuntimeDescriptor descriptor :
        List.of(
            descriptor("user:00000000-0000-4000-8000-000000000001", "glb", "imported"),
            descriptor("user:00000000-0000-4000-8000-000000000001", "vrm", "imported"),
            descriptor("builtin:whitelily-classic", "builtin-hd"),
            descriptor(null, "minecraft-skin"),
            descriptor("builtin:whitelily", null))) {
      CompletionException failure =
          org.junit.jupiter.api.Assertions.assertThrows(
              CompletionException.class,
              () -> runtime.prepare(descriptor).toCompletableFuture().join());

      assertInstanceOf(IllegalArgumentException.class, failure.getCause());
    }
  }

  private static PreparedCandidate prepare(
      NativeSkinCandidateRuntime runtime, String modelId, String format) {
    return runtime.prepare(descriptor(modelId, format)).toCompletableFuture().join();
  }

  private static AvatarRuntimeDescriptor descriptor(String modelId, String format) {
    return descriptor(modelId, format, "builtin");
  }

  private static AvatarRuntimeDescriptor descriptor(String modelId, String format, String origin) {
    return new AvatarRuntimeDescriptor(
        modelId,
        origin,
        format,
        "Z:/this/path/must/not/be/read/missing-avatar.bin",
        "not-used-by-native-skin-runtime",
        Map.of(),
        "not-used-by-native-skin-runtime",
        "not-used-by-native-skin-runtime");
  }
}
