package io.github.whitelily.avatar.render.backend;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

final class MinecraftAvatarRenderContextTest {
  @Test
  void failedOffscreenSkinningNeverSubmitsTheHeldItemBatch() {
    List<String> submissions = new ArrayList<>();

    assertThrows(
        IllegalStateException.class,
        () ->
            MinecraftAvatarRenderContext.commitPreparedDraws(
                () -> {
                  submissions.add("offscreen-skinning");
                  throw new IllegalStateException("draw failed");
                },
                () -> submissions.add("main-item-batch")));

    assertEquals(List.of("offscreen-skinning"), submissions);
  }

  @Test
  void successfulOffscreenSkinningPrecedesTheHeldItemBatch() {
    List<String> submissions = new ArrayList<>();

    MinecraftAvatarRenderContext.commitPreparedDraws(
        () -> submissions.add("offscreen-skinning"),
        () -> submissions.add("main-item-batch"));

    assertEquals(List.of("offscreen-skinning", "main-item-batch"), submissions);
  }
}
