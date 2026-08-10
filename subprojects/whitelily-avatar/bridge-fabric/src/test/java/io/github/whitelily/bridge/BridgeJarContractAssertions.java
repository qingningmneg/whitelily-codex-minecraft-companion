package io.github.whitelily.bridge;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
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
import java.util.List;
import java.util.HashSet;
import java.util.jar.JarFile;
import java.util.stream.Collectors;

final class BridgeJarContractAssertions {
  private static final String EXPECTED_JAR = "whitelily-bridge-fabric-1.21.5-0.1.0.jar";
  private static final List<String> ORDERED_ENTRIES =
      List.of(
          "META-INF/MANIFEST.MF",
          "LICENSE",
          "META-INF/",
          "fabric.mod.json",
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
          "io/github/whitelily/bridge/BridgeConnectionLifecycle.class",
          "io/github/whitelily/bridge/BridgeLoginDecision.class",
          "io/github/whitelily/bridge/BridgeLoginSelector.class",
          "io/github/whitelily/bridge/BridgeNetworkAddresses.class",
          "io/github/whitelily/bridge/BridgeNonce.class",
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
          "io/github/whitelily/bridge/WindowsOwnedFile.class",
          "io/github/whitelily/bridge/WindowsProofHandle.class",
          "whitelily-bridge-fabric-refmap.json",
          "whitelily_bridge.mixins.json");
  private static final Set<String> EXACT_ENTRIES = Set.copyOf(ORDERED_ENTRIES);
  private static final byte[] EXACT_MANIFEST =
      ("Manifest-Version: 1.0\r\n"
              + "Fabric-Jar-Type: classes\r\n"
              + "Fabric-Loom-Mixin-Remap-Type: mixin\r\n"
              + "Fabric-Gradle-Version: 8.12\r\n"
              + "Fabric-Loom-Version: 1.10.5\r\n"
              + "Fabric-Mixin-Compile-Extensions-Version: 0.6.0\r\n"
              + "Fabric-Minecraft-Version: 1.21.5\r\n"
              + "Fabric-Tiny-Remapper-Version: 0.11.1\r\n"
              + "Fabric-Loader-Version: 0.16.14\r\n"
              + "Fabric-Mixin-Version: 0.15.5+mixin.0.8.7\r\n"
              + "Fabric-Mixin-Group: net.fabricmc\r\n"
              + "Fabric-Mapping-Namespace: intermediary\r\n"
              + "\r\n")
          .getBytes(UTF_8);

  private BridgeJarContractAssertions() {}

  static void assertExact(Path jarPath, Path licensePath) throws Exception {
    assertEquals(EXPECTED_JAR, jarPath.getFileName().toString());
    try (JarFile jar = new JarFile(jarPath.toFile())) {
      List<java.util.jar.JarEntry> orderedEntries = jar.stream().toList();
      List<String> entryNames = orderedEntries.stream().map(entry -> entry.getName()).toList();
      Set<String> entries = new HashSet<>(entryNames);
      assertForbiddenPackagesAbsent(entries);
      assertEquals(EXACT_ENTRIES, entries);
      assertEquals(EXACT_ENTRIES.size(), jar.size());
      assertNoDuplicateCentralDirectoryEntry(jarPath);
      assertEquals(ORDERED_ENTRIES, entryNames, "ordered entries");
      for (java.util.jar.JarEntry entry : orderedEntries) {
        assertEquals(315504000000L, entry.getTime(), "entry timestamp: " + entry.getName());
      }
      assertArrayEquals(EXACT_MANIFEST, readBytes(jar, "META-INF/MANIFEST.MF"), "manifest bytes");

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
      assertEquals(
          ">=0.16.14",
          dependencies.get("fabricloader").getAsString(),
          "fabricloader dependency");

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
      assertEquals(1, injectors.get("defaultRequire").getAsInt(), "mixin defaultRequire");

      JsonObject refmap = json(jar, "whitelily-bridge-fabric-refmap.json");
      assertEquals(Set.of("mappings", "data"), refmap.keySet());
      JsonObject mappings = refmap.getAsJsonObject("mappings");
      assertNotNull(mappings);
      assertEquals(
          Set.of(
              "io/github/whitelily/bridge/MinecraftServerMixin",
              "io/github/whitelily/bridge/ConnectionMixin",
              "io/github/whitelily/bridge/PlayerListMixin",
              "io/github/whitelily/bridge/ServerHandshakePacketListenerImplMixin",
              "io/github/whitelily/bridge/ServerLoginPacketListenerImplMixin"),
          mappings.keySet());
      assertEquals(
          Set.of("disconnect(Lnet/minecraft/network/DisconnectionDetails;)V"),
          mappings.getAsJsonObject("io/github/whitelily/bridge/ConnectionMixin").keySet());
      assertEquals(
          Set.of("stopServer()V"),
          mappings.getAsJsonObject("io/github/whitelily/bridge/MinecraftServerMixin").keySet());
      assertEquals(
          "Lnet/minecraft/class_2535;method_60924(Lnet/minecraft/class_9812;)V",
          mapping(
              mappings,
              "io/github/whitelily/bridge/ConnectionMixin",
              "disconnect(Lnet/minecraft/network/DisconnectionDetails;)V"),
          "connection disconnect refmap");
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
          Set.of(
              "handleHello(Lnet/minecraft/network/protocol/login/ServerboundHelloPacket;)V",
              "Lnet/minecraft/server/network/ServerLoginPacketListenerImpl;requestedUsername:Ljava/lang/String;"),
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
          "Lnet/minecraft/class_3248;field_45028:Ljava/lang/String;",
          mapping(
              mappings,
              "io/github/whitelily/bridge/ServerLoginPacketListenerImplMixin",
              "Lnet/minecraft/server/network/ServerLoginPacketListenerImpl;requestedUsername:Ljava/lang/String;"));
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
      assertArrayEquals(Files.readAllBytes(licensePath), readBytes(jar, "LICENSE"), "license bytes");
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
    return new String(readBytes(jar, name), UTF_8);
  }

  private static byte[] readBytes(JarFile jar, String name) throws Exception {
    try (InputStream input = jar.getInputStream(jar.getJarEntry(name))) {
      return input.readAllBytes();
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

  private static void assertNoDuplicateCentralDirectoryEntry(Path jarPath) throws Exception {
    byte[] archive = Files.readAllBytes(jarPath);
    int eocd = -1;
    for (int index = archive.length - 22; index >= Math.max(0, archive.length - 65_557); index--) {
      if (littleEndianInt(archive, index) == 0x06054b50) {
        eocd = index;
        break;
      }
    }
    assertTrue(eocd >= 0, "end of central directory");
    int count = littleEndianShort(archive, eocd + 10);
    int offset = littleEndianInt(archive, eocd + 16);
    Set<String> names = new HashSet<>();
    for (int index = 0; index < count; index++) {
      assertEquals(0x02014b50, littleEndianInt(archive, offset));
      int nameLength = littleEndianShort(archive, offset + 28);
      int extraLength = littleEndianShort(archive, offset + 30);
      int commentLength = littleEndianShort(archive, offset + 32);
      String name = new String(archive, offset + 46, nameLength, UTF_8);
      assertTrue(names.add(name), "duplicate archive entry: " + name);
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }

  private static int littleEndianShort(byte[] bytes, int offset) {
    return (bytes[offset] & 0xff) | ((bytes[offset + 1] & 0xff) << 8);
  }

  private static int littleEndianInt(byte[] bytes, int offset) {
    return littleEndianShort(bytes, offset) | (littleEndianShort(bytes, offset + 2) << 16);
  }
}
