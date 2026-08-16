package io.github.whitelily.avatar.render;

import io.github.whitelily.avatar.WhiteLilyAvatarClient;
import io.github.whitelily.avatar.identity.IdentityDecision;
import io.github.whitelily.avatar.identity.PlayerIdentitySnapshot;
import io.github.whitelily.avatar.identity.WhiteLilyIdentityMatcher;
import io.github.whitelily.avatar.render.backend.AvatarVisualState;
import io.github.whitelily.avatar.theme.ArmorTheme;
import io.github.whitelily.avatar.theme.ArmorThemeResolver;
import io.github.whitelily.avatar.theme.EquipmentThemeInput;
import io.github.whitelily.bridge.WhiteLilyBridge;
import java.util.Locale;
import java.util.Optional;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.core.registries.BuiltInRegistries;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class WhiteLilyRenderRuntime {
  public static final String RENDER_FAILURE_CODE = "WL_AVATAR_RENDER_001";

  private static final Logger LOGGER =
      LoggerFactory.getLogger("whitelily_avatar");

  private final WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
  private final ArmorThemeResolver themeResolver = new ArmorThemeResolver();
  private final WhiteLilyRenderCoordinator coordinator =
      new WhiteLilyRenderCoordinator(
            new RendererSessionHealth(), () -> LOGGER.error(RENDER_FAILURE_CODE));

  public RenderSessionId beginSession() {
    return sessions.beginSession();
  }

  public void endSession() {
    sessions.endSession();
  }

  public WhiteLilyRenderDecision captureDecision(AbstractClientPlayer player) {
    Optional<RenderSessionId> current = sessions.currentSession();
    if (player == null || current.isEmpty()) {
      return WhiteLilyRenderDecision.vanilla();
    }

    RenderSessionId session = current.orElseThrow();
    String profileName = player.getGameProfile().getName();
    PlayerIdentitySnapshot identitySnapshot =
        new PlayerIdentitySnapshot(
            player.getUUID(),
            profileName,
            player == Minecraft.getInstance().player,
            session.matcherToken(),
            WhiteLilyBridge.isApprovedProfile(player.getUUID(), profileName));
    IdentityDecision identity =
        new WhiteLilyIdentityMatcher(session.matcherToken()).decide(identitySnapshot);
    EquipmentThemeInput equipment =
        EquipmentThemeInputAdapter.fromSlotIds(
            slot ->
                BuiltInRegistries.ITEM
                    .getKey(player.getItemBySlot(slot).getItem())
                    .toString());
    ArmorTheme theme = themeResolver.resolve(equipment);

    return WhiteLilyRenderDecision.capture(identity, theme, session, session);
  }

  public boolean runCustom(
      WhiteLilyRenderDecision decision, Runnable customOperation) {
    RenderSessionId current = sessions.currentSession().orElse(null);
    return coordinator.render(decision, current, customOperation);
  }

  public AvatarVisualState captureVisualState(
      AbstractClientPlayer player,
      float partialTick,
      WhiteLilyRenderDecision decision) {
    String worldSessionId =
        WhiteLilyAvatarClient.modelController() == null
            || WhiteLilyAvatarClient.modelController().currentWorldSessionId() == null
            ? "world-unbound"
            : WhiteLilyAvatarClient.modelController().currentWorldSessionId();
    String mainHand =
        BuiltInRegistries.ITEM.getKey(player.getMainHandItem().getItem()).toString();
    String offHand =
        BuiltInRegistries.ITEM.getKey(player.getOffhandItem().getItem()).toString();
    double distance =
        Minecraft.getInstance().getCameraEntity() == null
            ? 0.0
            : Minecraft.getInstance().getCameraEntity().distanceTo(player);
    return new AvatarVisualState(
        decision.renderSessionEpoch(),
        worldSessionId,
        player.getX(),
        player.getY(),
        player.getZ(),
        player.getYRot(),
        player.getXRot(),
        player.getPose().name().toLowerCase(Locale.ROOT),
        partialTick,
        player.tickCount + partialTick,
        decision.armorTheme(),
        mainHand,
        offHand,
        player.getDeltaMovement().horizontalDistanceSqr() > 0.0001,
        player.isSwimming(),
        player.isSleeping(),
        player.hurtTime > 0,
        false,
        false,
        "neutral",
        (float) distance,
        new AvatarVisualState.GraphicsCapabilities(true, true, 128));
  }

}
