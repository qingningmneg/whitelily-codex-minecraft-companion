import { z } from "zod";
import {
  BUILTIN_AVATAR_MODEL_IDS,
  type AvatarAppearanceListItem,
  type AvatarModelCatalogSnapshot,
  type AvatarModelControlRequest,
  type AvatarModelControlState,
  type AvatarModelId,
  type AvatarModelOrigin,
  type AvatarModelRecord,
  type AvatarRuntimeDescriptor,
} from "./avatarModelTypes.js";

export { BUILTIN_AVATAR_MODEL_IDS } from "./avatarModelTypes.js";
export type * from "./avatarModelTypes.js";

const USER_AVATAR_MODEL_ID_PATTERN =
  /^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const WORLD_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ERROR_CODE_PATTERN = /^AVATAR_[A-Z0-9_]{1,64}$/u;
const MANAGED_PATH_PATTERN = /^[A-Za-z0-9._/-]{1,512}$/u;
const PNG_DATA_URL_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u;

const boundedWellFormedString = (maximumCodePoints: number) =>
  z
    .string()
    .refine((value) => value === value.toWellFormed())
    .refine((value) => Array.from(value).length <= maximumCodePoints);

const avatarModelIdSchema = z.string().refine(isAvatarModelId);
const requestIdSchema = z.string().regex(REQUEST_ID_PATTERN);
const worldSessionIdSchema = z.string().regex(WORLD_SESSION_ID_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const canonicalIsoTimeSchema = z
  .string()
  .max(64)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  });
const displayNameSchema = boundedWellFormedString(80).refine(
  (value) => value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
);
const managedRelativePathSchema = z
  .string()
  .regex(MANAGED_PATH_PATTERN)
  .refine((value) => {
    if (value.startsWith("/") || value.endsWith("/") || value.includes("\\")) return false;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
    return value
      .split("/")
      .every((piece) => piece.length > 0 && piece !== "." && piece !== "..");
  });

const avatarModelOriginSchema = z.enum(["builtin", "imported"]);
const worldRendererSchema = z.literal("minecraft-skin");
const armModelSchema = z.enum(["slim", "wide"]);

const runtimeDescriptorFields = {
  modelId: avatarModelIdSchema,
  origin: avatarModelOriginSchema,
  worldRenderer: worldRendererSchema,
  armModel: armModelSchema,
} as const;

export const avatarRuntimeDescriptorSchema = z
  .object(runtimeDescriptorFields)
  .strict()
  .refine(isCoherentModelIdentity)
  .refine(({ modelId, armModel }) => hasCoherentArmModel(modelId, armModel));

export const avatarModelRecordSchema = z
  .object({
    id: avatarModelIdSchema,
    displayName: displayNameSchema,
    origin: avatarModelOriginSchema,
    worldRenderer: worldRendererSchema,
    skinAsset: managedRelativePathSchema,
    skinSha256: sha256Schema,
    armModel: armModelSchema,
    portraitAsset: managedRelativePathSchema.optional(),
    portraitSha256: sha256Schema.optional(),
    importedAt: canonicalIsoTimeSchema,
    validation: z
      .object({
        code: z.literal("AVATAR_VALID"),
        validatedAt: canonicalIsoTimeSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((record, context) => {
    if (!isCoherentModelIdentity({ modelId: record.id, origin: record.origin })) {
      context.addIssue({ code: "custom", message: "avatar appearance identity is incoherent" });
    }
    if (!hasCoherentArmModel(record.id, record.armModel)) {
      context.addIssue({ code: "custom", path: ["armModel"], message: "avatar arm model is incoherent" });
    }
    if (!hasCoherentManagedPath(record.id, record.origin, record.skinAsset)) {
      context.addIssue({ code: "custom", path: ["skinAsset"], message: "skin asset is incoherent" });
    }
    const hasPortraitAsset = record.portraitAsset !== undefined;
    const hasPortraitSha256 = record.portraitSha256 !== undefined;
    if (hasPortraitAsset !== hasPortraitSha256) {
      context.addIssue({ code: "custom", message: "portrait fields must appear together" });
    }
    if (record.origin === "builtin" && !hasPortraitAsset) {
      context.addIssue({ code: "custom", message: "builtin appearance needs a portrait" });
    }
    if (
      hasPortraitAsset &&
      !hasCoherentManagedPath(record.id, record.origin, record.portraitAsset)
    ) {
      context.addIssue({ code: "custom", path: ["portraitAsset"], message: "portrait asset is incoherent" });
    }
  });

export const avatarAppearanceListItemSchema = z
  .object({
    id: avatarModelIdSchema,
    displayName: displayNameSchema,
    origin: avatarModelOriginSchema,
    worldRenderer: worldRendererSchema,
    armModel: armModelSchema,
    previewDataUrl: z.string().max(3_000_000).regex(PNG_DATA_URL_PATTERN),
    portraitDataUrl: z.string().max(3_000_000).regex(PNG_DATA_URL_PATTERN).optional(),
  })
  .strict()
  .refine(({ id, origin }) => isCoherentModelIdentity({ modelId: id, origin }));

export const avatarModelCatalogSnapshotSchema = z
  .object({
    revision: z.number().int().safe().nonnegative(),
    models: z.array(avatarAppearanceListItemSchema).min(1).max(1_024),
    activeModelId: avatarModelIdSchema,
    pendingModelId: avatarModelIdSchema.optional(),
  })
  .strict()
  .superRefine(({ models, activeModelId, pendingModelId }, context) => {
    if (models[0]?.id !== BUILTIN_AVATAR_MODEL_IDS[0]) {
      context.addIssue({ code: "custom", message: "builtin avatar order is invalid" });
    }
    const ids = models.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "avatar model ids are duplicated" });
    }
    if (!ids.includes(activeModelId)) {
      context.addIssue({ code: "custom", message: "active avatar model is missing" });
    }
    if (pendingModelId !== undefined && !ids.includes(pendingModelId)) {
      context.addIssue({ code: "custom", message: "pending avatar model is missing" });
    }
  });

const prepareRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: requestIdSchema,
    operation: z.literal("prepare"),
    modelId: avatarModelIdSchema,
    worldSessionId: worldSessionIdSchema,
    candidate: avatarRuntimeDescriptorSchema,
    issuedAt: canonicalIsoTimeSchema,
  })
  .strict()
  .refine(({ modelId, candidate }) => modelId === candidate.modelId);

const commitRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: requestIdSchema,
    operation: z.literal("commit"),
    modelId: avatarModelIdSchema,
    worldSessionId: worldSessionIdSchema,
    issuedAt: canonicalIsoTimeSchema,
  })
  .strict();

const cancelRequestSchema = commitRequestSchema.extend({ operation: z.literal("cancel") }).strict();

export const avatarModelControlRequestSchema = z.discriminatedUnion("operation", [
  prepareRequestSchema,
  commitRequestSchema,
  cancelRequestSchema,
]);

export const avatarModelControlStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: requestIdSchema,
    phase: z.enum(["preparing", "ready", "committed", "cancelled", "failed"]),
    activeModelId: avatarModelIdSchema,
    candidateModelId: avatarModelIdSchema.optional(),
    worldSessionId: worldSessionIdSchema,
    errorCode: z.string().regex(ERROR_CODE_PATTERN).optional(),
    updatedAt: canonicalIsoTimeSchema,
  })
  .strict()
  .superRefine(({ phase, activeModelId, candidateModelId, errorCode }, context) => {
    if (["preparing", "ready", "committed"].includes(phase) && candidateModelId === undefined) {
      context.addIssue({ code: "custom", message: "candidate avatar model is missing" });
    }
    if (phase === "committed" && activeModelId !== candidateModelId) {
      context.addIssue({ code: "custom", message: "committed avatar model is not active" });
    }
    if (phase === "failed" && errorCode === undefined) {
      context.addIssue({ code: "custom", message: "failed avatar state has no error code" });
    }
    if (phase !== "failed" && errorCode !== undefined) {
      context.addIssue({ code: "custom", message: "successful avatar state has an error code" });
    }
  });

export function parseAvatarModelRecord(value: unknown): AvatarModelRecord {
  return parseOrThrow(avatarModelRecordSchema, value, "invalid avatar model record");
}

export function parseAvatarModelId(value: unknown): AvatarModelId {
  return parseOrThrow(avatarModelIdSchema, value, "invalid avatar model id");
}

export function parseAvatarRuntimeDescriptor(value: unknown): AvatarRuntimeDescriptor {
  return parseOrThrow(avatarRuntimeDescriptorSchema, value, "invalid avatar runtime descriptor");
}

export function parseAvatarModelCatalogSnapshot(value: unknown): AvatarModelCatalogSnapshot {
  return parseOrThrow(
    avatarModelCatalogSnapshotSchema,
    value,
    "invalid avatar model catalog snapshot",
  );
}

export function parseAvatarAppearanceListItem(value: unknown): AvatarAppearanceListItem {
  return parseOrThrow(avatarAppearanceListItemSchema, value, "invalid avatar appearance list item");
}

export function parseAvatarModelControlRequest(value: unknown): AvatarModelControlRequest {
  return parseOrThrow(
    avatarModelControlRequestSchema,
    value,
    "invalid avatar model control request",
  );
}

export function parseAvatarModelControlState(value: unknown): AvatarModelControlState {
  return parseOrThrow(avatarModelControlStateSchema, value, "invalid avatar model control state");
}

function isAvatarModelId(value: string): value is AvatarModelId {
  return value === BUILTIN_AVATAR_MODEL_IDS[0] || USER_AVATAR_MODEL_ID_PATTERN.test(value);
}

function isCoherentModelIdentity(value: {
  readonly modelId: string;
  readonly origin: AvatarModelOrigin;
}): boolean {
  return value.modelId === BUILTIN_AVATAR_MODEL_IDS[0]
    ? value.origin === "builtin"
    : USER_AVATAR_MODEL_ID_PATTERN.test(value.modelId) && value.origin === "imported";
}

function hasCoherentManagedPath(modelId: string, origin: AvatarModelOrigin, path: string): boolean {
  if (origin === "builtin") return path.startsWith("builtin/whitelily/");
  return path.startsWith(`user/${modelId.slice("user:".length)}/`);
}

function hasCoherentArmModel(modelId: string, armModel: "slim" | "wide"): boolean {
  return modelId !== BUILTIN_AVATAR_MODEL_IDS[0] || armModel === "slim";
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(message, { cause: parsed.error });
  return parsed.data;
}
