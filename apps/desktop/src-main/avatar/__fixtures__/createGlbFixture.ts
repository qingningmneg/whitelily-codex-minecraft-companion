type FixtureFormat = "glb" | "vrm0" | "vrm1";

export interface GlbFixtureOptions {
  readonly format?: FixtureFormat;
  readonly vrmSpecVersion?: string;
  readonly magic?: string;
  readonly imageUri?: string;
  readonly bufferUri?: string;
  readonly omitBone?: string;
  readonly duplicateBone?: { readonly semantic: string; readonly target: string };
  readonly duplicateNodeNames?: boolean;
  readonly invalidAccessorBounds?: boolean;
  readonly invalidMaterialIndex?: boolean;
  readonly breakHierarchy?: boolean;
  readonly collapseSides?: boolean;
  readonly nodeCount?: number;
  readonly includeExpressions?: boolean;
}

const boneOrder = [
  "hips",
  "chest",
  "neck",
  "head",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
] as const;

const nodeNames: Record<(typeof boneOrder)[number], string> = {
  hips: "Hips",
  chest: "Chest",
  neck: "Neck",
  head: "Head",
  leftUpperArm: "LeftUpperArm",
  leftLowerArm: "LeftLowerArm",
  leftHand: "LeftHand",
  rightUpperArm: "RightUpperArm",
  rightLowerArm: "RightLowerArm",
  rightHand: "RightHand",
  leftUpperLeg: "LeftUpperLeg",
  leftLowerLeg: "LeftLowerLeg",
  leftFoot: "LeftFoot",
  rightUpperLeg: "RightUpperLeg",
  rightLowerLeg: "RightLowerLeg",
  rightFoot: "RightFoot",
};

export function createGlbFixture(options: GlbFixtureOptions = {}): Buffer {
  const format = options.format ?? "glb";
  const includeExpressions = options.includeExpressions ?? format !== "glb";
  const nodes = createHumanoidNodes(options);
  while (nodes.length < (options.nodeCount ?? nodes.length)) {
    nodes.push({ name: `Extra${nodes.length}`, translation: [0, 0, 0] });
  }

  const binary = Buffer.alloc(1_068);
  const document: Record<string, unknown> = {
    asset: { version: "2.0", generator: "WhiteLily test fixture" },
    buffers: [
      {
        byteLength: binary.length,
        ...(options.bufferUri === undefined ? {} : { uri: options.bufferUri }),
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
      { buffer: 0, byteOffset: 44, byteLength: 1_024 },
      { buffer: 0, byteOffset: 0, byteLength: 4 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: options.invalidAccessorBounds ? 10_000 : 3,
        type: "VEC3",
      },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
      { bufferView: 2, componentType: 5126, count: 16, type: "MAT4" },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0 },
            indices: 1,
            material: options.invalidMaterialIndex ? 99 : 0,
            ...(includeExpressions ? { targets: [{ POSITION: 0 }] } : {}),
          },
        ],
      },
    ],
    nodes,
    skins: [
      { joints: boneOrder.map((_bone, index) => index), inverseBindMatrices: 2, skeleton: 0 },
    ],
    scenes: [{ nodes: [16] }],
    scene: 0,
    ...(options.imageUri === undefined
      ? { images: [{ bufferView: 3, mimeType: "image/png" }] }
      : { images: [{ uri: options.imageUri, mimeType: "image/png" }] }),
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  };

  if (format === "vrm1") {
    Object.assign(document, {
      extensionsUsed: ["VRMC_vrm"],
      extensions: {
        VRMC_vrm: {
          specVersion: options.vrmSpecVersion ?? "1.0",
          humanoid: { humanBones: createVrm1HumanBones(options) },
          ...(includeExpressions
            ? { expressions: { preset: { happy: { morphTargetBinds: [] } } } }
            : {}),
        },
      },
    });
  } else if (format === "vrm0") {
    Object.assign(document, {
      extensionsUsed: ["VRM"],
      extensions: {
        VRM: {
          specVersion: options.vrmSpecVersion ?? "0.0",
          humanoid: { humanBones: createVrm0HumanBones(options) },
          ...(includeExpressions
            ? { blendShapeMaster: { blendShapeGroups: [{ name: "happy", binds: [] }] } }
            : {}),
        },
      },
    });
  }

  const jsonBytes = padChunk(Buffer.from(JSON.stringify(document), "utf8"), 0x20);
  const binaryBytes = padChunk(binary, 0x00);
  const output = Buffer.alloc(12 + 8 + jsonBytes.length + 8 + binaryBytes.length);
  output.write(options.magic ?? "glTF", 0, 4, "ascii");
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonBytes.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(output, 20);
  const binaryHeader = 20 + jsonBytes.length;
  output.writeUInt32LE(binaryBytes.length, binaryHeader);
  output.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binaryBytes.copy(output, binaryHeader + 8);
  return output;
}

