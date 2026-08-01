import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { format } from "prettier";
import { renderSkinFrontPreview } from "./skin-front-preview.mjs";

export { renderSkinFrontPreview } from "./skin-front-preview.mjs";

export const THEMES = ["base", "leather", "iron", "gold", "diamond", "netherite"];
export const VIEWS = ["front", "back", "left", "right", "top", "bottom"];
export const BONES = [
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

export const BASE_PALETTE = ["#F7F6F2", "#E9F1EA", "#CDE2C8", "#D4C7A3", "#A67C52"];

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TEXTURE_SIZE = 128;
const SKIN_SIZE = 64;
const PATCH_SIZE = 8;
const PREVIEW_SIZE = 256;
const TRANSPARENT = [0, 0, 0, 0];
const SKIN = [246, 211, 190, 255];
const EYES = [98, 132, 82, 255];

const THEME_COLORS = {
  base: {
    primary: "#CDE2C8",
    secondary: "#E9F1EA",
    highlight: "#F7F6F2",
    shadow: "#D4C7A3",
  },
  leather: {
    primary: "#A67C52",
    secondary: "#80552F",
    highlight: "#C89B68",
    shadow: "#54351F",
  },
  iron: {
    primary: "#B9BEC2",
    secondary: "#8A9198",
    highlight: "#E6E8E9",
    shadow: "#626970",
  },
  gold: {
    primary: "#E6B83F",
    secondary: "#BE8421",
    highlight: "#FFE48B",
    shadow: "#875916",
  },
  diamond: {
    primary: "#43C9C3",
    secondary: "#178F91",
    highlight: "#A5F3EB",
    shadow: "#11656B",
  },
  netherite: {
    primary: "#55485E",
    secondary: "#362F3C",
    highlight: "#9A7CAA",
    shadow: "#211E27",
  },
};

const BONE_PARENT = {
  head: "body",
  hair_front: "head",
  hair_back: "head",
  hair_left: "head",
  hair_right: "head",
  lily: "head",
  ribbon: "hair_back",
  left_arm: "body",
  right_arm: "body",
  left_sleeve: "left_arm",
  right_sleeve: "right_arm",
  skirt_front: "body",
  skirt_back: "body",
  skirt_left: "body",
  skirt_right: "body",
  left_leg: "body",
  right_leg: "body",
  held_item: "right_arm",
};

function cube(origin, size, uvIndex, inflate = 0) {
  return {
    origin,
    size,
    inflate,
    uv: faceUv(uvIndex),
  };
}

function cubeWithFaceUv(origin, size, uvIndex, faceOverrides) {
  const modelCube = cube(origin, size, uvIndex);
  for (const [face, overrideIndex] of Object.entries(faceOverrides)) {
    modelCube.uv[face] = faceUv(overrideIndex)[face];
  }
  return modelCube;
}

function faceUv(index) {
  const x = (index % 8) * PATCH_SIZE;
  const y = Math.floor(index / 8) * PATCH_SIZE;
  return Object.fromEntries(
    ["north", "east", "south", "west", "up", "down"].map((face) => [
      face,
      { uv: [x, y], uv_size: [PATCH_SIZE, PATCH_SIZE] },
    ]),
  );
}

function modelBones() {
  const cubes = {
    head: [
      cubeWithFaceUv([-4, 24, -4], [8, 8, 8], 0, {
        east: 1,
        south: 1,
        west: 1,
        up: 1,
      }),
    ],
    hair_front: [
      cube([-4.25, 29.5, -4.45], [8.5, 2.75, 1], 1),
      cube([-4.2, 25.8, -4.45], [2.4, 4, 1], 1),
      cube([1.8, 25.8, -4.45], [2.4, 4, 1], 1),
      cube([-4.15, 14.2, -4.5], [1.45, 13.2, 1], 1),
      cube([2.7, 14.2, -4.5], [1.45, 13.2, 1], 1),
    ],
    hair_back: [cube([-4.45, 13, 3.7], [8.9, 19.2, 1], 2)],
    hair_left: [cube([-4.55, 14.5, -3.8], [1, 16.5, 7.6], 3)],
    hair_right: [cube([3.55, 14.5, -3.8], [1, 16.5, 7.6], 4)],
    lily: [
      cube([3.7, 27.25, -4.65], [1.25, 3.75, 0.7], 5),
      cube([2.45, 28.5, -4.65], [3.75, 1.25, 0.7], 5),
      cube([3.1, 27.9, -4.8], [2.4, 2.4, 0.85], 5),
    ],
    ribbon: [
      cube([-2.4, 15.7, 4.55], [2.3, 3, 0.65], 6),
      cube([0.1, 15.7, 4.55], [2.3, 3, 0.65], 6),
      cube([-0.7, 16.7, 4.4], [1.4, 1.4, 0.9], 6),
    ],
    body: [cube([-4, 12, -2], [8, 12, 4], 7)],
    left_arm: [cube([4, 12, -2], [4, 12, 4], 8)],
    right_arm: [cube([-8, 12, -2], [4, 12, 4], 9)],
    left_sleeve: [cube([3.6, 12.8, -2.4], [4.8, 9.7, 4.8], 10)],
    right_sleeve: [cube([-8.4, 12.8, -2.4], [4.8, 9.7, 4.8], 11)],
    skirt_front: [cube([-4.8, 0.2, -2.8], [9.6, 12.3, 1.2], 12)],
    skirt_back: [cube([-4.8, 0.2, 1.6], [9.6, 12.3, 1.2], 13)],
    skirt_left: [cube([3.6, 0.2, -1.6], [1.2, 12.3, 3.2], 14)],
    skirt_right: [cube([-4.8, 0.2, -1.6], [1.2, 12.3, 3.2], 15)],
    left_leg: [cube([0, 0, -2], [4, 12, 4], 16)],
    right_leg: [cube([-4, 0, -2], [4, 12, 4], 17)],
    held_item: [],
  };
  const pivots = {
    head: [0, 24, 0],
    hair_front: [0, 24, 0],
    hair_back: [0, 24, 0],
    hair_left: [0, 24, 0],
    hair_right: [0, 24, 0],
    lily: [0, 24, 0],
    ribbon: [0, 24, 0],
    body: [0, 12, 0],
    left_arm: [4, 22, 0],
    right_arm: [-4, 22, 0],
    left_sleeve: [4, 22, 0],
    right_sleeve: [-4, 22, 0],
    skirt_front: [0, 12, 0],
    skirt_back: [0, 12, 0],
    skirt_left: [0, 12, 0],
    skirt_right: [0, 12, 0],
    left_leg: [2, 12, 0],
    right_leg: [-2, 12, 0],
    held_item: [-6, 13, -1],
  };
  return BONES.map((name) => ({
    name,
    ...(BONE_PARENT[name] ? { parent: BONE_PARENT[name] } : {}),
    pivot: pivots[name],
    cubes: cubes[name],
  }));
}

function hexColor(value) {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
    255,
  ];
}

