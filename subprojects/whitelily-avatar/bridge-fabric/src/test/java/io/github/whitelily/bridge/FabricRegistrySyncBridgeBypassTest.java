package io.github.whitelily.bridge;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.whitelily.bridge.mixin.RegistrySyncManagerMixin;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.UUID;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.PacketFlow;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import net.minecraft.server.network.ServerConfigurationPacketListenerImpl;
import org.junit.jupiter.api.Test;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import sun.misc.Unsafe;

@SuppressWarnings({"deprecation", "removal"})
class FabricRegistrySyncBridgeBypassTest {
  private static final Unsafe UNSAFE = unsafe();

  @Test
  void pendingWhiteLilyApprovalSkipsFabricRegistrySyncWithoutConsumingApproval()
      throws Exception {
    MinecraftServer server = allocate(IntegratedServer.class);
    TestConnection connection = new TestConnection();
    connection.whitelily$markPendingApproval(server, WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID);
    CallbackInfo callback = invoke(connection, server);

    assertTrue(callback.isCancelled());
    assertTrue(
        connection.whitelily$takePendingApproval(
            server, WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID));
  }

  @Test
  void ordinaryConnectionStillRunsFabricRegistrySync() throws Exception {
    CallbackInfo callback =
        invoke(new TestConnection(), allocate(IntegratedServer.class));

    assertFalse(callback.isCancelled());
  }

  private static CallbackInfo invoke(TestConnection connection, Object server) throws Exception {
    TestConfigurationHandler handler = allocate(TestConfigurationHandler.class);
    handler.connection = connection;
    CallbackInfo callback = new CallbackInfo("configureClient", true);
    Method method =
        RegistrySyncManagerMixin.class.getDeclaredMethod(
            "whitelily$skipApprovedBridgeRegistrySync",
            ServerConfigurationPacketListenerImpl.class,
            MinecraftServer.class,
            CallbackInfo.class);
    method.setAccessible(true);
    method.invoke(null, handler, server, callback);
    return callback;
  }

  private static Unsafe unsafe() {
    try {
      Field field = Unsafe.class.getDeclaredField("theUnsafe");
      field.setAccessible(true);
      return (Unsafe) field.get(null);
    } catch (ReflectiveOperationException failure) {
      throw new ExceptionInInitializerError(failure);
    }
  }

  private static <T> T allocate(Class<T> type) throws InstantiationException {
    return type.cast(UNSAFE.allocateInstance(type));
  }

  private static final class TestConfigurationHandler
      extends ServerConfigurationPacketListenerImpl
      implements io.github.whitelily.bridge.mixin.ServerCommonPacketListenerImplAccessor {
    private Connection connection;

    private TestConfigurationHandler() {
      super(null, null, null);
    }

    @Override
    public Connection whitelily$connection() {
      return connection;
    }
  }

  private static final class TestConnection extends Connection
      implements BridgeConnectionApprovalAccess {
    private final PendingProfileApprovalSlot approval = new PendingProfileApprovalSlot();

    private TestConnection() {
      super(PacketFlow.SERVERBOUND);
    }

    @Override
    public void whitelily$markPendingApproval(Object server, UUID profileId) {
      approval.whitelily$markPendingApproval(server, profileId);
    }

    @Override
    public boolean whitelily$hasPendingApproval(Object server, UUID profileId) {
      return approval.whitelily$hasPendingApproval(server, profileId);
    }

    @Override
    public boolean whitelily$takePendingApproval(Object server, UUID profileId) {
      return approval.whitelily$takePendingApproval(server, profileId);
    }

    @Override
    public void whitelily$clearPendingApproval() {
      approval.whitelily$clearPendingApproval();
    }
  }
}
