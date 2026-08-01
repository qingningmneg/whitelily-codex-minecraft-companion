import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { readBoundedFile, validateAvatarAssets } from "./validate-assets.mjs";

const { readStableFile } = await import("./validate-assets.mjs");

const themes = ["base", "leather", "iron", "gold", "diamond", "netherite"];
const bones = [
  "head",
  "hair_front",
  "hair_back",
  "hair_left",
  "hair_right",
  "lily",
  "ribbon",
  "body",
  "left_arm",
  "right_arm",
  "left_sleeve",
  "right_sleeve",
  "skirt_front",
  "skirt_back",
  "skirt_left",
  "skirt_right",
  "left_leg",
  "right_leg",
  "held_item",
];
const runtimePrefix = "assets/whitelily_avatar";
const geometryPath = `${runtimePrefix}/geckolib/models/whitelily.geo.json`;
const entityTexturePaths = themes.map((theme) => `${runtimePrefix}/textures/entity/${theme}.png`);
const skinPaths = themes.map((theme) => `${runtimePrefix}/textures/skin/${theme}.png`);
const skinPreviewPaths = themes.map((theme) => `previews/skins/${theme}-front.png`);
const runtimePaths = [geometryPath, ...entityTexturePaths, ...skinPaths];
const generatedRuntime = new Map(
  await Promise.all(
    runtimePaths.map(async (runtimePath) => [
      runtimePath,
      await readFile(new URL(`../mod-fabric/src/main/resources/${runtimePath}`, import.meta.url)),
    ]),
  ),
);
const generatedSkinPreviews = new Map(
  await Promise.all(
    skinPreviewPaths.map(async (skinPreviewPath) => [
      skinPreviewPath,
      await readFile(new URL(`../assets/${skinPreviewPath}`, import.meta.url)),
    ]),
  ),
);
const generatedBlockbench = await readFile(
  new URL("../assets/blockbench/whitelily.bbmodel", import.meta.url),
);
const turnaround = await readFile(
  new URL("../assets/source/whitelily-turnaround.png", import.meta.url),
);
const armorThemes = await readFile(
  new URL("../assets/source/whitelily-armor-themes.png", import.meta.url),
);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function fileStat({
  dev = 1n,
  ino = 1n,
  size = 4n,
  mtimeNs = 1n,
  ctimeNs = 1n,
  birthtimeNs = 1n,
  symbolicLink = false,
} = {}) {
  return {
    isFile: () => !symbolicLink,
    isSymbolicLink: () => symbolicLink,
    dev,
    ino,
    size,
    mtimeNs,
    ctimeNs,
    birthtimeNs,
  };
}

function png(width = 64, height = 64, colorType = 6) {
  const header = Buffer.alloc(33);
  header.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = colorType;
  return header;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, "ascii");
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length);
  return bytes;
}

function rgbaScanlines({ width = 64, height = 64, filter = 0, length } = {}) {
  const rowBytes = width * 4 + 1;
  const resolvedLength = length ?? height * rowBytes;
  const scanlines = Buffer.alloc(resolvedLength);
  for (let offset = 0; offset < scanlines.length; offset += rowBytes) {
    scanlines[offset] = filter;
  }
  return scanlines;
}

function structurallyCompletePng({
  width = 64,
  height = 64,
  idat = true,
  iend = true,
  idatBytes,
  idatChunks,
  ancillaryChunks = [],
  compression = 0,
  filter = 0,
  interlace = 0,
} = {}) {
  const compressed = idatBytes ?? deflateSync(rgbaScanlines({ width, height }));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = compression;
  ihdr[11] = filter;
  ihdr[12] = interlace;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    ...(idat ? (idatChunks ?? [compressed]).map((idatChunk) => chunk("IDAT", idatChunk)) : []),
    ...ancillaryChunks,
    ...(iend ? [chunk("IEND")] : []),
  ]);
}

function generatedPngScanlines(bytes) {
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
  const scanlines = Buffer.from(inflateSync(Buffer.concat(idat)));
  return { width, height, scanlines };
}

function mutateGeneratedPng(bytes, mutate) {
  const { width, height, scanlines } = generatedPngScanlines(bytes);
  const setPixel = (x, y, color) => {
    const pixel = y * (width * 4 + 1) + 1 + x * 4;
    scanlines.set(color, pixel);
  };
  mutate({ width, height, setPixel });
  return structurallyCompletePng({
    width,
    height,
    idatBytes: deflateSync(scanlines),
  });
}

function runtimeAssetsWithHash(runtimePath, bytes) {
  return manifest().runtimeAssets.map((runtimeAsset) =>
    runtimeAsset.path === runtimePath ? { ...runtimeAsset, sha256: digest(bytes) } : runtimeAsset,
  );
}

function skinPreviewsWithHash(skinPreviewPath, bytes) {
  return manifest().skinPreviews.map((skinPreview) =>
    skinPreview.path === skinPreviewPath ? { ...skinPreview, sha256: digest(bytes) } : skinPreview,
  );
}