function image(width, height, fill = TRANSPARENT) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels.set(fill, offset);
  }
  return { width, height, pixels };
}

function setPixel(target, x, y, color) {
  if (x < 0 || x >= target.width || y < 0 || y >= target.height) return;
  const offset = (y * target.width + x) * 4;
  target.pixels.set(color, offset);
}

function getPixel(target, x, y) {
  const offset = (y * target.width + x) * 4;
  return [...target.pixels.subarray(offset, offset + 4)];
}

function fillRect(target, x, y, width, height, color) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) setPixel(target, px, py, color);
  }
}

function patternRect(target, x, y, width, height, colors, seed = 0) {
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const edge = px === 0 || py === 0 || px === width - 1 || py === height - 1;
      const index = edge ? 3 : (px * 3 + py * 5 + seed) % 3;
      setPixel(target, x + px, y + py, colors[index]);
    }
  }
}

function patchOrigin(index) {
  return [(index % 8) * PATCH_SIZE, Math.floor(index / 8) * PATCH_SIZE];
}

function makeEntityTexture(theme) {
  const target = image(TEXTURE_SIZE, TEXTURE_SIZE);
  const material = THEME_COLORS[theme];
  const base = BASE_PALETTE.map(hexColor);
  const armor = [
    hexColor(material.primary),
    hexColor(material.secondary),
    hexColor(material.highlight),
    hexColor(material.shadow),
  ];
  const hair = [base[0], base[1], [225, 224, 222, 255], [191, 190, 190, 255]];
  const botanical = [base[2], base[1], base[0], base[3]];
  const goldTrim = [base[3], base[4], [239, 219, 155, 255], [121, 89, 53, 255]];
  const armorBones = new Set([
    "body",
    "left_arm",
    "right_arm",
    "left_sleeve",
    "right_sleeve",
    "left_leg",
    "right_leg",
  ]);

  for (const [index, bone] of BONES.entries()) {
    const [x, y] = patchOrigin(index);
    let colors = botanical;
    if (bone === "head") colors = [SKIN, SKIN, [255, 230, 213, 255], [184, 141, 120, 255]];
    if (bone.startsWith("hair")) colors = hair;
    if (bone === "lily") colors = [base[0], base[1], goldTrim[2], goldTrim[1]];
    if (bone === "ribbon") colors = botanical;
    if (bone.startsWith("skirt")) colors = [base[0], base[1], base[2], base[3]];
    if (theme !== "base" && armorBones.has(bone)) colors = armor;
    patternRect(target, x, y, PATCH_SIZE, PATCH_SIZE, colors, index);
    if (bone === "body" || bone.startsWith("skirt")) {
      setPixel(target, x + 3, y + 2, goldTrim[1]);
      setPixel(target, x + 4, y + 2, goldTrim[2]);
      setPixel(target, x + 3, y + 5, goldTrim[2]);
      setPixel(target, x + 4, y + 5, goldTrim[1]);
    }
    if (bone === "lily") {
      fillRect(target, x + 3, y + 3, 2, 2, goldTrim[2]);
      setPixel(target, x + 3, y + 3, goldTrim[1]);
    }
    if (bone === "head") {
      fillRect(target, x + 1, y + 3, 2, 2, EYES);
      fillRect(target, x + 5, y + 3, 2, 2, EYES);
    }
  }
  return target;
}

