package io.github.whitelily.avatar.skin;

import static java.nio.charset.StandardCharsets.UTF_8;
import static java.nio.file.StandardOpenOption.READ;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Set;
import java.util.regex.Pattern;
import javax.imageio.ImageIO;
import net.minecraft.client.resources.PlayerSkin;

/** Revalidates the desktop-published allowlist before exposing user skin pixels. */
public final class ApprovedSkinCatalog {
  private static final int MAX_CATALOG_BYTES = 64 * 1024;
  private static final int MAX_SKIN_BYTES = 8 * 1024 * 1024;
  private static final byte[] PNG_SIGNATURE =
      new byte[] {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};
  private static final Pattern USER_ID = Pattern.compile(
      "^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
  private static final Pattern DIGEST = Pattern.compile("^[a-f0-9]{64}$");
  private static final int[][] REQUIRED_BASE_UV_RECTS = {
    {8, 0, 8, 8}, {16, 0, 8, 8}, {0, 8, 8, 8}, {8, 8, 8, 8},
    {16, 8, 8, 8}, {24, 8, 8, 8}, {20, 16, 8, 4}, {28, 16, 8, 4},
    {16, 20, 4, 12}, {20, 20, 8, 12}, {28, 20, 4, 12}, {32, 20, 8, 12},
    {4, 16, 4, 4}, {8, 16, 4, 4}, {0, 20, 4, 12}, {4, 20, 4, 12},
    {8, 20, 4, 12}, {12, 20, 4, 12}, {44, 16, 4, 4}, {48, 16, 4, 4},
    {40, 20, 4, 12}, {44, 20, 4, 12}, {48, 20, 4, 12}, {52, 20, 4, 12},
    {20, 48, 4, 4}, {24, 48, 4, 4}, {16, 52, 4, 12}, {20, 52, 4, 12},
    {24, 52, 4, 12}, {28, 52, 4, 12}, {36, 48, 4, 4}, {40, 48, 4, 4},
    {32, 52, 4, 12}, {36, 52, 4, 12}, {40, 52, 4, 12}, {44, 52, 4, 12}
  };

  private final Path dataRoot;
  private final Path modelRoot;
  private final Path catalogPath;

  public ApprovedSkinCatalog(Path dataRoot) {
    if (dataRoot == null || !dataRoot.isAbsolute()) {
      throw new IllegalArgumentException("approved skin data root is invalid");
    }
    this.dataRoot = dataRoot.toAbsolutePath().normalize();
    this.modelRoot = this.dataRoot.resolve("models");
    this.catalogPath = this.dataRoot.resolve("bridge/avatar-model/approved-skins.json");
  }

  public ApprovedSkin resolve(String modelId) throws ApprovedSkinException {
    if (modelId == null || !USER_ID.matcher(modelId).matches()) {
      throw invalid("approved skin model id is invalid");
    }
    JsonObject document = parseDocument(readBoundedOrdinaryFile(catalogPath, MAX_CATALOG_BYTES));
    if (!document.keySet().equals(Set.of("schemaVersion", "skins"))
        || integer(document, "schemaVersion") != 1
        || !document.get("skins").isJsonArray()
        || document.getAsJsonArray("skins").size() > 1024) {
      throw invalid("approved skin catalog structure is invalid");
    }
    JsonObject found = null;
    for (JsonElement element : document.getAsJsonArray("skins")) {
      if (!element.isJsonObject()) throw invalid("approved skin entry is invalid");
      JsonObject entry = element.getAsJsonObject();
      validateEntry(entry);
      if (modelId.equals(string(entry, "id", 64))) {
        if (found != null) throw invalid("approved skin id is duplicated");
        found = entry;
      }
    }
    if (found == null) throw invalid("approved skin is not listed");
    String relative = string(found, "skinAsset", 512);
    Path skinPath = resolveManaged(relative);
    byte[] bytes = readBoundedOrdinaryFile(skinPath, MAX_SKIN_BYTES);
    String expected = string(found, "skinSha256", 64);
    if (!DIGEST.matcher(expected).matches() || !sha256(bytes).equals(expected)) {
      throw invalid("approved skin digest changed");
    }
    validateSkinPng(bytes);
    PlayerSkin.Model model = switch (string(found, "armModel", 16)) {
      case "slim" -> PlayerSkin.Model.SLIM;
      case "wide" -> PlayerSkin.Model.WIDE;
      default -> throw invalid("approved skin arm model is invalid");
    };
    return new ApprovedSkin(modelId, model, bytes.clone(), expected);
  }

  private Path resolveManaged(String relativeText) throws ApprovedSkinException {
    if (relativeText.isEmpty()
        || relativeText.startsWith("/")
        || relativeText.contains("\\")
        || relativeText.contains(":")
        || relativeText.endsWith("/")) {
      throw invalid("approved skin path is invalid");
    }
    String[] pieces = relativeText.split("/", -1);
    if (Arrays.stream(pieces).anyMatch(piece -> piece.isEmpty() || piece.equals(".") || piece.equals(".."))) {
      throw invalid("approved skin path is invalid");
    }
    try {
      Path canonicalRoot = modelRoot.toRealPath();
      Path candidate = modelRoot.resolve(Path.of(relativeText)).normalize();
      if (!candidate.startsWith(modelRoot) || !candidate.toRealPath().startsWith(canonicalRoot)) {
        throw invalid("approved skin path escaped its root");
      }
      return candidate;
    } catch (ApprovedSkinException error) {
      throw error;
    } catch (IOException | RuntimeException error) {
      throw new ApprovedSkinException("approved skin path is invalid", error);
    }
  }

  private static void validateEntry(JsonObject entry) throws ApprovedSkinException {
    if (!entry.keySet().equals(Set.of("id", "origin", "skinAsset", "skinSha256", "armModel"))) {
      throw invalid("approved skin entry keys are invalid");
    }
    String id = string(entry, "id", 64);
    if (!id.equals("builtin:whitelily") && !USER_ID.matcher(id).matches()) {
      throw invalid("approved skin id is invalid");
    }
    String origin = string(entry, "origin", 16);
    if ((!id.equals("builtin:whitelily") || !origin.equals("builtin"))
        && (!USER_ID.matcher(id).matches() || !origin.equals("imported"))) {
      throw invalid("approved skin origin is invalid");
    }
    string(entry, "skinAsset", 512);
    string(entry, "skinSha256", 64);
    string(entry, "armModel", 16);
  }

  private static JsonObject parseDocument(byte[] bytes) throws ApprovedSkinException {
    try {
      JsonElement parsed = JsonParser.parseString(new String(bytes, UTF_8));
      if (!parsed.isJsonObject()) throw invalid("approved skin catalog is not an object");
      return parsed.getAsJsonObject();
    } catch (ApprovedSkinException error) {
      throw error;
    } catch (RuntimeException error) {
      throw new ApprovedSkinException("approved skin catalog is invalid", error);
    }
  }

  private static int integer(JsonObject object, String key) throws ApprovedSkinException {
    try {
      JsonElement value = object.get(key);
      if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
        throw invalid("approved skin number is invalid");
      }
      return value.getAsInt();
    } catch (ApprovedSkinException error) {
      throw error;
    } catch (RuntimeException error) {
      throw new ApprovedSkinException("approved skin number is invalid", error);
    }
  }

