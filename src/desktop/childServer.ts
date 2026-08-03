import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  DESKTOP_PROTOCOL_VERSION,
  MAX_DESKTOP_LINE_BYTES,
  parseDesktopEvent,
  parseDesktopCommandResult,
  parseDesktopRequest,
  parseDesktopResponse,
  type ConnectionInvalidationReason,
  type DesktopEvent,
  type DesktopCommandResultValue,
  type ConfirmedConnectionProof,
  type DesktopRequest,
  type DesktopResponse,
  type ProfileMutationResult,
} from "./desktopProtocol.js";
import { parsePrivateChildRequest, type PrivateWorldBindRequest } from "./privateChildProtocol.js";
import type {
  RuntimeAuthorityLoss,
  RuntimeEvent,
  RuntimeSnapshot,
} from "../runtime/runtimeEvents.js";
import type { TaskStopReason } from "../safety/taskBudget.js";
import type { AccountSnapshot, LoginAttempt } from "../codex/accountService.js";
import type {
  ModelCatalogSnapshot,
  ModelCatalogEvent,
  ModelSelection,
  ModelSelectionInput,
  PreparedModelSelection,
  ResolvedModelSelection,
} from "../codex/modelCatalog.js";
import type { ConfirmedRuntimeConnection } from "../config/schema.js";
import type { BehaviorModeSettings, CompanionProfile } from "../profile/profileSchema.js";
import type {
  MemoryContextScope,
  ScopedMemoryExport,
  ScopedMemoryInput,
  ScopedMemoryMutation,
  ScopedMemoryPatch,
} from "../memory/scopedMemoryStore.js";
import { createRedactedMemoryExport } from "../memory/memoryExport.js";
import type { MemoryMigration, MemoryMigrationPreview } from "../memory/memoryMigration.js";
import { DocumentStoreError, type DocumentEnvelope } from "../storage/documentStore.js";
import {
  fingerprintConfirmedWorld,
  type ConfirmedWorldBinding,
  type WorldProfile,
} from "../world/worldProfileStore.js";
import type { SafetyPreset } from "../safety/safetyProfile.js";
import type { RuntimeSafetyConfiguration } from "../safety/safetyProfile.js";
import type {
  DiagnosticExporter,
  PreparedDiagnosticArchive,
} from "../diagnostics/diagnosticExporter.js";
import type { DiagnosticPreview } from "../diagnostics/diagnosticManifest.js";
import { OwnerIdentityError, type OwnerIdentityAccess } from "../identity/ownerIdentity.js";

export interface DesktopChildRuntime {
  start(): Promise<void>;
  switchModel(
    selection: ResolvedModelSelection,
    commitPreference: () => Promise<void>,
  ): Promise<void>;
  stop(reason: TaskStopReason): Promise<void>;
  stopTask(): Promise<void>;
  snapshot(): RuntimeSnapshot;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  subscribeAuthorityLoss?(listener: (event: RuntimeAuthorityLoss) => void): () => void;
  applyProfile?(profile: CompanionProfile): void | Promise<void>;
  setMemoryScope?(scope: MemoryContextScope): void | Promise<void>;
}

export interface DesktopChildServerOptions {
  runtime?: DesktopChildRuntime;
  ownerIdentity: OwnerIdentityAccess;
  createRuntime: (
    connection: ConfirmedRuntimeConnection,
    initialRevision: number,
    selection: ResolvedModelSelection,
    worldSafety: RuntimeSafetyConfiguration,
  ) => Promise<DesktopChildRuntime>;
  account: DesktopChildAccountService;
  models: DesktopChildModelCatalog;
  profiles?: DesktopChildProfileStore;
  worldProfiles?: DesktopChildWorldProfileStore;
  /** Main-process supplied only; renderer requests never carry world identity or proof. */
  getConfirmedWorldBinding?: () => Promise<ConfirmedWorldBinding>;
  activatePrivateWorldBinding?: (
    binding: ConfirmedWorldBinding,
  ) => Promise<() => void> | (() => void);
  memories?: DesktopChildMemoryStore;
  memoryMigration?: Pick<MemoryMigration, "preview" | "commit" | "rollback" | "release">;
  diagnostics?: DesktopChildDiagnostics;
  createMemoryMigrationId?: () => string;
  memoryMigrationTtlMs?: number;
  input?: Readable;
  output?: Writable;
  now?: () => number;
  confirmedConnection?: ConfirmedRuntimeConnection;
  runtimeRevisionSeed?: number;
  modelValidationIntervalMs?: number;
  modelValidationTimeoutMs?: number;
  setModelValidationTimer?: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  clearModelValidationTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface AcceptedConnectionAuthority {
  readonly connection: ConfirmedRuntimeConnection;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly generation: number;
}

interface RecoveryConnectionAuthority {
  readonly connection: ConfirmedRuntimeConnection;
  readonly explicitModelRecovery: boolean;
}

interface RuntimeReplacementOperation {
  readonly generation: number;
  retirementReason?: TaskStopReason;
  containedSnapshot?: RuntimeSnapshot;
  operation: Promise<void>;
}

interface AuthorityInvalidationPolicy {
  publicReason: ConnectionInvalidationReason;
  preserveWorldBinding: boolean;
  preserveConnectionAuthority: boolean;
  explicitModelRecovery: boolean;
  finalized: boolean;
}

interface AuthorityInvalidationOperation {
  readonly policy: AuthorityInvalidationPolicy;
  readonly operation: Promise<void>;
}

export interface DesktopChildAccountService {
  getAccount(): Promise<AccountSnapshot>;
  startChatGptLogin(): Promise<LoginAttempt>;
  cancelChatGptLogin(attemptId: string): Promise<AccountSnapshot>;
  subscribe(listener: (snapshot: AccountSnapshot) => void): () => void;
  stop(): Promise<void>;
}

export interface DesktopChildModelCatalog {
  listModels(): Promise<ModelCatalogSnapshot>;
  selectModel(selection: ModelSelectionInput): Promise<ModelSelection>;
  prepareSelection(selection: ModelSelectionInput): Promise<PreparedModelSelection>;
  commitSelection(prepared: PreparedModelSelection): Promise<ModelSelection>;
  resolveRuntimeSelection(options?: { signal?: AbortSignal }): Promise<ResolvedModelSelection>;
  subscribe(listener: (event: ModelCatalogEvent) => void): () => void;
  stop(): void;
}

export interface DesktopChildProfileStore {
  read(): Promise<DocumentEnvelope<CompanionProfile>>;
  update(
    expectedRevision: number,
    profile: CompanionProfile,
  ): Promise<DocumentEnvelope<CompanionProfile>>;
  setBehaviorMode(
    expectedRevision: number,
    mode: CompanionProfile["mode"],
    settings: BehaviorModeSettings,
  ): Promise<DocumentEnvelope<CompanionProfile>>;
}

export interface DesktopChildWorldProfileStore {
  read(): Promise<DocumentEnvelope<WorldProfile | null>>;
  bindConfirmedWorld(
    expectedRevision: number,
    binding: ConfirmedWorldBinding,
    label: string,
  ): Promise<DocumentEnvelope<WorldProfile>>;
  updateSafetyProfile(
    expectedRevision: number,
    safetyPreset: SafetyPreset,
  ): Promise<DocumentEnvelope<WorldProfile>>;
}

export interface DesktopChildMemoryStore {
  export(): Promise<ScopedMemoryExport>;
  search(
    query: string,
    scope: MemoryContextScope,
  ): Promise<Awaited<ReturnType<DesktopChildMemoryStore["export"]>>["records"]>;
  searchExport(query: string, scope: MemoryContextScope): Promise<ScopedMemoryExport>;
  addAtRevision(expectedRevision: number, input: ScopedMemoryInput): Promise<ScopedMemoryMutation>;
  updateAtRevision(
    expectedRevision: number,
    id: number,
    recordRevision: number,
    patch: ScopedMemoryPatch,
  ): Promise<ScopedMemoryMutation>;
  forgetAtRevision(
    expectedRevision: number,
    id: number,
    recordRevision: number,
  ): Promise<ScopedMemoryMutation>;
  pinAtRevision(
    expectedRevision: number,
    id: number,
    recordRevision: number,
    pinned: boolean,
  ): Promise<ScopedMemoryMutation>;
}

export interface DesktopChildDiagnostics {
  preview(): Promise<DiagnosticPreview>;
  createArchive(exportId: string): Promise<PreparedDiagnosticArchive>;
  dispose(): Promise<void>;
}

interface PreviewedMemoryMigration {
  readonly id: string;
  readonly preview: MemoryMigrationPreview;
  readonly targetWorldId?: string;
  readonly expiresAt: number;
  readonly status: "previewed";
}

interface CommittedMemoryMigration {
  readonly id: string;
  readonly expiresAt: number;
  readonly status: "committed";
}

interface ConsumedMemoryMigration {
  readonly id: string;
  readonly expiresAt: number;
  readonly status: "rolled_back";
}

type RetainedMemoryMigration =
  PreviewedMemoryMigration | CommittedMemoryMigration | ConsumedMemoryMigration;

type DesktopErrorCode =
  | "INVALID_REQUEST"
  | "RUNTIME_START_FAILED"
  | "RUNTIME_STOP_FAILED"
  | "EMERGENCY_STOP_FAILED"
  | "ACCOUNT_OPERATION_FAILED"
  | "MODEL_OPERATION_FAILED"
  | "CONNECTION_OPERATION_FAILED"
  | "DOCUMENT_CONFLICT"
  | "PROFILE_OPERATION_FAILED"
  | "OWNER_IDENTITY_INVALID"
  | "OWNER_IDENTITY_REQUIRED"
  | "OWNER_IDENTITY_CONFIG_CONFLICT"
  | "OWNER_IDENTITY_WRITE_FAILED"
  | "OWNER_IDENTITY_CONFIG_INVALID"
  | "INTERNAL_ERROR";

class RuntimeReplacementCleanupError extends Error {}
class ConnectionOperationError extends Error {}
class ProfileRuntimeContainmentError extends Error {
  constructor(readonly committed: DocumentEnvelope<CompanionProfile>) {
    super("Profile committed but runtime containment failed");
  }
}

const errorMessages = {
  INVALID_REQUEST: "Invalid desktop request",
  RUNTIME_START_FAILED: "Runtime failed to start",
  RUNTIME_STOP_FAILED: "Runtime failed to stop",
  EMERGENCY_STOP_FAILED: "Emergency stop failed",
  ACCOUNT_OPERATION_FAILED: "Account operation failed",
  MODEL_OPERATION_FAILED: "Model operation failed",
  CONNECTION_OPERATION_FAILED: "Connection operation failed",
  DOCUMENT_CONFLICT: "Profile revision conflict",
  PROFILE_OPERATION_FAILED: "Profile operation failed",
  OWNER_IDENTITY_INVALID: "Owner identity is invalid",
  OWNER_IDENTITY_REQUIRED: "Owner identity is required",
  OWNER_IDENTITY_CONFIG_CONFLICT: "Owner identity configuration changed",
  OWNER_IDENTITY_WRITE_FAILED: "Owner identity update failed",
  OWNER_IDENTITY_CONFIG_INVALID: "Owner identity configuration is invalid",
  INTERNAL_ERROR: "Internal error",
} as const satisfies Record<DesktopErrorCode, string>;
const MODEL_VALIDATION_INTERVAL_MS = 30_000;
const MODEL_VALIDATION_TIMEOUT_MS = 5_000;
const MEMORY_MIGRATION_TTL_MS = 5 * 60_000;

export class DesktopChildServer {
  #runtime: DesktopChildRuntime | undefined;
  readonly #ownerIdentity: OwnerIdentityAccess;
  readonly #createRuntime: (
    connection: ConfirmedRuntimeConnection,
    initialRevision: number,
    selection: ResolvedModelSelection,
    worldSafety: RuntimeSafetyConfiguration,
  ) => Promise<DesktopChildRuntime>;
  #publicRuntimeRevision = 0;
  readonly #account: DesktopChildAccountService;
  readonly #models: DesktopChildModelCatalog;
  readonly #profiles: DesktopChildProfileStore | undefined;
  readonly #worldProfiles: DesktopChildWorldProfileStore | undefined;
  readonly #getConfirmedWorldBinding: (() => Promise<ConfirmedWorldBinding>) | undefined;
  readonly #activatePrivateWorldBinding:
    ((binding: ConfirmedWorldBinding) => Promise<() => void> | (() => void)) | undefined;
  readonly #memories: DesktopChildMemoryStore | undefined;
  readonly #memoryMigration:
    Pick<MemoryMigration, "preview" | "commit" | "rollback" | "release"> | undefined;
  readonly #createMemoryMigrationId: () => string;
  readonly #memoryMigrationTtlMs: number;
  #memoryMigrationCapability: RetainedMemoryMigration | undefined;
  readonly #diagnostics: DesktopChildDiagnostics | undefined;
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #now: () => number;
  readonly #modelValidationIntervalMs: number;
  readonly #modelValidationTimeoutMs: number;
  readonly #setModelValidationTimer: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  readonly #clearModelValidationTimer: (timer: ReturnType<typeof setTimeout>) => void;
  #acceptedConnectionAuthority: AcceptedConnectionAuthority | undefined;
  #activeRuntimeConnection: ConfirmedRuntimeConnection | undefined;
  #recoveryConnectionAuthority: RecoveryConnectionAuthority | undefined;
  #currentConfirmedConnectionProof: ConfirmedConnectionProof | undefined;
  #activeWorldBinding: ConfirmedWorldBinding | undefined;
  #authorityContained = true;
  readonly #usedProofNonces = new Map<string, number>();
  readonly #usedWorldBindingProofNonces = new Map<string, number>();
  #needsFreshRuntime = false;
  #lastSafeRuntimeSnapshot: RuntimeSnapshot | undefined;
  #shutdownRequested = false;
  #interruptGeneration = 0;
  #started = false;
  #stopping: Promise<void> | undefined;
  #replacementOperation: RuntimeReplacementOperation | undefined;
  #authorityInvalidationOperation: AuthorityInvalidationOperation | undefined;
  #runtimeSelection: ResolvedModelSelection | undefined;
  #modelValidationGeneration = 0;
  #modelValidationTimer: ReturnType<typeof setTimeout> | undefined;
  #modelValidationDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  #cancelModelValidation: (() => void) | undefined;
  #modelValidationAbortController: AbortController | undefined;
  readonly #urgentOperations = new Set<Promise<void>>();
  #unsubscribeRuntime: (() => void) | undefined;
  #unsubscribeOwnerIdentity: (() => void) | undefined;
  #unsubscribeAccount: (() => void) | undefined;
  #unsubscribeModelInvalidation: (() => void) | undefined;
  #lineChunks: Buffer[] = [];
  #lineBytes = 0;
  #discardingOversizedLine = false;
  #requestTail: Promise<void> = Promise.resolve();
  #modelSelectionTail: Promise<void> = Promise.resolve();
  #outputTail: Promise<void> = Promise.resolve();

