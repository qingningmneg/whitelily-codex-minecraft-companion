package io.github.whitelily.avatar.control;

import java.util.LinkedHashMap;
import java.util.Map;

public record AvatarRuntimeDescriptor(
    String modelId,
    String origin,
    String format,
    String resourcePath,
    String sha256,
    Map<String, String> boneMapping,
    String bodyAnimation,
    String expressions) {
  public AvatarRuntimeDescriptor {
    boneMapping = Map.copyOf(new LinkedHashMap<>(boneMapping));
  }
}
