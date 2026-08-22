import { z } from "zod";
import type { AccountSnapshot } from "../codex/accountService.js";
import type { ModelCatalogSnapshot, ModelSelection } from "../codex/modelCatalog.js";
import { MODEL_ID_PATTERN } from "../codex/modelId.js";
import type { RuntimeEvent, RuntimeSnapshot } from "../runtime/runtimeEvents.js";
import type { OwnerIdentitySnapshot } from "../identity/ownerIdentity.js";
import {
  behaviorModeSettingsSchema,
  companionModeSchema,
  companionProfileSchema,
  type CompanionProfile,
} from "../profile/profileSchema.js";
import type { DocumentEnvelope } from "../storage/documentStore.js";
import { createDocumentEnvelopeSchema } from "../storage/schemas.js";
import { redactedMemoryExportSchema, type RedactedMemoryExport } from "../memory/memoryExport.js";
import {
  safetyPresetSchema,
  worldProfileSchema,
  type WorldProfile,
} from "../world/worldProfileSchema.js";
import { DIAGNOSTIC_ACTION_ERROR_CODES } from "../diagnostics/diagnosticManifest.js";

export const DESKTOP_PROTOCOL_VERSION = 1 as const;
export const MAX_DESKTOP_LINE_BYTES = 1_048_576;

const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const safeTokenSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u);
const boundedPublicString = (maxCodePoints: number) =>
  z
    .string()
    .refine((value) => value === value.toWellFormed())
    .refine((value) => Array.from(value).length <= maxCodePoints);
const finiteNonnegative = z.number().finite().nonnegative();
const finiteNonnegativeInteger = finiteNonnegative.int().safe();
const runtimeRevisionSchema = finiteNonnegativeInteger;
const documentRevisionSchema = finiteNonnegativeInteger;
const ownerIdentitySnapshotFields = [
  "revision",
  "ownerUsername",
  "configured",
  "presence",
] as const;
const ownerUsernameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{3,16}$/u)
  .refine((value) => value !== "YourMcName");
const modelTokenSchema = z.string().regex(MODEL_ID_PATTERN);
const reasoningEffortSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const attemptIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u);
const connectionNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/u);
const minecraftPortSchema = z.number().int().min(1).max(65_535);
const encodedUrlSeparator = /%2f|%5c/iu;

const taskStopReasonSchema = z.enum([
  "completed",
  "failed",
  "timeout",
  "budget_exhausted",
  "owner_stop",
  "emergency_stop",
  "disconnect",
  "world_changed",
  "owner_changed",
  "model_unavailable",
  "model_changed",
  "process_exit",
]);

const taskLimitsSchema = z
  .object({
    maxToolCalls: finiteNonnegative,
    maxBlockChanges: finiteNonnegative,
    maxHorizontalTravel: finiteNonnegative,
    maxDurationMs: finiteNonnegative,
    maxDangerousOperations: finiteNonnegative,
  })
  .strict();

const taskBudgetSchema = z
  .object({
    active: z.boolean(),
    stopReason: taskStopReasonSchema.nullable(),
    limits: taskLimitsSchema,
    toolCalls: finiteNonnegativeInteger,
    blockChanges: finiteNonnegativeInteger,
    horizontalTravel: finiteNonnegative,
    dangerousOperations: finiteNonnegativeInteger,
    startedAt: finiteNonnegativeInteger.nullable(),
  })
  .strict();

const publicTaskSnapshotSchema = z
  .object({
    id: z
      .string()
      .max(128)
      .regex(/^task_[a-z0-9_-]+$/u),
    goal: boundedPublicString(4_000).refine((value) => value.trim().length > 0),
    status: z.enum(["running", "waiting_confirmation"]),
    allowedActions: z
      .array(boundedPublicString(256).refine((value) => value.trim().length > 0))
      .max(16),
    effectiveLimits: taskLimitsSchema,
    startedAt: boundedPublicString(64).refine((value) => value.length > 0),
    budget: taskBudgetSchema,
  })
  .strict();

const canonicalIsoTimeSchema = boundedPublicString(64).refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
});

