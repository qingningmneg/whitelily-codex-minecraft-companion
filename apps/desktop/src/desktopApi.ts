import {
  DESKTOP_PROTOCOL_VERSION,
  parseDesktopCommandResult,
  parseDesktopEvent,
  parseDesktopRequest,
  type ConnectionInvalidatedEvent,
  type DesktopCommand,
  type DesktopCommandResult,
  type DiagnosticPreview,
} from "../../../src/desktop/desktopProtocol.js";
import type { AccountSnapshot } from "../../../src/codex/accountService.js";
import type {
  ModelCatalogSnapshot,
  ModelSelection,
  ModelSelectionInput,
} from "../../../src/codex/modelCatalog.js";
import {
  parseMinecraftJavaUsername,
  type OwnerIdentitySnapshot,
} from "../../../src/identity/ownerIdentity.js";
import type { RuntimeEvent, RuntimeSnapshot } from "../../../src/runtime/runtimeEvents.js";
import {
  parseAvatarModelCatalogSnapshot as parseSharedAvatarModelCatalogSnapshot,
  parseAvatarModelId,
  parseAvatarModelListItem,
  type AvatarModelCatalogSnapshot,
  type AvatarModelListItem,
} from "../../../src/avatar/avatarModelSchemas.js";
import type { BehaviorModeSettings, CompanionProfile } from "../../../src/profile/profileSchema.js";
import type { CompanionMode } from "../../../src/domain/types.js";
import type {
  MemoryContextScope,
  ScopedMemoryExport,
  ScopedMemoryInput,
  ScopedMemoryMutation,
  ScopedMemoryPatch,
} from "../../../src/memory/scopedMemoryStore.js";
import type { DocumentEnvelope } from "../../../src/storage/documentStore.js";
import type { SafetyPreset, WorldProfile } from "../../../src/world/worldProfileSchema.js";
import type { Pcl2Candidate } from "../src-main/discovery/pcl2Discovery.js";
import type { ConfirmedLanSession, LanCandidate } from "../src-main/discovery/lanDetector.js";
import type {
  MinecraftComponentId,
  MinecraftComponentState,
  MinecraftComponentStatus,
} from "../src-main/minecraftComponents.js";

export const WHITE_LILY_IPC_CHANNELS = {
  status: "whitelily:status",
  start: "whitelily:start",
  stop: "whitelily:stop",
  stopTask: "whitelily:stop-task",
  emergencyStop: "whitelily:emergency-stop",
  readOwnerIdentity: "whitelily:read-owner-identity",
  updateOwnerIdentity: "whitelily:update-owner-identity",
  getAccount: "whitelily:get-account",
  startChatGptLogin: "whitelily:start-chatgpt-login",
  cancelChatGptLogin: "whitelily:cancel-chatgpt-login",
  listModels: "whitelily:list-models",
  migrateModelPreference: "whitelily:migrate-model-preference",
  selectModel: "whitelily:select-model",
  discoverPcl2: "whitelily:discover-pcl2",
  detectLanCandidates: "whitelily:detect-lan-candidates",
  confirmLanCandidate: "whitelily:confirm-lan-candidate",
  getMinecraftComponentStatus: "whitelily:get-minecraft-component-status",
  installMinecraftComponents: "whitelily:install-minecraft-components",
  removeMinecraftComponents: "whitelily:remove-minecraft-components",
  bindConfirmedWorld: "whitelily:bind-confirmed-world",
  readProfile: "whitelily:read-profile",
  updateProfile: "whitelily:update-profile",
  setBehaviorMode: "whitelily:set-behavior-mode",
  readMemories: "whitelily:read-memories",
  searchMemories: "whitelily:search-memories",
  addMemory: "whitelily:add-memory",
  updateMemory: "whitelily:update-memory",
  forgetMemory: "whitelily:forget-memory",
  pinMemory: "whitelily:pin-memory",
  setMemoryScope: "whitelily:set-memory-scope",
  previewMemoryMigration: "whitelily:preview-memory-migration",
  commitMemoryMigration: "whitelily:commit-memory-migration",
  rollbackMemoryMigration: "whitelily:rollback-memory-migration",
  exportMemories: "whitelily:export-memories",
  previewDiagnostics: "whitelily:preview-diagnostics",
  exportDiagnostics: "whitelily:export-diagnostics",
  readWorldProfile: "whitelily:read-world-profile",
  updateSafetyProfile: "whitelily:update-safety-profile",
  readStartupSetting: "whitelily:read-startup-setting",
  setStartupSetting: "whitelily:set-startup-setting",
  readCloseToTraySetting: "whitelily:read-close-to-tray-setting",
  setCloseToTraySetting: "whitelily:set-close-to-tray-setting",
  listAvatarModels: "whitelily:list-avatar-models",
  importAvatarModel: "whitelily:import-avatar-model",
  switchAvatarModel: "whitelily:switch-avatar-model",
  quitApplication: "whitelily:quit-application",
  runtimeEvent: "whitelily:runtime-event",
  ownerIdentityEvent: "whitelily:owner-identity-event",
  avatarModelsEvent: "whitelily:avatar-models-event",
} as const;

export type WhiteLilyEventChannel =
  | typeof WHITE_LILY_IPC_CHANNELS.runtimeEvent
  | typeof WHITE_LILY_IPC_CHANNELS.ownerIdentityEvent
  | typeof WHITE_LILY_IPC_CHANNELS.avatarModelsEvent;

export type WhiteLilyInvokeChannel = Exclude<
  (typeof WHITE_LILY_IPC_CHANNELS)[keyof typeof WHITE_LILY_IPC_CHANNELS],
  WhiteLilyEventChannel
