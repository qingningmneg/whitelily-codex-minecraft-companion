package io.github.whitelily.avatar.identity;

import java.util.UUID;

/** Immutable, renderer-facing player identity input with no live Minecraft dependencies. */
public final class PlayerIdentitySnapshot {
  private final UUID playerId;
  private final String profileName;
  private final boolean localPlayer;
  private final String teamName;
  private final String worldSession;
  private final boolean explicitWeakNameMode;

  public PlayerIdentitySnapshot(
      UUID playerId,
      String profileName,
      boolean localPlayer,
      String teamName,
      String worldSession,
      boolean explicitWeakNameMode) {
    this.playerId = playerId;
    this.profileName = profileName;
    this.localPlayer = localPlayer;
    this.teamName = teamName;
    this.worldSession = worldSession;
    this.explicitWeakNameMode = explicitWeakNameMode;
  }

  public UUID playerId() {
    return playerId;
  }

  public String profileName() {
    return profileName;
  }

  public boolean localPlayer() {
    return localPlayer;
  }

  public String teamName() {
    return teamName;
  }

  public String worldSession() {
    return worldSession;
  }

  public boolean explicitWeakNameMode() {
    return explicitWeakNameMode;
  }

  @Override
  public String toString() {
    return "PlayerIdentitySnapshot[identity=redacted]";
  }
}
