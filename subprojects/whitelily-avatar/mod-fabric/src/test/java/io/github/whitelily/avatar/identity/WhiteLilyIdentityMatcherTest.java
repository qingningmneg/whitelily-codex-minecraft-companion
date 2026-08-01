package io.github.whitelily.avatar.identity;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import java.util.UUID;
import org.junit.jupiter.api.Test;

final class WhiteLilyIdentityMatcherTest {
  private static final String SESSION = "world_session_20260729";
  private static final UUID PLAYER_ID = UUID.fromString("123e4567-e89b-12d3-a456-426614174000");

  private final WhiteLilyIdentityMatcher matcher = new WhiteLilyIdentityMatcher(SESSION);

  @Test
  void grantsFullOnlyToTheExactNamedRemotePlayerOnTheExactTargetTeamAndSession() {
    assertEquals(
        IdentityDecision.FULL,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", SESSION, false)));
  }

  @Test
  void grantsFullTargetTeamDecisionEvenWhenWeakNameModeIsEnabled() {
    assertEquals(
        IdentityDecision.FULL,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", SESSION, true)));
  }

  @Test
  void grantsBasicNameOnlyForEachMissingTeamRepresentationWhenWeakModeIsExplicit() {
    assertEquals(
        IdentityDecision.BASIC_NAME_ONLY,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, null, SESSION, true)));
    assertEquals(
        IdentityDecision.BASIC_NAME_ONLY,
        matcher.decide(
            snapshot(
                UUID.fromString("123e4567-e89b-12d3-a456-426614174001"),
                "WhiteLily",
                false,
                "",
                SESSION,
                true)));
  }

  @Test
  void refusesBasicNameOnlyWithoutExplicitWeakNameMode() {
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, null, SESSION, false)));
  }

  @Test
  void rejectsNonExactProfileNames() {
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "whitelily", false, "whitelily_avatar", SESSION, false)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily ", false, "whitelily_avatar", SESSION, false)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily\n", false, "whitelily_avatar", SESSION, false)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "白百合", false, "whitelily_avatar", SESSION, false)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "W".repeat(17), false, "whitelily_avatar", SESSION, false)));
  }

  @Test
  void rejectsMissingSnapshotMissingUuidAndTheLocalPlayer() {
    assertEquals(IdentityDecision.NONE, matcher.decide(null));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(null, "WhiteLily", false, "whitelily_avatar", SESSION, false)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", true, "whitelily_avatar", SESSION, false)));
  }

  @Test
  void requiresAnExactValidObservedSessionForBothDecisions() {
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", null, false)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, null, "", true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, null, "other_session", true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, null, SESSION + " ", true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, null, "session\u0000", true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, null, "会话", true)));
  }

  @Test
  void acceptsOnlyTheOneToOneHundredTwentyEightCharacterAsciiSessionRange() {
    String oneCharacterSession = "a";
    String maximumLengthSession = "a".repeat(128);

    assertEquals(
        IdentityDecision.FULL,
        new WhiteLilyIdentityMatcher(oneCharacterSession)
            .decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", oneCharacterSession, false)));
    assertEquals(
        IdentityDecision.FULL,
        new WhiteLilyIdentityMatcher(maximumLengthSession)
            .decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", maximumLengthSession, false)));
    assertEquals(
        IdentityDecision.NONE,
        new WhiteLilyIdentityMatcher("a".repeat(129))
            .decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", "a".repeat(129), false)));
  }

  @Test
  void failsClosedForMissingOrMalformedCurrentSessionConfiguration() {
    assertEquals(
        IdentityDecision.NONE,
        new WhiteLilyIdentityMatcher(null)
            .decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", SESSION, false)));
    assertEquals(
        IdentityDecision.NONE,
        new WhiteLilyIdentityMatcher("")
            .decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", "", false)));
    assertEquals(
        IdentityDecision.NONE,
        new WhiteLilyIdentityMatcher(" session")
            .decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", " session", false)));
    assertEquals(
        IdentityDecision.NONE,
        new WhiteLilyIdentityMatcher("session\u0001")
            .decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", "session\u0001", false)));
    assertEquals(
        IdentityDecision.NONE,
        new WhiteLilyIdentityMatcher("会话")
            .decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", "会话", false)));
  }

  @Test
  void treatsEveryNonEmptyNonTargetTeamAsConflictingEvenInWeakMode() {
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, "WHITELILY_AVATAR", SESSION, true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, " whitelily_avatar", SESSION, true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar ", SESSION, true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, " ", SESSION, true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar\u0000", SESSION, true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(PLAYER_ID, "WhiteLily", false, "other_team", SESSION, true)));
  }

  @Test
  void requiresFullRatherThanBasicNameOnlyForLaterPrivateActions() {
    IdentityDecision full = matcher.decide(
        snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", SESSION, false));
    IdentityDecision basic = matcher.decide(
        snapshot(PLAYER_ID, "WhiteLily", false, null, SESSION, true));

    assertEquals(IdentityDecision.FULL, full);
    assertNotEquals(IdentityDecision.FULL, basic);
  }

  @Test
  void remainsDeterministicAcrossRepeatedCalls() {
    PlayerIdentitySnapshot snapshot =
        snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", SESSION, false);

    assertEquals(IdentityDecision.FULL, matcher.decide(snapshot));
    assertEquals(IdentityDecision.FULL, matcher.decide(snapshot));
  }

  @Test
  void doesNotExposeWorldSessionTokensThroughStringRepresentations() {
    String secretSession = "private_world_session_314159";
    PlayerIdentitySnapshot snapshot =
        snapshot(PLAYER_ID, "WhiteLily", false, "whitelily_avatar", secretSession, false);
    WhiteLilyIdentityMatcher secretMatcher = new WhiteLilyIdentityMatcher(secretSession);

    assertFalse(snapshot.toString().contains(secretSession));
    assertFalse(secretMatcher.toString().contains(secretSession));
  }

  private static PlayerIdentitySnapshot snapshot(
      UUID playerId,
      String profileName,
      boolean localPlayer,
      String teamName,
      String worldSession,
      boolean explicitWeakNameMode) {
    return new PlayerIdentitySnapshot(
        playerId, profileName, localPlayer, teamName, worldSession, explicitWeakNameMode);
  }
}
