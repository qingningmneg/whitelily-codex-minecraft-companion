import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  PngImageValidationError,
  validateMinecraftSkin,
  validatePortrait,
} from "./pngImageValidator.js";

describe("PNG avatar image validation", () => {
  it("accepts only a complete 64x64 rgba skin with opaque base UV pixels", () => {
    expect(validateMinecraftSkin(validSkinBytes())).toMatchObject({ width: 64, height: 64 });
    expectCode(() => validateMinecraftSkin(png({ width: 64, height: 32 })), "AVATAR_SKIN_INVALID");
    expectCode(
      () => validateMinecraftSkin(png({ width: 64, height: 64, colorType: 2 })),
      "AVATAR_SKIN_INVALID",
    );
    expectCode(() => validateMinecraftSkin(skinWithTransparentBaseUv()), "AVATAR_SKIN_INVALID");
  });

  it("rejects malformed chunks, bad CRCs, and decompression output that is not exact", () => {
    const complete = validSkinBytes();
    const badCrc = Buffer.from(complete);
    badCrc[badCrc.length - 5] ^= 0xff;
    expectCode(() => validateMinecraftSkin(badCrc), "AVATAR_SKIN_INVALID");
    expectCode(
      () => validateMinecraftSkin(Buffer.concat([complete, Buffer.from([0])])),
      "AVATAR_SKIN_INVALID",
    );
    expectCode(
      () => validateMinecraftSkin(png({ width: 64, height: 64, raw: Buffer.alloc(1) })),
      "AVATAR_SKIN_INVALID",
    );
  });

  it("bounds optional portraits to 1x1 through 4096x4096 RGBA PNGs", () => {
    expect(validatePortrait(png({ width: 1, height: 1 }))).toMatchObject({ width: 1, height: 1 });
    expect(validatePortrait(png({ width: 2048, height: 2048 }))).toMatchObject({
      width: 2048,
      height: 2048,
    });
    expectCode(() => validatePortrait(png({ width: 4097, height: 64 })), "AVATAR_PORTRAIT_INVALID");
  });
});

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrow(PngImageValidationError);
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

export function validSkinBytes(): Buffer {
  const pixels = Buffer.alloc(64 * 64 * 4, 0xff);
  for (let y = 8; y < 16; y += 1) {
    for (let x = 40; x < 48; x += 1) pixels[(y * 64 + x) * 4 + 3] = 0;
  }
  return png({ width: 64, height: 64, pixels });
}

function skinWithTransparentBaseUv(): Buffer {
  const pixels = Buffer.alloc(64 * 64 * 4, 0xff);
  pixels[(8 * 64 + 8) * 4 + 3] = 0;
  return png({ width: 64, height: 64, pixels });
}

export function png(input: {
  readonly width: number;
  readonly height: number;
  readonly colorType?: number;
  readonly pixels?: Buffer;
  readonly raw?: Buffer;
}): Buffer {
  const colorType = input.colorType ?? 6;
  const channels = colorType === 6 ? 4 : 3;
  const pixels = input.pixels ?? Buffer.alloc(input.width * input.height * channels, 0xff);
  const raw = input.raw ?? withNoFilters(pixels, input.width, input.height, channels);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(input.width, 0);
  ihdr.writeUInt32BE(input.height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function withNoFilters(pixels: Buffer, width: number, height: number, channels: number): Buffer {
  const rowBytes = width * channels;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    pixels.copy(raw, row * (rowBytes + 1) + 1, row * rowBytes, (row + 1) * rowBytes);
  }
  return raw;
}

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
