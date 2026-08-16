import type {
  AvatarBoneMapping,
  AvatarExpressionCapability,
} from "../../../../src/avatar/avatarModelTypes.js";
import {
  AvatarFileValidationError,
  type GltfDocument,
  type GltfNode,
  type ParsedGlbContainer,
} from "./glbContainer.js";

const boneSemantics = [
  "head",
  "neck",
  "chest",
  "hips",
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
] as const satisfies readonly (keyof AvatarBoneMapping)[];

const genericAliases: Readonly<Record<keyof AvatarBoneMapping, readonly string[]>> = Object.freeze({
  hips: ["hips", "pelvis"],
  chest: ["chest", "upperchest", "spine2", "spine1", "spine"],
  neck: ["neck"],
  head: ["head"],
  leftUpperArm: ["leftupperarm", "leftarm", "lupperarm"],
  leftLowerArm: ["leftlowerarm", "leftforearm", "lforearm"],
  leftHand: ["lefthand", "lhand"],
  rightUpperArm: ["rightupperarm", "rightarm", "rupperarm"],
  rightLowerArm: ["rightlowerarm", "rightforearm", "rforearm"],
  rightHand: ["righthand", "rhand"],
  leftUpperLeg: ["leftupperleg", "leftthigh", "lthigh"],
  leftLowerLeg: ["leftlowerleg", "leftshin", "lshin"],
  leftFoot: ["leftfoot", "lfoot"],
  rightUpperLeg: ["rightupperleg", "rightthigh", "rthigh"],
  rightLowerLeg: ["rightlowerleg", "rightshin", "rshin"],
  rightFoot: ["rightfoot", "rfoot"],
});

export function mapAvatarBones(input: ParsedGlbContainer): {
  readonly mapping: AvatarBoneMapping;
  readonly expressions: AvatarExpressionCapability;
} {
  try {
    const indices =
      input.vrmVersion === "1.0"
        ? mapVrm1Indices(input.json)
        : input.vrmVersion === "0.x"
          ? mapVrm0Indices(input.json)
          : mapGenericIndices(input.json.nodes);
    validateUniqueIndices(indices);
    validateHierarchy(input.json.nodes, indices);
    validateLeftAndRightSides(input.json.nodes, indices);
    const mappedNames = boneSemantics.map(
      (semantic) => [semantic, requireNodeName(input.json.nodes, indices[semantic])] as const,
    );
    if (new Set(mappedNames.map(([, name]) => name)).size !== boneSemantics.length) {
      throw requiredBones("required avatar bone names are duplicated");
    }
    const mapping = Object.freeze(Object.fromEntries(mappedNames)) as unknown as AvatarBoneMapping;
    return Object.freeze({
      mapping,
      expressions: hasUsableExpressions(input) ? "full" : "neutral-only",
    });
  } catch (error) {
    if (error instanceof AvatarFileValidationError) throw error;
    throw requiredBones("avatar humanoid mapping is invalid", error);
  }
}

type BoneIndices = Record<keyof AvatarBoneMapping, number>;

function mapVrm1Indices(document: GltfDocument): BoneIndices {
  const vrm = requireObject(document.extensions?.VRMC_vrm, "VRM 1.0 extension");
  const humanoid = requireObject(vrm.humanoid, "VRM 1.0 humanoid");
  const humanBones = requireObject(humanoid.humanBones, "VRM 1.0 human bones");
  return Object.fromEntries(
    boneSemantics.map((semantic) => {
      const bone = requireObject(humanBones[semantic], `VRM 1.0 bone ${semantic}`);
      return [semantic, requireNodeIndex(bone.node, document.nodes.length, semantic)];
    }),
  ) as BoneIndices;
}

function mapVrm0Indices(document: GltfDocument): BoneIndices {
  const vrm = requireObject(document.extensions?.VRM, "VRM 0.x extension");
  const humanoid = requireObject(vrm.humanoid, "VRM 0.x humanoid");
  if (!Array.isArray(humanoid.humanBones)) throw requiredBones("VRM 0.x human bones are missing");
  const declared = new Map<string, number>();
  for (const value of humanoid.humanBones) {
    const bone = requireObject(value, "VRM 0.x human bone");
    if (typeof bone.bone !== "string" || declared.has(bone.bone)) {
      throw requiredBones("VRM 0.x human bone semantics are invalid");
    }
    declared.set(bone.bone, requireNodeIndex(bone.node, document.nodes.length, bone.bone));
  }
  return Object.fromEntries(
    boneSemantics.map((semantic) => {
      const index = declared.get(semantic);
      if (index === undefined) throw requiredBones(`required avatar bone ${semantic} is missing`);
      return [semantic, index];
    }),
  ) as BoneIndices;
}

function mapGenericIndices(nodes: readonly GltfNode[]): BoneIndices {
  const normalized = nodes.map((node) => normalizeBoneName(node.name));
  const mapped = {} as BoneIndices;
  for (const semantic of boneSemantics) {
    let selected: number | undefined;
    for (const alias of genericAliases[semantic]) {
      const matches = normalized.flatMap((name, index) => (name === alias ? [index] : []));
      if (matches.length > 1) throw requiredBones(`avatar bone ${semantic} is ambiguous`);
      if (matches.length === 1) {
        selected = matches[0];
        break;
      }
    }
    if (selected === undefined) throw requiredBones(`required avatar bone ${semantic} is missing`);
    mapped[semantic] = selected;
  }
  return mapped;
}

function normalizeBoneName(name: string | undefined): string {
  if (typeof name !== "string") return "";
  let normalized = name
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "");
  for (const prefix of ["mixamorig", "armature", "skeleton", "jbip"]) {
    if (normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length);
  }
  return normalized;
}

