package io.github.whitelily.avatar.skin;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.whitelily.avatar.control.AvatarRuntimeDescriptor;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import javax.imageio.ImageIO;
import net.minecraft.client.resources.PlayerSkin;
import net.minecraft.resources.ResourceLocation;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class ApprovedSkinCatalogTest {
  private static final String FIRST_ID = "user:00000000-0000-4000-8000-000000000001";
  private static final String SECOND_ID = "user:00000000-0000-4000-8000-000000000002";

  @TempDir Path dataRoot;

  @Test
  void resolvesOnlyTheManagedRelativePathAndVerifiedPixels() throws Exception {
    byte[] png = bundledSkin();
    Path skin = managed("user/00000000-0000-4000-8000-000000000001/skin.png", png);
    writeCatalog(FIRST_ID, relative(skin), sha256(png), "slim");

    ApprovedSkinCatalog.ApprovedSkin approved =
        new ApprovedSkinCatalog(dataRoot).resolve(FIRST_ID);

    assertEquals(FIRST_ID, approved.modelId());
    assertEquals(PlayerSkin.Model.SLIM, approved.model());
    assertArrayEquals(png, approved.pngBytes());
  }

  @Test
  void rejectsTraversalSymlinkDigestDriftAndInvalidPngShapes() throws Exception {
    byte[] valid = bundledSkin();
    Path outside = dataRoot.resolve("outside.png");
    Files.write(outside, valid);
    assertRejected("../outside.png", sha256(valid));

    Path target = managed("user/target.png", valid);
    Path link = dataRoot.resolve("models/user/link.png");
    try {
      Files.createSymbolicLink(link, target);
      assertRejected("user/link.png", sha256(valid));
    } catch (UnsupportedOperationException | IOException error) {
      // Windows without developer-mode symlink rights still exercises NOFOLLOW via traversal.
    }

    Path drift = managed("user/drift.png", valid);
    assertRejected(relative(drift), "0".repeat(64));

    byte[] wrongSize = png(32, 32, true, false);
    assertRejected(relative(managed("user/wrong-size.png", wrongSize)), sha256(wrongSize));
    byte[] rgb = png(64, 64, false, false);
    assertRejected(relative(managed("user/rgb.png", rgb)), sha256(rgb));
    byte[] transparentBase = png(64, 64, true, true);
    assertRejected(
        relative(managed("user/transparent-base.png", transparentBase)), sha256(transparentBase));
  }

  @Test
  void aRejectedCandidateDoesNotReplaceTheActiveSkin() throws Exception {
    byte[] valid = bundledSkin();
    Path first = managed("user/00000000-0000-4000-8000-000000000001/skin.png", valid);
    writeCatalog(FIRST_ID, relative(first), sha256(valid), "slim");
    WhiteLilySkinCatalog visible = new WhiteLilySkinCatalog();
    NativeSkinCandidateRuntime runtime =
        new NativeSkinCandidateRuntime(
            new ApprovedSkinCatalog(dataRoot),
            visible,
            approved ->
                CompletableFuture.completedFuture(
                    new NativeSkinCandidateRuntime.RegisteredSkin(
                        new PlayerSkin(
                            ResourceLocation.fromNamespaceAndPath("whitelily_avatar", "dynamic/first"),
                            null, null, null, approved.model(), true),
                        () -> {})));
    var firstCandidate = runtime.prepare(descriptor(FIRST_ID)).toCompletableFuture().join();
    runtime.requestCommit(firstCandidate);
    assertTrue(runtime.consumeVisibleCommit().isPresent());
    assertEquals(FIRST_ID, visible.activeModelId());

    writeCatalog(SECOND_ID, relative(first), "f".repeat(64), "slim");

    assertThrows(
        Exception.class,
        () -> runtime.prepare(descriptor(SECOND_ID)).toCompletableFuture().join());
    assertEquals(FIRST_ID, visible.activeModelId());
  }

  @Test
  void cancelRestoresThePreviousSkinAndReleaseRunsExactlyOnce() throws Exception {
    byte[] valid = bundledSkin();
    Path first = managed("user/00000000-0000-4000-8000-000000000001/skin.png", valid);
    writeCatalog(FIRST_ID, relative(first), sha256(valid), "slim");
    WhiteLilySkinCatalog visible = new WhiteLilySkinCatalog();
    AtomicInteger releases = new AtomicInteger();
    NativeSkinCandidateRuntime runtime =
        new NativeSkinCandidateRuntime(
            new ApprovedSkinCatalog(dataRoot),
            visible,
            approved ->
                CompletableFuture.completedFuture(
                    new NativeSkinCandidateRuntime.RegisteredSkin(
                        new PlayerSkin(
                            ResourceLocation.fromNamespaceAndPath("whitelily_avatar", "dynamic/first"),
                            null, null, null, approved.model(), true),
                        releases::incrementAndGet)));
    var candidate = runtime.prepare(descriptor(FIRST_ID)).toCompletableFuture().join();

    runtime.requestCommit(candidate);
    assertEquals(FIRST_ID, visible.activeModelId());
    runtime.cancel(candidate);
    assertEquals("builtin:whitelily", visible.activeModelId());
    runtime.release(candidate);
    runtime.release(candidate);

    assertEquals(1, releases.get());
  }

  private void assertRejected(String skinAsset, String digest) throws Exception {
    writeCatalog(FIRST_ID, skinAsset, digest, "slim");
    assertThrows(ApprovedSkinCatalog.ApprovedSkinException.class,
        () -> new ApprovedSkinCatalog(dataRoot).resolve(FIRST_ID));
  }

  private Path managed(String relative, byte[] bytes) throws IOException {
    Path path = dataRoot.resolve("models").resolve(relative);
    Files.createDirectories(path.getParent());
    Files.write(path, bytes);
    return path;
  }

  private String relative(Path path) {
    return dataRoot.resolve("models").relativize(path).toString().replace('\\', '/');
  }

  private void writeCatalog(String id, String skinAsset, String digest, String armModel)
      throws IOException {
    Path path = dataRoot.resolve("bridge/avatar-model/approved-skins.json");
    Files.createDirectories(path.getParent());
    Files.writeString(
        path,
        "{\"schemaVersion\":1,\"skins\":[{\"id\":\"" + id
            + "\",\"origin\":\"imported\",\"skinAsset\":\"" + skinAsset
            + "\",\"skinSha256\":\"" + digest + "\",\"armModel\":\"" + armModel
            + "\"}]}\n",
        UTF_8);
  }

  private static AvatarRuntimeDescriptor descriptor(String id) {
    return new AvatarRuntimeDescriptor(id, "imported", "minecraft-skin", "slim");
  }

  private static byte[] bundledSkin() throws IOException {
    try (InputStream input = ApprovedSkinCatalogTest.class.getResourceAsStream(
        "/assets/whitelily_avatar/textures/skin/base.png")) {
      if (input == null) throw new IOException("bundled skin fixture is missing");
      return input.readAllBytes();
    }
  }

  private static byte[] png(int width, int height, boolean alpha, boolean transparentBase)
      throws IOException {
    BufferedImage image = new BufferedImage(
        width, height, alpha ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB);
    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) image.setRGB(x, y, 0xffffffff);
    }
    if (transparentBase) image.setRGB(8, 0, 0x00ffffff);
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    ImageIO.write(image, "png", output);
    return output.toByteArray();
  }

  private static String sha256(byte[] bytes) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
  }
}