>;

export interface PreloadTransport {
  invoke(channel: WhiteLilyInvokeChannel, ...args: readonly unknown[]): Promise<unknown>;
  subscribe(channel: WhiteLilyEventChannel, listener: (value: unknown) => void): () => void;
}

export interface IpcRendererPort {
  invoke(channel: WhiteLilyInvokeChannel, ...args: readonly unknown[]): Promise<unknown>;
  on(channel: WhiteLilyEventChannel, listener: (event: unknown, value: unknown) => void): void;
  removeListener(
    channel: WhiteLilyEventChannel,
    listener: (event: unknown, value: unknown) => void,
  ): void;
}

export interface WhiteLilyDesktopApi {
  status(): Promise<RuntimeSnapshot>;
  start(): Promise<RuntimeSnapshot>;
  stop(): Promise<RuntimeSnapshot>;
  stopTask(): Promise<RuntimeSnapshot>;
  emergencyStop(): Promise<RuntimeSnapshot>;
  quitApplication(): Promise<void>;
  readOwnerIdentity(): Promise<OwnerIdentitySnapshot>;
  updateOwnerIdentity(input: {
    expectedRevision: number;
    ownerUsername: string;
  }): Promise<OwnerIdentitySnapshot>;
  subscribeOwnerIdentity(listener: (snapshot: OwnerIdentitySnapshot) => void): () => void;
  getAccount(): Promise<AccountSnapshot>;
  startChatGptLogin(): Promise<Extract<AccountSnapshot, { status: "pending" }>>;
  cancelChatGptLogin(attemptId: string): Promise<AccountSnapshot>;
  listModels(): Promise<ModelCatalogSnapshot>;
  migrateModelPreference(candidate: ModelSelectionInput | null): Promise<ModelCatalogSnapshot>;
  selectModel(selection: ModelSelectionInput): Promise<ModelSelection>;
  discoverPcl2(): Promise<readonly Pcl2Candidate[]>;
  detectLanCandidates(): Promise<readonly LanCandidate[]>;
  confirmLanCandidate(candidateId: string): Promise<ConfirmedLanSession>;
  getMinecraftComponentStatus(candidateId: string): Promise<MinecraftComponentStatus>;
  installMinecraftComponents(
    candidateId: string,
    selection: readonly MinecraftComponentId[],
  ): Promise<MinecraftComponentStatus>;
  removeMinecraftComponents(
    candidateId: string,
    selection: readonly MinecraftComponentId[],
  ): Promise<MinecraftComponentStatus>;
  bindConfirmedWorld?(input: {
    expectedRevision: number;
    label: string;
  }): Promise<DocumentEnvelope<WorldProfile | null>>;
  subscribeRuntime(listener: (event: DesktopRendererEvent) => void): () => void;
}

export interface WhiteLilyTask5Api {
  bindConfirmedWorld(input: {
    expectedRevision: number;
    label: string;
  }): Promise<DocumentEnvelope<WorldProfile | null>>;
  readProfile(): Promise<DocumentEnvelope<CompanionProfile>>;
  updateProfile(input: { expectedRevision: number; profile: CompanionProfile }): Promise<{
    envelope: DocumentEnvelope<CompanionProfile>;
    liveStatus: "applied" | "runtime_contained";
  }>;
  setBehaviorMode(input: {
    expectedRevision: number;
    mode: CompanionMode;
    settings: BehaviorModeSettings;
  }): Promise<{
    envelope: DocumentEnvelope<CompanionProfile>;
    liveStatus: "applied" | "runtime_contained";
  }>;
  readMemories(): Promise<ScopedMemoryExport>;
  searchMemories(input: { query: string; scope: MemoryContextScope }): Promise<ScopedMemoryExport>;
  addMemory(input: {
    expectedRevision: number;
    memory: RendererMemoryInput;
  }): Promise<ScopedMemoryMutation>;
  updateMemory(input: {
    id: number;
    expectedRevision: number;
    recordRevision: number;
    patch: RendererMemoryPatch;
  }): Promise<ScopedMemoryMutation>;
  forgetMemory(input: {
    id: number;
    expectedRevision: number;
    recordRevision: number;
  }): Promise<ScopedMemoryMutation>;
  pinMemory(input: {
    id: number;
    expectedRevision: number;
    recordRevision: number;
    pinned: boolean;
  }): Promise<ScopedMemoryMutation>;
  setMemoryScope(scope: MemoryContextScope): Promise<RuntimeSnapshot>;
  previewMemoryMigration(scope: "global" | "world"): Promise<MemoryMigrationPreviewResult>;
  commitMemoryMigration(input: {
    migrationId: string;
    sourceRevision: number;
  }): Promise<MemoryMigrationMutationResult>;
  rollbackMemoryMigration(migrationId: string): Promise<MemoryMigrationMutationResult>;
  exportMemories(): Promise<{ status: "cancelled" | "saved" }>;
  previewDiagnostics(): Promise<DiagnosticPreview>;
  exportDiagnostics(exportId: string): Promise<{ status: "cancelled" | "saved" }>;
  readWorldProfile(): Promise<DocumentEnvelope<WorldProfile | null>>;
  updateSafetyProfile(input: {
    expectedRevision: number;
    safetyPreset: SafetyPreset;
  }): Promise<DocumentEnvelope<WorldProfile | null>>;
  readStartupSetting(): Promise<{ enabled: boolean; available: boolean }>;
  setStartupSetting(enabled: boolean): Promise<{ enabled: boolean; available: boolean }>;
  readCloseToTraySetting(): Promise<{ revision: number; enabled: boolean }>;
  setCloseToTraySetting(input: {
    expectedRevision: number;
    enabled: boolean;
  }): Promise<{ revision: number; enabled: boolean }>;
}

