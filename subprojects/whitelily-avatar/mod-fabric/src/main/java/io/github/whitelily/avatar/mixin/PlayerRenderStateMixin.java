package io.github.whitelily.avatar.mixin;

import io.github.whitelily.avatar.render.WhiteLilyCapturedRender;
import io.github.whitelily.avatar.render.WhiteLilyPlayerRenderStateAccess;
import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;

@Mixin(PlayerRenderState.class)
public abstract class PlayerRenderStateMixin
    implements WhiteLilyPlayerRenderStateAccess {
  @Unique private WhiteLilyCapturedRender whitelily$capturedRender;

  @Override
  public WhiteLilyCapturedRender whitelily$getCapturedRender() {
    return whitelily$capturedRender;
  }

  @Override
  public void whitelily$setCapturedRender(WhiteLilyCapturedRender capturedRender) {
    whitelily$capturedRender = capturedRender;
  }
}
