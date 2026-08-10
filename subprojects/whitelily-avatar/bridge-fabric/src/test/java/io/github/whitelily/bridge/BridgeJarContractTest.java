package io.github.whitelily.bridge;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;
import java.util.jar.JarFile;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

class BridgeJarContractTest {
  private static final String EXPECTED_JAR =
      "whitelily-bridge-fabric-1.21.5-0.1.0.jar";

  @Test
  void remappedJarHasTheExactClientOnlyDependencyAndMixinContract() throws Exception {
    Path expectedJar = Path.of(System.getProperty("whitelily.bridge.jar")).toAbsolutePath().normalize();
    Path libraryDirectory = expectedJar.getParent();
    Set<String> bridgeJars;
    try (var files = Files.list(libraryDirectory)) {
      bridgeJars =
          files
              .map(path -> path.getFileName().toString())
              .filter(name -> name.startsWith("whitelily-bridge-fabric-") && name.endsWith(".jar"))
              .collect(Collectors.toSet());
    }
    assertEquals(Set.of(EXPECTED_JAR), bridgeJars);

    assertEquals(EXPECTED_JAR, expectedJar.getFileName().toString());
    try (JarFile jar = new JarFile(expectedJar.toFile())) {
      Set<String> requiredEntries =
          Set.of(
              "fabric.mod.json",
              "whitelily_bridge.mixins.json",
              "whitelily-bridge-fabric-refmap.json",
              "LICENSE",
              "io/github/whitelily/bridge/WhiteLilyBridge.class",
              "io/github/whitelily/bridge/WhiteLilyBridgeClient.class",
              "io/github/whitelily/bridge/ConnectionMixin.class",
              "io/github/whitelily/bridge/ServerHandshakePacketListenerImplMixin.class",
              "io/github/whitelily/bridge/ServerLoginPacketListenerImplMixin.class",
              "io/github/whitelily/bridge/MinecraftServerMixin.class",
              "io/github/whitelily/bridge/PlayerListMixin.class");
      for (String entry : requiredEntries) {
        assertNotNull(jar.getJarEntry(entry), entry);
      }

      JsonObject metadata = json(jar, "fabric.mod.json");
      assertEquals(
          Set.of(
              "schemaVersion",
              "id",
              "version",
              "name",
              "environment",
              "entrypoints",
              "mixins",
              "depends"),
          metadata.keySet());
      assertEquals(1, metadata.get("schemaVersion").getAsInt());
      assertEquals("whitelily_bridge", metadata.get("id").getAsString());
      assertEquals("0.1.0", metadata.get("version").getAsString());
      assertEquals("client", metadata.get("environment").getAsString());
      assertExactStrings(
          metadata.getAsJsonObject("entrypoints").getAsJsonArray("client"),
          Set.of("io.github.whitelily.bridge.WhiteLilyBridgeClient"));
      assertExactStrings(
          metadata.getAsJsonArray("mixins"), Set.of("whitelily_bridge.mixins.json"));
      JsonObject dependencies = metadata.getAsJsonObject("depends");
      assertEquals(Set.of("minecraft", "fabricloader"), dependencies.keySet());
      assertEquals("=1.21.5", dependencies.get("minecraft").getAsString());
      assertEquals(">=0.16.14", dependencies.get("fabricloader").getAsString());
      String metadataText = metadata.toString().toLowerCase(java.util.Locale.ROOT);
      assertFalse(metadataText.contains("fabric-api"));
      assertFalse(metadataText.contains("geckolib"));

      JsonObject mixins = json(jar, "whitelily_bridge.mixins.json");
      assertEquals(
          Set.of("required", "package", "compatibilityLevel", "refmap", "client", "injectors"),
          mixins.keySet());
      assertTrue(mixins.get("required").getAsBoolean());
      assertEquals("io.github.whitelily.bridge", mixins.get("package").getAsString());
      assertEquals("JAVA_21", mixins.get("compatibilityLevel").getAsString());
      assertEquals(
          "whitelily-bridge-fabric-refmap.json", mixins.get("refmap").getAsString());
      assertExactStrings(
          mixins.getAsJsonArray("client"),
          Set.of(
              "ConnectionMixin",
              "ServerHandshakePacketListenerImplMixin",
              "ServerLoginPacketListenerImplMixin",
              "MinecraftServerMixin",
              "PlayerListMixin"));
      assertEquals(1, mixins.getAsJsonObject("injectors").get("defaultRequire").getAsInt());

      JsonObject refmap = json(jar, "whitelily-bridge-fabric-refmap.json");
      JsonObject mappings = refmap.getAsJsonObject("mappings");
      assertNotNull(mappings);
      assertEquals(
          "Lnet/minecraft/class_3246;method_12576(Lnet/minecraft/class_2889;)V",
          mapping(
              mappings,
              "io/github/whitelily/bridge/ServerHandshakePacketListenerImplMixin",
              "handleIntention(Lnet/minecraft/network/protocol/handshake/ClientIntentionPacket;)V"));
      assertEquals(
          "Lnet/minecraft/class_3248;method_12641(Lnet/minecraft/class_2915;)V",
          mapping(
              mappings,
              "io/github/whitelily/bridge/ServerLoginPacketListenerImplMixin",
              "handleHello(Lnet/minecraft/network/protocol/login/ServerboundHelloPacket;)V"));
      assertEquals(
          "Lnet/minecraft/server/MinecraftServer;method_3782()V",
          mapping(
              mappings,
              "io/github/whitelily/bridge/MinecraftServerMixin",
              "stopServer()V"));
      assertEquals(
          "Lnet/minecraft/class_3324;method_14570(Lnet/minecraft/class_2535;Lnet/minecraft/class_3222;Lnet/minecraft/class_8792;)V",
          mapping(
              mappings,
              "io/github/whitelily/bridge/PlayerListMixin",
              "placeNewPlayer(Lnet/minecraft/network/Connection;Lnet/minecraft/server/level/ServerPlayer;Lnet/minecraft/server/network/CommonListenerCookie;)V"));
      assertEquals(
          "Lnet/minecraft/class_3324;method_14611(Lnet/minecraft/class_3222;)V",
          mapping(
              mappings,
              "io/github/whitelily/bridge/PlayerListMixin",
              "remove(Lnet/minecraft/server/level/ServerPlayer;)V"));
      assertEquals(
          Files.readString(Path.of(System.getProperty("whitelily.license")), UTF_8),
          read(jar, "LICENSE"));
      assertFalse(
          jar.stream()
              .map(entry -> entry.getName().toLowerCase(java.util.Locale.ROOT))
              .anyMatch(name -> name.contains("fabric-api") || name.contains("geckolib")));
    }
  }

  private static JsonObject json(JarFile jar, String name) throws Exception {
    return JsonParser.parseString(read(jar, name)).getAsJsonObject();
  }

  private static String read(JarFile jar, String name) throws Exception {
    try (InputStream input = jar.getInputStream(jar.getJarEntry(name))) {
      return new String(input.readAllBytes(), UTF_8);
    }
  }

  private static void assertExactStrings(JsonArray array, Set<String> expected) {
    assertEquals(expected.size(), array.size());
    assertEquals(
        expected,
        array.asList().stream().map(element -> element.getAsString()).collect(Collectors.toSet()));
  }

  private static String mapping(JsonObject mappings, String owner, String method) {
    return mappings.getAsJsonObject(owner).get(method).getAsString();
  }
}
