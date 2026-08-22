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
          "WhiteLily-LICENSE.txt",
          "WhiteLily-NOTICE.txt",
          "fabric-api-0.128.2+1.21.5.jar",
          "minecraft-components-manifest.json",
          "whitelily-avatar-fabric-1.21.5-0.1.1.jar",
          "whitelily-bridge-fabric-1.21.5-0.1.2.jar");

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
    assertEquals(3, manifest.getAsJsonArray("artifacts").size());
    assertEquals(3, manifest.getAsJsonArray("licenses").size());
    assertArtifact(
        manifest, 0, "bridge", "whitelily-bridge-fabric-1.21.5-0.1.2.jar", "whitelily_bridge", "0.1.2");
    assertArtifact(
        manifest, 1, "avatar", "whitelily-avatar-fabric-1.21.5-0.1.1.jar", "whitelily_avatar", "0.1.1");
    assertArtifact(
        manifest, 2, "avatar", "fabric-api-0.128.2+1.21.5.jar", "fabric-api", "0.128.2+1.21.5");
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
            .append("\", \"prior\": ");
        result.append('[');
        JsonArray priorEntries = entry.getAsJsonArray("prior");
        for (int priorIndex = 0; priorIndex < priorEntries.size(); priorIndex++) {
          JsonObject prior = priorEntries.get(priorIndex).getAsJsonObject();
          result
              .append("{\"fileName\": \"")
              .append(prior.get("fileName").getAsString())
              .append("\", \"bytes\": ")
              .append(prior.get("bytes").getAsLong())
              .append(", \"sha256\": \"")
              .append(prior.get("sha256").getAsString())
              .append("\", \"modId\": \"")
              .append(prior.get("modId").getAsString())
              .append("\", \"version\": \"")
              .append(prior.get("version").getAsString())
              .append("\"}");
          if (priorIndex + 1 < priorEntries.size()) result.append(',');
        }
        result.append(']');
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
    if (component.equals("bridge")) {
      JsonArray priorEntries = artifact.getAsJsonArray("prior");
      assertEquals(2, priorEntries.size());
      JsonObject prior = priorEntries.get(0).getAsJsonObject();
      assertEquals("whitelily-bridge-fabric-1.21.5-0.1.1.jar", prior.get("fileName").getAsString());
      assertEquals(52_087, prior.get("bytes").getAsLong());
      assertEquals(
          "8a6e00d47a28799798ffa5d561156ea7ceb0f697a0beb2cc7c55b34f6f81b514",
          prior.get("sha256").getAsString());
      assertEquals("whitelily_bridge", prior.get("modId").getAsString());
      assertEquals("0.1.1", prior.get("version").getAsString());
      JsonObject legacy = priorEntries.get(1).getAsJsonObject();
      assertEquals("whitelily-bridge-fabric-1.21.5-0.1.0.jar", legacy.get("fileName").getAsString());
      assertEquals(51_837, legacy.get("bytes").getAsLong());
      assertEquals(
          "380721d28236f5ad8206fd8d69af1e5629d741e9d38ec27c26c052c95266b6ce",
          legacy.get("sha256").getAsString());
      assertEquals("whitelily_bridge", legacy.get("modId").getAsString());
      assertEquals("0.1.0", legacy.get("version").getAsString());
    } else if (modId.equals("whitelily_avatar")) {
      JsonArray priorEntries = artifact.getAsJsonArray("prior");
      assertEquals(1, priorEntries.size());
      JsonObject prior = priorEntries.get(0).getAsJsonObject();
      assertEquals("whitelily-avatar-fabric-1.21.5-0.1.0.jar", prior.get("fileName").getAsString());
      assertEquals(239_985, prior.get("bytes").getAsLong());
      assertEquals(
          "1fdba2b89281d7dbfb96d8e2ab3637caf95b20452831377f46e5285d37531351",
          prior.get("sha256").getAsString());
      assertEquals("whitelily_avatar", prior.get("modId").getAsString());
      assertEquals("0.1.0", prior.get("version").getAsString());
    } else {
      assertEquals(0, artifact.getAsJsonArray("prior").size());
    }
  }

  private static String sha256(Path path) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(path)));
  }
}
