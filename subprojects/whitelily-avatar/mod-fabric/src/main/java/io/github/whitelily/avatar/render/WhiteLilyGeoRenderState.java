package io.github.whitelily.avatar.render;

import com.mojang.blaze3d.vertex.PoseStack;
import io.github.whitelily.avatar.theme.ArmorTheme;
import java.util.IdentityHashMap;
import java.util.Map;
import net.minecraft.client.renderer.entity.state.LivingEntityRenderState;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.world.item.ShieldItem;
import org.joml.Matrix4f;
import org.jetbrains.annotations.Nullable;
import software.bernie.geckolib.constant.dataticket.DataTicket;
import software.bernie.geckolib.renderer.base.GeoRenderState;

public final class WhiteLilyGeoRenderState extends LivingEntityRenderState
    implements GeoRenderState {
  private final Map<DataTicket<?>, Object> geckoData = new IdentityHashMap<>();
  private ArmorTheme armorTheme = ArmorTheme.BASE;
  private WhiteLilyHeldItems heldItems;

  public ArmorTheme armorTheme() {
    return armorTheme;
  }

  public void setArmorTheme(ArmorTheme armorTheme) {
    this.armorTheme = armorTheme == null ? ArmorTheme.BASE : armorTheme;
  }

  WhiteLilyHeldItems heldItems() {
    return heldItems;
  }

  void setHeldItems(WhiteLilyHeldItems heldItems) {
    this.heldItems = heldItems;
  }

  public void renderSmoothHeldItems(
      PoseStack poseStack,
      Matrix4f leftHand,
      Matrix4f rightHand,
      MultiBufferSource bufferSource,
      int packedLight) {
    if (heldItems == null) return;
    for (WhiteLilyHeldItemRenderCandidate candidate :
        WhiteLilyHeldItemGeoLayer.candidates(heldItems)) {
      Matrix4f hand =
          WhiteLilyHeldItemSelection.LEFT_HAND_BONE.equals(candidate.boneName())
              ? leftHand
              : rightHand;
      poseStack.pushPose();
      try {
        poseStack.mulPose(hand);
        WhiteLilyHeldItemPose.withTransform(
            poseStack,
            candidate.boneName(),
            candidate.displayContext(),
            candidate.stack().getItem() instanceof ShieldItem,
            () ->
                Minecraft.getInstance()
                    .getItemRenderer()
                    .renderStatic(
                        candidate.stack(),
                        candidate.displayContext(),
                        packedLight,
                        OverlayTexture.NO_OVERLAY,
                        poseStack,
                        bufferSource,
                        Minecraft.getInstance().level,
                        0));
      } finally {
        poseStack.popPose();
      }
    }
  }

  @Override
  public <D> void addGeckolibData(DataTicket<D> dataTicket, @Nullable D data) {
    geckoData.put(dataTicket, data);
  }

  @Override
  public boolean hasGeckolibData(DataTicket<?> dataTicket) {
    return geckoData.containsKey(dataTicket);
  }

  @Nullable
  @Override
  @SuppressWarnings("unchecked")
  public <D> D getGeckolibData(DataTicket<D> dataTicket) {
    if (!geckoData.containsKey(dataTicket)) {
      throw new IllegalArgumentException("Missing GeckoLib render data");
    }
    return (D) geckoData.get(dataTicket);
  }

  @Override
  public Map<DataTicket<?>, Object> getDataMap() {
    return geckoData;
  }
}
