package io.github.whitelily.bridge;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.JarOutputStream;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BridgeJarContractTest {
  private static final String EXPECTED_JAR =
      "whitelily-bridge-fabric-1.21.5-0.1.0.jar";

  @TempDir Path temporaryDirectory;

  @Test
  void exactContractRejectsAnEmbeddedJnaPackage() throws Exception {
    Path source = Path.of(System.getProperty("whitelily.bridge.jar"));
    Path mutated =
        Files.createDirectory(temporaryDirectory.resolve("embedded-jna")).resolve(EXPECTED_JAR);
    rewriteJar(source, mutated, Map.of(), Map.of("com/sun/jna/Native.class", new byte[] {0}), Set.of());

    AssertionError rejection =
        assertThrows(
            AssertionError.class,
            () ->
                BridgeJarContractAssertions.assertExact(
                    mutated, Path.of(System.getProperty("whitelily.license"))));
    assertTrue(rejection.getMessage().contains("embedded JNA"));
  }

  @Test
  void exactContractRejectsAnUnexpectedEntrypointKey() throws Exception {
    Path source = Path.of(System.getProperty("whitelily.bridge.jar"));
    Path mutated =
        Files.createDirectory(temporaryDirectory.resolve("extra-entrypoint"))
            .resolve(EXPECTED_JAR);
    JsonObject metadata;
    try (JarFile jar = new JarFile(source.toFile())) {
      metadata = json(jar, "fabric.mod.json");
    }
    JsonArray unexpected = new JsonArray();
    unexpected.add("foreign.Main");
    metadata.getAsJsonObject("entrypoints").add("main", unexpected);
    rewriteJar(
        source,
        mutated,
        Map.of("fabric.mod.json", metadata.toString().getBytes(UTF_8)),
        Map.of(),
        Set.of());

    assertThrows(
        AssertionError.class,
        () ->
            BridgeJarContractAssertions.assertExact(
                mutated, Path.of(System.getProperty("whitelily.license"))));
  }

  @Test
  void exactContractRejectsGenericExtraAndMissingEntriesAndForbiddenDependencies() throws Exception {
    Path source = Path.of(System.getProperty("whitelily.bridge.jar"));
    Path license = Path.of(System.getProperty("whitelily.license"));

    assertRejected(
        source,
        license,
        "generic-extra",
        Map.of(),
        Map.of("unexpected.txt", new byte[] {1}),
        Set.of());
    assertRejected(
        source,
        license,
        "missing-class",
        Map.of(),
        Map.of(),
        Set.of("io/github/whitelily/bridge/BridgePresencePublisher.class"));
    assertRejected(
        source,
        license,
        "embedded-fabric",
        Map.of(),
        Map.of("net/fabricmc/api/ClientModInitializer.class", new byte[] {0}),
        Set.of());
  }

  @Test
  void exactContractRejectsLicenseManifestAndMixinOrRefmapMutations() throws Exception {
    Path source = Path.of(System.getProperty("whitelily.bridge.jar"));
    Path license = Path.of(System.getProperty("whitelily.license"));

    assertRejected(source, license, "license", Map.of("LICENSE", "foreign".getBytes(UTF_8)), Map.of(), Set.of());
    assertRejected(
        source,
        license,
        "manifest",
        Map.of("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\nForeign: true\r\n\r\n".getBytes(UTF_8)),
        Map.of(),
        Set.of());
    assertRejected(
        source,
        license,
        "mixin-missing",
        Map.of(),
        Map.of(),
        Set.of("whitelily_bridge.mixins.json"));
    assertRejected(
        source,
        license,
        "refmap-missing",
        Map.of(),
        Map.of(),
        Set.of("whitelily-bridge-fabric-refmap.json"));
  }

  @Test
  void exactContractRejectsTheFirstWrongSemanticWithItsSpecificReason() throws Exception {
    Path source = Path.of(System.getProperty("whitelily.bridge.jar"));
    Path license = Path.of(System.getProperty("whitelily.license"));

    JsonObject dependencyMetadata;
    JsonObject mixinConfig;
    JsonObject refmap;
    byte[] manifest;
    try (JarFile jar = new JarFile(source.toFile())) {
      dependencyMetadata = json(jar, "fabric.mod.json");
      mixinConfig = json(jar, "whitelily_bridge.mixins.json");
      refmap = json(jar, "whitelily-bridge-fabric-refmap.json");
      manifest = jar.getInputStream(jar.getJarEntry("META-INF/MANIFEST.MF")).readAllBytes();
    }

    dependencyMetadata
        .getAsJsonObject("depends")
        .addProperty("fabricloader", ">=0.16.13");
    assertRejectedWithReason(
        source,
        license,
        "dependency",
        Map.of("fabric.mod.json", dependencyMetadata.toString().getBytes(UTF_8)),
        Map.of(),
        Set.of(),
        "fabricloader dependency");

    mixinConfig.getAsJsonObject("injectors").addProperty("defaultRequire", 2);
    assertRejectedWithReason(
        source,
        license,
        "mixin-content",
        Map.of("whitelily_bridge.mixins.json", mixinConfig.toString().getBytes(UTF_8)),
        Map.of(),
        Set.of(),
        "mixin defaultRequire");

    refmap
        .getAsJsonObject("mappings")
        .getAsJsonObject("io/github/whitelily/bridge/ConnectionMixin")
        .addProperty(
            "disconnect(Lnet/minecraft/network/DisconnectionDetails;)V", "foreign");
    assertRejectedWithReason(
        source,
        license,
        "refmap-content",
        Map.of("whitelily-bridge-fabric-refmap.json", refmap.toString().getBytes(UTF_8)),
        Map.of(),
        Set.of(),
        "connection disconnect refmap");

    byte[] changedManifest =
        new String(manifest, UTF_8)
            .replace("Manifest-Version: 1.0", "Manifest-Version: 1.1")
            .getBytes(UTF_8);
    assertRejectedWithReason(
        source,
        license,
        "manifest-content",
        Map.of("META-INF/MANIFEST.MF", changedManifest),
        Map.of(),
        Set.of(),
        "manifest bytes");

    assertRejectedWithReason(
        source,
        license,
        "license-content",
        Map.of("LICENSE", "foreign".getBytes(UTF_8)),
        Map.of(),
        Set.of(),
        "license bytes");
  }

  @Test
  void exactContractRejectsEntryOrderAndTimestampIndependently() throws Exception {
    Path source = Path.of(System.getProperty("whitelily.bridge.jar"));
    Path license = Path.of(System.getProperty("whitelily.license"));

    Path reordered =
        Files.createDirectory(temporaryDirectory.resolve("entry-order")).resolve(EXPECTED_JAR);
    rewriteJarInReverseOrder(source, reordered);
    AssertionError orderFailure =
        assertThrows(
            AssertionError.class,
            () -> BridgeJarContractAssertions.assertExact(reordered, license));
    assertTrue(orderFailure.getMessage().contains("ordered entries"));

    Path timestamped =
        Files.createDirectory(temporaryDirectory.resolve("entry-timestamp"))
            .resolve(EXPECTED_JAR);
    rewriteJarWithOneDosTimestamp(source, timestamped, "fabric.mod.json", 1);
    AssertionError timestampFailure =
        assertThrows(
            AssertionError.class,
            () -> BridgeJarContractAssertions.assertExact(timestamped, license));
    assertTrue(timestampFailure.getMessage().contains("entry timestamp: fabric.mod.json"));
  }

  @Test
  void exactContractUsesTimezoneNeutralZipTimestamps() throws Exception {
    Path source = Path.of(System.getProperty("whitelily.bridge.jar"));
    Path license = Path.of(System.getProperty("whitelily.license"));
    Path timestamped =
        Files.createDirectory(temporaryDirectory.resolve("utc-timestamp"))
            .resolve(EXPECTED_JAR);
    rewriteJarWithOneDosTimestamp(source, timestamped, "fabric.mod.json", 1);
    TimeZone original = TimeZone.getDefault();
    TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
    try {
      assertDoesNotThrow(() -> BridgeJarContractAssertions.assertExact(source, license));
      AssertionError rejection =
          assertThrows(
              AssertionError.class,
              () -> BridgeJarContractAssertions.assertExact(timestamped, license));
      assertTrue(rejection.getMessage().contains("entry timestamp: fabric.mod.json"));
    } finally {
      TimeZone.setDefault(original);
    }
  }

  @Test
  void exactContractRejectsALocalHeaderOnlyTimestampMutation() throws Exception {
    Path source = Path.of(System.getProperty("whitelily.bridge.jar"));
    Path license = Path.of(System.getProperty("whitelily.license"));
    Path timestamped =
        Files.createDirectory(temporaryDirectory.resolve("local-entry-timestamp"))
            .resolve(EXPECTED_JAR);
    rewriteJarWithOneLocalDosTimestamp(source, timestamped, "fabric.mod.json", 1);

    AssertionError rejection =
        assertThrows(
            AssertionError.class,
            () -> BridgeJarContractAssertions.assertExact(timestamped, license));
    assertTrue(rejection.getMessage().contains("local entry timestamp: fabric.mod.json"));
  }

  @Test
  void exactContractRejectsALocalHeaderOnlyEqualLengthNameMutation() throws Exception {
    Path source = Path.of(System.getProperty("whitelily.bridge.jar"));
    Path license = Path.of(System.getProperty("whitelily.license"));
    Path renamed =
        Files.createDirectory(temporaryDirectory.resolve("local-entry-name"))
            .resolve(EXPECTED_JAR);
    rewriteJarWithOneLocalName(source, renamed, "fabric.mod.json", "fabric.moe.json");

    AssertionError rejection =
        assertThrows(
            AssertionError.class,
            () -> BridgeJarContractAssertions.assertExact(renamed, license));
    assertTrue(rejection.getMessage().contains("local entry name: fabric.mod.json"));
  }

  @Test
  void exactContractRejectsARealDuplicateCentralDirectoryEntry() throws Exception {
    Path source = Path.of(System.getProperty("whitelily.bridge.jar"));
    Path mutated = Files.createDirectory(temporaryDirectory.resolve("duplicate-entry")).resolve(EXPECTED_JAR);
    duplicateFirstCentralDirectoryEntry(source, mutated);

    assertThrows(
        AssertionError.class,
        () -> BridgeJarContractAssertions.assertExact(mutated, Path.of(System.getProperty("whitelily.license"))));
  }

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
    BridgeJarContractAssertions.assertExact(
        expectedJar, Path.of(System.getProperty("whitelily.license")));
  }

  private static JsonObject json(JarFile jar, String name) throws Exception {
    return JsonParser.parseString(read(jar, name)).getAsJsonObject();
  }

  private static String read(JarFile jar, String name) throws Exception {
    try (InputStream input = jar.getInputStream(jar.getJarEntry(name))) {
      return new String(input.readAllBytes(), UTF_8);
    }
  }

  private static void rewriteJar(
      Path source,
      Path target,
      Map<String, byte[]> replacements,
      Map<String, byte[]> additions,
      Set<String> omissions)
      throws Exception {
    try (JarFile jar = new JarFile(source.toFile());
        OutputStream output = Files.newOutputStream(target);
        JarOutputStream rewritten = new JarOutputStream(output)) {
      for (JarEntry entry : java.util.Collections.list(jar.entries())) {
        if (omissions.contains(entry.getName())) {
          continue;
        }
        JarEntry copied = new JarEntry(entry.getName());
        copied.setTime(entry.getTime());
        rewritten.putNextEntry(copied);
        if (!entry.isDirectory()) {
          byte[] replacement = replacements.get(entry.getName());
          rewritten.write(
              replacement == null
                  ? jar.getInputStream(entry).readAllBytes()
                  : replacement);
        }
        rewritten.closeEntry();
      }
      for (Map.Entry<String, byte[]> addition : additions.entrySet()) {
        JarEntry entry = new JarEntry(addition.getKey());
        entry.setTime(315504000000L);
        rewritten.putNextEntry(entry);
        rewritten.write(addition.getValue());
        rewritten.closeEntry();
      }
    }
  }

  private void assertRejected(
      Path source,
      Path license,
      String name,
      Map<String, byte[]> replacements,
      Map<String, byte[]> additions,
      Set<String> omissions)
      throws Exception {
    Path mutated = Files.createDirectory(temporaryDirectory.resolve(name)).resolve(EXPECTED_JAR);
    rewriteJar(source, mutated, replacements, additions, omissions);
    assertThrows(AssertionError.class, () -> BridgeJarContractAssertions.assertExact(mutated, license));
  }

  private void assertRejectedWithReason(
      Path source,
      Path license,
      String name,
      Map<String, byte[]> replacements,
      Map<String, byte[]> additions,
      Set<String> omissions,
      String reason)
      throws Exception {
    Path mutated = Files.createDirectory(temporaryDirectory.resolve(name)).resolve(EXPECTED_JAR);
    rewriteJar(source, mutated, replacements, additions, omissions);
    AssertionError rejection =
        assertThrows(
            AssertionError.class,
            () -> BridgeJarContractAssertions.assertExact(mutated, license));
    assertTrue(
        rejection.getMessage() != null && rejection.getMessage().contains(reason),
        "expected rejection reason '" + reason + "' but got: " + rejection.getMessage());
  }

  private static void rewriteJarInReverseOrder(Path source, Path target) throws Exception {
    List<EntryCopy> entries = readEntries(source);
    Collections.reverse(entries);
    writeEntries(target, entries);
  }

  private static void rewriteJarWithOneDosTimestamp(
      Path source, Path target, String entryName, int timestamp) throws Exception {
    byte[] archive = Files.readAllBytes(source);
    int eocd = endOfCentralDirectory(archive);
    assertTrue(eocd >= 0, "end of central directory");
    int count = littleEndianShort(archive, eocd + 10);
    int offset = littleEndianInt(archive, eocd + 16);
    for (int index = 0; index < count; index++) {
      assertEquals(0x02014b50, littleEndianInt(archive, offset));
      int nameLength = littleEndianShort(archive, offset + 28);
      int extraLength = littleEndianShort(archive, offset + 30);
      int commentLength = littleEndianShort(archive, offset + 32);
      String name = new String(archive, offset + 46, nameLength, UTF_8);
      if (name.equals(entryName)) {
        int localOffset = littleEndianInt(archive, offset + 42);
        assertEquals(0x04034b50, littleEndianInt(archive, localOffset));
        putLittleEndianShort(archive, offset + 12, timestamp);
        putLittleEndianShort(archive, localOffset + 10, timestamp);
        Files.write(target, archive);
        return;
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
    throw new AssertionError("missing archive entry: " + entryName);
  }

  private static void rewriteJarWithOneLocalDosTimestamp(
      Path source, Path target, String entryName, int timestamp) throws Exception {
    byte[] archive = Files.readAllBytes(source);
    int eocd = endOfCentralDirectory(archive);
    assertTrue(eocd >= 0, "end of central directory");
    int count = littleEndianShort(archive, eocd + 10);
    int offset = littleEndianInt(archive, eocd + 16);
    for (int index = 0; index < count; index++) {
      assertEquals(0x02014b50, littleEndianInt(archive, offset));
      int nameLength = littleEndianShort(archive, offset + 28);
      int extraLength = littleEndianShort(archive, offset + 30);
      int commentLength = littleEndianShort(archive, offset + 32);
      String name = new String(archive, offset + 46, nameLength, UTF_8);
      if (name.equals(entryName)) {
        int localOffset = littleEndianInt(archive, offset + 42);
        assertEquals(0x04034b50, littleEndianInt(archive, localOffset));
        putLittleEndianShort(archive, localOffset + 10, timestamp);
        Files.write(target, archive);
        return;
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
    throw new AssertionError("missing archive entry: " + entryName);
  }

  private static void rewriteJarWithOneLocalName(
      Path source, Path target, String entryName, String replacementName) throws Exception {
    byte[] archive = Files.readAllBytes(source);
    byte[] replacement = replacementName.getBytes(UTF_8);
    int eocd = endOfCentralDirectory(archive);
    assertTrue(eocd >= 0, "end of central directory");
    int count = littleEndianShort(archive, eocd + 10);
    int offset = littleEndianInt(archive, eocd + 16);
    for (int index = 0; index < count; index++) {
      assertEquals(0x02014b50, littleEndianInt(archive, offset));
      int nameLength = littleEndianShort(archive, offset + 28);
      int extraLength = littleEndianShort(archive, offset + 30);
      int commentLength = littleEndianShort(archive, offset + 32);
      String name = new String(archive, offset + 46, nameLength, UTF_8);
      if (name.equals(entryName)) {
        int localOffset = littleEndianInt(archive, offset + 42);
        assertEquals(0x04034b50, littleEndianInt(archive, localOffset));
        int localNameLength = littleEndianShort(archive, localOffset + 26);
        assertEquals(localNameLength, replacement.length, "replacement name length");
        System.arraycopy(replacement, 0, archive, localOffset + 30, replacement.length);
        Files.write(target, archive);
        return;
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
    throw new AssertionError("missing archive entry: " + entryName);
  }

  private static List<EntryCopy> readEntries(Path source) throws Exception {
    List<EntryCopy> entries = new ArrayList<>();
    try (JarFile jar = new JarFile(source.toFile())) {
      for (JarEntry entry : java.util.Collections.list(jar.entries())) {
        entries.add(
            new EntryCopy(
                entry.getName(),
                entry.isDirectory(),
                entry.getTime(),
                entry.isDirectory()
                    ? new byte[0]
                    : jar.getInputStream(entry).readAllBytes()));
      }
    }
    return entries;
  }

  private static void writeEntries(Path target, List<EntryCopy> entries) throws Exception {
    try (OutputStream output = Files.newOutputStream(target);
        JarOutputStream rewritten = new JarOutputStream(output)) {
      for (EntryCopy entry : entries) {
        JarEntry copied = new JarEntry(entry.name());
        copied.setTime(entry.timestamp());
        rewritten.putNextEntry(copied);
        if (!entry.directory()) {
          rewritten.write(entry.contents());
        }
        rewritten.closeEntry();
      }
    }
  }

  private record EntryCopy(String name, boolean directory, long timestamp, byte[] contents) {}

  private static void duplicateFirstCentralDirectoryEntry(Path source, Path target) throws Exception {
    byte[] archive = Files.readAllBytes(source);
    int eocd = endOfCentralDirectory(archive);
    assertTrue(eocd >= 0, "end of central directory");
    int directoryOffset = littleEndianInt(archive, eocd + 16);
    int directorySize = littleEndianInt(archive, eocd + 12);
    assertEquals(0x02014b50, littleEndianInt(archive, directoryOffset));
    int firstLength = 46 + littleEndianShort(archive, directoryOffset + 28)
        + littleEndianShort(archive, directoryOffset + 30) + littleEndianShort(archive, directoryOffset + 32);
    byte[] duplicate = java.util.Arrays.copyOfRange(archive, directoryOffset, directoryOffset + firstLength);
    byte[] crafted = new byte[archive.length + duplicate.length];
    System.arraycopy(archive, 0, crafted, 0, eocd);
    System.arraycopy(duplicate, 0, crafted, eocd, duplicate.length);
    System.arraycopy(archive, eocd, crafted, eocd + duplicate.length, archive.length - eocd);
    int shiftedEocd = eocd + duplicate.length;
    putLittleEndianShort(crafted, shiftedEocd + 8, littleEndianShort(archive, eocd + 8) + 1);
    putLittleEndianShort(crafted, shiftedEocd + 10, littleEndianShort(archive, eocd + 10) + 1);
    putLittleEndianInt(crafted, shiftedEocd + 12, directorySize + duplicate.length);
    Files.write(target, crafted);
  }

  private static int littleEndianShort(byte[] bytes, int offset) {
    return (bytes[offset] & 0xff) | ((bytes[offset + 1] & 0xff) << 8);
  }

  private static int endOfCentralDirectory(byte[] archive) {
    for (int index = archive.length - 22; index >= Math.max(0, archive.length - 65_557); index--) {
      if (littleEndianInt(archive, index) == 0x06054b50) {
        return index;
      }
    }
    return -1;
  }

  private static int littleEndianInt(byte[] bytes, int offset) {
    return littleEndianShort(bytes, offset) | (littleEndianShort(bytes, offset + 2) << 16);
  }

  private static void putLittleEndianShort(byte[] bytes, int offset, int value) {
    bytes[offset] = (byte) value;
    bytes[offset + 1] = (byte) (value >>> 8);
  }

  private static void putLittleEndianInt(byte[] bytes, int offset, int value) {
    putLittleEndianShort(bytes, offset, value);
    putLittleEndianShort(bytes, offset + 2, value >>> 16);
  }
}
