package io.github.whitelily.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.whitelily.bridge.mixin.ConnectionMixin;
import java.lang.reflect.Method;
import java.util.UUID;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.junit.jupiter.api.Test;

class BridgeConnectionLifecycleTest {
  @Test
  void pendingApprovalCanBeInspectedWithoutBeingConsumed() {
    PendingProfileApprovalSlot approval = new PendingProfileApprovalSlot();
    Object server = new Object();
    UUID profile = WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID;
    approval.whitelily$markPendingApproval(server, profile);

    assertTrue(approval.whitelily$hasPendingApproval(server, profile));
    assertTrue(approval.whitelily$takePendingApproval(server, profile));
  }

  @Test
  void pendingApprovalInspectionRejectsEveryMismatchedAuthority() {
    PendingProfileApprovalSlot approval = new PendingProfileApprovalSlot();
    Object server = new Object();
    UUID profile = WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID;
    approval.whitelily$markPendingApproval(server, profile);

    assertFalse(approval.whitelily$hasPendingApproval(new Object(), profile));
    assertFalse(approval.whitelily$hasPendingApproval(server, UUID.randomUUID()));
    assertFalse(approval.whitelily$hasPendingApproval(null, profile));
    assertFalse(approval.whitelily$hasPendingApproval(server, null));
    assertTrue(approval.whitelily$takePendingApproval(server, profile));
  }

  @Test
  void rejectedLoginReachingTheNativeDisconnectClearsBothConnectionSlots() throws Exception {
    assertActualDisconnectInjectionClearsBothSlots();
  }

  @Test
  void directConnectionDisconnectClearsBothConnectionSlots() throws Exception {
    assertActualDisconnectInjectionClearsBothSlots();
  }

  @Test
  void playerPlacementThrowReachingTheNativeDisconnectClearsBothConnectionSlots() throws Exception {
    assertActualDisconnectInjectionClearsBothSlots();
  }

  private static void assertActualDisconnectInjectionClearsBothSlots() throws Exception {
    ConnectionMixinHarness connection = new ConnectionMixinHarness();
    Object server = new Object();
    UUID profile = WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID;
    connection.whitelily$setHandshakeProof("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 49_152);
    connection.whitelily$markPendingApproval(server, profile);

    Method clear =
        ConnectionMixin.class.getDeclaredMethod(
            "whitelily$clearBridgeConnectionState",
            net.minecraft.network.DisconnectionDetails.class,
            CallbackInfo.class);
    clear.setAccessible(true);
    clear.invoke(connection, null, new CallbackInfo("disconnect", false));

    assertFalse(connection.whitelily$takeHandshakeProof().isPresent());
    assertFalse(connection.whitelily$takePendingApproval(server, profile));
  }

  private static final class ConnectionMixinHarness extends ConnectionMixin {}
}
