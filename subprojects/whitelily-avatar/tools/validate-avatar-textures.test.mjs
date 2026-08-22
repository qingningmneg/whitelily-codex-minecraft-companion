import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateAvatarTextures } from "./validate-avatar-textures.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const avatarRoot = path.resolve(toolDirectory, "..");

test("requires exact 2K embedded color textures and approved sampled colors", async () => {
  const result = await validateAvatarTextures(avatarRoot);

  assert.deepEqual(result.size, [2048, 2048]);
  assert.deepEqual(result.controlSize, [2048, 2048]);
  assert.deepEqual(result.requiredPalette, ["#f7f6f2", "#e9f1ea", "#cde2c8", "#d4c7a3", "#a67c52"]);
  assert.deepEqual(result.irisSamples, [
    { role: "deep", coordinate: [521, 241], hex: "#7f815f" },
    { role: "mid", coordinate: [524, 240], hex: "#909770" },
    { role: "highlight", coordinate: [530, 240], hex: "#baba98" },
  ]);
  assert.equal(result.mipPaddingPx, 16);
  assert.equal(result.colorType, "RGBA");
  assert.equal(result.controlColorType, "RGBA");
  assert.equal(result.externalUris.length, 0);
});

test("rejects a material contract that introduces an external texture URI", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "whitelily-textures-"));
  try {
    const sourcePalette = path.join(avatarRoot, "assets", "palettes", "whitelily-base.json");
    const fixturePaletteDirectory = path.join(fixtureRoot, "assets", "palettes");
    const fixtureTextureDirectory = path.join(fixtureRoot, "assets", "textures", "source");
    await mkdir(fixturePaletteDirectory, { recursive: true });
    await mkdir(fixtureTextureDirectory, { recursive: true });
    const palette = JSON.parse(await readFile(sourcePalette, "utf8"));
    palette.atlas.externalUris = ["whitelily-base-albedo.png"];
    await writeFile(
      path.join(fixturePaletteDirectory, "whitelily-base.json"),
      `${JSON.stringify(palette, null, 2)}\n`,
      "utf8",
    );
    for (const filename of ["whitelily-base-albedo.png", "whitelily-base-control.png"]) {
      await writeFile(
        path.join(fixtureTextureDirectory, filename),
        await readFile(path.join(avatarRoot, "assets", "textures", "source", filename)),
      );
    }

    await assert.rejects(
      validateAvatarTextures(fixtureRoot),
      /AVATAR_TEXTURE_EXTERNAL_URI_FORBIDDEN/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("atlas statistics exclude missing-texture sentinels and transparent body paint", async () => {
  const result = await validateAvatarTextures(avatarRoot);

  assert.equal(result.albedoStatistics.pureWhitePixels, 0);
  assert.equal(result.albedoStatistics.pureBlackPixels, 0);
  assert.equal(result.albedoStatistics.missingPurplePixels, 0);
  assert.equal(result.albedoStatistics.transparentPixels, 0);
  assert.equal(result.controlStatistics.pureWhitePixels, 0);
  assert.equal(result.controlStatistics.pureBlackPixels, 0);
  assert.equal(result.controlStatistics.missingPurplePixels, 0);
});
