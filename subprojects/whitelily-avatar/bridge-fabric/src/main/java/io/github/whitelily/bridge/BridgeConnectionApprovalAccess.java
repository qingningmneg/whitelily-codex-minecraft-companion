package io.github.whitelily.bridge;

import java.util.UUID;

interface BridgeConnectionApprovalAccess {
  void whitelily$markPendingApproval(Object server, UUID profileId);

  boolean whitelily$takePendingApproval(Object server, UUID profileId);

  void whitelily$clearPendingApproval();
}
