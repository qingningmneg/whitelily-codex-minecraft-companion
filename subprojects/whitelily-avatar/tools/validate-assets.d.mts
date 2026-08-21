export interface ValidatedRgbaPng {
  readonly width: number;
  readonly height: number;
  readonly pixels: Buffer;
}

export function validateRgbaPng(
  bytes: Buffer,
  options: {
    readonly errorMessage: string;
    readonly expectedWidth?: number;
    readonly expectedHeight?: number;
    readonly maxDimension?: number;
    readonly maximumBytes?: number;
    readonly maximumCompressedBytes?: number;
    readonly decodePixels?: true;
  },
): ValidatedRgbaPng;

export function validateRgbaPng(
  bytes: Buffer,
  options: {
    readonly errorMessage: string;
    readonly expectedWidth?: number;
    readonly expectedHeight?: number;
    readonly maxDimension?: number;
    readonly maximumBytes?: number;
    readonly maximumCompressedBytes?: number;
    readonly decodePixels: false;
    readonly allowRgb?: boolean;
  },
): { readonly width: number; readonly height: number };

export function pngCrc32(bytes: Buffer): number;

export function renderSkinFrontPreview(
  skin: { readonly width: number; readonly height: number; readonly pixels: Buffer },
  options?: {
    readonly scale?: number;
    readonly background?: readonly [number, number, number, number];
  },
): { readonly width: number; readonly height: number; readonly pixels: Buffer };
