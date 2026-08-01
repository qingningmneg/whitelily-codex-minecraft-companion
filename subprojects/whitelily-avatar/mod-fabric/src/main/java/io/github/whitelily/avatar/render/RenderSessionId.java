package io.github.whitelily.avatar.render;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.Objects;

public final class RenderSessionId {
  private static final int RANDOM_BYTES = 32;

  private final String matcherToken;
  private final long epoch;

  private RenderSessionId(String matcherToken, long epoch) {
    this.matcherToken = matcherToken;
    this.epoch = epoch;
  }

  static RenderSessionId generate(long epoch, SecureRandom secureRandom) {
    byte[] randomBytes = new byte[RANDOM_BYTES];
    secureRandom.nextBytes(randomBytes);
    return new RenderSessionId(
        Base64.getUrlEncoder().withoutPadding().encodeToString(randomBytes), epoch);
  }

  String matcherToken() {
    return matcherToken;
  }

  public long epoch() {
    return epoch;
  }

  @Override
  public boolean equals(Object other) {
    if (this == other) {
      return true;
    }
    if (!(other instanceof RenderSessionId that)) {
      return false;
    }
    return epoch == that.epoch && matcherToken.equals(that.matcherToken);
  }

  @Override
  public int hashCode() {
    return Objects.hash(matcherToken, epoch);
  }

  @Override
  public String toString() {
    return "RenderSessionId[epoch=" + epoch + ", token=<redacted>]";
  }
}
