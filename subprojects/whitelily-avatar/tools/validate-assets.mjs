import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { renderSkinFrontPreview } from "./skin-front-preview.mjs";

const EXPECTED_THEMES = ["base", "leather", "iron", "gold", "diamond", "netherite"];
const EXPECTED_BONES = [
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
const EXPECTED_BASE_PALETTE = ["#F7F6F2", "#E9F1EA", "#CDE2C8", "#D4C7A3", "#A67C52"];
const RUNTIME_PREFIX = "assets/whitelily_avatar";
const EXPECTED_GEOMETRY = `${RUNTIME_PREFIX}/geckolib/models/whitelily.geo.json`;
const EXPECTED_ENTITY_TEXTURES = EXPECTED_THEMES.map(
  (theme) => `${RUNTIME_PREFIX}/textures/entity/${theme}.png`,
);
const EXPECTED_SKINS = EXPECTED_THEMES.map(
  (theme) => `${RUNTIME_PREFIX}/textures/skin/${theme}.png`,
);
const EXPECTED_SKIN_PREVIEWS = EXPECTED_THEMES.map((theme) => `previews/skins/${theme}-front.png`);
const EXPECTED_MODEL_PREVIEWS = new Set(
  EXPECTED_THEMES.flatMap((theme) =>
    ["front", "back", "left", "right", "top", "bottom"].map(
      (view) => `previews/${theme}-${view}.png`,
    ),
  ),
);
const EXPECTED_SOURCES = new Map([
  [
    "source/whitelily-turnaround.png",
    "572E52D22255C9D36328C48A114DFE30F89988B676122B7025A16AF062935CD6",
  ],
  [
    "source/whitelily-armor-themes.png",
    "8BFA790FBFAC1C5E5816765FAC5D4466FDB856B9C3FA407C725B9C29270D5A46",
  ],
]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_BIT_DEPTHS = new Map([
  [0, [1, 2, 4, 8, 16]],
  [2, [8, 16]],
  [3, [1, 2, 4, 8]],
  [4, [8, 16]],
  [6, [8, 16]],
]);
const PNG_CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_LICENSE_BYTES = 64 * 1024;
const MAX_SKIN_PNG_BYTES = 1024 * 1024;
const MAX_ENTITY_PNG_BYTES = 1024 * 1024;
const MAX_SOURCE_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_COMPRESSED_SKIN_BYTES = 1024 * 1024;
const MAX_PNG_CHUNKS = 256;

function failure(message, cause) {
  return cause === undefined
    ? new Error(`WhiteLily asset validation failed: ${message}`)
    : new Error(`WhiteLily asset validation failed: ${message}`, { cause });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asAssetRoot(root) {
  if (root instanceof URL) {
    if (root.protocol !== "file:") throw failure("asset root must be a file URL");
    return path.resolve(fileURLToPath(root));
  }
  if (typeof root !== "string") throw failure("asset root must be a path or file URL");
  return path.resolve(root);
}

function safeAssetPath(root, declaredPath) {
  if (typeof declaredPath !== "string" || declaredPath.length === 0) {
    throw failure("unsafe manifest path");
  }
  if (
    declaredPath.includes("\\") ||
    declaredPath.startsWith("/") ||
    path.isAbsolute(declaredPath) ||
    path.win32.isAbsolute(declaredPath)
  ) {
    throw failure("unsafe manifest path");
  }
  const pieces = declaredPath.split("/");
  if (pieces.some((piece) => piece.length === 0 || piece === "." || piece === "..")) {
    throw failure("unsafe manifest path");
  }
  const resolved = path.resolve(root, ...pieces);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw failure("unsafe manifest path");
  }
  return { declaredPath, resolved };
}

function isValidationError(error) {
  return error instanceof Error && error.message.startsWith("WhiteLily asset validation failed:");
}

function stableReadError(error) {
  return isValidationError(error) ? error : failure("asset read failed", error);
}

function validatedMaxBytes(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_RUNTIME_ASSET_BYTES) {
    throw failure("invalid asset size limit");
  }
  return maxBytes;
}

function snapshot(metadata, invalidMessage, rejectSymlink) {
  if (rejectSymlink && metadata.isSymbolicLink?.()) {
    throw failure("symlinked assets are prohibited");
  }
  if (!metadata.isFile?.()) throw failure(invalidMessage);
  const fields = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "birthtimeNs"];
  if (fields.some((field) => typeof metadata[field] !== "bigint")) {
    throw failure("asset snapshot unavailable");
  }
  return Object.fromEntries(fields.map((field) => [field, metadata[field]]));
}

function sameSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function requireMatchingSnapshot(left, right) {
  if (!sameSnapshot(left, right)) throw failure("asset changed during read");
}

async function regularFile(filePath, missingMessage, maxBytes) {
  return readStableFile(
    {
      lstatFile: async () => {
        try {
          return await lstat(filePath, { bigint: true });
        } catch (error) {
          if (error.code === "ENOENT") throw failure(missingMessage);
          throw stableReadError(error);
        }
      },
      openFile: () => open(filePath, "r"),
    },
    maxBytes,
    missingMessage,
  );
}

export async function readBoundedFile(openFile, maxBytes, invalidMessage) {
  return readStableFile({ openFile }, maxBytes, invalidMessage);
}

