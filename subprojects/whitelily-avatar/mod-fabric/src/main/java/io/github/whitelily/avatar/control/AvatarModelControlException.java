package io.github.whitelily.avatar.control;

import java.io.IOException;

public final class AvatarModelControlException extends IOException {
  private final String code;

  public AvatarModelControlException(String code, String message) {
    super(message);
    this.code = code;
  }

  public AvatarModelControlException(String code, String message, Throwable cause) {
    super(message, cause);
    this.code = code;
  }

  public String code() {
    return code;
  }
}
