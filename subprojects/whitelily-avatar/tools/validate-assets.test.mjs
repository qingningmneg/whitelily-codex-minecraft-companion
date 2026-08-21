import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readBoundedFile, readStableFile, validateAvatarAssets } from "./validate-assets.mjs";

const ASSET_ROOT = fileURLToPath(new URL("../assets/", import.meta.url));
const RESOURCE_ROOT = fileURLToPath(
  new URL("../mod-fabric/src/main/resources/", import.meta.url),
);
const THEMES = ["base", "leather", "iron", "gold", "diamond", "netherite"];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

async function fixture(mutate) {
  const root = await mkdtemp(join(tmpdir(), "whitelily-native-skin-"));
  const assets = join(root, "assets");
  const resources = join(root, "mod-fabric", "src", "main", "resources");
  const manifest = JSON.parse(await readFile(join(ASSET_ROOT, "manifest.json"), "utf8"));
  manifest.researchAssetDirectories = [];
  manifest.researchRuntimeAssets = [];
  for (const theme of THEMES) {
    for (const relative of [
      `assets/whitelily_avatar/textures/skin/${theme}.png`,
      `previews/skins/${theme}-front.png`,
      `concepts/${theme}.png`,
    ]) {
      const source = relative.startsWith("assets/") ? join(RESOURCE_ROOT, ...relative.split("/")) : join(ASSET_ROOT, ...relative.split("/"));
      const destination = relative.startsWith("assets/") ? join(resources, ...relative.split("/")) : join(assets, ...relative.split("/"));
      await mkdir(join(destination, ".."), { recursive: true });
      await copyFile(source, destination);
    }
  }
  for (const relative of ["source/asset-license.json", "source/whitelily-turnaround.png", "source/whitelily-armor-themes.png"]) {
    const destination = join(assets, ...relative.split("/"));
    await mkdir(join(destination, ".."), { recursive: true });
    await copyFile(join(ASSET_ROOT, ...relative.split("/")), destination);
  }
  await mutate({ assets, resources, manifest });
  await writeFile(join(assets, "manifest.json"), JSON.stringify(manifest));
  return { root, assets, resources };
}

async function rejectsFixture(mutate, expected) {
  const { root, assets } = await fixture(mutate);
  try {
    await assert.rejects(validateAvatarAssets(assets), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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

test("rejects a schema-v2 manifest that omits the native renderer declaration", async () => {
  await rejectsFixture(
    async ({ manifest }) => {
      delete manifest.worldRenderer;
    },
    /native slim skin renderer/i,
  );
});

test("rejects duplicate source declarations", async () => {
  await rejectsFixture(
    async ({ manifest }) => {
      manifest.sources = [manifest.sources[0], manifest.sources[0]];
    },
    /invalid source declarations/i,
  );
});

test("rejects a malformed skin PNG even when its runtime hash is coordinated", async () => {
  await rejectsFixture(
    async ({ manifest, resources }) => {
      const bytes = Buffer.from("not a PNG");
      const skin = manifest.runtimeAssets[0];
      skin.sha256 = digest(bytes);
      await writeFile(join(resources, ...skin.path.split("/")), bytes);
    },
    /64x64 RGBA PNG/i,
  );
});

test("rejects runtime hash tampering, traversal paths, and unknown resource files", async () => {
  await rejectsFixture(
    async ({ manifest }) => {
      manifest.runtimeAssets[0].sha256 = "0".repeat(64);
    },
    /runtime asset SHA-256 mismatch/i,
  );
  await rejectsFixture(
    async ({ manifest }) => {
      manifest.runtimeAssets[0].path = "assets/whitelily_avatar/textures/skin/../base.png";
    },
    /invalid runtime asset declarations|unsafe manifest path/i,
  );
  await rejectsFixture(
    async ({ resources }) => {
      const unknown = join(resources, "assets", "whitelily_avatar", "textures", "skin", "orphan.png");
      await mkdir(join(unknown, ".."), { recursive: true });
      await writeFile(unknown, Buffer.from("unknown"));
    },
    /undeclared runtime asset/i,
  );
});

test("rejects an over-limit PNG read before parsing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-bounded-read-"));
  const file = join(root, "oversized.png");
  try {
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(
      readBoundedFile(() => open(file, "r"), 1024 * 1024, "oversized PNG"),
      /asset exceeds maximum size/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an asset whose metadata changes while it is being read", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-stable-read-"));
  const file = join(root, "changing.png");
  let calls = 0;
  try {
    await writeFile(file, Buffer.from("before"));
    await assert.rejects(
      readStableFile(
        {
          lstatFile: async () => {
            if (calls++ === 1) await writeFile(file, Buffer.from("after-changed"));
            return lstat(file, { bigint: true });
          },
          openFile: () => open(file, "r"),
        },
        64,
        "changing PNG",
      ),
      /asset changed during read/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
