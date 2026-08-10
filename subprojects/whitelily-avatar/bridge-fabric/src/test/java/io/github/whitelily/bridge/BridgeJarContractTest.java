package io.github.whitelily.bridge;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
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
        copied.setTime(0L);
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
        entry.setTime(0L);
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

  private static void duplicateFirstCentralDirectoryEntry(Path source, Path target) throws Exception {
    byte[] archive = Files.readAllBytes(source);
    int eocd = -1;
    for (int index = archive.length - 22; index >= Math.max(0, archive.length - 65_557); index--) {
      if (littleEndianInt(archive, index) == 0x06054b50) {
        eocd = index;
        break;
      }
    }
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