export interface WhiteLilyAvatarApi {
  listAvatarModels(): Promise<AvatarModelCatalogSnapshot>;
  importAvatarModel(): Promise<
    | { readonly status: "cancelled" }
    | { readonly status: "imported"; readonly model: AvatarModelListItem }
  >;
  switchAvatarModel(modelId: string): Promise<AvatarModelCatalogSnapshot>;
  subscribeAvatarModels(listener: (snapshot: AvatarModelCatalogSnapshot) => void): () => void;
}

export type RendererMemoryInput = Omit<ScopedMemoryInput, "source" | "worldId">;
export type RendererMemoryPatch = Omit<ScopedMemoryPatch, "worldId">;
export interface MemoryMigrationPreviewResult {
  migrationId: string;
  sourceRevision: number;
  targetScope: "global" | "world";
  deduplicatedCount: number;
  movedCount: number;
}
export interface MemoryMigrationMutationResult {
  migrationId: string;
  status: "committed" | "rolled_back";
}

export type WhiteLilyAppApi = WhiteLilyDesktopApi & WhiteLilyTask5Api & WhiteLilyAvatarApi;

export type DesktopRendererEvent = RuntimeEvent | ConnectionInvalidatedEvent;
export type OwnerIdentityAuthoritySnapshot = OwnerIdentitySnapshot & {
  readonly childGeneration: number;
};

export function createPreloadTransport(ipcRenderer: IpcRendererPort): PreloadTransport {
  return {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    subscribe: (channel, listener) => {
      const wrapped = (_event: unknown, value: unknown): void => {
        listener(value);
      };
      let subscribed = true;
      ipcRenderer.on(channel, wrapped);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener(channel, wrapped);
      };
    },
  };
}