const runtimeActionQueueItemSchema = z
  .object({
    index: z.number().int().positive().safe(),
    kind: boundedPublicString(64).refine((value) => value.trim().length > 0),
    summary: boundedPublicString(160),
    status: z.enum([
      "waiting",
      "running",
      "suspended",
      "waiting_permission",
      "completed",
      "failed",
      "cancelled",
    ]),
    retryCount: finiteNonnegativeInteger,
    enqueuedAt: canonicalIsoTimeSchema,
    startedAt: canonicalIsoTimeSchema.optional(),
    endedAt: canonicalIsoTimeSchema.optional(),
    reason: boundedPublicString(240).optional(),
  })
  .strict();

const runtimeActionQueueProjectionSchema = z
  .object({
    goal: boundedPublicString(160).nullable(),
    items: z.array(runtimeActionQueueItemSchema).max(256),
  })
  .strict();

const minecraftStateSchema = z
  .object({
    state: z.enum(["disconnected", "connecting", "connected", "reconnecting"]),
    sessionId: safeTokenSchema.nullable(),
  })
  .strict();

const codexStateSchema = z
  .object({
    state: z.enum(["stopped", "starting", "ready", "failed"]),
    model: modelTokenSchema.nullable(),
  })
  .strict();

const workspaceVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const actionCapabilitySnapshotSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("starting"),
      workspaceVersion: workspaceVersionSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("ready"),
      workspaceVersion: workspaceVersionSchema,
      mcpListening: z.literal(true),
      discoveredToolCount: finiteNonnegativeInteger,
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
      workspaceVersion: workspaceVersionSchema.nullable(),
      mcpListening: z.boolean(),
      discoveredToolCount: finiteNonnegativeInteger,
      errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    })
    .strict(),
]);

const publicErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9_]{1,64}$/u),
    message: boundedPublicString(160).refine((value) => value.length > 0),
  })
  .strict();

const runtimeSnapshotSchema = z
  .object({
    revision: runtimeRevisionSchema,
    lifecycle: z.enum(["idle", "starting", "running", "stopping", "stopped", "failed"]),
    minecraft: minecraftStateSchema,
    codex: codexStateSchema,
    actions: actionCapabilitySnapshotSchema.nullable(),
    task: publicTaskSnapshotSchema.nullable(),
    actionQueue: runtimeActionQueueProjectionSchema,
    lastError: publicErrorSchema.nullable(),
  })
  .strict();

const ownerIdentitySnapshotValueSchema = z
  .object({
    revision: documentRevisionSchema,
    ownerUsername: ownerUsernameSchema.nullable(),
    configured: z.boolean(),
    presence: z.enum(["unknown", "online", "offline"]),
  })
  .strict()
  .refine((value) => value.configured === (value.ownerUsername !== null));
const ownerIdentitySnapshotSchema = z.preprocess(
  (value) => (hasOwnDataProperties(value, ownerIdentitySnapshotFields) ? value : undefined),
  ownerIdentitySnapshotValueSchema,
);

const runtimeEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("lifecycle"),
      revision: runtimeRevisionSchema,
      state: runtimeSnapshotSchema.shape.lifecycle,
    })
    .strict(),
  z
    .object({
      kind: z.literal("minecraft"),
      revision: runtimeRevisionSchema,
      state: minecraftStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("codex"),
      revision: runtimeRevisionSchema,
      state: codexStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("actions"),
      revision: runtimeRevisionSchema,
      state: actionCapabilitySnapshotSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      revision: runtimeRevisionSchema,
      task: publicTaskSnapshotSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("action_queue"),
      revision: runtimeRevisionSchema,
      actionQueue: runtimeActionQueueProjectionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      revision: runtimeRevisionSchema,
      error: publicErrorSchema,
    })
    .strict(),
]);

const accountSnapshotSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("signed_out") }).strict(),
  z
    .object({
      status: z.literal("pending"),
      attemptId: attemptIdSchema,
      expiresAt: finiteNonnegativeInteger,
    })
    .strict(),
  z
    .object({
      status: z.literal("signed_in"),
      auth: z.literal("chatgpt"),
    })
    .strict(),
  z
    .object({
      status: z.literal("cancelled"),
      attemptId: attemptIdSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("expired"),
      attemptId: attemptIdSchema,
    })
    .strict(),
]);

const modelSelectionInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic") }).strict(),
  z
    .object({
      mode: z.literal("explicit"),
      modelId: modelTokenSchema,
      reasoningEffort: reasoningEffortSchema,
    })
    .strict(),
]);

const modelSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic") }).strict(),
  z
    .object({
      mode: z.literal("explicit"),
      modelId: modelTokenSchema,
      reasoningEffort: reasoningEffortSchema,
      available: z.literal(true),
    })
    .strict(),
]);

