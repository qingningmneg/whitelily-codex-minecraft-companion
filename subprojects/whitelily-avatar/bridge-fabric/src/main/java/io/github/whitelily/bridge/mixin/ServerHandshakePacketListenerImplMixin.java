package io.github.whitelily.bridge.mixin;

import io.github.whitelily.bridge.BridgeConnectionAccess;
import io.github.whitelily.bridge.BridgeLoginSelector;
import io.github.whitelily.bridge.BridgeNetworkAddresses;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.handshake.ClientIntent;
import net.minecraft.network.protocol.handshake.ClientIntentionPacket;
import net.minecraft.server.network.ServerHandshakePacketListenerImpl;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ServerHandshakePacketListenerImpl.class)
public abstract class ServerHandshakePacketListenerImplMixin {
  @Shadow @Final private Connection connection;

  @Inject(
      method =
          "handleIntention(Lnet/minecraft/network/protocol/handshake/ClientIntentionPacket;)V",
      at = @At("HEAD"))
  private void whitelily$captureHandshakeProof(
      ClientIntentionPacket packet, CallbackInfo callbackInfo) {
    if (packet.intention() != ClientIntent.LOGIN) {
      return;
    }
    BridgeLoginSelector.captureHandshake(
        packet.hostName(),
        packet.port(),
        BridgeNetworkAddresses.isLoopback(connection.getRemoteAddress()),
        (BridgeConnectionAccess) connection);
  }
}
