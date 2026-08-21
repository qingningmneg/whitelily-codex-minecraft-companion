package io.github.whitelily.avatar.render;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.github.whitelily.avatar.identity.IdentityDecision;
import io.github.whitelily.avatar.skin.WhiteLilySkinCatalog;
import io.github.whitelily.avatar.theme.ArmorTheme;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.function.Function;
import net.minecraft.client.resources.PlayerSkin;
import net.minecraft.resources.ResourceLocation;
import org.junit.jupiter.api.Test;

final class NativeSkinRenderContractTest {
  @Test
  void matchedDecisionSelectsTheBundledSkinForItsTheme() {
    WhiteLilySkinCatalog catalog = new WhiteLilySkinCatalog();
    WhiteLilyRenderDecision decision = matchedDecision(ArmorTheme.NETHERITE);
    PlayerSkin original = originalSkin();

    PlayerSkin applied =
        assertDoesNotThrow(() -> apply(original, decision, catalog::skinFor));

    assertSame(catalog.skinFor(ArmorTheme.NETHERITE), applied);
  }

  @Test
  void unmatchedDecisionLeavesTheEnteringVanillaSkinUntouched() {
    PlayerSkin original = originalSkin();

    PlayerSkin applied =
        assertDoesNotThrow(
            () ->
                apply(
                    original,
                    WhiteLilyRenderDecision.vanilla(),
                    ignored -> {
                      throw new AssertionError("unmatched decisions must not resolve a native skin");
                    }));

    assertSame(original, applied);
  }

  @Test
  void skinResolutionFailureLeavesTheEnteringVanillaSkinUntouched() {
    PlayerSkin original = originalSkin();

    PlayerSkin applied =
        assertDoesNotThrow(
            () ->
                apply(
                    original,
                    matchedDecision(ArmorTheme.GOLD),
                    ignored -> {
                      throw new IllegalStateException("catalog unavailable");
                    }));

    assertSame(original, applied);
  }

  @Test
  void parsedMixinConfigurationOnlyActivatesThePlayerRendererBoundary() throws Exception {
    JsonObject config;
    try (InputStream stream =
        NativeSkinRenderContractTest.class.getResourceAsStream("/whitelily_avatar.mixins.json")) {
      config =
          JsonParser.parseString(new String(stream.readAllBytes(), StandardCharsets.UTF_8))
              .getAsJsonObject();
    }

    JsonArray clientMixins = config.getAsJsonArray("client");

    assertTrue(contains(clientMixins, "PlayerRendererMixin"));
    assertFalse(contains(clientMixins, "LivingEntityRendererMixin"));
    assertFalse(contains(clientMixins, "PlayerRenderStateMixin"));
  }

  private static WhiteLilyRenderDecision matchedDecision(ArmorTheme theme) {
    WhiteLilyRenderSessions sessions = new WhiteLilyRenderSessions();
    RenderSessionId session = sessions.beginSession();
    return WhiteLilyRenderDecision.capture(IdentityDecision.FULL, theme, session, session);
  }

  private static PlayerSkin originalSkin() {
    return new PlayerSkin(
        ResourceLocation.withDefaultNamespace("textures/entity/player/wide/steve.png"),
        null,
        null,
        null,
        PlayerSkin.Model.WIDE,
        true);
  }

  private static PlayerSkin apply(
      PlayerSkin original,
      WhiteLilyRenderDecision decision,
      Function<ArmorTheme, PlayerSkin> skinFor) {
    return NativeSkinStateApplication.apply(original, decision, skinFor);
  }

  private static boolean contains(JsonArray values, String expected) {
    for (int index = 0; index < values.size(); index++) {
      if (expected.equals(values.get(index).getAsString())) return true;
    }
    return false;
  }
}
