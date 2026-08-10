package io.github.whitelily.avatar.packaging;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

final class ComponentPackStagingTest {
  private static final Path REPOSITORY_ROOT = Path.of("..", "..", "..").toAbsolutePath().normalize();
  private static final Path STAGING = REPOSITORY_ROOT.resolve("build/minecraft-components");
  private static final Path MANIFEST = STAGING.resolve("minecraft-components-manifest.json");

  private static final List<String> EXACT_FILES =
      List.of(
          "Fabric-API-LICENSE.txt",
          "GeckoLib-LICENSE.txt",
          "WhiteLily-LICENSE.txt",
          "WhiteLily-NOTICE.txt",
          "fabric-api-0.128.2+1.21.5.jar",
          "geckolib-fabric-1.21.5-5.1.0.jar",
          "minecraft-components-manifest.json",
          "whitelily-avatar-fabric-1.21.5-0.1.0.jar",
          "whitelily-bridge-fabric-1.21.5-0.1.0.jar");

  @Test
  void stagesOnlyTheFixedPortableComponentAndLicenseFiles() throws Exception {
    List<String> names;
    try (var entries = Files.list(STAGING)) {
      names = entries.map(path -> path.getFileName().toString()).sorted().toList();
    }

    assertEquals(EXACT_FILES, names);
    for (String name : names) {
      Path staged = STAGING.resolve(name);
      assertTrue(Files.isRegularFile(staged));
      assertEquals(staged.toRealPath(), staged.toAbsolutePath().normalize());
    }
  }

  @Test
  void canonicalManifestPinsEveryStagedInputToItsActualBytesAndSha256() throws Exception {
    String text = Files.readString(MANIFEST, UTF_8);
    JsonObject manifest = JsonParser.parseString(text).getAsJsonObject();

    assertEquals(1, manifest.get("schemaVersion").getAsInt());
    assertEquals("1.21.5", manifest.get("minecraftVersion").getAsString());
    assertEquals(4, manifest.getAsJsonArray("artifacts").size());
    assertEquals(4, manifest.getAsJsonArray("licenses").size());
    assertArtifact(
        manifest, 0, "bridge", "whitelily-bridge-fabric-1.21.5-0.1.0.jar", "whitelily_bridge", "0.1.0");
    assertArtifact(
        manifest, 1, "avatar", "whitelily-avatar-fabric-1.21.5-0.1.0.jar", "whitelily_avatar", "0.1.0");
    assertArtifact(
        manifest, 2, "avatar", "fabric-api-0.128.2+1.21.5.jar", "fabric-api", "0.128.2+1.21.5");
    assertArtifact(
        manifest, 3, "avatar", "geckolib-fabric-1.21.5-5.1.0.jar", "geckolib", "5.1.0");
    for (var element : manifest.getAsJsonArray("licenses")) {
      assertEquals(Set.of("fileName", "bytes", "sha256"), element.getAsJsonObject().keySet());
    }
    assertEquals(text, canonicalManifest(manifest));

    for (String group : List.of("artifacts", "licenses")) {
      for (var element : manifest.getAsJsonArray(group)) {
        JsonObject entry = element.getAsJsonObject();
        Path file = STAGING.resolve(entry.get("fileName").getAsString());
        assertEquals(Files.size(file), entry.get("bytes").getAsLong());
        assertEquals(sha256(file), entry.get("sha256").getAsString());
      }
    }
  }

  @Test
  void stagedLicensesAreTheReviewedProjectAndEmbeddedThirdPartyInputs() throws Exception {
    assertEquals(
        Files.readString(REPOSITORY_ROOT.resolve("LICENSE"), UTF_8),
        Files.readString(STAGING.resolve("WhiteLily-LICENSE.txt"), UTF_8));
    assertEquals(
        Files.readString(REPOSITORY_ROOT.resolve("NOTICE"), UTF_8),
        Files.readString(STAGING.resolve("WhiteLily-NOTICE.txt"), UTF_8));
    assertArrayEquals(
        ComponentPackPolicy.readRequiredEntry(
            STAGING.resolve("fabric-api-0.128.2+1.21.5.jar"), "LICENSE-fabric-api"),
        Files.readAllBytes(STAGING.resolve("Fabric-API-LICENSE.txt")));
    assertArrayEquals(
        ComponentPackPolicy.readRequiredEntry(
            STAGING.resolve("geckolib-fabric-1.21.5-5.1.0.jar"), "LICENSE_GeckoLib 5"),
        Files.readAllBytes(STAGING.resolve("GeckoLib-LICENSE.txt")));
  }

  private static String canonicalManifest(JsonObject manifest) {
    StringBuilder result = new StringBuilder();
    result.append("{\n  \"schemaVersion\": 1,\n  \"minecraftVersion\": \"1.21.5\",\n");
    appendGroup(result, "artifacts", manifest.getAsJsonArray("artifacts"));
    result.append(",\n");
    appendGroup(result, "licenses", manifest.getAsJsonArray("licenses"));
    return result.append("\n}\n").toString();
  }

  private static void appendGroup(StringBuilder result, String name, JsonArray entries) {
    result.append("  \"").append(name).append("\": [\n");
    for (int index = 0; index < entries.size(); index++) {
      JsonObject entry = entries.get(index).getAsJsonObject();
      result.append("    {");
      if (name.equals("artifacts")) {
        result
            .append("\"component\": \"")
            .append(entry.get("component").getAsString())
            .append("\", ");
      }
      result
          .append("\"fileName\": \"")
          .append(entry.get("fileName").getAsString())
          .append("\", \"bytes\": ")
          .append(entry.get("bytes").getAsLong())
          .append(", \"sha256\": \"")
          .append(entry.get("sha256").getAsString())
          .append("\"");
      if (name.equals("artifacts")) {
        result
            .append(", \"modId\": \"")
            .append(entry.get("modId").getAsString())
            .append("\", \"version\": \"")
            .append(entry.get("version").getAsString())
            .append("\", \"prior\": []");
      }
      result.append('}');
      if (index + 1 < entries.size()) {
        result.append(',');
      }
      result.append('\n');
    }
    result.append("  ]");
  }

  private static void assertArtifact(
      JsonObject manifest,
      int index,
      String component,
      String fileName,
      String modId,
      String version) {
    JsonObject artifact = manifest.getAsJsonArray("artifacts").get(index).getAsJsonObject();
    assertEquals(
        Set.of("component", "fileName", "bytes", "sha256", "modId", "version", "prior"),
        artifact.keySet());
    assertEquals(component, artifact.get("component").getAsString());
    assertEquals(fileName, artifact.get("fileName").getAsString());
    assertEquals(modId, artifact.get("modId").getAsString());
    assertEquals(version, artifact.get("version").getAsString());
    assertEquals(0, artifact.getAsJsonArray("prior").size());
  }

  private static String sha256(Path path) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(path)));
  }
}