function repeatedSkinPreview(bytes) {
  return {
    declarations: manifest().skinPreviews.map((skinPreview) => ({
      ...skinPreview,
      sha256: digest(bytes),
    })),
    files: Object.fromEntries(skinPreviewPaths.map((skinPreviewPath) => [skinPreviewPath, bytes])),
  };
}

function solidRgbaPng(width, height, color) {
  const scanlines = rgbaScanlines({ width, height });
  const rowBytes = width * 4 + 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      scanlines.set(color, y * rowBytes + 1 + x * 4);
    }
  }
  return structurallyCompletePng({
    width,
    height,
    idatBytes: deflateSync(scanlines),
  });
}

function equivalentPngEncoding(bytes) {
  const { width, height, scanlines } = generatedPngScanlines(bytes);
  const compressed = deflateSync(scanlines);
  return structurallyCompletePng({
    width,
    height,
    idatChunks: [compressed.subarray(0, 17), Buffer.alloc(0), compressed.subarray(17)],
  });
}

function blockbenchGroups(model) {
  const groups = [];
  const visit = (entries) => {
    for (const entry of entries) {
      if (typeof entry === "string") continue;
      groups.push(entry);
      visit(entry.children);
    }
  };
  visit(model.outliner);
  return groups;
}

function manifest(overrides = {}) {
  const conceptReferences = themes.map((theme) => {
    const content = Buffer.from(`concept-${theme}`);
    return {
      theme,
      path: `concepts/${theme}.png`,
      sha256: digest(content),
    };
  });
  return {
    schemaVersion: 2,
    themes,
    model: {
      blockbench: "blockbench/whitelily.bbmodel",
      sha256: digest(generatedBlockbench),
      geometries: [geometryPath],
      bones,
      uvLayout: "whitelily-avatar-uv-v1",
    },
    entityTextures: themes.map((theme, index) => ({
      theme,
      path: entityTexturePaths[index],
      root: "resources",
      uvLayout: "whitelily-avatar-uv-v1",
    })),
    skins: themes.map((theme, index) => ({
      theme,
      path: skinPaths[index],
      root: "resources",
    })),
    skinPreviews: themes.map((theme, index) => ({
      theme,
      path: skinPreviewPaths[index],
      sha256: digest(generatedSkinPreviews.get(skinPreviewPaths[index])),
    })),
    conceptReferences,
    sources: [
      {
        path: "source/whitelily-turnaround.png",
        sha256: digest(turnaround),
      },
      {
        path: "source/whitelily-armor-themes.png",
        sha256: digest(armorThemes),
      },
    ],
    runtimeAssets: runtimePaths.map((runtimePath) => ({
      path: runtimePath,
      root: "resources",
      sha256: digest(generatedRuntime.get(runtimePath)),
    })),
    ...overrides,
  };
}

async function fixture(overrides = {}, files = {}) {
  const subprojectRoot = await mkdtemp(join(tmpdir(), "whitelily-avatar-assets-"));
  const root = join(subprojectRoot, "assets");
  await mkdir(join(root, "source"), { recursive: true });
  await writeFile(join(root, "source", "whitelily-turnaround.png"), turnaround);
  await writeFile(join(root, "source", "whitelily-armor-themes.png"), armorThemes);
  await writeFile(
    join(root, "source", "asset-license.json"),
    JSON.stringify({
      confirmedOn: "2026-07-28",
      authorization:
        "Project owner confirmed authorship/control and authorized public modification and redistribution.",
    }),
  );
  await mkdir(join(root, "blockbench"), { recursive: true });
  await writeFile(join(root, "blockbench", "whitelily.bbmodel"), generatedBlockbench);
  for (const theme of themes) {
    await mkdir(join(root, "concepts"), { recursive: true });
    await writeFile(join(root, "concepts", `${theme}.png`), Buffer.from(`concept-${theme}`));
  }
  for (const skinPreviewPath of skinPreviewPaths) {
    const filePath = join(root, ...skinPreviewPath.split("/"));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, generatedSkinPreviews.get(skinPreviewPath));
  }
  for (const [runtimePath, content] of generatedRuntime) {
    const filePath = join(subprojectRoot, "mod-fabric", "src", "main", "resources", runtimePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const fixturePath = relativePath.startsWith("runtime:")
      ? join(
          subprojectRoot,
          "mod-fabric",
          "src",
          "main",
          "resources",
          relativePath.slice("runtime:".length),
        )
      : join(root, relativePath);
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, content);
  }
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest(overrides)));
  return root;
}

async function withFixture(overrides, files, check) {
  const root = await fixture(overrides, files);
  try {
    await check(pathToFileURL(`${root}\\`));
  } finally {
    await rm(dirname(root), { recursive: true, force: true });
  }
}

test("accepts only the approved source images and six exact themes", async () => {
  const result = await validateAvatarAssets(new URL("../assets/", import.meta.url));
  assert.deepEqual(result.themes, themes);
  assert.equal(result.sourceCount, 2);
  assert.equal(result.skinCount, 6);
});

