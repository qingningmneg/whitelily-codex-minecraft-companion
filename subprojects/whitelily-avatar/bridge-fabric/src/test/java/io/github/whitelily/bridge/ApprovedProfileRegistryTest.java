package io.github.whitelily.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;

class ApprovedProfileRegistryTest {
  private static final UUID WHITE_LILY_OFFLINE_UUID =
      UUID.fromString("4c9f0cd1-8920-3a2d-b96a-ecfe5ebd8ab9");

  @Test
  void approvalRequiresTheFixedOfflineUuidAndLiteralName() {
    Object integratedServer = new Object();
    PendingProfileApprovalSlot connection = new PendingProfileApprovalSlot();

    assertFalse(
        WhiteLilyBridge.isApprovedProfileForCurrentServer(
            integratedServer, WHITE_LILY_OFFLINE_UUID, "WhiteLily"));
    connection.mark(integratedServer, UUID.fromString("00000000-0000-0000-0000-000000000001"));
    assertFalse(
        ApprovedProfileRegistry.complete(
            connection,
            integratedServer,
            UUID.fromString("00000000-0000-0000-0000-000000000001"),
            "WhiteLily",
            () -> true));
    connection.mark(integratedServer, WHITE_LILY_OFFLINE_UUID);
    assertTrue(
        ApprovedProfileRegistry.complete(
            connection, integratedServer, WHITE_LILY_OFFLINE_UUID, "WhiteLily", () -> true));
    assertTrue(
        WhiteLilyBridge.isApprovedProfileForCurrentServer(
            integratedServer, WHITE_LILY_OFFLINE_UUID, "WhiteLily"));
    assertFalse(
        WhiteLilyBridge.isApprovedProfileForCurrentServer(
            integratedServer, WHITE_LILY_OFFLINE_UUID, "whiteLily"));
    assertFalse(
        WhiteLilyBridge.isApprovedProfileForCurrentServer(
            integratedServer,
            UUID.fromString("00000000-0000-0000-0000-000000000001"),
            "WhiteLily"));

    ApprovedProfileRegistry.clearServer(integratedServer);
  }

  @Test
  void playerRemovalAndOnlyTheOwningServerStopRevokeApproval() {
    Object firstServer = new Object();
    Object secondServer = new Object();

    approve(firstServer, () -> true);
    ApprovedProfileRegistry.clearServer(secondServer);
    assertApprovedFor(firstServer);

    ApprovedProfileRegistry.revoke(secondServer, WHITE_LILY_OFFLINE_UUID);
    assertApprovedFor(firstServer);
    ApprovedProfileRegistry.revoke(firstServer, WHITE_LILY_OFFLINE_UUID);
    assertNotApprovedFor(firstServer);

    approve(secondServer, () -> true);
    ApprovedProfileRegistry.clearServer(firstServer);
    assertApprovedFor(secondServer);
    ApprovedProfileRegistry.clearServer(secondServer);
    assertNotApprovedFor(secondServer);
  }

  @Test
  void approvalStaysPrivateUntilPlacementCompletesAndRequiresTheOwningServer() {
    Object integratedServer = new Object();
    PendingProfileApprovalSlot connection = new PendingProfileApprovalSlot();
    connection.mark(integratedServer, WHITE_LILY_OFFLINE_UUID);

    assertNotApprovedFor(integratedServer);
    assertFalse(
        ApprovedProfileRegistry.complete(
            connection, new Object(), WHITE_LILY_OFFLINE_UUID, "WhiteLily", () -> true));
    assertNotApprovedFor(integratedServer);

    connection.mark(integratedServer, WHITE_LILY_OFFLINE_UUID);
    assertTrue(
        ApprovedProfileRegistry.complete(
            connection, integratedServer, WHITE_LILY_OFFLINE_UUID, "WhiteLily", () -> true));
    assertApprovedFor(integratedServer);
    assertFalse(
        ApprovedProfileRegistry.complete(
            connection, integratedServer, WHITE_LILY_OFFLINE_UUID, "WhiteLily", () -> true));
    assertNotApprovedFor(new Object());
    ApprovedProfileRegistry.clearServer(integratedServer);
  }

  @Test
  void publicReadFailsClosedWhenTheStoredIntegratedServerIsNoLongerActive() {
    Object integratedServer = new Object();
    AtomicBoolean active = new AtomicBoolean(true);
    approve(integratedServer, active::get);
    assertApprovedFor(integratedServer);

    active.set(false);

    assertNotApprovedFor(integratedServer);
    ApprovedProfileRegistry.clearServer(integratedServer);
  }

  private static void approve(Object server, java.util.function.BooleanSupplier active) {
    PendingProfileApprovalSlot connection = new PendingProfileApprovalSlot();
    connection.mark(server, WHITE_LILY_OFFLINE_UUID);
    assertTrue(
        ApprovedProfileRegistry.complete(
            connection, server, WHITE_LILY_OFFLINE_UUID, "WhiteLily", active));
  }

  private static void assertApprovedFor(Object server) {
    assertTrue(
        WhiteLilyBridge.isApprovedProfileForCurrentServer(
            server, WHITE_LILY_OFFLINE_UUID, "WhiteLily"));
  }

  private static void assertNotApprovedFor(Object server) {
    assertFalse(
        WhiteLilyBridge.isApprovedProfileForCurrentServer(
            server, WHITE_LILY_OFFLINE_UUID, "WhiteLily"));
  }
}