const availableModelSchema = z
  .object({
    id: modelTokenSchema,
    displayName: boundedPublicString(160).refine(
      (value) => value.length > 0 && value.trim() === value,
    ),
    supportedReasoningEfforts: z.array(reasoningEffortSchema).min(1).max(32),
  })
  .strict();

const modelCatalogSnapshotSchema = z
  .object({
    models: z.array(availableModelSchema).max(256),
    selection: modelSelectionSchema,
    legacyMigrationCompleted: z.boolean(),
  })
  .strict();

const startChatGptLoginResultSchema = z
  .object({
    attempt: z
      .object({
        status: z.literal("pending"),
        attemptId: attemptIdSchema,
        expiresAt: finiteNonnegativeInteger,
      })
      .strict(),
    loginUrl: boundedPublicString(8_192).refine(isSafeChatGptLoginUrl),
  })
  .strict();

const confirmedConnectionProofSchema = z
  .object({
    nonce: connectionNonceSchema,
    port: minecraftPortSchema,
    issuedAt: finiteNonnegativeInteger,
    expiresAt: finiteNonnegativeInteger,
  })
  .strict();
const configuredConnectionResultSchema = z
  .object({
    status: z.literal("configured"),
    port: minecraftPortSchema,
    confirmedAt: finiteNonnegativeInteger,
  })
  .strict();

const profileEnvelopeSchema = createDocumentEnvelopeSchema(1, companionProfileSchema);
const worldProfileEnvelopeSchema = createDocumentEnvelopeSchema(1, worldProfileSchema.nullable());
const profileMutationResultSchema = z
  .object({
    envelope: profileEnvelopeSchema,
    liveStatus: z.enum(["applied", "runtime_contained"]),
  })
  .strict();
const memoryScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("global") }).strict(),
  z.object({ mode: z.literal("world"), worldId: safeTokenSchema }).strict(),
  z.object({ mode: z.literal("layered"), worldId: safeTokenSchema }).strict(),
]);
const memoryCategorySchema = z.enum(["preference", "place", "project", "promise", "experience"]);
const memoryImportanceSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
const memoryInputSchema = z.discriminatedUnion("scope", [
  z
    .object({
      category: memoryCategorySchema,
      summary: boundedPublicString(160).min(1),
      importance: memoryImportanceSchema,
      scope: z.literal("global"),
    })
    .strict(),
  z
    .object({
      category: memoryCategorySchema,
      summary: boundedPublicString(160).min(1),
      importance: memoryImportanceSchema,
      scope: z.literal("world"),
    })
    .strict(),
]);
const memoryPatchSchema = z
  .object({
    category: memoryCategorySchema.optional(),
    summary: boundedPublicString(160).min(1).optional(),
    importance: memoryImportanceSchema.optional(),
    scope: z.enum(["global", "world"]).optional(),
  })
  .strict();
const memoryRecordSchema = z
  .object({
    id: z.number().int().positive().safe(),
    category: memoryCategorySchema,
    summary: boundedPublicString(160).min(1),
    importance: memoryImportanceSchema,
    createdAt: z.string().datetime({ offset: false }),
    updatedAt: z.string().datetime({ offset: false }),
    scope: z.enum(["global", "world"]),
    worldId: safeTokenSchema.optional(),
    source: z.enum(["manual", "automatic"]),
    pinned: z.boolean(),
    revision: documentRevisionSchema,
  })
  .strict();
const memoryEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: documentRevisionSchema,
    updatedAt: z.string().datetime({ offset: false }),
    records: z.array(memoryRecordSchema),
    legacyMigrated: z.boolean(),
  })
  .strict();
const memoryMutationResultSchema = z
  .object({ envelope: memoryEnvelopeSchema, record: memoryRecordSchema.optional() })
  .strict();
const storedMemoryScopeSchema = z.enum(["global", "world"]);
const memoryMigrationPreviewResultSchema = z
  .object({
    migrationId: safeTokenSchema,
    sourceRevision: documentRevisionSchema,
    targetScope: storedMemoryScopeSchema,
    deduplicatedCount: finiteNonnegativeInteger,
    movedCount: finiteNonnegativeInteger,
  })
  .strict();
const memoryMigrationMutationResultSchema = z
  .object({
    migrationId: safeTokenSchema,
    status: z.enum(["committed", "rolled_back"]),
  })
  .strict();
