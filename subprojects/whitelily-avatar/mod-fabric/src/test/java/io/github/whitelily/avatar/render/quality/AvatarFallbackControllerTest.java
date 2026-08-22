package io.github.whitelily.avatar.render.quality;

import static io.github.whitelily.avatar.render.quality.AvatarFallbackController.FailureType.ADVANCED_MATERIAL_FAILED;
import static io.github.whitelily.avatar.render.quality.AvatarFallbackController.FailureType.HIGH_MODEL_FAILED;
import static io.github.whitelily.avatar.render.quality.AvatarFallbackController.FailureType.SECONDARY_DYNAMICS_FAILED;
import static io.github.whitelily.avatar.render.quality.AvatarFallbackController.FallbackStage.BASIC_CEL;
import static io.github.whitelily.avatar.render.quality.AvatarFallbackController.FallbackStage.SAME_STYLE_LOW;
import static io.github.whitelily.avatar.render.quality.AvatarFallbackController.FallbackStage.VANILLA_FRAME_ONLY;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class AvatarFallbackControllerTest {
  @Test
  void followsTheOnlyAutomaticFallbackOrderAndNeverActivatesClassic() {
    AvatarFallbackController controller = new AvatarFallbackController();
    controller.beginNegotiation("session-one", "user:summer-dress");

    assertEquals(BASIC_CEL, controller.record(SECONDARY_DYNAMICS_FAILED));
    assertFalse(controller.currentState().secondaryDynamicsEnabled());
    assertFalse(controller.currentState().nonessentialTransparencyEnabled());
    assertEquals(SAME_STYLE_LOW, controller.record(ADVANCED_MATERIAL_FAILED));
    assertEquals(VANILLA_FRAME_ONLY, controller.record(HIGH_MODEL_FAILED));
    assertEquals("user:summer-dress", controller.activeModelId());
    assertFalse(controller.currentState().appearanceAccepted());
  }

  @Test
  void ignoresOutOfOrderFailuresInsteadOfSkippingARequiredFallbackStep() {
    AvatarFallbackController controller = new AvatarFallbackController();
    controller.beginNegotiation("session-one", "builtin:whitelily-hd");

    assertEquals(
        AvatarFallbackController.FallbackStage.FULL_QUALITY,
        controller.record(HIGH_MODEL_FAILED));
    assertEquals(BASIC_CEL, controller.record(SECONDARY_DYNAMICS_FAILED));
  }

  @Test
  void newSessionAndResourceReloadStartFromTheValidatedActiveModel() {
    AvatarFallbackController controller = new AvatarFallbackController();
    controller.beginNegotiation("session-one", "user:old");
    controller.record(SECONDARY_DYNAMICS_FAILED);
    controller.record(ADVANCED_MATERIAL_FAILED);
    controller.record(HIGH_MODEL_FAILED);

    controller.beginNegotiation("session-two", "user:validated");

    assertEquals(AvatarFallbackController.FallbackStage.FULL_QUALITY, controller.currentStage());
    assertEquals("user:validated", controller.activeModelId());
    assertTrue(controller.currentState().appearanceAccepted());
  }
}
