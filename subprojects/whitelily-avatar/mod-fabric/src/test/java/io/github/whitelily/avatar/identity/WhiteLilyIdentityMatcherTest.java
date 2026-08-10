package io.github.whitelily.avatar.identity;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.util.UUID;
import org.junit.jupiter.api.Test;

final class WhiteLilyIdentityMatcherTest {
  private static final String CURRENT_SESSION = "world_session_20260811";
  private static final String STALE_SESSION = "world_session_20260810";
  private static final UUID APPROVED_ID =
      UUID.fromString("4c9f0cd1-8920-3a2d-b96a-ecfe5ebd8ab9");
  private static final UUID WRONG_ID =
      UUID.fromString("123e4567-e89b-12d3-a456-426614174000");

  private final WhiteLilyIdentityMatcher matcher =
      new WhiteLilyIdentityMatcher(CURRENT_SESSION);

  @Test
  void grantsFullOnlyToTheExactCurrentRemoteBridgeApprovedProfile() {
    assertEquals(
        IdentityDecision.FULL,
        matcher.decide(snapshot(APPROVED_ID, "WhiteLily", false, CURRENT_SESSION, true)));
  }

  @Test
  void remoteServerNameCollisionCannotRenderWithoutCurrentBridgeApproval() {
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "WhiteLily", false, CURRENT_SESSION, false)));
  }

  @Test
  void wrongUuidCannotRenderEvenIfASeparateProfileWasApproved() {
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(WRONG_ID, "WhiteLily", false, CURRENT_SESSION, false)));
  }

  @Test
  void staleOrDifferentIntegratedWorldSessionCannotRetainApproval() {
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "WhiteLily", false, STALE_SESSION, true)));
    assertEquals(
        IdentityDecision.NONE,
        new WhiteLilyIdentityMatcher(STALE_SESSION)
            .decide(snapshot(APPROVED_ID, "WhiteLily", false, CURRENT_SESSION, true)));
  }

  @Test
  void localPlayerNeverRendersAsWhiteLily() {
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "WhiteLily", true, CURRENT_SESSION, true)));
  }

  @Test
  void missingBridgeOrUnapprovedProfileCannotRender() {
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "WhiteLily", false, CURRENT_SESSION, false)));
  }

  @Test
  void exactApprovalCannotAuthorizeAnotherName() {
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "whiteLily", false, CURRENT_SESSION, true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "WhiteLily ", false, CURRENT_SESSION, true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "WhiteLily\n", false, CURRENT_SESSION, true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "白百合", false, CURRENT_SESSION, true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "W".repeat(17), false, CURRENT_SESSION, true)));
  }

  @Test
  void malformedOrMissingIdentityAndSessionFailClosed() {
    assertEquals(IdentityDecision.NONE, matcher.decide(null));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(null, "WhiteLily", false, CURRENT_SESSION, true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, null, false, CURRENT_SESSION, true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "WhiteLily", false, null, true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "WhiteLily", false, "", true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "WhiteLily", false, CURRENT_SESSION + " ", true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "WhiteLily", false, "session\u0000", true)));
    assertEquals(
        IdentityDecision.NONE,
        matcher.decide(snapshot(APPROVED_ID, "WhiteLily", false, "会话", true)));
  }

  @Test
  void malformedOrMissingCurrentSessionConfigurationFailsClosed() {
    for (String invalid : new String[] {null, "", " session", "session\u0001", "会话", "a".repeat(129)}) {
      assertEquals(
          IdentityDecision.NONE,
          new WhiteLilyIdentityMatcher(invalid)
              .decide(snapshot(APPROVED_ID, "WhiteLily", false, CURRENT_SESSION, true)));
    }
  }

  @Test
  void sessionBoundaryAcceptsOneThroughOneHundredTwentyEightAsciiCharacters() {
    String one = "a";
    String maximum = "a".repeat(128);

    assertEquals(
        IdentityDecision.FULL,
        new WhiteLilyIdentityMatcher(one)
            .decide(snapshot(APPROVED_ID, "WhiteLily", false, one, true)));
    assertEquals(
        IdentityDecision.FULL,
        new WhiteLilyIdentityMatcher(maximum)
            .decide(snapshot(APPROVED_ID, "WhiteLily", false, maximum, true)));
  }

  @Test
  void identityObjectsNeverExposeTheOpaqueWorldSession() {
    PlayerIdentitySnapshot snapshot =
        snapshot(APPROVED_ID, "WhiteLily", false, CURRENT_SESSION, true);

    assertFalse(snapshot.toString().contains(CURRENT_SESSION));
    assertFalse(matcher.toString().contains(CURRENT_SESSION));
  }

  private static PlayerIdentitySnapshot snapshot(
      UUID playerId,
      String profileName,
      boolean localPlayer,
      String worldSession,
      boolean bridgeApproved) {
    return new PlayerIdentitySnapshot(
        playerId, profileName, localPlayer, worldSession, bridgeApproved);
  }
}