const diagnosticLogicalNames = [
  "app-version.json",
  "os-summary.json",
  "dependency-versions.json",
  "minecraft-compatibility.json",
  "app-log.jsonl",
  "audit-log.jsonl",
  "config-schema-summary.json",
] as const;
const diagnosticLogicalNameSchema = z.enum(diagnosticLogicalNames);
const diagnosticOmissions = [
  "minecraft-saves",
  "authentication-data",
  "pcl2-account-data",
  "complete-companion-profile",
  "complete-memories",
  "raw-chat",
] as const;
const diagnosticSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const diagnosticActionCapabilitySchema = z
  .object({
    workspaceVersion: workspaceVersionSchema.nullable(),
    state: z.enum(["starting", "ready", "failed"]),
    mcpListening: z.boolean(),
    discoveredToolCount: finiteNonnegativeInteger,
    errorCode: z.enum(DIAGNOSTIC_ACTION_ERROR_CODES).nullable(),
  })
  .strict();
export const diagnosticPreviewSchema = z
  .object({
    exportId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/u),
    actionCapability: diagnosticActionCapabilitySchema,
    files: z
      .array(
        z
          .object({
            logicalName: diagnosticLogicalNameSchema,
            size: finiteNonnegativeInteger,
            redactions: finiteNonnegativeInteger,
          })
          .strict(),
      )
      .length(diagnosticLogicalNames.length)
      .refine(
        (files) => files.every((file, index) => file.logicalName === diagnosticLogicalNames[index]),
        "diagnostic file whitelist is invalid",
      ),
    omitted: z
      .array(z.enum(diagnosticOmissions))
      .length(diagnosticOmissions.length)
      .refine(
        (omissions) => omissions.every((value, index) => value === diagnosticOmissions[index]),
        "diagnostic omission list is invalid",
      ),
  })
  .strict();
const preparedDiagnosticArchiveSchema = z
  .object({
    exportId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/u),
    size: finiteNonnegativeInteger.max(4 * 1024 * 1024),
    sha256: diagnosticSha256Schema,
  })
  .strict();

export const stopTaskCommandSchema = z.object({ kind: z.literal("stop_task") }).strict();

const desktopCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("get_status") }).strict(),
  z.object({ kind: z.literal("read_owner_identity") }).strict(),
  z
    .object({
      kind: z.literal("update_owner_identity"),
      expectedRevision: documentRevisionSchema,
      ownerUsername: ownerUsernameSchema,
    })
    .strict(),
  z.object({ kind: z.literal("start_runtime") }).strict(),
  z.object({ kind: z.literal("stop_runtime") }).strict(),
  stopTaskCommandSchema,
  z.object({ kind: z.literal("emergency_stop") }).strict(),
  z.object({ kind: z.literal("get_account") }).strict(),
  z.object({ kind: z.literal("start_chatgpt_login") }).strict(),
  z
    .object({
      kind: z.literal("cancel_chatgpt_login"),
      attemptId: attemptIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("read_memories") }).strict(),
  z
    .object({
      kind: z.literal("search_memories"),
      query: boundedPublicString(160),
      scope: memoryScopeSchema,
    })
    .strict(),
  z.object({ kind: z.literal("export_memories") }).strict(),
  z.object({ kind: z.literal("export_redacted_memories") }).strict(),
  z.object({ kind: z.literal("preview_diagnostics") }).strict(),
  z
    .object({
      kind: z.literal("prepare_diagnostic_archive"),
      exportId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal("preview_memory_migration"),
      scope: storedMemoryScopeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("commit_memory_migration"),
      migrationId: safeTokenSchema,
      sourceRevision: documentRevisionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rollback_memory_migration"),
      migrationId: safeTokenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("add_memory"),
      expectedRevision: documentRevisionSchema,
      memory: memoryInputSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_memory"),
      id: z.number().int().positive().safe(),
      expectedRevision: documentRevisionSchema,
      recordRevision: documentRevisionSchema,
      patch: memoryPatchSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("forget_memory"),
      id: z.number().int().positive().safe(),
      expectedRevision: documentRevisionSchema,
      recordRevision: documentRevisionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pin_memory"),
      id: z.number().int().positive().safe(),
      expectedRevision: documentRevisionSchema,
      recordRevision: documentRevisionSchema,
      pinned: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("list_models") }).strict(),
  z
    .object({
      kind: z.literal("migrate_model_preference"),
      candidate: modelSelectionInputSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("select_model"),
      selection: modelSelectionInputSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_confirmed_connection"),
      proof: confirmedConnectionProofSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("invalidate_connection"),
      reason: z.literal("lan_changed"),
    })
    .strict(),
  z.object({ kind: z.literal("read_profile") }).strict(),
  z.object({ kind: z.literal("read_world_profile") }).strict(),
  z
    .object({
      kind: z.literal("bind_confirmed_world"),
      expectedRevision: documentRevisionSchema,
      label: boundedPublicString(160).refine((value) => value.trim().length > 0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_safety_profile"),
      expectedRevision: documentRevisionSchema,
      safetyPreset: safetyPresetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_profile"),
      expectedRevision: documentRevisionSchema,
      profile: companionProfileSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_behavior_mode"),
      expectedRevision: documentRevisionSchema,
      mode: companionModeSchema,
      settings: behaviorModeSettingsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_memory_scope"),
      scope: memoryScopeSchema,
    })
    .strict(),
]);

