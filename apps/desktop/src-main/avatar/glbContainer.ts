export const MAX_AVATAR_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_JSON_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 4_096;
const MAX_JOINTS = 256;
const MAX_MATERIALS = 128;
const MAX_TEXTURES = 128;
const MAX_PRIMITIVES = 2_048;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BINARY_CHUNK_TYPE = 0x004e4942;

export type AvatarFileValidationErrorCode =
  "AVATAR_GLB_INVALID" | "AVATAR_EXTERNAL_RESOURCE" | "AVATAR_REQUIRED_BONE_MISSING";

export class AvatarFileValidationError extends Error {
  constructor(
    readonly code: AvatarFileValidationErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "AvatarFileValidationError";
  }
}

export interface GltfNode {
  readonly name?: string | undefined;
  readonly children?: readonly number[] | undefined;
  readonly translation?: readonly number[] | undefined;
  readonly matrix?: readonly number[] | undefined;
  readonly mesh?: number | undefined;
  readonly skin?: number | undefined;
  readonly [key: string]: unknown;
}

export interface GltfDocument {
  readonly asset: Readonly<Record<string, unknown>>;
  readonly buffers: readonly Readonly<Record<string, unknown>>[];
  readonly bufferViews: readonly Readonly<Record<string, unknown>>[];
  readonly accessors: readonly Readonly<Record<string, unknown>>[];
  readonly nodes: readonly GltfNode[];
  readonly meshes: readonly Readonly<Record<string, unknown>>[];
  readonly skins: readonly Readonly<Record<string, unknown>>[];
  readonly images: readonly Readonly<Record<string, unknown>>[];
  readonly textures: readonly Readonly<Record<string, unknown>>[];
  readonly materials: readonly Readonly<Record<string, unknown>>[];
  readonly animations: readonly Readonly<Record<string, unknown>>[];
  readonly extensions?: Readonly<Record<string, unknown>> | undefined;
  readonly [key: string]: unknown;
}

export interface ParsedGlbContainer {
  readonly json: GltfDocument;
  readonly binaryChunk: Uint8Array;
  readonly format: "vrm" | "glb";
  readonly vrmVersion?: "0.x" | "1.0" | undefined;
}

export function parseGlbContainer(bytes: Uint8Array): ParsedGlbContainer {
  try {
    return parseGlbContainerUnsafe(bytes);
  } catch (error) {
    if (error instanceof AvatarFileValidationError) throw error;
    throw new AvatarFileValidationError("AVATAR_GLB_INVALID", "avatar GLB is invalid", {
      cause: error,
    });
  }
}

function parseGlbContainerUnsafe(bytes: Uint8Array): ParsedGlbContainer {
  if (bytes.byteLength < 28 || bytes.byteLength > MAX_AVATAR_SOURCE_BYTES) {
    invalid("avatar GLB size is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) invalid("avatar GLB magic is invalid");
  if (view.getUint32(4, true) !== 2) invalid("avatar GLB version is invalid");
  if (view.getUint32(8, true) !== bytes.byteLength) invalid("avatar GLB length is invalid");

  let offset = 12;
  let jsonChunk: Uint8Array | undefined;
  let binaryChunk: Uint8Array | undefined;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) invalid("avatar GLB chunk header is truncated");
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    if (chunkLength % 4 !== 0 || chunkLength === 0 || offset + chunkLength > bytes.byteLength) {
      invalid("avatar GLB chunk is invalid");
    }
    const chunk = bytes.slice(offset, offset + chunkLength);
    offset += chunkLength;
    if (chunkType === JSON_CHUNK_TYPE) {
      if (jsonChunk !== undefined || binaryChunk !== undefined) {
        invalid("avatar GLB JSON chunk order is invalid");
      }
      if (chunkLength > MAX_JSON_CHUNK_BYTES) invalid("avatar GLB JSON chunk is too large");
      jsonChunk = chunk;
    } else if (chunkType === BINARY_CHUNK_TYPE) {
      if (jsonChunk === undefined || binaryChunk !== undefined) {
        invalid("avatar GLB binary chunk order is invalid");
      }
      binaryChunk = chunk;
    } else {
      invalid("avatar GLB contains an unsupported chunk");
    }
  }
  if (offset !== bytes.byteLength || jsonChunk === undefined || binaryChunk === undefined) {
    invalid("avatar GLB required chunks are missing");
  }

  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(jsonChunk).trimEnd();
  const rawDocument = JSON.parse(decoded) as unknown;
  if (!isPlainObject(rawDocument)) invalid("avatar glTF document is not an object");
  rejectExternalUris(rawDocument);
  const document = validateDocument(rawDocument, binaryChunk);
  const extensions = document.extensions;
  const vrm1 = isPlainObject(extensions?.VRMC_vrm) ? extensions.VRMC_vrm : undefined;
  const vrm0 = isPlainObject(extensions?.VRM) ? extensions.VRM : undefined;
  const hasVrm1 = vrm1 !== undefined;
  const hasVrm0 = vrm0 !== undefined;
  if (hasVrm1 && hasVrm0) invalid("avatar declares conflicting VRM versions");
  if (vrm1 !== undefined && vrm1.specVersion !== "1.0") {
    invalid("avatar VRM 1.0 version is invalid");
  }
  if (
    vrm0 !== undefined &&
    (typeof vrm0.specVersion !== "string" || !/^0\.[0-9]+(?:\.[0-9]+)?$/u.test(vrm0.specVersion))
  ) {
    invalid("avatar VRM 0.x version is invalid");
  }
  return Object.freeze({
    json: document,
    binaryChunk,
    format: hasVrm1 || hasVrm0 ? "vrm" : "glb",
    ...(hasVrm1 ? { vrmVersion: "1.0" as const } : {}),
    ...(hasVrm0 ? { vrmVersion: "0.x" as const } : {}),
  });
}

