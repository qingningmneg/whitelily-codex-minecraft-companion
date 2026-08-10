package io.github.whitelily.bridge;

import io.netty.channel.Channel;
import java.net.InetSocketAddress;
import java.util.Optional;
import net.minecraft.network.Connection;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Connection.class)
abstract class ConnectionMixin
    implements BridgeConnectionAccess,
        BridgeConnectionEndpointAccess,
        BridgeConnectionApprovalAccess {
  @Shadow private Channel channel;

  @Unique private final HandshakeProofSlot whitelily$handshakeProof = new HandshakeProofSlot();
  @Unique private final PendingProfileApprovalSlot whitelily$pendingApproval =
      new PendingProfileApprovalSlot();

  @Override
  public void whitelily$setHandshakeProof(String nonce, int port) {
    whitelily$handshakeProof.whitelily$setHandshakeProof(nonce, port);
  }

  @Override
  public Optional<HandshakeProof> whitelily$takeHandshakeProof() {
    return whitelily$handshakeProof.whitelily$takeHandshakeProof();
  }

  @Override
  public void whitelily$clearHandshakeProof() {
    whitelily$handshakeProof.whitelily$clearHandshakeProof();
  }

  @Override
  public int whitelily$localPort() {
    if (channel == null || !(channel.localAddress() instanceof InetSocketAddress localAddress)) {
      return -1;
    }
    return localAddress.getPort();
  }

  @Override
  public void whitelily$markPendingApproval(Object server, java.util.UUID profileId) {
    whitelily$pendingApproval.whitelily$markPendingApproval(server, profileId);
  }

  @Override
  public boolean whitelily$takePendingApproval(Object server, java.util.UUID profileId) {
    return whitelily$pendingApproval.whitelily$takePendingApproval(server, profileId);
  }

  @Override
  public void whitelily$clearPendingApproval() {
    whitelily$pendingApproval.whitelily$clearPendingApproval();
  }

  @Inject(
      method = "disconnect(Lnet/minecraft/network/DisconnectionDetails;)V",
      at = @At("HEAD"))
  private void whitelily$clearBridgeConnectionState(
      net.minecraft.network.DisconnectionDetails details, CallbackInfo callbackInfo) {
    BridgeConnectionLifecycle.clear(this, this);
  }
}