export function createWhiteLilyApi(transport: PreloadTransport): WhiteLilyAppApi {
  const invoke = async (channel: WhiteLilyInvokeChannel): Promise<RuntimeSnapshot> =>
    parseRuntimeSnapshot(await transport.invoke(channel));
  const getAccount = async (): Promise<AccountSnapshot> =>
    parseAccountSnapshot(await transport.invoke(WHITE_LILY_IPC_CHANNELS.getAccount));
  const invokeCommand = async <C extends DesktopCommand>(
    channel: WhiteLilyInvokeChannel,
    commandValue: C,
    input?: unknown,
  ): Promise<DesktopCommandResult<C>> => {
    const command = parseDesktopRequest({
      version: DESKTOP_PROTOCOL_VERSION,
      id: "preload",
      command: commandValue,
    }).command as C;
    return parseDesktopCommandResult(
      command,
      input === undefined
        ? await transport.invoke(channel)
        : await transport.invoke(channel, input),
    );
  };
  return Object.freeze({
    status: () => invoke(WHITE_LILY_IPC_CHANNELS.status),
    start: () => invoke(WHITE_LILY_IPC_CHANNELS.start),
    stop: () => invoke(WHITE_LILY_IPC_CHANNELS.stop),
    stopTask: async (...args: readonly unknown[]) => {
      validateNoDesktopApiInput(args);
      return invoke(WHITE_LILY_IPC_CHANNELS.stopTask);
    },
    emergencyStop: () => invoke(WHITE_LILY_IPC_CHANNELS.emergencyStop),
    quitApplication: async (...args: readonly unknown[]) => {
      validateNoDesktopApiInput(args);
      await transport.invoke(WHITE_LILY_IPC_CHANNELS.quitApplication);
    },
    readOwnerIdentity: async (...args: readonly unknown[]) => {
      validateNoDesktopApiInput(args);
      return parseOwnerIdentityAuthoritySnapshot(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.readOwnerIdentity),
      );
    },
    updateOwnerIdentity: async (...args: readonly unknown[]) => {
      const command = parseOwnerIdentityUpdateInput(args);
      return parseOwnerIdentityAuthoritySnapshot(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.updateOwnerIdentity, {
          expectedRevision: command.expectedRevision,
          ownerUsername: command.ownerUsername,
        }),
      );
    },
    subscribeOwnerIdentity: (...args: readonly unknown[]) => {
      if (args.length !== 1 || typeof args[0] !== "function") {
        throw new Error("invalid owner identity listener");
      }
      const listener = args[0] as (snapshot: OwnerIdentitySnapshot) => void;
      return transport.subscribe(WHITE_LILY_IPC_CHANNELS.ownerIdentityEvent, (value) => {
        try {
          listener(parseOwnerIdentityAuthoritySnapshot(value));
        } catch {
          // Malformed owner identity events are stopped at the preload boundary.
        }
      });
    },
    getAccount,
    startChatGptLogin: async () => {
      const snapshot = parseAccountSnapshot(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin),
      );
      if (snapshot.status !== "pending") throw new Error("invalid login attempt");
      return snapshot;
    },
    cancelChatGptLogin: async (attemptId: string) => {
      const command = parseDesktopRequest({
        version: 1,
        id: "preload",
        command: { kind: "cancel_chatgpt_login", attemptId },
      }).command;
      if (command.kind !== "cancel_chatgpt_login") throw new Error("invalid login attempt");
      return parseAccountSnapshot(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.cancelChatGptLogin, command.attemptId),
      );
    },
    listModels: async () =>
      parseDesktopCommandResult(
        { kind: "list_models" },
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.listModels),
      ),
    migrateModelPreference: async (candidate: ModelSelectionInput | null) => {
      const command = parseDesktopRequest({
        version: 1,
        id: "preload",
        command: { kind: "migrate_model_preference", candidate },
      }).command;
      if (command.kind !== "migrate_model_preference") {
        throw new Error("invalid model migration candidate");
      }
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.migrateModelPreference, command.candidate),
      );
    },
    selectModel: async (selection: ModelSelectionInput) => {
      const command = parseDesktopRequest({
        version: 1,
        id: "preload",
        command: { kind: "select_model", selection },
      }).command;
      if (command.kind !== "select_model") throw new Error("invalid model selection");
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.selectModel, command.selection),
      );
    },
    discoverPcl2: async () =>
      parsePcl2Candidates(await transport.invoke(WHITE_LILY_IPC_CHANNELS.discoverPcl2)),
    detectLanCandidates: async () =>
      parseLanCandidates(await transport.invoke(WHITE_LILY_IPC_CHANNELS.detectLanCandidates)),
    confirmLanCandidate: async (candidateId: string) => {
      if (!isLanCandidateId(candidateId)) throw new Error("invalid LAN candidate");
      return parseConfirmedLanSession(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.confirmLanCandidate, candidateId),
      );
    },
    getMinecraftComponentStatus: async (...args: readonly unknown[]) => {
      const candidateId = parseMinecraftComponentCandidateInput(args);
      return parseMinecraftComponentStatus(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.getMinecraftComponentStatus, candidateId),
      );
    },
    installMinecraftComponents: async (...args: readonly unknown[]) => {
      const { candidateId, selection } = parseMinecraftComponentOperationInput(args);
      return parseMinecraftComponentStatus(
        await transport.invoke(
          WHITE_LILY_IPC_CHANNELS.installMinecraftComponents,
          candidateId,
          selection,
        ),
      );
    },
    removeMinecraftComponents: async (...args: readonly unknown[]) => {
      const { candidateId, selection } = parseMinecraftComponentOperationInput(args);
      return parseMinecraftComponentStatus(
        await transport.invoke(
          WHITE_LILY_IPC_CHANNELS.removeMinecraftComponents,
          candidateId,
          selection,
        ),
      );
    },
    bindConfirmedWorld: async (input: { expectedRevision: number; label: string }) =>
      invokeCommand(
        WHITE_LILY_IPC_CHANNELS.bindConfirmedWorld,
        { kind: "bind_confirmed_world", ...input },
        input,
      ),
    readProfile: () => invokeCommand(WHITE_LILY_IPC_CHANNELS.readProfile, { kind: "read_profile" }),
    updateProfile: async (input: { expectedRevision: number; profile: CompanionProfile }) => {
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: { kind: "update_profile", ...input },
      }).command;
      if (command.kind !== "update_profile") throw new Error("invalid profile update");
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.updateProfile, {
          expectedRevision: command.expectedRevision,
          profile: command.profile,
        }),
      );
    },
    setBehaviorMode: async (input: {
      expectedRevision: number;
      mode: CompanionMode;
      settings: BehaviorModeSettings;
    }) => {
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: { kind: "set_behavior_mode", ...input },
      }).command;
      if (command.kind !== "set_behavior_mode") throw new Error("invalid behavior mode");
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.setBehaviorMode, {
          expectedRevision: command.expectedRevision,
          mode: command.mode,
          settings: command.settings,
        }),
      );
    },
    readMemories: () =>
      invokeCommand(WHITE_LILY_IPC_CHANNELS.readMemories, { kind: "read_memories" }),
    searchMemories: async (input: { query: string; scope: MemoryContextScope }) => {
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: { kind: "search_memories", ...input },
      }).command;
      if (command.kind !== "search_memories") throw new Error("invalid memory search");
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.searchMemories, {
          query: command.query,
          scope: command.scope,
        }),
      );
    },
    addMemory: async (input: { expectedRevision: number; memory: RendererMemoryInput }) => {
      if (
        typeof input !== "object" ||
        input === null ||
        typeof input.memory !== "object" ||
        input.memory === null ||
        Object.hasOwn(input.memory, "worldId")
      ) {
        throw new Error("invalid memory");
      }
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: {
          kind: "add_memory",
          expectedRevision: input.expectedRevision,
          memory: input.memory,
        },
      }).command;
      if (command.kind !== "add_memory") throw new Error("invalid memory");
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.addMemory, {
          expectedRevision: command.expectedRevision,
          memory: command.memory,
        }),
      );
    },
    updateMemory: async (input: {
      id: number;
      expectedRevision: number;
      recordRevision: number;
      patch: RendererMemoryPatch;
    }) => {
      if (
        typeof input !== "object" ||
        input === null ||
        typeof input.patch !== "object" ||
        input.patch === null ||
        Object.hasOwn(input.patch, "worldId")
      ) {
        throw new Error("invalid memory update");
      }
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: { kind: "update_memory", ...input },
      }).command;
      if (command.kind !== "update_memory") throw new Error("invalid memory update");
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.updateMemory, {
          id: command.id,
          expectedRevision: command.expectedRevision,
          recordRevision: command.recordRevision,
          patch: command.patch,
        }),
      );
    },
    forgetMemory: async (input: {
      id: number;
      expectedRevision: number;
      recordRevision: number;
    }) => {
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: { kind: "forget_memory", ...input },
      }).command;
      if (command.kind !== "forget_memory") throw new Error("invalid memory delete");
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.forgetMemory, {
          id: command.id,
          expectedRevision: command.expectedRevision,
          recordRevision: command.recordRevision,
        }),
      );
    },
    pinMemory: async (input: {
      id: number;
      expectedRevision: number;
      recordRevision: number;
      pinned: boolean;
    }) => {
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: { kind: "pin_memory", ...input },
      }).command;
      if (command.kind !== "pin_memory") throw new Error("invalid memory pin");
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.pinMemory, {
          id: command.id,
          expectedRevision: command.expectedRevision,
          recordRevision: command.recordRevision,
          pinned: command.pinned,
        }),
      );
    },
    setMemoryScope: async (scope: MemoryContextScope) => {
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: { kind: "set_memory_scope", scope: normalizeMemoryScope(scope) },
      }).command;
      if (command.kind !== "set_memory_scope") throw new Error("invalid memory scope");
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.setMemoryScope, command.scope),
      );
    },
    previewMemoryMigration: async (scope: "global" | "world") => {
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: { kind: "preview_memory_migration", scope },
      }).command;
      if (command.kind !== "preview_memory_migration") {
        throw new Error("invalid memory migration preview");
      }
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.previewMemoryMigration, command.scope),
      );
    },
    commitMemoryMigration: async (input: { migrationId: string; sourceRevision: number }) => {
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: { kind: "commit_memory_migration", ...input },
      }).command;
      if (command.kind !== "commit_memory_migration") {
        throw new Error("invalid memory migration commit");
      }
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.commitMemoryMigration, {
          migrationId: command.migrationId,
          sourceRevision: command.sourceRevision,
        }),
      );
    },
    rollbackMemoryMigration: async (migrationId: string) => {
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: { kind: "rollback_memory_migration", migrationId },
      }).command;
      if (command.kind !== "rollback_memory_migration") {
        throw new Error("invalid memory migration rollback");
      }
      return parseDesktopCommandResult(
        command,
        await transport.invoke(
          WHITE_LILY_IPC_CHANNELS.rollbackMemoryMigration,
          command.migrationId,
        ),
      );
    },
    exportMemories: async () =>
      parseExportResult(await transport.invoke(WHITE_LILY_IPC_CHANNELS.exportMemories)),
    previewDiagnostics: () =>
      invokeCommand(WHITE_LILY_IPC_CHANNELS.previewDiagnostics, {
        kind: "preview_diagnostics",
      }),
    exportDiagnostics: async (exportId: string) => {
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: { kind: "prepare_diagnostic_archive", exportId },
      }).command;
      if (command.kind !== "prepare_diagnostic_archive") {
        throw new Error("invalid diagnostic export");
      }
      return parseExportResult(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.exportDiagnostics, command.exportId),
      );
    },
    readWorldProfile: () =>
      invokeCommand(WHITE_LILY_IPC_CHANNELS.readWorldProfile, {
        kind: "read_world_profile",
      }),
    updateSafetyProfile: async (input: {
      expectedRevision: number;
      safetyPreset: SafetyPreset;
    }) => {
      const command = parseDesktopRequest({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "preload",
        command: { kind: "update_safety_profile", ...input },
      }).command;
      if (command.kind !== "update_safety_profile") throw new Error("invalid safety preset");
      return parseDesktopCommandResult(
        command,
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.updateSafetyProfile, {
          expectedRevision: command.expectedRevision,
          safetyPreset: command.safetyPreset,
        }),
      );
    },
    readStartupSetting: async () =>
      parseStartupSetting(await transport.invoke(WHITE_LILY_IPC_CHANNELS.readStartupSetting)),
    setStartupSetting: async (enabled: boolean) => {
      assertBooleanSetting(enabled);
      return parseStartupSetting(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.setStartupSetting, enabled),
      );
    },
    readCloseToTraySetting: async () =>
      parseRevisionedBooleanSetting(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.readCloseToTraySetting),
      ),
    setCloseToTraySetting: async (input: { expectedRevision: number; enabled: boolean }) => {
      const parsed = parseRevisionedBooleanSettingInput(input);
      return parseRevisionedBooleanSetting(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.setCloseToTraySetting, parsed),
      );
    },
    listAvatarModels: async (...args: readonly unknown[]) => {
      if (args.length !== 0) throw new Error("invalid avatar list input");
      return parseAvatarCatalogSnapshot(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.listAvatarModels),
      );
    },
    importAvatarModel: async (...args: readonly unknown[]) => {
      if (args.length !== 0) throw new Error("invalid avatar import input");
      return parseAvatarImportResult(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.importAvatarModel),
      );
    },
    switchAvatarModel: async (...args: readonly unknown[]) => {
      if (args.length !== 1) throw new Error("invalid avatar model selection");
      let modelId: string;
      try {
        modelId = parseAvatarModelId(args[0]);
      } catch {
        throw new Error("invalid avatar model selection");
      }
      return parseAvatarCatalogSnapshot(
        await transport.invoke(WHITE_LILY_IPC_CHANNELS.switchAvatarModel, modelId),
      );
    },
    subscribeAvatarModels: (...args: readonly unknown[]) => {
      if (args.length !== 1 || typeof args[0] !== "function") {
        throw new Error("invalid avatar model listener");
      }
      const listener = args[0] as (snapshot: AvatarModelCatalogSnapshot) => void;
      return transport.subscribe(WHITE_LILY_IPC_CHANNELS.avatarModelsEvent, (value) => {
        try {
          listener(parseAvatarCatalogSnapshot(value));
        } catch {
          // Malformed avatar catalog events are stopped at the preload boundary.
        }
      });
    },
    subscribeRuntime: (listener: (event: DesktopRendererEvent) => void) =>
      transport.subscribe(WHITE_LILY_IPC_CHANNELS.runtimeEvent, (value) => {
        try {
          listener(parseDesktopRendererEvent(value));
        } catch {
          // Malformed events are stopped at the preload boundary.
        }
      }),
  });
}

