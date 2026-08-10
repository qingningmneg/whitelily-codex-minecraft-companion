package io.github.whitelily.bridge;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

final class ApprovedProfileRegistry {
  private static final AtomicReference<Approval> APPROVAL = new AtomicReference<>();

  private ApprovedProfileRegistry() {}

  static boolean complete(
      BridgeConnectionApprovalAccess connection,
      Object integratedServer,
      UUID profileId,
      String profileName,
      BooleanSupplier activeServer) {
    if (connection == null
        || !connection.whitelily$takePendingApproval(integratedServer, profileId)
        || integratedServer == null
        || activeServer == null
        || !WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID.equals(profileId)
        || !WhiteLilyBridge.WHITE_LILY_USERNAME.equals(profileName)
        || !isActive(activeServer)) {
      return false;
    }
    APPROVAL.set(new Approval(integratedServer, activeServer));
    return true;
  }

  static void revoke(Object integratedServer, UUID profileId) {
    if (!WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID.equals(profileId)) {
      return;
    }
    Approval current = APPROVAL.get();
    if (current != null && current.server == integratedServer) {
      APPROVAL.compareAndSet(current, null);
    }
  }

  static void clearServer(Object integratedServer) {
    Approval current = APPROVAL.get();
    if (current != null && current.server == integratedServer) {
      APPROVAL.compareAndSet(current, null);
    }
  }

  static boolean isApproved(Object currentIntegratedServer, UUID profileId, String profileName) {
    Approval current = APPROVAL.get();
    return current != null
        && current.server == currentIntegratedServer
        && isActive(current.activeServer)
        && WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID.equals(profileId)
        && WhiteLilyBridge.WHITE_LILY_USERNAME.equals(profileName);
  }

  private static boolean isActive(BooleanSupplier activeServer) {
    try {
      return activeServer.getAsBoolean();
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  private static final class Approval {
    private final Object server;
    private final BooleanSupplier activeServer;

    private Approval(Object server, BooleanSupplier activeServer) {
      this.server = server;
      this.activeServer = activeServer;
    }
  }
}