  private static String string(JsonObject object, String key, int maximum)
      throws ApprovedSkinException {
    try {
      JsonElement value = object.get(key);
      if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
        throw invalid("approved skin string is invalid");
      }
      String text = value.getAsString();
      if (text.isEmpty() || text.codePointCount(0, text.length()) > maximum
          || text.codePoints().anyMatch(codePoint -> codePoint < 0x20 || codePoint == 0x7f)) {
        throw invalid("approved skin string is invalid");
      }
      return text;
    } catch (ApprovedSkinException error) {
      throw error;
    } catch (RuntimeException error) {
      throw new ApprovedSkinException("approved skin string is invalid", error);
    }
  }

  private static byte[] readBoundedOrdinaryFile(Path path, int maximum)
      throws ApprovedSkinException {
    Path absolute = path.toAbsolutePath().normalize();
    try {
      BasicFileAttributes before = Files.readAttributes(
          absolute, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      if (!before.isRegularFile() || before.isSymbolicLink() || before.isOther()
          || before.size() > maximum || !absolute.toRealPath().equals(absolute)) {
        throw invalid("approved skin input is not a bounded ordinary file");
      }
      ByteArrayOutputStream output = new ByteArrayOutputStream((int) before.size());
      try (SeekableByteChannel channel = Files.newByteChannel(
          absolute, Set.<OpenOption>of(READ, LinkOption.NOFOLLOW_LINKS))) {
        ByteBuffer buffer = ByteBuffer.allocate(8192);
        while (channel.read(buffer) >= 0) {
          buffer.flip();
          if (output.size() + buffer.remaining() > maximum) {
            throw invalid("approved skin input is too large");
          }
          output.write(buffer.array(), buffer.position(), buffer.remaining());
          buffer.clear();
        }
      }
      BasicFileAttributes after = Files.readAttributes(
          absolute, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
      if (!after.isRegularFile() || after.isSymbolicLink() || after.isOther()
          || !java.util.Objects.equals(before.fileKey(), after.fileKey())
          || before.size() != after.size() || before.lastModifiedTime().compareTo(after.lastModifiedTime()) != 0) {
        throw invalid("approved skin input changed while reading");
      }
      return output.toByteArray();
    } catch (ApprovedSkinException error) {
      throw error;
    } catch (IOException | RuntimeException error) {
      throw new ApprovedSkinException("approved skin input could not be read", error);
    }
  }

  private static void validateSkinPng(byte[] bytes) throws ApprovedSkinException {
    try {
      if (bytes.length < 33 || !Arrays.equals(Arrays.copyOf(bytes, 8), PNG_SIGNATURE)) {
        throw invalid("approved skin PNG signature is invalid");
      }
      ByteBuffer header = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN);
      int length = header.getInt(8);
      String type = new String(bytes, 12, 4, UTF_8);
      if (length != 13 || !type.equals("IHDR") || header.getInt(16) != 64 || header.getInt(20) != 64
          || Byte.toUnsignedInt(bytes[24]) != 8 || Byte.toUnsignedInt(bytes[25]) != 6
          || Byte.toUnsignedInt(bytes[28]) != 0) {
        throw invalid("approved skin must be a 64x64 RGBA PNG");
      }
      BufferedImage image = ImageIO.read(new ByteArrayInputStream(bytes));
      if (image == null || image.getWidth() != 64 || image.getHeight() != 64
          || !image.getColorModel().hasAlpha()) {
        throw invalid("approved skin pixels are invalid");
      }
      for (int[] rectangle : REQUIRED_BASE_UV_RECTS) {
        for (int y = rectangle[1]; y < rectangle[1] + rectangle[3]; y++) {
          for (int x = rectangle[0]; x < rectangle[0] + rectangle[2]; x++) {
            if ((image.getRGB(x, y) >>> 24) != 0xff) {
              throw invalid("approved skin base UV must be opaque");
            }
          }
        }
      }
    } catch (ApprovedSkinException error) {
      throw error;
    } catch (IOException | RuntimeException error) {
      throw new ApprovedSkinException("approved skin PNG is invalid", error);
    }
  }

  private static String sha256(byte[] bytes) throws ApprovedSkinException {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (NoSuchAlgorithmException error) {
      throw new ApprovedSkinException("SHA-256 is unavailable", error);
    }
  }

  private static ApprovedSkinException invalid(String message) {
    return new ApprovedSkinException(message);
  }

  public record ApprovedSkin(String modelId, PlayerSkin.Model model, byte[] pngBytes, String sha256) {
    public ApprovedSkin {
      pngBytes = pngBytes.clone();
    }

    @Override
    public byte[] pngBytes() {
      return pngBytes.clone();
    }
  }

  public static final class ApprovedSkinException extends Exception {
    ApprovedSkinException(String message) { super(message); }
    ApprovedSkinException(String message, Throwable cause) { super(message, cause); }
  }
}
