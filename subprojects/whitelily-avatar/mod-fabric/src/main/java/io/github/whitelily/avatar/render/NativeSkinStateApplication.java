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
      if (decision == null || !decision.usesNativeSkin()) return ApplicationResult.unchanged();
      PlayerSkin nativeSkin = skinFor.apply(decision.armorTheme());
      if (nativeSkin == null) return ApplicationResult.unchanged();
      playerRenderState.skin = nativeSkin;
      return ApplicationResult.applied();
    } catch (RuntimeException error) {
      playerRenderState.skin = original;
      return ApplicationResult.failure(error);
    }
  }

  public enum Status {
    APPLIED,
    UNCHANGED,
    FAILED
  }

  public static final class ApplicationResult {
    private static final ApplicationResult APPLIED =
        new ApplicationResult(Status.APPLIED, null);
    private static final ApplicationResult UNCHANGED =
        new ApplicationResult(Status.UNCHANGED, null);

    private final Status status;
    private final RuntimeException failure;

    private ApplicationResult(Status status, RuntimeException failure) {
      this.status = status;
      this.failure = failure;
    }

    private static ApplicationResult applied() {
      return APPLIED;
    }

    private static ApplicationResult unchanged() {
      return UNCHANGED;
    }

    private static ApplicationResult failure(RuntimeException error) {
      return new ApplicationResult(Status.FAILED, error);
    }

    public Status status() {
      return status;
    }

    public void onApplied(Runnable listener) {
      if (status == Status.APPLIED) listener.run();
    }

    public void reportFailure(Consumer<RuntimeException> reporter) {
      if (failure != null) reporter.accept(failure);
    }
  }
}