  constructor(options: DesktopChildServerOptions) {
    this.#runtime = options.runtime;
    this.#ownerIdentity = options.ownerIdentity;
    this.#createRuntime = options.createRuntime;
    this.#account = options.account;
    this.#models = options.models;
    this.#profiles = options.profiles;
    this.#worldProfiles = options.worldProfiles;
    this.#getConfirmedWorldBinding = options.getConfirmedWorldBinding;
    this.#activatePrivateWorldBinding = options.activatePrivateWorldBinding;
    this.#memories = options.memories;
    this.#memoryMigration = options.memoryMigration;
    this.#diagnostics = options.diagnostics;
    this.#createMemoryMigrationId = options.createMemoryMigrationId ?? randomUUID;
    this.#memoryMigrationTtlMs = options.memoryMigrationTtlMs ?? MEMORY_MIGRATION_TTL_MS;
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#now = options.now ?? Date.now;
    this.#modelValidationIntervalMs =
      options.modelValidationIntervalMs ?? MODEL_VALIDATION_INTERVAL_MS;
    this.#modelValidationTimeoutMs =
      options.modelValidationTimeoutMs ?? MODEL_VALIDATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#modelValidationIntervalMs) ||
      this.#modelValidationIntervalMs <= 0 ||
      !Number.isSafeInteger(this.#modelValidationTimeoutMs) ||
      this.#modelValidationTimeoutMs <= 0
    ) {
      throw new Error("Model validation schedule is invalid");
    }
    if (!Number.isSafeInteger(this.#memoryMigrationTtlMs) || this.#memoryMigrationTtlMs <= 0) {
      throw new Error("Memory migration lifetime is invalid");
    }
    this.#setModelValidationTimer = options.setModelValidationTimer ?? setTimeout;
    this.#clearModelValidationTimer = options.clearModelValidationTimer ?? clearTimeout;
    const runtimeRevisionSeed = options.runtimeRevisionSeed ?? 0;
    if (!isRuntimeRevision(runtimeRevisionSeed)) {
      throw new Error("Runtime revision seed is invalid");
    }
    this.#publicRuntimeRevision = runtimeRevisionSeed;
    if (options.runtime) {
      this.#authorityContained = false;
      try {
        const revision = options.runtime.snapshot().revision;
        if (isRuntimeRevision(revision) && revision >= runtimeRevisionSeed) {
          this.#publicRuntimeRevision = revision;
        }
      } catch {
        // Status dispatch remains the fail-closed boundary for an unreadable runtime.
      }
    }
    if (options.confirmedConnection) {
      const now = this.#now();
      if (Number.isSafeInteger(now) && now >= 0 && now <= Number.MAX_SAFE_INTEGER - 10_000) {
        this.#acceptedConnectionAuthority = Object.freeze({
          connection: options.confirmedConnection,
          nonce: "trusted_initial_connection",
          issuedAt: now,
          expiresAt: now + 10_000,
          generation: this.#interruptGeneration,
        });
        this.#authorityContained = false;
      }
    }
  }

  start(): void {
    if (this.#started || this.#stopping) return;
    this.#started = true;
    if (this.#runtime) this.#unsubscribeRuntime = this.#subscribeRuntime(this.#runtime);
    this.#unsubscribeOwnerIdentity = this.#ownerIdentity.subscribe((owner) => {
      const envelope: DesktopEvent = {
        version: DESKTOP_PROTOCOL_VERSION,
        event: { kind: "owner_identity", owner },
      };
      try {
        void this.#writeProtocol(parseDesktopEvent(envelope));
      } catch {
        // Owner identity never bypasses the strict desktop event schema.
      }
    });
    this.#unsubscribeAccount = this.#account.subscribe((account) => {
      if (account.status !== "signed_in") {
        void this.#invalidateDesktopAuthority(
          "model_unavailable",
          "account_lost",
          true,
          true,
          true,
        );
      }
      const envelope: DesktopEvent = {
        version: DESKTOP_PROTOCOL_VERSION,
        event: { kind: "account", account },
      };
      try {
        void this.#writeProtocol(parseDesktopEvent(envelope));
      } catch {
        // Account state never bypasses the strict desktop event schema.
      }
    });
    this.#unsubscribeModelInvalidation = this.#models.subscribe((event) => {
      if (event.kind !== "selection_invalidated") return;
      void this.#invalidateDesktopAuthority("model_unavailable", event.reason, true, true, true);
    });
    this.#input.on("data", this.#onData);
    this.#input.once("end", this.#onEnd);
    this.#input.once("error", this.#onInputError);
  }

  #subscribeRuntime(runtime: DesktopChildRuntime): () => void {
    let active = true;
    const unsubscribe = runtime.subscribe((event) => {
      if (!active || runtime !== this.#runtime) return;
      if (
        !isRuntimeRevision(event.revision) ||
        this.#publicRuntimeRevision >= Number.MAX_SAFE_INTEGER ||
        event.revision !== this.#publicRuntimeRevision + 1
      ) {
        void this.#beginRuntimeInvalidation(runtime, "process_exit", true).catch(() => undefined);
        return;
      }
      this.#publicRuntimeRevision = event.revision;
      if (isConnectionInvalidatingRuntimeEvent(event)) {
        this.#beginRuntimeInvalidation(
          runtime,
          event.kind === "minecraft"
            ? event.state.state === "disconnected"
              ? "world_changed"
              : "disconnect"
            : "process_exit",
          true,
          event.kind === "minecraft"
            ? event.state.state === "disconnected"
              ? "world_changed"
              : "minecraft_disconnect"
            : "runtime_failed",
        );
      }
      const envelope: DesktopEvent = {
        version: DESKTOP_PROTOCOL_VERSION,
        event,
      };
      try {
        void this.#writeProtocol(parseDesktopEvent(envelope));
      } catch {
        // RuntimeFacade events must never place malformed data on protocol stdout.
      }
    });
    const unsubscribeAuthorityLoss = runtime.subscribeAuthorityLoss?.((event) => {
      if (!active || runtime !== this.#runtime) return;
      if (event.reason === "model_unavailable") {
        void this.#beginRuntimeInvalidation(
          runtime,
          "model_unavailable",
          true,
          "model_unavailable",
          true,
          true,
          true,
          true,
        ).catch(() => undefined);
      }
    });
    return () => {
      if (!active) return;
      active = false;
      try {
        unsubscribeAuthorityLoss?.();
      } finally {
        unsubscribe();
      }
    };
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#detachInput();
    this.#shutdownRequested = true;
    this.#stopModelValidation();
    this.#interruptGeneration += 1;
    this.#invalidateConnectionAuthority();
    if (this.#replacementOperation && this.#replacementOperation.retirementReason === undefined) {
      this.#replacementOperation.retirementReason = "process_exit";
    }
    this.#stopping = (async (): Promise<void> => {
      await Promise.allSettled([
        this.#requestTail,
        ...this.#urgentOperations,
        ...(this.#authorityInvalidationOperation
          ? [this.#authorityInvalidationOperation.operation]
          : []),
        ...(this.#replacementOperation ? [this.#replacementOperation.operation] : []),
      ]);
      await this.#runtime?.stop("process_exit").catch(() => undefined);
      await this.#authorityInvalidationOperation?.operation.catch(() => undefined);
      this.#releaseMemoryMigrationCapability();
      await this.#diagnostics?.dispose().catch(() => undefined);
      try {
        this.#unsubscribeRuntime?.();
      } catch {
        // Observer teardown cannot block child shutdown.
      }
      this.#unsubscribeRuntime = undefined;
      try {
        this.#unsubscribeOwnerIdentity?.();
      } catch {
        // Owner observer teardown cannot block child shutdown.
      }
      this.#unsubscribeOwnerIdentity = undefined;
      try {
        this.#unsubscribeAccount?.();
      } catch {
        // Observer teardown cannot block child shutdown.
      }
      this.#unsubscribeAccount = undefined;
      try {
        this.#unsubscribeModelInvalidation?.();
      } catch {
        // Model observer teardown cannot block child shutdown.
      }
      this.#unsubscribeModelInvalidation = undefined;
      this.#models.stop();
      await this.#account.stop().catch(() => undefined);
      await this.#outputTail.catch(() => undefined);
    })();
    return this.#stopping;
  }

  readonly #onData = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const segmentEnd = newline < 0 ? bytes.length : newline;

      if (this.#discardingOversizedLine) {
        if (newline >= 0) this.#discardingOversizedLine = false;
      } else {
        const segmentLength = segmentEnd - offset;
        if (segmentLength > MAX_DESKTOP_LINE_BYTES - this.#lineBytes) {
          this.#resetLine();
          this.#discardingOversizedLine = newline < 0;
          this.#queueInvalidRequest("invalid");
        } else {
          if (segmentLength > 0) {
            this.#lineChunks.push(bytes.subarray(offset, segmentEnd));
            this.#lineBytes += segmentLength;
          }
          if (newline >= 0) {
            const line = Buffer.concat(this.#lineChunks, this.#lineBytes);
            this.#resetLine();
            this.#queueLine(stripTrailingCarriageReturn(line));
          }
        }
      }

      offset = newline < 0 ? bytes.length : newline + 1;
    }
  };

  readonly #onEnd = (): void => {
    if (!this.#discardingOversizedLine && this.#lineBytes > 0) {
      const line = Buffer.concat(this.#lineChunks, this.#lineBytes);
      this.#resetLine();
      this.#queueLine(stripTrailingCarriageReturn(line));
    } else {
      this.#resetLine();
    }
    void this.stop();
  };

  readonly #onInputError = (): void => {
    this.#resetLine();
    void this.stop();
  };

  #detachInput(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#input.off("data", this.#onData);
    this.#input.off("end", this.#onEnd);
    this.#input.off("error", this.#onInputError);
  }

  #resetLine(): void {
    this.#lineChunks = [];
    this.#lineBytes = 0;
  }

  #queueLine(line: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(line.toString("utf8"));
    } catch {
      this.#queueInvalidRequest("invalid");
      return;
    }

    if (hasOwn(value, "privateCommand")) {
      let request: PrivateWorldBindRequest;
      try {
        request = parsePrivateChildRequest(value);
      } catch {
        this.#queueInvalidRequest(extractRequestId(value));
        return;
      }
      const interruptGeneration = this.#interruptGeneration;
      const precedingEmergencies =
        this.#urgentOperations.size === 0
          ? undefined
          : Promise.allSettled([...this.#urgentOperations]).then(() => undefined);
      this.#requestTail = this.#requestTail
        .catch(() => undefined)
        .then(() =>
          this.#dispatchPrivateWorldBind(request, interruptGeneration, precedingEmergencies),
        );
      return;
    }

    let request: DesktopRequest;
    try {
      request = parseDesktopRequest(value);
    } catch {
      this.#queueInvalidRequest(extractRequestId(value));
      return;
    }

    if (request.command.kind === "emergency_stop") {
      this.#queueEmergency(request);
      return;
    }
    if (request.command.kind === "stop_task") {
      this.#queueTaskControl(request);
      return;
    }
    if (
      request.command.kind === "stop_runtime" ||
      request.command.kind === "invalidate_connection"
    ) {
      this.#queueAuthorityControl(request);
      return;
    }
    const interruptGeneration = this.#interruptGeneration;
    const precedingEmergencies =
      this.#urgentOperations.size === 0
        ? undefined
        : Promise.allSettled([...this.#urgentOperations]).then(() => undefined);
    this.#requestTail = this.#requestTail
      .catch(() => undefined)
      .then(() => this.#dispatchOrdinary(request, interruptGeneration, precedingEmergencies));
  }

  #queueInvalidRequest(id: string): void {
    this.#requestTail = this.#requestTail
      .catch(() => undefined)
      .then(() => this.#writeError(id, "INVALID_REQUEST"));
  }

  #queueEmergency(request: DesktopRequest): void {
    const operation = this.#dispatchEmergency(request);
    this.#trackUrgentOperation(operation);
  }

  #queueAuthorityControl(request: DesktopRequest): void {
    if (
      request.command.kind !== "stop_runtime" &&
      request.command.kind !== "invalidate_connection"
    ) {
      throw new Error("Invalid authority control request");
    }
    const invalidation = this.#beginAuthorityInvalidation(
      request.command.kind === "stop_runtime" ? "owner_stop" : "disconnect",
      request.command.kind === "stop_runtime" ? "owner_stop" : "lan_changed",
    );
    const operation = this.#dispatchAuthorityControl(request, invalidation);
    this.#trackUrgentOperation(operation);
  }

  #queueTaskControl(request: DesktopRequest): void {
    if (request.command.kind !== "stop_task") {
      throw new Error("Invalid task control request");
    }
    const operation = this.#dispatchTaskControl(request);
    this.#trackUrgentOperation(operation);
  }

  #trackUrgentOperation(operation: Promise<void>): void {
    this.#urgentOperations.add(operation);
    void operation
      .finally(() => {
        this.#urgentOperations.delete(operation);
      })
      .catch(() => undefined);
  }

  async #dispatchOrdinary(
    request: DesktopRequest,
    interruptGeneration: number,
    precedingEmergencies: Promise<void> | undefined,
  ): Promise<void> {
    let terminalResponseCommitted = false;
    try {
      switch (request.command.kind) {
        case "read_owner_identity":
          await this.#writeCommandResult(request, this.#ownerIdentity.snapshot());
          return;
        case "update_owner_identity":
          await this.#writeCommandResult(
            request,
            await this.#ownerIdentity.update({
              expectedRevision: request.command.expectedRevision,
              ownerUsername: request.command.ownerUsername,
            }),
          );
          return;
        case "get_status":
          break;
        case "start_runtime": {
          if (!this.#ownerIdentity.snapshot().configured) {
            throw new OwnerIdentityError("OWNER_IDENTITY_REQUIRED");
          }
          await precedingEmergencies;
          try {
            await this.#authorityInvalidationOperation?.operation;
          } catch {
            throw new ConnectionOperationError("Runtime containment failed");
          }
          if (this.#shutdownRequested || interruptGeneration !== this.#interruptGeneration) {
            throw new Error("Runtime start was interrupted");
          }
          const current = this.#runtime;
          const alreadyRunning =
            current !== undefined &&
            !this.#needsFreshRuntime &&
            current.snapshot().lifecycle === "running";
          let selection = this.#runtimeSelection;
          if (!alreadyRunning) {
            selection = await this.#models.resolveRuntimeSelection();
            const connection = this.#consumeConnectionAuthority(interruptGeneration);
            if (!this.#runtime || this.#needsFreshRuntime) {
              await this.#replaceRuntime(
                interruptGeneration,
                connection,
                selection,
                await this.#worldSafetyConfiguration(),
              );
            }
          }
          if (!selection) throw new Error("Runtime model selection is unavailable");
          const runtime = this.#requireRuntime();
          await runtime.start();
          if (
            this.#shutdownRequested ||
            interruptGeneration !== this.#interruptGeneration ||
            runtime.snapshot().lifecycle !== "running"
          ) {
            throw new Error("Runtime start was interrupted");
          }
          this.#runtimeSelection = selection;
          this.#startModelValidation(runtime, selection);
          break;
        }
        case "stop_runtime":
          throw new Error("Stop requests use the urgent dispatch path");
        case "stop_task":
          throw new Error("Task stop requests use the urgent dispatch path");
        case "emergency_stop":
          throw new Error("Emergency requests use the urgent dispatch path");
        case "get_account":
          await this.#writeCommandResult(request, await this.#account.getAccount());
          return;
        case "start_chatgpt_login": {
          const attempt = await this.#account.startChatGptLogin();
          await this.#writeCommandResult(request, {
            attempt: {
              status: "pending",
              attemptId: attempt.attemptId,
              expiresAt: attempt.expiresAt,
            },
            loginUrl: attempt.loginUrl,
          });
          return;
        }
        case "cancel_chatgpt_login":
          await this.#writeCommandResult(
            request,
            await this.#account.cancelChatGptLogin(request.command.attemptId),
          );
          return;
        case "list_models":
          await this.#writeCommandResult(request, await this.#models.listModels());
          return;
        case "select_model":
          await this.#writeCommandResult(
            request,
            await this.#selectModel(request.command.selection, interruptGeneration),
          );
          return;
        case "read_profile":
          await this.#writeCommandResult(request, await this.#requireProfiles().read());
          return;
        case "read_world_profile":
          await this.#writeCommandResult(request, await this.#requireWorldProfiles().read());
          return;
        case "bind_confirmed_world": {
          const worlds = this.#requireWorldProfiles();
          const before = await worlds.read();
          this.#assertWorldRevision(before.revision, request.command.expectedRevision);
          const binding = await this.#requireConfirmedWorldBinding();
          this.#assertPrivateBindingAuthority(interruptGeneration, binding);
          await this.#beginAuthorityInvalidation(
            "world_changed",
            "world_changed",
            true,
            true,
            true,
          );
          this.#assertPrivateBindingAuthority(interruptGeneration + 1, binding);
          const result = await worlds.bindConfirmedWorld(
            request.command.expectedRevision,
            binding,
            request.command.label,
          );
          this.#assertPrivateBindingAuthority(interruptGeneration + 1, binding);
          this.#activeWorldBinding = binding;
          await this.#writeCommandResult(request, result, () => {
            terminalResponseCommitted = true;
          });
          return;
        }
        case "update_safety_profile": {
          const worlds = this.#requireWorldProfiles();
          const before = await worlds.read();
          this.#assertWorldRevision(before.revision, request.command.expectedRevision);
          if (!before.value) throw new Error("world profile is not bound");
          await this.#beginAuthorityInvalidation(
            "world_changed",
            "world_changed",
            true,
            true,
            true,
          );
          this.#assertActiveWorldBindingAuthority(interruptGeneration + 1);
          const result = await worlds.updateSafetyProfile(
            request.command.expectedRevision,
            request.command.safetyPreset,
          );
          this.#assertActiveWorldBindingAuthority(interruptGeneration + 1);
          await this.#writeCommandResult(request, result, () => {
            terminalResponseCommitted = true;
          });
          return;
        }
        case "update_profile": {
          const envelope = await this.#requireProfiles().update(
            request.command.expectedRevision,
            request.command.profile,
          );
          await this.#writeCommandResult(request, await this.#applyCommittedProfile(envelope));
          return;
        }
        case "set_behavior_mode": {
          const envelope = await this.#requireProfiles().setBehaviorMode(
            request.command.expectedRevision,
            request.command.mode,
            request.command.settings,
          );
          await this.#writeCommandResult(request, await this.#applyCommittedProfile(envelope));
          return;
        }
        case "set_memory_scope": {
          const runtime = this.#requireRuntime();
          if (!runtime.setMemoryScope) throw new Error("Runtime memory scope is unavailable");
          await runtime.setMemoryScope(request.command.scope);
          await this.#writeCommandResult(request, this.#snapshot());
          return;
        }
        case "read_memories":
        case "export_memories":
          await this.#writeCommandResult(request, await this.#requireMemories().export());
          return;
        case "export_redacted_memories":
          await this.#writeCommandResult(
            request,
            createRedactedMemoryExport(await this.#requireMemories().export()),
          );
          return;
        case "preview_diagnostics":
          await this.#writeCommandResult(request, await this.#requireDiagnostics().preview());
          return;
        case "prepare_diagnostic_archive": {
          const prepared = await this.#requireDiagnostics().createArchive(request.command.exportId);
          await this.#writeCommandResult(request, {
            exportId: prepared.exportId,
            size: prepared.size,
            sha256: prepared.sha256,
          });
          return;
        }
        case "preview_memory_migration": {
          const migrationId = this.#createMemoryMigrationId();
          const current = this.#activeMemoryMigration();
          if (current?.id === migrationId) {
            throw new Error("Memory migration id collision");
          }
          this.#releaseMemoryMigrationCapability();
          const world =
            request.command.scope === "world"
              ? (await this.#requireWorldProfiles().read()).value
              : undefined;
          if (request.command.scope === "world" && world === null) {
            throw new Error("Authoritative world profile is unavailable");
          }
          const preview = await this.#requireMemoryMigration().preview({
            id: migrationId,
            scope: request.command.scope,
            ...(world === undefined || world === null ? {} : { worldId: world.id }),
          });
          this.#memoryMigrationCapability = {
            id: migrationId,
            preview: structuredClone(preview),
            ...(world === undefined || world === null ? {} : { targetWorldId: world.id }),
            status: "previewed",
            expiresAt: this.#newMemoryMigrationExpiry(),
          };
          await this.#writeCommandResult(request, {
            migrationId,
            sourceRevision: preview.sourceRevision,
            targetScope: request.command.scope,
            deduplicatedCount: preview.deduplicatedCount,
            movedCount: preview.movedCount,
          });
          return;
        }
        case "commit_memory_migration": {
          const retained = this.#activeMemoryMigration();
          if (
            !retained ||
            retained.status !== "previewed" ||
            retained.id !== request.command.migrationId ||
            retained.preview.sourceRevision !== request.command.sourceRevision
          ) {
            throw new DocumentStoreError("DOCUMENT_CONFLICT", "memory migration preview is stale");
          }
          if (
            retained.targetWorldId !== undefined &&
            (await this.#requireWorldProfiles().read()).value?.id !== retained.targetWorldId
          ) {
            this.#releaseMemoryMigrationCapability();
            throw new DocumentStoreError(
              "DOCUMENT_CONFLICT",
              "memory migration world authority changed",
            );
          }
          await this.#requireMemoryMigration().commit(structuredClone(retained.preview));
          this.#memoryMigrationCapability = {
            id: retained.id,
            status: "committed",
            expiresAt: this.#newMemoryMigrationExpiry(),
          };
          await this.#writeCommandResult(request, {
            migrationId: request.command.migrationId,
            status: "committed",
          });
          return;
        }
        case "rollback_memory_migration": {
          const retained = this.#activeMemoryMigration();
          if (
            !retained ||
            retained.status !== "committed" ||
            retained.id !== request.command.migrationId
          ) {
            throw new DocumentStoreError(
              "DOCUMENT_CONFLICT",
              "memory migration snapshot is unavailable",
            );
          }
          await this.#requireMemoryMigration().rollback(request.command.migrationId);
          this.#requireMemoryMigration().release(request.command.migrationId);
          this.#memoryMigrationCapability = {
            id: request.command.migrationId,
            status: "rolled_back",
            expiresAt: this.#newMemoryMigrationExpiry(),
          };
          await this.#writeCommandResult(request, {
            migrationId: request.command.migrationId,
            status: "rolled_back",
          });
          return;
        }
        case "search_memories": {
          await this.#writeCommandResult(
            request,
            await this.#requireMemories().searchExport(
              request.command.query,
              request.command.scope,
            ),
          );
          return;
        }
        case "add_memory":
          await this.#writeCommandResult(
            request,
            await this.#requireMemories().addAtRevision(
              request.command.expectedRevision,
              await this.#resolveMemoryInput(request.command.memory),
            ),
          );
          return;
        case "update_memory":
          await this.#writeCommandResult(
            request,
            await this.#requireMemories().updateAtRevision(
              request.command.expectedRevision,
              request.command.id,
              request.command.recordRevision,
              await this.#resolveMemoryPatch(request.command.patch),
            ),
          );
          return;
        case "forget_memory":
          await this.#writeCommandResult(
            request,
            await this.#requireMemories().forgetAtRevision(
              request.command.expectedRevision,
              request.command.id,
              request.command.recordRevision,
            ),
          );
          return;
        case "pin_memory":
          await this.#writeCommandResult(
            request,
            await this.#requireMemories().pinAtRevision(
              request.command.expectedRevision,
              request.command.id,
              request.command.recordRevision,
              request.command.pinned,
            ),
          );
          return;
        case "set_confirmed_connection": {
          await precedingEmergencies;
          await this.#authorityInvalidationOperation?.operation;
          this.#assertConnectionGeneration(interruptGeneration);
          const current = this.#runtime;
          let lifecycle = current?.snapshot().lifecycle;
          if (current && lifecycle === "failed") {
            await this.#beginRuntimeInvalidation(current, "process_exit", false);
            this.#assertConnectionGeneration(interruptGeneration);
            lifecycle = this.#runtime?.snapshot().lifecycle;
          }
          if (lifecycle !== undefined && lifecycle !== "idle" && lifecycle !== "stopped") {
            throw new ConnectionOperationError("runtime must stop before connection changes");
          }
          const authority = this.#acceptConnectionProof(request.command.proof, interruptGeneration);
          this.#assertConnectionGeneration(interruptGeneration);
          if (
            !this.#currentConfirmedConnectionProof ||
            !sameConfirmedProof(this.#currentConfirmedConnectionProof, request.command.proof)
          ) {
            this.#activeWorldBinding = undefined;
          }
          this.#currentConfirmedConnectionProof = Object.freeze(
            structuredClone(request.command.proof),
          );
          this.#activeRuntimeConnection = undefined;
          this.#recoveryConnectionAuthority = undefined;
          this.#acceptedConnectionAuthority = authority;
          this.#authorityContained = false;
          this.#needsFreshRuntime = true;
          await this.#writeCommandResult(request, {
            status: "configured",
            port: authority.connection.port,
            confirmedAt: authority.issuedAt,
          });
          return;
        }
        case "invalidate_connection":
          throw new Error("Connection invalidation requests use the urgent dispatch path");
      }
      await this.#writeCommandResult(request, this.#snapshot());
    } catch (error) {
      if (terminalResponseCommitted) return;
      if (error instanceof ProfileRuntimeContainmentError) {
        await this.#writeProfileRuntimeContainmentError(request.id, error.committed);
        return;
      }
      if (
        (request.command.kind === "start_runtime" || request.command.kind === "stop_runtime") &&
        !(error instanceof OwnerIdentityError)
      ) {
        this.#needsFreshRuntime = true;
        const preserveModelRecovery =
          request.command.kind === "start_runtime" &&
          this.#currentConfirmedConnectionProof !== undefined &&
          this.#recoveryConnectionAuthority?.explicitModelRecovery === true;
        this.#invalidateConnectionAuthority(
          preserveModelRecovery,
          preserveModelRecovery,
          preserveModelRecovery,
        );
      }
      await this.#writeError(
        request.id,
        error instanceof OwnerIdentityError
          ? error.code
          : request.command.kind === "select_model"
            ? "MODEL_OPERATION_FAILED"
            : error instanceof DocumentStoreError && error.code === "DOCUMENT_CONFLICT"
              ? "DOCUMENT_CONFLICT"
              : error instanceof ConnectionOperationError
                ? "CONNECTION_OPERATION_FAILED"
                : errorCodeFor(request.command.kind),
      );
    }
  }

  async #dispatchPrivateWorldBind(
    request: PrivateWorldBindRequest,
    interruptGeneration: number,
    precedingEmergencies: Promise<void> | undefined,
  ): Promise<void> {
    let terminalResponseCommitted = false;
    try {
      const binding = request.privateCommand.binding;
      await precedingEmergencies;
      this.#assertConnectionGeneration(interruptGeneration);
      this.#consumePrivateWorldBindingProof(binding);
      this.#assertPrivateBindingMatchesCurrentConnection(binding);
      const worlds = this.#requireWorldProfiles();
      const before = await worlds.read();
      this.#assertPrivateBindingAuthority(interruptGeneration, binding);
      this.#assertWorldRevision(before.revision, request.privateCommand.expectedRevision);
      this.#activeWorldBinding = undefined;
      await this.#beginAuthorityInvalidation("world_changed", "world_changed", true, true, true);
      this.#assertPrivateBindingAuthority(interruptGeneration + 1, binding);
      const release = await this.#activatePrivateWorldBinding?.(binding);
      try {
        this.#assertPrivateBindingAuthority(interruptGeneration + 1, binding);
        const result = await worlds.bindConfirmedWorld(
          request.privateCommand.expectedRevision,
          binding,
          request.privateCommand.label,
        );
        this.#assertPrivateBindingAuthority(interruptGeneration + 1, binding);
        this.#activeWorldBinding = Object.freeze(structuredClone(binding));
        await this.#writePrivateWorldBindResult(request, result, () => {
          terminalResponseCommitted = true;
        });
      } finally {
        release?.();
      }
    } catch (error) {
      if (terminalResponseCommitted) return;
      await this.#writeError(
        request.id,
        error instanceof DocumentStoreError && error.code === "DOCUMENT_CONFLICT"
          ? "DOCUMENT_CONFLICT"
          : error instanceof ConnectionOperationError
            ? "CONNECTION_OPERATION_FAILED"
            : "PROFILE_OPERATION_FAILED",
      );
    }
  }

  async #dispatchEmergency(request: DesktopRequest): Promise<void> {
    const invalidation = this.#beginAuthorityInvalidation("emergency_stop", "emergency_stop");
    try {
      await invalidation;
      await this.#writeResponse({
        version: DESKTOP_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        result: this.#snapshot(),
      });
    } catch {
      await this.#writeError(request.id, "EMERGENCY_STOP_FAILED");
    }
  }

  async #dispatchTaskControl(request: DesktopRequest): Promise<void> {
    if (request.command.kind !== "stop_task") {
      throw new Error("Invalid task control request");
    }
    try {
      const runtime = this.#runtime;
      const before = this.#snapshot();
      if (runtime === undefined || before.task === null) {
        await this.#writeCommandResult(request, before);
        return;
      }
      if (typeof runtime.stopTask !== "function") {
        throw new Error("Runtime task-only stop is unavailable");
      }
      await runtime.stopTask();
      const after = this.#snapshot();
      if (after.task !== null) throw new Error("Runtime task-only stop did not revoke the task");
      await this.#writeCommandResult(request, after);
    } catch {
      await this.#writeError(request.id, "RUNTIME_STOP_FAILED");
    }
  }

  #selectModel(
    selection: ModelSelectionInput,
    replacementGeneration: number,
  ): Promise<ModelSelection> {
    const operation = this.#modelSelectionTail
      .catch(() => undefined)
      .then(() => this.#performModelSelection(selection, replacementGeneration));
    this.#modelSelectionTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #performModelSelection(
    selection: ModelSelectionInput,
    replacementGeneration: number,
  ): Promise<ModelSelection> {
    this.#assertModelSelectionGeneration(replacementGeneration);
    const prepared = await this.#models.prepareSelection(selection);
    this.#assertModelSelectionGeneration(replacementGeneration);
    const runtime = this.#runtime;
    const lifecycle = runtime?.snapshot().lifecycle;
    if (runtime && !this.#needsFreshRuntime && lifecycle === "running") {
      let committed: ModelSelection | undefined;
      await runtime.switchModel(prepared.resolved, async () => {
        if (committed !== undefined) throw new Error("Model preference was already committed");
        committed = await this.#models.commitSelection(prepared);
      });
      this.#assertModelSelectionGeneration(replacementGeneration, runtime);
      const snapshot = runtime.snapshot();
      if (
        snapshot.lifecycle !== "running" ||
        snapshot.codex.state !== "ready" ||
        snapshot.codex.model !== prepared.resolved.modelId ||
        committed === undefined
      ) {
        throw new Error("Runtime model switch did not publish the prepared selection");
      }
      this.#runtimeSelection = prepared.resolved;
      this.#startModelValidation(runtime, prepared.resolved);
      return committed;
    }
    if (runtime && lifecycle !== "idle" && lifecycle !== "stopped" && lifecycle !== "failed") {
      throw new Error("Runtime model switching is unavailable");
    }
    const committed = await this.#models.commitSelection(prepared);
    this.#assertModelSelectionGeneration(replacementGeneration);
    this.#runtimeSelection = prepared.resolved;
    return committed;
  }

  #assertModelSelectionGeneration(
    replacementGeneration: number,
    runtime?: DesktopChildRuntime,
  ): void {
    if (
      this.#shutdownRequested ||
      replacementGeneration !== this.#interruptGeneration ||
      (runtime !== undefined && runtime !== this.#runtime)
    ) {
      throw new Error("Model selection was interrupted");
    }
  }

  async #dispatchAuthorityControl(
    request: DesktopRequest,
    invalidation: Promise<void>,
  ): Promise<void> {
    if (
      request.command.kind !== "stop_runtime" &&
      request.command.kind !== "invalidate_connection"
    ) {
      throw new Error("Invalid authority control request");
    }
    try {
      await invalidation;
      await this.#writeCommandResult(request, this.#snapshot());
    } catch {
      await this.#writeError(request.id, errorCodeFor(request.command.kind));
    }
  }

  #beginRuntimeInvalidation(
    runtime: DesktopChildRuntime,
    reason: Exclude<TaskStopReason, "owner_changed" | "model_changed">,
    _interrupt: boolean,
    publicReason: ConnectionInvalidationReason = connectionInvalidationReason(reason),
    synchronousRuntimeStop = false,
    preserveWorldBinding = false,
    preserveConnectionAuthority = false,
    explicitModelRecovery = false,
  ): Promise<void> {
    if (runtime !== this.#runtime) return Promise.resolve();
    return this.#beginAuthorityInvalidation(
      reason,
      publicReason,
      synchronousRuntimeStop,
      preserveWorldBinding,
      preserveConnectionAuthority,
      explicitModelRecovery,
    );
  }

  #beginAuthorityInvalidation(
    reason: TaskStopReason,
    publicReason: ConnectionInvalidationReason,
    synchronousRuntimeStop = true,
    preserveWorldBinding = false,
    preserveConnectionAuthority = false,
    explicitModelRecovery = false,
  ): Promise<void> {
    const existing = this.#authorityInvalidationOperation;
    if (existing) {
      const policy = existing.policy;
      const tightenedWorldBinding = policy.preserveWorldBinding && preserveWorldBinding;
      const tightenedConnectionAuthority =
        policy.preserveConnectionAuthority && preserveConnectionAuthority;
      const upgradedExplicitModelRecovery =
        tightenedConnectionAuthority && explicitModelRecovery && !policy.explicitModelRecovery;
      if (
        tightenedWorldBinding !== policy.preserveWorldBinding ||
        tightenedConnectionAuthority !== policy.preserveConnectionAuthority ||
        upgradedExplicitModelRecovery
      ) {
        if (
          tightenedWorldBinding !== policy.preserveWorldBinding ||
          tightenedConnectionAuthority !== policy.preserveConnectionAuthority
        ) {
          this.#interruptGeneration += 1;
        }
        const effectiveExplicitModelRecovery =
          tightenedConnectionAuthority && (policy.explicitModelRecovery || explicitModelRecovery);
        this.#invalidateConnectionAuthority(
          tightenedWorldBinding,
          tightenedConnectionAuthority,
          effectiveExplicitModelRecovery,
        );
        this.#rebasePreservedConnectionAuthority(tightenedConnectionAuthority);
        if (policy.finalized) {
          const followUpPolicy: AuthorityInvalidationPolicy = {
            publicReason,
            preserveWorldBinding: tightenedWorldBinding,
            preserveConnectionAuthority: tightenedConnectionAuthority,
            explicitModelRecovery: effectiveExplicitModelRecovery,
            finalized: false,
          };
          const followUp = existing.operation.then(async () => {
            followUpPolicy.finalized = true;
            this.#invalidateConnectionAuthority(
              followUpPolicy.preserveWorldBinding,
              followUpPolicy.preserveConnectionAuthority,
              followUpPolicy.explicitModelRecovery,
            );
            this.#rebasePreservedConnectionAuthority(followUpPolicy.preserveConnectionAuthority);
            await this.#publishConnectionInvalidated(followUpPolicy.publicReason);
            this.#authorityContained = true;
          });
          return this.#trackAuthorityInvalidationOperation(followUpPolicy, followUp);
        }
        if (policy.publicReason !== "model_unavailable" && policy.publicReason !== "account_lost") {
          policy.publicReason = publicReason;
        }
        policy.preserveWorldBinding = tightenedWorldBinding;
        policy.preserveConnectionAuthority = tightenedConnectionAuthority;
        policy.explicitModelRecovery = effectiveExplicitModelRecovery;
      }
      return existing.operation;
    }
    const policy: AuthorityInvalidationPolicy = {
      publicReason,
      preserveWorldBinding,
      preserveConnectionAuthority,
      explicitModelRecovery: preserveConnectionAuthority && explicitModelRecovery,
      finalized: false,
    };
    const runtime = this.#runtime;
    const replacement = this.#replacementOperation;
    if (
      this.#authorityContained &&
      !runtime &&
      !replacement &&
      !this.#acceptedConnectionAuthority
    ) {
      this.#needsFreshRuntime = true;
      this.#stopModelValidation();
      this.#interruptGeneration += 1;
      this.#invalidateConnectionAuthority(
        policy.preserveWorldBinding,
        policy.preserveConnectionAuthority,
        policy.explicitModelRecovery,
      );
      this.#rebasePreservedConnectionAuthority(policy.preserveConnectionAuthority);
      return Promise.resolve();
    }
    this.#needsFreshRuntime = true;
    this.#stopModelValidation();
    this.#interruptGeneration += 1;
    this.#invalidateConnectionAuthority(
      policy.preserveWorldBinding,
      policy.preserveConnectionAuthority,
      policy.explicitModelRecovery,
    );
    this.#rebasePreservedConnectionAuthority(policy.preserveConnectionAuthority);
    if (replacement && replacement.retirementReason === undefined) {
      replacement.retirementReason = reason;
    }
    if (runtime) {
      try {
        this.#unsubscribeRuntime?.();
      } catch {
        // Runtime retirement still proceeds when observer teardown fails.
      }
      this.#unsubscribeRuntime = undefined;
    }
    let runtimeStop: Promise<void> | undefined;
    if (runtime) {
      runtimeStop = synchronousRuntimeStop
        ? callRuntimeStop(runtime, reason)
        : Promise.resolve().then(() => runtime.stop(reason));
    }
    const operation = (async (): Promise<void> => {
      let safeSnapshot: RuntimeSnapshot | undefined;
      if (runtime) {
        await runtimeStop;
        safeSnapshot = this.#readContainedSnapshot(runtime);
        if (this.#runtime === runtime) this.#runtime = undefined;
      }
      if (replacement) {
        try {
          await replacement.operation;
        } catch (error) {
          if (error instanceof RuntimeReplacementCleanupError) throw error;
        }
        safeSnapshot ??= replacement.containedSnapshot;
      }
      policy.finalized = true;
      this.#invalidateConnectionAuthority(
        policy.preserveWorldBinding,
        policy.preserveConnectionAuthority,
        policy.explicitModelRecovery,
      );
      this.#rebasePreservedConnectionAuthority(policy.preserveConnectionAuthority);
      await this.#publishConnectionInvalidated(policy.publicReason, safeSnapshot);
      this.#authorityContained = true;
    })();
    return this.#trackAuthorityInvalidationOperation(policy, operation);
  }

  #trackAuthorityInvalidationOperation(
    policy: AuthorityInvalidationPolicy,
    operation: Promise<void>,
  ): Promise<void> {
    const authorityOperation: AuthorityInvalidationOperation = {
      policy,
      operation,
    };
    this.#authorityInvalidationOperation = authorityOperation;
    void operation.then(
      () => {
        if (this.#authorityInvalidationOperation === authorityOperation) {
          this.#authorityInvalidationOperation = undefined;
        }
      },
      () => {
        // Failed containment remains authoritative until the main process kills the child.
      },
    );
    return operation;
  }

  #invalidateDesktopAuthority(
    reason: Exclude<TaskStopReason, "owner_changed" | "model_changed">,
    publicReason: ConnectionInvalidationReason = connectionInvalidationReason(reason),
    preserveWorldBinding = false,
    preserveConnectionAuthority = false,
    explicitModelRecovery = false,
  ): Promise<void> {
    return this.#beginAuthorityInvalidation(
      reason,
      publicReason,
      true,
      preserveWorldBinding,
      preserveConnectionAuthority,
      explicitModelRecovery,
    );
  }

  #readContainedSnapshot(runtime: DesktopChildRuntime): RuntimeSnapshot {
    const snapshot = runtime.snapshot();
    if (
      (snapshot.lifecycle !== "idle" &&
        snapshot.lifecycle !== "stopped" &&
        snapshot.lifecycle !== "failed") ||
      snapshot.minecraft.state !== "disconnected" ||
      snapshot.minecraft.sessionId !== null ||
      (snapshot.codex.state !== "stopped" && snapshot.codex.state !== "failed") ||
      snapshot.codex.model !== null ||
      snapshot.task !== null
    ) {
      throw new Error("Runtime invalidation cleanup did not reach a safe state");
    }
    if (!isRuntimeRevision(snapshot.revision) || snapshot.revision < this.#publicRuntimeRevision) {
      throw new Error("Runtime invalidation revision regressed");
    }
    return snapshot;
  }

  #startModelValidation(runtime: DesktopChildRuntime, selection: ResolvedModelSelection): void {
    this.#stopModelValidation();
    this.#runtimeSelection = selection;
    const generation = this.#modelValidationGeneration;
    const schedule = (): void => {
      if (
        this.#shutdownRequested ||
        generation !== this.#modelValidationGeneration ||
        runtime !== this.#runtime
      ) {
        return;
      }
      this.#modelValidationTimer = this.#setModelValidationTimer(() => {
        this.#modelValidationTimer = undefined;
        void this.#validateConnectedModel(runtime, selection, generation, schedule);
      }, this.#modelValidationIntervalMs);
      this.#modelValidationTimer.unref?.();
    };
    schedule();
  }

  async #validateConnectedModel(
    runtime: DesktopChildRuntime,
    selection: ResolvedModelSelection,
    generation: number,
    scheduleNext: () => void,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelValidation!: () => void;
    const abortController = new AbortController();
    this.#modelValidationAbortController = abortController;
    const cancelled = new Promise<boolean>((resolve) => {
      cancelValidation = () => {
        abortController.abort();
        resolve(false);
      };
    });
    this.#cancelModelValidation = cancelValidation;
    const validation = Promise.resolve()
      .then(() =>
        this.#models.resolveRuntimeSelection({
          signal: abortController.signal,
        }),
      )
      .then(
        (current) =>
          current.modelId === selection.modelId &&
          current.reasoningEffort === selection.reasoningEffort,
        () => false,
      );
    const timed = new Promise<boolean>((resolve) => {
      timeout = this.#setModelValidationTimer(() => {
        abortController.abort();
        resolve(false);
      }, this.#modelValidationTimeoutMs);
      this.#modelValidationDeadlineTimer = timeout;
      timeout.unref?.();
    });
    const valid = await Promise.race([validation, timed, cancelled]);
    if (timeout) this.#clearModelValidationTimer(timeout);
    if (this.#modelValidationDeadlineTimer === timeout) {
      this.#modelValidationDeadlineTimer = undefined;
    }
    if (this.#cancelModelValidation === cancelValidation) this.#cancelModelValidation = undefined;
    if (this.#modelValidationAbortController === abortController) {
      this.#modelValidationAbortController = undefined;
    }
    if (
      this.#shutdownRequested ||
      generation !== this.#modelValidationGeneration ||
      runtime !== this.#runtime
    ) {
      return;
    }
    if (!valid) {
      await this.#invalidateDesktopAuthority(
        "model_unavailable",
        "model_unavailable",
        true,
        true,
        true,
      );
      return;
    }
    scheduleNext();
  }

  #stopModelValidation(): void {
    this.#modelValidationGeneration += 1;
    const cancel = this.#cancelModelValidation;
    this.#cancelModelValidation = undefined;
    cancel?.();
    this.#modelValidationAbortController?.abort();
    this.#modelValidationAbortController = undefined;
    if (this.#modelValidationTimer) this.#clearModelValidationTimer(this.#modelValidationTimer);
    this.#modelValidationTimer = undefined;
    if (this.#modelValidationDeadlineTimer) {
      this.#clearModelValidationTimer(this.#modelValidationDeadlineTimer);
    }
    this.#modelValidationDeadlineTimer = undefined;
    this.#runtimeSelection = undefined;
  }

  #publishConnectionInvalidated(
    reason: ConnectionInvalidationReason,
    containedSnapshot?: RuntimeSnapshot,
  ): Promise<void> {
    if (this.#publicRuntimeRevision >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new Error("Runtime revision is exhausted"));
    }
    const base =
      containedSnapshot ??
      this.#lastSafeRuntimeSnapshot ??
      ({ ...idleRuntimeSnapshot, revision: this.#publicRuntimeRevision } as const);
    const revision = this.#publicRuntimeRevision + 1;
    const snapshot: RuntimeSnapshot = {
      ...base,
      revision,
    };
    const envelope: DesktopEvent = {
      version: DESKTOP_PROTOCOL_VERSION,
      event: {
        kind: "connection_invalidated",
        revision,
        reason,
        snapshot,
      },
    };
    const parsed = parseDesktopEvent(envelope);
    this.#publicRuntimeRevision = revision;
    this.#lastSafeRuntimeSnapshot = snapshot;
    return this.#writeProtocol(parsed);
  }

  async #replaceRuntime(
    generation: number,
    connection: ConfirmedRuntimeConnection,
    selection: ResolvedModelSelection,
    worldSafety: RuntimeSafetyConfiguration,
  ): Promise<void> {
    if (this.#shutdownRequested || generation !== this.#interruptGeneration) {
      throw new Error("Runtime replacement was interrupted");
    }
    const replacement = {
      generation,
      operation: Promise.resolve(),
    } as RuntimeReplacementOperation;
    const operation = this.#createAndReplaceRuntime(
      generation,
      connection,
      selection,
      worldSafety,
      replacement,
    );
    replacement.operation = operation;
    this.#replacementOperation = replacement;
    try {
      await operation;
    } finally {
      if (this.#replacementOperation === replacement) this.#replacementOperation = undefined;
    }
  }

  async #createAndReplaceRuntime(
    generation: number,
    connection: ConfirmedRuntimeConnection,
    selection: ResolvedModelSelection,
    worldSafety: RuntimeSafetyConfiguration,
    replacement: RuntimeReplacementOperation,
  ): Promise<void> {
    const initialRevision = this.#publicRuntimeRevision;
    const next = await this.#createRuntime(connection, initialRevision, selection, worldSafety);
    const nextSnapshot = next.snapshot();
    if (!isRuntimeRevision(nextSnapshot.revision) || nextSnapshot.revision !== initialRevision) {
      await next.stop("process_exit").catch(() => undefined);
      throw new Error("Replacement runtime revision is invalid");
    }
    if (this.#shutdownRequested || generation !== this.#interruptGeneration) {
      try {
        await next.stop(replacement.retirementReason ?? "process_exit");
        replacement.containedSnapshot = this.#readContainedSnapshot(next);
      } catch {
        throw new RuntimeReplacementCleanupError();
      }
      throw new Error("Runtime replacement was interrupted");
    }
    let unsubscribeNext: () => void;
    try {
      unsubscribeNext = this.#subscribeRuntime(next);
    } catch (error) {
      await next.stop("process_exit").catch(() => undefined);
      throw error;
    }
    const unsubscribePrevious = this.#unsubscribeRuntime;
    this.#runtime = next;
    this.#unsubscribeRuntime = unsubscribeNext;
    this.#needsFreshRuntime = false;
    try {
      unsubscribePrevious?.();
    } catch {
      // The fresh facade is authoritative even if old observer teardown fails.
    }
  }

  #writeError(id: string, code: DesktopErrorCode): Promise<void> {
    return this.#writeResponse({
      version: DESKTOP_PROTOCOL_VERSION,
      id,
      ok: false,
      error: protocolError(code),
    });
  }

  #acceptConnectionProof(
    proof: ConfirmedConnectionProof,
    generation: number,
  ): AcceptedConnectionAuthority {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new ConnectionOperationError("invalid clock");
    for (const [nonce, expiresAt] of this.#usedProofNonces) {
      if (expiresAt <= now) this.#usedProofNonces.delete(nonce);
    }
    if (
      this.#usedProofNonces.has(proof.nonce) ||
      proof.issuedAt > now ||
      proof.expiresAt <= now ||
      proof.expiresAt <= proof.issuedAt ||
      proof.expiresAt - proof.issuedAt > 10_000
    ) {
      throw new ConnectionOperationError("invalid connection proof");
    }
    if (this.#usedProofNonces.size >= 256) {
      throw new ConnectionOperationError("connection proof replay cache is full");
    }
    this.#usedProofNonces.set(proof.nonce, proof.expiresAt);
    return Object.freeze({
      connection: Object.freeze({ host: "127.0.0.1", port: proof.port }),
      nonce: proof.nonce,
      issuedAt: proof.issuedAt,
      expiresAt: proof.expiresAt,
      generation,
    });
  }

  #consumeConnectionAuthority(generation: number): ConfirmedRuntimeConnection {
    const authority = this.#acceptedConnectionAuthority;
    this.#acceptedConnectionAuthority = undefined;
    const now = this.#now();
    if (generation !== this.#interruptGeneration || this.#shutdownRequested) {
      throw new ConnectionOperationError("Minecraft connection is not confirmed");
    }
    if (authority) {
      if (
        !Number.isSafeInteger(now) ||
        now < authority.issuedAt ||
        now >= authority.expiresAt ||
        authority.generation !== generation
      ) {
        throw new ConnectionOperationError("Minecraft connection is not confirmed");
      }
      this.#activeRuntimeConnection = authority.connection;
      return authority.connection;
    }
    const recovery = this.#recoveryConnectionAuthority;
    this.#recoveryConnectionAuthority = undefined;
    if (!recovery) {
      throw new ConnectionOperationError("Minecraft connection is not confirmed");
    }
    this.#activeRuntimeConnection = recovery.connection;
    return recovery.connection;
  }

  #assertConnectionGeneration(generation: number): void {
    if (this.#shutdownRequested || generation !== this.#interruptGeneration) {
      throw new ConnectionOperationError("Connection confirmation was interrupted");
    }
  }

  #invalidateConnectionAuthority(
    preserveWorldBinding = false,
    preserveConnectionAuthority = false,
    explicitModelRecovery = false,
  ): void {
    if (preserveConnectionAuthority) {
      const existing = this.#recoveryConnectionAuthority;
      const connection =
        existing?.connection ??
        this.#activeRuntimeConnection ??
        (explicitModelRecovery ? this.#acceptedConnectionAuthority?.connection : undefined);
      if (connection) {
        this.#recoveryConnectionAuthority = Object.freeze({
          connection,
          explicitModelRecovery: existing?.explicitModelRecovery === true || explicitModelRecovery,
        });
      }
      if (explicitModelRecovery) {
        this.#acceptedConnectionAuthority = undefined;
        this.#activeRuntimeConnection = undefined;
      }
    } else {
      this.#acceptedConnectionAuthority = undefined;
      this.#activeRuntimeConnection = undefined;
      this.#recoveryConnectionAuthority = undefined;
    }
    if (!preserveWorldBinding) {
      this.#currentConfirmedConnectionProof = undefined;
      this.#activeWorldBinding = undefined;
    }
  }

  #rebasePreservedConnectionAuthority(preserveConnectionAuthority: boolean): void {
    const authority = this.#acceptedConnectionAuthority;
    if (!preserveConnectionAuthority || !authority) return;
    this.#acceptedConnectionAuthority = Object.freeze({
      ...authority,
      generation: this.#interruptGeneration,
    });
  }

  #writeResponse(response: DesktopResponse): Promise<void> {
    return this.#writeProtocol(parseDesktopResponse(response));
  }

  #writeProtocol(
    value: DesktopResponse | DesktopEvent,
    commitResponse?: () => void,
  ): Promise<void> {
    const line = `${JSON.stringify(value)}\n`;
    commitResponse?.();
    const operation = this.#outputTail
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            this.#output.write(line, (error?: Error | null) => {
              if (error) reject(error);
              else resolve();
            });
          }),
      );
    this.#outputTail = operation;
    return operation;
  }

  #writeCommandResult(
    request: DesktopRequest,
    result: DesktopCommandResultValue,
    commitResponse?: () => void,
  ): Promise<void> {
    return this.#writeProtocol(
      parseDesktopResponse({
        version: DESKTOP_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        result: parseDesktopCommandResult(request.command, result),
      }),
      commitResponse,
    );
  }

  #writePrivateWorldBindResult(
    request: PrivateWorldBindRequest,
    result: DocumentEnvelope<WorldProfile | null>,
    commitResponse?: () => void,
  ): Promise<void> {
    return this.#writeProtocol(
      parseDesktopResponse({
        version: DESKTOP_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        result: parseDesktopCommandResult(
          {
            kind: "bind_confirmed_world",
            expectedRevision: request.privateCommand.expectedRevision,
            label: request.privateCommand.label,
          },
          result,
        ),
      }),
      commitResponse,
    );
  }

  #snapshot(): RuntimeSnapshot {
    const snapshot =
      this.#runtime?.snapshot() ??
      this.#lastSafeRuntimeSnapshot ??
      ({ ...idleRuntimeSnapshot, revision: this.#publicRuntimeRevision } as const);
    if (!isRuntimeRevision(snapshot.revision) || snapshot.revision < this.#publicRuntimeRevision) {
      throw new Error("Runtime revision is invalid");
    }
    this.#publicRuntimeRevision = snapshot.revision;
    return snapshot;
  }

  #requireRuntime(): DesktopChildRuntime {
    if (!this.#runtime) throw new Error("Runtime is unavailable");
    return this.#runtime;
  }

  #requireProfiles(): DesktopChildProfileStore {
    if (!this.#profiles) throw new Error("Profile store is unavailable");
    return this.#profiles;
  }

  #requireWorldProfiles(): DesktopChildWorldProfileStore {
    if (!this.#worldProfiles) throw new Error("World profile store is unavailable");
    return this.#worldProfiles;
  }

  #assertWorldRevision(actual: number, expected: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0 || actual !== expected) {
      throw new DocumentStoreError("DOCUMENT_CONFLICT", "world profile revision conflict");
    }
  }

  #requireConfirmedWorldBinding(): Promise<ConfirmedWorldBinding> {
    if (!this.#getConfirmedWorldBinding) {
      return Promise.reject(new ConnectionOperationError("World binding is not confirmed"));
    }
    return this.#getConfirmedWorldBinding();
  }

  #consumePrivateWorldBindingProof(binding: ConfirmedWorldBinding): void {
    const now = this.#assertWorldBindingProofCurrent(binding);
    for (const [nonce, expiresAt] of this.#usedWorldBindingProofNonces) {
      if (expiresAt <= now) this.#usedWorldBindingProofNonces.delete(nonce);
    }
    if (this.#usedWorldBindingProofNonces.has(binding.proof.nonce)) {
      throw new ConnectionOperationError("world binding proof was already consumed");
    }
    if (this.#usedWorldBindingProofNonces.size >= 256) {
      throw new ConnectionOperationError("world binding proof replay cache is full");
    }
    this.#usedWorldBindingProofNonces.set(binding.proof.nonce, binding.proof.expiresAt);
  }

  #assertWorldBindingProofCurrent(binding: ConfirmedWorldBinding): number {
    const now = this.#now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      binding.proof.issuedAt > now ||
      binding.proof.expiresAt <= now ||
      binding.proof.expiresAt <= binding.proof.issuedAt ||
      binding.proof.expiresAt - binding.proof.issuedAt > 10_000
    ) {
      throw new ConnectionOperationError("world binding proof is not current");
    }
    return now;
  }

  #assertPrivateBindingAuthority(generation: number, binding: ConfirmedWorldBinding): void {
    this.#assertConnectionGeneration(generation);
    this.#assertWorldBindingProofCurrent(binding);
    this.#assertPrivateBindingMatchesCurrentConnection(binding);
  }

  #assertActiveWorldBindingAuthority(generation: number): void {
    this.#assertConnectionGeneration(generation);
    const binding = this.#activeWorldBinding;
    const current = this.#currentConfirmedConnectionProof;
    if (!binding || !current) {
      throw new ConnectionOperationError("world binding is not current");
    }
    this.#assertWorldBindingProofCurrent(binding);
    if (!sameConfirmedProof(current, binding.proof)) {
      throw new ConnectionOperationError("world binding is not current");
    }
  }

  #assertPrivateBindingMatchesCurrentConnection(binding: ConfirmedWorldBinding): void {
    const current = this.#currentConfirmedConnectionProof;
    if (!current || !sameConfirmedProof(current, binding.proof)) {
      throw new ConnectionOperationError(
        "world binding is not confirmed for the current connection",
      );
    }
  }

  async #worldSafetyConfiguration(): Promise<RuntimeSafetyConfiguration> {
    try {
      const profile = (await this.#requireWorldProfiles().read()).value;
      const binding = this.#activeWorldBinding;
      const current = this.#currentConfirmedConnectionProof;
      if (!profile || !binding || !current || !sameConfirmedProof(current, binding.proof)) {
        return { compatibilityVerified: false };
      }
      const fingerprint = fingerprintConfirmedWorld(
        binding.canonicalInstancePath,
        binding.javaSession,
      );
      if (profile.instanceFingerprint !== fingerprint) {
        return { compatibilityVerified: false };
      }
      return {
        requestedPreset: profile.safetyPreset,
        compatibilityVerified: binding.javaSession.version === "1.21.5",
      };
    } catch {
      return { compatibilityVerified: false };
    }
  }

  #requireMemories(): DesktopChildMemoryStore {
    if (!this.#memories) throw new Error("Memory store is unavailable");
    return this.#memories;
  }

  #requireDiagnostics(): DesktopChildDiagnostics {
    if (!this.#diagnostics) throw new Error("Diagnostics are unavailable");
    return this.#diagnostics;
  }

  async #resolveMemoryInput(
    input: Extract<DesktopRequest["command"], { kind: "add_memory" }>["memory"],
  ): Promise<ScopedMemoryInput> {
    if (input.scope === "global") return input;
    return { ...input, worldId: await this.#authoritativeWorldId() };
  }

  async #resolveMemoryPatch(
    patch: Extract<DesktopRequest["command"], { kind: "update_memory" }>["patch"],
  ): Promise<ScopedMemoryPatch> {
    if (patch.scope !== "world") return patch;
    return { ...patch, worldId: await this.#authoritativeWorldId() };
  }

  async #authoritativeWorldId(): Promise<string> {
    const world = (await this.#requireWorldProfiles().read()).value;
    if (!world) throw new Error("Authoritative world profile is unavailable");
    return world.id;
  }

  #activeMemoryMigration(): RetainedMemoryMigration | undefined {
    const capability = this.#memoryMigrationCapability;
    if (!capability) return undefined;
    if (this.#now() < capability.expiresAt) return capability;
    this.#releaseMemoryMigrationCapability();
    return undefined;
  }

  #newMemoryMigrationExpiry(): number {
    const expiresAt = this.#now() + this.#memoryMigrationTtlMs;
    if (!Number.isSafeInteger(expiresAt)) throw new Error("Memory migration expiry is invalid");
    return expiresAt;
  }

  #releaseMemoryMigrationCapability(): void {
    const capability = this.#memoryMigrationCapability;
    if (capability?.status === "committed") {
      this.#requireMemoryMigration().release(capability.id);
    }
    this.#memoryMigrationCapability = undefined;
  }

  #requireMemoryMigration(): Pick<MemoryMigration, "preview" | "commit" | "rollback" | "release"> {
    if (!this.#memoryMigration) throw new Error("Memory migration is unavailable");
    return this.#memoryMigration;
  }

  async #applyCommittedProfile(
    envelope: DocumentEnvelope<CompanionProfile>,
  ): Promise<ProfileMutationResult> {
    const runtime = this.#runtime;
    if (!runtime?.applyProfile) return { envelope, liveStatus: "applied" };
    try {
      await runtime.applyProfile(envelope.value);
      return { envelope, liveStatus: "applied" };
    } catch {
      try {
        await this.#beginRuntimeInvalidation(runtime, "failed", true, "runtime_failed", true);
      } catch {
        throw new ProfileRuntimeContainmentError(envelope);
      }
      return { envelope, liveStatus: "runtime_contained" };
    }
  }

  #writeProfileRuntimeContainmentError(
    id: string,
    committed: DocumentEnvelope<CompanionProfile>,
  ): Promise<void> {
    return this.#writeResponse({
      version: DESKTOP_PROTOCOL_VERSION,
      id,
      ok: false,
      error: {
        code: "PROFILE_RUNTIME_CONTAINMENT_FAILED",
        message: "Profile committed but runtime containment failed",
        committed,
      },
    });
  }
}