function validateDocument(
  document: Record<string, unknown>,
  binaryChunk: Uint8Array,
): GltfDocument {
  const asset = requireObject(document.asset, "asset");
  if (asset.version !== "2.0") invalid("avatar glTF asset version is invalid");
  const buffers = requireArray(document.buffers, "buffers", 1);
  if (buffers.length !== 1) invalid("avatar glTF must have one embedded buffer");
  const buffer = requireObject(buffers[0], "buffer");
  const bufferLength = requireSafeInteger(buffer.byteLength, "buffer byteLength", 1);
  if (bufferLength > binaryChunk.byteLength || binaryChunk.byteLength - bufferLength > 3) {
    invalid("avatar glTF buffer length is invalid");
  }

  const bufferViews = optionalArray(document.bufferViews, "bufferViews", 65_536);
  const validatedViews = bufferViews.map((value, index) =>
    validateBufferView(value, index, bufferLength),
  );
  const accessors = optionalArray(document.accessors, "accessors", 65_536);
  const validatedAccessors = accessors.map((value, index) =>
    validateAccessor(value, index, validatedViews),
  );
  const nodes = optionalArray(document.nodes, "nodes", MAX_NODES).map((value, index) =>
    validateNode(value, index),
  );
  validateNodeHierarchy(nodes);
  const images = optionalArray(document.images, "images", MAX_TEXTURES).map((value, index) =>
    validateImage(value, index, validatedViews.length),
  );
  const samplers = optionalArray(document.samplers, "samplers", MAX_TEXTURES);
  samplers.forEach((value, index) => validateSampler(value, index));
  const textures = optionalArray(document.textures, "textures", MAX_TEXTURES).map((value, index) =>
    validateTexture(value, index, images.length, samplers.length),
  );
  const materials = optionalArray(document.materials, "materials", MAX_MATERIALS).map(
    (value, index) => validateMaterial(value, index, textures.length),
  );
  const meshes = optionalArray(document.meshes, "meshes", MAX_NODES).map((value, index) =>
    validateMesh(value, index, validatedAccessors, materials.length),
  );
  const primitiveCount = meshes.reduce(
    (total, mesh) =>
      total + requireArray(mesh.primitives, "mesh primitives", MAX_PRIMITIVES).length,
    0,
  );
  if (primitiveCount > MAX_PRIMITIVES) invalid("avatar glTF has too many primitives");
  const skins = optionalArray(document.skins, "skins", MAX_NODES).map((value, index) =>
    validateSkin(value, index, nodes.length, validatedAccessors),
  );
  const uniqueJoints = new Set(
    skins.flatMap((skin) => requireArray(skin.joints, "skin joints", MAX_JOINTS) as number[]),
  );
  if (uniqueJoints.size > MAX_JOINTS) invalid("avatar glTF has too many joints");
  nodes.forEach((node) => {
    if (node.mesh !== undefined) requireIndex(node.mesh, meshes.length, "node mesh");
    if (node.skin !== undefined) requireIndex(node.skin, skins.length, "node skin");
  });
  const animations = optionalArray(document.animations, "animations", MAX_PRIMITIVES).map(
    (value, index) => validateAnimation(value, index, validatedAccessors.length, nodes.length),
  );
  validateScenes(document, nodes.length);

  return Object.freeze({
    ...document,
    asset,
    buffers: Object.freeze([buffer]),
    bufferViews: Object.freeze(validatedViews),
    accessors: Object.freeze(validatedAccessors),
    nodes: Object.freeze(nodes),
    meshes: Object.freeze(meshes),
    skins: Object.freeze(skins),
    images: Object.freeze(images),
    textures: Object.freeze(textures),
    materials: Object.freeze(materials),
    animations: Object.freeze(animations),
    ...(isPlainObject(document.extensions) ? { extensions: document.extensions } : {}),
  }) as GltfDocument;
}