export async function readStableFile({ lstatFile, openFile }, maxBytes, invalidMessage) {
  const limit = validatedMaxBytes(maxBytes);
  const limitBigInt = BigInt(limit);
  let handle;
  let value;
  let primaryError;
  try {
    const pathBefore = lstatFile ? snapshot(await lstatFile(), invalidMessage, true) : undefined;
    if (pathBefore && pathBefore.size > limitBigInt) throw failure("asset exceeds maximum size");

    handle = await openFile();
    const handleBefore = snapshot(await handle.stat({ bigint: true }), invalidMessage, false);
    if (handleBefore.size > limitBigInt) throw failure("asset exceeds maximum size");
    const pathAfterOpen = lstatFile ? snapshot(await lstatFile(), invalidMessage, true) : undefined;
    if (pathBefore) {
      requireMatchingSnapshot(pathBefore, handleBefore);
      requireMatchingSnapshot(pathBefore, pathAfterOpen);
    }

    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const remaining = buffer.length - total;
      const { bytesRead } = await handle.read(buffer, total, remaining, total);
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > remaining) {
        throw failure("asset read failed");
      }
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw failure("asset exceeds maximum size");
    }

    const handleAfter = snapshot(await handle.stat({ bigint: true }), invalidMessage, false);
    if (handleAfter.size > limitBigInt) throw failure("asset exceeds maximum size");
    const pathAfterRead = lstatFile ? snapshot(await lstatFile(), invalidMessage, true) : undefined;
    requireMatchingSnapshot(handleBefore, handleAfter);
    if (pathBefore) requireMatchingSnapshot(handleAfter, pathAfterRead);
    if (handleAfter.size !== BigInt(total)) throw failure("asset changed during read");
    value = buffer.subarray(0, total);
  } catch (error) {
    primaryError = stableReadError(error);
  }

  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      if (!primaryError) primaryError = failure("asset close failed", error);
    }
  }
  if (primaryError) throw primaryError;
  return value;
}

function requireExactThemes(themes) {
  if (
    !Array.isArray(themes) ||
    themes.length !== EXPECTED_THEMES.length ||
    themes.some((theme, index) => theme !== EXPECTED_THEMES[index])
  ) {
    throw failure("manifest must declare six exact themes");
  }
}

function sourceDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isPngChunkType(type) {
  return type.every((byte) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122));
}

function validatePngPixelData(
  idatParts,
  compressedLength,
  width,
  height,
  bitDepth,
  colorType,
  invalidPng,
) {
  const channels = PNG_CHANNELS.get(colorType);
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const decodedLength = height * (rowBytes + 1);
  let inflated;
  try {
    const result = inflateSync(Buffer.concat(idatParts, compressedLength), {
      info: true,
      maxOutputLength: decodedLength,
    });
    if (result.engine.bytesWritten !== compressedLength) throw invalidPng();
    inflated = result.buffer;
  } catch {
    throw invalidPng();
  }
  if (inflated.length !== decodedLength) throw invalidPng();
  for (let offset = 0; offset < inflated.length; offset += rowBytes + 1) {
    if (inflated[offset] > 4) throw invalidPng();
  }
  return inflated;
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function unfilterRgba(inflated, width, height, invalidPng) {
  const bytesPerPixel = 4;
  const rowBytes = width * bytesPerPixel;
  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  for (let y = 0; y < height; y += 1) {
    const inputRow = y * (rowBytes + 1);
    const outputRow = y * rowBytes;
    const filter = inflated[inputRow];
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[inputRow + 1 + x];
      const left = x >= bytesPerPixel ? pixels[outputRow + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[outputRow - rowBytes + x] : 0;
      const upperLeft =
        y > 0 && x >= bytesPerPixel ? pixels[outputRow - rowBytes + x - bytesPerPixel] : 0;
      let reconstructed;
      if (filter === 0) reconstructed = raw;
      else if (filter === 1) reconstructed = raw + left;
      else if (filter === 2) reconstructed = raw + above;
      else if (filter === 3) reconstructed = raw + Math.floor((left + above) / 2);
      else if (filter === 4) reconstructed = raw + paeth(left, above, upperLeft);
      else throw invalidPng();
      pixels[outputRow + x] = reconstructed & 0xff;
    }
  }
  return pixels;
}

function validateRgbaPng(bytes, { errorMessage, expectedWidth, expectedHeight, maxDimension }) {
  const invalidPng = () => failure(errorMessage);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw invalidPng();
  }

  let offset = 8;
  let sawIhdr = false;
  let sawPlte = false;
  let sawIdat = false;
  let idatEnded = false;
  let sawIend = false;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let compressedLength = 0;
  let chunkCount = 0;
  const idatParts = [];
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw invalidPng();
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS) throw invalidPng();
    const length = bytes.readUInt32BE(offset);
    if (length > MAX_SKIN_PNG_BYTES - 12) throw invalidPng();
    if (length > bytes.length - offset - 12) throw invalidPng();

    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (!isPngChunkType(typeBytes)) throw invalidPng();
    const type = typeBytes.toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if (pngCrc32(bytes.subarray(offset + 4, dataEnd)) !== expectedCrc) throw invalidPng();

    if (!sawIhdr) {
      if (type !== "IHDR" || length !== 13) throw invalidPng();
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      if (
        !PNG_BIT_DEPTHS.get(colorType)?.includes(bitDepth) ||
        width === 0 ||
        height === 0 ||
        (expectedWidth !== undefined && width !== expectedWidth) ||
        (expectedHeight !== undefined && height !== expectedHeight) ||
        (maxDimension !== undefined && (width > maxDimension || height > maxDimension)) ||
        bitDepth !== 8 ||
        colorType !== 6 ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        bytes[dataStart + 12] !== 0
      ) {
        throw invalidPng();
      }
      sawIhdr = true;
    } else {
      if (sawIdat && type !== "IDAT") idatEnded = true;
      if (type === "IHDR") throw invalidPng();
      if (type === "PLTE") {
        if (
          colorType === 6 ||
          sawPlte ||
          sawIdat ||
          length === 0 ||
          length % 3 !== 0 ||
          length > 768
        ) {
          throw invalidPng();
        }
        sawPlte = true;
      } else if (type === "IDAT") {
        if (idatEnded) throw invalidPng();
        compressedLength += length;
        if (compressedLength > MAX_COMPRESSED_SKIN_BYTES) throw invalidPng();
        idatParts.push(bytes.subarray(dataStart, dataEnd));
        sawIdat = true;
      } else if (type === "IEND") {
        if (length !== 0 || !sawIdat) throw invalidPng();
        sawIend = true;
        offset = dataEnd + 4;
        if (offset !== bytes.length) throw invalidPng();
        break;
      } else if (typeBytes[0] >= 65 && typeBytes[0] <= 90) {
        throw invalidPng();
      }
    }
    offset = dataEnd + 4;
  }
  if (!sawIhdr || !sawIdat || !sawIend || offset !== bytes.length) throw invalidPng();
  const inflated = validatePngPixelData(
    idatParts,
    compressedLength,
    width,
    height,
    bitDepth,
    colorType,
    invalidPng,
  );
  return {
    width,
    height,
    pixels: unfilterRgba(inflated, width, height, invalidPng),
  };
}

