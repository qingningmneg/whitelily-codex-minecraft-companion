package io.github.whitelily.avatar.packaging;

import static java.nio.charset.StandardCharsets.UTF_8;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.StringReader;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

final class ComponentPackPolicy {
  private static final Limits DEFAULT_LIMITS =
      new Limits(
          64L * 1024 * 1024,
          16 * 1024 * 1024,
          96L * 1024 * 1024,
          8_192,
          1,
          4_096,
          64 * 1024,
          1024 * 1024);
  private static final int MAX_ENTRY_NAME = 512;
  private static final Pattern MOD_ID = Pattern.compile("[a-z][a-z0-9_-]{1,63}");
  private static final Pattern VERSION = Pattern.compile("[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}");
  private static final Set<String> FORBIDDEN_SUFFIXES =
      Set.of(
          ".exe",
          ".com",
          ".scr",
          ".msi",
          ".dll",
          ".so",
          ".dylib",
          ".jnilib",
          ".pyd",
          ".sys",
          ".node",
          ".bat",
          ".cmd",
          ".ps1",
          ".psm1",
          ".sh",
          ".bash",
          ".zsh",
          ".js",
          ".mjs",
          ".cjs",
          ".py",
          ".vbs");
  private static final String AVATAR_RESOURCE_PREFIX = "assets/whitelily_avatar/";

  private ComponentPackPolicy() {}

  record Limits(
      long maxCompressedBytes,
      int maxEntryBytes,
      long maxExpandedBytes,
      int maxEntries,
      int maxDepth,
      int maxNestedArchives,
      int maxMetadataBytes,
      int maxLicenseBytes) {
    Limits {
      if (maxCompressedBytes < 1
          || maxEntryBytes < 1
          || maxExpandedBytes < 1
          || maxEntries < 1
          || maxDepth < 0
          || maxNestedArchives < 0
          || maxMetadataBytes < 1
          || maxLicenseBytes < 1) {
        throw new IllegalArgumentException("invalid component limits");
      }
    }
  }

  private static final class Budget {
    private final Limits limits;
    private long compressedBytes;
    private long expandedBytes;
    private int entries;
    private int nestedArchives;

    Budget(Limits limits) {
      this.limits = limits;
    }

    void claimArchive(int depth, int bytes) throws IOException {
      if (depth > limits.maxDepth()) {
        throw invalid();
      }
      if (depth > 0 && ++nestedArchives > limits.maxNestedArchives()) {
        throw invalid();
      }
      if (bytes < 1 || bytes > limits.maxCompressedBytes() - compressedBytes) {
        throw invalid();
      }
      compressedBytes += bytes;
    }

    void claimEntry(ZipEntry entry) throws IOException {
      if (++entries > limits.maxEntries()) {
        throw invalid();
      }
      long declaredSize = entry.getSize();
      if (declaredSize > limits.maxEntryBytes()
          || declaredSize > limits.maxExpandedBytes() - expandedBytes) {
        throw invalid();
      }
    }

    void claimExpanded(int entryBytes, int additionalBytes) throws IOException {
      if (additionalBytes < 0
          || entryBytes > limits.maxEntryBytes() - additionalBytes
          || expandedBytes > limits.maxExpandedBytes() - additionalBytes) {
        throw invalid();
      }
      expandedBytes += additionalBytes;
    }
  }

  private record ArchiveEntry(byte[] bytes, boolean directory) {}

  record ExpectedMod(
      String id,
      String version,
      String environment,
      Map<String, String> dependencies,
      Set<String> exactAvatarResources,
      String requiredLicense,
      boolean allowDeclaredNestedJars) {
    ExpectedMod {
      dependencies = Map.copyOf(dependencies);
      exactAvatarResources = Set.copyOf(exactAvatarResources);
    }
  }

  static void inspectPack(LinkedHashMap<Path, ExpectedMod> components) throws IOException {
    if (components.size() != 4) {
      throw invalid();
    }
    Set<String> allModIds = new HashSet<>();
    Budget budget = new Budget(DEFAULT_LIMITS);
    for (var component : components.entrySet()) {
      Set<String> componentIds = inspectComponent(component.getKey(), component.getValue(), budget);
      for (String id : componentIds) {
        if (!allModIds.add(id)) {
          throw invalid();
        }
      }
    }
  }

  static Set<String> inspectComponent(Path jar, ExpectedMod expected) throws IOException {
    return inspectComponent(jar, expected, DEFAULT_LIMITS);
  }

