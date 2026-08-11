// @vitest-environment node

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_PROTOCOL_VERSION,
  parseDesktopRequest,
  type DesktopCommand,
  type DesktopEvent,
  type DesktopResponse,
} from "../../../src/desktop/desktopProtocol.js";
import type { OwnerIdentitySnapshot } from "../../../src/identity/ownerIdentity.js";
import type { RuntimeSnapshot } from "../../../src/runtime/runtimeEvents.js";
import {
  createPreloadTransport,
  createWhiteLilyApi,
  WHITE_LILY_IPC_CHANNELS,
  type IpcRendererPort,
  type DesktopRendererEvent,
  type PreloadTransport,
} from "../src/desktopApi.js";
import { createMainWindowOptions } from "./main.js";
import { ChildSupervisor, type ChildProcessPort, type SpawnChild } from "./childSupervisor.js";
import { ExternalUrlPolicy } from "./externalUrlPolicy.js";
import { registerIpcHandlers, type IpcMainPort, type IpcSupervisor } from "./ipcRegistry.js";
import type { MinecraftComponentManager, MinecraftComponentStatus } from "./minecraftComponents.js";
import { WorldBindingAuthority } from "./discovery/worldBindingAuthority.js";

const idleSnapshot: RuntimeSnapshot = {
  revision: 0,
  lifecycle: "idle",
  minecraft: { state: "disconnected", sessionId: null },
  codex: { state: "stopped", model: null },
  actions: null,
  task: null,
  lastError: null,
};

const ownerSnapshot: OwnerIdentitySnapshot = {
  revision: 7,
  ownerUsername: "NewOwner",
  configured: true,
  presence: "online",
};
const ownerAuthoritySnapshot = { ...ownerSnapshot, childGeneration: 7 };

const pcl2Candidates = [
  {
    id: "pcl2_candidate_1234",
    displayPath: "Plain Craft Launcher 2.exe",
    source: "running_process" as const,
    running: true,
  },
];

const lanCandidates = [
  {
    id: "lan_candidate_1234",
    port: 51321,
    version: "1.21.5",
    observedAt: 1_000,
    expiresAt: 61_000,
  },
];

const readyComponentStatus: MinecraftComponentStatus = {
  state: "ready",
  bridgeInstalled: true,
  bridgeActive: true,
  avatarInstalled: true,
  restartRequired: false,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function loginResult(attemptId: string, expiresAt: number, path: string) {
  return {
    attempt: {
      status: "pending" as const,
      attemptId,
      expiresAt,
    },
    loginUrl: `https://auth.openai.com/${path}`,
  };
}

class LanContainmentChild extends EventEmitter implements ChildProcessPort {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: string[] = [];
  killCalls = 0;
  alive = true;

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => this.writes.push(chunk));
  }

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }

  respond(response: DesktopResponse): void {
    this.stdout.write(`${JSON.stringify(response)}\n`);
  }

  requests() {
    return this.writes
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => parseDesktopRequest(JSON.parse(line)));
  }

  crash(): void {
    if (!this.alive) return;
    this.alive = false;
    this.emit("exit", 1, null);
  }
}

type WorldAuthorityPort = NonNullable<Parameters<typeof registerIpcHandlers>[0]["worldAuthority"]>;

function createRegistryHarness(
  snapshot: unknown = idleSnapshot,
  worldAuthority?: WorldAuthorityPort,
) {
  const loginExpiresAt = Date.now() + 60_000;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const removedChannels: string[] = [];
  const ipcMain: IpcMainPort = {
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel) => {
      removedChannels.push(channel);
      handlers.delete(channel);
    },
  };
  let runtimeListener: Parameters<IpcSupervisor["subscribe"]>[0] | undefined;
  const unsubscribeSupervisor = vi.fn(() => {
    runtimeListener = undefined;
  });
  const request = vi.fn(async (command: DesktopCommand): Promise<unknown> => {
    switch (command.kind) {
      case "get_account":
        return { status: "signed_out" };
      case "start_chatgpt_login":
        return {
          attempt: {
            status: "pending",
            attemptId: "opaque_attempt_1234",
            expiresAt: loginExpiresAt,
          },
          loginUrl: "https://auth.openai.com/oauth?state=private",
        };
      case "cancel_chatgpt_login":
        return { status: "cancelled", attemptId: command.attemptId };
      case "list_models":
        return {
          models: [],
          selection: { mode: "automatic" },
          legacyMigrationCompleted: false,
        };
      case "migrate_model_preference":
        return {
          models: [],
          selection: { mode: "automatic" },
          legacyMigrationCompleted: true,
        };
      case "select_model":
        return command.selection.mode === "automatic"
          ? { mode: "automatic" }
          : { ...command.selection, available: true };
      case "read_owner_identity":
        return ownerSnapshot;
      case "update_owner_identity":
        return {
          ...ownerSnapshot,
          revision: command.expectedRevision + 1,
          ownerUsername: command.ownerUsername,
        };
      case "set_confirmed_connection":
        return {
          status: "configured",
          port: command.proof.port,
          confirmedAt: command.proof.issuedAt,
        };
      default:
        return snapshot;
    }
  });
  const emergencyStop = vi.fn<IpcSupervisor["emergencyStop"]>(
    async () => snapshot as RuntimeSnapshot,
  );
  const stopTask = vi.fn(async () => snapshot as RuntimeSnapshot);
  const bindConfirmedWorld = vi.fn(async () => snapshot as RuntimeSnapshot);
  const supervisor = {
    request: request as IpcSupervisor["request"],
    stopTask,
    emergencyStop,
    activeChildGeneration: () => 7,
    subscribe: (listener) => {
      runtimeListener = listener;
      return unsubscribeSupervisor;
    },
    ...(worldAuthority ? { bindConfirmedWorld } : {}),
  } as IpcSupervisor & { activeChildGeneration(): number };
  const published: DesktopRendererEvent[] = [];
  const publishedOwners: Array<OwnerIdentitySnapshot & { childGeneration: number }> = [];
  const policy = new ExternalUrlPolicy();
  const openExternal = vi.fn<(url: string) => Promise<unknown>>(async () => undefined);
  const discoverPcl2 = vi.fn(async () => pcl2Candidates);
  const detectLanCandidates = vi.fn(async () => lanCandidates);
  const confirmLanCandidate = vi.fn(
    async (
      candidateId: string,
      applyProof: (proof: {
        nonce: string;
        port: number;
        issuedAt: number;
        expiresAt: number;
      }) => Promise<unknown>,
    ) => {
      expect(candidateId).toBe("lan_candidate_1234");
      await applyProof({
        nonce: "proof_nonce_12345678",
        port: 51321,
        issuedAt: 1_000,
        expiresAt: 11_000,
      });
      return { status: "confirmed" as const, port: 51321, version: "1.21.5", confirmedAt: 1_000 };
    },
  );
  const validateConfirmedSession = vi.fn(async () => true);
  const getMinecraftComponentStatus = vi.fn<MinecraftComponentManager["status"]>(async () =>
    structuredClone(readyComponentStatus),
  );
  const installMinecraftComponents = vi.fn<MinecraftComponentManager["install"]>(async () =>
    structuredClone(readyComponentStatus),
  );
  const removeMinecraftComponents = vi.fn<MinecraftComponentManager["remove"]>(async () =>
    structuredClone(readyComponentStatus),
  );
  const cleanup = registerIpcHandlers({
    ipcMain,
    supervisor,
    publishRuntime: (event) => published.push(event),
    publishOwnerIdentity: (owner) => publishedOwners.push(owner),
    externalUrlPolicy: policy,
    openExternal,
    pcl2Discovery: { discoverPcl2 },
    lanDetector: {
      detectLanCandidates,
      confirmLanCandidate,
      validateConfirmedSession,
      stop: vi.fn(),
    },
    minecraftComponentManager: {
      status: getMinecraftComponentStatus,
      install: installMinecraftComponents,
      remove: removeMinecraftComponents,
    },
    ...(worldAuthority ? { worldAuthority } : {}),
  });
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error("unknown renderer channel");
    return handler({}, ...args);
  };
  return {
    stopTask,
    emergencyStop,
    cleanup,
    handlers,
    invoke,
    published,
    publishedOwners,
    removedChannels,
    request,
    runtimeEvent: (event: DesktopEvent["event"], childGeneration = 7) =>
      runtimeListener?.(event, { childGeneration }),
    policy,
    openExternal,
    discoverPcl2,
    detectLanCandidates,
    confirmLanCandidate,
    validateConfirmedSession,
    getMinecraftComponentStatus,
    installMinecraftComponents,
    removeMinecraftComponents,
    bindConfirmedWorld,
    unsubscribeSupervisor,
  };
}

