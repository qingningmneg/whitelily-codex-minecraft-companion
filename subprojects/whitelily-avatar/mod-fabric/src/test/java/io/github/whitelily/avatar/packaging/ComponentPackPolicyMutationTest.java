package io.github.whitelily.avatar.packaging;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class ComponentPackPolicyMutationTest {
  @TempDir Path temporaryDirectory;

  @Test
  void recursiveArchiveBudgetsAreSharedAcrossAllDeclaredNestedJars() throws Exception {
    byte[] nestedOne = minimalJar("nested_one", List.of(file("LICENSE", "one".getBytes(UTF_8))));
    byte[] nestedTwo = minimalJar("nested_two", List.of(file("LICENSE", "two".getBytes(UTF_8))));
    byte[] metadata =
        metadata(
            "top_mod",
            "\"jars\":[{\"file\":\"META-INF/jars/one.jar\"},{\"file\":\"META-INF/jars/two.jar\"}]");
    Path top =
        jar(
            "nested-budget.jar",
            List.of(
                file("fabric.mod.json", metadata),
                file("LICENSE", "license".getBytes(UTF_8)),
                file("META-INF/jars/one.jar", nestedOne),
                file("META-INF/jars/two.jar", nestedTwo)));
    long completeExpandedTree =
        metadata.length
            + 7L
            + nestedOne.length
            + nestedTwo.length
            + metadata("nested_one", null).length
            + 3L
            + metadata("nested_two", null).length
            + 3L;
    assertThrows(
        IOException.class,
        () ->
            ComponentPackPolicy.inspectComponent(
                top,
                expectation("top_mod", true),
                limits(8_000_000, 4_000_000, completeExpandedTree - 1, 100, 2, 2, 65_536, 1_024)));
    long completeCompressedTree = Files.size(top) + nestedOne.length + nestedTwo.length;
    assertThrows(
        IOException.class,
        () ->
            ComponentPackPolicy.inspectComponent(
                top,
                expectation("top_mod", true),
                limits(completeCompressedTree - 1, 4_000_000, 8_000_000, 100, 2, 2, 65_536, 1_024)));
    assertThrows(
        IOException.class,
        () ->
            ComponentPackPolicy.inspectComponent(
                top,
                expectation("top_mod", true),
                limits(8_000_000, 4_000_000, 8_000_000, 7, 2, 2, 65_536, 1_024)));
    assertThrows(
        IOException.class,
        () ->
            ComponentPackPolicy.inspectComponent(
                top,
                expectation("top_mod", true),
                limits(8_000_000, 4_000_000, 8_000_000, 100, 2, 1, 65_536, 1_024)));
    assertThrows(
        IOException.class,
        () ->
            ComponentPackPolicy.inspectComponent(
                top,
                expectation("top_mod", true),
                limits(8_000_000, 4_000_000, 8_000_000, 100, 0, 2, 65_536, 1_024)));
  }

  @Test
  void executableAndNativeMagicIsRejectedWithoutMisclassifyingJavaClassFiles() throws Exception {
    for (byte[] magic :
        List.of(
            portableExecutableHeader(),
            new byte[] {0x7f, 'E', 'L', 'F'},
            new byte[] {(byte) 0xfe, (byte) 0xed, (byte) 0xfa, (byte) 0xcf},
            new byte[] {(byte) 0xca, (byte) 0xfe, (byte) 0xba, (byte) 0xbe})) {
      Path mutated = basicJar("magic-" + Integer.toHexString(magic[0] & 0xff) + ".jar", file("payload/data", magic));
      assertThrows(IOException.class, () -> ComponentPackPolicy.inspectComponent(mutated, expectation("test_mod", false)));
    }
    Path legitimateClass =
        basicJar(
            "class.jar",
            file(
                "io/github/whitelily/Legitimate.class",
                new byte[] {(byte) 0xca, (byte) 0xfe, (byte) 0xba, (byte) 0xbe}));
    assertDoesNotThrow(() -> ComponentPackPolicy.inspectComponent(legitimateClass, expectation("test_mod", false)));
    Path legitimateMzResource =
        basicJar("mz-resource.jar", file("assets/whitelily_avatar/data.bin", new byte[] {'M', 'Z', 1, 2}));
    assertDoesNotThrow(() -> ComponentPackPolicy.inspectComponent(legitimateMzResource, expectation("test_mod", false)));
  }

  @Test
  void nativeFileNameFamiliesAreRejectedCaseInsensitively() throws Exception {
    for (String name :
        List.of(
            "native/PAYLOAD.DLL",
            "native/tool.exe",
            "native/libpayload.so",
            "native/libpayload.so.1.2",
            "native/payload.dylib",
            "native/payload.jnilib",
            "native/payload.pyd",
            "native/payload.sys")) {
      Path mutated = basicJar("native-" + Math.abs(name.hashCode()) + ".jar", file(name, new byte[] {1}));
      assertThrows(IOException.class, () -> ComponentPackPolicy.inspectComponent(mutated, expectation("test_mod", false)), name);
    }
  }

  @Test
  void scriptFamiliesAndShebangsUnderAnyFileNameAreRejected() throws Exception {
    for (String name :
        List.of(
            "scripts/run.bat",
            "scripts/run.cmd",
            "scripts/run.ps1",
            "scripts/run.psm1",
            "scripts/run.sh",
            "scripts/run.bash",
            "scripts/run.zsh",
            "scripts/run.js",
            "scripts/run.mjs",
            "scripts/run.cjs",
            "scripts/run.py",
            "scripts/run.vbs")) {
      Path mutated = basicJar("script-" + Math.abs(name.hashCode()) + ".jar", file(name, "echo no".getBytes(UTF_8)));
      assertThrows(IOException.class, () -> ComponentPackPolicy.inspectComponent(mutated, expectation("test_mod", false)), name);
    }
    Path shebang = basicJar("shebang.jar", file("scripts/launcher", "#!/bin/sh\n".getBytes(UTF_8)));
    Path bomShebang =
        basicJar(
            "bom-shebang.jar",
            file(
                "scripts/launcher",
                new byte[] {(byte) 0xef, (byte) 0xbb, (byte) 0xbf, '#', '!', '/', 'b', 'i', 'n'}));
    Path dottedShebang =
        basicJar("dotted-shebang.jar", file("scripts/launcher.txt", "#!/bin/sh\n".getBytes(UTF_8)));
    Path dottedBomShebang =
        basicJar(
            "dotted-bom-shebang.jar",
            file(
                "scripts/launcher.data",
                new byte[] {(byte) 0xef, (byte) 0xbb, (byte) 0xbf, '#', '!', '/', 'b', 'i', 'n'}));
    assertThrows(IOException.class, () -> ComponentPackPolicy.inspectComponent(shebang, expectation("test_mod", false)));
    assertThrows(IOException.class, () -> ComponentPackPolicy.inspectComponent(bomShebang, expectation("test_mod", false)));
    assertThrows(IOException.class, () -> ComponentPackPolicy.inspectComponent(dottedShebang, expectation("test_mod", false)));
    assertThrows(IOException.class, () -> ComponentPackPolicy.inspectComponent(dottedBomShebang, expectation("test_mod", false)));
  }

  @Test
  void malformedUtf8AndDuplicateMetadataKeysAreRejected() throws Exception {
    Path malformed =
        jar(
            "malformed.jar",
            List.of(
                file("fabric.mod.json", new byte[] {(byte) 0xc3, 0x28}),
                file("LICENSE", new byte[] {1})));
    Path duplicate =
        jar(
            "duplicate-key.jar",
            List.of(
                file(
                    "fabric.mod.json",
                    "{\"schemaVersion\":1,\"id\":\"test_mod\",\"id\":\"other_mod\",\"version\":\"1.0.0\",\"environment\":\"*\",\"depends\":{}}"
                        .getBytes(UTF_8)),
                file("LICENSE", new byte[] {1})));

    assertThrows(IOException.class, () -> ComponentPackPolicy.inspectComponent(malformed, expectation("test_mod", false)));
    assertThrows(IOException.class, () -> ComponentPackPolicy.inspectComponent(duplicate, expectation("test_mod", false)));
  }

  @Test
  void entrySizeCountAndTraversalLimitsFailClosed() throws Exception {
    Path oversized = basicJar("oversized.jar", file("data/blob", new byte[257]));
    assertThrows(
        IOException.class,
        () -> ComponentPackPolicy.inspectComponent(oversized, expectation("test_mod", false), limits(1_000_000, 256, 1_000_000, 100, 2, 4, 65_536, 1_024)));

    List<EntryData> counted = new ArrayList<>();
    counted.add(file("fabric.mod.json", metadata("test_mod", null)));
    counted.add(file("LICENSE", new byte[] {1}));
    counted.add(file("a", new byte[] {1}));
    Path tooMany = jar("too-many.jar", counted);
    assertThrows(
        IOException.class,
        () -> ComponentPackPolicy.inspectComponent(tooMany, expectation("test_mod", false), limits(1_000_000, 1_000_000, 1_000_000, 2, 2, 4, 65_536, 1_024)));

    Path traversal = basicJar("traversal.jar", file("../escape", new byte[] {1}));
    assertThrows(IOException.class, () -> ComponentPackPolicy.inspectComponent(traversal, expectation("test_mod", false)));
  }

  @Test
  void requiredLicenseMustBeAnExactOrdinaryNonemptyBoundedFile() throws Exception {
    Path directoryLicense =
        jar(
            "directory-license.jar",
            List.of(file("fabric.mod.json", metadata("test_mod", null)), directory("LICENSE/")));
    Path emptyLicense =
        jar(
            "empty-license.jar",
            List.of(
                file("fabric.mod.json", metadata("test_mod", null)),
                file("LICENSE", new byte[0])));
    Path oversizedLicense =
        jar(
            "large-license.jar",
            List.of(
                file("fabric.mod.json", metadata("test_mod", null)),
                file("LICENSE", new byte[65])));
    var smallLicenseLimit = limits(1_000_000, 1_000_000, 1_000_000, 100, 2, 4, 65_536, 64);

    assertThrows(
        IOException.class,
        () ->
            ComponentPackPolicy.inspectComponent(
                directoryLicense,
                new ComponentPackPolicy.ExpectedMod(
                    "test_mod", "1.0.0", "*", Map.of(), Set.of(), "LICENSE/", false)));
    assertThrows(IOException.class, () -> ComponentPackPolicy.inspectComponent(emptyLicense, expectation("test_mod", false)));
    assertThrows(IOException.class, () -> ComponentPackPolicy.inspectComponent(oversizedLicense, expectation("test_mod", false), smallLicenseLimit));
  }

  private Path basicJar(String name, EntryData addition) throws IOException {
    return jar(
        name,
        List.of(
            file("fabric.mod.json", metadata("test_mod", null)),
            file("LICENSE", "license".getBytes(UTF_8)),
            addition));
  }

  private Path jar(String name, List<EntryData> entries) throws IOException {
    Path output = temporaryDirectory.resolve(name);
    Files.write(output, archive(entries));
    return output;
  }

  private static byte[] minimalJar(String id, List<EntryData> additions) throws IOException {
    List<EntryData> entries = new ArrayList<>();
    entries.add(file("fabric.mod.json", metadata(id, null)));
    entries.addAll(additions);
    return archive(entries);
  }

  private static byte[] archive(List<EntryData> entries) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    try (ZipOutputStream zip = new ZipOutputStream(output)) {
      for (EntryData entry : entries) {
        zip.putNextEntry(new ZipEntry(entry.name()));
        if (!entry.directory()) zip.write(entry.bytes());
        zip.closeEntry();
      }
    }
    return output.toByteArray();
  }

  private static byte[] metadata(String id, String extraMember) {
    String extra = extraMember == null ? "" : "," + extraMember;
    return ("{\"schemaVersion\":1,\"id\":\"" + id + "\",\"version\":\"1.0.0\",\"environment\":\"*\",\"depends\":{}" + extra + "}")
        .getBytes(UTF_8);
  }

  private static ComponentPackPolicy.ExpectedMod expectation(String id, boolean nested) {
    return new ComponentPackPolicy.ExpectedMod(id, "1.0.0", "*", Map.of(), Set.of(), "LICENSE", nested);
  }

  private static ComponentPackPolicy.Limits limits(
      long compressed,
      int entry,
      long expanded,
      int count,
      int depth,
      int nested,
      int metadata,
      int license) {
    return new ComponentPackPolicy.Limits(compressed, entry, expanded, count, depth, nested, metadata, license);
  }

  private static EntryData file(String name, byte[] bytes) {
    return new EntryData(name, bytes, false);
  }

  private static EntryData directory(String name) {
    return new EntryData(name, new byte[0], true);
  }

  private static byte[] portableExecutableHeader() {
    byte[] bytes = new byte[68];
    bytes[0] = 'M';
    bytes[1] = 'Z';
    bytes[0x3c] = 64;
    bytes[64] = 'P';
    bytes[65] = 'E';
    return bytes;
  }

  private record EntryData(String name, byte[] bytes, boolean directory) {}
}
