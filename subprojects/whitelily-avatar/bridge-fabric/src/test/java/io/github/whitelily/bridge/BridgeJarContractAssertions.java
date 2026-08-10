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

final class BridgeJarContractAssertions {
  private static final String EXPECTED_JAR = "whitelily-bridge-fabric-1.21.5-0.1.0.jar";
  private static final Set<String> EXACT_ENTRIES =
      Set.of(
          "META-INF/",
          "META-INF/MANIFEST.MF",
          "LICENSE",
          "fabric.mod.json",
          "whitelily_bridge.mixins.json",
          "whitelily-bridge-fabric-refmap.json",
          "io/",
          "io/github/",
          "io/github/whitelily/",
          "io/github/whitelily/bridge/",
          "io/github/whitelily/bridge/ApprovedProfileRegistry$Approval.class",
          "io/github/whitelily/bridge/ApprovedProfileRegistry.class",
          "io/github/whitelily/bridge/BridgeAuthorizationContext.class",
          "io/github/whitelily/bridge/BridgeAuthorizationPolicy.class",
          "io/github/whitelily/bridge/BridgeConnectionAccess.class",
          "io/github/whitelily/bridge/BridgeConnectionApprovalAccess.class",
          "io/github/whitelily/bridge/BridgeConnectionEndpointAccess.class",
          "io/github/whitelily/bridge/BridgeLoginDecision.class",
          "io/github/whitelily/bridge/BridgeLoginSelector.class",
          "io/github/whitelily/bridge/BridgeNetworkAddresses.class",
          "io/github/whitelily/bridge/BridgePresencePublisher.class",
          "io/github/whitelily/bridge/BridgeProofStore.class",
          "io/github/whitelily/bridge/BridgeRequest.class",
          "io/github/whitelily/bridge/BridgeRuntime.class",
          "io/github/whitelily/bridge/ConnectionMixin.class",
          "io/github/whitelily/bridge/HandshakeProof.class",
          "io/github/whitelily/bridge/HandshakeProofSlot.class",
          "io/github/whitelily/bridge/MinecraftServerMixin.class",
          "io/github/whitelily/bridge/PendingProfileApprovalSlot$Candidate.class",
          "io/github/whitelily/bridge/PendingProfileApprovalSlot.class",
          "io/github/whitelily/bridge/PlayerListMixin.class",
          "io/github/whitelily/bridge/ServerHandshakePacketListenerImplMixin.class",
          "io/github/whitelily/bridge/ServerLoginPacketListenerImplMixin.class",
          "io/github/whitelily/bridge/WhiteLilyBridge.class",
          "io/github/whitelily/bridge/WhiteLilyBridgeClient.class",
          "io/github/whitelily/bridge/WindowsOwnedFile$Identity.class",
          "io/github/whitelily/bridge/WindowsOwnedFile.class");

  private BridgeJarContractAssertions() {}

