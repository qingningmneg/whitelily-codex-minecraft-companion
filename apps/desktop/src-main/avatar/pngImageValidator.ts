import { deflateSync } from "node:zlib";
import {
  pngCrc32,
  renderSkinFrontPreview,
  validateRgbaPng,
} from "../../../../subprojects/whitelily-avatar/tools/validate-assets.mjs";

export type PngImageValidationCode = "AVATAR_SKIN_INVALID" | "AVATAR_PORTRAIT_INVALID";

export class PngImageValidationError extends Error {
  constructor(
    readonly code: PngImageValidationCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "PngImageValidationError";
  }
}

export interface ValidatedMinecraftSkin {
  readonly width: 64;
  readonly height: 64;
  readonly pixels: Buffer;
}

export interface ValidatedPortrait {
  readonly width: number;
  readonly height: number;
}

const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_PNG_DIMENSION = 4_096;
const REQUIRED_BASE_UV_RECTS = [
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
] as const;

export function validateMinecraftSkin(bytes: Buffer): ValidatedMinecraftSkin {
  try {
    const image = validateRgbaPng(bytes, {
      errorMessage: "invalid Minecraft skin PNG",
      expectedWidth: 64,
      expectedHeight: 64,
      maximumBytes: MAX_PNG_BYTES,
      maximumCompressedBytes: MAX_PNG_BYTES,
    });
    assertOpaqueBaseUv(image.pixels);
    return { width: 64, height: 64, pixels: image.pixels };
  } catch (error) {
    throw new PngImageValidationError("AVATAR_SKIN_INVALID", "Minecraft skin PNG is invalid", {
      cause: error,
    });
  }
}

export function validatePortrait(bytes: Buffer): ValidatedPortrait {
  try {
    const image = validateRgbaPng(bytes, {
      errorMessage: "invalid portrait PNG",
      maxDimension: MAX_PNG_DIMENSION,
      maximumBytes: MAX_PNG_BYTES,
      maximumCompressedBytes: MAX_PNG_BYTES,
      decodePixels: false,
    });
    return { width: image.width, height: image.height };
  } catch (error) {
    throw new PngImageValidationError("AVATAR_PORTRAIT_INVALID", "portrait PNG is invalid", {
      cause: error,
    });
  }
}

export function createDeterministicSkinPreview(skin: ValidatedMinecraftSkin): Buffer {
  const preview = renderSkinFrontPreview(
    { width: skin.width, height: skin.height, pixels: skin.pixels },
    { scale: 8 },
  );
  return encodeRgbaPng(preview.width, preview.height, preview.pixels);
}

function encodeRgbaPng(width: number, height: number, pixels: Buffer): Buffer {
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    pixels.copy(raw, row * (rowBytes + 1) + 1, row * rowBytes, (row + 1) * rowBytes);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function assertOpaqueBaseUv(pixels: Buffer): void {
  for (const [left, top, width, height] of REQUIRED_BASE_UV_RECTS) {
    for (let y = top; y < top + height; y += 1) {
      for (let x = left; x < left + width; x += 1) {
        if (pixels[(y * 64 + x) * 4 + 3] !== 255) {
          throw new Error("Minecraft skin base UV must be opaque");
        }
      }
    }
  }
}
