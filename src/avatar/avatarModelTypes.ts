export const BUILTIN_AVATAR_MODEL_IDS = Object.freeze([
  "builtin:whitelily-hd",
  "builtin:whitelily-classic",
] as const);

export type AvatarModelId = string;
export type AvatarModelOrigin = "builtin" | "imported";
export type AvatarModelFormat = "builtin-hd" | "builtin-classic" | "vrm" | "glb";
export type AvatarExpressionCapability = "full" | "neutral-only";
export type AvatarBodyAnimationCapability = "whitelily-humanoid-v1";
export type AvatarModelValidationCode =
  | "AVATAR_VALID"
  | "AVATAR_FORMAT_UNSUPPORTED"
  | "AVATAR_GLB_INVALID"
  | "AVATAR_EXTERNAL_RESOURCE"
  | "AVATAR_REQUIRED_BONE_MISSING"
  | "AVATAR_PREVIEW_FAILED"
  | "AVATAR_DIGEST_MISMATCH";

export interface AvatarBoneMapping {
  readonly head: string;
  readonly neck: string;
  readonly chest: string;
  readonly hips: string;
  readonly leftUpperArm: string;
  readonly leftLowerArm: string;
  readonly leftHand: string;
  readonly rightUpperArm: string;
  readonly rightLowerArm: string;
  readonly rightHand: string;
  readonly leftUpperLeg: string;
  readonly leftLowerLeg: string;
  readonly leftFoot: string;
  readonly rightUpperLeg: string;
  readonly rightLowerLeg: string;
  readonly rightFoot: string;
}

export interface AvatarModelRecord {
  readonly id: AvatarModelId;
  readonly displayName: string;
  readonly origin: AvatarModelOrigin;
  readonly format: AvatarModelFormat;
  readonly resourcePath: string;
  readonly sha256: string;
  readonly importedAt: string;
  readonly previewPath: string;
  readonly previewStatus: "ready";
  readonly boneMapping: AvatarBoneMapping;
  readonly bodyAnimation: AvatarBodyAnimationCapability;
  readonly expressions: AvatarExpressionCapability;
  readonly validation: {
    readonly code: "AVATAR_VALID";
    readonly validatedAt: string;
  };
}

export interface AvatarModelListItem {
  readonly id: AvatarModelId;
  readonly displayName: string;
  readonly origin: AvatarModelOrigin;
  readonly format: AvatarModelFormat;
  readonly previewDataUrl: string;
  readonly bodyAnimation: AvatarBodyAnimationCapability;
  readonly expressions: AvatarExpressionCapability;
}

export interface AvatarModelCatalogSnapshot {
  readonly revision: number;
  readonly models: readonly AvatarModelListItem[];
  readonly activeModelId: AvatarModelId;
  readonly pendingModelId?: AvatarModelId | undefined;
}

export interface AvatarModelCatalogState {
  readonly revision: number;
  readonly models: readonly AvatarModelRecord[];
}

export interface AvatarRuntimeDescriptor {
  readonly modelId: AvatarModelId;
  readonly origin: AvatarModelOrigin;
  readonly format: AvatarModelFormat;
  readonly resourcePath: string;
  readonly sha256: string;
  readonly boneMapping: AvatarBoneMapping;
  readonly bodyAnimation: AvatarBodyAnimationCapability;
  readonly expressions: AvatarExpressionCapability;
}

export type AvatarModelControlRequest =
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly operation: "prepare";
      readonly modelId: AvatarModelId;
      readonly worldSessionId: string;
      readonly candidate: AvatarRuntimeDescriptor;
      readonly issuedAt: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly operation: "commit" | "cancel";
      readonly modelId: AvatarModelId;
      readonly worldSessionId: string;
      readonly issuedAt: string;
    };

export interface AvatarModelControlState {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly phase: "preparing" | "ready" | "committed" | "cancelled" | "failed";
  readonly activeModelId: AvatarModelId;
  readonly candidateModelId?: AvatarModelId | undefined;
  readonly worldSessionId: string;
  readonly errorCode?: string | undefined;
  readonly updatedAt: string;
}
