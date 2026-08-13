import {
  DESKTOP_PROTOCOL_VERSION,
  parseDesktopCommandResult,
  parseDesktopEvent,
  parseDesktopRequest,
  type DesktopCommand,
  type DesktopCommandResult,
  type DesktopEvent,
} from "../../../src/desktop/desktopProtocol.js";
import type { RuntimeSnapshot } from "../../../src/runtime/runtimeEvents.js";
import {
  parseMinecraftJavaUsername,
  type OwnerIdentitySnapshot,
} from "../../../src/identity/ownerIdentity.js";
import { DocumentStoreError } from "../../../src/storage/documentStore.js";
import type { ConfirmedWorldBinding } from "../../../src/world/worldProfileStore.js";
import type { ExternalUrlPolicy } from "./externalUrlPolicy.js";
import type { Pcl2Candidate } from "./discovery/pcl2Discovery.js";
import { isOpaqueLanId } from "./discovery/lanCandidateStore.js";
import type {
  ConfirmedConnectionProof,
  ConfirmedLanSession,
  ConfiguredConnectionResult,
  LanCandidate,
} from "./discovery/lanDetector.js";
import {
  parseConfirmedLanSession,
  parseDesktopRendererEvent,
  parseLanCandidates,
  parseMinecraftComponentStatus,
  parseOwnerIdentityAuthoritySnapshot,
  parseOwnerIdentitySnapshot,
  parsePcl2Candidates,
  parseRuntimeSnapshot,
  WHITE_LILY_IPC_CHANNELS,
  type DesktopRendererEvent,
  type OwnerIdentityAuthoritySnapshot,
} from "../src/desktopApi.js";
import type { MinecraftComponentId, MinecraftComponentManager } from "./minecraftComponents.js";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

export interface IpcMainPort {
  handle(channel: string, handler: IpcHandler): void;
  removeHandler(channel: string): void;
}

export interface IpcSupervisor {
  request<C extends DesktopCommand>(command: C): Promise<DesktopCommandResult<C>>;
  bindConfirmedWorld?(
    binding: ConfirmedWorldBinding,
    intent: Extract<DesktopCommand, { kind: "bind_confirmed_world" }>,
  ): Promise<DesktopCommandResult<Extract<DesktopCommand, { kind: "bind_confirmed_world" }>>>;
  stopTask(): Promise<RuntimeSnapshot>;
  emergencyStop(): Promise<RuntimeSnapshot>;
  activeChildGeneration(): number;
  subscribe(
    listener: (event: DesktopEvent["event"], context: { readonly childGeneration: number }) => void,
  ): () => void;
}

export interface IpcRegistryOptions {
  ipcMain: IpcMainPort;
  supervisor: IpcSupervisor;
  publishRuntime: (event: DesktopRendererEvent) => void;
  publishOwnerIdentity: (owner: OwnerIdentityAuthoritySnapshot) => void;
  externalUrlPolicy: ExternalUrlPolicy;
  openExternal(url: string): Promise<unknown>;
  pcl2Discovery: {
    discoverPcl2(): Promise<readonly Pcl2Candidate[]>;
  };
  lanDetector: {
    detectLanCandidates(): Promise<readonly LanCandidate[]>;
    confirmLanCandidate(
      candidateId: string,
      applyProof: (proof: ConfirmedConnectionProof) => Promise<ConfiguredConnectionResult>,
    ): Promise<ConfirmedLanSession>;
    validateConfirmedSession(): Promise<boolean>;
    stop(): void;
  };
  worldAuthority?: {
    redeem(proof: ConfirmedConnectionProof): Promise<ConfirmedWorldBinding>;
  };
  minecraftComponentManager?: MinecraftComponentManager;
  startupSettings?: {
    read(): { enabled: boolean; available: boolean };
    set(enabled: boolean): { enabled: boolean; available: boolean };
  };
  closeToTraySettings?: {
    read(): Promise<{ revision: number; enabled: boolean }>;
    set(
      expectedRevision: number,
      enabled: boolean,
    ): Promise<{ revision: number; enabled: boolean }>;
  };
  requestApplicationQuit?: () => Promise<void>;
  exportSerialized?(serialized: string): Promise<{ status: "cancelled" | "saved" }>;
  exportDiagnostic?(
    exportId: string,
    prepareArchive: () => Promise<{ exportId: string; size: number; sha256: string }>,
  ): Promise<{ status: "cancelled" | "saved" }>;
}

