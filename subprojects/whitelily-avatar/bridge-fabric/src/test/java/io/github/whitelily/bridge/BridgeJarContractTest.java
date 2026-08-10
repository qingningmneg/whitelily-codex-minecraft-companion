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
    rewriteJar(source, mutated, Map.of(), Map.of("com/sun/jna/Native.class", new byte[] {0}));

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
        source, mutated, Map.of("fabric.mod.json", metadata.toString().getBytes(UTF_8)), Map.of());

    assertThrows(
        AssertionError.class,
        () ->
            BridgeJarContractAssertions.assertExact(
                mutated, Path.of(System.getProperty("whitelily.license"))));
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
      Path source, Path target, Map<String, byte[]> replacements, Map<String, byte[]> additions)
      throws Exception {
    try (JarFile jar = new JarFile(source.toFile());
        OutputStream output = Files.newOutputStream(target);
        JarOutputStream rewritten = new JarOutputStream(output)) {
      for (JarEntry entry : java.util.Collections.list(jar.entries())) {
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
}