const desktopRequestSchema = z
  .object({
    version: z.literal(DESKTOP_PROTOCOL_VERSION),
    id: requestIdSchema,
    command: desktopCommandSchema,
  })
  .strict();
const exactDesktopRequestSchema = z.preprocess(preprocessDesktopRequest, desktopRequestSchema);

const desktopCommandResultSchema = z.union([
  runtimeSnapshotSchema,
  ownerIdentitySnapshotSchema,
  accountSnapshotSchema,
  startChatGptLoginResultSchema,
  modelCatalogSnapshotSchema,
  modelSelectionSchema,
  configuredConnectionResultSchema,
  profileEnvelopeSchema,
  worldProfileEnvelopeSchema,
  profileMutationResultSchema,
  memoryEnvelopeSchema,
  redactedMemoryExportSchema,
  memoryMutationResultSchema,
  memoryMigrationPreviewResultSchema,
  memoryMigrationMutationResultSchema,
  diagnosticPreviewSchema,
  preparedDiagnosticArchiveSchema,
]);

const ownerIdentityErrorSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("OWNER_IDENTITY_INVALID"),
      message: z.literal("Owner identity is invalid"),
    })
    .strict(),
  z
    .object({
      code: z.literal("OWNER_IDENTITY_REQUIRED"),
      message: z.literal("Owner identity is required"),
    })
    .strict(),
  z
    .object({
      code: z.literal("OWNER_IDENTITY_CONFIG_CONFLICT"),
      message: z.literal("Owner identity configuration changed"),
    })
    .strict(),
  z
    .object({
      code: z.literal("OWNER_IDENTITY_WRITE_FAILED"),
      message: z.literal("Owner identity update failed"),
    })
    .strict(),
  z
    .object({
      code: z.literal("OWNER_IDENTITY_CONFIG_INVALID"),
      message: z.literal("Owner identity configuration is invalid"),
    })
    .strict(),
]);

const desktopErrorSchema = z.union([
  z
    .object({
      code: z.enum([
        "INVALID_REQUEST",
        "RUNTIME_START_FAILED",
        "MINECRAFT_BRIDGE_REQUIRED",
        "MINECRAFT_BRIDGE_REJECTED",
        "MCP_PORT_UNAVAILABLE",
        "MCP_TOOL_CATALOG_INVALID",
        "MCP_READINESS_TIMEOUT",
        "RUNTIME_STOP_FAILED",
        "EMERGENCY_STOP_FAILED",
        "ACCOUNT_OPERATION_FAILED",
        "MODEL_OPERATION_FAILED",
        "CONNECTION_OPERATION_FAILED",
        "DOCUMENT_CONFLICT",
        "PROFILE_OPERATION_FAILED",
        "INTERNAL_ERROR",
      ]),
      message: boundedPublicString(160).refine((value) => value.length > 0),
    })
    .strict(),
  ownerIdentityErrorSchema,
  z
    .object({
      code: z.literal("PROFILE_RUNTIME_CONTAINMENT_FAILED"),
      message: boundedPublicString(160).refine((value) => value.length > 0),
      committed: profileEnvelopeSchema,
    })
    .strict(),
]);

const desktopResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(DESKTOP_PROTOCOL_VERSION),
      id: requestIdSchema,
      ok: z.literal(true),
      result: desktopCommandResultSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(DESKTOP_PROTOCOL_VERSION),
      id: requestIdSchema,
      ok: z.literal(false),
      error: desktopErrorSchema,
    })
    .strict(),
]);