function isConnectionInvalidatingRuntimeEvent(event: RuntimeEvent): boolean {
  return (
    (event.kind === "minecraft" &&
      (event.state.state === "disconnected" || event.state.state === "reconnecting")) ||
    (event.kind === "lifecycle" && (event.state === "failed" || event.state === "stopped")) ||
    event.kind === "error"
  );
}

function connectionInvalidationReason(
  reason: Exclude<TaskStopReason, "owner_changed" | "model_changed">,
): ConnectionInvalidationReason {
  switch (reason) {
    case "owner_stop":
      return "owner_stop";
    case "emergency_stop":
      return "emergency_stop";
    case "disconnect":
      return "minecraft_disconnect";
    case "world_changed":
      return "world_changed";
    case "model_unavailable":
      return "model_unavailable";
    case "completed":
    case "failed":
    case "timeout":
    case "budget_exhausted":
    case "process_exit":
      return "runtime_failed";
  }
}

function isRuntimeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function stripTrailingCarriageReturn(line: Buffer): Buffer {
  return line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
}

function extractRequestId(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/u.test((value as { id: string }).id)
  ) {
    return (value as { id: string }).id;
  }
  return "invalid";
}

function hasOwn(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key);
}

function sameConfirmedProof(
  left: ConfirmedConnectionProof,
  right: ConfirmedConnectionProof,
): boolean {
  return (
    left.nonce === right.nonce &&
    left.port === right.port &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt
  );
}

