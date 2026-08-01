import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { format } from "prettier";
import * as avatarAssets from "./build-avatar-assets.mjs";
import { buildAvatarAssets, renderAvatarPreviews } from "./build-avatar-assets.mjs";

const themes = ["base", "leather", "iron", "gold", "diamond", "netherite"];
const views = ["front", "back", "left", "right", "top", "bottom"];

async function hashes(root, files) {
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(join(root, file)))
          .digest("hex"),
      ]),
    ),
  );
}

function rgbaPixels(bytes) {
  let offset = 8;
  let width;
  let height;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR") {
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
    }
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const scanlines = inflateSync(Buffer.concat(idat));
  const pixels = [];
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    assert.equal(scanlines[row], 0);
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 4;
      pixels.push([...scanlines.subarray(pixel, pixel + 4)]);
    }
  }
  return pixels;
}

const faceNames = ["north", "south", "west", "east", "up", "down"];

function fixtureCube(origin, size, uvColumn = 0, extra = {}) {
  return {
    origin,
    size,
    uv: Object.fromEntries(
      faceNames.map((face, index) => [face, { uv: [uvColumn + index, 0], uv_size: [1, 1] }]),
    ),
    ...extra,
  };
}

function fixtureGeometry(bones) {
  return {
    "minecraft:geometry": [
      {
        description: { texture_width: 16, texture_height: 16 },
        bones,
      },
    ],
  };
}

function fixtureTexture(colors) {
  const pixels = new Uint8Array(16 * 16 * 4);
  for (const [x, color] of colors.entries()) pixels.set(color, x * 4);
  return { width: 16, height: 16, pixels };
}

function imagePixel(rendered, x, y) {
  const offset = (y * rendered.width + x) * 4;
  return [...rendered.pixels.subarray(offset, offset + 4)];
}

function centerPixel(rendered) {
  return imagePixel(rendered, Math.floor(rendered.width / 2), Math.floor(rendered.height / 2));
}

function skinFixture(parts) {
  const texture = { width: 64, height: 64, pixels: new Uint8Array(64 * 64 * 4) };
  const fill = ([left, top, width, height], color) => {
    for (let y = top; y < top + height; y += 1) {
      for (let x = left; x < left + width; x += 1) {
        texture.pixels.set(color, (y * 64 + x) * 4);
      }
    }
  };
  for (const { base, overlay, baseColor, overlayColor } of parts) {
    fill(base, baseColor);
    fill(overlay, overlayColor);
  }
  return texture;
}