export function parseAvatarCatalogSnapshot(value: unknown): AvatarModelCatalogSnapshot {
  try {
    let record: Record<string, unknown>;
    try {
      record = readExactPlainDataObject(value, ["revision", "models", "activeModelId"]);
    } catch {
      record = readExactPlainDataObject(value, [
        "revision",
        "models",
        "activeModelId",
        "pendingModelId",
      ]);
    }
    const models = readExactDataArray(record.models, 1_024, "invalid avatar model catalog").map(
      (model) =>
        parseAvatarModelListItem(
          readExactPlainDataObject(model, [
            "id",
            "displayName",
            "origin",
            "format",
            "previewDataUrl",
            "bodyAnimation",
            "expressions",
          ]),
        ),
    );
    return parseSharedAvatarModelCatalogSnapshot({
      revision: record.revision,
      models,
      activeModelId: record.activeModelId,
      ...(Object.hasOwn(record, "pendingModelId") ? { pendingModelId: record.pendingModelId } : {}),
    });
  } catch {
    throw new Error("invalid avatar model catalog");
  }
}

export function parseAvatarImportResult(
  value: unknown,
):
  | { readonly status: "cancelled" }
  | { readonly status: "imported"; readonly model: AvatarModelListItem } {
  try {
    try {
      const cancelled = readExactPlainDataObject(value, ["status"]);
      if (cancelled.status !== "cancelled") throw new Error("invalid avatar import result");
      return Object.freeze({ status: "cancelled" });
    } catch {
      const imported = readExactPlainDataObject(value, ["status", "model"]);
      if (imported.status !== "imported") throw new Error("invalid avatar import result");
      return Object.freeze({
        status: "imported",
        model: parseAvatarModelListItem(
          readExactPlainDataObject(imported.model, [
            "id",
            "displayName",
            "origin",
            "format",
            "previewDataUrl",
            "bodyAnimation",
            "expressions",
          ]),
        ),
      });
    }
  } catch {
    throw new Error("invalid avatar import result");
  }
}

