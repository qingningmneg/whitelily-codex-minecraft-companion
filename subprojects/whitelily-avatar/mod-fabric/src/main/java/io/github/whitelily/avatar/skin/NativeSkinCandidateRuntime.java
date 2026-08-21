package io.github.whitelily.avatar.skin;

import io.github.whitelily.avatar.control.AvatarCandidateRuntime;
import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;

/** Candidate runtime for model switches implemented entirely by the vanilla player skin. */
public final class NativeSkinCandidateRuntime implements AvatarCandidateRuntime {
  private static final Map<String, Set<String>> SUPPORTED_ALIASES =
      Map.of(
          "builtin:whitelily", Set.of("minecraft-skin"),
          "builtin:whitelily-hd", Set.of("minecraft-skin", "builtin-hd"),
          "builtin:whitelily-classic", Set.of("minecraft-skin", "builtin-classic"));

  private final Set<NativeCandidate> liveCandidates = ConcurrentHashMap.newKeySet();
  private final AtomicReference<NativeCandidate> awaitingVisible = new AtomicReference<>();

  @Override
  public CompletionStage<PreparedCandidate> prepare(AvatarRuntimeDescriptor descriptor) {
    if (!isSupported(descriptor)) {
      return CompletableFuture.failedFuture(
          new IllegalArgumentException("native skin runtime does not support this descriptor"));
    }
    NativeCandidate candidate = new NativeCandidate(this, descriptor.modelId());
    liveCandidates.add(candidate);
    return CompletableFuture.completedFuture(candidate);
  }

  @Override
  public synchronized void requestCommit(PreparedCandidate candidate) {
    NativeCandidate nativeCandidate = owned(candidate);
    if (!liveCandidates.contains(nativeCandidate)) {
      throw new IllegalStateException("native skin candidate was released");
    }
    awaitingVisible.set(nativeCandidate);
  }

  @Override
  public synchronized void cancel(PreparedCandidate candidate) {
    NativeCandidate nativeCandidate = owned(candidate);
    awaitingVisible.compareAndSet(nativeCandidate, null);
  }

  @Override
  public synchronized void release(PreparedCandidate candidate) {
    NativeCandidate nativeCandidate = owned(candidate);
    awaitingVisible.compareAndSet(nativeCandidate, null);
    liveCandidates.remove(nativeCandidate);
  }

  /** Consumes the native candidate waiting for its first successfully applied vanilla frame. */
  public synchronized Optional<PreparedCandidate> consumeVisibleCommit() {
    return Optional.ofNullable(awaitingVisible.getAndSet(null));
  }

  private static boolean isSupported(AvatarRuntimeDescriptor descriptor) {
    if (descriptor == null
        || descriptor.modelId() == null
        || descriptor.format() == null
        || !"builtin".equals(descriptor.origin())) {
      return false;
    }
    return SUPPORTED_ALIASES
        .getOrDefault(descriptor.modelId(), Set.of())
        .contains(descriptor.format());
  }

  private NativeCandidate owned(PreparedCandidate candidate) {
    if (candidate instanceof NativeCandidate nativeCandidate
        && nativeCandidate.owner == this) {
      return nativeCandidate;
    }
    throw new IllegalArgumentException("native skin candidate has no runtime owner");
  }

  private static final class NativeCandidate implements PreparedCandidate {
    private final NativeSkinCandidateRuntime owner;
    private final String modelId;

    private NativeCandidate(NativeSkinCandidateRuntime owner, String modelId) {
      this.owner = owner;
      this.modelId = modelId;
    }

    @Override
    public String modelId() {
      return modelId;
    }
  }
}