interface ValidatedBufferView extends Readonly<Record<string, unknown>> {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly byteStride?: number | undefined;
}

interface ValidatedAccessor extends Readonly<Record<string, unknown>> {
  readonly componentType: number;
  readonly count: number;
  readonly type: string;
}

function validateBufferView(
  value: unknown,
  index: number,
  bufferLength: number,
): ValidatedBufferView {
  const bufferView = requireObject(value, `bufferView ${index}`);
  if (bufferView.buffer !== 0) invalid("avatar bufferView references an invalid buffer");
  const byteOffset = optionalSafeInteger(bufferView.byteOffset, 0, "bufferView byteOffset", 0);
  const byteLength = requireSafeInteger(bufferView.byteLength, "bufferView byteLength", 1);
  if (byteOffset + byteLength > bufferLength) invalid("avatar bufferView is out of bounds");
  const byteStride =
    bufferView.byteStride === undefined
      ? undefined
      : requireSafeInteger(bufferView.byteStride, "bufferView byteStride", 4);
  if (byteStride !== undefined && (byteStride > 252 || byteStride % 4 !== 0)) {
    invalid("avatar bufferView stride is invalid");
  }
  if (
    bufferView.target !== undefined &&
    bufferView.target !== 34_962 &&
    bufferView.target !== 34_963
  ) {
    invalid("avatar bufferView target is invalid");
  }
  return Object.freeze({
    ...bufferView,
    byteOffset,
    byteLength,
    ...(byteStride ? { byteStride } : {}),
  });
}

function validateAccessor(
  value: unknown,
  index: number,
  bufferViews: readonly ValidatedBufferView[],
): ValidatedAccessor {
  const accessor = requireObject(value, `accessor ${index}`);
  const componentType = requireSafeInteger(accessor.componentType, "accessor componentType", 1);
  const componentBytes = componentByteLength(componentType);
  const count = requireSafeInteger(accessor.count, "accessor count", 1);
  const type = accessor.type;
  if (typeof type !== "string" || !ACCESSOR_COMPONENTS[type]) {
    invalid("avatar accessor type is invalid");
  }
  const elementBytes = accessorElementBytes(type, componentBytes);
  const accessorOffset = optionalSafeInteger(accessor.byteOffset, 0, "accessor byteOffset", 0);
  if (accessor.bufferView !== undefined) {
    const viewIndex = requireIndex(accessor.bufferView, bufferViews.length, "accessor bufferView");
    const bufferView = bufferViews[viewIndex];
    if (bufferView === undefined) invalid("avatar accessor bufferView is missing");
    const stride = bufferView.byteStride ?? elementBytes;
    if (stride < elementBytes) invalid("avatar accessor stride is too small");
    const requiredBytes = accessorOffset + stride * (count - 1) + elementBytes;
    if (requiredBytes > bufferView.byteLength) invalid("avatar accessor is out of bounds");
  } else if (accessor.sparse === undefined) {
    invalid("avatar accessor has no storage");
  }
  if (accessor.sparse !== undefined) {
    validateSparseAccessor(accessor.sparse, count, elementBytes, bufferViews);
  }
  return Object.freeze({ ...accessor, componentType, count, type });
}