  static void assertExact(Path jarPath, Path licensePath) throws Exception {
    assertEquals(EXPECTED_JAR, jarPath.getFileName().toString());
    try (JarFile jar = new JarFile(jarPath.toFile())) {
      Set<String> entries =
          jar.stream().map(entry -> entry.getName()).collect(Collectors.toSet());
      assertForbiddenPackagesAbsent(entries);
      assertEquals(EXACT_ENTRIES, entries);
      assertEquals(EXACT_ENTRIES.size(), jar.size());

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
      assertEquals("WhiteLily Bridge", metadata.get("name").getAsString());
      assertEquals("client", metadata.get("environment").getAsString());
      JsonObject entrypoints = metadata.getAsJsonObject("entrypoints");
      assertEquals(Set.of("client"), entrypoints.keySet());
      assertExactStrings(
          entrypoints.getAsJsonArray("client"),
          Set.of("io.github.whitelily.bridge.WhiteLilyBridgeClient"));
      assertExactStrings(
          metadata.getAsJsonArray("mixins"), Set.of("whitelily_bridge.mixins.json"));
      JsonObject dependencies = metadata.getAsJsonObject("depends");
      assertEquals(Set.of("minecraft", "fabricloader"), dependencies.keySet());
      assertEquals("=1.21.5", dependencies.get("minecraft").getAsString());
      assertEquals(">=0.16.14", dependencies.get("fabricloader").getAsString());

      JsonObject mixins = json(jar, "whitelily_bridge.mixins.json");
      assertEquals(
          Set.of("required", "package", "compatibilityLevel", "refmap", "client", "injectors"),
          mixins.keySet());
      assertTrue(mixins.get("required").getAsBoolean());
      assertEquals("io.github.whitelily.bridge", mixins.get("package").getAsString());
      assertEquals("JAVA_21", mixins.get("compatibilityLevel").getAsString());
      assertEquals("whitelily-bridge-fabric-refmap.json", mixins.get("refmap").getAsString());
      assertExactStrings(
          mixins.getAsJsonArray("client"),
          Set.of(
              "ConnectionMixin",
              "ServerHandshakePacketListenerImplMixin",
              "ServerLoginPacketListenerImplMixin",
              "MinecraftServerMixin",
              "PlayerListMixin"));
      JsonObject injectors = mixins.getAsJsonObject("injectors");
      assertEquals(Set.of("defaultRequire"), injectors.keySet());
      assertEquals(1, injectors.get("defaultRequire").getAsInt());

      JsonObject refmap = json(jar, "whitelily-bridge-fabric-refmap.json");
      assertEquals(Set.of("mappings", "data"), refmap.keySet());
      JsonObject mappings = refmap.getAsJsonObject("mappings");
      assertNotNull(mappings);
      assertEquals(
          Set.of(
              "io/github/whitelily/bridge/MinecraftServerMixin",
              "io/github/whitelily/bridge/PlayerListMixin",
              "io/github/whitelily/bridge/ServerHandshakePacketListenerImplMixin",
              "io/github/whitelily/bridge/ServerLoginPacketListenerImplMixin"),
          mappings.keySet());
      assertEquals(
          Set.of("stopServer()V"),
          mappings.getAsJsonObject("io/github/whitelily/bridge/MinecraftServerMixin").keySet());
      assertEquals(
          Set.of(
              "placeNewPlayer(Lnet/minecraft/network/Connection;Lnet/minecraft/server/level/ServerPlayer;Lnet/minecraft/server/network/CommonListenerCookie;)V",
              "remove(Lnet/minecraft/server/level/ServerPlayer;)V"),
          mappings.getAsJsonObject("io/github/whitelily/bridge/PlayerListMixin").keySet());
      assertEquals(
          Set.of(
              "handleIntention(Lnet/minecraft/network/protocol/handshake/ClientIntentionPacket;)V"),
          mappings
              .getAsJsonObject(
                  "io/github/whitelily/bridge/ServerHandshakePacketListenerImplMixin")
              .keySet());
      assertEquals(
          Set.of("handleHello(Lnet/minecraft/network/protocol/login/ServerboundHelloPacket;)V"),
          mappings
              .getAsJsonObject("io/github/whitelily/bridge/ServerLoginPacketListenerImplMixin")
              .keySet());
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
          mapping(mappings, "io/github/whitelily/bridge/MinecraftServerMixin", "stopServer()V"));
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
          mappings,
          refmap
              .getAsJsonObject("data")
              .getAsJsonObject("named:intermediary"));
      assertEquals(Set.of("named:intermediary"), refmap.getAsJsonObject("data").keySet());
      assertEquals(Files.readString(licensePath, UTF_8), read(jar, "LICENSE"));
    }
  }

  private static void assertForbiddenPackagesAbsent(Set<String> entries) {
    for (String entry : entries) {
      assertFalse(entry.startsWith("com/sun/jna/"), "embedded JNA: " + entry);
      assertFalse(entry.startsWith("net/fabricmc/"), "embedded Fabric dependency: " + entry);
      assertFalse(entry.startsWith("software/bernie/"), "embedded GeckoLib: " + entry);
      assertFalse(entry.startsWith("org/spongepowered/"), "embedded Mixin: " + entry);
      assertFalse(entry.startsWith("com/google/gson/"), "embedded Gson: " + entry);
      assertFalse(entry.endsWith(".jar"), "nested dependency JAR: " + entry);
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
    JsonObject ownerMappings = mappings.getAsJsonObject(owner);
    assertNotNull(ownerMappings, owner);
    return ownerMappings.get(method).getAsString();
  }
}
