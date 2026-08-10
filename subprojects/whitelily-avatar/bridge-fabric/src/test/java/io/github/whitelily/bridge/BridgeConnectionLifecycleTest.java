package io.github.whitelily.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;

import java.lang.reflect.Method;
import java.util.UUID;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.junit.jupiter.api.Test;

class BridgeConnectionLifecycleTest {
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