function callRuntimeStop(runtime: DesktopChildRuntime, reason: TaskStopReason): Promise<void> {
  try {
    return runtime.stop(reason);
  } catch (error) {
    return Promise.reject(error);
  }
}

function protocolError(code: DesktopErrorCode): Extract<DesktopResponse, { ok: false }>["error"] {
  switch (code) {
    case "OWNER_IDENTITY_INVALID":
      return { code, message: errorMessages[code] };
    case "OWNER_IDENTITY_REQUIRED":
      return { code, message: errorMessages[code] };
    case "OWNER_IDENTITY_CONFIG_CONFLICT":
      return { code, message: errorMessages[code] };
    case "OWNER_IDENTITY_WRITE_FAILED":
      return { code, message: errorMessages[code] };
    case "OWNER_IDENTITY_CONFIG_INVALID":
      return { code, message: errorMessages[code] };
    default:
      return { code, message: errorMessages[code] };
  }
}

function errorCodeFor(kind: DesktopRequest["command"]["kind"]): DesktopErrorCode {
  switch (kind) {
    case "read_owner_identity":
    case "update_owner_identity":
      return "INTERNAL_ERROR";
    case "start_runtime":
      return "RUNTIME_START_FAILED";
    case "stop_runtime":
      return "RUNTIME_STOP_FAILED";
    case "stop_task":
      return "RUNTIME_STOP_FAILED";
    case "emergency_stop":
      return "EMERGENCY_STOP_FAILED";
    case "get_status":
      return "INTERNAL_ERROR";
    case "get_account":
    case "start_chatgpt_login":
    case "cancel_chatgpt_login":
      return "ACCOUNT_OPERATION_FAILED";
    case "list_models":
    case "select_model":
      return "MODEL_OPERATION_FAILED";
    case "set_confirmed_connection":
    case "invalidate_connection":
      return "CONNECTION_OPERATION_FAILED";
    case "read_profile":
    case "read_world_profile":
    case "bind_confirmed_world":
    case "update_safety_profile":
    case "update_profile":
    case "set_behavior_mode":
      return "PROFILE_OPERATION_FAILED";
    case "set_memory_scope":
      return "INTERNAL_ERROR";
    case "read_memories":
    case "search_memories":
    case "export_memories":
    case "export_redacted_memories":
    case "preview_diagnostics":
    case "prepare_diagnostic_archive":
    case "preview_memory_migration":
    case "commit_memory_migration":
    case "rollback_memory_migration":
    case "add_memory":
    case "update_memory":
    case "forget_memory":
    case "pin_memory":
      return "INTERNAL_ERROR";
  }
}

const idleRuntimeSnapshot: RuntimeSnapshot = {
  revision: 0,
  lifecycle: "idle",
  minecraft: { state: "disconnected", sessionId: null },
  codex: { state: "stopped", model: null },
  task: null,
  lastError: null,
};
