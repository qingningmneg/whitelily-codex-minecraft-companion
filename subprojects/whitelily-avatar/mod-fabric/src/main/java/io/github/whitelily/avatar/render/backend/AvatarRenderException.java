package io.github.whitelily.avatar.render.backend;

public final class AvatarRenderException extends Exception {
  private final String code;

  public AvatarRenderException(String code, String message) {
    super(message);
    this.code = code;
  }

  public AvatarRenderException(String code, String message, Throwable cause) {
    super(message, cause);
    this.code = code;
  }

  public String code() {
    return code;
  }
}