function parseExportResult(value: unknown): { status: "cancelled" | "saved" } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "status" ||
    ((value as { status?: unknown }).status !== "cancelled" &&
      (value as { status?: unknown }).status !== "saved")
  ) {
    throw new Error("invalid export result");
  }
  return Object.freeze({ status: (value as { status: "cancelled" | "saved" }).status });
}

function parseStartupSetting(value: unknown): { enabled: boolean; available: boolean } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "available,enabled" ||
    typeof (value as { enabled?: unknown }).enabled !== "boolean" ||
    typeof (value as { available?: unknown }).available !== "boolean"
  ) {
    throw new Error("invalid startup setting");
  }
  const setting = value as { enabled: boolean; available: boolean };
  if (!setting.available && setting.enabled) throw new Error("invalid startup setting");
  return Object.freeze({ enabled: setting.enabled, available: setting.available });
}

function parseBooleanSetting(value: unknown): { enabled: boolean } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "enabled" ||
    typeof (value as { enabled?: unknown }).enabled !== "boolean"
  ) {
    throw new Error("invalid setting");
  }
  return Object.freeze({ enabled: (value as { enabled: boolean }).enabled });
}

function parseRevisionedBooleanSetting(value: unknown): { revision: number; enabled: boolean } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    typeof Reflect.get(value, "enabled") !== "boolean" ||
    !Number.isSafeInteger(Reflect.get(value, "revision")) ||
    (Reflect.get(value, "revision") as number) < 0
  ) {
    throw new Error("invalid boolean setting");
  }
  return {
    revision: Reflect.get(value, "revision") as number,
    enabled: Reflect.get(value, "enabled") as boolean,
  };
}

function parseRevisionedBooleanSettingInput(value: unknown): {
  expectedRevision: number;
  enabled: boolean;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    typeof Reflect.get(value, "enabled") !== "boolean" ||
    !Number.isSafeInteger(Reflect.get(value, "expectedRevision")) ||
    (Reflect.get(value, "expectedRevision") as number) < 0
  ) {
    throw new Error("invalid boolean setting");
  }
  return {
    expectedRevision: Reflect.get(value, "expectedRevision") as number,
    enabled: Reflect.get(value, "enabled") as boolean,
  };
}

function assertBooleanSetting(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error("invalid setting");
}

export function parseRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  try {
    return parseDesktopCommandResult({ kind: "get_status" }, value);
  } catch {
    throw new Error("invalid runtime snapshot");
  }
}

export function parseRuntimeEvent(value: unknown): RuntimeEvent {
  const event = parseDesktopRendererEvent(value);
  if (event.kind === "connection_invalidated") throw new Error("invalid runtime event");
  return event;
}

export function parseDesktopRendererEvent(value: unknown): DesktopRendererEvent {
  try {
    const event = parseDesktopEvent({
      version: DESKTOP_PROTOCOL_VERSION,
      event: value,
    }).event;
    if (event.kind === "account" || event.kind === "owner_identity") {
      throw new Error("not a runtime renderer event");
    }
    return event;
  } catch {
    throw new Error("invalid renderer event");
  }
}