function validateSparseAccessor(
  value: unknown,
  accessorCount: number,
  elementBytes: number,
  bufferViews: readonly ValidatedBufferView[],
): void {
  const sparse = requireObject(value, "sparse accessor");
  const count = requireSafeInteger(sparse.count, "sparse accessor count", 1);
  if (count > accessorCount) invalid("sparse accessor count is invalid");
  const indices = requireObject(sparse.indices, "sparse accessor indices");
  const indexComponent = requireSafeInteger(indices.componentType, "sparse index componentType", 1);
  if (![5_121, 5_123, 5_125].includes(indexComponent)) {
    invalid("sparse accessor index type is invalid");
  }
  validateBufferViewSlice(
    indices,
    count * componentByteLength(indexComponent),
    bufferViews,
    "sparse indices",
  );
  validateBufferViewSlice(
    requireObject(sparse.values, "sparse accessor values"),
    count * elementBytes,
    bufferViews,
    "sparse values",
  );
}

function validateBufferViewSlice(
  value: Record<string, unknown>,
  byteLength: number,
  bufferViews: readonly ValidatedBufferView[],
  label: string,
): void {
  const viewIndex = requireIndex(value.bufferView, bufferViews.length, `${label} bufferView`);
  const view = bufferViews[viewIndex];
  if (view === undefined) invalid(`${label} bufferView is missing`);
  const byteOffset = optionalSafeInteger(value.byteOffset, 0, `${label} byteOffset`, 0);
  if (byteOffset + byteLength > view.byteLength) invalid(`${label} is out of bounds`);
}

function validateNode(value: unknown, index: number): GltfNode {
  const node = requireObject(value, `node ${index}`);
  if (node.name !== undefined && (typeof node.name !== "string" || node.name.length > 256)) {
    invalid("avatar node name is invalid");
  }
  if (node.children !== undefined) {
    const children = requireArray(node.children, "node children", MAX_NODES);
    if (new Set(children).size !== children.length) invalid("avatar node children are duplicated");
  }
  validateFiniteTuple(node.translation, 3, "node translation");
  validateFiniteTuple(node.rotation, 4, "node rotation");
  validateFiniteTuple(node.scale, 3, "node scale");
  validateFiniteTuple(node.matrix, 16, "node matrix");
  if (node.matrix !== undefined && [node.translation, node.rotation, node.scale].some(Boolean)) {
    invalid("avatar node mixes matrix and TRS transforms");
  }
  return Object.freeze(node) as GltfNode;
}

function validateNodeHierarchy(nodes: readonly GltfNode[]): void {
  const parent = new Array<number | undefined>(nodes.length);
  nodes.forEach((node, nodeIndex) => {
    for (const childValue of node.children ?? []) {
      const child = requireIndex(childValue, nodes.length, "node child");
      if (child === nodeIndex || parent[child] !== undefined) {
        invalid("avatar node hierarchy is invalid");
      }
      parent[child] = nodeIndex;
    }
  });
  for (let start = 0; start < nodes.length; start += 1) {
    const visited = new Set<number>();
    let current: number | undefined = start;
    while (current !== undefined) {
      if (visited.has(current)) invalid("avatar node hierarchy contains a cycle");
      visited.add(current);
      current = parent[current];
    }
  }
}

function validateImage(
  value: unknown,
  index: number,
  bufferViewCount: number,
): Readonly<Record<string, unknown>> {
  const image = requireObject(value, `image ${index}`);
  requireIndex(image.bufferView, bufferViewCount, "image bufferView");
  if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") {
    invalid("avatar image MIME type is invalid");
  }
  return Object.freeze(image);
}

function validateSampler(value: unknown, index: number): void {
  const sampler = requireObject(value, `sampler ${index}`);
  for (const key of ["magFilter", "minFilter", "wrapS", "wrapT"] as const) {
    if (sampler[key] !== undefined) requireSafeInteger(sampler[key], `sampler ${key}`, 1);
  }
}

function validateTexture(
  value: unknown,
  index: number,
  imageCount: number,
  samplerCount: number,
): Readonly<Record<string, unknown>> {
  const texture = requireObject(value, `texture ${index}`);
  requireIndex(texture.source, imageCount, "texture source");
  if (texture.sampler !== undefined) requireIndex(texture.sampler, samplerCount, "texture sampler");
  return Object.freeze(texture);
}

