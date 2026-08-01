package io.github.whitelily.avatar.identity;

/**
 * Makes fail-closed visual identity decisions from a bounded, immutable player snapshot.
 *
 * <p>This matcher intentionally accepts only the supplied snapshot fields. Minecraft chat,
 * display text, scoreboard text, NBT, and skin URLs are not inputs to this decision.
 */
public final class WhiteLilyIdentityMatcher {
  private static final String TARGET_PROFILE_NAME = "WhiteLily";
  private static final String TARGET_TEAM_NAME = "whitelily_avatar";
  private static final int MAX_PROFILE_NAME_LENGTH = 16;
  private static final int MAX_WORLD_SESSION_LENGTH = 128;

  private final String currentWorldSession;

  /**
   * Creates a matcher bound to one opaque world-session token. Invalid configuration is retained
   * only as invalid state so that {@link #decide(PlayerIdentitySnapshot)} safely returns NONE.
   */
  public WhiteLilyIdentityMatcher(String currentWorldSession) {
    this.currentWorldSession = currentWorldSession;
  }

  public IdentityDecision decide(PlayerIdentitySnapshot snapshot) {
    if (snapshot == null
        || snapshot.playerId() == null
        || snapshot.localPlayer()
        || !isTargetProfileName(snapshot.profileName())
        || !isValidWorldSession(snapshot.worldSession())
        || !snapshot.worldSession().equals(currentWorldSession)
        || !isValidWorldSession(currentWorldSession)) {
      return IdentityDecision.NONE;
    }

    if (TARGET_TEAM_NAME.equals(snapshot.teamName())) {
      return IdentityDecision.FULL;
    }

    if (isMissingTeam(snapshot.teamName()) && snapshot.explicitWeakNameMode()) {
      return IdentityDecision.BASIC_NAME_ONLY;
    }

    return IdentityDecision.NONE;
  }

  @Override
  public String toString() {
    return "WhiteLilyIdentityMatcher[currentWorldSession=redacted]";
  }

  private static boolean isTargetProfileName(String profileName) {
    return isPlainProfileName(profileName) && TARGET_PROFILE_NAME.equals(profileName);
  }

  private static boolean isPlainProfileName(String profileName) {
    if (profileName == null
        || profileName.isEmpty()
        || profileName.length() > MAX_PROFILE_NAME_LENGTH) {
      return false;
    }

    for (int index = 0; index < profileName.length(); index++) {
      char character = profileName.charAt(index);
      if (!((character >= 'A' && character <= 'Z')
          || (character >= 'a' && character <= 'z')
          || (character >= '0' && character <= '9')
          || character == '_')) {
        return false;
      }
    }
    return true;
  }

  private static boolean isMissingTeam(String teamName) {
    return teamName == null || teamName.isEmpty();
  }

  private static boolean isValidWorldSession(String worldSession) {
    if (worldSession == null
        || worldSession.isEmpty()
        || worldSession.length() > MAX_WORLD_SESSION_LENGTH) {
      return false;
    }

    for (int index = 0; index < worldSession.length(); index++) {
      char character = worldSession.charAt(index);
      if (!((character >= 'A' && character <= 'Z')
          || (character >= 'a' && character <= 'z')
          || (character >= '0' && character <= '9')
          || character == '_'
          || character == '-')) {
        return false;
      }
    }
    return true;
  }
}
