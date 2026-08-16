package io.github.whitelily.avatar.render.quality;

import static io.github.whitelily.avatar.render.quality.AvatarDetailSelector.AvatarDetailLevel.HIGH;
import static io.github.whitelily.avatar.render.quality.AvatarDetailSelector.AvatarDetailLevel.LOW;
import static org.junit.jupiter.api.Assertions.assertEquals;

import io.github.whitelily.avatar.render.backend.AvatarVisualState;
import org.junit.jupiter.api.Test;

final class AvatarDetailSelectorTest {
  @Test
  void appliesFourteenEighteenBlockHysteresis() {
    AvatarDetailSelector selector = new AvatarDetailSelector();

    assertEquals(HIGH, selector.select(HIGH, 17.9f));
    assertEquals(LOW, selector.select(HIGH, 18.1f));
    assertEquals(LOW, selector.select(LOW, 14.1f));
    assertEquals(HIGH, selector.select(LOW, 13.9f));
  }

  @Test
  void selectsHighAtSixteenOrCloserForTheFirstObservation() {
    AvatarDetailSelector selector = new AvatarDetailSelector();

    assertEquals(HIGH, selector.select(null, 16.0f));
    assertEquals(LOW, selector.select(null, 16.01f));
  }

  @Test
  void selectsLowWhenGpuCannotSupportTheHighJointPalette() {
    AvatarDetailSelector selector = new AvatarDetailSelector();
    AvatarVisualState.GraphicsCapabilities constrained =
        new AvatarVisualState.GraphicsCapabilities(true, true, 127);

    assertEquals(LOW, selector.select(HIGH, 4.0f, constrained));
  }
}
