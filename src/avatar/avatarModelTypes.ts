export const BUILTIN_AVATAR_MODEL_IDS = Object.freeze(["builtin:whitelily"] as const);

export type AvatarModelId = string;
export type AvatarModelOrigin = "builtin" | "imported";
export type AvatarWorldRenderer = "minecraft-skin";
export type AvatarArmModel = "slim" | "wide";

export interface AvatarAppearanceRecord {
  readonly id: string;
  readonly displayName: string;
  readonly origin: "builtin" | "imported";
  readonly worldRenderer: AvatarWorldRenderer;
  readonly skinAsset: string;
  readonly skinSha256: string;
  readonly armModel: AvatarArmModel;
  readonly portraitAsset?: string;
  readonly portraitSha256?: string;
  readonly importedAt: string;
  readonly validation: { readonly code: "AVATAR_VALID"; readonly validatedAt: string };
}

export interface AvatarAppearanceListItem {
  readonly id: string;
  readonly displayName: string;
  readonly origin: "builtin" | "imported";
  readonly worldRenderer: "minecraft-skin";
  readonly armModel: "slim" | "wide";
  readonly previewDataUrl: string;
  readonly portraitDataUrl?: string;
}

export interface AvatarRuntimeDescriptor {
  readonly modelId: string;
  readonly origin: "builtin" | "imported";
  readonly worldRenderer: "minecraft-skin";
  readonly armModel: "slim" | "wide";
}

// Keeps existing IPC method names stable during the appearance-contract migration.
export type AvatarModelRecord = AvatarAppearanceRecord;

export interface AvatarModelCatalogSnapshot {
  readonly revision: number;
  readonly models: readonly AvatarAppearanceListItem[];
  readonly activeModelId: AvatarModelId;
  readonly pendingModelId?: AvatarModelId | undefined;
}

export interface AvatarModelCatalogState {
  readonly revision: number;
  readonly models: readonly AvatarAppearanceRecord[];
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