test("requires one shared geometry with the exact renderer bone contract", async () => {
  const result = await validateAvatarAssets(new URL("../assets/", import.meta.url));
  assert.equal(
    result.blockbenchPath,
    "blockbench/whitelily.bbmodel",
    "missing model: blockbench/whitelily.bbmodel",
  );
  assert.deepEqual(
    result.geometryPaths,
    [`${runtimePrefix}/geckolib/models/whitelily.geo.json`],
    "missing shared geometry: assets/whitelily_avatar/geckolib/models/whitelily.geo.json",
  );
  assert.deepEqual(result.bones, bones, `missing or unexpected model bones: ${bones.join(", ")}`);
});

test("requires six same-size entity textures with one shared UV layout", async () => {
  const result = await validateAvatarAssets(new URL("../assets/", import.meta.url));
  assert.deepEqual(
    result.entityTexturePaths,
    themes.map((theme) => `${runtimePrefix}/textures/entity/${theme}.png`),
    `missing entity textures: ${themes.join(", ")}`,
  );
  assert.deepEqual(result.entityTextureSize, { width: 128, height: 128 });
  assert.equal(result.sharedUvLayout, "whitelily-avatar-uv-v1");
  assert.deepEqual(result.basePalette, ["#F7F6F2", "#E9F1EA", "#CDE2C8", "#D4C7A3", "#A67C52"]);
});

test("requires six usable 64x64 RGBA fallback skins", async () => {
  const result = await validateAvatarAssets(new URL("../assets/", import.meta.url));
  assert.deepEqual(
    result.skinPaths,
    themes.map((theme) => `${runtimePrefix}/textures/skin/${theme}.png`),
    `missing fallback skins: ${themes.join(", ")}`,
  );
});

test("requires six exact durable full-front skin previews with manifest hashes", async () => {
  const result = await validateAvatarAssets(new URL("../assets/", import.meta.url));
  assert.deepEqual(result.skinPreviewPaths, skinPreviewPaths);
  assert.equal(result.skinPreviewCount, 6);
});

test("rejects an opaque magenta skin preview even when its manifest hash matches", async () => {
  const preview = solidRgbaPng(128, 256, [255, 0, 255, 255]);
  await withFixture(
    { skinPreviews: skinPreviewsWithHash(skinPreviewPaths[0], preview) },
    { [skinPreviewPaths[0]]: preview },
    async (root) => {
      await assert.rejects(
        validateAvatarAssets(root),
        /skin preview pixels must match its fallback skin/i,
      );
    },
  );
});

test("rejects a one-pixel skin preview drift even when its manifest hash matches", async () => {
  const preview = mutateGeneratedPng(
    generatedSkinPreviews.get(skinPreviewPaths[0]),
    ({ setPixel }) => setPixel(0, 0, [255, 0, 255, 255]),
  );
  await withFixture(
    { skinPreviews: skinPreviewsWithHash(skinPreviewPaths[0], preview) },
    { [skinPreviewPaths[0]]: preview },
    async (root) => {
      await assert.rejects(
        validateAvatarAssets(root),
        /skin preview pixels must match its fallback skin/i,
      );
    },
  );
});

test("rejects a fallback skin pixel drift when its runtime hash changes but its preview does not", async () => {
  const skin = mutateGeneratedPng(generatedRuntime.get(skinPaths[0]), ({ setPixel }) =>
    setPixel(24, 40, [17, 34, 51, 255]),
  );
  await withFixture(
    { runtimeAssets: runtimeAssetsWithHash(skinPaths[0], skin) },
    { [`runtime:${skinPaths[0]}`]: skin },
    async (root) => {
      await assert.rejects(
        validateAvatarAssets(root),
        /skin preview pixels must match its fallback skin/i,
      );
    },
  );
});

test("accepts a pixel-equivalent skin preview with different PNG chunk encoding", async () => {
  const preview = equivalentPngEncoding(generatedSkinPreviews.get(skinPreviewPaths[0]));
  assert.notDeepEqual(preview, generatedSkinPreviews.get(skinPreviewPaths[0]));
  await withFixture(
    { skinPreviews: skinPreviewsWithHash(skinPreviewPaths[0], preview) },
    { [skinPreviewPaths[0]]: preview },
    async (root) => {
      await validateAvatarAssets(root);
    },
  );
});

test("rejects redirected or orphaned durable skin previews", async () => {
  const redirected = manifest().skinPreviews.map((preview, index) =>
    index === 0 ? { ...preview, path: "previews/skins/redirected-front.png" } : preview,
  );
  await withFixture({ skinPreviews: redirected }, {}, async (root) => {
    await assert.rejects(validateAvatarAssets(root), /six exact skin preview paths/i);
  });

  await withFixture(
    {},
    {
      "previews/skins/orphan-front.png": structurallyCompletePng({
        width: 128,
        height: 256,
      }),
    },
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /undeclared preview asset.*orphan/i);
    },
  );
});

