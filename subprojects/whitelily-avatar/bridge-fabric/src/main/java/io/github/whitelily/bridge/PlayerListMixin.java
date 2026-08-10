package io.github.whitelily.bridge;

import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.Connection;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.server.players.PlayerList;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(PlayerList.class)
abstract class PlayerListMixin {
  @Shadow @Final private MinecraftServer server;

  @Inject(
      method =
          "placeNewPlayer(Lnet/minecraft/network/Connection;Lnet/minecraft/server/level/ServerPlayer;Lnet/minecraft/server/network/CommonListenerCookie;)V",
      at = @At("TAIL"))
  private void whitelily$completeApprovedProfile(
      Connection connection,
      ServerPlayer player,
      CommonListenerCookie cookie,
      CallbackInfo callbackInfo) {
    if (server instanceof IntegratedServer integratedServer
        && WhiteLilyBridge.isCurrentPublishedIntegratedServer(integratedServer)) {
      ApprovedProfileRegistry.complete(
          (BridgeConnectionApprovalAccess) connection,
          server,
          player.getUUID(),
          player.getGameProfile().getName(),
          () -> WhiteLilyBridge.isCurrentPublishedIntegratedServer(integratedServer));
    }
  }

  @Inject(
      method = "remove(Lnet/minecraft/server/level/ServerPlayer;)V",
      at = @At("HEAD"))
  private void whitelily$revokeApprovedProfile(
      ServerPlayer player, CallbackInfo callbackInfo) {
    ApprovedProfileRegistry.revoke(server, player.getUUID());
  }
}
