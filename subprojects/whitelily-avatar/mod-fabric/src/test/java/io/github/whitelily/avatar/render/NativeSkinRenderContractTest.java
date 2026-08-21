package io.github.whitelily.avatar.render;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
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
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import java.util.function.Supplier;
import net.minecraft.SharedConstants;
import net.minecraft.client.renderer.entity.state.PlayerRenderState;
import net.minecraft.client.resources.PlayerSkin;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class NativeSkinRenderContractTest {
  @BeforeAll
  static void bootstrapMinecraftRegistries() {
    SharedConstants.tryDetectVersion();
    Bootstrap.bootStrap();
  }

  @Test
  void matchedDecisionAppliesTheBundledSkinToThePlayerRenderState() {
    WhiteLilySkinCatalog catalog = new WhiteLilySkinCatalog();
    WhiteLilyRenderDecision decision = matchedDecision(ArmorTheme.NETHERITE);
    PlayerRenderState state = stateWithOriginalSkin();

    assertDoesNotThrow(() -> apply(state, () -> decision, catalog::skinFor));

    assertSame(catalog.skinFor(ArmorTheme.NETHERITE), state.skin);
  }

  @Test
  void unmatchedDecisionLeavesTheEnteringVanillaSkinUntouched() {
    PlayerRenderState state = stateWithOriginalSkin();
    PlayerSkin original = state.skin;

    assertDoesNotThrow(
        () ->
            apply(
                state,
                WhiteLilyRenderDecision::vanilla,
                ignored -> {
                  throw new AssertionError("unmatched decisions must not resolve a native skin");
                }));

    assertSame(original, state.skin);
  }

  @Test
  void nullSkinResolutionLeavesTheEnteringVanillaSkinUntouched() {
    PlayerRenderState state = stateWithOriginalSkin();
    PlayerSkin original = state.skin;

    assertDoesNotThrow(
        () -> apply(state, () -> matchedDecision(ArmorTheme.GOLD), ignored -> null));

    assertSame(original, state.skin);
  }

  @Test
  void skinResolutionFailureRestoresTheEnteringSkinAndReportsOnce() {
    PlayerRenderState state = stateWithOriginalSkin();
    PlayerSkin original = state.skin;
    IllegalStateException failure = new IllegalStateException("catalog unavailable");
    AtomicInteger reportCount = new AtomicInteger();
    AtomicReference<RuntimeException> reported = new AtomicReference<>();

    NativeSkinStateApplication.ApplicationResult result =
        assertDoesNotThrow(
            () ->
                apply(
                    state,
                    () -> matchedDecision(ArmorTheme.GOLD),
                    ignored -> {
                      throw failure;
                    }));
    result.reportFailure(
        error -> {
          reportCount.incrementAndGet();
          reported.set(error);
        });

    assertSame(original, state.skin);
    assertEquals(1, reportCount.get());
    assertSame(failure, reported.get());
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

  private static PlayerRenderState stateWithOriginalSkin() {
    PlayerRenderState state = new PlayerRenderState();
    state.skin = originalSkin();
    return state;
  }

  private static NativeSkinStateApplication.ApplicationResult apply(
      PlayerRenderState state,
      Supplier<WhiteLilyRenderDecision> decision,
      Function<ArmorTheme, PlayerSkin> skinFor) {
    return NativeSkinStateApplication.apply(state, decision, skinFor);
  }

  private static boolean contains(JsonArray values, String expected) {
    for (int index = 0; index < values.size(); index++) {
      if (expected.equals(values.get(index).getAsString())) return true;
    }
    return false;
  }
}