test("rejects any fallback skin redirect away from its canonical resources path", async () => {
  const redirectedSkins = manifest().skins.map((skin, index) =>
    index === 0 ? { ...skin, root: "assets", path: "fallback/base.png" } : skin,
  );
  const redirectedRuntime = manifest().runtimeAssets.filter(
    (runtimeAsset) => runtimeAsset.path !== skinPaths[0],
  );
  const root = await fixture(
    { skins: redirectedSkins, runtimeAssets: redirectedRuntime },
    { "fallback/base.png": generatedRuntime.get(skinPaths[0]) },
  );
  const originalSkin = join(
    dirname(root),
    "mod-fabric",
    "src",
    "main",
    "resources",
    ...skinPaths[0].split("/"),
  );
  try {
    await rm(originalSkin);
    await assert.rejects(
      validateAvatarAssets(pathToFileURL(`${root}\\`)),
      /six exact fallback skin paths/i,
    );
  } finally {
    await rm(dirname(root), { recursive: true, force: true });
  }
});

test("rejects transparent required base UV regions in fallback skins", async () => {
  const transparentTorso = mutateGeneratedPng(
    generatedRuntime.get(skinPaths[0]),
    ({ setPixel }) => {
      for (let y = 20; y < 32; y += 1) {
        for (let x = 20; x < 28; x += 1) setPixel(x, y, [0, 0, 0, 0]);
      }
    },
  );
  await withFixture({}, { [`runtime:${skinPaths[0]}`]: transparentTorso }, async (root) => {
    await assert.rejects(validateAvatarAssets(root), /required skin base UV/i);
  });
});

test("rejects transparency in every required classic Steve base face", async () => {
  const transparentHeadBack = mutateGeneratedPng(
    generatedRuntime.get(skinPaths[0]),
    ({ setPixel }) => {
      for (let y = 8; y < 16; y += 1) {
        for (let x = 24; x < 32; x += 1) setPixel(x, y, [0, 0, 0, 0]);
      }
    },
  );
  await withFixture(
    {
      runtimeAssets: runtimeAssetsWithHash(skinPaths[0], transparentHeadBack),
    },
    { [`runtime:${skinPaths[0]}`]: transparentHeadBack },
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /required skin base UV/i);
    },
  );
});

test("rejects an opaque head overlay or hidden eye and mouth windows", async () => {
  const opaqueOverlay = mutateGeneratedPng(generatedRuntime.get(skinPaths[0]), ({ setPixel }) => {
    for (let y = 8; y < 16; y += 1) {
      for (let x = 40; x < 48; x += 1) setPixel(x, y, [20, 20, 20, 255]);
    }
  });
  await withFixture({}, { [`runtime:${skinPaths[0]}`]: opaqueOverlay }, async (root) => {
    await assert.rejects(validateAvatarAssets(root), /head overlay.*transparent/i);
  });

  const hiddenFeatures = mutateGeneratedPng(generatedRuntime.get(skinPaths[0]), ({ setPixel }) => {
    for (const [x, y] of [
      [41, 11],
      [42, 11],
      [45, 11],
      [46, 11],
      [43, 14],
      [44, 14],
    ]) {
      setPixel(x, y, [20, 20, 20, 255]);
    }
  });
  await withFixture({}, { [`runtime:${skinPaths[0]}`]: hiddenFeatures }, async (root) => {
    await assert.rejects(validateAvatarAssets(root), /eye and mouth windows/i);
  });
});

test("rejects a sparse head overlay even when its runtime hash is coordinated", async () => {
  const onePixelOverlay = mutateGeneratedPng(generatedRuntime.get(skinPaths[0]), ({ setPixel }) => {
    for (let y = 8; y < 16; y += 1) {
      for (let x = 40; x < 48; x += 1) setPixel(x, y, [0, 0, 0, 0]);
    }
    setPixel(40, 8, [180, 180, 180, 255]);
  });
  await withFixture(
    {
      runtimeAssets: runtimeAssetsWithHash(skinPaths[0], onePixelOverlay),
    },
    { [`runtime:${skinPaths[0]}`]: onePixelOverlay },
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /head overlay/i);
    },
  );
});

test("rejects missing malformed duplicate or element-colliding recursive group UUIDs", async () => {
  const mutations = {
    missing: (model) => {
      delete blockbenchGroups(model)[1].uuid;
    },
    malformed: (model) => {
      blockbenchGroups(model)[1].uuid = "not-a-uuid";
    },
    duplicate: (model) => {
      const groups = blockbenchGroups(model);
      groups[1].uuid = groups[0].uuid;
    },
    collision: (model) => {
      blockbenchGroups(model)[1].uuid = model.elements[0].uuid;
    },
  };
  for (const [description, mutate] of Object.entries(mutations)) {
    const model = JSON.parse(generatedBlockbench);
    mutate(model);
    const modelBytes = Buffer.from(JSON.stringify(model));
    await withFixture(
      {
        model: {
          ...manifest().model,
          sha256: digest(modelBytes),
        },
      },
      { "blockbench/whitelily.bbmodel": modelBytes },
      async (root) => {
        await assert.rejects(
          validateAvatarAssets(root),
          /Blockbench group UUID contract/i,
          description,
        );
      },
    );
  }
});

