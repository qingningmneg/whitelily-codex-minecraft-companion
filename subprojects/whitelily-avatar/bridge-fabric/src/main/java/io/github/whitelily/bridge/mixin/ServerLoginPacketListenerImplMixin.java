package io.github.whitelily.bridge.mixin;

import io.github.whitelily.bridge.BridgeConnectionAccess;
import io.github.whitelily.bridge.BridgeConnectionApprovalAccess;
import io.github.whitelily.bridge.BridgeConnectionEndpointAccess;
import io.github.whitelily.bridge.BridgeLoginDecision;
import io.github.whitelily.bridge.BridgeNetworkAddresses;
import io.github.whitelily.bridge.BridgeRuntime;
import io.github.whitelily.bridge.WhiteLilyBridge;
import com.mojang.authlib.GameProfile;
import java.util.UUID;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.UUIDUtil;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.login.ServerboundHelloPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerLoginPacketListenerImpl;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ServerLoginPacketListenerImpl.class)
public abstract class ServerLoginPacketListenerImplMixin {
  @Shadow @Final protected MinecraftServer server;
  @Shadow @Final protected Connection connection;
  @Shadow protected String requestedUsername;

  @Shadow
  protected abstract void startClientVerification(GameProfile profile);

  @Inject(
      method = "handleHello(Lnet/minecraft/network/protocol/login/ServerboundHelloPacket;)V",
      at =
          @At(
              value = "FIELD",
              target =
                  "Lnet/minecraft/server/network/ServerLoginPacketListenerImpl;requestedUsername:Ljava/lang/String;",
              opcode = org.objectweb.asm.Opcodes.PUTFIELD,
              shift = At.Shift.AFTER),
      cancellable = true)
  private void whitelily$authorizeBridgeProfile(
      ServerboundHelloPacket packet, CallbackInfo callbackInfo) {
    if (!WhiteLilyBridge.isCurrentPublishedIntegratedServer(server)) {
      return;
    }
    int publishedPort = ((IntegratedServer) server).getPort();
    int localPort = ((BridgeConnectionEndpointAccess) connection).whitelily$localPort();
    BridgeLoginDecision decision =
        BridgeRuntime.loginSelector()
            .select(
                (BridgeConnectionAccess) connection,
                true,
                BridgeNetworkAddresses.isLoopback(connection.getRemoteAddress()),
                localPort,
                publishedPort,
                packet.name(),
                System.currentTimeMillis());
    if (decision != BridgeLoginDecision.BRIDGE_OFFLINE_PROFILE
        || !WhiteLilyBridge.isCurrentPublishedIntegratedServer(server)) {
      return;
    }

    requestedUsername = WhiteLilyBridge.WHITE_LILY_USERNAME;
    UUID profileId = UUIDUtil.createOfflinePlayerUUID(WhiteLilyBridge.WHITE_LILY_USERNAME);
    BridgeConnectionApprovalAccess approval = (BridgeConnectionApprovalAccess) connection;
    approval.whitelily$markPendingApproval(server, profileId);
    try {
      startClientVerification(new GameProfile(profileId, WhiteLilyBridge.WHITE_LILY_USERNAME));
    } catch (RuntimeException | Error failure) {
      approval.whitelily$takePendingApproval(server, profileId);
      throw failure;
    }
    callbackInfo.cancel();
  }
}
