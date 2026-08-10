package io.github.whitelily.bridge;

import static java.nio.charset.StandardCharsets.UTF_8;

import java.util.UUID;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;

public final class WhiteLilyBridge {
  static final String WHITE_LILY_USERNAME = "WhiteLily";
  static final UUID WHITE_LILY_OFFLINE_UUID =
      UUID.nameUUIDFromBytes(("OfflinePlayer:" + WHITE_LILY_USERNAME).getBytes(UTF_8));

  private WhiteLilyBridge() {}

  public static boolean isApprovedProfile(UUID profileId, String profileName) {
    return isApprovedProfileForCurrentServer(
        Minecraft.getInstance().getSingleplayerServer(), profileId, profileName);
  }

  static boolean isApprovedProfileForCurrentServer(
      Object currentIntegratedServer, UUID profileId, String profileName) {
    return ApprovedProfileRegistry.isApproved(currentIntegratedServer, profileId, profileName);
  }

  static boolean isCurrentPublishedIntegratedServer(Object candidate) {
    if (!(candidate instanceof IntegratedServer integratedServer)) {
      return false;
    }
    try {
      Minecraft minecraft = Minecraft.getInstance();
      return minecraft != null
          && integratedServer == minecraft.getSingleplayerServer()
          && integratedServer.isPublished();
    } catch (RuntimeException ignored) {
      return false;
    }
  }
}
