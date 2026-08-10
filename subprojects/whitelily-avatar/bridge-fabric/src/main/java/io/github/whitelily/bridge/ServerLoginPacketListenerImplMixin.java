package io.github.whitelily.bridge;

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
abstract class ServerLoginPacketListenerImplMixin {
  @Shadow @Final MinecraftServer server;
  @Shadow @Final Connection connection;
  @Shadow String requestedUsername;

  @Shadow
  abstract void startClientVerification(GameProfile profile);

  @Inject(
      method = "handleHello(Lnet/minecraft/network/protocol/login/ServerboundHelloPacket;)V",
      at = @At("HEAD"),
      cancellable = true)
  private void whitelily$authorizeBridgeProfile(
      ServerboundHelloPacket packet, CallbackInfo callbackInfo) {
    boolean integrated = server instanceof IntegratedServer integratedServer && integratedServer.isPublished();
    int publishedPort = integrated ? ((IntegratedServer) server).getPort() : -1;
    int localPort = ((BridgeConnectionEndpointAccess) connection).whitelily$localPort();
    BridgeLoginDecision decision =
        BridgeRuntime.loginSelector()
            .select(
                (BridgeConnectionAccess) connection,
                integrated,
                BridgeNetworkAddresses.isLoopback(connection.getRemoteAddress()),
                localPort,
                publishedPort,
                packet.name(),
                System.currentTimeMillis());
    if (decision != BridgeLoginDecision.BRIDGE_OFFLINE_PROFILE) {
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
