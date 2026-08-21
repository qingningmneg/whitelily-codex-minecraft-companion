package io.github.whitelily.avatar.render;

import io.github.whitelily.avatar.theme.ArmorTheme;
import java.util.function.Function;
import net.minecraft.client.resources.PlayerSkin;

/** Selects the skin that the vanilla player renderer should retain for one render state. */
public final class NativeSkinStateApplication {
  private NativeSkinStateApplication() {}

  public static PlayerSkin apply(
      PlayerSkin original,
      WhiteLilyRenderDecision decision,
      Function<ArmorTheme, PlayerSkin> skinFor) {
    if (decision == null || !decision.usesNativeSkin()) return original;
    try {
      PlayerSkin nativeSkin = skinFor.apply(decision.armorTheme());
      return nativeSkin == null ? original : nativeSkin;
    } catch (RuntimeException ignored) {
      return original;
    }
  }
}