function createHumanoidNodes(options: GlbFixtureOptions): Array<Record<string, unknown>> {
  const leftX = options.collapseSides ? 0 : 0.3;
  const rightX = options.collapseSides ? 0 : -0.3;
  const nodes: Array<Record<string, unknown>> = [
    { name: "Hips", translation: [0, 1, 0], children: [1, 10, 13] },
    { name: "Chest", translation: [0, 0.5, 0], children: [2, 4, 7] },
    { name: "Neck", translation: [0, 0.35, 0], children: options.breakHierarchy ? [] : [3] },
    { name: "Head", translation: [0, 0.25, 0] },
    { name: "LeftUpperArm", translation: [leftX, 0.25, 0], children: [5] },
    { name: "LeftLowerArm", translation: [0.35, 0, 0], children: [6] },
    { name: "LeftHand", translation: [0.3, 0, 0] },
    { name: "RightUpperArm", translation: [rightX, 0.25, 0], children: [8] },
    { name: "RightLowerArm", translation: [-0.35, 0, 0], children: [9] },
    { name: "RightHand", translation: [-0.3, 0, 0] },
    { name: "LeftUpperLeg", translation: [leftX / 2, -0.4, 0], children: [11] },
    { name: "LeftLowerLeg", translation: [0, -0.5, 0], children: [12] },
    { name: "LeftFoot", translation: [0, -0.4, 0.1] },
    { name: "RightUpperLeg", translation: [rightX / 2, -0.4, 0], children: [14] },
    { name: "RightLowerLeg", translation: [0, -0.5, 0], children: [15] },
    { name: "RightFoot", translation: [0, -0.4, 0.1] },
    { name: "BodyMesh", mesh: 0, skin: 0 },
  ];
  if (options.breakHierarchy) nodes[0] = { ...nodes[0], children: [1, 3, 10, 13] };
  if (options.duplicateNodeNames) nodes[9] = { ...nodes[9], name: "LeftHand" };
  if (options.omitBone !== undefined) {
    const index = boneOrder.indexOf(options.omitBone as (typeof boneOrder)[number]);
    if (index >= 0) nodes[index] = { ...nodes[index], name: `Missing${options.omitBone}` };
  }
  return nodes;
}

function createVrm1HumanBones(options: GlbFixtureOptions): Record<string, { node: number }> {
  const result = Object.fromEntries(boneOrder.map((bone, node) => [bone, { node }]));
  if (options.omitBone !== undefined) delete result[options.omitBone];
  if (options.duplicateBone !== undefined) {
    result[options.duplicateBone.semantic] = result[options.duplicateBone.target] ?? { node: 0 };
  }
  return result;
}

function createVrm0HumanBones(options: GlbFixtureOptions): Array<{ bone: string; node: number }> {
  const result = boneOrder
    .filter((bone) => bone !== options.omitBone)
    .map((bone, node) => ({ bone, node: boneOrder.indexOf(bone) }));
  const duplicateBone = options.duplicateBone;
  if (duplicateBone !== undefined) {
    const duplicate = result.find(({ bone }) => bone === duplicateBone.semantic);
    const target = result.find(({ bone }) => bone === duplicateBone.target);
    if (duplicate !== undefined && target !== undefined) duplicate.node = target.node;
  }
  return result;
}

function padChunk(bytes: Buffer, padding: number): Buffer {
  const length = Math.ceil(bytes.length / 4) * 4;
  const padded = Buffer.alloc(length, padding);
  bytes.copy(padded);
  return padded;
}