function validatePng64Rgba(bytes) {
  return validateRgbaPng(bytes, {
    errorMessage: "skin must be a complete 64x64 RGBA PNG",
    expectedWidth: 64,
    expectedHeight: 64,
  });
}

function validateSkinPreview(bytes) {
  return validateRgbaPng(bytes, {
    errorMessage: "skin preview must be a complete 128x256 RGBA PNG",
    expectedWidth: 128,
    expectedHeight: 256,
  });
}

function validateEntityTexture(bytes) {
  return validateRgbaPng(bytes, {
    errorMessage: "entity texture must be a complete RGBA PNG no larger than 256x256",
    maxDimension: 256,
  });
}

const REQUIRED_SKIN_BASE_RECTS = [
  [8, 0, 8, 8],
  [16, 0, 8, 8],
  [0, 8, 8, 8],
  [8, 8, 8, 8],
  [16, 8, 8, 8],
  [24, 8, 8, 8],
  [20, 16, 8, 4],
  [28, 16, 8, 4],
  [16, 20, 4, 12],
  [20, 20, 8, 12],
  [28, 20, 4, 12],
  [32, 20, 8, 12],
  [4, 16, 4, 4],
  [8, 16, 4, 4],
  [0, 20, 4, 12],
  [4, 20, 4, 12],
  [8, 20, 4, 12],
  [12, 20, 4, 12],
  [44, 16, 4, 4],
  [48, 16, 4, 4],
  [40, 20, 4, 12],
  [44, 20, 4, 12],
  [48, 20, 4, 12],
  [52, 20, 4, 12],
  [20, 48, 4, 4],
  [24, 48, 4, 4],
  [16, 52, 4, 12],
  [20, 52, 4, 12],
  [24, 52, 4, 12],
  [28, 52, 4, 12],
  [36, 48, 4, 4],
  [40, 48, 4, 4],
  [32, 52, 4, 12],
  [36, 52, 4, 12],
  [40, 52, 4, 12],
  [44, 52, 4, 12],
];
const REQUIRED_HEAD_OVERLAY_REGIONS = [
  [40, 8, 8, 2, 16],
  [40, 10, 1, 4, 4],
  [47, 10, 1, 4, 4],
  [45, 9, 2, 2, 4],
];
const SKIN_FEATURE_PIXELS = [
  [9, 11],
  [10, 11],
  [13, 11],
  [14, 11],
  [11, 14],
  [12, 14],
];

function validateSkinSemantics(pixels) {
  const pixel = (x, y) => pixels.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4);
  for (const [left, top, width, height] of REQUIRED_SKIN_BASE_RECTS) {
    for (let y = top; y < top + height; y += 1) {
      for (let x = left; x < left + width; x += 1) {
        if (pixel(x, y)[3] !== 255) throw failure("required skin base UV regions must be opaque");
      }
    }
  }
  let transparentOverlayPixels = 0;
  let opaqueOverlayPixels = 0;
  for (let y = 8; y < 16; y += 1) {
    for (let x = 40; x < 48; x += 1) {
      const alpha = pixel(x, y)[3];
      if (alpha === 0) transparentOverlayPixels += 1;
      if (alpha === 255) opaqueOverlayPixels += 1;
    }
  }
  if (transparentOverlayPixels < 32 || opaqueOverlayPixels < 24 || opaqueOverlayPixels > 32) {
    throw failure("skin head overlay must remain mostly transparent");
  }
  for (const [left, top, width, height, requiredOpaque] of REQUIRED_HEAD_OVERLAY_REGIONS) {
    let regionOpaque = 0;
    for (let y = top; y < top + height; y += 1) {
      for (let x = left; x < left + width; x += 1) {
        if (pixel(x, y)[3] === 255) regionOpaque += 1;
      }
    }
    if (regionOpaque < requiredOpaque) {
      throw failure("skin head overlay semantic coverage is incomplete");
    }
  }
  const reference = pixel(12, 10);
  for (const [x, y] of SKIN_FEATURE_PIXELS) {
    const feature = pixel(x, y);
    const overlay = pixel(x + 32, y);
    const contrast = Math.max(
      Math.abs(feature[0] - reference[0]),
      Math.abs(feature[1] - reference[1]),
      Math.abs(feature[2] - reference[2]),
    );
    if (overlay[3] !== 0 || contrast < 24) {
      throw failure("skin head overlay eye and mouth windows must remain visible");
    }
  }
}