function validateUniqueIndices(indices: BoneIndices): void {
  if (new Set(Object.values(indices)).size !== boneSemantics.length) {
    throw requiredBones("required avatar bones are duplicated");
  }
}

function validateHierarchy(nodes: readonly GltfNode[], indices: BoneIndices): void {
  const parents = buildParents(nodes);
  const requiredChains: readonly (readonly (keyof AvatarBoneMapping)[])[] = [
    ["hips", "chest", "neck", "head"],
    ["chest", "leftUpperArm", "leftLowerArm", "leftHand"],
    ["chest", "rightUpperArm", "rightLowerArm", "rightHand"],
    ["hips", "leftUpperLeg", "leftLowerLeg", "leftFoot"],
    ["hips", "rightUpperLeg", "rightLowerLeg", "rightFoot"],
  ];
  for (const chain of requiredChains) {
    for (let index = 1; index < chain.length; index += 1) {
      const ancestorSemantic = chain[index - 1];
      const childSemantic = chain[index];
      if (
        ancestorSemantic === undefined ||
        childSemantic === undefined ||
        !isDescendant(indices[childSemantic], indices[ancestorSemantic], parents)
      ) {
        throw requiredBones("avatar humanoid hierarchy is invalid");
      }
    }
  }
}

function buildParents(nodes: readonly GltfNode[]): readonly (number | undefined)[] {
  const parents = new Array<number | undefined>(nodes.length);
  nodes.forEach((node, parent) => {
    for (const child of node.children ?? []) parents[child] = parent;
  });
  return parents;
}

function isDescendant(
  child: number,
  ancestor: number,
  parents: readonly (number | undefined)[],
): boolean {
  let current = parents[child];
  while (current !== undefined) {
    if (current === ancestor) return true;
    current = parents[current];
  }
  return false;
}

function validateLeftAndRightSides(nodes: readonly GltfNode[], indices: BoneIndices): void {
  const parents = buildParents(nodes);
  const hipsX = worldX(nodes, indices.hips, parents, new Map());
  const pairs: readonly (readonly [keyof AvatarBoneMapping, keyof AvatarBoneMapping])[] = [
    ["leftUpperArm", "rightUpperArm"],
    ["leftHand", "rightHand"],
    ["leftUpperLeg", "rightUpperLeg"],
    ["leftFoot", "rightFoot"],
  ];
  let leftDirection: number | undefined;
  for (const [left, right] of pairs) {
    const leftOffset = worldX(nodes, indices[left], parents, new Map()) - hipsX;
    const rightOffset = worldX(nodes, indices[right], parents, new Map()) - hipsX;
    if (leftOffset === 0 || rightOffset === 0 || Math.sign(leftOffset) === Math.sign(rightOffset)) {
      throw requiredBones("avatar left and right rest pose is invalid");
    }
    leftDirection ??= Math.sign(leftOffset);
    if (Math.sign(leftOffset) !== leftDirection) {
      throw requiredBones("avatar left and right rest pose is inconsistent");
    }
  }
}

function worldX(
  nodes: readonly GltfNode[],
  nodeIndex: number,
  parents: readonly (number | undefined)[],
  memo: Map<number, number>,
): number {
  const cached = memo.get(nodeIndex);
  if (cached !== undefined) return cached;
  const node = nodes[nodeIndex];
  if (node === undefined) throw requiredBones("avatar bone node is missing");
  const localX = node.matrix?.[12] ?? node.translation?.[0] ?? 0;
  if (typeof localX !== "number" || !Number.isFinite(localX)) {
    throw requiredBones("avatar bone transform is invalid");
  }
  const parent = parents[nodeIndex];
  const result = localX + (parent === undefined ? 0 : worldX(nodes, parent, parents, memo));
  memo.set(nodeIndex, result);
  return result;
}

function requireNodeName(nodes: readonly GltfNode[], index: number): string {
  const name = nodes[index]?.name;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.trim() !== name ||
    Array.from(name).length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw requiredBones("avatar bone name is invalid");
  }
  return name;
}

function hasUsableExpressions(input: ParsedGlbContainer): boolean {
  if (!hasMorphTargets(input.json)) return false;
  if (input.vrmVersion === "1.0") {
    const vrm = input.json.extensions?.VRMC_vrm;
    return (
      isPlainObject(vrm) &&
      isPlainObject(vrm.expressions) &&
      Object.keys(vrm.expressions).length > 0
    );
  }
  if (input.vrmVersion === "0.x") {
    const vrm = input.json.extensions?.VRM;
    if (!isPlainObject(vrm) || !isPlainObject(vrm.blendShapeMaster)) return false;
    return (
      Array.isArray(vrm.blendShapeMaster.blendShapeGroups) &&
      vrm.blendShapeMaster.blendShapeGroups.length > 0
    );
  }
  return false;
}

function hasMorphTargets(document: GltfDocument): boolean {
  return document.meshes.some((mesh) => {
    if (!Array.isArray(mesh.primitives)) return false;
    return mesh.primitives.some(
      (primitive) =>
        isPlainObject(primitive) &&
        Array.isArray(primitive.targets) &&
        primitive.targets.length > 0,
    );
  });
}

function requireNodeIndex(value: unknown, nodeCount: number, semantic: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= nodeCount) {
    throw requiredBones(`avatar bone ${semantic} node is invalid`);
  }
  return value as number;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw requiredBones(`${label} is missing`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requiredBones(message: string, cause?: unknown): AvatarFileValidationError {
  return new AvatarFileValidationError("AVATAR_REQUIRED_BONE_MISSING", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}
