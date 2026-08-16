import { z } from "zod";
import {
  BUILTIN_AVATAR_MODEL_IDS,
  type AvatarBoneMapping,
  type AvatarModelCatalogSnapshot,
  type AvatarModelControlRequest,
  type AvatarModelControlState,
  type AvatarModelFormat,
  type AvatarModelId,
  type AvatarModelListItem,
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
const boneNameSchema = boundedWellFormedString(128).refine(
  (value) => value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
);
const managedRelativePathSchema = z
  .string()
  .regex(MANAGED_PATH_PATTERN)
  .refine((value) => {
    if (value.startsWith("/") || value.endsWith("/") || value.includes("\\")) return false;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return false;
    const pieces = value.split("/");
    return pieces.every((piece) => piece.length > 0 && piece !== "." && piece !== "..");
  });

const avatarModelOriginSchema = z.enum(["builtin", "imported"]);
const avatarModelFormatSchema = z.enum(["builtin-hd", "builtin-classic", "vrm", "glb"]);
const bodyAnimationSchema = z.literal("whitelily-humanoid-v1");
const expressionCapabilitySchema = z.enum(["full", "neutral-only"]);

export const avatarBoneMappingSchema = z
  .object({
    head: boneNameSchema,
    neck: boneNameSchema,
    chest: boneNameSchema,
    hips: boneNameSchema,
    leftUpperArm: boneNameSchema,
    leftLowerArm: boneNameSchema,
    leftHand: boneNameSchema,
    rightUpperArm: boneNameSchema,
    rightLowerArm: boneNameSchema,
    rightHand: boneNameSchema,
    leftUpperLeg: boneNameSchema,
    leftLowerLeg: boneNameSchema,
    leftFoot: boneNameSchema,
    rightUpperLeg: boneNameSchema,
    rightLowerLeg: boneNameSchema,
    rightFoot: boneNameSchema,
  })
  .strict()
  .refine((mapping) => new Set(Object.values(mapping)).size === Object.keys(mapping).length);

const runtimeDescriptorFields = {
  modelId: avatarModelIdSchema,
  origin: avatarModelOriginSchema,
  format: avatarModelFormatSchema,
  resourcePath: managedRelativePathSchema,
  sha256: sha256Schema,
  boneMapping: avatarBoneMappingSchema,
  bodyAnimation: bodyAnimationSchema,
  expressions: expressionCapabilitySchema,
} as const;

export const avatarRuntimeDescriptorSchema = z
  .object(runtimeDescriptorFields)
  .strict()
  .refine(isCoherentModelIdentity)
  .refine(hasCoherentManagedPath);

export const avatarModelRecordSchema = z
  .object({
    id: avatarModelIdSchema,
    displayName: displayNameSchema,
    origin: avatarModelOriginSchema,
    format: avatarModelFormatSchema,
    resourcePath: managedRelativePathSchema,
    sha256: sha256Schema,
    importedAt: canonicalIsoTimeSchema,
    previewPath: managedRelativePathSchema,
    previewStatus: z.literal("ready"),
    boneMapping: avatarBoneMappingSchema,
    bodyAnimation: bodyAnimationSchema,
    expressions: expressionCapabilitySchema,
    validation: z
      .object({
        code: z.literal("AVATAR_VALID"),
        validatedAt: canonicalIsoTimeSchema,
      })
      .strict(),
  })
  .strict()
  .refine(({ id, origin, format }) => isCoherentModelIdentity({ modelId: id, origin, format }))
  .refine(({ id, origin, resourcePath }) =>
    hasCoherentManagedPath({ modelId: id, origin, resourcePath }),
  )
  .refine(({ id, origin, previewPath }) =>
    hasCoherentManagedPath({ modelId: id, origin, resourcePath: previewPath }),
  );

export const avatarModelListItemSchema = z
  .object({
    id: avatarModelIdSchema,
    displayName: displayNameSchema,
    origin: avatarModelOriginSchema,
    format: avatarModelFormatSchema,
    previewDataUrl: z.string().max(3_000_000).regex(PNG_DATA_URL_PATTERN),
    bodyAnimation: bodyAnimationSchema,
    expressions: expressionCapabilitySchema,
  })
  .strict()
  .refine(({ id, origin, format }) => isCoherentModelIdentity({ modelId: id, origin, format }));

export const avatarModelCatalogSnapshotSchema = z
  .object({
    revision: z.number().int().safe().nonnegative(),
    models: z.array(avatarModelListItemSchema).min(2).max(1_024),
    activeModelId: avatarModelIdSchema,
    pendingModelId: avatarModelIdSchema.optional(),
  })
  .strict()
  .superRefine(({ models, activeModelId, pendingModelId }, context) => {
    if (
      models[0]?.id !== BUILTIN_AVATAR_MODEL_IDS[0] ||
      models[1]?.id !== BUILTIN_AVATAR_MODEL_IDS[1]
    ) {
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

export function parseAvatarModelListItem(value: unknown): AvatarModelListItem {
  return parseOrThrow(avatarModelListItemSchema, value, "invalid avatar model list item");
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
  return (
    value === BUILTIN_AVATAR_MODEL_IDS[0] ||
    value === BUILTIN_AVATAR_MODEL_IDS[1] ||
    USER_AVATAR_MODEL_ID_PATTERN.test(value)
  );
}

function isCoherentModelIdentity(value: {
  readonly modelId: string;
  readonly origin: AvatarModelOrigin;
  readonly format: AvatarModelFormat;
}): boolean {
  if (value.modelId === BUILTIN_AVATAR_MODEL_IDS[0]) {
    return value.origin === "builtin" && value.format === "builtin-hd";
  }
  if (value.modelId === BUILTIN_AVATAR_MODEL_IDS[1]) {
    return value.origin === "builtin" && value.format === "builtin-classic";
  }
  return (
    USER_AVATAR_MODEL_ID_PATTERN.test(value.modelId) &&
    value.origin === "imported" &&
    (value.format === "vrm" || value.format === "glb")
  );
}

function hasCoherentManagedPath(value: {
  readonly modelId: string;
  readonly origin: AvatarModelOrigin;
  readonly resourcePath: string;
}): boolean {
  if (value.origin === "builtin") {
    const builtinDirectory = value.modelId.slice("builtin:".length);
    return value.resourcePath.startsWith(`builtin/${builtinDirectory}/`);
  }
  const uuid = value.modelId.slice("user:".length);
  return value.resourcePath.startsWith(`user/${uuid}/`);
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(message, { cause: parsed.error });
  return parsed.data;
}