async function walk(root, relativePath = "") {
  const directory = relativePath === "" ? root : path.join(root, relativePath);
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink()) throw failure("symlinked assets are prohibited");
  if (!metadata.isDirectory()) throw failure("asset root is not a directory");
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelative = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
    const childPath = path.join(root, childRelative);
    const childMetadata = await lstat(childPath);
    if (childMetadata.isSymbolicLink()) throw failure("symlinked assets are prohibited");
    if (childMetadata.isDirectory()) {
      files.push(...(await walk(root, childRelative)));
    } else if (childMetadata.isFile()) {
      files.push(childRelative);
    } else {
      throw failure("asset entries must be regular files");
    }
  }
  return files;
}

function exactArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function jsonAsset(bytes, message) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw failure(message);
  }
}

function manifestFile(entry, assetRoot, resourceRoot) {
  if (!isPlainObject(entry) || typeof entry.path !== "string") {
    throw failure("unsafe manifest path");
  }
  const rootName = entry.root ?? "assets";
  if (rootName !== "assets" && rootName !== "resources") {
    throw failure("unsafe manifest path");
  }
  const base = rootName === "resources" ? resourceRoot : assetRoot;
  return { rootName, ...safeAssetPath(base, entry.path) };
}

function requireExactBones(actual) {
  if (!exactArray(actual, EXPECTED_BONES)) {
    throw failure(`exact bone set must include held_item: expected ${EXPECTED_BONES.join(", ")}`);
  }
}

function inspectBlockbenchOutliner(blockbench) {
  if (!Array.isArray(blockbench.outliner) || !Array.isArray(blockbench.elements)) {
    throw failure("invalid Blockbench outliner hierarchy");
  }
  const names = [];
  const parents = new Map();
  const elementOwners = new Map();
  const groupIds = new Set();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const visit = (entries, parent = null) => {
    for (const entry of entries) {
      if (!isPlainObject(entry) || !Array.isArray(entry.children) || "parent" in entry) {
        throw failure("invalid Blockbench outliner hierarchy");
      }
      if (parents.has(entry.name)) throw failure("invalid Blockbench outliner hierarchy");
      if (
        typeof entry.uuid !== "string" ||
        !uuidPattern.test(entry.uuid) ||
        groupIds.has(entry.uuid)
      ) {
        throw failure("Blockbench group UUID contract is invalid");
      }
      groupIds.add(entry.uuid);
      names.push(entry.name);
      parents.set(entry.name, parent);
      for (const child of entry.children) {
        if (typeof child === "string") {
          if (elementOwners.has(child)) throw failure("invalid Blockbench element ownership");
          elementOwners.set(child, entry.name);
        } else {
          visit([child], entry.name);
        }
      }
    }
  };
  visit(blockbench.outliner);
  if (
    names.length !== EXPECTED_BONES.length ||
    EXPECTED_BONES.some((name) => !names.includes(name))
  ) {
    throw failure(`exact bone set must include held_item: expected ${EXPECTED_BONES.join(", ")}`);
  }
  const elementIds = blockbench.elements.map((element) => element?.uuid);
  if (
    elementIds.some((id) => typeof id !== "string") ||
    new Set(elementIds).size !== elementIds.length ||
    elementOwners.size !== elementIds.length ||
    elementIds.some((id) => !elementOwners.has(id))
  ) {
    throw failure("invalid Blockbench element ownership");
  }
  if (elementIds.some((id) => groupIds.has(id))) {
    throw failure("Blockbench group UUID contract is invalid");
  }
  return { parents, elementOwners };
}

function rgbaHexes(pixels) {
  const colors = new Set();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    colors.add(
      `#${pixels[offset].toString(16).padStart(2, "0")}${pixels[offset + 1]
        .toString(16)
        .padStart(2, "0")}${pixels[offset + 2].toString(16).padStart(2, "0")}`.toUpperCase(),
    );
  }
  return colors;
}