const LAN_REVALIDATION_INTERVAL_MS = 2_000;

const invocationCommands = {
  [WHITE_LILY_IPC_CHANNELS.status]: { kind: "get_status" },
  [WHITE_LILY_IPC_CHANNELS.start]: { kind: "start_runtime" },
  [WHITE_LILY_IPC_CHANNELS.stop]: { kind: "stop_runtime" },
} as const satisfies Readonly<Record<string, DesktopCommand>>;

type PendingLoginAttempt = Extract<
  DesktopCommandResult<{ kind: "start_chatgpt_login" }>["attempt"],
  { status: "pending" }
>;

interface LoginOpenOperation {
  attempt: PendingLoginAttempt;
  generation: number;
  loginUrl: string;
  openPromise: Promise<PendingLoginAttempt>;
  resolveOpen(attempt: PendingLoginAttempt): void;
  rejectOpen(error: Error): void;
  settled: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export function registerIpcHandlers(options: IpcRegistryOptions): () => void {
  const invocationChannels = Object.keys(invocationCommands) as Array<
    keyof typeof invocationCommands
  >;
  const registeredChannels: string[] = [];
  let unsubscribe = (): void => undefined;
  const inFlightOpens = new Map<string, LoginOpenOperation>();
  let activeLogin: LoginOpenOperation | undefined;
  let loginGeneration = 0;
  let lanMonitorGeneration = 0;
  let lanMonitor: ReturnType<typeof setInterval> | undefined;
  let lanValidationInFlight = false;
  let cleaned = false;
  let confirmedWorldProof: ConfirmedConnectionProof | undefined;
  const stopLanMonitor = (): void => {
    lanMonitorGeneration += 1;
    if (lanMonitor) clearInterval(lanMonitor);
    lanMonitor = undefined;
    lanValidationInFlight = false;
  };
  const startLanMonitor = (): void => {
    stopLanMonitor();
    const generation = lanMonitorGeneration;
    lanMonitor = setInterval(() => {
      if (cleaned || generation !== lanMonitorGeneration || lanValidationInFlight) return;
      lanValidationInFlight = true;
      void Promise.resolve()
        .then(() => options.lanDetector.validateConfirmedSession())
        .catch(() => false)
        .then(async (valid) => {
          if (cleaned || generation !== lanMonitorGeneration || valid) return;
          stopLanMonitor();
          await options.supervisor
            .request({ kind: "invalidate_connection", reason: "lan_changed" })
            .catch(() => undefined);
        })
        .finally(() => {
          if (generation === lanMonitorGeneration) lanValidationInFlight = false;
        });
    }, LAN_REVALIDATION_INTERVAL_MS);
    lanMonitor.unref?.();
  };
  const isActiveLogin = (operation: LoginOpenOperation): boolean =>
    !cleaned && activeLogin === operation && operation.generation === loginGeneration;
  const settleOpenFailure = (operation: LoginOpenOperation, error: Error): void => {
    if (operation.settled) return;
    operation.settled = true;
    operation.rejectOpen(error);
  };
  const invalidateActiveLogin = (
    expected?: LoginOpenOperation,
    error = new Error("ChatGPT login is no longer active"),
  ): boolean => {
    const operation = activeLogin;
    if (!operation || (expected && operation !== expected)) return false;
    loginGeneration += 1;
    activeLogin = undefined;
    if (operation.expiryTimer) clearTimeout(operation.expiryTimer);
    operation.expiryTimer = undefined;
    options.externalUrlPolicy.clearActiveCodexLoginUrl();
    settleOpenFailure(operation, error);
    return true;
  };
  const createLoginOperation = (
    attempt: PendingLoginAttempt,
    loginUrl: string,
  ): LoginOpenOperation => {
    let resolveOpen!: (value: PendingLoginAttempt) => void;
    let rejectOpen!: (error: Error) => void;
    const openPromise = new Promise<PendingLoginAttempt>((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    return {
      attempt,
      generation: ++loginGeneration,
      loginUrl,
      openPromise,
      resolveOpen,
      rejectOpen,
      settled: false,
    };
  };
  const startOpeningLogin = (operation: LoginOpenOperation): void => {
    const failOpen = async (): Promise<void> => {
      const authoritative = isActiveLogin(operation);
      if (authoritative) {
        invalidateActiveLogin(operation, new Error("Unable to open ChatGPT login"));
        await options.supervisor
          .request({
            kind: "cancel_chatgpt_login",
            attemptId: operation.attempt.attemptId,
          })
          .catch(() => undefined);
      } else {
        settleOpenFailure(operation, new Error("Unable to open ChatGPT login"));
      }
      if (inFlightOpens.get(operation.attempt.attemptId) === operation) {
        inFlightOpens.delete(operation.attempt.attemptId);
      }
    };
    let opening: Promise<unknown>;
    try {
      options.externalUrlPolicy.setActiveCodexLoginUrl(operation.loginUrl);
      opening = Promise.resolve().then(() => options.openExternal(operation.loginUrl));
    } catch {
      opening = Promise.reject(new Error("Unable to open ChatGPT login"));
    }
    void opening.then(
      () => {
        if (isActiveLogin(operation)) {
          operation.expiryTimer = setTimeout(
            () => invalidateActiveLogin(operation),
            Math.max(0, operation.attempt.expiresAt - Date.now()),
          );
          operation.expiryTimer.unref?.();
          if (!operation.settled) {
            operation.settled = true;
            operation.resolveOpen(operation.attempt);
          }
        } else {
          settleOpenFailure(operation, new Error("ChatGPT login is no longer active"));
        }
        if (inFlightOpens.get(operation.attempt.attemptId) === operation) {
          inFlightOpens.delete(operation.attempt.attemptId);
        }
      },
      () => failOpen(),
    );
  };
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    unsubscribe();
    stopLanMonitor();
    invalidateActiveLogin();
    inFlightOpens.clear();
    try {
      options.lanDetector.stop();
    } catch {
      // Discovery teardown cannot retain IPC authority.
    }
    for (const channel of registeredChannels) {
      options.ipcMain.removeHandler(channel);
    }
  };
  try {
    for (const channel of invocationChannels) {
      options.ipcMain.handle(channel, async (_event, ...args) => {
        validateNoIpcInput(args);
        return parseRuntimeSnapshot(await options.supervisor.request(invocationCommands[channel]));
      });
      registeredChannels.push(channel);
    }
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.stopTask, async (_event, ...args) => {
      validateNoIpcInput(args);
      return parseRuntimeSnapshot(await options.supervisor.stopTask());
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.stopTask);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.emergencyStop, async (_event, ...args) => {
      validateNoIpcInput(args);
      return parseRuntimeSnapshot(await options.supervisor.emergencyStop());
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.emergencyStop);
    if (options.requestApplicationQuit) {
      options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.quitApplication, async (_event, ...args) => {
        validateNoIpcInput(args);
        try {
          await options.requestApplicationQuit?.();
        } catch {
          throw new Error("WhiteLily application quit failed");
        }
      });
      registeredChannels.push(WHITE_LILY_IPC_CHANNELS.quitApplication);
    }
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.readOwnerIdentity, async (_event, ...args) => {
      validateNoIpcInput(args);
      const command = { kind: "read_owner_identity" } as const;
      return parseOwnerIdentityAuthoritySnapshot({
        ...parseOwnerIdentitySnapshot(await options.supervisor.request(command)),
        childGeneration: options.supervisor.activeChildGeneration(),
      });
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.readOwnerIdentity);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.updateOwnerIdentity, async (_event, ...args) => {
      const command = parseSingleObjectCommand("update_owner_identity", args);
      return parseOwnerIdentityAuthoritySnapshot({
        ...parseOwnerIdentitySnapshot(await options.supervisor.request(command)),
        childGeneration: options.supervisor.activeChildGeneration(),
      });
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.updateOwnerIdentity);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.getAccount, async (_event, ...args) => {
      validateNoIpcInput(args);
      const command = { kind: "get_account" } as const;
      const account = parseDesktopCommandResult(command, await options.supervisor.request(command));
      if (account.status !== "pending" || account.attemptId !== activeLogin?.attempt.attemptId) {
        invalidateActiveLogin();
      }
      return account;
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.getAccount);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.startChatGptLogin, async (_event, ...args) => {
      validateNoIpcInput(args);
      const command = { kind: "start_chatgpt_login" } as const;
      const result = parseDesktopCommandResult(command, await options.supervisor.request(command));
      if (cleaned) throw new Error("ChatGPT login is no longer active");
      const shared =
        inFlightOpens.get(result.attempt.attemptId) ??
        (activeLogin?.attempt.attemptId === result.attempt.attemptId ? activeLogin : undefined);
      if (shared) return shared.openPromise;
      invalidateActiveLogin();
      const operation = createLoginOperation(result.attempt, result.loginUrl);
      activeLogin = operation;
      inFlightOpens.set(result.attempt.attemptId, operation);
      startOpeningLogin(operation);
      return operation.openPromise;
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.cancelChatGptLogin, async (_event, ...args) => {
      if (args.length !== 1) throw new Error("invalid IPC input");
      const command = parseDesktopRequest({
        version: 1,
        id: "ipc",
        command: { kind: "cancel_chatgpt_login", attemptId: args[0] },
      }).command;
      if (command.kind !== "cancel_chatgpt_login") throw new Error("invalid IPC input");
      if (activeLogin?.attempt.attemptId === command.attemptId) {
        invalidateActiveLogin(activeLogin);
      }
      try {
        return parseDesktopCommandResult(command, await options.supervisor.request(command));
      } finally {
        if (activeLogin?.attempt.attemptId === command.attemptId) {
          invalidateActiveLogin(activeLogin);
        }
      }
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.cancelChatGptLogin);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.listModels, async (_event, ...args) => {
      validateNoIpcInput(args);
      const command = { kind: "list_models" } as const;
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.listModels);
    options.ipcMain.handle(
      WHITE_LILY_IPC_CHANNELS.migrateModelPreference,
      async (_event, ...args) => {
        if (args.length !== 1) throw new Error("invalid IPC input");
        const command = parseDesktopRequest({
          version: 1,
          id: "ipc",
          command: { kind: "migrate_model_preference", candidate: args[0] },
        }).command;
        if (command.kind !== "migrate_model_preference") throw new Error("invalid IPC input");
        return parseDesktopCommandResult(command, await options.supervisor.request(command));
      },
    );
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.migrateModelPreference);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.selectModel, async (_event, ...args) => {
      if (args.length !== 1) throw new Error("invalid IPC input");
      const command = parseDesktopRequest({
        version: 1,
        id: "ipc",
        command: { kind: "select_model", selection: args[0] },
      }).command;
      if (command.kind !== "select_model") throw new Error("invalid IPC input");
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.selectModel);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.discoverPcl2, async (_event, ...args) => {
      validateNoIpcInput(args);
      return parsePcl2Candidates(await options.pcl2Discovery.discoverPcl2());
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.discoverPcl2);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.detectLanCandidates, async (_event, ...args) => {
      validateNoIpcInput(args);
      return parseLanCandidates(await options.lanDetector.detectLanCandidates());
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.detectLanCandidates);
    options.ipcMain.handle(
      WHITE_LILY_IPC_CHANNELS.getMinecraftComponentStatus,
      async (_event, ...args) => {
        const candidateId = parseMinecraftComponentCandidateArgs(args);
        if (!options.minecraftComponentManager) {
          throw new Error("Minecraft component manager is unavailable");
        }
        return parseMinecraftComponentStatus(
          await options.minecraftComponentManager.status(candidateId),
        );
      },
    );
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.getMinecraftComponentStatus);
    options.ipcMain.handle(
      WHITE_LILY_IPC_CHANNELS.installMinecraftComponents,
      async (_event, ...args) => {
        const { candidateId, selection } = parseMinecraftComponentOperationArgs(args);
        if (!options.minecraftComponentManager) {
          throw new Error("Minecraft component manager is unavailable");
        }
        return parseMinecraftComponentStatus(
          await options.minecraftComponentManager.install(candidateId, selection),
        );
      },
    );
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.installMinecraftComponents);
    options.ipcMain.handle(
      WHITE_LILY_IPC_CHANNELS.removeMinecraftComponents,
      async (_event, ...args) => {
        const { candidateId, selection } = parseMinecraftComponentOperationArgs(args);
        if (!options.minecraftComponentManager) {
          throw new Error("Minecraft component manager is unavailable");
        }
        return parseMinecraftComponentStatus(
          await options.minecraftComponentManager.remove(candidateId, selection),
        );
      },
    );
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.removeMinecraftComponents);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.confirmLanCandidate, async (_event, ...args) => {
      if (
        args.length !== 1 ||
        typeof args[0] !== "string" ||
        !/^[A-Za-z0-9_-]{16,64}$/u.test(args[0])
      ) {
        throw new Error("invalid IPC input");
      }
      let appliedProof: ConfirmedConnectionProof | undefined;
      const confirmed = parseConfirmedLanSession(
        await options.lanDetector.confirmLanCandidate(args[0], async (proof) => {
          const command = { kind: "set_confirmed_connection", proof } as const;
          const configured = parseDesktopCommandResult(
            command,
            await options.supervisor.request(command),
          );
          appliedProof = proof;
          return configured;
        }),
      );
      // `confirmLanCandidate` only resolves after the child accepted this proof.
      // The main process retains it privately for a single later world bind.
      confirmedWorldProof = appliedProof;
      if (!cleaned) startLanMonitor();
      return confirmed;
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.confirmLanCandidate);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.bindConfirmedWorld, async (_event, ...args) => {
      if (!options.worldAuthority || !options.supervisor.bindConfirmedWorld) {
        throw new Error("world binding authority is unavailable");
      }
      if (args.length !== 1) throw new Error("invalid IPC input");
      const command = parseDesktopRequest({
        version: 1,
        id: "ipc",
        command: { kind: "bind_confirmed_world", ...(args[0] as object) },
      }).command;
      if (command.kind !== "bind_confirmed_world" || !confirmedWorldProof) {
        throw new Error("world binding is not confirmed");
      }
      const proof = confirmedWorldProof;
      confirmedWorldProof = undefined;
      const binding = await options.worldAuthority.redeem(proof);
      return parseDesktopCommandResult(
        command,
        await options.supervisor.bindConfirmedWorld(binding, command),
      );
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.bindConfirmedWorld);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.readProfile, async (_event, ...args) => {
      validateNoIpcInput(args);
      const command = { kind: "read_profile" } as const;
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.readProfile);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.updateProfile, async (_event, ...args) => {
      const command = parseSingleObjectCommand("update_profile", args);
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.updateProfile);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.setBehaviorMode, async (_event, ...args) => {
      const command = parseSingleObjectCommand("set_behavior_mode", args);
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.setBehaviorMode);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.readMemories, async (_event, ...args) => {
      validateNoIpcInput(args);
      const command = { kind: "read_memories" } as const;
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.readMemories);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.searchMemories, async (_event, ...args) => {
      const command = parseSingleObjectCommand("search_memories", args);
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.searchMemories);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.addMemory, async (_event, ...args) => {
      const input = parseSingleObjectInput(args);
      const memory = parseNestedObject(input, "memory");
      if (Object.hasOwn(memory, "worldId")) throw new Error("invalid IPC input");
      const command = parseDesktopRequest({
        version: 1,
        id: "ipc",
        command: {
          kind: "add_memory",
          ...input,
          memory,
        },
      }).command;
      if (command.kind !== "add_memory") throw new Error("invalid IPC input");
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.addMemory);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.updateMemory, async (_event, ...args) => {
      const input = parseSingleObjectInput(args);
      const patch = parseNestedObject(input, "patch");
      if (Object.hasOwn(patch, "worldId")) throw new Error("invalid IPC input");
      const command = parseDesktopRequest({
        version: 1,
        id: "ipc",
        command: {
          kind: "update_memory",
          ...input,
          patch,
        },
      }).command;
      if (command.kind !== "update_memory") throw new Error("invalid IPC input");
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.updateMemory);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.forgetMemory, async (_event, ...args) => {
      const command = parseSingleObjectCommand("forget_memory", args);
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.forgetMemory);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.pinMemory, async (_event, ...args) => {
      const command = parseSingleObjectCommand("pin_memory", args);
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.pinMemory);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.setMemoryScope, async (_event, ...args) => {
      if (args.length !== 1) throw new Error("invalid IPC input");
      const parsed = parseDesktopRequest({
        version: 1,
        id: "ipc",
        command: { kind: "set_memory_scope", scope: args[0] },
      }).command;
      if (parsed.kind !== "set_memory_scope") throw new Error("invalid IPC input");
      return parseDesktopCommandResult(parsed, await options.supervisor.request(parsed));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.setMemoryScope);
    options.ipcMain.handle(
      WHITE_LILY_IPC_CHANNELS.previewMemoryMigration,
      async (_event, ...args) => {
        if (args.length !== 1) throw new Error("invalid IPC input");
        const command = parseDesktopRequest({
          version: 1,
          id: "ipc",
          command: { kind: "preview_memory_migration", scope: args[0] },
        }).command;
        if (command.kind !== "preview_memory_migration") throw new Error("invalid IPC input");
        return parseDesktopCommandResult(command, await options.supervisor.request(command));
      },
    );
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.previewMemoryMigration);
    options.ipcMain.handle(
      WHITE_LILY_IPC_CHANNELS.commitMemoryMigration,
      async (_event, ...args) => {
        const command = parseSingleObjectCommand("commit_memory_migration", args);
        return parseDesktopCommandResult(command, await options.supervisor.request(command));
      },
    );
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.commitMemoryMigration);
    options.ipcMain.handle(
      WHITE_LILY_IPC_CHANNELS.rollbackMemoryMigration,
      async (_event, ...args) => {
        if (args.length !== 1) throw new Error("invalid IPC input");
        const command = parseDesktopRequest({
          version: 1,
          id: "ipc",
          command: { kind: "rollback_memory_migration", migrationId: args[0] },
        }).command;
        if (command.kind !== "rollback_memory_migration") throw new Error("invalid IPC input");
        return parseDesktopCommandResult(command, await options.supervisor.request(command));
      },
    );
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.rollbackMemoryMigration);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.exportMemories, async (_event, ...args) => {
      validateNoIpcInput(args);
      if (!options.exportSerialized) throw new Error("memory export is unavailable");
      const command = { kind: "export_redacted_memories" } as const;
      const value = parseDesktopCommandResult(command, await options.supervisor.request(command));
      return options.exportSerialized(JSON.stringify(value));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.exportMemories);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.previewDiagnostics, async (_event, ...args) => {
      validateNoIpcInput(args);
      const command = { kind: "preview_diagnostics" } as const;
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.previewDiagnostics);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.exportDiagnostics, async (_event, ...args) => {
      if (!options.exportDiagnostic || args.length !== 1 || typeof args[0] !== "string") {
        throw new Error("invalid IPC input");
      }
      const command = parseDesktopRequest({
        version: 1,
        id: "ipc",
        command: { kind: "prepare_diagnostic_archive", exportId: args[0] },
      }).command;
      if (command.kind !== "prepare_diagnostic_archive") throw new Error("invalid IPC input");
      return options.exportDiagnostic(command.exportId, async () =>
        parseDesktopCommandResult(command, await options.supervisor.request(command)),
      );
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.exportDiagnostics);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.readWorldProfile, async (_event, ...args) => {
      validateNoIpcInput(args);
      const command = { kind: "read_world_profile" } as const;
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.readWorldProfile);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.updateSafetyProfile, async (_event, ...args) => {
      const command = parseSingleObjectCommand("update_safety_profile", args);
      return parseDesktopCommandResult(command, await options.supervisor.request(command));
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.updateSafetyProfile);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.readStartupSetting, async (_event, ...args) => {
      validateNoIpcInput(args);
      if (!options.startupSettings) throw new Error("startup setting is unavailable");
      return options.startupSettings.read();
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.readStartupSetting);
    options.ipcMain.handle(WHITE_LILY_IPC_CHANNELS.setStartupSetting, async (_event, ...args) => {
      const enabled = parseBooleanIpcInput(args);
      if (!options.startupSettings) throw new Error("startup setting is unavailable");
      return options.startupSettings.set(enabled);
    });
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.setStartupSetting);
    options.ipcMain.handle(
      WHITE_LILY_IPC_CHANNELS.readCloseToTraySetting,
      async (_event, ...args) => {
        validateNoIpcInput(args);
        if (!options.closeToTraySettings) throw new Error("close-to-tray setting is unavailable");
        return options.closeToTraySettings.read();
      },
    );
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.readCloseToTraySetting);
    options.ipcMain.handle(
      WHITE_LILY_IPC_CHANNELS.setCloseToTraySetting,
      async (_event, ...args) => {
        const { expectedRevision, enabled } = parseRevisionedBooleanIpcInput(args);
        if (!options.closeToTraySettings) throw new Error("close-to-tray setting is unavailable");
        try {
          return await options.closeToTraySettings.set(expectedRevision, enabled);
        } catch (error) {
          if (error instanceof DocumentStoreError && error.code === "DOCUMENT_CONFLICT") {
            throw new Error("DOCUMENT_CONFLICT: close-to-tray setting changed");
          }
          throw error;
        }
      },
    );
    registeredChannels.push(WHITE_LILY_IPC_CHANNELS.setCloseToTraySetting);
    unsubscribe = options.supervisor.subscribe((value, context) => {
      let event: DesktopEvent["event"];
      try {
        event = parseDesktopEvent({
          version: DESKTOP_PROTOCOL_VERSION,
          event: value,
        }).event;
      } catch {
        // Malformed child events never reach any renderer channel.
        return;
      }
      if (event.kind === "account") {
        if (
          event.account.status !== "pending" ||
          event.account.attemptId !== activeLogin?.attempt.attemptId
        ) {
          invalidateActiveLogin();
        }
        return;
      }
      if (event.kind === "owner_identity") {
        try {
          options.publishOwnerIdentity(
            parseOwnerIdentityAuthoritySnapshot({
              ...parseOwnerIdentitySnapshot(event.owner),
              childGeneration: context.childGeneration,
            }),
          );
        } catch {
          // Invalid owner identity snapshots remain private to the child boundary.
        }
        return;
      }
      try {
        options.publishRuntime(parseDesktopRendererEvent(event));
      } catch {
        // Malformed child events never reach a renderer.
      }
    });
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function validateNoIpcInput(args: readonly unknown[]): void {
  if (args.length !== 0) throw new Error("invalid IPC input");
}