export function parseOwnerIdentitySnapshot(value: unknown): OwnerIdentitySnapshot {
  try {
    const snapshot = parseDesktopCommandResult({ kind: "read_owner_identity" }, value);
    if (snapshot.ownerUsername !== null) {
      parseMinecraftJavaUsername(snapshot.ownerUsername);
    }
    return snapshot;
  } catch {
    throw new Error("invalid owner identity snapshot");
  }
}

export function parseOwnerIdentityAuthoritySnapshot(
  value: unknown,
): OwnerIdentityAuthoritySnapshot {
  try {
    const record = readExactPlainDataObject(value, [
      "revision",
      "ownerUsername",
      "configured",
      "presence",
      "childGeneration",
    ]);
    if (!Number.isSafeInteger(record.childGeneration) || (record.childGeneration as number) < 1) {
      throw new Error("invalid owner child generation");
    }
    const owner = parseOwnerIdentitySnapshot({
      revision: record.revision,
      ownerUsername: record.ownerUsername,
      configured: record.configured,
      presence: record.presence,
    });
    return Object.freeze({
      ...owner,
      childGeneration: record.childGeneration as number,
    });
  } catch {
    throw new Error("invalid owner identity snapshot");
  }
}

function validateNoDesktopApiInput(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("invalid owner identity input");
}

function parseOwnerIdentityUpdateInput(
  args: readonly unknown[],
): Extract<DesktopCommand, { kind: "update_owner_identity" }> {
  if (args.length !== 1) throw new Error("invalid owner identity input");
  const input = readExactPlainDataObject(args[0], ["expectedRevision", "ownerUsername"]);
  try {
    const command = parseDesktopRequest({
      version: DESKTOP_PROTOCOL_VERSION,
      id: "preload",
      command: {
        kind: "update_owner_identity",
        expectedRevision: input.expectedRevision,
        ownerUsername: input.ownerUsername,
      },
    }).command;
    if (command.kind !== "update_owner_identity") {
      throw new Error("invalid owner identity input");
    }
    parseMinecraftJavaUsername(command.ownerUsername);
    return command;
  } catch {
    throw new Error("invalid owner identity input");
  }
}

function readExactPlainDataObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid owner identity input");
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  } catch {
    throw new Error("invalid owner identity input");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    prototype !== Object.prototype ||
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(descriptors, field)) ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    throw new Error("invalid owner identity input");
  }
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field]!;
    if (!Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new Error("invalid owner identity input");
    }
    result[field] = descriptor.value;
  }
  return result;
}

export function parseAccountSnapshot(value: unknown): AccountSnapshot {
  try {
    return parseDesktopCommandResult({ kind: "get_account" }, value);
  } catch {
    throw new Error("invalid account snapshot");
  }
}

export function parsePcl2Candidates(value: unknown): readonly Pcl2Candidate[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("invalid PCL2 candidates");
  }
  const candidateIds = new Set<string>();
  const candidates: Pcl2Candidate[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("invalid PCL2 candidates");
    }
    const candidate = item as Record<string, unknown>;
    if (
      Object.keys(candidate).sort().join(",") !== "displayPath,id,running,source" ||
      typeof candidate.id !== "string" ||
      !/^[A-Za-z0-9_-]{16,64}$/u.test(candidate.id) ||
      candidateIds.has(candidate.id) ||
      candidate.displayPath !== "Plain Craft Launcher 2.exe" ||
      typeof candidate.running !== "boolean" ||
      !(
        candidate.source === "known_location" ||
        candidate.source === "start_menu" ||
        candidate.source === "running_process"
      )
    ) {
      throw new Error("invalid PCL2 candidates");
    }
    candidateIds.add(candidate.id);
    candidates.push(
      Object.freeze({
        id: candidate.id,
        displayPath: candidate.displayPath,
        source: candidate.source,
        running: candidate.running,
      }),
    );
  }
  return Object.freeze(candidates);
}

export function parseLanCandidates(value: unknown): readonly LanCandidate[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("invalid LAN candidates");
  const ids = new Set<string>();
  const candidates: LanCandidate[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("invalid LAN candidates");
    }
    const candidate = item as Record<string, unknown>;
    if (
      Object.keys(candidate).sort().join(",") !== "expiresAt,id,observedAt,port,version" ||
      !isLanCandidateId(candidate.id) ||
      ids.has(candidate.id) ||
      !isMinecraftPort(candidate.port) ||
      !isSafeVersion(candidate.version) ||
      !isTimestamp(candidate.observedAt) ||
      !isTimestamp(candidate.expiresAt) ||
      candidate.expiresAt <= candidate.observedAt ||
      candidate.expiresAt - candidate.observedAt > 60_000
    ) {
      throw new Error("invalid LAN candidates");
    }
    ids.add(candidate.id);
    candidates.push(
      Object.freeze({
        id: candidate.id,
        port: candidate.port,
        version: candidate.version,
        observedAt: candidate.observedAt,
        expiresAt: candidate.expiresAt,
      }),
    );
  }
  return Object.freeze(candidates);
}

export function parseConfirmedLanSession(value: unknown): ConfirmedLanSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid confirmed LAN session");
  }
  const session = value as Record<string, unknown>;
  if (
    Object.keys(session).sort().join(",") !== "confirmedAt,port,status,version" ||
    session.status !== "confirmed" ||
    !isMinecraftPort(session.port) ||
    !isSafeVersion(session.version) ||
    !isTimestamp(session.confirmedAt)
  ) {
    throw new Error("invalid confirmed LAN session");
  }
  return Object.freeze({
    status: "confirmed",
    port: session.port,
    version: session.version,
    confirmedAt: session.confirmedAt,
  });
}

