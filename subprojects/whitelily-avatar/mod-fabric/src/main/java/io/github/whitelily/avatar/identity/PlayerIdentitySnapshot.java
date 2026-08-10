package io.github.whitelily.avatar.identity;

import java.util.UUID;

/** Immutable, renderer-facing player identity input with no live Minecraft dependencies. */
public final class PlayerIdentitySnapshot {
  private final UUID playerId;
  private final String profileName;
  private final boolean localPlayer;
  private final String worldSession;
  private final boolean bridgeApproved;

  public PlayerIdentitySnapshot(
      UUID playerId,
      String profileName,
      boolean localPlayer,
      String worldSession,
      boolean bridgeApproved) {
    this.playerId = playerId;
    this.profileName = profileName;
    this.localPlayer = localPlayer;
    this.worldSession = worldSession;
    this.bridgeApproved = bridgeApproved;
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

  public String worldSession() {
    return worldSession;
  }

  public boolean bridgeApproved() {
    return bridgeApproved;
  }

  @Override
  public String toString() {
    return "PlayerIdentitySnapshot[identity=redacted]";
  }
}