const connectionInvalidatedEventSchema = z
  .object({
    kind: z.literal("connection_invalidated"),
    revision: runtimeRevisionSchema,
    reason: z.enum([
      "account_lost",
      "model_unavailable",
      "action_unavailable",
      "lan_changed",
      "minecraft_disconnect",
      "world_changed",
      "owner_stop",
      "emergency_stop",
      "runtime_failed",
    ]),
    snapshot: runtimeSnapshotSchema.refine(isAuthorityFreeTerminalRuntimeSnapshot),
  })
  .strict()
  .refine((event) => event.snapshot.revision === event.revision);

export function isAuthorityFreeTerminalRuntimeSnapshot(snapshot: RuntimeSnapshot): boolean {
  return (
    (snapshot.lifecycle === "idle" ||
      snapshot.lifecycle === "stopped" ||
      snapshot.lifecycle === "failed") &&
    snapshot.minecraft.state === "disconnected" &&
    snapshot.minecraft.sessionId === null &&
    (snapshot.codex.state === "stopped" || snapshot.codex.state === "failed") &&
    snapshot.codex.model === null &&
    snapshot.actions === null &&
    snapshot.task === null &&
    snapshot.actionQueue.goal === null
  );
}

const desktopEventPayloadSchema = z.union([
  runtimeEventSchema,
  connectionInvalidatedEventSchema,
  z
    .object({
      kind: z.literal("owner_identity"),
      owner: ownerIdentitySnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("account"),
      account: accountSnapshotSchema,
    })
    .strict(),
]);

const desktopEventSchema = z
  .object({
    version: z.literal(DESKTOP_PROTOCOL_VERSION),
    event: desktopEventPayloadSchema,
  })
  .strict();

export type DesktopCommand = z.infer<typeof desktopCommandSchema>;
export type OwnerIdentityCommand = Extract<
  DesktopCommand,
  { kind: "read_owner_identity" | "update_owner_identity" }
>;
export type DesktopRequest = z.infer<typeof desktopRequestSchema>;
export type DiagnosticPreview = z.infer<typeof diagnosticPreviewSchema>;
export interface StartChatGptLoginResult {
  attempt: Extract<AccountSnapshot, { status: "pending" }>;
  loginUrl: string;
}
export type ConfirmedConnectionProof = z.infer<typeof confirmedConnectionProofSchema>;
export type ConfiguredConnectionResult = z.infer<typeof configuredConnectionResultSchema>;
export interface ProfileMutationResult {
  envelope: DocumentEnvelope<CompanionProfile>;
  liveStatus: "applied" | "runtime_contained";
}
export type DesktopCommandResult<C extends DesktopCommand> = C["kind"] extends
  | "get_status"
  | "start_runtime"
  | "stop_runtime"
  | "stop_task"
  | "emergency_stop"
  | "invalidate_connection"
  ? RuntimeSnapshot
  : C["kind"] extends "read_owner_identity" | "update_owner_identity"
    ? OwnerIdentitySnapshot
    : C["kind"] extends "get_account" | "cancel_chatgpt_login"
      ? AccountSnapshot
      : C["kind"] extends "start_chatgpt_login"
        ? StartChatGptLoginResult
        : C["kind"] extends "list_models" | "migrate_model_preference"
          ? ModelCatalogSnapshot
          : C["kind"] extends "select_model"
            ? ModelSelection
            : C["kind"] extends "set_confirmed_connection"
              ? ConfiguredConnectionResult
              : C["kind"] extends "read_profile"
                ? DocumentEnvelope<CompanionProfile>
                : C["kind"] extends
                      "read_world_profile" | "bind_confirmed_world" | "update_safety_profile"
                  ? DocumentEnvelope<WorldProfile | null>
                  : C["kind"] extends "update_profile" | "set_behavior_mode"
                    ? ProfileMutationResult
                    : C["kind"] extends "set_memory_scope"
                      ? RuntimeSnapshot
                      : C["kind"] extends "export_redacted_memories"
                        ? RedactedMemoryExport
                        : C["kind"] extends "preview_diagnostics"
                          ? DiagnosticPreview
                          : C["kind"] extends "prepare_diagnostic_archive"
                            ? z.infer<typeof preparedDiagnosticArchiveSchema>
                            : C["kind"] extends "preview_memory_migration"
                              ? z.infer<typeof memoryMigrationPreviewResultSchema>
                              : C["kind"] extends
                                    "commit_memory_migration" | "rollback_memory_migration"
                                ? z.infer<typeof memoryMigrationMutationResultSchema>
                                : C["kind"] extends
                                      "read_memories" | "search_memories" | "export_memories"
                                  ? z.infer<typeof memoryEnvelopeSchema>
                                  : C["kind"] extends
                                        | "add_memory"
                                        | "update_memory"
                                        | "forget_memory"
                                        | "pin_memory"
                                    ? z.infer<typeof memoryMutationResultSchema>
                                    : never;
