package io.github.whitelily.avatar.render;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.vertex.PoseStack;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Stream;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.item.ItemDisplayContext;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import org.joml.Matrix4f;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

final class WhiteLilyHeldItemLayerContractTest {
  @BeforeAll
  static void bootstrapMinecraftRegistries() {
    SharedConstants.tryDetectVersion();
    Bootstrap.bootStrap();
  }

  @ParameterizedTest(name = "{0}: main={1}, off={2}")
  @MethodSource("layerMatrix")
  void layerCandidatesPreserveBothStacksAndPhysicalAnchors(
      HumanoidArm mainArm,
      boolean mainPresent,
      boolean offPresent,
      InteractionHand rightHand,
      InteractionHand leftHand) {
    WhiteLilyHeldItems heldItems =
        WhiteLilyHeldItems.capture(
            mainPresent ? new ItemStack(Items.STICK) : ItemStack.EMPTY,
            offPresent ? new ItemStack(Items.SHIELD) : ItemStack.EMPTY,
            mainArm);

    List<WhiteLilyHeldItemRenderCandidate> candidates =
        WhiteLilyHeldItemGeoLayer.candidates(heldItems);

    assertLayerCandidate(
        candidates,
        WhiteLilyHeldItemSelection.RIGHT_HAND_BONE,
        rightHand,
        ItemDisplayContext.THIRD_PERSON_RIGHT_HAND);
    assertLayerCandidate(
        candidates,
        WhiteLilyHeldItemSelection.LEFT_HAND_BONE,
        leftHand,
        ItemDisplayContext.THIRD_PERSON_LEFT_HAND);
  }

  @Test
  void emptyHandsProduceNoLayerCandidates() {
    WhiteLilyHeldItems heldItems =
        WhiteLilyHeldItems.capture(
            ItemStack.EMPTY, ItemStack.EMPTY, HumanoidArm.RIGHT);

    assertTrue(WhiteLilyHeldItemGeoLayer.candidates(heldItems).isEmpty());
  }

  @Test
  void capturedStacksAreDefensiveAndRenderCandidatesCannotMutateState() {
    ItemStack main = new ItemStack(Items.STICK);
    ItemStack off = new ItemStack(Items.SHIELD);
    WhiteLilyHeldItems heldItems =
        WhiteLilyHeldItems.capture(main, off, HumanoidArm.LEFT);

    main.setCount(0);
    off.setCount(0);
    List<WhiteLilyHeldItemRenderCandidate> first =
        WhiteLilyHeldItemGeoLayer.candidates(heldItems);
    first.get(0).stack().setCount(0);
    first.get(1).stack().setCount(0);
    List<WhiteLilyHeldItemRenderCandidate> second =
        WhiteLilyHeldItemGeoLayer.candidates(heldItems);

    assertEquals(2, second.size());
    assertFalse(second.get(0).stack().isEmpty());
    assertFalse(second.get(1).stack().isEmpty());
    assertFalse(heldItems.toString().contains("minecraft:stick"));
    assertFalse(heldItems.toString().contains("minecraft:shield"));
  }

  @Test
  void leftAnchorOffsetMatchesTheMirroredHandPivotWithoutAddingABone()
      throws Exception {
    JsonObject geometry =
        JsonParser.parseString(
                Files.readString(
                    Path.of(
                        "src/main/resources/assets/whitelily_avatar/"
                            + "geckolib/models/whitelily.geo.json")))
            .getAsJsonObject();
    JsonArray bones =
        geometry
            .getAsJsonArray("minecraft:geometry")
            .get(0)
            .getAsJsonObject()
            .getAsJsonArray("bones");
    JsonObject leftArm = bone(bones, "left_arm");
    JsonObject rightAnchor = bone(bones, "held_item");
    JsonArray leftPivot = leftArm.getAsJsonArray("pivot");
    JsonArray rightPivot = rightAnchor.getAsJsonArray("pivot");

    assertEquals("right_arm", rightAnchor.get("parent").getAsString());
    assertTrue(findBone(bones, "held_item_left").isEmpty());
    assertEquals(
        (rightPivot.get(0).getAsDouble()
                + leftPivot.get(0).getAsDouble())
            / 16.0,
        WhiteLilyHeldItemPose.LEFT_HAND_OFFSET_X);
    assertEquals(
        (rightPivot.get(1).getAsDouble()
                - leftPivot.get(1).getAsDouble())
            / 16.0,
        WhiteLilyHeldItemPose.LEFT_HAND_OFFSET_Y);
    assertEquals(
        (rightPivot.get(2).getAsDouble()
                - leftPivot.get(2).getAsDouble())
            / 16.0,
        WhiteLilyHeldItemPose.LEFT_HAND_OFFSET_Z);
  }

  @Test
  void itemPoseTransformIsIsolatedFromFollowingBoneTasks() {
    PoseStack poseStack = new PoseStack();
    Matrix4f before = new Matrix4f(poseStack.last().pose());
    AtomicBoolean transformedInside = new AtomicBoolean();

    WhiteLilyHeldItemPose.withTransform(
        poseStack,
        WhiteLilyHeldItemSelection.LEFT_HAND_BONE,
        ItemDisplayContext.THIRD_PERSON_LEFT_HAND,
        false,
        () ->
            transformedInside.set(
                !before.equals(poseStack.last().pose())));

    assertTrue(transformedInside.get());
    assertEquals(before, poseStack.last().pose());
  }

  private static JsonObject bone(JsonArray bones, String name) {
    return findBone(bones, name).orElseThrow();
  }

  private static Stream<Arguments> layerMatrix() {
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

  private static java.util.Optional<JsonObject> findBone(
      JsonArray bones, String name) {
    for (var element : bones) {
      JsonObject bone = element.getAsJsonObject();
      if (name.equals(bone.get("name").getAsString())) {
        return java.util.Optional.of(bone);
      }
    }
    return java.util.Optional.empty();
  }

  private static void assertLayerCandidate(
      List<WhiteLilyHeldItemRenderCandidate> candidates,
      String bone,
      InteractionHand hand,
      ItemDisplayContext context) {
    Optional<WhiteLilyHeldItemRenderCandidate> candidate =
        candidates.stream()
            .filter(value -> bone.equals(value.boneName()))
            .findFirst();
    if (hand == null) {
      assertTrue(candidate.isEmpty());
      return;
    }

    WhiteLilyHeldItemRenderCandidate selected = candidate.orElseThrow();
    net.minecraft.world.item.Item expectedItem =
        hand == InteractionHand.MAIN_HAND ? Items.STICK : Items.SHIELD;
    assertEquals(bone, selected.boneName());
    assertEquals(hand, selected.interactionHand());
    assertEquals(expectedItem, selected.stack().getItem());
    assertEquals(context, selected.displayContext());
  }
}
