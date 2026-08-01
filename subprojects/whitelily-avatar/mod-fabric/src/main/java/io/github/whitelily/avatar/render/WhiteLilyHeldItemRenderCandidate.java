package io.github.whitelily.avatar.render;

import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.ItemDisplayContext;
import net.minecraft.world.item.ItemStack;

record WhiteLilyHeldItemRenderCandidate(
    String boneName,
    InteractionHand interactionHand,
    ItemStack stack,
    ItemDisplayContext displayContext) {
  WhiteLilyHeldItemRenderCandidate {
    stack = stack.copy();
  }

  @Override
  public ItemStack stack() {
    return stack.copy();
  }
}
