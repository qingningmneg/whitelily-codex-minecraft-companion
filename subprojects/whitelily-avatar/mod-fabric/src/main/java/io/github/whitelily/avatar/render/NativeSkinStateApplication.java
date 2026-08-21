package io.github.whitelily.avatar.render;

import io.github.whitelily.avatar.theme.ArmorTheme;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;
import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import net.minecraft.client.resources.PlayerSkin;

/** Applies the native skin decision to the vanilla player render state. */
public final class NativeSkinStateApplication {
  private NativeSkinStateApplication() {}

  public static ApplicationResult apply(
      PlayerRenderState playerRenderState,
      Supplier<WhiteLilyRenderDecision> captureDecision,
      Function<ArmorTheme, PlayerSkin> skinFor) {
    PlayerSkin original = playerRenderState.skin;
    try {
      WhiteLilyRenderDecision decision = captureDecision.get();
      if (decision == null || !decision.usesNativeSkin()) return ApplicationResult.success();
      PlayerSkin nativeSkin = skinFor.apply(decision.armorTheme());
      if (nativeSkin != null) playerRenderState.skin = nativeSkin;
      return ApplicationResult.success();
    } catch (RuntimeException error) {
      playerRenderState.skin = original;
      return ApplicationResult.failure(error);
    }
  }

  public static final class ApplicationResult {
    private static final ApplicationResult SUCCESS = new ApplicationResult(null);

    private final RuntimeException failure;

    private ApplicationResult(RuntimeException failure) {
      this.failure = failure;
    }

    private static ApplicationResult success() {
      return SUCCESS;
    }

    private static ApplicationResult failure(RuntimeException error) {
      return new ApplicationResult(error);
    }

    public void reportFailure(Consumer<RuntimeException> reporter) {
      if (failure != null) reporter.accept(failure);
    }
  }
}