function parseMinecraftComponentCandidateArgs(args: readonly unknown[]): string {
  if (args.length !== 1 || !isOpaqueLanId(args[0])) throw new Error("invalid IPC input");
  return args[0];
}

function parseMinecraftComponentOperationArgs(args: readonly unknown[]): {
  readonly candidateId: string;
  readonly selection: readonly MinecraftComponentId[];
} {
  if (args.length !== 2 || !isOpaqueLanId(args[0])) throw new Error("invalid IPC input");
  const selection = readMinecraftComponentSelection(args[1]);
  return Object.freeze({ candidateId: args[0], selection });
}

function readMinecraftComponentSelection(value: unknown): readonly MinecraftComponentId[] {
  if (!Array.isArray(value) || value.length > 2) throw new Error("invalid IPC input");
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  } catch {
    throw new Error("invalid IPC input");
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
    throw new Error("invalid IPC input");
  }
  const result: MinecraftComponentId[] = [];
  const selected = new Set<MinecraftComponentId>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new Error("invalid IPC input");
    }
    const component = descriptor.value;
    if (
      (component !== "bridge" && component !== "avatar") ||
      selected.has(component as MinecraftComponentId)
    ) {
      throw new Error("invalid IPC input");
    }
    selected.add(component);
    result.push(component);
  }
  return Object.freeze(result);
}

