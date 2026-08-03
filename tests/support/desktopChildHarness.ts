import { PassThrough } from "node:stream";
import { DesktopChildServer } from "../../src/desktop/childServer.js";
import type {
  DesktopEvent,
  DesktopRequest,
  DesktopResponse,
} from "../../src/desktop/desktopProtocol.js";
import { parseDesktopEvent, parseDesktopResponse } from "../../src/desktop/desktopProtocol.js";
import type { AccountSnapshot, LoginAttempt } from "../../src/codex/accountService.js";
import type {
  ModelCatalogSnapshot,
  ModelCatalogEvent,
  ModelSelection,
  ModelSelectionInput,
  ResolvedModelSelection,
} from "../../src/codex/modelCatalog.js";
import { RuntimeFacade } from "../../src/runtime/runtimeFacade.js";
import type { RuntimeAuthorityLoss, RuntimeSnapshot } from "../../src/runtime/runtimeEvents.js";
import type { TaskStopReason } from "../../src/safety/taskBudget.js";
import type { ConfirmedRuntimeConnection } from "../../src/config/schema.js";
import type { RuntimeSafetyConfiguration } from "../../src/safety/safetyProfile.js";
import {
  companionProfileSchema,
  createDefaultCompanionProfile,
  withBehaviorMode,
  type BehaviorModeSettings,
  type CompanionProfile,
} from "../../src/profile/profileSchema.js";
import { DocumentStoreError, type DocumentEnvelope } from "../../src/storage/documentStore.js";
import type {
  DesktopChildDiagnostics,
  DesktopChildMemoryStore,
  DesktopChildWorldProfileStore,
} from "../../src/desktop/childServer.js";
import type { ConfirmedWorldBinding } from "../../src/world/worldProfileStore.js";
import type { MemoryMigration, MemoryMigrationPreview } from "../../src/memory/memoryMigration.js";
import {
  OwnerIdentityError,
  type OwnerIdentityAccess,
  type OwnerIdentitySnapshot,
} from "../../src/identity/ownerIdentity.js";

export interface DesktopRuntime {
  start(): Promise<void>;
  stop(reason: TaskStopReason): Promise<void>;
  stopTask(): Promise<void>;
  snapshot(): RuntimeSnapshot;
  subscribe(listener: DesktopRuntimeEventListener): () => void;
  subscribeAuthorityLoss?(listener: (event: RuntimeAuthorityLoss) => void): () => void;
  applyProfile?(profile: CompanionProfile): void | Promise<void>;
}

type DesktopRuntimeEventListener = Parameters<RuntimeFacade["subscribe"]>[0];

export interface DesktopChildHarness {
  input: PassThrough;
  output: PassThrough;
  runtime: DesktopRuntime;
  server: DesktopChildServer;
  stopReasons: TaskStopReason[];
  runtimeCreations(): number;
  lifecycleStarts(): number;
  lifecycleStops(): number;
  releaseLifecycleStop(): void;
  send(request: DesktopRequest): void;
  sendRaw(bytes: Buffer | string): void;
  endInput(): void;
  nextLine(): Promise<string>;
  nextResponse(): Promise<DesktopResponse>;
  nextEvent(): Promise<DesktopEvent>;
  lines(): readonly string[];
}