test("rejects orphan textures in both entity and skin runtime roots", async () => {
  for (const kind of ["entity", "skin"]) {
    await withFixture(
      {},
      {
        [`runtime:${runtimePrefix}/textures/${kind}/orphan.png`]: generatedRuntime.get(
          kind === "entity" ? entityTexturePaths[0] : skinPaths[0],
        ),
      },
      async (root) => {
        await assert.rejects(validateAvatarAssets(root), /unreferenced texture.*orphan/i);
      },
    );
  }
});

test("rejects semantically valid generated assets whose bytes differ from manifest hashes", async () => {
  const recoloredOverlay = mutateGeneratedPng(generatedRuntime.get(skinPaths[0]), ({ setPixel }) =>
    setPixel(40, 8, [185, 184, 184, 255]),
  );
  await withFixture({}, { [`runtime:${skinPaths[0]}`]: recoloredOverlay }, async (root) => {
    await assert.rejects(validateAvatarAssets(root), /runtime asset SHA-256 mismatch/i);
  });

  await withFixture(
    {},
    {
      "blockbench/whitelily.bbmodel": Buffer.concat([generatedBlockbench, Buffer.from("\n")]),
    },
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /Blockbench SHA-256 mismatch/i);
    },
  );
});

test("requires every declared model and texture file to exist without unreferenced textures", async () => {
  const result = await validateAvatarAssets(new URL("../assets/", import.meta.url));
  assert.equal(result.runtimeAssetCount, 13);
  assert.equal(result.unreferencedTextureCount, 0);
  assert.ok(result.maxTextureDimension <= 256);
});

test("rejects any geometry or Blockbench bone set that differs from the exact contract", async () => {
  for (const format of ["geometry", "blockbench"]) {
    const root = await fixture();
    const subprojectRoot = dirname(root);
    try {
      if (format === "geometry") {
        const modelPath = join(
          subprojectRoot,
          "mod-fabric",
          "src",
          "main",
          "resources",
          ...geometryPath.split("/"),
        );
        const model = JSON.parse(await readFile(modelPath, "utf8"));
        model["minecraft:geometry"][0].bones = model["minecraft:geometry"][0].bones.filter(
          (bone) => bone.name !== "held_item",
        );
        await writeFile(modelPath, JSON.stringify(model));
      } else {
        const modelPath = join(root, "blockbench", "whitelily.bbmodel");
        const model = JSON.parse(await readFile(modelPath, "utf8"));
        const removeGroup = (entries, name) =>
          entries
            .filter((entry) => typeof entry === "string" || entry.name !== name)
            .map((entry) =>
              typeof entry === "string"
                ? entry
                : { ...entry, children: removeGroup(entry.children, name) },
            );
        model.outliner = removeGroup(model.outliner, "held_item");
        const modelBytes = Buffer.from(JSON.stringify(model));
        await writeFile(modelPath, modelBytes);
        const manifestPath = join(root, "manifest.json");
        const declaration = JSON.parse(await readFile(manifestPath, "utf8"));
        declaration.model.sha256 = digest(modelBytes);
        await writeFile(manifestPath, JSON.stringify(declaration));
      }
      await assert.rejects(
        validateAvatarAssets(pathToFileURL(`${root}\\`)),
        /exact bone set.*held_item/i,
        format,
      );
    } finally {
      await rm(subprojectRoot, { recursive: true, force: true });
    }
  }
});

test("rejects multiple shared geometry declarations or divergent UV layout IDs", async () => {
  await withFixture(
    {
      model: {
        ...manifest().model,
        geometries: [geometryPath, geometryPath],
      },
    },
    {},
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /exactly one shared geometry/i);
    },
  );
  await withFixture(
    {
      entityTextures: manifest().entityTextures.map((texture) =>
        texture.theme === "diamond" ? { ...texture, uvLayout: "different-layout" } : texture,
      ),
    },
    {},
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /shared UV layout/i);
    },
  );
});

test("rejects entity textures with mismatched dimensions or dimensions over 256", async () => {
  await withFixture(
    {},
    {
      [`runtime:${entityTexturePaths[3]}`]: generatedRuntime.get(skinPaths[0]),
    },
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /matching dimensions/i);
    },
  );
  await withFixture(
    {},
    {
      [`runtime:${entityTexturePaths[3]}`]: structurallyCompletePng({
        width: 257,
        height: 128,
      }),
    },
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /256x256/i);
    },
  );
});

