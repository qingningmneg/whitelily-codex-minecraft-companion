package io.github.whitelily.avatar.render.backend;

import java.util.Objects;
import java.util.regex.Pattern;

public record AvatarFrameResult(boolean successful, String errorCode) {
  private static final Pattern ERROR_CODE = Pattern.compile("^AVATAR_[A-Z0-9_]{1,64}$");

  public AvatarFrameResult {
    if (successful == (errorCode != null)
        || (errorCode != null && !ERROR_CODE.matcher(errorCode).matches())) {
      throw new IllegalArgumentException("invalid avatar frame result");
    }
  }

  public static AvatarFrameResult complete() {
    return new AvatarFrameResult(true, null);
  }

  public static AvatarFrameResult failed(String errorCode) {
    return new AvatarFrameResult(false, Objects.requireNonNull(errorCode, "errorCode"));
  }
}
