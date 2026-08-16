package io.github.whitelily.avatar.render.diagnostics;

import java.util.Objects;
import java.util.regex.Pattern;

public record AvatarRenderDiagnostic(
    String assetVersion,
    String backend,
    String modelId,
    String detailLevel,
    String armorTheme,
    String materialTier,
    String sessionId,
    String errorCode,
    String sanitizedReason) {
  private static final int MAX_REASON_CODE_POINTS = 240;
  private static final Pattern USER_WINDOWS_PATH =
      Pattern.compile("(?i)[a-z]:\\\\(?:users|documents and settings)\\\\[^\\\\\\s]+(?:\\\\[^\\s]*)?");
  private static final Pattern USER_UNIX_PATH =
      Pattern.compile("(?i)/(?:users|home)/[^/\\s]+(?:/[^\\s]*)?");
  private static final Pattern TOKEN_VALUE =
      Pattern.compile("(?i)\\b(?:token|api[_-]?key|access[_-]?token|authorization)\\s*[=:]\\s*(?:bearer\\s+)?[^\\s,;]+|\\bbearer\\s+[^\\s,;]+");

  public AvatarRenderDiagnostic {
    assetVersion = required(assetVersion, "assetVersion");
    backend = required(backend, "backend");
    modelId = required(modelId, "modelId");
    detailLevel = required(detailLevel, "detailLevel");
    armorTheme = required(armorTheme, "armorTheme");
    materialTier = required(materialTier, "materialTier");
    sessionId = required(sessionId, "sessionId");
    errorCode = required(errorCode, "errorCode");
    sanitizedReason = sanitizeReason(sanitizedReason);
  }

  public static String sanitizeReason(String reason) {
    String withoutControls = Objects.requireNonNullElse(reason, "unknown").replaceAll("[\\p{Cc}\\p{Cf}]", " ");
    String withoutPaths = USER_UNIX_PATH.matcher(USER_WINDOWS_PATH.matcher(withoutControls).replaceAll("<user-path>")).replaceAll("<user-path>");
    String withoutTokens = TOKEN_VALUE.matcher(withoutPaths).replaceAll("<redacted-token>");
    String normalized = withoutTokens.replaceAll("\\s+", " ").trim();
    if (normalized.isEmpty()) normalized = "unknown";
    if (normalized.codePointCount(0, normalized.length()) <= MAX_REASON_CODE_POINTS) return normalized;
    int end = normalized.offsetByCodePoints(0, MAX_REASON_CODE_POINTS);
    return normalized.substring(0, end);
  }

  private static String required(String value, String name) {
    value = Objects.requireNonNull(value, name);
    if (value.isBlank()) throw new IllegalArgumentException(name + " must not be blank");
    return value;
  }
}