test("builds deterministic model, theme textures, skins, and six-view previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-build-"));
  try {
    const first = await buildAvatarAssets(root);
    assert.deepEqual(first.themes, themes);
    assert.deepEqual(first.views, views);
    assert.equal(first.boneCount, 19);
    assert.equal(first.entityTextureSize, "128x128");
    assert.equal(first.skinTextureSize, "64x64");

    const resourceFiles = [
      "mod-fabric/src/main/resources/assets/whitelily_avatar/geckolib/models/whitelily.geo.json",
      ...themes.map(
        (theme) =>
          `mod-fabric/src/main/resources/assets/whitelily_avatar/textures/entity/${theme}.png`,
      ),
      ...themes.map(
        (theme) =>
          `mod-fabric/src/main/resources/assets/whitelily_avatar/textures/skin/${theme}.png`,
      ),
    ];
    const previewFiles = themes.flatMap((theme) =>
      views.map((view) => `assets/previews/${theme}-${view}.png`),
    );
    const skinPreviewFiles = themes.map((theme) => `assets/previews/skins/${theme}-front.png`);
    const files = [
      "assets/blockbench/whitelily.bbmodel",
      ...resourceFiles,
      ...previewFiles,
      ...skinPreviewFiles,
    ];
    const before = await hashes(root, files);
    await buildAvatarAssets(root);
    assert.deepEqual(await hashes(root, files), before);
    assert.equal(
      (await readdir(join(root, "assets", "previews"))).filter((file) => file.endsWith(".png"))
        .length,
      36,
    );
    assert.equal((await readdir(join(root, "assets", "previews", "skins"))).length, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nests every Blockbench group and element exactly once according to the geometry hierarchy", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-outliner-"));
  try {
    await buildAvatarAssets(root);
    const blockbench = JSON.parse(
      await readFile(join(root, "assets", "blockbench", "whitelily.bbmodel"), "utf8"),
    );
    const geometry = JSON.parse(
      await readFile(
        join(
          root,
          "mod-fabric",
          "src",
          "main",
          "resources",
          "assets",
          "whitelily_avatar",
          "geckolib",
          "models",
          "whitelily.geo.json",
        ),
        "utf8",
      ),
    );
    const expectedParents = new Map(
      geometry["minecraft:geometry"][0].bones.map((bone) => [bone.name, bone.parent ?? null]),
    );
    const actualParents = new Map();
    const elementOwners = new Map();
    const visit = (entries, parent = null) => {
      for (const entry of entries) {
        assert.equal(typeof entry, "object");
        assert.equal("parent" in entry, false);
        assert.equal(actualParents.has(entry.name), false);
        actualParents.set(entry.name, parent);
        for (const child of entry.children) {
          if (typeof child === "string") {
            assert.equal(elementOwners.has(child), false);
            elementOwners.set(child, entry.name);
          } else {
            visit([child], entry.name);
          }
        }
      }
    };
    visit(blockbench.outliner);

    assert.deepEqual([...actualParents].sort(), [...expectedParents].sort());
    assert.deepEqual(
      [...elementOwners].sort(),
      blockbench.elements.map((element) => [element.uuid, element.name.split(/_\d+$/u)[0]]).sort(),
    );
    assert.equal(actualParents.get("held_item"), "right_arm");
    assert.deepEqual(
      blockbench.outliner.map((entry) => entry.name),
      ["body"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves the Blockbench texture path to the generated base entity texture", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-texture-path-"));
  try {
    await buildAvatarAssets(root);
    const modelPath = join(root, "assets", "blockbench", "whitelily.bbmodel");
    const blockbench = JSON.parse(await readFile(modelPath, "utf8"));
    const expectedPath = join(
      root,
      "mod-fabric",
      "src",
      "main",
      "resources",
      "assets",
      "whitelily_avatar",
      "textures",
      "entity",
      "base.png",
    );
    assert.equal("path" in blockbench.textures[0], false);
    const resolvedPath = resolve(dirname(modelPath), blockbench.textures[0].relative_path);
    assert.equal(resolvedPath, expectedPath);
    assert.deepEqual(await readFile(resolvedPath), await readFile(expectedPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses a per-pixel depth buffer so cube declaration order cannot change occlusion", () => {
  const near = fixtureCube([-2, -2, -3], [4, 4, 1], 0);
  const far = fixtureCube([-2, -2, 1], [4, 4, 1], 6);
  const texture = fixtureTexture([
    [220, 30, 30, 255],
    [220, 30, 30, 255],
    [220, 30, 30, 255],
    [220, 30, 30, 255],
    [220, 30, 30, 255],
    [220, 30, 30, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
  ]);
  const render = (cubes) =>
    avatarAssets.renderOrthographicView(
      fixtureGeometry([{ name: "body", pivot: [0, 0, 0], cubes }]),
      texture,
      "front",
      { size: 64 },
    );

  const nearThenFar = render([near, far]);
  const farThenNear = render([far, near]);
  assert.deepEqual(centerPixel(nearThenFar), [220, 30, 30, 255]);
  assert.deepEqual(nearThenFar.pixels, farThenNear.pixels);
});

test("culls opposing faces and samples the correct UV patch for all six cameras", () => {
  const colors = [
    [220, 20, 20, 255],
    [20, 220, 20, 255],
    [20, 20, 220, 255],
    [220, 220, 20, 255],
    [220, 20, 220, 255],
    [20, 220, 220, 255],
  ];
  const geometry = fixtureGeometry([
    { name: "body", pivot: [0, 0, 0], cubes: [fixtureCube([-2, -2, -2], [4, 4, 4])] },
  ]);
  const expected = {
    front: colors[0],
    back: colors[1],
    left: colors[2],
    right: colors[3],
    top: colors[4],
    bottom: colors[5],
  };
  for (const view of views) {
    const rendered = avatarAssets.renderOrthographicView(geometry, fixtureTexture(colors), view, {
      size: 64,
    });
    assert.deepEqual(centerPixel(rendered), expected[view], view);
  }
});

test("applies parent bone and cube pivot rotations before projection", () => {
  const texture = fixtureTexture(faceNames.map(() => [160, 80, 200, 255]));
  const child = {
    name: "child",
    parent: "body",
    pivot: [0, 0, 0],
    cubes: [
      fixtureCube([-5, -1, -1], [10, 2, 2], 0, {
        pivot: [0, 0, 0],
        rotation: [0, 20, 0],
      }),
    ],
  };
  const unrotated = avatarAssets.renderOrthographicView(
    fixtureGeometry([{ name: "body", pivot: [0, 0, 0] }, child]),
    texture,
    "front",
    { size: 64 },
  );
  const rotated = avatarAssets.renderOrthographicView(
    fixtureGeometry([{ name: "body", pivot: [0, 0, 0], rotation: [0, 45, 0] }, child]),
    texture,
    "front",
    { size: 64 },
  );
  assert.notDeepEqual(rotated.pixels, unrotated.pixels);
});

test("does not write depth for transparent texels, leaving geometry behind visible", () => {
  const near = fixtureCube([-2, -2, -3], [4, 4, 1], 0);
  const far = fixtureCube([-2, -2, 1], [4, 4, 1], 6);
  const texture = fixtureTexture([
    [220, 30, 30, 0],
    [220, 30, 30, 0],
    [220, 30, 30, 0],
    [220, 30, 30, 0],
    [220, 30, 30, 0],
    [220, 30, 30, 0],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
  ]);
  const rendered = avatarAssets.renderOrthographicView(
    fixtureGeometry([{ name: "body", pivot: [0, 0, 0], cubes: [near, far] }]),
    texture,
    "front",
    { size: 64 },
  );
  assert.deepEqual(centerPixel(rendered), [30, 60, 220, 255]);
});

test("composites partial-alpha fragments far to near independent of cube declaration order", () => {
  const near = fixtureCube([-2, -2, -3], [4, 4, 1], 0);
  const far = fixtureCube([-2, -2, 1], [4, 4, 1], 6);
  const texture = fixtureTexture([
    [220, 30, 30, 128],
    [220, 30, 30, 128],
    [220, 30, 30, 128],
    [220, 30, 30, 128],
    [220, 30, 30, 128],
    [220, 30, 30, 128],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
    [30, 60, 220, 255],
  ]);
  const render = (cubes) =>
    avatarAssets.renderOrthographicView(
      fixtureGeometry([{ name: "body", pivot: [0, 0, 0], cubes }]),
      texture,
      "front",
      { size: 64 },
    );

  const nearThenFar = render([near, far]);
  const farThenNear = render([far, near]);
  assert.deepEqual(centerPixel(nearThenFar), [125, 45, 125, 255]);
  assert.deepEqual(nearThenFar.pixels, farThenNear.pixels);
});

test("maps all six standard Steve front base and overlay UV regions with source-over alpha", () => {
  const skin = skinFixture([
    {
      base: [8, 8, 8, 8],
      overlay: [40, 8, 8, 8],
      baseColor: [100, 0, 0, 255],
      overlayColor: [200, 100, 100, 128],
    },
    {
      base: [20, 20, 8, 12],
      overlay: [20, 36, 8, 12],
      baseColor: [0, 100, 0, 255],
      overlayColor: [100, 200, 100, 128],
    },
    {
      base: [44, 20, 4, 12],
      overlay: [44, 36, 4, 12],
      baseColor: [0, 0, 100, 255],
      overlayColor: [100, 100, 200, 128],
    },
    {
      base: [36, 52, 4, 12],
      overlay: [52, 52, 4, 12],
      baseColor: [100, 100, 0, 255],
      overlayColor: [200, 200, 100, 128],
    },
    {
      base: [4, 20, 4, 12],
      overlay: [4, 36, 4, 12],
      baseColor: [100, 0, 100, 255],
      overlayColor: [200, 100, 200, 128],
    },
    {
      base: [20, 52, 4, 12],
      overlay: [4, 52, 4, 12],
      baseColor: [0, 100, 100, 255],
      overlayColor: [100, 200, 200, 128],
    },
  ]);
  const rendered = avatarAssets.renderSkinFrontPreview(skin, {
    scale: 1,
    background: [1, 2, 3, 255],
  });
  assert.deepEqual({ width: rendered.width, height: rendered.height }, { width: 16, height: 32 });
  assert.deepEqual(imagePixel(rendered, 7, 3), [150, 50, 50, 255]);
  assert.deepEqual(imagePixel(rendered, 7, 13), [50, 150, 50, 255]);
  assert.deepEqual(imagePixel(rendered, 1, 13), [50, 50, 150, 255]);
  assert.deepEqual(imagePixel(rendered, 13, 13), [150, 150, 50, 255]);
  assert.deepEqual(imagePixel(rendered, 5, 25), [150, 50, 150, 255]);
  assert.deepEqual(imagePixel(rendered, 9, 25), [50, 150, 150, 255]);
  assert.deepEqual(imagePixel(rendered, 0, 0), [1, 2, 3, 255]);
});

test("keeps every skin head overlay mostly transparent with visible eye and mouth windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-skin-overlay-"));
  try {
    await buildAvatarAssets(root);
    for (const theme of themes) {
      const pixels = rgbaPixels(
        await readFile(
          join(
            root,
            "mod-fabric",
            "src",
            "main",
            "resources",
            "assets",
            "whitelily_avatar",
            "textures",
            "skin",
            `${theme}.png`,
          ),
        ),
      );
      const at = (x, y) => pixels[y * 64 + x];
      const overlay = [];
      for (let y = 8; y < 16; y += 1) {
        for (let x = 40; x < 48; x += 1) overlay.push(at(x, y));
      }
      const transparent = overlay.filter((pixel) => pixel[3] === 0).length;
      assert.ok(transparent >= 32 && transparent < 64, `${theme}: ${transparent}`);
      for (const [baseX, baseY] of [
        [9, 11],
        [10, 11],
        [13, 11],
        [14, 11],
        [11, 14],
        [12, 14],
      ]) {
        const overlayPixel = at(baseX + 32, baseY);
        assert.equal(overlayPixel[3], 0, `${theme}: ${baseX},${baseY}`);
        assert.ok(
          at(baseX, baseY)
            .slice(0, 3)
            .some((channel, index) => channel !== at(12, 10)[index]),
          `${theme}: feature contrast at ${baseX},${baseY}`,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renders previews from the exported model and selected entity texture", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-render-"));
  try {
    await buildAvatarAssets(root);
    const preview = join(root, "assets", "previews", "base-front.png");
    const originalHash = createHash("sha256")
      .update(await readFile(preview))
      .digest("hex");
    await renderAvatarPreviews(root, {
      themes: [{ name: "base", textureTheme: "netherite" }],
      views: ["front"],
    });
    const changedHash = createHash("sha256")
      .update(await readFile(preview))
      .digest("hex");
    assert.notEqual(changedHash, originalHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps long front hair visible and maps the head top to the hair UV patch", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-hair-"));
  try {
    await buildAvatarAssets(root);
    const model = JSON.parse(
      await readFile(
        join(
          root,
          "mod-fabric",
          "src",
          "main",
          "resources",
          "assets",
          "whitelily_avatar",
          "geckolib",
          "models",
          "whitelily.geo.json",
        ),
        "utf8",
      ),
    );
    const bones = new Map(model["minecraft:geometry"][0].bones.map((bone) => [bone.name, bone]));
    const longFrontStrands = bones
      .get("hair_front")
      .cubes.filter((cube) => cube.size[1] >= 10 && cube.origin[2] < -4);
    assert.equal(longFrontStrands.length, 2);
    assert.deepEqual(
      bones.get("head").cubes[0].uv.up.uv,
      bones.get("hair_front").cubes[0].uv.north.uv,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clamps top-view lighting without wrapping bright gold channels", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-lighting-"));
  try {
    await buildAvatarAssets(root);
    const pixels = rgbaPixels(await readFile(join(root, "assets", "previews", "gold-top.png")));
    assert.equal(
      pixels.some(([red, green, blue]) => red < 32 && green > 220 && blue > 120),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes the generated GeckoLib JSON in repository format", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-format-"));
  try {
    await buildAvatarAssets(root);
    const geometryPath = join(
      root,
      "mod-fabric",
      "src",
      "main",
      "resources",
      "assets",
      "whitelily_avatar",
      "geckolib",
      "models",
      "whitelily.geo.json",
    );
    const geometry = await readFile(geometryPath, "utf8");
    assert.equal(geometry, await format(geometry, { parser: "json" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
