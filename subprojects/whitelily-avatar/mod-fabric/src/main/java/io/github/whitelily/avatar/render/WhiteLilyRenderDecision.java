package io.github.whitelily.avatar.render;

import io.github.whitelily.avatar.identity.IdentityDecision;
import io.github.whitelily.avatar.theme.ArmorTheme;
import java.util.Objects;

public final class WhiteLilyRenderDecision {
  private final IdentityDecision identity;
  private final ArmorTheme armorTheme;
  private final RenderSessionId capturedSession;
  private final boolean nativeSkin;

  private WhiteLilyRenderDecision(
      IdentityDecision identity,
      ArmorTheme armorTheme,
      RenderSessionId capturedSession,
      boolean nativeSkin) {
    this.identity = identity;
    this.armorTheme = armorTheme;
    this.capturedSession = capturedSession;
    this.nativeSkin = nativeSkin;
  }

  public static WhiteLilyRenderDecision vanilla() {
    return new WhiteLilyRenderDecision(
        IdentityDecision.NONE, ArmorTheme.BASE, null, false);
  }

  public static WhiteLilyRenderDecision capture(
      IdentityDecision identity,
      ArmorTheme armorTheme,
      RenderSessionId capturedSession,
      RenderSessionId currentSession) {
    if (identity == null
        || identity != IdentityDecision.FULL
        || armorTheme == null
        || capturedSession == null
        || !capturedSession.equals(currentSession)) {
      return vanilla();
    }
    return new WhiteLilyRenderDecision(identity, armorTheme, capturedSession, true);
  }

  public boolean usesCustomRenderer() {
    return usesNativeSkin();
  }

  public boolean usesNativeSkin() {
    return nativeSkin;
  }

  public boolean canRenderCustomIn(RenderSessionId currentSession) {
    return nativeSkin && Objects.equals(capturedSession, currentSession);
  }

  public boolean expressionCapable() {
    return nativeSkin && identity == IdentityDecision.FULL;
  }

  public boolean hidesVanillaArmor() {
    return false;
  }

  public boolean rendersHeldItem() {
    return false;
  }

  public ArmorTheme armorTheme() {
    return armorTheme;
  }

  public long renderSessionEpoch() {
    return capturedSession == null ? 0L : capturedSession.epoch();
  }

  @Override
  public String toString() {
    return "WhiteLilyRenderDecision[identity="
        + identity
        + ", armorTheme="
        + armorTheme
        + ", nativeSkin="
        + nativeSkin
        + ", session=<redacted>]";
  }
}