function drawSkinFace(target, x, y, width, height, colors, seed = 0) {
  patternRect(target, x, y, width, height, colors, seed);
}

function makeSkin(theme) {
  const target = image(SKIN_SIZE, SKIN_SIZE);
  const material = THEME_COLORS[theme];
  const base = BASE_PALETTE.map(hexColor);
  const hair = [base[0], base[1], [224, 223, 221, 255], [186, 184, 184, 255]];
  const dress = [base[1], base[2], base[0], base[3]];
  const armor = [
    hexColor(material.primary),
    hexColor(material.secondary),
    hexColor(material.highlight),
    hexColor(material.shadow),
  ];
  const clothing = theme === "base" ? dress : armor;

  const headFaces = [
    [8, 0, 8, 8],
    [16, 0, 8, 8],
    [0, 8, 8, 8],
    [8, 8, 8, 8],
    [16, 8, 8, 8],
    [24, 8, 8, 8],
  ];
  for (const [index, face] of headFaces.entries()) {
    drawSkinFace(target, ...face, index === 3 ? [SKIN, SKIN, SKIN, SKIN] : hair, index);
  }
  fillRect(target, 9, 11, 2, 2, EYES);
  fillRect(target, 13, 11, 2, 2, EYES);
  fillRect(target, 11, 14, 2, 1, [225, 164, 159, 255]);

  const bodyFaces = [
    [20, 16, 8, 4],
    [28, 16, 8, 4],
    [16, 20, 4, 12],
    [20, 20, 8, 12],
    [28, 20, 4, 12],
    [32, 20, 8, 12],
  ];
  const limbFaces = [
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
  for (const [index, face] of bodyFaces.entries()) drawSkinFace(target, ...face, clothing, index);
  for (const [index, face] of limbFaces.entries()) drawSkinFace(target, ...face, clothing, index);

  const overlays = [
    [20, 36, 8, 12, dress],
    [4, 36, 4, 12, dress],
    [4, 52, 4, 12, dress],
    [44, 36, 4, 12, clothing],
    [52, 52, 4, 12, clothing],
  ];
  for (const [index, [x, y, width, height, colors]] of overlays.entries()) {
    drawSkinFace(target, x, y, width, height, colors, index + 7);
  }
  drawSkinFace(target, 40, 8, 8, 2, hair, 7);
  drawSkinFace(target, 40, 10, 1, 4, hair, 8);
  drawSkinFace(target, 47, 10, 1, 4, hair, 9);
  fillRect(target, 45, 9, 2, 2, base[0]);
  setPixel(target, 46, 9, base[4]);
  fillRect(target, 23, 38, 2, 2, base[0]);
  setPixel(target, 24, 39, base[4]);
  return target;
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

function pngChunk(type, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
}

function encodePng(target) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(target.width, 0);
  ihdr.writeUInt32BE(target.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc(target.height * (target.width * 4 + 1));
  for (let y = 0; y < target.height; y += 1) {
    const row = y * (target.width * 4 + 1);
    scanlines[row] = 0;
    target.pixels.copy(scanlines, row + 1, y * target.width * 4, (y + 1) * target.width * 4);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND"),
  ]);
}

function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Invalid PNG signature");
  let offset = 8;
  let width;
  let height;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error("Expected non-interlaced RGBA PNG");
      }
    }
    if (type === "IDAT") idat.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const target = image(width, height);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y += 1) {
    const row = y * (rowBytes + 1);
    if (raw[row] !== 0) throw new Error("Expected filter-zero generated PNG");
    raw.copy(target.pixels, y * rowBytes, row + 1, row + 1 + rowBytes);
  }
  return target;
}

