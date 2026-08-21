import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateAvatarAssets } from "./validate-assets.mjs";

const ASSET_ROOT = fileURLToPath(new URL("../assets/", import.meta.url));

test("declares the native slim renderer and six exact skins", async () => {
  const manifest = JSON.parse(await readFile(join(ASSET_ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.worldRenderer, "minecraft-skin");
  assert.equal(manifest.armModel, "slim");
  assert.equal(manifest.defaultTheme, "base");
  assert.deepEqual(
    manifest.skins.map(({ theme }) => theme),
    ["base", "leather", "iron", "gold", "diamond", "netherite"],
  );
  assert.equal(
    manifest.runtimeAssets.some(({ path }) => /geckolib|textures\/entity|shader|\.glb$/u.test(path)),
    false,
  );
});

test("validates six native skins, their stable previews, and their runtime hashes", async () => {
  const result = await validateAvatarAssets(ASSET_ROOT);
  assert.deepEqual(result.themes, ["base", "leather", "iron", "gold", "diamond", "netherite"]);
  assert.equal(result.skinCount, 6);
  assert.equal(result.skinPreviewCount, 6);
  assert.equal(result.runtimeAssetCount, 6);
  assert.equal(result.unreferencedTextureCount, 0);
});

test("classifies retained Blender, Gecko, and entity files as research assets", async () => {
  const manifest = JSON.parse(await readFile(join(ASSET_ROOT, "manifest.json"), "utf8"));
  assert.ok(manifest.researchAssetDirectories.includes("blender/"));
  assert.ok(manifest.researchAssetDirectories.includes("blockbench/"));
  assert.ok(
    manifest.researchRuntimeAssets.some(
      ({ path }) => path === "assets/whitelily_avatar/geckolib/models/whitelily.geo.json",
    ),
  );
  assert.ok(
    manifest.researchRuntimeAssets.some(({ path }) => path.includes("textures/entity/base.png")),
  );
});