async function validateNativeSkinAssets(assetRoot, resourceRoot, namespaceRoot, allFiles, manifest) {
  if (
    manifest.worldRenderer !== "minecraft-skin" ||
    manifest.armModel !== "slim" ||
    manifest.defaultTheme !== "base"
  ) {
    throw failure("manifest must declare the native slim skin renderer");
  }
  requireExactThemes(manifest.themes);
  if (!Array.isArray(manifest.skins) || manifest.skins.length !== EXPECTED_THEMES.length) {
    throw failure("manifest must declare six exact fallback skin paths");
  }
  const skinPaths = [];
  const inspectedSkins = [];
  for (const [index, skin] of manifest.skins.entries()) {
    if (
      !isPlainObject(skin) ||
      skin.theme !== EXPECTED_THEMES[index] ||
      skin.path !== EXPECTED_SKINS[index] ||
      skin.root !== "resources"
    ) {
      throw failure("manifest must declare six exact fallback skin paths");
    }
    const safePath = safeAssetPath(resourceRoot, skin.path);
    const inspected = validatePng64Rgba(
      await regularFile(
        safePath.resolved,
        `missing declared runtime asset: ${safePath.declaredPath}`,
        MAX_SKIN_PNG_BYTES,
      ),
    );
    validateSkinSemantics(inspected.pixels);
    skinPaths.push(safePath.declaredPath);
    inspectedSkins.push(inspected);
  }

  if (!Array.isArray(manifest.runtimeAssets) || manifest.runtimeAssets.length !== EXPECTED_SKINS.length) {
    throw failure("invalid runtime asset declarations");
  }
  const runtimeDeclarations = new Set();
  for (const [index, runtimeAsset] of manifest.runtimeAssets.entries()) {
    const declared = manifestFile(runtimeAsset, assetRoot, resourceRoot);
    if (
      declared.rootName !== "resources" ||
      declared.declaredPath !== EXPECTED_SKINS[index] ||
      runtimeDeclarations.has(declared.declaredPath) ||
      typeof runtimeAsset.sha256 !== "string" ||
      !/^[0-9A-F]{64}$/.test(runtimeAsset.sha256)
    ) {
      throw failure("invalid runtime asset declarations");
    }
    const bytes = await regularFile(
      declared.resolved,
      `missing declared runtime asset: ${declared.declaredPath}`,
      MAX_SKIN_PNG_BYTES,
    );
    if (sourceDigest(bytes) !== runtimeAsset.sha256) {
      throw failure(`runtime asset SHA-256 mismatch: ${declared.declaredPath}`);
    }
    runtimeDeclarations.add(declared.declaredPath);
  }

  if (
    !Array.isArray(manifest.skinPreviews) ||
    manifest.skinPreviews.length !== EXPECTED_THEMES.length
  ) {
    throw failure("manifest must declare six exact skin preview paths");
  }
  const skinPreviewPaths = [];
  for (const [index, preview] of manifest.skinPreviews.entries()) {
    if (
      !isPlainObject(preview) ||
      preview.theme !== EXPECTED_THEMES[index] ||
      preview.path !== EXPECTED_SKIN_PREVIEWS[index] ||
      typeof preview.sha256 !== "string" ||
      !/^[0-9A-F]{64}$/.test(preview.sha256)
    ) {
      throw failure("manifest must declare six exact skin preview paths");
    }
    const safePath = safeAssetPath(assetRoot, preview.path);
    const bytes = await regularFile(
      safePath.resolved,
      `missing declared skin preview: ${safePath.declaredPath}`,
      MAX_SKIN_PNG_BYTES,
    );
    const inspected = validateSkinPreview(bytes);
    if (sourceDigest(bytes) !== preview.sha256) {
      throw failure(`skin preview SHA-256 mismatch: ${safePath.declaredPath}`);
    }
    const expectedPreview = renderSkinFrontPreview(inspectedSkins[index]);
    if (!inspected.pixels.equals(expectedPreview.pixels)) {
      throw failure(`skin preview pixels must match its fallback skin: ${safePath.declaredPath}`);
    }
    skinPreviewPaths.push(safePath.declaredPath);
  }

  if (!Array.isArray(manifest.conceptReferences) || manifest.conceptReferences.length !== 6) {
    throw failure("invalid concept reference declarations");
  }
  const declaredAssetFiles = new Set(["manifest.json", "source/asset-license.json", ...skinPreviewPaths]);
  for (const [index, concept] of manifest.conceptReferences.entries()) {
    if (!isPlainObject(concept) || concept.theme !== EXPECTED_THEMES[index] || typeof concept.sha256 !== "string") {
      throw failure("invalid concept reference declarations");
    }
    const safePath = safeAssetPath(assetRoot, concept.path);
    const bytes = await regularFile(safePath.resolved, `missing concept reference: ${safePath.declaredPath}`, MAX_RUNTIME_ASSET_BYTES);
    if (!/^[0-9A-F]{64}$/.test(concept.sha256) || sourceDigest(bytes) !== concept.sha256) {
      throw failure("concept reference SHA-256 mismatch");
    }
    declaredAssetFiles.add(safePath.declaredPath);
  }
  if (!Array.isArray(manifest.sources) || manifest.sources.length !== EXPECTED_SOURCES.size) {
    throw failure("invalid source declarations");
  }
  const declaredSources = new Set();
  for (const source of manifest.sources) {
    const safePath = safeAssetPath(assetRoot, source?.path);
    const expectedHash = EXPECTED_SOURCES.get(safePath.declaredPath);
    const bytes = await regularFile(safePath.resolved, "missing approved source image", MAX_SOURCE_IMAGE_BYTES);
    if (
      !expectedHash ||
      declaredSources.has(safePath.declaredPath) ||
      source.sha256 !== expectedHash ||
      sourceDigest(bytes) !== expectedHash
    ) {
      throw failure("invalid source declarations");
    }
    declaredSources.add(safePath.declaredPath);
    declaredAssetFiles.add(safePath.declaredPath);
  }

  const researchDirectories = new Set(manifest.researchAssetDirectories);
  if (
    !Array.isArray(manifest.researchAssetDirectories) ||
    researchDirectories.size !== manifest.researchAssetDirectories.length ||
    [...researchDirectories].some((entry) => typeof entry !== "string" || !entry.endsWith("/") || entry.includes(".."))
  ) {
    throw failure("invalid research asset declarations");
  }
  for (const file of allFiles) {
    if (declaredAssetFiles.has(file) || [...researchDirectories].some((directory) => file.startsWith(directory))) continue;
    throw failure(`undeclared asset: ${file}`);
  }

  if (!Array.isArray(manifest.researchRuntimeAssets)) throw failure("invalid research runtime declarations");
  const researchRuntime = new Set();
  for (const entry of manifest.researchRuntimeAssets) {
    const declared = manifestFile(entry, assetRoot, resourceRoot);
    if (declared.rootName !== "resources" || runtimeDeclarations.has(declared.declaredPath)) {
      throw failure("invalid research runtime declarations");
    }
    researchRuntime.add(declared.declaredPath);
  }
  const namespaceFiles = await walk(namespaceRoot);
  for (const relative of namespaceFiles) {
    const declared = `${RUNTIME_PREFIX}/${relative}`;
    if (!runtimeDeclarations.has(declared) && !researchRuntime.has(declared)) {
      throw failure(`undeclared runtime asset: ${declared}`);
    }
  }
  if (runtimeDeclarations.size + researchRuntime.size !== namespaceFiles.length) {
    throw failure("research runtime declarations do not match preserved files");
  }
  return {
    themes: [...manifest.themes], skinCount: skinPaths.length, skinPaths, skinPreviewPaths,
    skinPreviewCount: skinPreviewPaths.length, runtimeAssetCount: runtimeDeclarations.size,
    unreferencedTextureCount: 0, maxTextureDimension: 64,
  };
}

