package io.github.whitelily.bridge.mixin;

import io.github.whitelily.bridge.BridgeConnectionApprovalAccess;
import io.github.whitelily.bridge.WhiteLilyBridge;
import net.minecraft.network.Connection;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerConfigurationPacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Pseudo;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Pseudo
@Mixin(targets = "net.fabricmc.fabric.impl.registry.sync.RegistrySyncManager", remap = false)
public abstract class RegistrySyncManagerMixin {
  @Inject(method = "configureClient", at = @At("HEAD"), cancellable = true, require = 0)
  private static void whitelily$skipApprovedBridgeRegistrySync(
      ServerConfigurationPacketListenerImpl handler,
      MinecraftServer server,
      CallbackInfo callbackInfo) {
    Connection connection =
        ((ServerCommonPacketListenerImplAccessor) handler).whitelily$connection();
    if (connection instanceof BridgeConnectionApprovalAccess approval
        && approval.whitelily$hasPendingApproval(
            server, WhiteLilyBridge.WHITE_LILY_OFFLINE_UUID)) {
      callbackInfo.cancel();
    }
  }
}