function parseSingleObjectCommand<
  K extends Extract<
    DesktopCommand["kind"],
    | "update_profile"
    | "update_owner_identity"
    | "set_behavior_mode"
    | "search_memories"
    | "add_memory"
    | "update_memory"
    | "forget_memory"
    | "pin_memory"
    | "update_safety_profile"
    | "commit_memory_migration"
  >,
>(kind: K, args: readonly unknown[]): Extract<DesktopCommand, { kind: K }> {
  if (
    args.length !== 1 ||
    typeof args[0] !== "object" ||
    args[0] === null ||
    Array.isArray(args[0])
  ) {
    throw new Error("invalid IPC input");
  }
  let descriptors: PropertyDescriptorMap;
  try {
    if (Object.getPrototypeOf(args[0]) !== Object.prototype) {
      throw new Error("invalid IPC input");
    }
    descriptors = Object.getOwnPropertyDescriptors(args[0]);
  } catch {
    throw new Error("invalid IPC input");
  }
  const input: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new Error("invalid IPC input");
    const descriptor = descriptors[key]!;
    if (!Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new Error("invalid IPC input");
    }
    input[key] = descriptor.value;
  }
  try {
    const command = parseDesktopRequest({
      version: DESKTOP_PROTOCOL_VERSION,
      id: "ipc",
      command: { kind, ...input },
    }).command;
    if (command.kind !== kind) throw new Error("invalid IPC input");
    if (command.kind === "update_owner_identity") {
      parseMinecraftJavaUsername(command.ownerUsername);
    }
    return command as Extract<DesktopCommand, { kind: K }>;
  } catch {
    throw new Error("invalid IPC input");
  }
}

