package io.github.whitelily.avatar.render;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Optional;
import java.util.stream.Stream;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.item.ItemDisplayContext;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

final class WhiteLilyHeldItemSelectionTest {
  @ParameterizedTest(name = "{0}: main={1}, off={2}")
  @MethodSource("handMatrix")
  void mapsBothPhysicalAnchorsWithoutDroppingEitherInteractionHand(
      HumanoidArm mainArm,
      boolean mainPresent,
      boolean offPresent,
      InteractionHand rightHand,
      InteractionHand leftHand) {
    Optional<WhiteLilyHeldItemSelection> right =
        WhiteLilyHeldItemSelection.forBone(
            WhiteLilyHeldItemSelection.RIGHT_HAND_BONE,
            mainArm,
            !mainPresent,
            !offPresent);
    Optional<WhiteLilyHeldItemSelection> left =
        WhiteLilyHeldItemSelection.forBone(
            WhiteLilyHeldItemSelection.LEFT_HAND_BONE,
            mainArm,
            !mainPresent,
            !offPresent);

    assertSelection(
        right,
        rightHand,
        WhiteLilyHeldItemSelection.RIGHT_HAND_BONE,
        ItemDisplayContext.THIRD_PERSON_RIGHT_HAND);
    assertSelection(
        left,
        leftHand,
        WhiteLilyHeldItemSelection.LEFT_HAND_BONE,
        ItemDisplayContext.THIRD_PERSON_LEFT_HAND);
  }

  @Test
  void rejectsUnknownOrMissingBones() {
    assertTrue(
        WhiteLilyHeldItemSelection.forBone(
                "right_arm", HumanoidArm.RIGHT, false, false)
            .isEmpty());
    assertTrue(
        WhiteLilyHeldItemSelection.forBone(
                "held_item_left", HumanoidArm.RIGHT, false, false)
            .isEmpty());
    assertTrue(
        WhiteLilyHeldItemSelection.forBone(
                null, HumanoidArm.RIGHT, false, false)
            .isEmpty());
  }

  private static Stream<Arguments> handMatrix() {
    return Stream.of(
        Arguments.of(
            HumanoidArm.RIGHT,
            true,
            false,
            InteractionHand.MAIN_HAND,
            null),
        Arguments.of(
            HumanoidArm.RIGHT,
            false,
            true,
            null,
            InteractionHand.OFF_HAND),
        Arguments.of(
            HumanoidArm.RIGHT,
            true,
            true,
            InteractionHand.MAIN_HAND,
            InteractionHand.OFF_HAND),
        Arguments.of(HumanoidArm.RIGHT, false, false, null, null),
        Arguments.of(
            HumanoidArm.LEFT,
            true,
            false,
            null,
            InteractionHand.MAIN_HAND),
        Arguments.of(
            HumanoidArm.LEFT,
            false,
            true,
            InteractionHand.OFF_HAND,
            null),
        Arguments.of(
            HumanoidArm.LEFT,
            true,
            true,
            InteractionHand.OFF_HAND,
            InteractionHand.MAIN_HAND),
        Arguments.of(HumanoidArm.LEFT, false, false, null, null));
  }

  private static void assertSelection(
      Optional<WhiteLilyHeldItemSelection> actual,
      InteractionHand expectedHand,
      String expectedBone,
      ItemDisplayContext expectedContext) {
    if (expectedHand == null) {
      assertTrue(actual.isEmpty());
      return;
    }

    WhiteLilyHeldItemSelection selected = actual.orElseThrow();
    assertEquals(expectedHand, selected.interactionHand());
    assertEquals(expectedBone, selected.boneName());
    assertEquals(expectedContext, selected.displayContext());
  }
}