export async function validateAvatarAssets(root) {
  const assetRoot = asAssetRoot(root);
  const subprojectRoot = path.dirname(assetRoot);
  const resourceRoot = path.join(subprojectRoot, "mod-fabric", "src", "main", "resources");
  const namespaceRoot = path.join(resourceRoot, "assets", "whitelily_avatar");
  const allFiles = await walk(assetRoot);
  const manifestBytes = await regularFile(
    path.join(assetRoot, "manifest.json"),
    "missing manifest",
    MAX_MANIFEST_BYTES,
  );
  const manifest = jsonAsset(manifestBytes, "manifest is not valid JSON");
  if (!isPlainObject(manifest) || manifest.schemaVersion !== 2) {
    throw failure("unsupported manifest schema");
  }

  // Schema-v2 manifests without a renderer are historical migration inputs.  Native manifests
  // always take the skin-only path above; the retained branch below remains callable only to
  // validate those archived inputs while their research records are migrated.
  if (manifest.worldRenderer !== undefined) {
    return validateNativeSkinAssets(assetRoot, resourceRoot, namespaceRoot, allFiles, manifest);
  }

  requireExactThemes(manifest.themes);
  const declaredAssetFiles = new Set(["manifest.json", "source/asset-license.json"]);
  const declaredRuntimeFiles = new Set();

  if (
    !isPlainObject(manifest.model) ||
    manifest.model.blockbench !== "blockbench/whitelily.bbmodel" ||
    manifest.model.uvLayout !== "whitelily-avatar-uv-v1"
  ) {
    throw failure("invalid shared model declaration");
  }
  if (
    !Array.isArray(manifest.model.geometries) ||
    manifest.model.geometries.length !== 1 ||
    manifest.model.geometries[0] !== EXPECTED_GEOMETRY
  ) {
    throw failure("manifest must declare exactly one shared geometry");
  }
  requireExactBones(manifest.model.bones);

  const blockbenchPath = safeAssetPath(assetRoot, manifest.model.blockbench);
  const blockbenchBytes = await regularFile(
    blockbenchPath.resolved,
    `missing declared model: ${blockbenchPath.declaredPath}`,
    MAX_RUNTIME_ASSET_BYTES,
  );
  if (
    typeof manifest.model.sha256 !== "string" ||
    !/^[0-9A-F]{64}$/.test(manifest.model.sha256) ||
    sourceDigest(blockbenchBytes) !== manifest.model.sha256
  ) {
    throw failure("Blockbench SHA-256 mismatch");
  }
  const blockbench = jsonAsset(blockbenchBytes, "invalid Blockbench model");
  if (
    !isPlainObject(blockbench) ||
    blockbench.meta?.model_format !== "geckolib_model" ||
    blockbench.resolution?.width !== 128 ||
    blockbench.resolution?.height !== 128
  ) {
    throw failure("invalid Blockbench model");
  }
  const blockbenchOutliner = inspectBlockbenchOutliner(blockbench);
  declaredAssetFiles.add(blockbenchPath.declaredPath);

  const geometryPath = safeAssetPath(resourceRoot, manifest.model.geometries[0]);
  const geometry = jsonAsset(
    await regularFile(
      geometryPath.resolved,
      `missing declared runtime asset: ${geometryPath.declaredPath}`,
      MAX_RUNTIME_ASSET_BYTES,
    ),
    "invalid GeckoLib geometry",
  );
  const geometries = geometry?.["minecraft:geometry"];
  if (
    geometry?.format_version !== "1.12.0" ||
    !Array.isArray(geometries) ||
    geometries.length !== 1 ||
    geometries[0]?.description?.identifier !== "geometry.whitelily" ||
    geometries[0]?.description?.texture_width !== 128 ||
    geometries[0]?.description?.texture_height !== 128
  ) {
    throw failure("invalid GeckoLib geometry");
  }
  requireExactBones(geometries[0].bones?.map((bone) => bone?.name));
  const geometryParents = new Map(
    geometries[0].bones.map((bone) => [bone.name, bone.parent ?? null]),
  );
  if (
    [...geometryParents].some(([name, parent]) => blockbenchOutliner.parents.get(name) !== parent)
  ) {
    throw failure("Blockbench outliner hierarchy must match GeckoLib bone parents");
  }
  for (const bone of geometries[0].bones) {
    const ownedElements = [...blockbenchOutliner.elementOwners.values()].filter(
      (owner) => owner === bone.name,
    ).length;
    if (ownedElements !== (bone.cubes?.length ?? 0)) {
      throw failure("Blockbench element ownership must match GeckoLib bone cubes");
    }
  }
  declaredRuntimeFiles.add(geometryPath.declaredPath);

  if (
    !Array.isArray(manifest.entityTextures) ||
    manifest.entityTextures.length !== EXPECTED_THEMES.length
  ) {
    throw failure("manifest must declare six exact entity textures");
  }
  const entityTexturePaths = [];
  const entityTextureThemes = [];
  let entityTextureSize;
  let basePixels;
  for (const [index, texture] of manifest.entityTextures.entries()) {
    if (
      !isPlainObject(texture) ||
      texture.theme !== EXPECTED_THEMES[index] ||
      texture.path !== EXPECTED_ENTITY_TEXTURES[index] ||
      texture.root !== "resources" ||
      texture.uvLayout !== manifest.model.uvLayout
    ) {
      if (texture?.uvLayout !== manifest.model.uvLayout) {
        throw failure("all entity textures must use the shared UV layout");
      }
      throw failure("manifest must declare six exact entity textures");
    }
    const safePath = safeAssetPath(resourceRoot, texture.path);
    const inspected = validateEntityTexture(
      await regularFile(
        safePath.resolved,
        `missing declared runtime asset: ${safePath.declaredPath}`,
        MAX_ENTITY_PNG_BYTES,
      ),
    );
    if (
      entityTextureSize &&
      (inspected.width !== entityTextureSize.width || inspected.height !== entityTextureSize.height)
    ) {
      throw failure("entity textures must have matching dimensions");
    }
    entityTextureSize ??= { width: inspected.width, height: inspected.height };
    if (index === 0) basePixels = inspected.pixels;
    entityTextureThemes.push(texture.theme);
    entityTexturePaths.push(safePath.declaredPath);
    declaredRuntimeFiles.add(safePath.declaredPath);
  }
  requireExactThemes(entityTextureThemes);
  const baseColors = rgbaHexes(basePixels);
  if (EXPECTED_BASE_PALETTE.some((color) => !baseColors.has(color))) {
    throw failure("base entity texture must preserve the approved base palette");
  }

  if (!Array.isArray(manifest.skins) || manifest.skins.length !== EXPECTED_THEMES.length) {
    throw failure("manifest must declare six exact themes");
  }
  const skinThemes = [];
  const skinPaths = [];
  const inspectedSkins = [];
  for (const [index, skin] of manifest.skins.entries()) {
    if (
      !isPlainObject(skin) ||
      skin.theme !== EXPECTED_THEMES[index] ||
      skin.path !== EXPECTED_SKINS[index] ||
      skin.root !== "resources"
    ) {
      throw failure("manifest must declare six exact fallback skin paths");
    }
    skinThemes.push(skin.theme);
    const safePath = safeAssetPath(resourceRoot, skin.path);
    if (
      declaredRuntimeFiles.has(safePath.declaredPath) ||
      declaredAssetFiles.has(safePath.declaredPath)
    ) {
      throw failure("duplicate manifest asset path");
    }
    const inspected = validatePng64Rgba(
      await regularFile(
        safePath.resolved,
        `missing declared runtime asset: ${safePath.declaredPath}`,
        MAX_SKIN_PNG_BYTES,
      ),
    );
    validateSkinSemantics(inspected.pixels);
    inspectedSkins.push(inspected);
    declaredRuntimeFiles.add(safePath.declaredPath);
    skinPaths.push(safePath.declaredPath);
  }
  requireExactThemes(skinThemes);

  if (
    !Array.isArray(manifest.skinPreviews) ||
    manifest.skinPreviews.length !== EXPECTED_THEMES.length
  ) {
    throw failure("manifest must declare six exact skin preview paths");
  }
  const skinPreviewPaths = [];
  const inspectedSkinPreviews = [];
  for (const [index, preview] of manifest.skinPreviews.entries()) {
    if (
      !isPlainObject(preview) ||
      preview.theme !== EXPECTED_THEMES[index] ||
      preview.path !== EXPECTED_SKIN_PREVIEWS[index] ||
      typeof preview.sha256 !== "string" ||
      !/^[0-9A-F]{64}$/.test(preview.sha256)
    ) {
      throw failure("manifest must declare six exact skin preview paths");
    }
    const safePath = safeAssetPath(assetRoot, preview.path);
    if (declaredAssetFiles.has(safePath.declaredPath)) {
      throw failure("duplicate manifest asset path");
    }
    const previewBytes = await regularFile(
      safePath.resolved,
      `missing declared skin preview: ${safePath.declaredPath}`,
      MAX_SKIN_PNG_BYTES,
    );
    inspectedSkinPreviews.push(validateSkinPreview(previewBytes));
    if (sourceDigest(previewBytes) !== preview.sha256) {
      throw failure(`skin preview SHA-256 mismatch: ${safePath.declaredPath}`);
    }
    declaredAssetFiles.add(safePath.declaredPath);
    skinPreviewPaths.push(safePath.declaredPath);
  }

  if (!Array.isArray(manifest.sources)) throw failure("invalid source declarations");
  const declaredSources = new Set();
  for (const source of manifest.sources) {
    if (!isPlainObject(source)) throw failure("invalid source declarations");
    const safePath = safeAssetPath(assetRoot, source.path);
    const approvedDigest = EXPECTED_SOURCES.get(safePath.declaredPath);
    if (!approvedDigest || source.sha256 !== approvedDigest) {
      throw failure("source SHA-256 mismatch");
    }
    const actualDigest = sourceDigest(
      await regularFile(safePath.resolved, "missing approved source image", MAX_SOURCE_IMAGE_BYTES),
    );
    if (actualDigest !== approvedDigest || declaredSources.has(safePath.declaredPath)) {
      throw failure("source SHA-256 mismatch");
    }
    declaredSources.add(safePath.declaredPath);
    declaredAssetFiles.add(safePath.declaredPath);
  }
  if (declaredSources.size !== EXPECTED_SOURCES.size) throw failure("invalid source declarations");

  if (
    !Array.isArray(manifest.conceptReferences) ||
    manifest.conceptReferences.length !== EXPECTED_THEMES.length
  ) {
    throw failure("invalid concept reference declarations");
  }
  for (const [index, concept] of manifest.conceptReferences.entries()) {
    if (
      !isPlainObject(concept) ||
      concept.theme !== EXPECTED_THEMES[index] ||
      typeof concept.sha256 !== "string" ||
      !/^[0-9A-F]{64}$/.test(concept.sha256)
    ) {
      throw failure("invalid concept reference declarations");
    }
    const safePath = safeAssetPath(assetRoot, concept.path);
    const actualDigest = sourceDigest(
      await regularFile(
        safePath.resolved,
        `missing concept reference: ${safePath.declaredPath}`,
        MAX_RUNTIME_ASSET_BYTES,
      ),
    );
    if (actualDigest !== concept.sha256 || declaredAssetFiles.has(safePath.declaredPath)) {
      throw failure("concept reference SHA-256 mismatch");
    }
    declaredAssetFiles.add(safePath.declaredPath);
  }

  const licenseBytes = await regularFile(
    path.join(assetRoot, "source", "asset-license.json"),
    "missing license declaration",
    MAX_LICENSE_BYTES,
  );
  const license = jsonAsset(licenseBytes, "invalid license declaration");
  if (
    !isPlainObject(license) ||
    license.confirmedOn !== "2026-07-28" ||
    license.authorization !==
      "Project owner confirmed authorship/control and authorized public modification and redistribution."
  ) {
    throw failure("invalid license declaration");
  }

  const expectedRuntime = new Set([
    EXPECTED_GEOMETRY,
    ...EXPECTED_ENTITY_TEXTURES,
    ...EXPECTED_SKINS,
  ]);
  if (
    !Array.isArray(manifest.runtimeAssets) ||
    manifest.runtimeAssets.length !== expectedRuntime.size
  ) {
    throw failure("invalid runtime asset declarations");
  }
  const runtimeDeclarations = new Set();
  for (const runtimeAsset of manifest.runtimeAssets) {
    const declared = manifestFile(runtimeAsset, assetRoot, resourceRoot);
    if (
      declared.rootName !== "resources" ||
      !expectedRuntime.has(declared.declaredPath) ||
      runtimeDeclarations.has(declared.declaredPath) ||
      typeof runtimeAsset.sha256 !== "string" ||
      !/^[0-9A-F]{64}$/.test(runtimeAsset.sha256)
    ) {
      throw failure("invalid runtime asset declarations");
    }
    const runtimeBytes = await regularFile(
      declared.resolved,
      `missing declared runtime asset: ${declared.declaredPath}`,
      MAX_RUNTIME_ASSET_BYTES,
    );
    if (sourceDigest(runtimeBytes) !== runtimeAsset.sha256) {
      throw failure(`runtime asset SHA-256 mismatch: ${declared.declaredPath}`);
    }
    runtimeDeclarations.add(declared.declaredPath);
  }
  if (runtimeDeclarations.size !== expectedRuntime.size) {
    throw failure("invalid runtime asset declarations");
  }

  for (const [index, inspectedPreview] of inspectedSkinPreviews.entries()) {
    const expectedPreview = renderSkinFrontPreview(inspectedSkins[index]);
    if (
      inspectedPreview.width !== expectedPreview.width ||
      inspectedPreview.height !== expectedPreview.height ||
      !inspectedPreview.pixels.equals(expectedPreview.pixels)
    ) {
      throw failure(`skin preview pixels must match its fallback skin: ${skinPreviewPaths[index]}`);
    }
  }

  for (const file of allFiles) {
    if (file === "manifest.json" || EXPECTED_MODEL_PREVIEWS.has(file)) continue;
    if (!declaredAssetFiles.has(file)) {
      if (file.startsWith("previews/")) throw failure(`undeclared preview asset: ${file}`);
      throw failure(`undeclared runtime asset: ${file}`);
    }
  }

  const namespaceFiles = await walk(namespaceRoot);
  for (const relative of namespaceFiles) {
    const declaredPath = `${RUNTIME_PREFIX}/${relative}`;
    if (declaredRuntimeFiles.has(declaredPath)) continue;
    if (relative.startsWith("textures/") && relative.endsWith(".png")) {
      throw failure(`unreferenced texture: ${relative}`);
    }
    throw failure(`undeclared runtime asset: ${relative}`);
  }

  return {
    themes: [...manifest.themes],
    sourceCount: manifest.sources.length,
    skinCount: manifest.skins.length,
    blockbenchPath: blockbenchPath.declaredPath,
    geometryPaths: [geometryPath.declaredPath],
    bones: [...EXPECTED_BONES],
    entityTexturePaths,
    entityTextureSize,
    sharedUvLayout: manifest.model.uvLayout,
    basePalette: [...EXPECTED_BASE_PALETTE],
    skinPaths,
    skinPreviewPaths,
    skinPreviewCount: skinPreviewPaths.length,
    runtimeAssetCount: runtimeDeclarations.size,
    unreferencedTextureCount: 0,
    maxTextureDimension: Math.max(entityTextureSize.width, entityTextureSize.height, 64),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await validateAvatarAssets(new URL("../assets/", import.meta.url));
  console.log("WhiteLily native skin asset validation passed.");
}