test("rejects missing declared runtime files and unreferenced texture files", async () => {
  const root = await fixture();
  const subprojectRoot = dirname(root);
  const resourceRoot = join(subprojectRoot, "mod-fabric", "src", "main", "resources");
  try {
    await rm(join(resourceRoot, ...entityTexturePaths[0].split("/")));
    await assert.rejects(
      validateAvatarAssets(pathToFileURL(`${root}\\`)),
      new RegExp(`missing declared runtime asset.*${themes[0]}`, "i"),
    );
  } finally {
    await rm(subprojectRoot, { recursive: true, force: true });
  }

  await withFixture(
    {},
    {
      [`runtime:${runtimePrefix}/textures/entity/orphan.png`]: generatedRuntime.get(
        entityTexturePaths[0],
      ),
    },
    async (fixtureRoot) => {
      await assert.rejects(validateAvatarAssets(fixtureRoot), /unreferenced texture.*orphan/i);
    },
  );
});

test("rejects a base entity texture that omits the approved palette", async () => {
  await withFixture(
    {},
    {
      [`runtime:${entityTexturePaths[0]}`]: structurallyCompletePng({
        width: 128,
        height: 128,
      }),
    },
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /approved base palette/i);
    },
  );
});

test("rejects a source digest that differs from its manifest declaration", async () => {
  await withFixture(
    { sources: [{ path: "source/whitelily-turnaround.png", sha256: "0".repeat(64) }] },
    {},
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /source SHA-256 mismatch/i);
    },
  );
});

test("rejects a missing license declaration", async () => {
  const root = await fixture();
  await rm(join(root, "source", "asset-license.json"));
  try {
    await assert.rejects(validateAvatarAssets(pathToFileURL(`${root}\\`)), /license declaration/i);
  } finally {
    await rm(dirname(root), { recursive: true, force: true });
  }
});

test("rejects a missing declared theme", async () => {
  await withFixture(
    { themes: themes.slice(0, -1), skins: themes.slice(0, -1).map((theme) => ({ theme })) },
    {},
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /six exact themes/i);
    },
  );
});

test("rejects a declared skin that is not a 64x64 RGBA PNG", async () => {
  const skins = manifest().skins;
  await withFixture(
    { skins },
    Object.fromEntries(
      themes.map((theme, index) => [
        `runtime:${skinPaths[index]}`,
        png(64, 64, theme === "base" ? 2 : 6),
      ]),
    ),
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /64x64 RGBA PNG/i);
    },
  );
});

test("rejects truncated or incomplete PNG skin chunks", async () => {
  const skins = manifest().skins;
  const complete = structurallyCompletePng();
  const badCrc = Buffer.from(complete);
  badCrc[29] ^= 1;
  const cases = [
    ["truncated after IHDR", png()],
    ["missing IDAT", structurallyCompletePng({ idat: false })],
    ["missing IEND", structurallyCompletePng({ iend: false })],
    ["invalid IHDR CRC", badCrc],
    ["trailing bytes after IEND", Buffer.concat([complete, Buffer.from([0])])],
    [
      "duplicate IHDR",
      Buffer.concat([complete.subarray(0, 33), complete.subarray(8, 33), complete.subarray(33)]),
    ],
    [
      "unknown critical chunk",
      Buffer.concat([complete.subarray(0, 33), chunk("ABCD"), complete.subarray(33)]),
    ],
  ];
  for (const [description, image] of cases) {
    await withFixture(
      { skins },
      Object.fromEntries(themes.map((theme, index) => [`runtime:${skinPaths[index]}`, image])),
      async (root) => {
        await assert.rejects(validateAvatarAssets(root), /64x64 RGBA PNG/i, description);
      },
    );
  }
});

test("validates complete bounded non-interlaced RGBA pixel streams", async () => {
  const skins = manifest().skins;
  const { scanlines } = generatedPngScanlines(generatedRuntime.get(skinPaths[0]));
  const complete = structurallyCompletePng({ idatBytes: deflateSync(scanlines) });
  const previews = repeatedSkinPreview(generatedSkinPreviews.get(skinPreviewPaths[0]));
  const runtimeAssets = manifest().runtimeAssets.map((runtimeAsset) =>
    skinPaths.includes(runtimeAsset.path)
      ? { ...runtimeAsset, sha256: digest(complete) }
      : runtimeAsset,
  );
  await withFixture(
    { skins, skinPreviews: previews.declarations, runtimeAssets },
    {
      ...Object.fromEntries(
        themes.map((theme, index) => [`runtime:${skinPaths[index]}`, complete]),
      ),
      ...previews.files,
    },
    async (root) => {
      await validateAvatarAssets(root);
    },
  );
});