  static Set<String> inspectComponent(Path jar, ExpectedMod expected, Limits limits)
      throws IOException {
    return inspectComponent(jar, expected, new Budget(limits));
  }

  private static Set<String> inspectComponent(Path jar, ExpectedMod expected, Budget budget)
      throws IOException {
    long size = Files.size(jar);
    if (size < 1
        || size > budget.limits.maxCompressedBytes()
        || !Files.isRegularFile(jar, LinkOption.NOFOLLOW_LINKS)) {
      throw invalid();
    }
    budget.claimArchive(0, Math.toIntExact(size));
    Set<String> modIds = new HashSet<>();
    inspectArchive(Files.readAllBytes(jar), 0, expected, modIds, budget);
    return Set.copyOf(modIds);
  }

  static byte[] readRequiredEntry(Path jar, String entryName) throws IOException {
    try (ZipFile zip = new ZipFile(jar.toFile())) {
      var matches = zip.stream().filter(entry -> entry.getName().equals(entryName)).toList();
      if (matches.size() != 1 || matches.getFirst().isDirectory()) {
        throw invalid();
      }
      try (InputStream input = zip.getInputStream(matches.getFirst())) {
        byte[] bytes = readBounded(input, DEFAULT_LIMITS.maxLicenseBytes());
        if (bytes.length == 0) {
          throw invalid();
        }
        return bytes;
      }
    }
  }

  private static void inspectArchive(
      byte[] archiveBytes,
      int depth,
      ExpectedMod expected,
      Set<String> modIds,
      Budget budget)
      throws IOException {
    Map<String, ArchiveEntry> entries = readArchive(archiveBytes, budget);
    ArchiveEntry metadataEntry = entries.get("fabric.mod.json");
    if (metadataEntry == null
        || metadataEntry.directory()
        || metadataEntry.bytes().length > budget.limits.maxMetadataBytes()) {
      throw invalid();
    }
    JsonObject metadata = parseUniqueJson(metadataEntry.bytes());
    if (!exactInteger(metadata.get("schemaVersion"), 1)) {
      throw invalid();
    }
    String id = requiredString(metadata, "id");
    String version = requiredString(metadata, "version");
    if (!MOD_ID.matcher(id).matches() || !VERSION.matcher(version).matches() || !modIds.add(id)) {
      throw invalid();
    }

    if (expected != null) {
      if (!expected.id().equals(id)
          || !expected.version().equals(version)
          || !expected.environment().equals(requiredString(metadata, "environment"))
          || !expected.dependencies().equals(stringMap(metadata.getAsJsonObject("depends")))) {
        throw invalid();
      }
      ArchiveEntry license = entries.get(expected.requiredLicense());
      if (license == null
          || license.directory()
          || license.bytes().length < 1
          || license.bytes().length > budget.limits.maxLicenseBytes()) {
        throw invalid();
      }
      Set<String> actualAvatarResources = new HashSet<>();
      for (String name : entries.keySet()) {
        if (!entries.get(name).directory()
            && name.startsWith(AVATAR_RESOURCE_PREFIX)
            && (name.contains("/geckolib/models/")
                || name.contains("/textures/entity/")
                || name.contains("/textures/skin/"))) {
          actualAvatarResources.add(name);
        }
      }
      if (!expected.exactAvatarResources().equals(actualAvatarResources)) {
        throw invalid();
      }
    }

    Set<String> nestedEntries = new HashSet<>();
    for (String name : entries.keySet()) {
      if (name.toLowerCase(Locale.ROOT).endsWith(".jar")) {
        nestedEntries.add(name);
      }
    }
    Set<String> declaredNested = declaredNestedJars(metadata);
    if (depth != 0
        || expected == null
        || !expected.allowDeclaredNestedJars()) {
      if (!nestedEntries.isEmpty() || !declaredNested.isEmpty()) {
        throw invalid();
      }
    } else if (declaredNested.isEmpty() || !declaredNested.equals(nestedEntries)) {
      throw invalid();
    }
    for (String nested : nestedEntries.stream().sorted().toList()) {
      byte[] nestedBytes = entries.get(nested).bytes();
      budget.claimArchive(depth + 1, nestedBytes.length);
      inspectArchive(nestedBytes, depth + 1, null, modIds, budget);
    }
  }