async function stableJson(value) {
  return format(JSON.stringify(value), { parser: "json" });
}

function geometryJson() {
  return {
    format_version: "1.12.0",
    "minecraft:geometry": [
      {
        description: {
          identifier: "geometry.whitelily",
          texture_width: TEXTURE_SIZE,
          texture_height: TEXTURE_SIZE,
          visible_bounds_width: 3,
          visible_bounds_height: 3.5,
          visible_bounds_offset: [0, 1.65, 0],
        },
        bones: modelBones(),
      },
    ],
  };
}

function uuid(index, kind = 0) {
  return `00000000-0000-4000-8${kind.toString(16).padStart(3, "0")}-${index
    .toString(16)
    .padStart(12, "0")}`;
}

function blockbenchJson() {
  const bones = modelBones();
  const elements = [];
  const groups = new Map();
  let elementIndex = 1;
  for (const [boneIndex, bone] of bones.entries()) {
    const children = [];
    for (const modelCube of bone.cubes) {
      const id = uuid(elementIndex);
      elementIndex += 1;
      children.push(id);
      elements.push({
        name: `${bone.name}_${children.length}`,
        box_uv: false,
        rescale: false,
        locked: false,
        from: modelCube.origin,
        to: modelCube.origin.map((value, axis) => value + modelCube.size[axis]),
        autouv: 0,
        color: boneIndex % 8,
        origin: bone.pivot,
        faces: Object.fromEntries(
          Object.entries(modelCube.uv).map(([face, uv]) => [
            face,
            {
              uv: [uv.uv[0], uv.uv[1], uv.uv[0] + uv.uv_size[0], uv.uv[1] + uv.uv_size[1]],
              texture: 0,
            },
          ]),
        ),
        type: "cube",
        uuid: id,
      });
    }
    groups.set(bone.name, {
      name: bone.name,
      origin: bone.pivot,
      rotation: bone.rotation ?? [0, 0, 0],
      color: boneIndex % 8,
      uuid: uuid(boneIndex + 1, 1),
      export: true,
      isOpen: true,
      autouv: 0,
      children,
    });
  }
  const outliner = [];
  for (const bone of bones) {
    const group = groups.get(bone.name);
    if (bone.parent) {
      groups.get(bone.parent).children.push(group);
    } else {
      outliner.push(group);
    }
  }
  return {
    meta: {
      format_version: "4.10",
      model_format: "geckolib_model",
      box_uv: false,
    },
    name: "whitelily",
    model_identifier: "whitelily",
    visible_box: [3, 3.5, 0],
    variable_placeholders: "",
    resolution: { width: TEXTURE_SIZE, height: TEXTURE_SIZE },
    elements,
    outliner,
    textures: [
      {
        relative_path:
          "../../mod-fabric/src/main/resources/assets/whitelily_avatar/textures/entity/base.png",
        name: "base.png",
        folder: "entity",
        namespace: "whitelily_avatar",
        id: "0",
        particle: false,
        render_mode: "default",
        visible: true,
        mode: "bitmap",
        saved: true,
        uuid: uuid(1, 2),
        source: "",
      },
    ],
  };
}