function parseBooleanIpcInput(args: readonly unknown[]): boolean {
  if (args.length !== 1 || typeof args[0] !== "boolean") {
    throw new Error("invalid IPC input");
  }
  return args[0];
}

function parseRevisionedBooleanIpcInput(args: readonly unknown[]): {
  expectedRevision: number;
  enabled: boolean;
} {
  if (args.length !== 1) throw new Error("invalid IPC input");
  const value = args[0];
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    typeof Reflect.get(value, "enabled") !== "boolean" ||
    !Number.isSafeInteger(Reflect.get(value, "expectedRevision")) ||
    (Reflect.get(value, "expectedRevision") as number) < 0
  ) {
    throw new Error("invalid IPC input");
  }
  return {
    expectedRevision: Reflect.get(value, "expectedRevision") as number,
    enabled: Reflect.get(value, "enabled") as boolean,
  };
}

function parseSingleObjectInput(args: readonly unknown[]): Record<string, unknown> {
  if (
    args.length !== 1 ||
    typeof args[0] !== "object" ||
    args[0] === null ||
    Array.isArray(args[0])
  ) {
    throw new Error("invalid IPC input");
  }
  return args[0] as Record<string, unknown>;
}

function parseNestedObject(
  input: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const value = input[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid IPC input");
  }
  return value as Record<string, unknown>;
}
