const SKIN_FRONT_PARTS = [
  { base: [8, 8, 8, 8], overlay: [40, 8, 8, 8], destination: [4, 0] },
  { base: [20, 20, 8, 12], overlay: [20, 36, 8, 12], destination: [4, 8] },
  { base: [44, 20, 4, 12], overlay: [44, 36, 4, 12], destination: [0, 8] },
  { base: [36, 52, 4, 12], overlay: [52, 52, 4, 12], destination: [12, 8] },
  { base: [4, 20, 4, 12], overlay: [4, 36, 4, 12], destination: [4, 20] },
  { base: [20, 52, 4, 12], overlay: [4, 52, 4, 12], destination: [8, 20] },
];

function image(width, height, fill) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels.set(fill, offset);
  }
  return { width, height, pixels };
}

function getPixel(source, x, y) {
  const offset = (y * source.width + x) * 4;
  return source.pixels.subarray(offset, offset + 4);
}

function blendPixel(target, x, y, color) {
  if (color[3] === 0) return;
  const offset = (y * target.width + x) * 4;
  if (color[3] === 255) {
    target.pixels.set(color, offset);
    return;
  }
  const alpha = color[3] / 255;
  for (let channel = 0; channel < 3; channel += 1) {
    target.pixels[offset + channel] = Math.round(
      color[channel] * alpha + target.pixels[offset + channel] * (1 - alpha),
    );
  }
  target.pixels[offset + 3] = 255;
}

export function renderSkinFrontPreview(
  skin,
  { scale = 8, background = [238, 240, 238, 255] } = {},
) {
  if (!Number.isInteger(scale) || scale < 1 || scale > 16) {
    throw new Error("Skin preview scale must be an integer from 1 to 16");
  }
  const target = image(16 * scale, 32 * scale, background);
  for (const { base, overlay, destination } of SKIN_FRONT_PARTS) {
    const [baseX, baseY, width, height] = base;
    const [overlayX, overlayY] = overlay;
    const [destinationX, destinationY] = destination;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const colors = [
          getPixel(skin, baseX + x, baseY + y),
          getPixel(skin, overlayX + x, overlayY + y),
        ];
        for (let scaledY = 0; scaledY < scale; scaledY += 1) {
          for (let scaledX = 0; scaledX < scale; scaledX += 1) {
            const outputX = (destinationX + x) * scale + scaledX;
            const outputY = (destinationY + y) * scale + scaledY;
            for (const color of colors) blendPixel(target, outputX, outputY, color);
          }
        }
      }
    }
  }
  return target;
}
