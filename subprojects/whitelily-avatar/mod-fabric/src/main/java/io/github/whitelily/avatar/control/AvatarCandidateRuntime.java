package io.github.whitelily.avatar.control;

import java.util.concurrent.CompletionStage;

public interface AvatarCandidateRuntime {
  CompletionStage<PreparedCandidate> prepare(AvatarRuntimeDescriptor descriptor);

  void requestCommit(PreparedCandidate candidate);

  void cancel(PreparedCandidate candidate);

  void release(PreparedCandidate candidate);

  interface PreparedCandidate {
    String modelId();
  }
}