export type DesktopCommandResultValue =
  | RuntimeSnapshot
  | OwnerIdentitySnapshot
  | AccountSnapshot
  | StartChatGptLoginResult
  | ModelCatalogSnapshot
  | ModelSelection
  | ConfiguredConnectionResult
  | DocumentEnvelope<CompanionProfile>
  | DocumentEnvelope<WorldProfile | null>
  | ProfileMutationResult
  | z.infer<typeof memoryEnvelopeSchema>
  | RedactedMemoryExport
  | DiagnosticPreview
  | z.infer<typeof preparedDiagnosticArchiveSchema>
  | z.infer<typeof memoryMutationResultSchema>
  | z.infer<typeof memoryMigrationPreviewResultSchema>
  | z.infer<typeof memoryMigrationMutationResultSchema>;
type OwnerIdentityProtocolError = z.infer<typeof ownerIdentityErrorSchema>;
export type DesktopResponse =
  | {
      version: typeof DESKTOP_PROTOCOL_VERSION;
      id: string;
      ok: true;
      result: DesktopCommandResultValue;
    }
  | {
      version: typeof DESKTOP_PROTOCOL_VERSION;
      id: string;
      ok: false;
      error:
        | {
            code:
              | "INVALID_REQUEST"
              | "RUNTIME_START_FAILED"
              | "MINECRAFT_BRIDGE_REQUIRED"
              | "MINECRAFT_BRIDGE_REJECTED"
              | "MCP_PORT_UNAVAILABLE"
              | "MCP_TOOL_CATALOG_INVALID"
              | "MCP_READINESS_TIMEOUT"
              | "RUNTIME_STOP_FAILED"
              | "EMERGENCY_STOP_FAILED"
              | "ACCOUNT_OPERATION_FAILED"
              | "MODEL_OPERATION_FAILED"
              | "CONNECTION_OPERATION_FAILED"
              | "DOCUMENT_CONFLICT"
              | "PROFILE_OPERATION_FAILED"
              | "INTERNAL_ERROR";
            message: string;
          }
        | OwnerIdentityProtocolError
        | {
            code: "PROFILE_RUNTIME_CONTAINMENT_FAILED";
            message: string;
            committed: DocumentEnvelope<CompanionProfile>;
          };
    };
export type ConnectionInvalidationReason = z.infer<
  typeof connectionInvalidatedEventSchema
>["reason"];
export interface ConnectionInvalidatedEvent {
  kind: "connection_invalidated";
  revision: number;
  reason: ConnectionInvalidationReason;
  snapshot: RuntimeSnapshot;
}
export interface OwnerIdentityEvent {
  readonly kind: "owner_identity";
  readonly owner: OwnerIdentitySnapshot;
}
export interface DesktopEvent {
  version: typeof DESKTOP_PROTOCOL_VERSION;
  event:
    | RuntimeEvent
    | ConnectionInvalidatedEvent
    | OwnerIdentityEvent
    | { kind: "account"; account: AccountSnapshot };
}

export function parseDesktopRequest(value: unknown): DesktopRequest {
  return parseOrThrow(exactDesktopRequestSchema, value, "invalid desktop request");
}

export function parseDesktopResponse(value: unknown): DesktopResponse {
  return parseOrThrow(desktopResponseSchema, value, "invalid desktop response");
}

