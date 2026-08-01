package io.github.whitelily.avatar.render;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.datafixers.util.Either;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.ItemDisplayContext;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ShieldItem;
import software.bernie.geckolib.cache.object.BakedGeoModel;
import software.bernie.geckolib.cache.object.GeoBone;
import software.bernie.geckolib.renderer.layer.BlockAndItemGeoLayer;

final class WhiteLilyHeldItemGeoLayer
    extends BlockAndItemGeoLayer<
        WhiteLilyAnimatable, AbstractClientPlayer, WhiteLilyGeoRenderState> {
  WhiteLilyHeldItemGeoLayer(WhiteLilyGeoRenderer renderer) {
    super(renderer);
  }

  @Override
  protected List<RenderData<WhiteLilyGeoRenderState>> getRelevantBones(
      WhiteLilyGeoRenderState renderState, BakedGeoModel model) {
    return candidates(renderState.heldItems()).stream()
        .map(
            candidate ->
                new RenderData<WhiteLilyGeoRenderState>(
                    candidate.boneName(),
                    candidate.displayContext(),
                    (bone, state) -> Either.left(candidate.stack())))
        .toList();
  }

  @Override
  public void addRenderData(
      WhiteLilyAnimatable animatable,
      AbstractClientPlayer player,
      WhiteLilyGeoRenderState renderState) {
    renderState.setHeldItems(
        WhiteLilyHeldItems.capture(
            player.getMainHandItem(),
            player.getOffhandItem(),
            player.getMainArm()));
  }

  @Override
  protected void renderStackForBone(
      PoseStack poseStack,
      GeoBone bone,
      ItemStack stack,
      ItemDisplayContext displayContext,
      WhiteLilyGeoRenderState renderState,
      MultiBufferSource bufferSource,
      int packedLight,
      int packedOverlay) {
    WhiteLilyHeldItemPose.withTransform(
        poseStack,
        bone.getName(),
        displayContext,
        stack.getItem() instanceof ShieldItem,
        () ->
            super.renderStackForBone(
                poseStack,
                bone,
                stack,
                displayContext,
                renderState,
                bufferSource,
                packedLight,
                packedOverlay));
  }

  static List<WhiteLilyHeldItemRenderCandidate> candidates(
      WhiteLilyHeldItems heldItems) {
    if (heldItems == null) {
      return List.of();
    }

    List<WhiteLilyHeldItemRenderCandidate> candidates = new ArrayList<>(2);
    addCandidate(
        candidates, heldItems, WhiteLilyHeldItemSelection.RIGHT_HAND_BONE);
    addCandidate(
        candidates, heldItems, WhiteLilyHeldItemSelection.LEFT_HAND_BONE);
    return List.copyOf(candidates);
  }

  private static void addCandidate(
      List<WhiteLilyHeldItemRenderCandidate> candidates,
      WhiteLilyHeldItems heldItems,
      String boneName) {
    WhiteLilyHeldItemSelection.forBone(
            boneName,
            heldItems.mainArm(),
            heldItems.isEmpty(InteractionHand.MAIN_HAND),
            heldItems.isEmpty(InteractionHand.OFF_HAND))
        .ifPresent(
            selection ->
                candidates.add(
                    new WhiteLilyHeldItemRenderCandidate(
                        selection.boneName(),
                        selection.interactionHand(),
                        heldItems.copyForRender(selection.interactionHand()),
                        selection.displayContext())));
  }
}
