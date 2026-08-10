package io.github.whitelily.bridge;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

final class PendingProfileApprovalSlot implements BridgeConnectionApprovalAccess {
  private final AtomicReference<Candidate> candidate = new AtomicReference<>();

  void mark(Object server, UUID profileId) {
    whitelily$markPendingApproval(server, profileId);
  }

  @Override
  public void whitelily$markPendingApproval(Object server, UUID profileId) {
    if (server != null && profileId != null) {
      candidate.compareAndSet(null, new Candidate(server, profileId));
    }
  }

  @Override
  public boolean whitelily$takePendingApproval(Object server, UUID profileId) {
    Candidate pending = candidate.getAndSet(null);
    return pending != null && pending.server == server && pending.profileId.equals(profileId);
  }

  @Override
  public String toString() {
    return "PendingProfileApprovalSlot[redacted]";
  }

  private record Candidate(Object server, UUID profileId) {}
}
