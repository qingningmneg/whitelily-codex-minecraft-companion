package io.github.whitelily.avatar;

import io.github.whitelily.avatar.render.WeakNameModeControl;
import io.github.whitelily.avatar.render.WhiteLilyRenderRuntime;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientWorldEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;

public final class WhiteLilyAvatarClient implements ClientModInitializer {
  public static final String COMPONENT_VERSION = "0.1.0";

  private static final WhiteLilyRenderRuntime RENDER_RUNTIME =
      new WhiteLilyRenderRuntime();

  @Override
  public void onInitializeClient() {
    ClientPlayConnectionEvents.JOIN.register(
        (handler, sender, client) -> RENDER_RUNTIME.beginSession());
    ClientPlayConnectionEvents.DISCONNECT.register(
        (handler, client) -> RENDER_RUNTIME.endSession());
    ClientWorldEvents.AFTER_CLIENT_WORLD_CHANGE.register(
        (client, world) -> {
          if (world == null) {
            RENDER_RUNTIME.endSession();
          } else {
            RENDER_RUNTIME.beginSession();
          }
        });
  }

  public static WhiteLilyRenderRuntime renderRuntime() {
    return RENDER_RUNTIME;
  }

  public static WeakNameModeControl weakNameModeControl() {
    return RENDER_RUNTIME.weakNameModeControl();
  }
}