  private static Map<String, ArchiveEntry> readArchive(byte[] archiveBytes, Budget budget)
      throws IOException {
    Map<String, ArchiveEntry> entries = new TreeMap<>();
    try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(archiveBytes))) {
      ZipEntry entry;
      while ((entry = zip.getNextEntry()) != null) {
        budget.claimEntry(entry);
        String name = entry.getName();
        validateEntryName(name);
        if (entries.containsKey(name)) {
          throw invalid();
        }
        rejectForbiddenName(name);
        byte[] bytes = entry.isDirectory() ? new byte[0] : readBounded(zip, budget);
        if (!entry.isDirectory()) {
          rejectForbiddenMagic(name, bytes);
        }
        entries.put(name, new ArchiveEntry(bytes, entry.isDirectory()));
        zip.closeEntry();
      }
    } catch (IllegalArgumentException failure) {
      throw invalid();
    }
    if (entries.isEmpty()) {
      throw invalid();
    }
    return entries;
  }

  private static JsonObject parseUniqueJson(byte[] bytes) throws IOException {
    if (bytes.length >= 3
        && bytes[0] == (byte) 0xef
        && bytes[1] == (byte) 0xbb
        && bytes[2] == (byte) 0xbf) {
      throw invalid();
    }
    String text;
    try {
      text =
          UTF_8.newDecoder()
              .onMalformedInput(CodingErrorAction.REPORT)
              .onUnmappableCharacter(CodingErrorAction.REPORT)
              .decode(ByteBuffer.wrap(bytes))
              .toString();
    } catch (java.nio.charset.CharacterCodingException failure) {
      throw invalid();
    }
    JsonReader reader = new JsonReader(new StringReader(text));
    reader.setStrictness(Strictness.STRICT);
    try {
      JsonElement value = readUniqueValue(reader);
      if (reader.peek() != JsonToken.END_DOCUMENT || !value.isJsonObject()) {
        throw invalid();
      }
      return value.getAsJsonObject();
    } catch (RuntimeException failure) {
      throw invalid();
    }
  }

  private static JsonElement readUniqueValue(JsonReader reader) throws IOException {
    return switch (reader.peek()) {
      case BEGIN_OBJECT -> {
        reader.beginObject();
        JsonObject object = new JsonObject();
        Set<String> names = new HashSet<>();
        while (reader.hasNext()) {
          String name = reader.nextName();
          if (!names.add(name)) {
            throw invalid();
          }
          object.add(name, readUniqueValue(reader));
        }
        reader.endObject();
        yield object;
      }
      case BEGIN_ARRAY -> {
        reader.beginArray();
        JsonArray array = new JsonArray();
        while (reader.hasNext()) {
          array.add(readUniqueValue(reader));
        }
        reader.endArray();
        yield array;
      }
      case STRING -> new JsonPrimitive(reader.nextString());
      case NUMBER -> new JsonPrimitive(new BigDecimal(reader.nextString()));
      case BOOLEAN -> new JsonPrimitive(reader.nextBoolean());
      case NULL -> {
        reader.nextNull();
        yield JsonNull.INSTANCE;
      }
      default -> throw invalid();
    };
  }

  private static Set<String> declaredNestedJars(JsonObject metadata) throws IOException {
    JsonElement value = metadata.get("jars");
    if (value == null) {
      return Set.of();
    }
    if (!value.isJsonArray()) {
      throw invalid();
    }
    Set<String> declared = new HashSet<>();
    for (JsonElement element : value.getAsJsonArray()) {
      if (!element.isJsonObject()
          || !element.getAsJsonObject().keySet().equals(Set.of("file"))) {
        throw invalid();
      }
      String name = requiredString(element.getAsJsonObject(), "file");
      validateEntryName(name);
      if (!name.toLowerCase(Locale.ROOT).endsWith(".jar") || !declared.add(name)) {
        throw invalid();
      }
    }
    return declared;
  }

  private static Map<String, String> stringMap(JsonObject object) throws IOException {
    if (object == null) {
      throw invalid();
    }
    Map<String, String> values = new TreeMap<>();
    for (var entry : object.entrySet()) {
      if (!entry.getValue().isJsonPrimitive()
          || !entry.getValue().getAsJsonPrimitive().isString()) {
        throw invalid();
      }
      values.put(entry.getKey(), entry.getValue().getAsString());
    }
    return Map.copyOf(values);
  }

  private static String requiredString(JsonObject object, String name) throws IOException {
    JsonElement value = object.get(name);
    if (value == null
        || !value.isJsonPrimitive()
        || !value.getAsJsonPrimitive().isString()
        || value.getAsString().isEmpty()) {
      throw invalid();
    }
    return value.getAsString();
  }

  private static boolean exactInteger(JsonElement value, int expected) {
    return value != null
        && value.isJsonPrimitive()
        && value.getAsJsonPrimitive().isNumber()
        && value.getAsJsonPrimitive().getAsString().equals(Integer.toString(expected));
  }

  private static void rejectForbiddenName(String name) throws IOException {
    String lowerName = name.toLowerCase(Locale.ROOT);
    for (String suffix : FORBIDDEN_SUFFIXES) {
      if (lowerName.endsWith(suffix)) {
        throw invalid();
      }
    }
    String fileName = lowerName.substring(lowerName.lastIndexOf('/') + 1);
    int so = fileName.indexOf(".so.");
    if (so >= 0 && so + 4 < fileName.length()) {
      throw invalid();
    }
  }

  private static void rejectForbiddenMagic(String name, byte[] bytes) throws IOException {
    String lowerName = name.toLowerCase(Locale.ROOT);
    boolean javaClass = lowerName.endsWith(".class");
    if (isPortableExecutable(bytes)
        || startsWith(bytes, 0x7f, 0x45, 0x4c, 0x46)
        || startsWith(bytes, 0xfe, 0xed, 0xfa, 0xce)
        || startsWith(bytes, 0xfe, 0xed, 0xfa, 0xcf)
        || startsWith(bytes, 0xce, 0xfa, 0xed, 0xfe)
        || startsWith(bytes, 0xcf, 0xfa, 0xed, 0xfe)
        || startsWith(bytes, 0xbe, 0xba, 0xfe, 0xca)
        || (!javaClass && startsWith(bytes, 0xca, 0xfe, 0xba, 0xbe))) {
      throw invalid();
    }
    if (startsWith(bytes, 0x23, 0x21)
        || startsWith(bytes, 0xef, 0xbb, 0xbf, 0x23, 0x21)) {
      throw invalid();
    }
  }

  private static boolean isPortableExecutable(byte[] bytes) {
    if (!startsWith(bytes, 0x4d, 0x5a) || bytes.length < 64) {
      return false;
    }
    int headerOffset =
        (bytes[0x3c] & 0xff)
            | ((bytes[0x3d] & 0xff) << 8)
            | ((bytes[0x3e] & 0xff) << 16)
            | ((bytes[0x3f] & 0xff) << 24);
    return headerOffset >= 0
        && headerOffset <= bytes.length - 4
        && startsWithAt(bytes, headerOffset, 0x50, 0x45, 0x00, 0x00);
  }

  private static boolean startsWithAt(byte[] bytes, int offset, int... prefix) {
    if (offset < 0 || bytes.length - offset < prefix.length) {
      return false;
    }
    for (int index = 0; index < prefix.length; index++) {
      if ((bytes[offset + index] & 0xff) != prefix[index]) {
        return false;
      }
    }
    return true;
  }

  private static boolean startsWith(byte[] bytes, int... prefix) {
    if (bytes.length < prefix.length) {
      return false;
    }
    for (int index = 0; index < prefix.length; index++) {
      if ((bytes[index] & 0xff) != prefix[index]) {
        return false;
      }
    }
    return true;
  }

  private static void validateEntryName(String name) throws IOException {
    if (name == null
        || name.isEmpty()
        || name.length() > MAX_ENTRY_NAME
        || name.startsWith("/")
        || name.contains("\\")
        || name.contains(":")
        || name.chars().anyMatch(character -> character < 0x20 || character == 0x7f)) {
      throw invalid();
    }
    String withoutTrailingSlash = name.endsWith("/") ? name.substring(0, name.length() - 1) : name;
    if (withoutTrailingSlash.isEmpty()) {
      throw invalid();
    }
    for (String segment : withoutTrailingSlash.split("/", -1)) {
      if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) {
        throw invalid();
      }
    }
  }

  private static byte[] readBounded(InputStream input, int maximum) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8_192];
    int read;
    while ((read = input.read(buffer)) != -1) {
      if (output.size() + read > maximum) {
        throw invalid();
      }
      output.write(buffer, 0, read);
    }
    return output.toByteArray();
  }

  private static byte[] readBounded(InputStream input, Budget budget) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8_192];
    int read;
    while ((read = input.read(buffer)) != -1) {
      budget.claimExpanded(output.size(), read);
      output.write(buffer, 0, read);
    }
    return output.toByteArray();
  }

  private static IOException invalid() {
    return new IOException("invalid component pack");
  }
}