export function createDesktopChildHarness(
  options: {
    account?: Partial<{
      getAccount(): Promise<AccountSnapshot>;
      startChatGptLogin(): Promise<LoginAttempt>;
      cancelChatGptLogin(attemptId: string): Promise<AccountSnapshot>;
      subscribe(listener: (snapshot: AccountSnapshot) => void): () => void;
      stop(): Promise<void>;
    }>;
    ownerIdentity?: OwnerIdentityAccess;
    blockLifecycleStop?: boolean;
    createRuntime?: (
      connection: ConfirmedRuntimeConnection,
      initialRevision: number,
      selection: ResolvedModelSelection,
      worldSafety: RuntimeSafetyConfiguration,
    ) => Promise<DesktopRuntime>;
    lazyRuntime?: boolean;
    models?: Partial<{
      listModels(): Promise<ModelCatalogSnapshot>;
      selectModel(selection: ModelSelectionInput): Promise<ModelSelection>;
      resolveRuntimeSelection(options?: { signal?: AbortSignal }): Promise<ResolvedModelSelection>;
      subscribe(listener: (event: ModelCatalogEvent) => void): () => void;
      stop(): void;
    }>;
    profiles?: Partial<{
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
    }>;
    memories?: DesktopChildMemoryStore;
    memoryMigration?: Pick<MemoryMigration, "preview" | "commit" | "rollback" | "release">;
    diagnostics?: DesktopChildDiagnostics;
    createMemoryMigrationId?: () => string;
    memoryMigrationTtlMs?: number;
    worldProfiles?: DesktopChildWorldProfileStore;
    getConfirmedWorldBinding?: () => Promise<ConfirmedWorldBinding>;
    runtime?: DesktopRuntime;
    now?: () => number;
  } = {},
): DesktopChildHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const stopReasons: TaskStopReason[] = [];
  let runtimeCreations = 0;
  let lifecycleStarts = 0;
  let lifecycleStops = 0;
  let releaseStop = (): void => undefined;
  let stopGate = Promise.resolve();
  if (options.blockLifecycleStop) {
    stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
  }
  const createDefaultRuntime = (initialRevision = 0): RuntimeFacade => {
    runtimeCreations += 1;
    return new RuntimeFacade({
      initialRevision,
      lifecycle: {
        start: async () => {
          lifecycleStarts += 1;
        },
        stop: async () => {
          lifecycleStops += 1;
          await stopGate;
        },
      },
      task: {
        current: () => null,
        budget: () => ({
          active: false,
          stopReason: null,
          limits: {
            maxToolCalls: 64,
            maxBlockChanges: 256,
            maxHorizontalTravel: 1_024,
            maxDurationMs: 600_000,
            maxDangerousOperations: 8,
          },
          toolCalls: 0,
          blockChanges: 0,
          horizontalTravel: 0,
          dangerousOperations: 0,
          startedAt: null,
        }),
        stop: (reason) => {
          stopReasons.push(reason);
        },
      },
    });
  };
  const runtime = options.runtime ?? (options.lazyRuntime ? undefined : createDefaultRuntime());
  if (options.runtime) runtimeCreations += 1;
  const reportedRuntime =
    runtime ??
    new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
    });
  const account = {
    getAccount: async (): Promise<AccountSnapshot> => ({ status: "signed_out" }),
    startChatGptLogin: async (): Promise<LoginAttempt> => ({
      attemptId: "default_attempt_1234",
      expiresAt: 60_000,
      loginUrl: "https://auth.openai.com/oauth",
    }),
    cancelChatGptLogin: async (attemptId: string): Promise<AccountSnapshot> => ({
      status: "cancelled",
      attemptId,
    }),
    subscribe: (_listener: (snapshot: AccountSnapshot) => void) => () => undefined,
    stop: async () => undefined,
    ...options.account,
  };
  let ownerSnapshot: OwnerIdentitySnapshot = Object.freeze({
    revision: 0,
    ownerUsername: "HarnessOwner",
    configured: true,
    presence: "unknown",
  });
  const ownerListeners = new Set<(snapshot: OwnerIdentitySnapshot) => void>();
  const ownerIdentity: OwnerIdentityAccess = options.ownerIdentity ?? {
    snapshot: () => ownerSnapshot,
    update: async (input) => {
      if (input.expectedRevision !== ownerSnapshot.revision) {
        throw new OwnerIdentityError("OWNER_IDENTITY_CONFIG_CONFLICT");
      }
      if (input.ownerUsername === ownerSnapshot.ownerUsername) return ownerSnapshot;
      ownerSnapshot = Object.freeze({
        revision: ownerSnapshot.revision + 1,
        ownerUsername: input.ownerUsername,
        configured: true,
        presence: "unknown",
      });
      for (const listener of ownerListeners) listener(ownerSnapshot);
      return ownerSnapshot;
    },
    setPresence: (input) => {
      if (
        input.revision !== ownerSnapshot.revision ||
        input.ownerUsername !== ownerSnapshot.ownerUsername ||
        input.presence === ownerSnapshot.presence
      ) {
        return;
      }
      ownerSnapshot = Object.freeze({ ...ownerSnapshot, presence: input.presence });
      for (const listener of ownerListeners) listener(ownerSnapshot);
    },
    subscribe: (listener) => {
      ownerListeners.add(listener);
      return () => ownerListeners.delete(listener);
    },
  };
  const models = {
    listModels: async (): Promise<ModelCatalogSnapshot> => ({
      models: [],
      selection: { mode: "automatic" },
      legacyMigrationCompleted: false,
    }),
    selectModel: async (selection: ModelSelectionInput): Promise<ModelSelection> =>
      selection.mode === "automatic" ? { mode: "automatic" } : { ...selection, available: true },
    resolveRuntimeSelection: async (): Promise<ResolvedModelSelection> => ({
      modelId: "harness-live-model",
      reasoningEffort: "medium",
    }),
    subscribe: (_listener: (event: ModelCatalogEvent) => void) => () => undefined,
    stop: () => undefined,
    ...options.models,
  };
  let profileEnvelope: DocumentEnvelope<CompanionProfile> = {
    schemaVersion: 1,
    revision: 0,
    updatedAt: "2026-07-29T01:02:03.004Z",
    value: createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99"),
  };
  const profiles = {
    read: async () => structuredClone(profileEnvelope),
    update: async (expectedRevision: number, profile: CompanionProfile) => {
      if (expectedRevision !== profileEnvelope.revision) {
        throw new DocumentStoreError("DOCUMENT_CONFLICT", "document revision conflict");
      }
      profileEnvelope = {
        ...profileEnvelope,
        revision: profileEnvelope.revision + 1,
        value: companionProfileSchema.parse(profile),
      };
      return structuredClone(profileEnvelope);
    },
    setBehaviorMode: async (
      expectedRevision: number,
      mode: CompanionProfile["mode"],
      settings: BehaviorModeSettings,
    ) => {
      if (expectedRevision !== profileEnvelope.revision) {
        throw new DocumentStoreError("DOCUMENT_CONFLICT", "document revision conflict");
      }
      profileEnvelope = {
        ...profileEnvelope,
        revision: profileEnvelope.revision + 1,
        value: withBehaviorMode(profileEnvelope.value, mode, settings),
      };
      return structuredClone(profileEnvelope);
    },
    ...options.profiles,
  };
  const lines: string[] = [];
  const pendingLines: string[] = [];
  const lineWaiters: Array<(line: string) => void> = [];
  let bufferedOutput = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    bufferedOutput += chunk;
    while (true) {
      const newline = bufferedOutput.indexOf("\n");
      if (newline < 0) break;
      const line = bufferedOutput.slice(0, newline);
      bufferedOutput = bufferedOutput.slice(newline + 1);
      const responseId = (() => {
        try {
          const value = JSON.parse(line) as { id?: unknown };
          return typeof value.id === "string" ? value.id : undefined;
        } catch {
          return undefined;
        }
      })();
      if (responseId?.startsWith("harness-confirm-")) continue;
      lines.push(line);
      const waiter = lineWaiters.shift();
      if (waiter) waiter(line);
      else pendingLines.push(line);
    }
  });

  const nextLine = (): Promise<string> => {
    const line = pendingLines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve) => lineWaiters.push(resolve));
  };
  const nextMatching = async <T>(
    parse: (value: unknown) => T,
    matches: (value: unknown) => boolean,
  ): Promise<T> => {
    while (true) {
      const value: unknown = JSON.parse(await nextLine());
      if (matches(value)) return parse(value);
    }
  };

  const server = new DesktopChildServer({
    input,
    output,
    ...(runtime ? { runtime } : {}),
    createRuntime:
      options.createRuntime ??
      (async (_connection, initialRevision, _selection) => createDefaultRuntime(initialRevision)),
    ...(options.now ? { now: options.now } : {}),
    ...(!options.lazyRuntime
      ? { confirmedConnection: { host: "127.0.0.1" as const, port: 25565 } }
      : {}),
    account,
    ownerIdentity,
    models,
    profiles,
    ...(options.worldProfiles === undefined ? {} : { worldProfiles: options.worldProfiles }),
    ...(options.getConfirmedWorldBinding === undefined
      ? {}
      : { getConfirmedWorldBinding: options.getConfirmedWorldBinding }),
    ...(options.memories === undefined ? {} : { memories: options.memories }),
    ...(options.memoryMigration === undefined ? {} : { memoryMigration: options.memoryMigration }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...(options.createMemoryMigrationId === undefined
      ? {}
      : { createMemoryMigrationId: options.createMemoryMigrationId }),
    ...(options.memoryMigrationTtlMs === undefined
      ? {}
      : { memoryMigrationTtlMs: options.memoryMigrationTtlMs }),
  } as ConstructorParameters<typeof DesktopChildServer>[0] & {
    memoryMigration?: Pick<MemoryMigration, "preview" | "commit" | "rollback" | "release">;
    createMemoryMigrationId?: () => string;
    memoryMigrationTtlMs?: number;
    preview?: MemoryMigrationPreview;
  });
  server.start();
  let autoConfirmationRequired = false;
  let autoConfirmationIndex = 0;
  const send = (request: DesktopRequest): void => {
    if (!options.lazyRuntime && request.command.kind === "start_runtime") {
      if (autoConfirmationRequired) {
        const issuedAt = options.now?.() ?? Date.now();
        autoConfirmationIndex += 1;
        input.write(
          `${JSON.stringify({
            version: 1,
            id: `harness-confirm-${autoConfirmationIndex}`,
            command: {
              kind: "set_confirmed_connection",
              proof: {
                nonce: `harness_proof_${String(autoConfirmationIndex).padStart(8, "0")}`,
                port: 25565,
                issuedAt,
                expiresAt: issuedAt + 10_000,
              },
            },
          })}\n`,
        );
      }
      autoConfirmationRequired = true;
    }
    input.write(`${JSON.stringify(request)}\n`);
  };
  return {
    input,
    output,
    runtime: reportedRuntime,
    server,
    stopReasons,
    runtimeCreations: () => runtimeCreations,
    lifecycleStarts: () => lifecycleStarts,
    lifecycleStops: () => lifecycleStops,
    releaseLifecycleStop: () => releaseStop(),
    send,
    sendRaw: (bytes) => input.write(bytes),
    endInput: () => input.end(),
    nextLine,
    nextResponse: () =>
      nextMatching(
        parseDesktopResponse,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          Object.prototype.hasOwnProperty.call(value, "id"),
      ),
    nextEvent: () =>
      nextMatching(
        parseDesktopEvent,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          Object.prototype.hasOwnProperty.call(value, "event"),
      ),
    lines: () => lines,
  };
}