function shade(color, factor) {
  return [
    Math.min(255, Math.round(color[0] * factor)),
    Math.min(255, Math.round(color[1] * factor)),
    Math.min(255, Math.round(color[2] * factor)),
    color[3],
  ];
}

function blendPixel(target, x, y, color) {
  if (color[3] === 0 || x < 0 || x >= target.width || y < 0 || y >= target.height) return;
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

const CAMERAS = {
  front: { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1] },
  back: { right: [-1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] },
  left: { right: [0, 0, 1], up: [0, 1, 0], forward: [1, 0, 0] },
  right: { right: [0, 0, -1], up: [0, 1, 0], forward: [-1, 0, 0] },
  top: { right: [1, 0, 0], up: [0, 0, -1], forward: [0, -1, 0] },
  bottom: { right: [1, 0, 0], up: [0, 0, 1], forward: [0, 1, 0] },
};

const FACE_VERTICES = {
  north: [0, 3, 2, 1],
  south: [4, 5, 6, 7],
  west: [0, 4, 7, 3],
  east: [1, 2, 6, 5],
  up: [3, 7, 6, 2],
  down: [0, 1, 5, 4],
};

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function rotateAround(point, pivot, rotation = [0, 0, 0]) {
  let [x, y, z] = subtract(point, pivot);
  const [rx, ry, rz] = rotation.map((degrees) => (degrees * Math.PI) / 180);
  if (rx) [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  if (ry) [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  if (rz) [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  return [x + pivot[0], y + pivot[1], z + pivot[2]];
}

function cubeVertices(modelCube) {
  const inflate = modelCube.inflate ?? 0;
  const min = modelCube.origin.map((value) => value - inflate);
  const max = modelCube.origin.map((value, axis) => value + modelCube.size[axis] + inflate);
  return [
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [max[0], max[1], min[2]],
    [min[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], min[1], max[2]],
    [max[0], max[1], max[2]],
    [min[0], max[1], max[2]],
  ];
}

function transformedFaces(geometry) {
  const bones = geometry["minecraft:geometry"][0].bones;
  const boneByName = new Map(bones.map((bone) => [bone.name, bone]));
  const transformBonePoint = (point, bone) => {
    let transformed = rotateAround(point, bone.pivot ?? [0, 0, 0], bone.rotation);
    let parent = bone.parent ? boneByName.get(bone.parent) : undefined;
    while (parent) {
      transformed = rotateAround(transformed, parent.pivot ?? [0, 0, 0], parent.rotation);
      parent = parent.parent ? boneByName.get(parent.parent) : undefined;
    }
    return transformed;
  };
  const faces = [];
  for (const bone of bones) {
    for (const modelCube of bone.cubes ?? []) {
      const cubePivot = modelCube.pivot ?? bone.pivot ?? [0, 0, 0];
      const vertices = cubeVertices(modelCube).map((point) =>
        transformBonePoint(rotateAround(point, cubePivot, modelCube.rotation), bone),
      );
      for (const [faceName, indices] of Object.entries(FACE_VERTICES)) {
        const uv = modelCube.uv?.[faceName];
        if (!uv) continue;
        const [u, v] = uv.uv;
        const [width, height] = uv.uv_size;
        const faceKey = JSON.stringify([
          bone.name,
          modelCube.origin,
          modelCube.size,
          modelCube.pivot ?? null,
          modelCube.rotation ?? null,
          modelCube.inflate ?? 0,
          faceName,
          uv.uv,
          uv.uv_size,
        ]);
        faces.push({
          faceKey,
          vertices: indices.map((index) => vertices[index]),
          uvs: [
            [u, v + height],
            [u, v],
            [u + width, v],
            [u + width, v + height],
          ],
          uvBounds: [
            Math.min(u, u + width),
            Math.max(u, u + width),
            Math.min(v, v + height),
            Math.max(v, v + height),
          ],
        });
      }
    }
  }
  return faces;
}

function edge(a, b, point) {
  return (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
}

function rasterizeTriangle(
  target,
  fragments,
  texture,
  vertices,
  uvs,
  uvBounds,
  surfaceKey,
  triangleKey,
) {
  const area = edge(vertices[1], vertices[2], vertices[0]);
  if (Math.abs(area) < 1e-9) return;
  const minX = Math.max(0, Math.floor(Math.min(...vertices.map((vertex) => vertex[0]))));
  const maxX = Math.min(
    target.width - 1,
    Math.ceil(Math.max(...vertices.map((vertex) => vertex[0]))),
  );
  const minY = Math.max(0, Math.floor(Math.min(...vertices.map((vertex) => vertex[1]))));
  const maxY = Math.min(
    target.height - 1,
    Math.ceil(Math.max(...vertices.map((vertex) => vertex[1]))),
  );
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const point = [x + 0.5, y + 0.5];
      const weights = [
        edge(vertices[1], vertices[2], point) / area,
        edge(vertices[2], vertices[0], point) / area,
        edge(vertices[0], vertices[1], point) / area,
      ];
      if (weights.some((weight) => weight < -1e-9)) continue;
      const depth = weights.reduce((sum, weight, index) => sum + weight * vertices[index][2], 0);
      const pixelIndex = y * target.width + x;
      const interpolated = [0, 1].map((axis) =>
        weights.reduce((sum, weight, index) => sum + weight * uvs[index][axis], 0),
      );
      const tx = Math.max(
        0,
        Math.min(texture.width - 1, Math.floor(Math.min(uvBounds[1] - 1e-7, interpolated[0]))),
      );
      const ty = Math.max(
        0,
        Math.min(texture.height - 1, Math.floor(Math.min(uvBounds[3] - 1e-7, interpolated[1]))),
      );
      const color = getPixel(texture, tx, ty);
      if (color[3] === 0) continue;
      fragments[pixelIndex] ??= new Map();
      const existing = fragments[pixelIndex].get(surfaceKey);
      if (
        !existing ||
        depth < existing.depth ||
        (depth === existing.depth && triangleKey < existing.key)
      ) {
        fragments[pixelIndex].set(surfaceKey, {
          depth,
          color,
          key: triangleKey,
        });
      }
    }
  }
}

export function renderOrthographicView(
  geometry,
  texture,
  viewName,
  { size = PREVIEW_SIZE, background = [238, 240, 238, 255] } = {},
) {
  const camera = CAMERAS[viewName];
  if (!camera) throw new Error(`Unsupported preview view: ${viewName}`);
  const faces = transformedFaces(geometry);
  const visibleFaces = faces.filter((face) => {
    const normal = cross(
      subtract(face.vertices[1], face.vertices[0]),
      subtract(face.vertices[2], face.vertices[0]),
    );
    return dot(normal, camera.forward) < -1e-9;
  });
  const projectedFaces = visibleFaces.map((face) => ({
    ...face,
    projected: face.vertices.map((point) => [
      dot(point, camera.right),
      dot(point, camera.up),
      dot(point, camera.forward),
    ]),
  }));
  const projectedPoints = projectedFaces.flatMap((face) => face.projected);
  const target = image(size, size, background);
  if (projectedPoints.length === 0) return target;
  const horizontal = projectedPoints.map((point) => point[0]);
  const vertical = projectedPoints.map((point) => point[1]);
  const horizontalSpan = Math.max(...horizontal) - Math.min(...horizontal);
  const verticalSpan = Math.max(...vertical) - Math.min(...vertical);
  const scale = (size * 0.82) / Math.max(horizontalSpan, verticalSpan, 1);
  const horizontalCenter = (Math.max(...horizontal) + Math.min(...horizontal)) / 2;
  const verticalCenter = (Math.max(...vertical) + Math.min(...vertical)) / 2;
  const fragments = new Array(size * size);
  for (const face of projectedFaces) {
    const screen = face.projected.map((point) => [
      size / 2 + (point[0] - horizontalCenter) * scale,
      size / 2 - (point[1] - verticalCenter) * scale,
      point[2],
    ]);
    rasterizeTriangle(
      target,
      fragments,
      texture,
      [screen[0], screen[1], screen[2]],
      [face.uvs[0], face.uvs[1], face.uvs[2]],
      face.uvBounds,
      face.faceKey,
      `${face.faceKey}|0`,
    );
    rasterizeTriangle(
      target,
      fragments,
      texture,
      [screen[0], screen[2], screen[3]],
      [face.uvs[0], face.uvs[2], face.uvs[3]],
      face.uvBounds,
      face.faceKey,
      `${face.faceKey}|1`,
    );
  }
  for (const [pixelIndex, pixelFragments] of fragments.entries()) {
    if (!pixelFragments) continue;
    const x = pixelIndex % size;
    const y = Math.floor(pixelIndex / size);
    const ordered = [...pixelFragments.values()].sort(
      (left, right) =>
        right.depth - left.depth || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
    );
    for (const fragment of ordered) blendPixel(target, x, y, fragment.color);
  }
  return target;
}

async function writeBytes(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
}

export async function renderAvatarPreviews(
  subprojectRoot,
  { themes = THEMES.map((name) => ({ name, textureTheme: name })), views = VIEWS } = {},
) {
  const resources = path.join(subprojectRoot, "mod-fabric", "src", "main", "resources");
  const geometryPath = path.join(
    resources,
    "assets",
    "whitelily_avatar",
    "geckolib",
    "models",
    "whitelily.geo.json",
  );
  const geometry = JSON.parse(await readFile(geometryPath, "utf8"));
  for (const theme of themes) {
    const texturePath = path.join(
      resources,
      "assets",
      "whitelily_avatar",
      "textures",
      "entity",
      `${theme.textureTheme}.png`,
    );
    const texture = decodePng(await readFile(texturePath));
    for (const view of views) {
      const preview = renderOrthographicView(geometry, texture, view);
      await writeBytes(
        path.join(subprojectRoot, "assets", "previews", `${theme.name}-${view}.png`),
        encodePng(preview),
      );
    }
  }
}

export async function renderSkinFrontPreviews(subprojectRoot, { themes = THEMES } = {}) {
  const skinRoot = path.join(
    subprojectRoot,
    "mod-fabric",
    "src",
    "main",
    "resources",
    "assets",
    "whitelily_avatar",
    "textures",
    "skin",
  );
  for (const theme of themes) {
    const skin = decodePng(await readFile(path.join(skinRoot, `${theme}.png`)));
    await writeBytes(
      path.join(subprojectRoot, "assets", "previews", "skins", `${theme}-front.png`),
      encodePng(renderSkinFrontPreview(skin)),
    );
  }
}

export async function buildAvatarAssets(subprojectRoot) {
  const resources = path.join(subprojectRoot, "mod-fabric", "src", "main", "resources");
  const runtime = path.join(resources, "assets", "whitelily_avatar");
  await writeBytes(
    path.join(subprojectRoot, "assets", "blockbench", "whitelily.bbmodel"),
    Buffer.from(await stableJson(blockbenchJson())),
  );
  await writeBytes(
    path.join(runtime, "geckolib", "models", "whitelily.geo.json"),
    Buffer.from(await stableJson(geometryJson())),
  );
  for (const theme of THEMES) {
    await writeBytes(
      path.join(runtime, "textures", "entity", `${theme}.png`),
      encodePng(makeEntityTexture(theme)),
    );
    await writeBytes(
      path.join(runtime, "textures", "skin", `${theme}.png`),
      encodePng(makeSkin(theme)),
    );
  }
  await renderAvatarPreviews(subprojectRoot);
  await renderSkinFrontPreviews(subprojectRoot);
  return {
    themes: [...THEMES],
    views: [...VIEWS],
    boneCount: BONES.length,
    entityTextureSize: `${TEXTURE_SIZE}x${TEXTURE_SIZE}`,
    skinTextureSize: `${SKIN_SIZE}x${SKIN_SIZE}`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const subprojectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await buildAvatarAssets(subprojectRoot);
}