export function parseDesktopCommandResult<C extends DesktopCommand>(
  command: C,
  value: unknown,
): DesktopCommandResult<C> {
  if (containsAccessor(value)) throw new Error("invalid desktop command result");
  let schema: z.ZodType;
  switch (command.kind) {
    case "get_status":
    case "start_runtime":
    case "stop_runtime":
    case "stop_task":
    case "emergency_stop":
    case "invalidate_connection":
      schema = runtimeSnapshotSchema;
      break;
    case "read_owner_identity":
    case "update_owner_identity":
      schema = ownerIdentitySnapshotSchema;
      break;
    case "get_account":
    case "cancel_chatgpt_login":
      schema = accountSnapshotSchema;
      break;
    case "start_chatgpt_login":
      schema = startChatGptLoginResultSchema;
      break;
    case "list_models":
    case "migrate_model_preference":
      schema = modelCatalogSnapshotSchema;
      break;
    case "select_model":
      schema = modelSelectionSchema;
      break;
    case "set_confirmed_connection":
      schema = configuredConnectionResultSchema;
      break;
    case "read_profile":
      schema = profileEnvelopeSchema;
      break;
    case "read_world_profile":
    case "bind_confirmed_world":
    case "update_safety_profile":
      schema = worldProfileEnvelopeSchema;
      break;
    case "update_profile":
    case "set_behavior_mode":
      schema = profileMutationResultSchema;
      break;
    case "set_memory_scope":
      schema = runtimeSnapshotSchema;
      break;
    case "read_memories":
    case "search_memories":
    case "export_memories":
      schema = memoryEnvelopeSchema;
      break;
    case "export_redacted_memories":
      schema = redactedMemoryExportSchema;
      break;
    case "preview_diagnostics":
      schema = diagnosticPreviewSchema;
      break;
    case "prepare_diagnostic_archive":
      schema = preparedDiagnosticArchiveSchema;
      break;
    case "preview_memory_migration":
      schema = memoryMigrationPreviewResultSchema;
      break;
    case "commit_memory_migration":
    case "rollback_memory_migration":
      schema = memoryMigrationMutationResultSchema;
      break;
    case "add_memory":
    case "update_memory":
    case "forget_memory":
    case "pin_memory":
      schema = memoryMutationResultSchema;
      break;
  }
  return parseOrThrow(schema, value, "invalid desktop command result") as DesktopCommandResult<C>;
}

export function parseDesktopEvent(value: unknown): DesktopEvent {
  if (!hasOwnDataProperties(value, ["version", "event"])) {
    throw new Error("invalid desktop event");
  }
  const event = value.event;
  if (!hasOwnDataProperties(event, ["kind"])) {
    throw new Error("invalid desktop event");
  }
  if (event.kind === "owner_identity" && !hasOwnDataProperties(event, ["kind", "owner"])) {
    throw new Error("invalid desktop event");
  }
  if (containsAccessor(value)) throw new Error("invalid desktop event");
  return parseOrThrow(desktopEventSchema, value, "invalid desktop event");
}

function hasOwnDataProperties(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  try {
    return fields.every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor !== undefined && Object.hasOwn(descriptor, "value");
    });
  } catch {
    return false;
  }
}

function preprocessDesktopRequest(value: unknown): unknown {
  const request = copyOwnEnumerableDataRecord(value);
  if (request === undefined) return undefined;
  const command = copyOwnEnumerableDataRecord(request.command);
  if (command === undefined) return undefined;
  request.command = command;
  return request;
}

function copyOwnEnumerableDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return undefined;
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return undefined;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return undefined;
  }
}

function containsAccessor(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) {
      return true;
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return true;
  }
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) return true;
    if ("value" in descriptor && containsAccessor(descriptor.value, seen)) return true;
  }
  return false;
}

function isSafeChatGptLoginUrl(value: string): boolean {
  try {
    if (value.includes("\\")) return false;
    const authority = /^https:\/\/([^/?#]*)/iu.exec(value)?.[1];
    if (!authority || authority.includes(":") || authority.includes("@")) return false;
    const authorityPrefixLength = value.indexOf(authority) + authority.length;
    const rawPath = value.slice(authorityPrefixLength).split(/[?#]/u, 1)[0]!;
    if (encodedUrlSeparator.test(rawPath)) return false;
    for (const segment of rawPath.split("/")) {
      const decoded = decodeURIComponent(segment);
      if (decoded === "." || decoded === "..") return false;
    }
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.port.length > 0
    ) {
      return false;
    }
    const host = url.hostname.toLowerCase();
    return (
      host === "openai.com" ||
      host.endsWith(".openai.com") ||
      host === "chatgpt.com" ||
      host.endsWith(".chatgpt.com")
    );
  } catch {
    return false;
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(message);
  return parsed.data;
}