function validateMaterial(
  value: unknown,
  index: number,
  textureCount: number,
): Readonly<Record<string, unknown>> {
  const material = requireObject(value, `material ${index}`);
  validateTextureInfo(material.normalTexture, textureCount, "normal texture");
  validateTextureInfo(material.occlusionTexture, textureCount, "occlusion texture");
  validateTextureInfo(material.emissiveTexture, textureCount, "emissive texture");
  if (material.pbrMetallicRoughness !== undefined) {
    const pbr = requireObject(material.pbrMetallicRoughness, "PBR material");
    validateTextureInfo(pbr.baseColorTexture, textureCount, "base color texture");
    validateTextureInfo(pbr.metallicRoughnessTexture, textureCount, "metallic roughness texture");
  }
  return Object.freeze(material);
}

function validateTextureInfo(value: unknown, textureCount: number, label: string): void {
  if (value === undefined) return;
  const info = requireObject(value, label);
  requireIndex(info.index, textureCount, label);
  if (info.texCoord !== undefined) requireSafeInteger(info.texCoord, `${label} texCoord`, 0);
}

function validateMesh(
  value: unknown,
  index: number,
  accessors: readonly ValidatedAccessor[],
  materialCount: number,
): Readonly<Record<string, unknown>> {
  const mesh = requireObject(value, `mesh ${index}`);
  const primitives = requireArray(mesh.primitives, "mesh primitives", MAX_PRIMITIVES);
  if (primitives.length === 0) invalid("avatar mesh has no primitives");
  primitives.forEach((primitiveValue) => {
    const primitive = requireObject(primitiveValue, "mesh primitive");
    if (primitive.mode !== undefined && primitive.mode !== 4) {
      invalid("avatar mesh primitive is not TRIANGLES");
    }
    const attributes = requireObject(primitive.attributes, "mesh attributes");
    if (attributes.POSITION === undefined) invalid("avatar mesh has no positions");
    Object.values(attributes).forEach((accessor) =>
      requireIndex(accessor, accessors.length, "mesh attribute accessor"),
    );
    if (primitive.indices !== undefined) {
      const accessorIndex = requireIndex(
        primitive.indices,
        accessors.length,
        "mesh index accessor",
      );
      const accessor = accessors[accessorIndex];
      if (
        accessor === undefined ||
        accessor.type !== "SCALAR" ||
        ![5_121, 5_123, 5_125].includes(accessor.componentType)
      ) {
        invalid("avatar mesh index accessor is invalid");
      }
    }
    if (primitive.material !== undefined) {
      requireIndex(primitive.material, materialCount, "mesh material");
    }
    if (primitive.targets !== undefined) {
      requireArray(primitive.targets, "morph targets", MAX_TEXTURES).forEach((target) => {
        const attributes = requireObject(target, "morph target");
        Object.values(attributes).forEach((accessor) =>
          requireIndex(accessor, accessors.length, "morph target accessor"),
        );
      });
    }
  });
  return Object.freeze({ ...mesh, primitives: Object.freeze(primitives) });
}

function validateSkin(
  value: unknown,
  index: number,
  nodeCount: number,
  accessors: readonly ValidatedAccessor[],
): Readonly<Record<string, unknown>> {
  const skin = requireObject(value, `skin ${index}`);
  const joints = requireArray(skin.joints, "skin joints", MAX_JOINTS);
  if (joints.length === 0 || new Set(joints).size !== joints.length) {
    invalid("avatar skin joints are invalid");
  }
  joints.forEach((joint) => requireIndex(joint, nodeCount, "skin joint"));
  if (skin.skeleton !== undefined) requireIndex(skin.skeleton, nodeCount, "skin skeleton");
  if (skin.inverseBindMatrices !== undefined) {
    const accessorIndex = requireIndex(
      skin.inverseBindMatrices,
      accessors.length,
      "inverse bind matrices",
    );
    const accessor = accessors[accessorIndex];
    if (
      accessor === undefined ||
      accessor.type !== "MAT4" ||
      accessor.componentType !== 5_126 ||
      accessor.count !== joints.length
    ) {
      invalid("avatar inverse bind matrices accessor is invalid");
    }
  }
  return Object.freeze({ ...skin, joints: Object.freeze(joints) });
}