test("accepts consecutive IDAT chunks including a zero-length chunk", async () => {
  const { scanlines } = generatedPngScanlines(generatedRuntime.get(skinPaths[0]));
  const compressed = deflateSync(scanlines);
  const image = structurallyCompletePng({
    idatChunks: [compressed.subarray(0, 10), Buffer.alloc(0), compressed.subarray(10)],
  });
  const skins = manifest().skins;
  const previews = repeatedSkinPreview(generatedSkinPreviews.get(skinPreviewPaths[0]));
  const runtimeAssets = manifest().runtimeAssets.map((runtimeAsset) =>
    skinPaths.includes(runtimeAsset.path)
      ? { ...runtimeAsset, sha256: digest(image) }
      : runtimeAsset,
  );
  await withFixture(
    { skins, skinPreviews: previews.declarations, runtimeAssets },
    {
      ...Object.fromEntries(themes.map((theme, index) => [`runtime:${skinPaths[index]}`, image])),
      ...previews.files,
    },
    async (root) => {
      await validateAvatarAssets(root);
    },
  );
});

test("rejects malformed, oversized, or interlaced PNG pixel streams", async () => {
  const skins = manifest().skins;
  const validScanlines = rgbaScanlines();
  const cases = [
    ["truncated IDAT zlib stream", structurallyCompletePng({ idatBytes: Buffer.from([120, 156]) })],
    [
      "trailing zlib data",
      structurallyCompletePng({
        idatBytes: Buffer.concat([deflateSync(validScanlines), Buffer.from([0])]),
      }),
    ],
    [
      "wrong decoded scanline length",
      structurallyCompletePng({ idatBytes: deflateSync(validScanlines.subarray(0, -1)) }),
    ],
    [
      "invalid scanline filter",
      structurallyCompletePng({ idatBytes: deflateSync(rgbaScanlines({ filter: 5 })) }),
    ],
    [
      "decoded output larger than the fixed image bound",
      structurallyCompletePng({ idatBytes: deflateSync(Buffer.alloc(64 * 257 + 1)) }),
    ],
    ["unsupported Adam7 interlace", structurallyCompletePng({ interlace: 1 })],
    ["invalid IHDR compression method", structurallyCompletePng({ compression: 1 })],
    ["invalid IHDR filter method", structurallyCompletePng({ filter: 1 })],
  ];
  for (const [description, image] of cases) {
    await withFixture(
      { skins },
      Object.fromEntries(themes.map((theme, index) => [`runtime:${skinPaths[index]}`, image])),
      async (root) => {
        await assert.rejects(validateAvatarAssets(root), /64x64 RGBA PNG/i, description);
      },
    );
  }
});

test("bounds every validator file read before parsing asset bytes", async () => {
  const overLimitAncillary = structurallyCompletePng({
    ancillaryChunks: [chunk("abAb", Buffer.alloc(2 * 1024 * 1024))],
  });
  const skins = manifest().skins;
  await withFixture(
    { skins },
    Object.fromEntries(
      themes.map((theme, index) => [`runtime:${skinPaths[index]}`, overLimitAncillary]),
    ),
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /asset exceeds maximum size/i);
    },
  );

  await withFixture({ padding: "x".repeat(64 * 1024) }, {}, async (root) => {
    await assert.rejects(validateAvatarAssets(root), /asset exceeds maximum size/i);
  });

  const oversizedSource = Buffer.concat([
    turnaround,
    Buffer.alloc(4 * 1024 * 1024 - turnaround.length + 1),
  ]);
  await withFixture({}, { "source/whitelily-turnaround.png": oversizedSource }, async (root) => {
    await assert.rejects(validateAvatarAssets(root), /asset exceeds maximum size/i);
  });

  await withFixture(
    {},
    { "blockbench/whitelily.bbmodel": Buffer.alloc(4 * 1024 * 1024 + 1) },
    async (root) => {
      await assert.rejects(validateAvatarAssets(root), /asset exceeds maximum size/i);
    },
  );

  const root = await fixture();
  await writeFile(
    join(root, "source", "asset-license.json"),
    JSON.stringify({
      confirmedOn: "2026-07-28",
      authorization:
        "Project owner confirmed authorship/control and authorized public modification and redistribution.",
      padding: "x".repeat(64 * 1024),
    }),
  );
  try {
    await assert.rejects(
      validateAvatarAssets(pathToFileURL(`${root}\\`)),
      /asset exceeds maximum size/i,
    );
  } finally {
    await rm(dirname(root), { recursive: true, force: true });
  }
});

