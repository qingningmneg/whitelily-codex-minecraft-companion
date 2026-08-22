package io.github.whitelily.bridge.mixin;

import io.github.whitelily.bridge.ApprovedProfileRegistry;
import net.minecraft.server.MinecraftServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MinecraftServer.class)
public abstract class MinecraftServerMixin {
  @Inject(method = "stopServer()V", at = @At("HEAD"))
  private void whitelily$clearApprovedProfile(CallbackInfo callbackInfo) {
    ApprovedProfileRegistry.clearServer(this);
  }
}