export function parseMinecraftComponentStatus(value: unknown): MinecraftComponentStatus {
  const fields = [
    "state",
    "bridgeInstalled",
    "bridgeActive",
    "avatarInstalled",
    "restartRequired",
  ] as const;
  const record = readExactDataRecord(value, fields, "invalid Minecraft component status");
  const state = record.state;
  if (
    !isMinecraftComponentState(state) ||
    typeof record.bridgeInstalled !== "boolean" ||
    typeof record.bridgeActive !== "boolean" ||
    typeof record.avatarInstalled !== "boolean" ||
    typeof record.restartRequired !== "boolean"
  ) {
    throw new Error("invalid Minecraft component status");
  }
  const status = {
    state,
    bridgeInstalled: record.bridgeInstalled,
    bridgeActive: record.bridgeActive,
    avatarInstalled: record.avatarInstalled,
    restartRequired: record.restartRequired,
  } satisfies MinecraftComponentStatus;
  if (!isConsistentMinecraftComponentStatus(status)) {
    throw new Error("invalid Minecraft component status");
  }
  return Object.freeze(status);
}

function parseMinecraftComponentCandidateInput(args: readonly unknown[]): string {
  if (args.length !== 1 || !isLanCandidateId(args[0])) {
    throw new Error("invalid Minecraft component input");
  }
  return args[0];
}

function parseMinecraftComponentOperationInput(args: readonly unknown[]): {
  candidateId: string;
  selection: readonly MinecraftComponentId[];
} {
  if (args.length !== 2 || !isLanCandidateId(args[0])) {
    throw new Error("invalid Minecraft component input");
  }
  const selection = parseMinecraftComponentSelection(args[1]);
  return Object.freeze({ candidateId: args[0], selection });
}

function parseMinecraftComponentSelection(value: unknown): readonly MinecraftComponentId[] {
  if (!Array.isArray(value) || value.length > 2) {
    throw new Error("invalid Minecraft component input");
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  } catch {
    throw new Error("invalid Minecraft component input");
  }
  const expectedKeys = [
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
    "length",
  ];
  const keys = Reflect.ownKeys(descriptors);
  if (
    prototype !== Array.prototype ||
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key)) ||
    descriptors.length?.value !== value.length
  ) {
    throw new Error("invalid Minecraft component input");
  }
  const selected = new Set<MinecraftComponentId>();
  const result: MinecraftComponentId[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new Error("invalid Minecraft component input");
    }
    const component = descriptor.value;
    if (
      (component !== "bridge" && component !== "avatar") ||
      selected.has(component as MinecraftComponentId)
    ) {
      throw new Error("invalid Minecraft component input");
    }
    selected.add(component);
    result.push(component);
  }
  return Object.freeze(result);
}

function readExactDataRecord<const K extends readonly string[]>(
  value: unknown,
  fields: K,
  message: string,
): { [P in K[number]]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  } catch {
    throw new Error(message);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    prototype !== Object.prototype ||
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(descriptors, field)) ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    throw new Error(message);
  }
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field]!;
    if (!Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new Error(message);
    }
    result[field] = descriptor.value;
  }
  return result as { [P in K[number]]: unknown };
}

function readExactDataArray(value: unknown, maximum: number, message: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(message);
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  } catch {
    throw new Error(message);
  }
  const expectedKeys = [
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
    "length",
  ];
  const keys = Reflect.ownKeys(descriptors);
  if (
    prototype !== Array.prototype ||
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key)) ||
    descriptors.length?.value !== value.length
  ) {
    throw new Error(message);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new Error(message);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function isMinecraftComponentState(value: unknown): value is MinecraftComponentState {
  return (
    value === "bridge_not_installed" ||
    value === "bridge_restart_required" ||
    value === "bridge_not_active" ||
    value === "bridge_version_unsupported" ||
    value === "bridge_file_conflict" ||
    value === "avatar_not_installed" ||
    value === "avatar_restart_required" ||
    value === "ready"
  );
}

function isConsistentMinecraftComponentStatus(value: MinecraftComponentStatus): boolean {
  const flags = `${Number(value.bridgeInstalled)}${Number(value.bridgeActive)}${Number(
    value.avatarInstalled,
  )}${Number(value.restartRequired)}`;
  switch (value.state) {
    case "bridge_not_installed":
    case "bridge_file_conflict":
      return flags === "0000";
    case "bridge_version_unsupported":
      return flags === "0000" || flags === "1000";
    case "bridge_restart_required":
      return flags === "1001";
    case "bridge_not_active":
      return flags === "1000";
    case "avatar_not_installed":
      return flags === "1100";
    case "avatar_restart_required":
      return flags === "1111";
    case "ready":
      return flags === "1110";
  }
}

function isLanCandidateId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/u.test(value);
}

function isMinecraftPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafeVersion(value: unknown): value is string {
  return value === "unknown" || value === "1.21.5";
}

declare global {
  interface Window {
    whiteLily: WhiteLilyAppApi;
  }
}

function normalizeMemoryScope(
  scope: MemoryContextScope,
): { mode: "global" } | { mode: "world"; worldId: string } | { mode: "layered"; worldId: string } {
  if (!scope || typeof scope !== "object") throw new Error("invalid memory scope");
  if (scope.mode === "global") return { mode: "global" };
  if ((scope.mode === "world" || scope.mode === "layered") && typeof scope.worldId === "string") {
    return { mode: scope.mode, worldId: scope.worldId };
  }
  throw new Error("invalid memory scope");
}
