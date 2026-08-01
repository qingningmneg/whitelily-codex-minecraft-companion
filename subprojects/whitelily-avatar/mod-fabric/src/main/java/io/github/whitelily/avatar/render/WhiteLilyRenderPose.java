package io.github.whitelily.avatar.render;

import com.mojang.blaze3d.vertex.PoseStack;

public final class WhiteLilyRenderPose {
  private WhiteLilyRenderPose() {}

  public static PoseStack independentCopy(PoseStack source) {
    PoseStack copy = new PoseStack();
    copy.last().pose().set(source.last().pose());
    copy.last().normal().set(source.last().normal());
    return copy;
  }
}