function validateAnimation(
  value: unknown,
  index: number,
  accessorCount: number,
  nodeCount: number,
): Readonly<Record<string, unknown>> {
  const animation = requireObject(value, `animation ${index}`);
  const samplers = requireArray(animation.samplers, "animation samplers", MAX_PRIMITIVES);
  samplers.forEach((samplerValue) => {
    const sampler = requireObject(samplerValue, "animation sampler");
    requireIndex(sampler.input, accessorCount, "animation input");
    requireIndex(sampler.output, accessorCount, "animation output");
    if (
      sampler.interpolation !== undefined &&
      !["LINEAR", "STEP", "CUBICSPLINE"].includes(String(sampler.interpolation))
    ) {
      invalid("animation interpolation is invalid");
    }
  });
  const channels = requireArray(animation.channels, "animation channels", MAX_PRIMITIVES);
  channels.forEach((channelValue) => {
    const channel = requireObject(channelValue, "animation channel");
    requireIndex(channel.sampler, samplers.length, "animation sampler");
    const target = requireObject(channel.target, "animation target");
    requireIndex(target.node, nodeCount, "animation target node");
    if (!new Set(["translation", "rotation", "scale", "weights"]).has(target.path as string)) {
      invalid("animation target path is invalid");
    }
  });
  return Object.freeze(animation);
}

function validateScenes(document: Record<string, unknown>, nodeCount: number): void {
  const scenes = optionalArray(document.scenes, "scenes", MAX_NODES);
  scenes.forEach((sceneValue) => {
    const scene = requireObject(sceneValue, "scene");
    optionalArray(scene.nodes, "scene nodes", MAX_NODES).forEach((node) =>
      requireIndex(node, nodeCount, "scene node"),
    );
  });
  if (document.scene !== undefined) requireIndex(document.scene, scenes.length, "default scene");
}

function rejectExternalUris(root: Record<string, unknown>): void {
  const pending: unknown[] = [root];
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    visited += 1;
    if (visited > 200_000) invalid("avatar JSON structure is too complex");
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isPlainObject(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase() === "uri") {
        throw new AvatarFileValidationError(
          "AVATAR_EXTERNAL_RESOURCE",
          "avatar contains an external resource URI",
        );
      }
      pending.push(child);
    }
  }
}

const ACCESSOR_COMPONENTS: Readonly<Record<string, number>> = Object.freeze({
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
});

function accessorElementBytes(type: string, componentBytes: number): number {
  if (type.startsWith("MAT")) {
    const dimension = Number(type.slice(3));
    const columnBytes = alignFour(dimension * componentBytes);
    return dimension * columnBytes;
  }
  const components = ACCESSOR_COMPONENTS[type];
  if (components === undefined) invalid("avatar accessor type is invalid");
  return components * componentBytes;
}

function componentByteLength(componentType: number): number {
  if ([5_120, 5_121].includes(componentType)) return 1;
  if ([5_122, 5_123].includes(componentType)) return 2;
  if ([5_125, 5_126].includes(componentType)) return 4;
  invalid("avatar accessor component type is invalid");
}

function alignFour(value: number): number {
  return Math.ceil(value / 4) * 4;
}

function validateFiniteTuple(value: unknown, length: number, label: string): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    invalid(`${label} is invalid`);
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) invalid(`avatar ${label} is invalid`);
  return value;
}

function requireArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(`avatar ${label} is invalid`);
  return value;
}

function optionalArray(value: unknown, label: string, maximum: number): unknown[] {
  return value === undefined ? [] : requireArray(value, label, maximum);
}

function requireSafeInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    invalid(`avatar ${label} is invalid`);
  return value as number;
}

function optionalSafeInteger(
  value: unknown,
  fallback: number,
  label: string,
  minimum: number,
): number {
  return value === undefined ? fallback : requireSafeInteger(value, label, minimum);
}

function requireIndex(value: unknown, length: number, label: string): number {
  const index = requireSafeInteger(value, label, 0);
  if (index >= length) invalid(`avatar ${label} is out of bounds`);
  return index;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function invalid(message: string): never {
  throw new AvatarFileValidationError("AVATAR_GLB_INVALID", message);
}
