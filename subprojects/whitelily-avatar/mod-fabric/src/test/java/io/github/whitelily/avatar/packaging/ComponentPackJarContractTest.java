package io.github.whitelily.avatar.packaging;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.UnaryOperator;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class ComponentPackJarContractTest {
  private static final Path STAGING =
      Path.of("..", "..", "..", "build", "minecraft-components")
          .toAbsolutePath()
          .normalize();
  private static final Path BRIDGE =
      STAGING.resolve("whitelily-bridge-fabric-1.21.5-0.1.2.jar");
  private static final Path AVATAR =
      STAGING.resolve("whitelily-avatar-fabric-1.21.5-0.1.0.jar");
  private static final Path FABRIC_API =
      STAGING.resolve("fabric-api-0.128.2+1.21.5.jar");
  private static final Path GECKOLIB =
      STAGING.resolve("geckolib-fabric-1.21.5-5.1.0.jar");

  private static final Set<String> AVATAR_THEME_RESOURCES =
      Set.of(
          "assets/whitelily_avatar/geckolib/models/whitelily.geo.json",
          "assets/whitelily_avatar/textures/entity/base.png",
          "assets/whitelily_avatar/textures/entity/leather.png",
          "assets/whitelily_avatar/textures/entity/iron.png",
          "assets/whitelily_avatar/textures/entity/gold.png",
          "assets/whitelily_avatar/textures/entity/diamond.png",
          "assets/whitelily_avatar/textures/entity/netherite.png",
          "assets/whitelily_avatar/textures/skin/base.png",
          "assets/whitelily_avatar/textures/skin/leather.png",
          "assets/whitelily_avatar/textures/skin/iron.png",
          "assets/whitelily_avatar/textures/skin/gold.png",
          "assets/whitelily_avatar/textures/skin/diamond.png",
          "assets/whitelily_avatar/textures/skin/netherite.png");

  @TempDir Path temporaryDirectory;

  @Test
  void realPackHasExactTopLevelMetadataUniqueRecursiveIdsAndReviewedContent() throws Exception {
    ComponentPackPolicy.inspectPack(exactPack());
  }

  @Test
  void bridgeAuthorityRemainsInItsOwnJarInsteadOfBeingCopiedIntoAvatar() throws Exception {
    assertFalse(hasEntryPrefix(AVATAR, "io/github/whitelily/bridge/"));
    assertFalse(hasEntryPrefix(BRIDGE, "io/github/whitelily/avatar/"));
  }

  @Test
  void changedBridgeDependencyIsRejectedByTheRealAvatarJarBoundary() throws Exception {
    Path mutated =
        rewrite(
            AVATAR,
            "fabric.mod.json",
            bytes ->
                replaceRequired(
                    bytes,
                    "\"whitelily_bridge\": \">=0.1.0\"",
                    "\"whitelily_bridge\": \">=9.0.0\""),
            null,
            Map.of());

    assertThrows(
        IOException.class,
        () -> ComponentPackPolicy.inspectComponent(mutated, avatarExpectation()));
  }

  @Test
  void missingOneOfTheSixReviewedThemesIsRejected() throws Exception {
    Path mutated =
        rewrite(
            AVATAR,
            null,
            UnaryOperator.identity(),
            "assets/whitelily_avatar/textures/entity/gold.png",
            Map.of());

    assertThrows(
        IOException.class,
        () -> ComponentPackPolicy.inspectComponent(mutated, avatarExpectation()));
  }

  @Test
  void executableOrNativePayloadIsRejectedAtAnyJarBoundary() throws Exception {
    Path mutated =
        rewrite(
            GECKOLIB,
            null,
            UnaryOperator.identity(),
            null,
            Map.of("native/payload.dll", new byte[] {1, 2, 3}));

    assertThrows(
        IOException.class,
        () -> ComponentPackPolicy.inspectComponent(mutated, geckoExpectation("geckolib")));
  }

  @Test
  void undeclaredNestedJarIsRejected() throws Exception {
    Path mutated =
        rewrite(
            AVATAR,
            null,
            UnaryOperator.identity(),
            null,
            Map.of("META-INF/jars/unreviewed.jar", minimalFabricJar("unreviewed", "1.0.0")));

    assertThrows(
        IOException.class,
        () -> ComponentPackPolicy.inspectComponent(mutated, avatarExpectation()));
  }

  @Test
  void duplicateModIdAcrossTopLevelArtifactsIsRejected() throws Exception {
    Path mutatedGecko =
        rewrite(
            GECKOLIB,
            "fabric.mod.json",
            bytes -> replaceRequired(bytes, "\"id\": \"geckolib\"", "\"id\": \"fabric-api\""),
            null,
            Map.of());
    LinkedHashMap<Path, ComponentPackPolicy.ExpectedMod> duplicatePack = exactPack();
    duplicatePack.remove(GECKOLIB);
    duplicatePack.put(mutatedGecko, geckoExpectation("fabric-api"));

    assertThrows(IOException.class, () -> ComponentPackPolicy.inspectPack(duplicatePack));
  }

  private static LinkedHashMap<Path, ComponentPackPolicy.ExpectedMod> exactPack() {
    LinkedHashMap<Path, ComponentPackPolicy.ExpectedMod> pack = new LinkedHashMap<>();
    pack.put(
        BRIDGE,
        new ComponentPackPolicy.ExpectedMod(
            "whitelily_bridge",
            "0.1.2",
            "client",
            Map.of("minecraft", "=1.21.5", "fabricloader", ">=0.16.14"),
            Set.of(),
            "LICENSE",
            false));
    pack.put(AVATAR, avatarExpectation());
    pack.put(
        FABRIC_API,
        new ComponentPackPolicy.ExpectedMod(
            "fabric-api",
            "0.128.2+1.21.5",
            "*",
            Map.of(
                "fabricloader", ">=0.16.10",
                "java", ">=21",
                "minecraft", ">=1.21.5- <1.21.6-"),
            Set.of(),
            "LICENSE-fabric-api",
            true));
    pack.put(GECKOLIB, geckoExpectation("geckolib"));
    return pack;
  }

  private static ComponentPackPolicy.ExpectedMod avatarExpectation() {
    return new ComponentPackPolicy.ExpectedMod(
        "whitelily_avatar",
        "0.1.0",
        "client",
        Map.of(
            "minecraft", "=1.21.5",
            "fabricloader", ">=0.16.14",
            "whitelily_bridge", ">=0.1.0",
            "fabric-api", ">=0.128.2+1.21.5",
            "geckolib", "=5.1.0"),
        AVATAR_THEME_RESOURCES,
        "LICENSE",
        false);
  }

  private static ComponentPackPolicy.ExpectedMod geckoExpectation(String id) {
    return new ComponentPackPolicy.ExpectedMod(
        id,
        "5.1.0",
        "*",
        Map.of(
            "fabricloader", ">=0.16",
            "fabric-api", ">=0.119.5+1.21.5",
            "java", ">=17",
            "minecraft", ">=1.21.5"),
        Set.of(),
        "LICENSE_GeckoLib 5",
        false);
  }

  private Path rewrite(
      Path source,
      String transformedEntry,
      UnaryOperator<byte[]> transform,
      String removedEntry,
      Map<String, byte[]> additions)
      throws Exception {
    Path target = temporaryDirectory.resolve("mutated-" + source.getFileName());
    try (ZipFile input = new ZipFile(source.toFile());
        ZipOutputStream output = new ZipOutputStream(Files.newOutputStream(target))) {
      var entries = input.entries();
      while (entries.hasMoreElements()) {
        ZipEntry entry = entries.nextElement();
        if (entry.getName().equals(removedEntry)) {
          continue;
        }
        output.putNextEntry(new ZipEntry(entry.getName()));
        if (!entry.isDirectory()) {
          byte[] bytes;
          try (InputStream stream = input.getInputStream(entry)) {
            bytes = stream.readAllBytes();
          }
          output.write(entry.getName().equals(transformedEntry) ? transform.apply(bytes) : bytes);
        }
        output.closeEntry();
      }
      for (var addition : additions.entrySet()) {
        output.putNextEntry(new ZipEntry(addition.getKey()));
        output.write(addition.getValue());
        output.closeEntry();
      }
    }
    return target;
  }

  private static byte[] replaceRequired(byte[] input, String before, String after) {
    String text = new String(input, UTF_8);
    String replaced = text.replace(before, after);
    assertNotEquals(text, replaced);
    return replaced.getBytes(UTF_8);
  }

  private static byte[] minimalFabricJar(String id, String version) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
      zip.putNextEntry(new ZipEntry("fabric.mod.json"));
      zip.write(
          ("{\"schemaVersion\":1,\"id\":\"" + id + "\",\"version\":\"" + version + "\"}")
              .getBytes(UTF_8));
      zip.closeEntry();
    }
    return bytes.toByteArray();
  }

  private static boolean hasEntryPrefix(Path jar, String prefix) throws IOException {
    try (ZipFile zip = new ZipFile(jar.toFile())) {
      return zip.stream().anyMatch(entry -> entry.getName().startsWith(prefix));
    }
  }
}
