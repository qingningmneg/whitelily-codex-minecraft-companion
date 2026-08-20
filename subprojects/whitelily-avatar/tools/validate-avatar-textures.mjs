import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REQUIRED_PALETTE = ["#f7f6f2", "#e9f1ea", "#cde2c8", "#d4c7a3", "#a67c52"];
const REQUIRED_IRIS_SAMPLES = [
  { role: "deep", coordinate: [521, 241], hex: "#7f815f" },
  { role: "mid", coordinate: [524, 240], hex: "#909770" },
  { role: "highlight", coordinate: [530, 240], hex: "#baba98" },
];

function fail(code) {
  throw new Error(code);
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) fail("AVATAR_TEXTURE_PNG_INVALID");
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  const compressed = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0)
        fail("AVATAR_TEXTURE_PNG_UNSUPPORTED");
    } else if (type === "IDAT") compressed.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  if (!width || !height || bitDepth !== 8 || !new Set([2, 6]).has(colorType))
    fail("AVATAR_TEXTURE_PNG_UNSUPPORTED");
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(compressed));
  if (inflated.length !== (stride + 1) * height) fail("AVATAR_TEXTURE_PNG_INVALID");
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const sourceOffset = y * (stride + 1);
    const outputOffset = y * stride;
    const filter = inflated[sourceOffset];
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + x + 1];
      const left = x >= channels ? pixels[outputOffset + x - channels] : 0;
      const above = y > 0 ? pixels[outputOffset - stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[outputOffset - stride + x - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + above;
      else if (filter === 3) value = raw + Math.floor((left + above) / 2);
      else if (filter === 4) value = raw + paeth(left, above, upperLeft);
      else fail("AVATAR_TEXTURE_PNG_UNSUPPORTED");
      pixels[outputOffset + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function pixelHex(image, coordinate) {
  const [x, y] = coordinate;
  if (x < 0 || y < 0 || x >= image.width || y >= image.height)
    fail("AVATAR_TEXTURE_SAMPLE_INVALID");
  const offset = (y * image.width + x) * image.channels;
  return `#${image.pixels.subarray(offset, offset + 3).toString("hex")}`;
}

function statistics(image) {
  let pureWhitePixels = 0;
  let pureBlackPixels = 0;
  let missingPurplePixels = 0;
  let transparentPixels = 0;
  for (let offset = 0; offset < image.pixels.length; offset += image.channels) {
    const red = image.pixels[offset];
    const green = image.pixels[offset + 1];
    const blue = image.pixels[offset + 2];
    const alpha = image.channels === 4 ? image.pixels[offset + 3] : 255;
    if (red === 255 && green === 255 && blue === 255) pureWhitePixels += 1;
    if (red === 0 && green === 0 && blue === 0) pureBlackPixels += 1;
    if (red >= 224 && green <= 32 && blue >= 224) missingPurplePixels += 1;
    if (alpha < 255) transparentPixels += 1;
  }
  return { pureWhitePixels, pureBlackPixels, missingPurplePixels, transparentPixels };
}

async function readJson(filename, code) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch {
    fail(code);
  }
}

export async function validateAvatarTextures(avatarRoot) {
  const palettePath = path.join(avatarRoot, "assets", "palettes", "whitelily-base.json");
  const palette = await readJson(palettePath, "AVATAR_TEXTURE_PALETTE_INVALID");
  const requiredPalette = palette.requiredPalette?.map((color) => color.toLowerCase());
  if (JSON.stringify(requiredPalette) !== JSON.stringify(REQUIRED_PALETTE))
    fail("AVATAR_TEXTURE_PALETTE_INVALID");
  const irisSamples = palette.irisSamples?.map(({ role, coordinate, hex }) => ({
    role,
    coordinate,
    hex: hex.toLowerCase(),
  }));
  if (JSON.stringify(irisSamples) !== JSON.stringify(REQUIRED_IRIS_SAMPLES))
    fail("AVATAR_TEXTURE_IRIS_SAMPLES_INVALID");
  if (palette.atlas?.embedded !== true || palette.atlas.externalUris?.length !== 0)
    fail("AVATAR_TEXTURE_EXTERNAL_URI_FORBIDDEN");
  if (
    JSON.stringify(palette.atlas.size) !== "[2048,2048]" ||
    palette.atlas.colorType !== "RGBA" ||
    palette.atlas.mipPaddingPx !== 16
  )
    fail("AVATAR_TEXTURE_ATLAS_CONTRACT_INVALID");

  const albedo = decodePng(await readFile(path.join(avatarRoot, palette.atlas.albedo)));
  const control = decodePng(await readFile(path.join(avatarRoot, palette.atlas.control)));
  if (albedo.width !== 2048 || albedo.height !== 2048 || albedo.channels !== 4)
    fail("AVATAR_TEXTURE_ALBEDO_INVALID");
  if (control.width !== 2048 || control.height !== 2048 || control.channels !== 4)
    fail("AVATAR_TEXTURE_CONTROL_INVALID");

  const turnaround = decodePng(
    await readFile(path.join(avatarRoot, "assets", "source", "whitelily-turnaround.png")),
  );
  for (const sample of REQUIRED_IRIS_SAMPLES) {
    if (pixelHex(turnaround, sample.coordinate) !== sample.hex)
      fail("AVATAR_TEXTURE_IRIS_SAMPLE_MISMATCH");
  }

  return {
    size: [albedo.width, albedo.height],
    controlSize: [control.width, control.height],
    colorType: "RGBA",
    controlColorType: "RGBA",
    requiredPalette,
    irisSamples,
    mipPaddingPx: palette.atlas.mipPaddingPx,
    externalUris: palette.atlas.externalUris,
    albedoStatistics: statistics(albedo),
    controlStatistics: statistics(control),
  };
}