describe("IPC registry", () => {
  it("registers only the fixed renderer invocation channels", () => {
    const { handlers } = createRegistryHarness();

    expect([...handlers.keys()].sort()).toEqual(
      [
        WHITE_LILY_IPC_CHANNELS.status,
        WHITE_LILY_IPC_CHANNELS.start,
        WHITE_LILY_IPC_CHANNELS.stop,
        WHITE_LILY_IPC_CHANNELS.stopTask,
        WHITE_LILY_IPC_CHANNELS.emergencyStop,
        WHITE_LILY_IPC_CHANNELS.readOwnerIdentity,
        WHITE_LILY_IPC_CHANNELS.updateOwnerIdentity,
        WHITE_LILY_IPC_CHANNELS.getAccount,
        WHITE_LILY_IPC_CHANNELS.startChatGptLogin,
        WHITE_LILY_IPC_CHANNELS.cancelChatGptLogin,
        WHITE_LILY_IPC_CHANNELS.commitMemoryMigration,
        WHITE_LILY_IPC_CHANNELS.listModels,
        WHITE_LILY_IPC_CHANNELS.migrateModelPreference,
        WHITE_LILY_IPC_CHANNELS.selectModel,
        WHITE_LILY_IPC_CHANNELS.discoverPcl2,
        WHITE_LILY_IPC_CHANNELS.detectLanCandidates,
        WHITE_LILY_IPC_CHANNELS.confirmLanCandidate,
        WHITE_LILY_IPC_CHANNELS.getMinecraftComponentStatus,
        WHITE_LILY_IPC_CHANNELS.installMinecraftComponents,
        WHITE_LILY_IPC_CHANNELS.removeMinecraftComponents,
        WHITE_LILY_IPC_CHANNELS.bindConfirmedWorld,
        WHITE_LILY_IPC_CHANNELS.readProfile,
        WHITE_LILY_IPC_CHANNELS.updateProfile,
        WHITE_LILY_IPC_CHANNELS.setBehaviorMode,
        WHITE_LILY_IPC_CHANNELS.readMemories,
        WHITE_LILY_IPC_CHANNELS.searchMemories,
        WHITE_LILY_IPC_CHANNELS.addMemory,
        WHITE_LILY_IPC_CHANNELS.updateMemory,
        WHITE_LILY_IPC_CHANNELS.forgetMemory,
        WHITE_LILY_IPC_CHANNELS.pinMemory,
        WHITE_LILY_IPC_CHANNELS.previewMemoryMigration,
        WHITE_LILY_IPC_CHANNELS.setMemoryScope,
        WHITE_LILY_IPC_CHANNELS.exportMemories,
        WHITE_LILY_IPC_CHANNELS.previewDiagnostics,
        WHITE_LILY_IPC_CHANNELS.exportDiagnostics,
        WHITE_LILY_IPC_CHANNELS.readWorldProfile,
        WHITE_LILY_IPC_CHANNELS.rollbackMemoryMigration,
        WHITE_LILY_IPC_CHANNELS.updateSafetyProfile,
        WHITE_LILY_IPC_CHANNELS.readStartupSetting,
        WHITE_LILY_IPC_CHANNELS.setStartupSetting,
        WHITE_LILY_IPC_CHANNELS.readCloseToTraySetting,
        WHITE_LILY_IPC_CHANNELS.setCloseToTraySetting,
      ].sort(),
    );
    expect(handlers.has("whitelily:execute")).toBe(false);
    expect(handlers.has("whitelily:open-external")).toBe(false);
  });

  it("accepts only opaque candidate IDs and duplicate-free bounded component selections", async () => {
    const harness = createRegistryHarness();

    await expect(
      harness.invoke(WHITE_LILY_IPC_CHANNELS.getMinecraftComponentStatus, "lan_candidate_1234"),
    ).resolves.toEqual(readyComponentStatus);
    await expect(
      harness.invoke(WHITE_LILY_IPC_CHANNELS.installMinecraftComponents, "lan_candidate_1234", [
        "bridge",
        "avatar",
      ]),
    ).resolves.toEqual(readyComponentStatus);
    await expect(
      harness.invoke(WHITE_LILY_IPC_CHANNELS.removeMinecraftComponents, "lan_candidate_1234", [
        "avatar",
        "bridge",
      ]),
    ).resolves.toEqual(readyComponentStatus);

    expect(harness.getMinecraftComponentStatus).toHaveBeenCalledWith("lan_candidate_1234");
    expect(harness.installMinecraftComponents).toHaveBeenCalledWith("lan_candidate_1234", [
      "bridge",
      "avatar",
    ]);
    expect(harness.removeMinecraftComponents).toHaveBeenCalledWith("lan_candidate_1234", [
      "avatar",
      "bridge",
    ]);

    const selectionWithExtraKey = ["bridge"] as string[] & { path?: string };
    selectionWithExtraKey.path = String.raw`C:\Private\mods`;
    let selectionGetterCalls = 0;
    const accessorSelection: unknown[] = [];
    Object.defineProperty(accessorSelection, "0", {
      enumerable: true,
      get: () => {
        selectionGetterCalls += 1;
        return "bridge";
      },
    });
    const invalidStatusInputs: readonly (readonly unknown[])[] = [
      [],
      [""],
      ["short"],
      ["x".repeat(65)],
      [String.raw`C:\Private\mods`],
      ["../mods/lan_candidate_1234"],
      ["lan_candidate_1234", { path: String.raw`C:\Private\mods` }],
    ];
    for (const input of invalidStatusInputs) {
      await expect(
        harness.invoke(WHITE_LILY_IPC_CHANNELS.getMinecraftComponentStatus, ...input),
      ).rejects.toThrow("invalid IPC input");
    }
    const invalidSelections: readonly unknown[] = [
      "bridge",
      ["bridge", "bridge"],
      ["avatar", "avatar"],
      ["bridge", "avatar", "bridge"],
      ["fabric-api"],
      [{ path: String.raw`C:\Private\mods` }],
      selectionWithExtraKey,
      accessorSelection,
      Object.setPrototypeOf(["bridge"], null),
    ];
    for (const selection of invalidSelections) {
      await expect(
        harness.invoke(
          WHITE_LILY_IPC_CHANNELS.installMinecraftComponents,
          "lan_candidate_1234",
          selection,
        ),
      ).rejects.toThrow("invalid IPC input");
    }
    await expect(
      harness.invoke(
        WHITE_LILY_IPC_CHANNELS.installMinecraftComponents,
        "lan_candidate_1234",
        ["bridge"],
        { resourceDirectory: String.raw`C:\Private\resources` },
      ),
    ).rejects.toThrow("invalid IPC input");
    await expect(
      harness.invoke(
        WHITE_LILY_IPC_CHANNELS.removeMinecraftComponents,
        "lan_candidate_1234",
        ["avatar"],
        { presenceDirectory: String.raw`C:\Private\presence` },
      ),
    ).rejects.toThrow("invalid IPC input");
    expect(selectionGetterCalls).toBe(0);
    expect(harness.installMinecraftComponents).toHaveBeenCalledTimes(1);
    expect(harness.removeMinecraftComponents).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed manager results before they cross the main boundary", async () => {
    const harness = createRegistryHarness();
    const malformed: readonly unknown[] = [
      null,
      { ...readyComponentStatus, path: String.raw`C:\Private\mods` },
      { ...readyComponentStatus, state: "arbitrary" },
      { ...readyComponentStatus, bridgeInstalled: "yes" },
      { ...readyComponentStatus, restartRequired: true },
    ];

    for (const value of malformed) {
      harness.getMinecraftComponentStatus.mockResolvedValueOnce(value as MinecraftComponentStatus);
      await expect(
        harness.invoke(WHITE_LILY_IPC_CHANNELS.getMinecraftComponentStatus, "lan_candidate_1234"),
      ).rejects.toThrow("invalid Minecraft component status");
    }
  });

  it("keeps startup, close-to-tray, and safe export as narrow main-process controls", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const setStartup = vi.fn((enabled: boolean) => ({ enabled, available: true }));
    const setCloseToTray = vi.fn(async (expectedRevision: number, enabled: boolean) => ({
      revision: expectedRevision + 1,
      enabled,
    }));
    const exportSerialized = vi.fn(async (serialized: string) => {
      expect(JSON.parse(serialized)).toMatchObject({ schemaVersion: 1, records: [] });
      return { status: "saved" as const };
    });
    const exportDiagnostic = vi.fn(
      async (
        exportId: string,
        prepareArchive: () => Promise<{ exportId: string; size: number; sha256: string }>,
      ) => {
        expect(exportId).toBe("diagnostic_1234567890");
        await expect(prepareArchive()).resolves.toEqual({
          exportId: "diagnostic_1234567890",
          size: 512,
          sha256: "a".repeat(64),
        });
        return { status: "saved" as const };
      },
    );
    const memoryEnvelope = {
      schemaVersion: 1 as const,
      revision: 0,
      updatedAt: "2026-07-29T00:00:00.000Z",
      records: [],
      legacyMigrated: true,
    };
    const request = vi.fn(async (command: DesktopCommand) => {
      if (command.kind === "export_redacted_memories") return memoryEnvelope;
      if (command.kind === "preview_diagnostics") {
        return {
          exportId: "diagnostic_1234567890",
          actionCapability: {
            workspaceVersion: "workspace-1",
            state: "ready",
            mcpListening: true,
            discoveredToolCount: 16,
            errorCode: null,
          },
          files: [
            { logicalName: "app-version.json", size: 20, redactions: 0 },
            { logicalName: "os-summary.json", size: 20, redactions: 0 },
            { logicalName: "dependency-versions.json", size: 20, redactions: 0 },
            { logicalName: "minecraft-compatibility.json", size: 20, redactions: 0 },
            { logicalName: "app-log.jsonl", size: 20, redactions: 0 },
            { logicalName: "audit-log.jsonl", size: 20, redactions: 0 },
            { logicalName: "config-schema-summary.json", size: 20, redactions: 0 },
          ],
          omitted: [
            "minecraft-saves",
            "authentication-data",
            "pcl2-account-data",
            "complete-companion-profile",
            "complete-memories",
            "raw-chat",
          ],
        };
      }
      if (command.kind === "prepare_diagnostic_archive") {
        return { exportId: command.exportId, size: 512, sha256: "a".repeat(64) };
      }
      return idleSnapshot;
    }) as IpcSupervisor["request"];
    registerIpcHandlers({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => handlers.delete(channel),
      },
      supervisor: {
        request,
        stopTask: async () => idleSnapshot,
        emergencyStop: async () => idleSnapshot,
        activeChildGeneration: () => 7,
        subscribe: () => () => undefined,
      },
      publishRuntime: () => undefined,
      publishOwnerIdentity: () => undefined,
      externalUrlPolicy: new ExternalUrlPolicy(),
      openExternal: async () => undefined,
      pcl2Discovery: { discoverPcl2: async () => [] },
      lanDetector: {
        detectLanCandidates: async () => [],
        confirmLanCandidate: vi.fn(),
        validateConfirmedSession: async () => true,
        stop: () => undefined,
      },
      startupSettings: {
        read: () => ({ enabled: false, available: true }),
        set: setStartup,
      },
      closeToTraySettings: {
        read: async () => ({ revision: 0, enabled: true }),
        set: setCloseToTray,
      },
      exportSerialized,
      exportDiagnostic,
    });
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

    await expect(invoke(WHITE_LILY_IPC_CHANNELS.readStartupSetting)).resolves.toEqual({
      enabled: false,
      available: true,
    });
    await expect(invoke(WHITE_LILY_IPC_CHANNELS.setStartupSetting, true)).resolves.toEqual({
      enabled: true,
      available: true,
    });
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.setCloseToTraySetting, {
        expectedRevision: 0,
        enabled: false,
      }),
    ).resolves.toEqual({ revision: 1, enabled: false });
    await expect(invoke(WHITE_LILY_IPC_CHANNELS.exportMemories)).resolves.toEqual({
      status: "saved",
    });
    await expect(invoke(WHITE_LILY_IPC_CHANNELS.previewDiagnostics)).resolves.toMatchObject({
      exportId: "diagnostic_1234567890",
    });
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.exportDiagnostics, "diagnostic_1234567890"),
    ).resolves.toEqual({ status: "saved" });

    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.setStartupSetting, {
        enabled: true,
        path: "evil.exe",
        args: ["--shell"],
      }),
    ).rejects.toThrow("invalid IPC input");
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.exportMemories, String.raw`C:\private\arbitrary.json`),
    ).rejects.toThrow("invalid IPC input");
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.exportDiagnostics, {
        exportId: "diagnostic_1234567890",
        destination: String.raw`C:\private\arbitrary.zip`,
      }),
    ).rejects.toThrow("invalid IPC input");
    expect(setStartup).toHaveBeenCalledOnce();
    expect(setCloseToTray).toHaveBeenCalledOnce();
    expect(exportSerialized).toHaveBeenCalledOnce();
    expect(exportDiagnostic).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({ kind: "export_redacted_memories" });
  });

  it.each(["add", "update"] as const)(
    "keeps a world-scoped %s atomic with child-owned current-world resolution",
    async (operation) => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const timestamp = "2026-07-29T00:00:00.000Z";
      const worldA = "12345678-1234-4234-8234-123456789aaa";
      const worldB = "12345678-1234-4234-8234-123456789bbb";
      let currentWorldId = worldA;
      const firstRequest = deferred<"read" | "mutation">();
      const releaseRead = deferred<void>();
      const releaseMutation = deferred<void>();
      const requestMock = vi.fn(async (command: DesktopCommand) => {
        if (command.kind === "read_world_profile") {
          firstRequest.resolve("read");
          await releaseRead.promise;
          return {
            schemaVersion: 1,
            revision: 2,
            updatedAt: timestamp,
            value: {
              id: worldA,
              label: "Survival",
              instanceFingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              ownerUsername: "Player",
              safetyPreset: "conservative",
            },
          };
        }
        if (command.kind === "add_memory" || command.kind === "update_memory") {
          firstRequest.resolve("mutation");
          await releaseMutation.promise;
          const suppliedWorldId =
            command.kind === "add_memory"
              ? Reflect.get(command.memory, "worldId")
              : Reflect.get(command.patch, "worldId");
          const input =
            command.kind === "add_memory"
              ? {
                  ...command.memory,
                  ...(typeof suppliedWorldId === "string" ? { worldId: suppliedWorldId } : {}),
                }
              : {
                  category: "project" as const,
                  summary: "World tower",
                  importance: 3 as const,
                  scope: command.patch.scope ?? ("global" as const),
                  ...(typeof suppliedWorldId === "string" ? { worldId: suppliedWorldId } : {}),
                };
          const authoritativeWorldId =
            input.scope === "world" && "worldId" in input ? input.worldId : currentWorldId;
          const record = {
            id: 1,
            ...input,
            ...(input.scope === "world" ? { worldId: authoritativeWorldId } : {}),
            createdAt: timestamp,
            updatedAt: timestamp,
            source: "manual" as const,
            pinned: false,
            revision: 0,
          };
          return {
            envelope: {
              schemaVersion: 1,
              revision: 1,
              updatedAt: timestamp,
              records: [record],
              legacyMigrated: true,
            },
            record,
          };
        }
        return idleSnapshot;
      });
      const request = requestMock as IpcSupervisor["request"];
      registerIpcHandlers({
        ipcMain: {
          handle: (channel, handler) => handlers.set(channel, handler),
          removeHandler: (channel) => handlers.delete(channel),
        },
        supervisor: {
          request,
          stopTask: async () => idleSnapshot,
          emergencyStop: async () => idleSnapshot,
          activeChildGeneration: () => 7,
          subscribe: () => () => undefined,
        },
        publishRuntime: () => undefined,
        publishOwnerIdentity: () => undefined,
        externalUrlPolicy: new ExternalUrlPolicy(),
        openExternal: async () => undefined,
        pcl2Discovery: { discoverPcl2: async () => [] },
        lanDetector: {
          detectLanCandidates: async () => [],
          confirmLanCandidate: vi.fn(),
          validateConfirmedSession: async () => true,
          stop: () => undefined,
        },
      });

      const invocation =
        operation === "add"
          ? handlers.get(WHITE_LILY_IPC_CHANNELS.addMemory)!(
              {},
              {
                expectedRevision: 0,
                memory: {
                  category: "project",
                  summary: "World tower",
                  importance: 3,
                  scope: "world",
                },
              },
            )
          : handlers.get(WHITE_LILY_IPC_CHANNELS.updateMemory)!(
              {},
              {
                id: 1,
                expectedRevision: 0,
                recordRevision: 0,
                patch: { scope: "world" },
              },
            );
      const result = Promise.resolve(invocation);
      await firstRequest.promise;
      currentWorldId = worldB;
      releaseRead.resolve();
      releaseMutation.resolve();

      await expect(result).resolves.toMatchObject({
        record: { scope: "world", worldId: worldB },
      });
      expect(
        requestMock.mock.calls.some(([command]) => command.kind === "read_world_profile"),
      ).toBe(false);
      const mutation = requestMock.mock.calls
        .map(([command]) => command)
        .find((command) => command.kind === `${operation}_memory`);
      expect(
        mutation?.kind === "add_memory"
          ? Object.hasOwn(mutation.memory, "worldId")
          : mutation?.kind === "update_memory"
            ? Object.hasOwn(mutation.patch, "worldId")
            : true,
      ).toBe(false);
    },
  );

  it("exposes only fixed LAN detection and opaque-ID confirmation", async () => {
    const { invoke, request, detectLanCandidates, confirmLanCandidate } = createRegistryHarness();

    await expect(invoke(WHITE_LILY_IPC_CHANNELS.detectLanCandidates)).resolves.toEqual(
      lanCandidates,
    );
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.confirmLanCandidate, "lan_candidate_1234"),
    ).resolves.toEqual({
      status: "confirmed",
      port: 51321,
      version: "1.21.5",
      confirmedAt: 1_000,
    });

    expect(detectLanCandidates).toHaveBeenCalledOnce();
    expect(confirmLanCandidate).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({
      kind: "set_confirmed_connection",
      proof: {
        nonce: "proof_nonce_12345678",
        port: 51321,
        issuedAt: 1_000,
        expiresAt: 11_000,
      },
    });
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.confirmLanCandidate, {
        id: "lan_candidate_1234",
        host: "127.0.0.1",
        port: 51321,
        pid: 4200,
        script: "Get-NetTCPConnection",
      }),
    ).rejects.toThrow("invalid IPC input");
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.detectLanCandidates, { host: "127.0.0.1" }),
    ).rejects.toThrow("invalid IPC input");
  });

  it("keeps raw Java snapshot child failures opaque across bind-confirmed-world IPC", async () => {
    const sentinel = "SENSITIVE_STDERR ProcessId = 98765 Get-CimInstance";
    const javaSession = {
      pid: 1234,
      processStartedAt: 100,
      port: 51321,
      version: "1.21.5",
    };
    const authority = new WorldBindingAuthority({
      configPath: "unused-by-direct-resolution",
      lanDetector: { redeemConfirmedProof: async () => javaSession },
      resolveInstancePath: async () => "C:/Minecraft/Instance",
      snapshotExecFile: async () => {
        throw new Error(sentinel);
      },
    });
    const harness = createRegistryHarness(idleSnapshot, {
      redeem: async () => {
        await authority.resolveJavaInstance(javaSession);
        throw new Error("unreachable");
      },
    });
    await harness.invoke(WHITE_LILY_IPC_CHANNELS.confirmLanCandidate, "lan_candidate_1234");

    const failure = await Promise.resolve(
      harness.invoke(WHITE_LILY_IPC_CHANNELS.bindConfirmedWorld, {
        expectedRevision: 0,
        label: "Opaque world",
      }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Java process snapshot unavailable");
    expect((failure as Error).message).not.toContain(sentinel);
    expect((failure as Error).cause).toBeUndefined();
    expect(harness.bindConfirmedWorld).not.toHaveBeenCalled();
  });

  it("invalidates child connection authority when confirmed LAN identity changes", async () => {
    vi.useFakeTimers();
    try {
      const harness = createRegistryHarness();
      harness.validateConfirmedSession.mockResolvedValueOnce(false);

      await harness.invoke(WHITE_LILY_IPC_CHANNELS.confirmLanCandidate, "lan_candidate_1234");
      await vi.advanceTimersByTimeAsync(2_000);

      expect(harness.request).toHaveBeenCalledWith({
        kind: "invalidate_connection",
        reason: "lan_changed",
      });
      harness.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no active unquarantined child when LAN invalidation is rejected", async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain: IpcMainPort = {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    };
    const child = new LanContainmentChild();
    const spawn: SpawnChild = () => child;
    const supervisor = new ChildSupervisor({
      childEntry: String.raw`C:\Program Files\WhiteLily\resources\childMain.js`,
      configPath: String.raw`C:\LocalAppData\owner\WhiteLily\config.toml`,
      workingDirectory: String.raw`C:\LocalAppData\owner\WhiteLily`,
      environment: {
        LOCALAPPDATA: String.raw`C:\LocalAppData\owner`,
        WHITELILY_DATA_ROOT: String.raw`C:\LocalAppData\owner\WhiteLily`,
      },
      development: true,
      spawn,
    });
    supervisor.start();
    const cleanup = registerIpcHandlers({
      ipcMain,
      supervisor,
      publishRuntime: () => undefined,
      publishOwnerIdentity: () => undefined,
      externalUrlPolicy: new ExternalUrlPolicy(),
      openExternal: async () => undefined,
      pcl2Discovery: { discoverPcl2: async () => [] },
      lanDetector: {
        detectLanCandidates: async () => lanCandidates,
        confirmLanCandidate: async (_candidateId, applyProof) => {
          await applyProof({
            nonce: "proof_nonce_12345678",
            port: 51321,
            issuedAt: 1_000,
            expiresAt: 11_000,
          });
          return {
            status: "confirmed",
            port: 51321,
            version: "1.21.5",
            confirmedAt: 1_000,
          };
        },
        validateConfirmedSession: async () => false,
        stop: () => undefined,
      },
    });
    try {
      const confirm = handlers.get(WHITE_LILY_IPC_CHANNELS.confirmLanCandidate)!(
        {},
        "lan_candidate_1234",
      );
      await flushMicrotasks();
      const configure = child.requests()[0]!;
      child.respond({
        version: DESKTOP_PROTOCOL_VERSION,
        id: configure.id,
        ok: true,
        result: { status: "configured", port: 51321, confirmedAt: 1_000 },
      });
      await expect(confirm).resolves.toMatchObject({ status: "confirmed" });

      await vi.advanceTimersByTimeAsync(2_000);
      const invalidation = child
        .requests()
        .find((request) => request.command.kind === "invalidate_connection")!;
      child.respond({
        version: DESKTOP_PROTOCOL_VERSION,
        id: invalidation.id,
        ok: false,
        error: {
          code: "CONNECTION_OPERATION_FAILED",
          message: "The child could not prove LAN authority containment",
        },
      });
      await flushMicrotasks();

      expect(child.killCalls).toBe(1);
      expect(child.alive).toBe(true);
      await expect(supervisor.request({ kind: "get_status" })).rejects.toThrow("quarantined");
      expect(() => supervisor.start()).toThrow("quarantined");
    } finally {
      cleanup();
      child.crash();
      await supervisor.shutdown();
    }
  });

  it.each([
    { path: String.raw`C:\Windows\System32` },
    { executable: "powershell.exe" },
    { shell: "whoami" },
  ])("rejects renderer-controlled process input %j", async (payload) => {
    const { invoke, request, emergencyStop } = createRegistryHarness();

    await expect(invoke(WHITE_LILY_IPC_CHANNELS.start, payload)).rejects.toThrow(
      "invalid IPC input",
    );
    expect(request).not.toHaveBeenCalled();
    expect(emergencyStop).not.toHaveBeenCalled();
  });

  it("reads and revision-checks owner identity through exact main-process handlers", async () => {
    const { invoke, request } = createRegistryHarness();

    await expect(invoke(WHITE_LILY_IPC_CHANNELS.readOwnerIdentity)).resolves.toEqual(
      ownerAuthoritySnapshot,
    );
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.updateOwnerIdentity, {
        expectedRevision: 7,
        ownerUsername: "NewOwner",
      }),
    ).resolves.toEqual({ ...ownerAuthoritySnapshot, revision: 8 });
    expect(request.mock.calls.map(([command]) => command)).toEqual([
      { kind: "read_owner_identity" },
      { kind: "update_owner_identity", expectedRevision: 7, ownerUsername: "NewOwner" },
    ]);
  });

  it("rejects malformed owner IPC input without invoking getters or the supervisor", async () => {
    const { invoke, request } = createRegistryHarness();
    let getterCalls = 0;
    const accessorInput = Object.defineProperties(
      {},
      {
        expectedRevision: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return 7;
          },
        },
        ownerUsername: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return "NewOwner";
          },
        },
      },
    );
    const exoticInput = Object.assign(Object.create({ inherited: true }), {
      expectedRevision: 7,
      ownerUsername: "NewOwner",
    });

    for (const args of [
      [],
      [{ expectedRevision: 7, ownerUsername: "NewOwner" }, { token: "secret" }],
      [[7, "NewOwner"]],
      [{ expectedRevision: -1, ownerUsername: "NewOwner" }],
      [{ expectedRevision: 7.5, ownerUsername: "NewOwner" }],
      [{ expectedRevision: 7, ownerUsername: "../../../config.toml" }],
      [{ expectedRevision: 7, ownerUsername: "NewOwner", path: String.raw`C:\config.toml` }],
      [{ expectedRevision: 7, ownerUsername: "NewOwner", toml: "owner = 'Mallory'" }],
      [{ expectedRevision: 7, ownerUsername: "NewOwner", token: "secret" }],
      [accessorInput],
      [exoticInput],
    ] as const) {
      await expect(invoke(WHITE_LILY_IPC_CHANNELS.updateOwnerIdentity, ...args)).rejects.toThrow(
        "invalid IPC input",
      );
    }
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.readOwnerIdentity, { token: "secret" }),
    ).rejects.toThrow("invalid IPC input");
    expect(getterCalls).toBe(0);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed owner identity results from the supervisor", async () => {
    const harness = createRegistryHarness();
    harness.request.mockResolvedValueOnce({ ...ownerSnapshot, token: "secret" });
    harness.request.mockResolvedValueOnce({
      ...ownerSnapshot,
      revision: 8,
      path: String.raw`C:\config.toml`,
    });
    harness.request.mockResolvedValueOnce({ ...ownerSnapshot, ownerUsername: "WhiteLily" });

    await expect(harness.invoke(WHITE_LILY_IPC_CHANNELS.readOwnerIdentity)).rejects.toThrow(
      "invalid",
    );
    await expect(
      harness.invoke(WHITE_LILY_IPC_CHANNELS.updateOwnerIdentity, {
        expectedRevision: 7,
        ownerUsername: "NewOwner",
      }),
    ).rejects.toThrow("invalid");
    await expect(harness.invoke(WHITE_LILY_IPC_CHANNELS.readOwnerIdentity)).rejects.toThrow(
      "invalid",
    );
  });

  it("rejects unknown channels instead of forwarding them", () => {
    const { invoke, request } = createRegistryHarness();

    expect(() => invoke("whitelily:run-shell", "whoami")).toThrow("unknown renderer channel");
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts no renderer path, executable, shell, or script for PCL2 discovery", async () => {
    const { discoverPcl2, invoke } = createRegistryHarness();

    for (const payload of [
      { path: String.raw`C:\Profiles\Private\Plain Craft Launcher 2.exe` },
      { executable: "powershell.exe" },
      { shell: "Get-Process" },
      { script: "whoami" },
    ]) {
      await expect(invoke(WHITE_LILY_IPC_CHANNELS.discoverPcl2, payload)).rejects.toThrow(
        "invalid IPC input",
      );
    }
    expect(discoverPcl2).not.toHaveBeenCalled();
  });

  it("maps each allowed channel to a fixed protocol command and validates the result", async () => {
    const { invoke, request, stopTask, emergencyStop } = createRegistryHarness();

    await expect(invoke(WHITE_LILY_IPC_CHANNELS.status)).resolves.toEqual(idleSnapshot);
    await expect(invoke(WHITE_LILY_IPC_CHANNELS.start)).resolves.toEqual(idleSnapshot);
    await expect(invoke(WHITE_LILY_IPC_CHANNELS.stop)).resolves.toEqual(idleSnapshot);
    await expect(invoke(WHITE_LILY_IPC_CHANNELS.stopTask)).resolves.toEqual(idleSnapshot);
    await expect(invoke(WHITE_LILY_IPC_CHANNELS.emergencyStop)).resolves.toEqual(idleSnapshot);
    await expect(invoke(WHITE_LILY_IPC_CHANNELS.discoverPcl2)).resolves.toEqual(pcl2Candidates);

    expect(request.mock.calls.map(([command]) => command)).toEqual([
      { kind: "get_status" },
      { kind: "start_runtime" },
      { kind: "stop_runtime" },
    ]);
    expect(stopTask).toHaveBeenCalledOnce();
    expect(emergencyStop).toHaveBeenCalledOnce();
  });

  it("rejects task-stop IPC arguments before reaching any supervisor stop authority", async () => {
    const { invoke, request, stopTask, emergencyStop } = createRegistryHarness();

    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.stopTask, { kind: "stop_runtime" }),
    ).rejects.toThrow("invalid IPC input");
    expect(stopTask).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(emergencyStop).not.toHaveBeenCalled();
  });

  it("returns only strict bounded public PCL2 candidate fields", async () => {
    const harness = createRegistryHarness();

    await expect(harness.invoke(WHITE_LILY_IPC_CHANNELS.discoverPcl2)).resolves.toEqual(
      pcl2Candidates,
    );
    expect(JSON.stringify(pcl2Candidates)).not.toContain("C:\\");

    harness.discoverPcl2.mockResolvedValueOnce([
      {
        ...pcl2Candidates[0]!,
        canonicalPath: String.raw`C:\Profiles\Private\Plain Craft Launcher 2.exe`,
      },
    ] as never);
    await expect(harness.invoke(WHITE_LILY_IPC_CHANNELS.discoverPcl2)).rejects.toThrow(
      "invalid PCL2 candidates",
    );
  });

  it("opens one main-validated login URL and returns only public attempt metadata", async () => {
    const { invoke, openExternal, policy } = createRegistryHarness();

    const result = await invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);
    const repeated = await invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);

    expect(result).toMatchObject({
      status: "pending",
      attemptId: "opaque_attempt_1234",
    });
    expect(result).not.toHaveProperty("loginUrl");
    expect(repeated).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("state=private");
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://auth.openai.com/oauth?state=private",
    );
    expect(policy.canOpen("https://auth.openai.com/oauth?state=private")).toBe(true);
  });

  it("clears the active URL on cancel, expiry/account completion, and open failure", async () => {
    vi.useFakeTimers();
    try {
      const harness = createRegistryHarness();
      await harness.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);
      await harness.invoke(WHITE_LILY_IPC_CHANNELS.cancelChatGptLogin, "opaque_attempt_1234");
      expect(harness.policy.canOpen("https://auth.openai.com/oauth?state=private")).toBe(false);

      await harness.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);
      harness.runtimeEvent({
        kind: "account",
        account: { status: "signed_in", auth: "chatgpt" },
      });
      expect(harness.policy.canOpen("https://auth.openai.com/oauth?state=private")).toBe(false);

      await harness.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(harness.policy.canOpen("https://auth.openai.com/oauth?state=private")).toBe(false);

      const failed = createRegistryHarness();
      failed.openExternal.mockRejectedValueOnce(new Error("shell leaked ?access_token=private"));
      await expect(failed.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin)).rejects.toThrow(
        "Unable to open ChatGPT login",
      );
      expect(failed.policy.canOpen("https://auth.openai.com/oauth?state=private")).toBe(false);
      expect(failed.request.mock.calls.map(([command]) => command)).toContainEqual({
        kind: "cancel_chatgpt_login",
        attemptId: "opaque_attempt_1234",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates a deferred login open before cancel can return stale pending", async () => {
    const harness = createRegistryHarness();
    const opening = deferred<void>();
    harness.openExternal.mockImplementationOnce(() => opening.promise);

    const starting = harness.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);
    await flushMicrotasks();
    expect(harness.openExternal).toHaveBeenCalledOnce();

    await harness.invoke(WHITE_LILY_IPC_CHANNELS.cancelChatGptLogin, "opaque_attempt_1234");
    opening.resolve();

    await expect(starting).rejects.toThrow("ChatGPT login is no longer active");
    expect(harness.policy.canOpen("https://auth.openai.com/oauth?state=private")).toBe(false);
  });

  it("invalidates deferred login opens on account completion and cleanup", async () => {
    const completed = createRegistryHarness();
    const completionOpen = deferred<void>();
    completed.openExternal.mockImplementationOnce(() => completionOpen.promise);
    const completingStart = completed.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);
    await flushMicrotasks();

    completed.runtimeEvent({
      kind: "account",
      account: { status: "signed_in", auth: "chatgpt" },
    });
    completionOpen.resolve();
    await expect(completingStart).rejects.toThrow("ChatGPT login is no longer active");
    expect(completed.policy.canOpen("https://auth.openai.com/oauth?state=private")).toBe(false);

    const cleaned = createRegistryHarness();
    const cleanupOpen = deferred<void>();
    cleaned.openExternal.mockImplementationOnce(() => cleanupOpen.promise);
    const cleanupStart = cleaned.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);
    await flushMicrotasks();

    cleaned.cleanup();
    cleanupOpen.resolve();
    await expect(cleanupStart).rejects.toThrow("ChatGPT login is no longer active");
    expect(cleaned.policy.canOpen("https://auth.openai.com/oauth?state=private")).toBe(false);
  });

  it("shares one deferred open result across concurrent starts for the same attempt", async () => {
    const harness = createRegistryHarness();
    const opening = deferred<void>();
    harness.openExternal.mockImplementationOnce(() => opening.promise);

    const first = harness.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);
    await flushMicrotasks();
    let secondSettled = false;
    const second = Promise.resolve(
      harness.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin),
    ).finally(() => {
      secondSettled = true;
    });
    await flushMicrotasks();

    expect(secondSettled).toBe(false);
    expect(harness.openExternal).toHaveBeenCalledOnce();
    opening.reject(new Error("shell failed"));

    await expect(first).rejects.toThrow("Unable to open ChatGPT login");
    await expect(second).rejects.toThrow("Unable to open ChatGPT login");
    expect(
      harness.request.mock.calls.filter(([command]) => command.kind === "cancel_chatgpt_login"),
    ).toHaveLength(1);
  });

  it("keeps a replacement attempt authoritative when an old open resolves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const harness = createRegistryHarness();
      const oldOpen = deferred<void>();
      harness.openExternal
        .mockImplementationOnce(() => oldOpen.promise)
        .mockResolvedValueOnce(undefined);
      let starts = 0;
      harness.request.mockImplementation(async (command: DesktopCommand) => {
        if (command.kind === "start_chatgpt_login") {
          starts += 1;
          return starts === 1
            ? loginResult("opaque_attempt_old1", 2_000, "old")
            : loginResult("opaque_attempt_new2", 61_000, "new");
        }
        if (command.kind === "cancel_chatgpt_login") {
          return { status: "cancelled", attemptId: command.attemptId };
        }
        return idleSnapshot;
      });

      const oldStart = harness.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);
      await flushMicrotasks();
      await expect(
        harness.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin),
      ).resolves.toMatchObject({ attemptId: "opaque_attempt_new2" });
      expect(harness.policy.canOpen("https://auth.openai.com/new")).toBe(true);

      oldOpen.resolve();
      await expect(oldStart).rejects.toThrow("ChatGPT login is no longer active");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.policy.canOpen("https://auth.openai.com/new")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an old open failure cancel or clear a replacement attempt", async () => {
    const harness = createRegistryHarness();
    const oldOpen = deferred<void>();
    harness.openExternal
      .mockImplementationOnce(() => oldOpen.promise)
      .mockResolvedValueOnce(undefined);
    let starts = 0;
    harness.request.mockImplementation(async (command: DesktopCommand) => {
      if (command.kind === "start_chatgpt_login") {
        starts += 1;
        return starts === 1
          ? loginResult("opaque_attempt_old1", Date.now() + 30_000, "old")
          : loginResult("opaque_attempt_new2", Date.now() + 60_000, "new");
      }
      if (command.kind === "cancel_chatgpt_login") {
        return { status: "cancelled", attemptId: command.attemptId };
      }
      return idleSnapshot;
    });

    const oldStart = harness.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);
    await flushMicrotasks();
    await harness.invoke(WHITE_LILY_IPC_CHANNELS.startChatGptLogin);
    oldOpen.reject(new Error("old shell failure"));

    await expect(oldStart).rejects.toThrow("ChatGPT login is no longer active");
    expect(harness.policy.canOpen("https://auth.openai.com/new")).toBe(true);
    expect(
      harness.request.mock.calls.filter(
        ([command]) =>
          command.kind === "cancel_chatgpt_login" && command.attemptId === "opaque_attempt_old1",
      ),
    ).toHaveLength(0);
  });

  it("rejects malformed supervisor output and runtime events", async () => {
    const malformedSnapshot = { ...idleSnapshot, localPath: String.raw`C:\secret` };
    const { invoke, published, runtimeEvent } = createRegistryHarness(malformedSnapshot);

    await expect(invoke(WHITE_LILY_IPC_CHANNELS.status)).rejects.toThrow(
      "invalid runtime snapshot",
    );
    runtimeEvent({ kind: "lifecycle", state: "running", extra: true } as never);
    expect(published).toEqual([]);
  });

  it("strictly projects authoritative connection invalidation to the renderer", () => {
    const { published, runtimeEvent } = createRegistryHarness();
    const signal = {
      kind: "connection_invalidated" as const,
      revision: 8,
      reason: "runtime_failed" as const,
      snapshot: {
        ...idleSnapshot,
        revision: 8,
        lifecycle: "stopped" as const,
      },
    };

    runtimeEvent(signal);
    expect(published).toEqual([signal]);

    runtimeEvent({
      ...signal,
      revision: 9,
      snapshot: { ...signal.snapshot, revision: 8 },
    } as never);
    expect(published).toEqual([signal]);
    runtimeEvent({
      ...signal,
      revision: 10,
      snapshot: {
        ...signal.snapshot,
        revision: 10,
        lifecycle: "running",
        minecraft: { state: "connected", sessionId: null },
      },
    } as never);
    expect(published).toEqual([signal]);
  });

  it("publishes only strict owner snapshots on the dedicated owner channel", () => {
    const { published, publishedOwners, runtimeEvent } = createRegistryHarness();

    runtimeEvent({ kind: "owner_identity", owner: ownerSnapshot });
    expect(publishedOwners).toEqual([ownerAuthoritySnapshot]);
    expect(published).toEqual([]);

    let getterCalls = 0;
    const accessorOwner = Object.defineProperty({}, "revision", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 8;
      },
    });
    for (const owner of [
      { ...ownerSnapshot, path: String.raw`C:\config.toml` },
      { ...ownerSnapshot, toml: "owner = 'Mallory'" },
      { ...ownerSnapshot, token: "secret" },
      { ...ownerSnapshot, extra: true },
      { ...ownerSnapshot, ownerUsername: "WhiteLily" },
      accessorOwner,
    ]) {
      runtimeEvent({ kind: "owner_identity", owner } as never);
    }
    runtimeEvent({ kind: "account", account: { status: "signed_out" } });
    expect(publishedOwners).toEqual([ownerAuthoritySnapshot]);
    expect(published).toEqual([]);
    expect(getterCalls).toBe(0);
  });

  it("removes all handlers and the supervisor subscription exactly once", () => {
    const { cleanup, handlers, removedChannels, runtimeEvent, unsubscribeSupervisor } =
      createRegistryHarness();

    cleanup();
    cleanup();

    expect(handlers).toEqual(new Map());
    expect(runtimeEvent({ kind: "lifecycle", revision: 1, state: "running" })).toBeUndefined();
    expect(removedChannels.sort()).toEqual(
      [
        WHITE_LILY_IPC_CHANNELS.status,
        WHITE_LILY_IPC_CHANNELS.start,
        WHITE_LILY_IPC_CHANNELS.stop,
        WHITE_LILY_IPC_CHANNELS.stopTask,
        WHITE_LILY_IPC_CHANNELS.emergencyStop,
        WHITE_LILY_IPC_CHANNELS.readOwnerIdentity,
        WHITE_LILY_IPC_CHANNELS.updateOwnerIdentity,
        WHITE_LILY_IPC_CHANNELS.getAccount,
        WHITE_LILY_IPC_CHANNELS.startChatGptLogin,
        WHITE_LILY_IPC_CHANNELS.cancelChatGptLogin,
        WHITE_LILY_IPC_CHANNELS.commitMemoryMigration,
        WHITE_LILY_IPC_CHANNELS.listModels,
        WHITE_LILY_IPC_CHANNELS.migrateModelPreference,
        WHITE_LILY_IPC_CHANNELS.selectModel,
        WHITE_LILY_IPC_CHANNELS.discoverPcl2,
        WHITE_LILY_IPC_CHANNELS.detectLanCandidates,
        WHITE_LILY_IPC_CHANNELS.confirmLanCandidate,
        WHITE_LILY_IPC_CHANNELS.getMinecraftComponentStatus,
        WHITE_LILY_IPC_CHANNELS.installMinecraftComponents,
        WHITE_LILY_IPC_CHANNELS.removeMinecraftComponents,
        WHITE_LILY_IPC_CHANNELS.bindConfirmedWorld,
        WHITE_LILY_IPC_CHANNELS.readProfile,
        WHITE_LILY_IPC_CHANNELS.updateProfile,
        WHITE_LILY_IPC_CHANNELS.setBehaviorMode,
        WHITE_LILY_IPC_CHANNELS.readMemories,
        WHITE_LILY_IPC_CHANNELS.searchMemories,
        WHITE_LILY_IPC_CHANNELS.addMemory,
        WHITE_LILY_IPC_CHANNELS.updateMemory,
        WHITE_LILY_IPC_CHANNELS.forgetMemory,
        WHITE_LILY_IPC_CHANNELS.pinMemory,
        WHITE_LILY_IPC_CHANNELS.previewMemoryMigration,
        WHITE_LILY_IPC_CHANNELS.setMemoryScope,
        WHITE_LILY_IPC_CHANNELS.exportMemories,
        WHITE_LILY_IPC_CHANNELS.previewDiagnostics,
        WHITE_LILY_IPC_CHANNELS.exportDiagnostics,
        WHITE_LILY_IPC_CHANNELS.readWorldProfile,
        WHITE_LILY_IPC_CHANNELS.rollbackMemoryMigration,
        WHITE_LILY_IPC_CHANNELS.updateSafetyProfile,
        WHITE_LILY_IPC_CHANNELS.readStartupSetting,
        WHITE_LILY_IPC_CHANNELS.setStartupSetting,
        WHITE_LILY_IPC_CHANNELS.readCloseToTraySetting,
        WHITE_LILY_IPC_CHANNELS.setCloseToTraySetting,
      ].sort(),
    );
    expect(unsubscribeSupervisor).toHaveBeenCalledOnce();
  });

  it("validates a bounded model migration candidate before forwarding it", async () => {
    const { handlers, request } = createRegistryHarness();
    const migrate = handlers.get(WHITE_LILY_IPC_CHANNELS.migrateModelPreference)!;

    await expect(
      migrate(undefined, {
        mode: "explicit",
        modelId: "gpt-live",
        reasoningEffort: "high",
      }),
    ).resolves.toMatchObject({ legacyMigrationCompleted: true });
    expect(request).toHaveBeenLastCalledWith({
      kind: "migrate_model_preference",
      candidate: { mode: "explicit", modelId: "gpt-live", reasoningEffort: "high" },
    });

    await expect(migrate(undefined, null)).resolves.toMatchObject({
      legacyMigrationCompleted: true,
    });
    await expect(
      migrate(undefined, { mode: "explicit", modelId: "../private", reasoningEffort: "high" }),
    ).rejects.toThrow("invalid desktop request");
    await expect(migrate(undefined, "raw-local-storage-json")).rejects.toThrow(
      "invalid desktop request",
    );
  });

  it("rolls back earlier handlers when IPC registration throws", () => {
    const handlers = new Set<string>();
    const removedChannels: string[] = [];
    const ipcMain: IpcMainPort = {
      handle: (channel) => {
        if (channel === WHITE_LILY_IPC_CHANNELS.stop) {
          throw new Error("registration failed");
        }
        handlers.add(channel);
      },
      removeHandler: (channel) => {
        removedChannels.push(channel);
        handlers.delete(channel);
      },
    };
    const subscribe = vi.fn<IpcSupervisor["subscribe"]>(() => () => undefined);

    expect(() =>
      registerIpcHandlers({
        ipcMain,
        supervisor: {
          request: (async () => idleSnapshot) as IpcSupervisor["request"],
          stopTask: async () => idleSnapshot,
          emergencyStop: async () => idleSnapshot,
          activeChildGeneration: () => 7,
          subscribe,
        },
        publishRuntime: () => undefined,
        publishOwnerIdentity: () => undefined,
        externalUrlPolicy: new ExternalUrlPolicy(),
        openExternal: async () => undefined,
        pcl2Discovery: { discoverPcl2: async () => [] },
        lanDetector: {
          detectLanCandidates: async () => [],
          confirmLanCandidate: async () => {
            throw new Error("not used");
          },
          validateConfirmedSession: async () => false,
          stop: () => undefined,
        },
      }),
    ).toThrow("registration failed");

    expect(handlers).toEqual(new Set());
    expect(removedChannels.sort()).toEqual(
      [WHITE_LILY_IPC_CHANNELS.status, WHITE_LILY_IPC_CHANNELS.start].sort(),
    );
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("typed preload API", () => {
  it("exposes only named WhiteLily operations over fixed channels", async () => {
    const invoked: string[] = [];
    const transport: PreloadTransport = {
      invoke: async (channel) => {
        invoked.push(channel);
        if (channel === WHITE_LILY_IPC_CHANNELS.getAccount) {
          return { status: "signed_out" };
        }
        if (channel === WHITE_LILY_IPC_CHANNELS.startChatGptLogin) {
          return {
            status: "pending",
            attemptId: "opaque_attempt_1234",
            expiresAt: 60_000,
          };
        }
        if (channel === WHITE_LILY_IPC_CHANNELS.cancelChatGptLogin) {
          return { status: "cancelled", attemptId: "opaque_attempt_1234" };
        }
        if (channel === WHITE_LILY_IPC_CHANNELS.listModels) {
          return {
            models: [],
            selection: { mode: "automatic" },
            legacyMigrationCompleted: false,
          };
        }
        if (channel === WHITE_LILY_IPC_CHANNELS.migrateModelPreference) {
          return {
            models: [],
            selection: { mode: "automatic" },
            legacyMigrationCompleted: true,
          };
        }
        if (channel === WHITE_LILY_IPC_CHANNELS.selectModel) {
          return { mode: "automatic" };
        }
        if (channel === WHITE_LILY_IPC_CHANNELS.discoverPcl2) {
          return pcl2Candidates;
        }
        if (channel === WHITE_LILY_IPC_CHANNELS.detectLanCandidates) {
          return lanCandidates;
        }
        if (channel === WHITE_LILY_IPC_CHANNELS.confirmLanCandidate) {
          return {
            status: "confirmed",
            port: 51321,
            version: "1.21.5",
            confirmedAt: 1_000,
          };
        }
        if (
          channel === WHITE_LILY_IPC_CHANNELS.getMinecraftComponentStatus ||
          channel === WHITE_LILY_IPC_CHANNELS.installMinecraftComponents ||
          channel === WHITE_LILY_IPC_CHANNELS.removeMinecraftComponents
        ) {
          return {
            state: "ready",
            bridgeInstalled: true,
            bridgeActive: true,
            avatarInstalled: true,
            restartRequired: false,
          };
        }
        if (channel === WHITE_LILY_IPC_CHANNELS.readOwnerIdentity) {
          return ownerAuthoritySnapshot;
        }
        if (channel === WHITE_LILY_IPC_CHANNELS.updateOwnerIdentity) {
          return { ...ownerAuthoritySnapshot, revision: 8 };
        }
        return idleSnapshot;
      },
      subscribe: () => () => undefined,
    };

    const api = createWhiteLilyApi(transport);

    expect(Object.keys(api).sort()).toEqual(
      [
        "status",
        "start",
        "stop",
        "stopTask",
        "emergencyStop",
        "readOwnerIdentity",
        "updateOwnerIdentity",
        "subscribeOwnerIdentity",
        "subscribeRuntime",
        "getAccount",
        "startChatGptLogin",
        "cancelChatGptLogin",
        "commitMemoryMigration",
        "listModels",
        "migrateModelPreference",
        "selectModel",
        "discoverPcl2",
        "detectLanCandidates",
        "confirmLanCandidate",
        "getMinecraftComponentStatus",
        "installMinecraftComponents",
        "removeMinecraftComponents",
        "bindConfirmedWorld",
        "readProfile",
        "updateProfile",
        "setBehaviorMode",
        "readMemories",
        "searchMemories",
        "addMemory",
        "updateMemory",
        "forgetMemory",
        "pinMemory",
        "previewMemoryMigration",
        "setMemoryScope",
        "exportMemories",
        "previewDiagnostics",
        "exportDiagnostics",
        "readWorldProfile",
        "rollbackMemoryMigration",
        "updateSafetyProfile",
        "readStartupSetting",
        "setStartupSetting",
        "readCloseToTraySetting",
        "setCloseToTraySetting",
      ].sort(),
    );
    await api.status();
    await api.start();
    await api.stop();
    await api.stopTask();
    await api.emergencyStop();
    await api.readOwnerIdentity();
    await api.updateOwnerIdentity({ expectedRevision: 7, ownerUsername: "NewOwner" });
    await api.getAccount();
    await api.startChatGptLogin();
    await api.cancelChatGptLogin("opaque_attempt_1234");
    await api.listModels();
    await api.migrateModelPreference(null);
    await api.selectModel({ mode: "automatic" });
    await expect(api.discoverPcl2()).resolves.toEqual(pcl2Candidates);
    await expect(api.detectLanCandidates()).resolves.toEqual(lanCandidates);
    await expect(api.confirmLanCandidate("lan_candidate_1234")).resolves.toMatchObject({
      status: "confirmed",
      port: 51321,
    });
    await expect(api.getMinecraftComponentStatus("lan_candidate_1234")).resolves.toMatchObject({
      state: "ready",
    });
    await expect(
      api.installMinecraftComponents("lan_candidate_1234", ["bridge", "avatar"]),
    ).resolves.toMatchObject({ state: "ready" });
    await expect(
      api.removeMinecraftComponents("lan_candidate_1234", ["avatar"]),
    ).resolves.toMatchObject({ state: "ready" });
    expect(invoked).toEqual([
      WHITE_LILY_IPC_CHANNELS.status,
      WHITE_LILY_IPC_CHANNELS.start,
      WHITE_LILY_IPC_CHANNELS.stop,
      WHITE_LILY_IPC_CHANNELS.stopTask,
      WHITE_LILY_IPC_CHANNELS.emergencyStop,
      WHITE_LILY_IPC_CHANNELS.readOwnerIdentity,
      WHITE_LILY_IPC_CHANNELS.updateOwnerIdentity,
      WHITE_LILY_IPC_CHANNELS.getAccount,
      WHITE_LILY_IPC_CHANNELS.startChatGptLogin,
      WHITE_LILY_IPC_CHANNELS.cancelChatGptLogin,
      WHITE_LILY_IPC_CHANNELS.listModels,
      WHITE_LILY_IPC_CHANNELS.migrateModelPreference,
      WHITE_LILY_IPC_CHANNELS.selectModel,
      WHITE_LILY_IPC_CHANNELS.discoverPcl2,
      WHITE_LILY_IPC_CHANNELS.detectLanCandidates,
      WHITE_LILY_IPC_CHANNELS.confirmLanCandidate,
      WHITE_LILY_IPC_CHANNELS.getMinecraftComponentStatus,
      WHITE_LILY_IPC_CHANNELS.installMinecraftComponents,
      WHITE_LILY_IPC_CHANNELS.removeMinecraftComponents,
    ]);
    expect(api).not.toHaveProperty("invoke");
    expect(api).not.toHaveProperty("send");
    expect(api).not.toHaveProperty("ipcRenderer");
    expect(api).not.toHaveProperty("electron");
  });

  it("rejects malformed LAN public values and renderer-supplied connection material", async () => {
    const malformedTransport: PreloadTransport = {
      invoke: async (channel) =>
        channel === WHITE_LILY_IPC_CHANNELS.detectLanCandidates
          ? [{ ...lanCandidates[0]!, pid: 4200 }]
          : {
              status: "confirmed",
              port: 51321,
              version: "1.21.5",
              confirmedAt: 1_000,
              proof: "proof_nonce_12345678",
            },
      subscribe: () => () => undefined,
    };
    const api = createWhiteLilyApi(malformedTransport);
    await expect(api.detectLanCandidates()).rejects.toThrow("invalid LAN candidates");
    await expect(api.confirmLanCandidate("lan_candidate_1234")).rejects.toThrow(
      "invalid confirmed LAN session",
    );
    await expect(
      api.confirmLanCandidate({
        id: "lan_candidate_1234",
        host: "127.0.0.1",
        port: 51321,
      } as never),
    ).rejects.toThrow("invalid LAN candidate");
  });

  it("validates preload return values and subscribed events before renderer delivery", async () => {
    let eventListener: ((value: unknown) => void) | undefined;
    const transport: PreloadTransport = {
      invoke: async () => ({ ...idleSnapshot, leakedToken: "secret" }),
      subscribe: (_channel, listener) => {
        eventListener = listener;
        return () => undefined;
      },
    };
    const api = createWhiteLilyApi(transport);
    const rendererListener = vi.fn();
    api.subscribeRuntime(rendererListener);

    await expect(api.status()).rejects.toThrow("invalid runtime snapshot");
    eventListener?.({
      kind: "lifecycle",
      revision: 7,
      state: "running",
      leakedPath: "secret",
    });
    expect(rendererListener).not.toHaveBeenCalled();
    eventListener?.({ kind: "lifecycle", revision: 7, state: "running" });
    expect(rendererListener).toHaveBeenCalledWith({
      kind: "lifecycle",
      revision: 7,
      state: "running",
    });
    const invalidation = {
      kind: "connection_invalidated" as const,
      revision: 8,
      reason: "model_unavailable" as const,
      snapshot: {
        ...idleSnapshot,
        revision: 8,
        lifecycle: "stopped" as const,
      },
    };
    eventListener?.(invalidation);
    expect(rendererListener).toHaveBeenLastCalledWith(invalidation);
    eventListener?.({
      ...invalidation,
      revision: 9,
      snapshot: { ...invalidation.snapshot, revision: 8 },
    });
    expect(rendererListener).toHaveBeenCalledTimes(2);
    eventListener?.({
      ...invalidation,
      revision: 9,
      snapshot: {
        ...invalidation.snapshot,
        revision: 9,
        lifecycle: "running",
        codex: { state: "ready", model: "stale-model" },
      },
    });
    expect(rendererListener).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed or excessive PCL2 discovery output at the preload boundary", async () => {
    const malformedTransport: PreloadTransport = {
      invoke: async () => [
        {
          ...pcl2Candidates[0]!,
          canonicalPath: String.raw`C:\Profiles\Private\Plain Craft Launcher 2.exe`,
        },
      ],
      subscribe: () => () => undefined,
    };
    await expect(createWhiteLilyApi(malformedTransport).discoverPcl2()).rejects.toThrow(
      "invalid PCL2 candidates",
    );

    const excessiveTransport: PreloadTransport = {
      invoke: async () => Array.from({ length: 33 }, () => pcl2Candidates[0]),
      subscribe: () => () => undefined,
    };
    await expect(createWhiteLilyApi(excessiveTransport).discoverPcl2()).rejects.toThrow(
      "invalid PCL2 candidates",
    );
  });

  it("removes only wrapped listeners from their dedicated channels and unsubscribes idempotently", () => {
    const listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>();
    const removeListener = vi.fn(
      (channel: string, listener: (event: unknown, value: unknown) => void) => {
        listeners.get(channel)?.delete(listener);
      },
    );
    const ipcRenderer: IpcRendererPort = {
      invoke: async () => idleSnapshot,
      on: (channel, listener) => {
        const channelListeners = listeners.get(channel) ?? new Set();
        channelListeners.add(listener);
        listeners.set(channel, channelListeners);
      },
      removeListener,
    };
    const transport = createPreloadTransport(ipcRenderer);
    const api = createWhiteLilyApi(transport);
    const rendererListener = vi.fn();
    const unrelated = (): void => undefined;
    listeners.set(WHITE_LILY_IPC_CHANNELS.runtimeEvent, new Set([unrelated]));

    const unsubscribeRuntime = api.subscribeRuntime(rendererListener);
    const unsubscribeOwner = api.subscribeOwnerIdentity(vi.fn());
    expect(listeners.get(WHITE_LILY_IPC_CHANNELS.runtimeEvent)?.size).toBe(2);
    expect(listeners.get(WHITE_LILY_IPC_CHANNELS.ownerIdentityEvent)?.size).toBe(1);
    unsubscribeRuntime();
    unsubscribeRuntime();
    unsubscribeOwner();
    unsubscribeOwner();

    expect(removeListener).toHaveBeenCalledTimes(2);
    expect(listeners.get(WHITE_LILY_IPC_CHANNELS.runtimeEvent)).toEqual(new Set([unrelated]));
    expect(listeners.get(WHITE_LILY_IPC_CHANNELS.ownerIdentityEvent)).toEqual(new Set());
  });
});

describe("Electron window security", () => {
  it("creates a sandboxed isolated renderer without Node integration", () => {
    expect(
      createMainWindowOptions(String.raw`C:\Program Files\WhiteLily\preload.js`).webPreferences,
    ).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
  });
});
