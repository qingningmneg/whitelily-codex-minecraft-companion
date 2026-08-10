package io.github.whitelily.avatar;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

final class ModuleMetadataTest {
  @Test
  void pinsTheApprovedClientOnlyCompatibility() throws Exception {
    String json = Files.readString(Path.of("src/main/resources/fabric.mod.json"));
    assertTrue(json.contains("\"id\": \"whitelily_avatar\""));
    assertTrue(json.contains("\"environment\": \"client\""));
    assertTrue(json.contains("\"minecraft\": \"=1.21.5\""));
    assertTrue(json.contains("\"fabricloader\": \">=0.16.14\""));
    assertTrue(json.contains("\"whitelily_bridge\": \">=0.1.0\""));
    assertTrue(json.contains("\"geckolib\": \"=5.1.0\""));
  }

  @Test
  void publishesTheStableComponentVersion() {
    assertEquals("0.1.0", WhiteLilyAvatarClient.COMPONENT_VERSION);
  }

  @Test
  void expandsTheComponentVersionIntoProcessedFabricMetadata() throws Exception {
    String json = Files.readString(Path.of("build/resources/main/fabric.mod.json"));

    assertTrue(json.contains("\"version\": \"0.1.0\""), () -> json);
  }

  @Test
  void pinsTheGradleDistributionChecksum() throws Exception {
    String properties = Files.readString(Path.of("../gradle/wrapper/gradle-wrapper.properties"));
    assertTrue(properties.contains(
        "distributionSha256Sum=7a00d51fb93147819aab76024feece20b6b84e420694101f276be952e08bef03"));
  }

  @Test
  void mixinConfigurationNamesTheRefmapGeneratedByLoom() throws Exception {
    String json =
        Files.readString(Path.of("src/main/resources/whitelily_avatar.mixins.json"));

    assertTrue(json.contains("\"refmap\": \"whitelily-avatar-fabric-refmap.json\""));
  }
}