test("bounds handle reads and closes when a file grows after metadata", async () => {
  const maxBytes = 4;
  const reads = [];
  let closes = 0;
  const grownHandle = {
    stat: async () => fileStat(),
    read: async (buffer, offset, length, position) => {
      reads.push({ bufferLength: buffer.length, length, position });
      const data = Buffer.from("abcde").subarray(position, position + length);
      data.copy(buffer, offset);
      return { bytesRead: data.length, buffer };
    },
    close: async () => {
      closes += 1;
    },
  };
  await assert.rejects(
    readBoundedFile(async () => grownHandle, maxBytes, "test file"),
    /asset exceeds maximum size/i,
  );
  assert.equal(closes, 1);
  assert.deepEqual(reads, [{ bufferLength: 5, length: 5, position: 0 }]);

  const chunks = [Buffer.from("ab"), Buffer.from("cd"), Buffer.alloc(0)];
  const safeReads = [];
  closes = 0;
  const safeHandle = {
    stat: async () => fileStat(),
    read: async (buffer, offset, length, position) => {
      safeReads.push({ bufferLength: buffer.length, length, position });
      const data = chunks.shift().subarray(0, length);
      data.copy(buffer, offset);
      return { bytesRead: data.length, buffer };
    },
    close: async () => {
      closes += 1;
    },
  };
  assert.deepEqual(
    await readBoundedFile(async () => safeHandle, maxBytes, "test file"),
    Buffer.from("abcd"),
  );
  assert.equal(closes, 1);
  assert.deepEqual(safeReads, [
    { bufferLength: 5, length: 5, position: 0 },
    { bufferLength: 5, length: 3, position: 2 },
    { bufferLength: 5, length: 1, position: 4 },
  ]);
});

test("rejects a handle that shrinks before EOF", async () => {
  let stats = 0;
  let closes = 0;
  const chunks = [Buffer.from("abc"), Buffer.alloc(0)];
  const handle = {
    stat: async () => fileStat({ size: stats++ === 0 ? 4n : 3n }),
    read: async (buffer, offset, length) => {
      const data = chunks.shift().subarray(0, length);
      data.copy(buffer, offset);
      return { bytesRead: data.length, buffer };
    },
    close: async () => {
      closes += 1;
    },
  };
  await assert.rejects(
    readBoundedFile(async () => handle, 4, "test file"),
    /asset changed during read/i,
  );
  assert.equal(closes, 1);
});

test("requires stable path and handle identity snapshots", async () => {
  assert.equal(typeof readStableFile, "function");
  const base = fileStat();
  const replacement = fileStat({ ino: 2n });
  const handle = {
    stat: async () => base,
    read: async (buffer) => {
      Buffer.from("abcd").copy(buffer);
      return { bytesRead: 4, buffer };
    },
    close: async () => {},
  };
  let lstatCall = 0;
  await assert.rejects(
    readStableFile(
      {
        lstatFile: async () => (lstatCall++ === 0 ? base : replacement),
        openFile: async () => handle,
      },
      4,
      "test file",
    ),
    /asset changed during read/i,
  );

  lstatCall = 0;
  await assert.rejects(
    readStableFile(
      {
        lstatFile: async () => (lstatCall++ === 0 ? base : fileStat({ symbolicLink: true })),
        openFile: async () => handle,
      },
      4,
      "test file",
    ),
    /symlinked assets are prohibited/i,
  );
});

test("rejects invalid reader limits before opening a handle", async () => {
  for (const maxBytes of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    4 * 1024 * 1024 + 1,
  ]) {
    let opens = 0;
    await assert.rejects(
      readBoundedFile(
        async () => {
          opens += 1;
          throw new Error("must not open");
        },
        maxBytes,
        "test file",
      ),
      /invalid asset size limit/i,
    );
    assert.equal(opens, 0);
  }
});

test("preserves primary I/O failures while reporting close-only failures", async () => {
  const base = fileStat();
  let closes = 0;
  const readAndCloseFailure = {
    stat: async () => base,
    read: async () => {
      throw new Error("read exploded");
    },
    close: async () => {
      closes += 1;
      throw new Error("close exploded");
    },
  };
  await assert.rejects(
    readBoundedFile(async () => readAndCloseFailure, 4, "test file"),
    (error) =>
      error.message.includes("asset read failed") && error.cause?.message === "read exploded",
  );
  assert.equal(closes, 1);

  closes = 0;
  let closeOnlyReads = 0;
  const closeOnlyFailure = {
    stat: async () => base,
    read: async (buffer) => {
      if (closeOnlyReads++ > 0) return { bytesRead: 0, buffer };
      Buffer.from("abcd").copy(buffer);
      return { bytesRead: 4, buffer };
    },
    close: async () => {
      closes += 1;
      throw new Error("close exploded");
    },
  };
  await assert.rejects(
    readBoundedFile(async () => closeOnlyFailure, 4, "test file"),
    (error) =>
      error.message.includes("asset close failed") && error.cause?.message === "close exploded",
  );
  assert.equal(closes, 1);
});

test("rejects absolute and traversal paths in manifest asset declarations", async () => {
  for (const path of [
    "C:\\escape.png",
    "/escape.png",
    "source/../escape.png",
    "../escape.png",
    "source\\..\\escape.png",
  ]) {
    await withFixture({ sources: [{ path, sha256: digest(turnaround) }] }, {}, async (root) => {
      await assert.rejects(validateAvatarAssets(root), /unsafe manifest path/i);
    });
  }
});

test("rejects runtime files that the manifest does not declare", async () => {
  await withFixture({}, { "blockbench/orphan.bbmodel": "{}" }, async (root) => {
    await assert.rejects(validateAvatarAssets(root), /undeclared runtime asset/i);
  });
});
