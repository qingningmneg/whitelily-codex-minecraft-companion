import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_PROTOCOL_VERSION,
  MAX_DESKTOP_LINE_BYTES,
  parseDesktopEvent,
  parseDesktopRequest,
  parseDesktopResponse,
  type ConfirmedConnectionProof,
  type DesktopCommand,
  type DesktopRequest,
} from "../../src/desktop/desktopProtocol.js";
import {
  createDefaultDesktopChildServices,
  runDesktopChild,
  type DesktopChildServices,
} from "../../src/desktop/childMain.js";
import { RuntimeFacade } from "../../src/runtime/runtimeFacade.js";
import { ActionCapabilityError } from "../../src/app.js";
import { MineflayerBridgeError } from "../../src/minecraft/mineflayerConnection.js";
import type { AccountSnapshot } from "../../src/codex/accountService.js";
import type { Model } from "../../src/codex/generated/v2/Model.js";
import {
  ModelCatalog,
  type ModelCatalogEvent,
  type ModelSelection,
  type ModelSelectionInput,
  type PreparedModelSelection,
  type ResolvedModelSelection,
} from "../../src/codex/modelCatalog.js";
import { ModelPreferenceStore } from "../../src/codex/modelPreferenceStore.js";
import { FarmingPreferenceStore } from "../../src/profile/farmingPreferenceStore.js";
import type { MinecraftEvent } from "../../src/minecraft/minecraftPort.js";
import type { RuntimeEvent, RuntimeSnapshot } from "../../src/runtime/runtimeEvents.js";
import type { TaskStopReason } from "../../src/safety/taskBudget.js";
import type { RuntimeSafetyConfiguration } from "../../src/safety/safetyProfile.js";
import { createDefaultCompanionProfile } from "../../src/profile/profileSchema.js";
import { DocumentStoreError } from "../../src/storage/documentStore.js";
import {
  fingerprintConfirmedWorld,
  type ConfirmedWorldBinding,
  type WorldProfile,
} from "../../src/world/worldProfileStore.js";
import type { DesktopChildWorldProfileStore } from "../../src/desktop/childServer.js";
import type { DesktopChildMemoryStore } from "../../src/desktop/childServer.js";
import { ScopedMemoryStore, type ScopedMemoryExport } from "../../src/memory/scopedMemoryStore.js";
import { MemoryMigration } from "../../src/memory/memoryMigration.js";
import {
  createDesktopChildHarness,
  type DesktopChildHarness,
  type DesktopRuntime,
} from "../support/desktopChildHarness.js";
import { validConfig } from "../support/appHarness.js";
import {
  OwnerIdentityError,
  type OwnerIdentityAccess,
  type OwnerIdentityErrorCode,
  type OwnerIdentitySnapshot,
} from "../../src/identity/ownerIdentity.js";

const idleSnapshot: RuntimeSnapshot = {
  revision: 0,
  lifecycle: "idle",
  minecraft: { state: "disconnected", sessionId: null },
  codex: { state: "stopped", model: null },
  actions: null,
  task: null,
  actionQueue: { goal: null, items: [] },
  lastError: null,
};

const readyActions = {
  state: "ready",
  workspaceVersion: "workspace-1",
  mcpListening: true,
  discoveredToolCount: 15,
} as const;

const readyActionAccess = {
  snapshot: () => readyActions,
  subscribe: () => () => undefined,
};

const stopNoTask = async (): Promise<void> => undefined;

const openHarnesses: DesktopChildHarness[] = [];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(
  options: Parameters<typeof createDesktopChildHarness>[0] = {},
): DesktopChildHarness {
  const harness = createDesktopChildHarness(options);
  openHarnesses.push(harness);
  return harness;
}

interface ControlledOwnerIdentity extends OwnerIdentityAccess {
  failNext(code: OwnerIdentityErrorCode): void;
  listenerCount(): number;
}

function ownerHarness(ownerUsername: string | null): ControlledOwnerIdentity {
  let snapshot: OwnerIdentitySnapshot = Object.freeze({
    revision: 0,
    ownerUsername,
    configured: ownerUsername !== null,
    presence: "unknown",
  });
  let nextFailure: OwnerIdentityErrorCode | undefined;
  const listeners = new Set<(snapshot: OwnerIdentitySnapshot) => void>();
  return {
    snapshot: () => {
      if (nextFailure === "OWNER_IDENTITY_CONFIG_INVALID") {
        nextFailure = undefined;
        throw new OwnerIdentityError("OWNER_IDENTITY_CONFIG_INVALID");
      }
      return snapshot;
    },
    update: async (input) => {
      if (nextFailure !== undefined) {
        const code = nextFailure;
        nextFailure = undefined;
        throw new OwnerIdentityError(code);
      }
      if (input.expectedRevision !== snapshot.revision) {
        throw new OwnerIdentityError("OWNER_IDENTITY_CONFIG_CONFLICT");
      }
      if (input.ownerUsername === snapshot.ownerUsername) return snapshot;
      snapshot = Object.freeze({
        revision: snapshot.revision + 1,
        ownerUsername: input.ownerUsername,
        configured: true,
        presence: "unknown",
      });
      for (const listener of listeners) listener(snapshot);
      return snapshot;
    },
    setPresence: (input) => {
      if (
        input.revision !== snapshot.revision ||
        input.ownerUsername !== snapshot.ownerUsername ||
        input.presence === snapshot.presence
      ) {
        return;
      }
      snapshot = Object.freeze({ ...snapshot, presence: input.presence });
      for (const listener of listeners) listener(snapshot);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    failNext: (code) => {
      nextFailure = code;
    },
    listenerCount: () => listeners.size,
  };
}

function inertDesktopChildServices(): DesktopChildServices {
  return {
    ownerIdentity: ownerHarness("HarnessOwner"),
    account: {
      getAccount: async () => ({ status: "signed_out" }),
      startChatGptLogin: async () => ({
        attemptId: "opaque_attempt_1234",
        expiresAt: 60_000,
        loginUrl: "https://auth.openai.com/oauth",
      }),
      cancelChatGptLogin: async (attemptId) => ({ status: "cancelled", attemptId }),
      subscribe: () => () => undefined,
      stop: async () => undefined,
    },
    models: {
      listModels: async () => ({
        models: [],
        selection: { mode: "automatic" },
        legacyMigrationCompleted: false,
      }),
      migrateLegacyPreference: async (candidate) => ({
        models: [],
        selection:
          candidate?.mode === "explicit"
            ? { ...candidate, available: true }
            : { mode: "automatic" },
        legacyMigrationCompleted: true,
      }),
      selectModel: async () => ({ mode: "automatic" }),
      prepareSelection: async (selection) => ({
        preferenceRevision: 0,
        requested: selection,
        resolved: { modelId: "inert-live-model", reasoningEffort: "medium" },
      }),
      commitSelection: async (prepared) =>
        prepared.requested.mode === "automatic"
          ? { mode: "automatic" }
          : { ...prepared.requested, available: true },
      resolveRuntimeSelection: async () => ({
        modelId: "inert-live-model",
        reasoningEffort: "medium",
      }),
      subscribe: () => () => undefined,
      stop: () => undefined,
    },
    createRuntime: async (_connection, initialRevision) =>
      new RuntimeFacade({
        initialRevision,
        lifecycle: {
          start: async () => undefined,
          stop: async () => undefined,
        },
      }),
  };
}

function request(id: string, kind: DesktopRequest["command"]["kind"]): DesktopRequest {
  return parseDesktopRequest({
    version: DESKTOP_PROTOCOL_VERSION,
    id,
    command: { kind },
  });
}

function commandRequest(id: string, command: DesktopCommand): DesktopRequest {
  return parseDesktopRequest({
    version: DESKTOP_PROTOCOL_VERSION,
    id,
    command,
  });
}

function privateWorldBindRequest(
  id: string,
  binding: ConfirmedWorldBinding,
  expectedRevision = 0,
): string {
  return `${JSON.stringify({
    version: 1,
    id,
    privateCommand: {
      kind: "bind_confirmed_world",
      expectedRevision,
      label: "Survival",
      binding,
    },
  })}\n`;
}

function connectionInvalidations(harness: DesktopChildHarness): string[] {
  return harness
    .lines()
    .map((line) => JSON.parse(line) as { event?: { kind?: string; reason?: string } })
    .filter((message) => message.event?.kind === "connection_invalidated")
    .map((message) => message.event?.reason ?? "");
}

function serviceModel(id: string, effort: string, isDefault = false): Model {
  return {
    id: `record-${id}`,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: `Live ${id}`,
    description: "Service model",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: effort, description: effort }],
    defaultReasoningEffort: effort,
    inputModalities: ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault,
  };
}

async function memoryPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "whitelily-desktop-memory-")), "scoped.json");
}

function memoryEnvelope(revision: number, updatedAt: string, summary: string): ScopedMemoryExport {
  return {
    schemaVersion: 1,
    revision,
    updatedAt,
    records: [
      {
        id: 1,
        category: "project",
        summary,
        importance: 3,
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt,
        scope: "global",
        source: "manual",
        pinned: false,
        revision: 0,
      },
    ],
    legacyMigrated: false,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const harness of openHarnesses.splice(0)) {
    harness.releaseLifecycleStop();
    await harness.server.stop();
    harness.input.destroy();
    harness.output.destroy();
  }
});

describe("DesktopChildServer", () => {
  it("passes the same config-scoped farming preference store into desktop runtimes", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-farming-child-"));
    try {
      const configPath = join(rootDirectory, "config.toml");
      const preferenceRoot = join(rootDirectory, "config");
      await Promise.all([
        writeFile(configPath, validConfig, "utf8"),
        mkdir(preferenceRoot, { recursive: true }),
      ]);
      const seeded = new FarmingPreferenceStore({ rootDirectory: preferenceRoot });
      await seeded.setAllowed(0);
      let runtimeStore: FarmingPreferenceStore | undefined;
      const services = await createDefaultDesktopChildServices(
        { configPath, cwd: rootDirectory },
        "0.2.0-beta.2",
        async (_configPath, _connection, _revision, _selection, _ownerIdentity, farmingStore) => {
          runtimeStore = farmingStore;
          return new RuntimeFacade({
            lifecycle: { start: async () => undefined, stop: async () => undefined },
          });
        },
      );

      await services.createRuntime(
        { host: "127.0.0.1", port: 25565 },
        0,
        { modelId: "gpt-5.6-terra", reasoningEffort: "low" },
        { compatibilityVerified: true, requestedPreset: "standard" },
      );

      expect(runtimeStore).toBeDefined();
      await expect(runtimeStore!.read()).resolves.toMatchObject({
        revision: 1,
        value: { status: "allowed" },
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("reads and updates owner identity without exposing config input", async () => {
    const ownerIdentity = ownerHarness("OldOwner");
    const harness = createHarness({ ownerIdentity });

    harness.send(commandRequest("owner-read", { kind: "read_owner_identity" }));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "owner-read",
      ok: true,
      result: { ownerUsername: "OldOwner", revision: 0 },
    });

    harness.send(
      commandRequest("owner-update", {
        kind: "update_owner_identity",
        expectedRevision: 0,
        ownerUsername: "NewOwner",
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "owner-update",
      ok: true,
      result: {
        ownerUsername: "NewOwner",
        revision: 1,
        configured: true,
        presence: "unknown",
      },
    });
  });

  it("refuses start_runtime until the owner is configured", async () => {
    const createRuntime = vi.fn(async () => {
      throw new Error("runtime must not be created");
    });
    const harness = createHarness({
      ownerIdentity: ownerHarness(null),
      createRuntime,
      lazyRuntime: true,
    });

    harness.send(request("owner-required", "start_runtime"));

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "owner-required",
      ok: false,
      error: {
        code: "OWNER_IDENTITY_REQUIRED",
        message: "Owner identity is required",
      },
    });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("preserves confirmed connection authority across the first-run owner gate", async () => {
    const ownerIdentity = ownerHarness(null);
    const createRuntime = vi.fn(
      async (_connection, initialRevision: number) =>
        new RuntimeFacade({
          initialRevision,
          lifecycle: {
            start: async () => undefined,
            stop: async () => undefined,
          },
        }),
    );
    const harness = createHarness({
      ownerIdentity,
      createRuntime,
      lazyRuntime: true,
      now: () => 1_000,
    });
    harness.send(
      commandRequest("owner-gate-confirm", {
        kind: "set_confirmed_connection",
        proof: {
          nonce: "owner_gate_proof_1234",
          port: 51321,
          issuedAt: 1_000,
          expiresAt: 11_000,
        },
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "owner-gate-confirm",
      ok: true,
    });
    harness.send(request("owner-gate-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "owner-gate-start",
      ok: false,
      error: { code: "OWNER_IDENTITY_REQUIRED" },
    });

    harness.send(
      commandRequest("owner-gate-update", {
        kind: "update_owner_identity",
        expectedRevision: 0,
        ownerUsername: "NewOwner",
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "owner-gate-update",
      ok: true,
    });
    harness.send(request("owner-gate-retry", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "owner-gate-retry",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(createRuntime).toHaveBeenCalledOnce();
  });

  it("emits one owner event after a commit and none on no-op, stale, or failed updates", async () => {
    const ownerIdentity = ownerHarness("OldOwner");
    const harness = createHarness({ ownerIdentity });

    harness.send(
      commandRequest("owner-commit", {
        kind: "update_owner_identity",
        expectedRevision: 0,
        ownerUsername: "NewOwner",
      }),
    );
    await expect(harness.nextEvent()).resolves.toEqual({
      version: DESKTOP_PROTOCOL_VERSION,
      event: {
        kind: "owner_identity",
        owner: {
          revision: 1,
          ownerUsername: "NewOwner",
          configured: true,
          presence: "unknown",
        },
      },
    });
    await expect(harness.nextResponse()).resolves.toMatchObject({ id: "owner-commit", ok: true });

    const ownerEventCount = (): number =>
      harness
        .lines()
        .map((line) => JSON.parse(line) as { event?: { kind?: string } })
        .filter((message) => message.event?.kind === "owner_identity").length;
    harness.send(
      commandRequest("owner-no-op", {
        kind: "update_owner_identity",
        expectedRevision: 1,
        ownerUsername: "NewOwner",
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({ id: "owner-no-op", ok: true });

    harness.send(
      commandRequest("owner-stale", {
        kind: "update_owner_identity",
        expectedRevision: 0,
        ownerUsername: "StaleOwner",
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "owner-stale",
      ok: false,
      error: { code: "OWNER_IDENTITY_CONFIG_CONFLICT" },
    });

    ownerIdentity.failNext("OWNER_IDENTITY_WRITE_FAILED");
    harness.send(
      commandRequest("owner-write-failed", {
        kind: "update_owner_identity",
        expectedRevision: 1,
        ownerUsername: "FailedOwner",
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "owner-write-failed",
      ok: false,
      error: { code: "OWNER_IDENTITY_WRITE_FAILED" },
    });
    await delay(10);
    expect(ownerEventCount()).toBe(1);
  });

  it("maps owner errors to fixed confidential protocol messages", async () => {
    const ownerIdentity = ownerHarness("OldOwner");
    const harness = createHarness({ ownerIdentity });
    for (const [index, code] of [
      "OWNER_IDENTITY_INVALID",
      "OWNER_IDENTITY_CONFIG_CONFLICT",
      "OWNER_IDENTITY_WRITE_FAILED",
      "OWNER_IDENTITY_CONFIG_INVALID",
    ].entries()) {
      ownerIdentity.failNext(code as OwnerIdentityErrorCode);
      harness.send(
        commandRequest(`owner-error-${index}`, {
          kind: "update_owner_identity",
          expectedRevision: 0,
          ownerUsername: "PrivateOwner",
        }),
      );
      const response = await harness.nextResponse();
      expect(response).toMatchObject({
        id: `owner-error-${index}`,
        ok: false,
        error: { code },
      });
      expect(JSON.stringify(response)).not.toMatch(/PrivateOwner|config\.toml|[A-Z]:\\/u);
    }
  });

  it("unsubscribes the owner identity listener during idempotent stop", async () => {
    const ownerIdentity = ownerHarness("OldOwner");
    const harness = createHarness({ ownerIdentity });
    expect(ownerIdentity.listenerCount()).toBe(1);

    await harness.server.stop();
    await harness.server.stop();

    expect(ownerIdentity.listenerCount()).toBe(0);
  });

  it("uses one default owner service for child reads, updates, and events", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "whitelily-owner-child-"));
    const productVersion = (
      JSON.parse(await readFile(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    await writeFile(
      join(cwd, "config.toml"),
      validConfig.replace('owner_username = "TestOwner"', 'owner_username = "YourMcName"'),
      "utf8",
    );
    const input = new PassThrough();
    const output = new PassThrough();
    let rawOutput = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rawOutput += chunk;
    });
    const running = runDesktopChild([], { input, output, cwd, appVersion: productVersion });

    input.write(
      `${JSON.stringify(commandRequest("default-owner-read", { kind: "read_owner_identity" }))}\n`,
    );
    await vi.waitFor(() => expect(rawOutput).toContain('"id":"default-owner-read"'));
    input.write(
      `${JSON.stringify(
        commandRequest("default-owner-update", {
          kind: "update_owner_identity",
          expectedRevision: 0,
          ownerUsername: "NewOwner",
        }),
      )}\n`,
    );
    await vi.waitFor(() => expect(rawOutput).toContain('"id":"default-owner-update"'));
    input.end();
    await running;

    const messages = rawOutput
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages).toContainEqual(
      expect.objectContaining({
        id: "default-owner-read",
        ok: true,
        result: expect.objectContaining({ ownerUsername: null, configured: false, revision: 0 }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        id: "default-owner-update",
        ok: true,
        result: expect.objectContaining({ ownerUsername: "NewOwner", revision: 1 }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        event: {
          kind: "owner_identity",
          owner: expect.objectContaining({ ownerUsername: "NewOwner", revision: 1 }),
        },
      }),
    );
    expect(await readFile(join(cwd, "config.toml"), "utf8")).toContain(
      'owner_username = "NewOwner"',
    );
  });

  it("keeps diagnostic preview authority in the child and returns no archive path", async () => {
    const preview = vi.fn(async () => ({
      exportId: "diagnostic_1234567890",
      actionCapability: {
        workspaceVersion: "workspace-1",
        state: "ready" as const,
        mcpListening: true,
        discoveredToolCount: 15,
        errorCode: null,
      },
      files: [
        { logicalName: "app-version.json" as const, size: 20, redactions: 0 },
        { logicalName: "os-summary.json" as const, size: 20, redactions: 0 },
        { logicalName: "dependency-versions.json" as const, size: 20, redactions: 0 },
        { logicalName: "minecraft-compatibility.json" as const, size: 20, redactions: 0 },
        { logicalName: "app-log.jsonl" as const, size: 20, redactions: 0 },
        { logicalName: "audit-log.jsonl" as const, size: 20, redactions: 0 },
        { logicalName: "config-schema-summary.json" as const, size: 20, redactions: 0 },
      ],
      omitted: [
        "minecraft-saves" as const,
        "authentication-data" as const,
        "pcl2-account-data" as const,
        "complete-companion-profile" as const,
        "complete-memories" as const,
        "raw-chat" as const,
      ],
    }));
    const createArchive = vi.fn(async (exportId: string) => ({
      exportId,
      path: String.raw`C:\private\WhiteLily\diagnostics\diagnostic_1234567890.zip`,
      size: 512,
      sha256: "a".repeat(64),
    }));
    const harness = createHarness({
      diagnostics: { preview, createArchive, dispose: async () => undefined },
    });
    harness.runtime.snapshot = () => ({
      ...idleSnapshot,
      actions: readyActions,
    });

    harness.send(commandRequest("diagnostic-preview", { kind: "preview_diagnostics" }));
    const previewResponse = await harness.nextResponse();
    expect(previewResponse.ok, JSON.stringify(previewResponse)).toBe(true);
    expect(previewResponse).toMatchObject({
      id: "diagnostic-preview",
      ok: true,
      result: { exportId: "diagnostic_1234567890" },
    });
    harness.send(
      commandRequest("diagnostic-export", {
        kind: "prepare_diagnostic_archive",
        exportId: "diagnostic_1234567890",
      }),
    );
    const response = await harness.nextResponse();
    expect(response).toMatchObject({
      id: "diagnostic-export",
      ok: true,
      result: {
        exportId: "diagnostic_1234567890",
        size: 512,
        sha256: "a".repeat(64),
      },
    });
    expect(JSON.stringify(response)).not.toContain("C:\\private");
    expect(preview).toHaveBeenCalledOnce();
    expect(preview).toHaveBeenCalledWith(readyActions, null);
    expect(createArchive).toHaveBeenCalledWith("diagnostic_1234567890");
  });

  it("waits for an in-flight diagnostic request before idempotent shutdown disposal", async () => {
    let releaseArchive!: () => void;
    let archiveEntered!: () => void;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      archiveEntered = resolve;
    });
    const dispose = vi.fn(async () => undefined);
    const diagnostics = {
      preview: async () => ({
        exportId: "diagnostic_1234567890",
        actionCapability: {
          workspaceVersion: null,
          state: "starting" as const,
          mcpListening: false,
          discoveredToolCount: 0,
          errorCode: null,
        },
        files: [
          { logicalName: "app-version.json" as const, size: 20, redactions: 0 },
          { logicalName: "os-summary.json" as const, size: 20, redactions: 0 },
          { logicalName: "dependency-versions.json" as const, size: 20, redactions: 0 },
          { logicalName: "minecraft-compatibility.json" as const, size: 20, redactions: 0 },
          { logicalName: "app-log.jsonl" as const, size: 0, redactions: 0 },
          { logicalName: "audit-log.jsonl" as const, size: 0, redactions: 0 },
          { logicalName: "config-schema-summary.json" as const, size: 20, redactions: 0 },
        ],
        omitted: [
          "minecraft-saves" as const,
          "authentication-data" as const,
          "pcl2-account-data" as const,
          "complete-companion-profile" as const,
          "complete-memories" as const,
          "raw-chat" as const,
        ],
      }),
      createArchive: async (exportId: string) => {
        archiveEntered();
        await archiveGate;
        return {
          exportId,
          path: String.raw`C:\private\diagnostic.zip`,
          size: 512,
          sha256: "a".repeat(64),
        };
      },
      dispose,
    };
    const harness = createHarness({ diagnostics });
    harness.send(commandRequest("diagnostic-preview", { kind: "preview_diagnostics" }));
    await harness.nextResponse();
    harness.send(
      commandRequest("diagnostic-export", {
        kind: "prepare_diagnostic_archive",
        exportId: "diagnostic_1234567890",
      }),
    );
    await entered;

    const stopping = harness.server.stop();
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
    releaseArchive();
    await stopping;
    await harness.server.stop();

    expect(dispose).toHaveBeenCalledOnce();
  });
  it("lets stricter LAN invalidation dominate a private bind preserve fence", async () => {
    let releaseStop!: () => void;
    let stopEntered!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const enteredStop = new Promise<void>((resolve) => {
      stopEntered = resolve;
    });
    let bindCalls = 0;
    const safetyConfigurations: Array<{
      requestedPreset?: string;
      compatibilityVerified: boolean;
    }> = [];
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision: 0,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: null,
      }),
      bindConfirmedWorld: async () => {
        bindCalls += 1;
        throw new Error("must not persist after authority loss");
      },
      updateSafetyProfile: async () => {
        throw new Error("unused");
      },
    };
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 100,
      worldProfiles: worlds,
      createRuntime: async (_connection, initialRevision, _selection, safety) => {
        safetyConfigurations.push(safety);
        return new RuntimeFacade({
          initialRevision,
          lifecycle: {
            start: async () => undefined,
            stop: async () => {
              stopEntered();
              await stopGate;
            },
          },
        });
      },
    });
    const proof: ConfirmedConnectionProof = {
      nonce: "preserve_bind_proof_0001",
      port: 25565,
      issuedAt: 10,
      expiresAt: 9_999,
    };
    const binding: ConfirmedWorldBinding = {
      canonicalInstancePath: "C:/Minecraft/Instance",
      javaSession: {
        pid: 1234,
        processStartedAt: 10,
        port: 25565,
        version: "1.21.5",
      },
      ownerUsername: "Owner",
      proof,
    };
    harness.send(
      commandRequest("preserve-bind-connection", { kind: "set_confirmed_connection", proof }),
    );
    await harness.nextResponse();
    harness.send(request("preserve-bind-start", "start_runtime"));
    await harness.nextResponse();

    harness.sendRaw(privateWorldBindRequest("preserve-bind", binding));
    await enteredStop;
    harness.send(
      commandRequest("preserve-bind-invalidate", {
        kind: "invalidate_connection",
        reason: "lan_changed",
      }),
    );
    releaseStop();

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "preserve-bind",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "preserve-bind-invalidate",
      ok: true,
    });
    expect(bindCalls).toBe(0);
    expect(connectionInvalidations(harness)).toContain("lan_changed");

    const nextProof = { ...proof, nonce: "preserve_bind_proof_0002" };
    harness.send(
      commandRequest("preserve-bind-next-connection", {
        kind: "set_confirmed_connection",
        proof: nextProof,
      }),
    );
    await harness.nextResponse();
    harness.send(request("preserve-bind-next-start", "start_runtime"));
    await harness.nextResponse();
    expect(safetyConfigurations.at(-1)).toEqual({ compatibilityVerified: false });
  });

  it("lets stricter emergency invalidation dominate an update preserve fence", async () => {
    let releaseStop!: () => void;
    let stopEntered!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const enteredStop = new Promise<void>((resolve) => {
      stopEntered = resolve;
    });
    let updateCalls = 0;
    const profile: WorldProfile = {
      id: "be176ae1-a4b4-4fd6-b04c-89634cd74a99",
      label: "Survival",
      instanceFingerprint: "f".repeat(43),
      ownerUsername: "Owner",
      safetyPreset: "standard",
    };
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision: 1,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: profile,
      }),
      bindConfirmedWorld: async () => {
        throw new Error("unused");
      },
      updateSafetyProfile: async () => {
        updateCalls += 1;
        throw new Error("must not persist after emergency");
      },
    };
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 100,
      worldProfiles: worlds,
      createRuntime: async (_connection, initialRevision) =>
        new RuntimeFacade({
          initialRevision,
          lifecycle: {
            start: async () => undefined,
            stop: async () => {
              stopEntered();
              await stopGate;
            },
          },
        }),
    });
    const proof: ConfirmedConnectionProof = {
      nonce: "preserve_update_proof_01",
      port: 25565,
      issuedAt: 10,
      expiresAt: 9_999,
    };
    harness.send(
      commandRequest("preserve-update-connection", { kind: "set_confirmed_connection", proof }),
    );
    await harness.nextResponse();
    harness.send(request("preserve-update-start", "start_runtime"));
    await harness.nextResponse();
    harness.send(
      commandRequest("preserve-update", {
        kind: "update_safety_profile",
        expectedRevision: 1,
        safetyPreset: "conservative",
      }),
    );
    await enteredStop;
    harness.send(request("preserve-update-emergency", "emergency_stop"));
    releaseStop();

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "preserve-update",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "preserve-update-emergency",
      ok: true,
    });
    expect(updateCalls).toBe(0);
    expect(connectionInvalidations(harness)).toContain("emergency_stop");
  });

  it("publishes a follow-up strict invalidation when tightening arrives during fence finalization", async () => {
    let releaseStop!: () => void;
    let stopEntered!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const enteredStop = new Promise<void>((resolve) => {
      stopEntered = resolve;
    });
    let bindCalls = 0;
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision: 0,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: null,
      }),
      bindConfirmedWorld: async () => {
        bindCalls += 1;
        throw new Error("must not persist after late invalidation");
      },
      updateSafetyProfile: async () => {
        throw new Error("unused");
      },
    };
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 100,
      worldProfiles: worlds,
      createRuntime: async (_connection, initialRevision) =>
        new RuntimeFacade({
          initialRevision,
          lifecycle: {
            start: async () => undefined,
            stop: async () => {
              stopEntered();
              await stopGate;
            },
          },
        }),
    });
    const proof: ConfirmedConnectionProof = {
      nonce: "finalize_bind_proof_0001",
      port: 25565,
      issuedAt: 10,
      expiresAt: 9_999,
    };
    const binding: ConfirmedWorldBinding = {
      canonicalInstancePath: "C:/Minecraft/Instance",
      javaSession: {
        pid: 1234,
        processStartedAt: 10,
        port: 25565,
        version: "1.21.5",
      },
      ownerUsername: "Owner",
      proof,
    };
    harness.send(
      commandRequest("finalize-bind-connection", { kind: "set_confirmed_connection", proof }),
    );
    await harness.nextResponse();
    harness.send(request("finalize-bind-start", "start_runtime"));
    await harness.nextResponse();
    harness.sendRaw(privateWorldBindRequest("finalize-bind", binding));
    await enteredStop;

    let publishEntered!: () => void;
    const enteredPublish = new Promise<void>((resolve) => {
      publishEntered = resolve;
    });
    const originalWrite = harness.output.write.bind(harness.output);
    harness.output.cork();
    harness.output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      const line = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (line.includes('"kind":"connection_invalidated"')) publishEntered();
      return Reflect.apply(originalWrite, harness.output, [chunk, ...args]) as boolean;
    }) as typeof harness.output.write;
    releaseStop();
    await enteredPublish;

    harness.send(
      commandRequest("finalize-bind-invalidate", {
        kind: "invalidate_connection",
        reason: "lan_changed",
      }),
    );
    harness.output.uncork();

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "finalize-bind",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "finalize-bind-invalidate",
      ok: true,
    });
    expect(bindCalls).toBe(0);
    expect(connectionInvalidations(harness)).toContain("lan_changed");
  });

  it("aborts a private bind when LAN invalidation wins while its document read is pending", async () => {
    let releaseRead!: () => void;
    let readEntered!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const enteredRead = new Promise<void>((resolve) => {
      readEntered = resolve;
    });
    let bindCalls = 0;
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => {
        readEntered();
        await readGate;
        return {
          schemaVersion: 1,
          revision: 0,
          updatedAt: "2026-07-29T00:00:00.000Z",
          value: null,
        };
      },
      bindConfirmedWorld: async () => {
        bindCalls += 1;
        throw new Error("must not persist");
      },
      updateSafetyProfile: async () => {
        throw new Error("unused");
      },
    };
    const harness = createHarness({ worldProfiles: worlds, now: () => 100 });
    const proof = { nonce: "race_private_proof_0001", port: 25565, issuedAt: 10, expiresAt: 9_999 };
    harness.send(commandRequest("race-connection", { kind: "set_confirmed_connection", proof }));
    await harness.nextResponse();
    harness.sendRaw(
      `${JSON.stringify({ version: 1, id: "race-bind", privateCommand: { kind: "bind_confirmed_world", expectedRevision: 0, label: "Race", binding: { canonicalInstancePath: "C:/Instance", javaSession: { pid: 1234, processStartedAt: 10, port: 25565, version: "1.21.5" }, ownerUsername: "Owner", proof } } })}\n`,
    );
    await enteredRead;
    harness.send(
      commandRequest("race-invalidate", { kind: "invalidate_connection", reason: "lan_changed" }),
    );
    releaseRead();
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "race-bind",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "race-invalidate",
      ok: true,
    });
    expect(bindCalls).toBe(0);
  });
  it("aborts a private bind when its exact current proof expires during document read", async () => {
    let now = 100;
    let releaseRead!: () => void;
    let readEntered!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const enteredRead = new Promise<void>((resolve) => {
      readEntered = resolve;
    });
    let bindCalls = 0;
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => {
        readEntered();
        await readGate;
        return {
          schemaVersion: 1,
          revision: 0,
          updatedAt: "2026-07-29T00:00:00.000Z",
          value: null,
        };
      },
      bindConfirmedWorld: async () => {
        bindCalls += 1;
        throw new Error("expired proof must not persist");
      },
      updateSafetyProfile: async () => {
        throw new Error("unused");
      },
    };
    const harness = createHarness({ worldProfiles: worlds, now: () => now });
    const proof: ConfirmedConnectionProof = {
      nonce: "read_expiry_proof_0001",
      port: 25565,
      issuedAt: 100,
      expiresAt: 101,
    };
    const binding: ConfirmedWorldBinding = {
      canonicalInstancePath: "C:/Minecraft/Instance",
      javaSession: {
        pid: 1234,
        processStartedAt: 10,
        port: 25565,
        version: "1.21.5",
      },
      ownerUsername: "Owner",
      proof,
    };
    harness.send(
      commandRequest("read-expiry-connection", { kind: "set_confirmed_connection", proof }),
    );
    await harness.nextResponse();
    harness.sendRaw(privateWorldBindRequest("read-expiry-bind", binding));
    await enteredRead;
    now = 101;
    releaseRead();

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "read-expiry-bind",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    expect(bindCalls).toBe(0);
  });
  it("does not install a stale binding when emergency stop arrives during private CAS", async () => {
    let releaseCommit!: () => void;
    let commitEntered!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const enteredCommit = new Promise<void>((resolve) => {
      commitEntered = resolve;
    });
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision: 0,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: null,
      }),
      bindConfirmedWorld: async () => {
        commitEntered();
        await commitGate;
        return {
          schemaVersion: 1,
          revision: 1,
          updatedAt: "2026-07-29T00:00:01.000Z",
          value: {
            id: "be176ae1-a4b4-4fd6-b04c-89634cd74a99",
            label: "Race",
            instanceFingerprint: "f".repeat(43),
            ownerUsername: "Owner",
            safetyPreset: "conservative",
          },
        };
      },
      updateSafetyProfile: async () => {
        throw new Error("unused");
      },
    };
    const harness = createHarness({ worldProfiles: worlds, now: () => 100 });
    const proof = { nonce: "race_private_proof_0002", port: 25565, issuedAt: 10, expiresAt: 9_999 };
    harness.send(commandRequest("cas-connection", { kind: "set_confirmed_connection", proof }));
    await harness.nextResponse();
    harness.sendRaw(
      `${JSON.stringify({ version: 1, id: "cas-bind", privateCommand: { kind: "bind_confirmed_world", expectedRevision: 0, label: "Race", binding: { canonicalInstancePath: "C:/Instance", javaSession: { pid: 1234, processStartedAt: 10, port: 25565, version: "1.21.5" }, ownerUsername: "Owner", proof } } })}\n`,
    );
    await enteredCommit;
    harness.send(request("cas-emergency", "emergency_stop"));
    releaseCommit();
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "cas-bind",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    await expect(harness.nextResponse()).resolves.toMatchObject({ id: "cas-emergency", ok: true });
  });
  it("drops standard safety when LAN confirmation is invalidated before a different session", async () => {
    let revision = 0;
    let profile: WorldProfile | null = null;
    const safetyConfigurations: Array<{
      requestedPreset?: string;
      compatibilityVerified: boolean;
    }> = [];
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: profile,
      }),
      bindConfirmedWorld: async (expectedRevision, binding, label) => {
        if (expectedRevision !== revision) {
          throw new DocumentStoreError("DOCUMENT_CONFLICT", "world profile revision conflict");
        }
        revision += 1;
        profile = {
          id: "be176ae1-a4b4-4fd6-b04c-89634cd74a99",
          label,
          instanceFingerprint: fingerprintConfirmedWorld(
            binding.canonicalInstancePath,
            binding.javaSession,
          ),
          ownerUsername: binding.ownerUsername,
          safetyPreset: "standard",
        };
        return {
          schemaVersion: 1,
          revision,
          updatedAt: "2026-07-29T00:00:01.000Z",
          value: profile,
        };
      },
      updateSafetyProfile: async () => {
        throw new Error("must not update");
      },
    };
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 100,
      worldProfiles: worlds,
      createRuntime: async (_connection, initialRevision, _selection, safety) => {
        safetyConfigurations.push(safety);
        return new RuntimeFacade({
          initialRevision,
          lifecycle: { start: async () => undefined, stop: async () => undefined },
        });
      },
    });
    const firstProof = {
      nonce: "private_world_session_0001",
      port: 25565,
      issuedAt: 10,
      expiresAt: 9_999,
    };
    harness.send(
      commandRequest("session-one", { kind: "set_confirmed_connection", proof: firstProof }),
    );
    await harness.nextResponse();
    harness.sendRaw(
      `${JSON.stringify({
        version: 1,
        id: "session-one-bind",
        privateCommand: {
          kind: "bind_confirmed_world",
          expectedRevision: 0,
          label: "Survival",
          binding: {
            canonicalInstancePath: "C:/Minecraft/Instance",
            javaSession: { pid: 1234, processStartedAt: 10, port: 25565, version: "1.21.5" },
            ownerUsername: "Owner",
            proof: firstProof,
          },
        },
      })}\n`,
    );
    await harness.nextResponse();
    harness.send(request("session-one-start", "start_runtime"));
    await harness.nextResponse();
    expect(safetyConfigurations).toEqual([
      { requestedPreset: "standard", compatibilityVerified: true },
    ]);

    harness.send(
      commandRequest("session-loss", { kind: "invalidate_connection", reason: "lan_changed" }),
    );
    await harness.nextResponse();
    harness.send(
      commandRequest("session-two", {
        kind: "set_confirmed_connection",
        proof: { ...firstProof, nonce: "private_world_session_0002" },
      }),
    );
    await harness.nextResponse();
    harness.send(request("session-two-start", "start_runtime"));
    await harness.nextResponse();
    expect(safetyConfigurations.at(-1)).toEqual({ compatibilityVerified: false });
  });
  it("keeps fingerprint-compatible safety after the live owner changes", async () => {
    let revision = 0;
    let profile: WorldProfile | null = null;
    const safetyConfigurations: Array<{
      requestedPreset?: string;
      compatibilityVerified: boolean;
    }> = [];
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: profile,
      }),
      bindConfirmedWorld: async (expectedRevision, binding, label) => {
        if (expectedRevision !== revision) {
          throw new DocumentStoreError("DOCUMENT_CONFLICT", "world profile revision conflict");
        }
        revision += 1;
        profile = {
          id: "be176ae1-a4b4-4fd6-b04c-89634cd74a99",
          label,
          instanceFingerprint: fingerprintConfirmedWorld(
            binding.canonicalInstancePath,
            binding.javaSession,
          ),
          ownerUsername: "OldOwner",
          safetyPreset: "standard",
        };
        return {
          schemaVersion: 1,
          revision,
          updatedAt: "2026-07-29T00:00:01.000Z",
          value: profile,
        };
      },
      updateSafetyProfile: async () => {
        throw new Error("must not update");
      },
    };
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 100,
      worldProfiles: worlds,
      createRuntime: async (_connection, initialRevision, _selection, safety) => {
        safetyConfigurations.push(safety);
        return new RuntimeFacade({
          initialRevision,
          lifecycle: { start: async () => undefined, stop: async () => undefined },
        });
      },
    });
    const proof = {
      nonce: "private_world_owner_change",
      port: 25565,
      issuedAt: 10,
      expiresAt: 9_999,
    };
    const binding: ConfirmedWorldBinding = {
      canonicalInstancePath: "C:/Minecraft/Instance",
      javaSession: { pid: 1234, processStartedAt: 10, port: 25565, version: "1.21.5" },
      ownerUsername: "NewOwner",
      proof,
    };

    harness.send(
      commandRequest("owner-change-connection", { kind: "set_confirmed_connection", proof }),
    );
    await harness.nextResponse();
    harness.sendRaw(privateWorldBindRequest("owner-change-bind", binding));
    await harness.nextResponse();
    harness.send(request("owner-change-start", "start_runtime"));
    await harness.nextResponse();

    expect(safetyConfigurations).toEqual([
      { requestedPreset: "standard", compatibilityVerified: true },
    ]);
  });
  it("accepts one parent-private world bind without exposing its authority to public commands", async () => {
    let revision = 0;
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: null,
      }),
      bindConfirmedWorld: async (expectedRevision, _binding, label) => {
        if (expectedRevision !== revision) {
          throw new DocumentStoreError("DOCUMENT_CONFLICT", "world profile revision conflict");
        }
        revision += 1;
        return {
          schemaVersion: 1,
          revision,
          updatedAt: "2026-07-29T00:00:01.000Z",
          value: {
            id: "be176ae1-a4b4-4fd6-b04c-89634cd74a99",
            instanceFingerprint: "f".repeat(43),
            ownerUsername: "Owner",
            label,
            safetyPreset: "standard",
          },
        };
      },
      updateSafetyProfile: async () => {
        throw new Error("must not update");
      },
    };
    const harness = createHarness({ worldProfiles: worlds, now: () => 100 });
    const privateBind = {
      version: 1,
      id: "private-world-bind",
      privateCommand: {
        kind: "bind_confirmed_world",
        expectedRevision: 0,
        label: "Survival",
        binding: {
          canonicalInstancePath: "C:/Minecraft/Instance",
          javaSession: { pid: 1234, processStartedAt: 10, port: 25565, version: "1.21.5" },
          ownerUsername: "Owner",
          proof: {
            nonce: "private_world_proof_0001",
            port: 25565,
            issuedAt: 10,
            expiresAt: 9_999,
          },
        },
      },
    };

    harness.send(
      commandRequest("private-world-connection", {
        kind: "set_confirmed_connection",
        proof: privateBind.privateCommand.binding.proof,
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "private-world-connection",
      ok: true,
    });
    harness.sendRaw(`${JSON.stringify(privateBind)}\n`);

    await expect(harness.nextResponse()).resolves.toMatchObject({
      version: 1,
      id: "private-world-bind",
      ok: true,
      result: { revision: 1, value: { label: "Survival", safetyPreset: "standard" } },
    });
    harness.send(request("private-world-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "private-world-start",
      ok: true,
      result: { lifecycle: "running" },
    });
    harness.sendRaw(`${JSON.stringify({ ...privateBind, id: "private-world-replay" })}\n`);
    await expect(harness.nextResponse()).resolves.toMatchObject({
      version: 1,
      id: "private-world-replay",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
  });
  it("hard-bounds private proof replay history and prunes expired entries before admitting new work", async () => {
    let now = 100;
    let bindCalls = 0;
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision: 0,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: null,
      }),
      bindConfirmedWorld: async (_expectedRevision, _binding, label) => {
        bindCalls += 1;
        return {
          schemaVersion: 1,
          revision: 1,
          updatedAt: "2026-07-29T00:00:01.000Z",
          value: {
            id: "be176ae1-a4b4-4fd6-b04c-89634cd74a99",
            label,
            instanceFingerprint: "f".repeat(43),
            ownerUsername: "Owner",
            safetyPreset: "standard",
          },
        };
      },
      updateSafetyProfile: async () => {
        throw new Error("unused");
      },
    };
    const harness = createHarness({ worldProfiles: worlds, now: () => now });
    const currentProof: ConfirmedConnectionProof = {
      nonce: "bounded_cache_current_01",
      port: 25565,
      issuedAt: now,
      expiresAt: 9_999,
    };
    const bindingFor = (proof: ConfirmedConnectionProof): ConfirmedWorldBinding => ({
      canonicalInstancePath: "C:/Minecraft/Instance",
      javaSession: {
        pid: 1234,
        processStartedAt: 10,
        port: 25565,
        version: "1.21.5",
      },
      ownerUsername: "Owner",
      proof,
    });
    harness.send(
      commandRequest("bounded-cache-connection", {
        kind: "set_confirmed_connection",
        proof: currentProof,
      }),
    );
    await harness.nextResponse();

    for (let index = 0; index < 256; index += 1) {
      const proof = {
        ...currentProof,
        nonce: `bounded_cache_fill_${String(index).padStart(4, "0")}`,
        expiresAt: 101,
      };
      harness.sendRaw(privateWorldBindRequest(`bounded-cache-fill-${index}`, bindingFor(proof)));
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: `bounded-cache-fill-${index}`,
        ok: false,
        error: { code: "CONNECTION_OPERATION_FAILED" },
      });
    }

    harness.sendRaw(privateWorldBindRequest("bounded-cache-full", bindingFor(currentProof)));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "bounded-cache-full",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    expect(bindCalls).toBe(0);

    now = 102;
    harness.sendRaw(privateWorldBindRequest("bounded-cache-pruned", bindingFor(currentProof)));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "bounded-cache-pruned",
      ok: true,
    });
    expect(bindCalls).toBe(1);

    harness.sendRaw(
      privateWorldBindRequest(
        "bounded-cache-expired",
        bindingFor({
          ...currentProof,
          nonce: "bounded_cache_fill_0000",
          expiresAt: 101,
        }),
        1,
      ),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "bounded-cache-expired",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    expect(bindCalls).toBe(1);
  });

  it("rejects an expired current-session private proof after its replay entry was pruned", async () => {
    let now = 100;
    let bindCalls = 0;
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision: 1,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: null,
      }),
      bindConfirmedWorld: async () => {
        bindCalls += 1;
        throw new Error("expired proof must not persist");
      },
      updateSafetyProfile: async () => {
        throw new Error("unused");
      },
    };
    const harness = createHarness({ worldProfiles: worlds, now: () => now });
    const proof: ConfirmedConnectionProof = {
      nonce: "expired_current_proof_01",
      port: 25565,
      issuedAt: 100,
      expiresAt: 101,
    };
    const binding: ConfirmedWorldBinding = {
      canonicalInstancePath: "C:/Minecraft/Instance",
      javaSession: {
        pid: 1234,
        processStartedAt: 10,
        port: 25565,
        version: "1.21.5",
      },
      ownerUsername: "Owner",
      proof,
    };
    harness.send(
      commandRequest("expired-current-connection", { kind: "set_confirmed_connection", proof }),
    );
    await harness.nextResponse();
    harness.sendRaw(privateWorldBindRequest("expired-current-consumed", binding));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "expired-current-consumed",
      ok: false,
      error: { code: "DOCUMENT_CONFLICT" },
    });

    now = 102;
    harness.sendRaw(
      privateWorldBindRequest("expired-current-prune", {
        ...binding,
        proof: {
          ...proof,
          nonce: "expired_current_pruner_1",
          expiresAt: 200,
        },
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "expired-current-prune",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });

    harness.sendRaw(privateWorldBindRequest("expired-current-retry", binding, 1));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "expired-current-retry",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    expect(bindCalls).toBe(0);
  });

  it("does not accumulate private proof replay history across a long-lived bind lifecycle", async () => {
    let now = 100;
    let revision = 0;
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: null,
      }),
      bindConfirmedWorld: async (expectedRevision, _binding, label) => {
        if (expectedRevision !== revision) throw new Error("unexpected revision");
        revision += 1;
        return {
          schemaVersion: 1,
          revision,
          updatedAt: "2026-07-29T00:00:01.000Z",
          value: {
            id: "be176ae1-a4b4-4fd6-b04c-89634cd74a99",
            label,
            instanceFingerprint: "f".repeat(43),
            ownerUsername: "Owner",
            safetyPreset: "standard",
          },
        };
      },
      updateSafetyProfile: async () => {
        throw new Error("unused");
      },
    };
    const harness = createHarness({ worldProfiles: worlds, now: () => now });

    for (let index = 0; index < 270; index += 1) {
      const proof: ConfirmedConnectionProof = {
        nonce: `lifecycle_proof_${String(index).padStart(4, "0")}`,
        port: 25565,
        issuedAt: now,
        expiresAt: now + 1,
      };
      const binding: ConfirmedWorldBinding = {
        canonicalInstancePath: "C:/Minecraft/Instance",
        javaSession: {
          pid: 1234,
          processStartedAt: 10,
          port: 25565,
          version: "1.21.5",
        },
        ownerUsername: "Owner",
        proof,
      };
      harness.send(
        commandRequest(`lifecycle-connection-${index}`, {
          kind: "set_confirmed_connection",
          proof,
        }),
      );
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: `lifecycle-connection-${index}`,
        ok: true,
      });
      harness.sendRaw(privateWorldBindRequest(`lifecycle-bind-${index}`, binding, revision));
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: `lifecycle-bind-${index}`,
        ok: true,
      });
      harness.send(request(`lifecycle-barrier-${index}`, "get_status"));
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: `lifecycle-barrier-${index}`,
        ok: true,
      });
      now += 2;
    }
    expect(revision).toBe(270);
  });

  it("allows a normal same-session safety update after its preserve fence", async () => {
    let revision = 0;
    let profile: WorldProfile | null = null;
    let updateCalls = 0;
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: profile,
      }),
      bindConfirmedWorld: async (_expectedRevision, binding, label) => {
        revision += 1;
        profile = {
          id: "be176ae1-a4b4-4fd6-b04c-89634cd74a99",
          label,
          instanceFingerprint: fingerprintConfirmedWorld(
            binding.canonicalInstancePath,
            binding.javaSession,
          ),
          ownerUsername: binding.ownerUsername,
          safetyPreset: "standard",
        };
        return {
          schemaVersion: 1,
          revision,
          updatedAt: "2026-07-29T00:00:01.000Z",
          value: profile,
        };
      },
      updateSafetyProfile: async (_expectedRevision, safetyPreset) => {
        updateCalls += 1;
        revision += 1;
        profile = { ...profile!, safetyPreset };
        return {
          schemaVersion: 1,
          revision,
          updatedAt: "2026-07-29T00:00:02.000Z",
          value: profile,
        };
      },
    };
    const harness = createHarness({ worldProfiles: worlds, now: () => 100 });
    const proof: ConfirmedConnectionProof = {
      nonce: "normal_update_proof_0001",
      port: 25565,
      issuedAt: 10,
      expiresAt: 9_999,
    };
    const binding: ConfirmedWorldBinding = {
      canonicalInstancePath: "C:/Minecraft/Instance",
      javaSession: {
        pid: 1234,
        processStartedAt: 10,
        port: 25565,
        version: "1.21.5",
      },
      ownerUsername: "Owner",
      proof,
    };
    harness.send(
      commandRequest("normal-update-connection", { kind: "set_confirmed_connection", proof }),
    );
    await harness.nextResponse();
    harness.sendRaw(privateWorldBindRequest("normal-update-bind", binding));
    await harness.nextResponse();
    harness.send(
      commandRequest("normal-update", {
        kind: "update_safety_profile",
        expectedRevision: 1,
        safetyPreset: "conservative",
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "normal-update",
      ok: true,
      result: { revision: 2, value: { safetyPreset: "conservative" } },
    });
    expect(updateCalls).toBe(1);
  });

  it("returns world revision conflicts without fencing a valid runtime", async () => {
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision: 1,
        updatedAt: "2026-07-29T00:00:01.000Z",
        value: null,
      }),
      bindConfirmedWorld: async () => {
        throw new Error("must not bind");
      },
      updateSafetyProfile: async () => {
        throw new Error("must not update");
      },
    };
    const harness = createHarness({ worldProfiles: worlds });

    harness.send(
      commandRequest("world-stale", {
        kind: "bind_confirmed_world",
        expectedRevision: 0,
        label: "Survival",
      }),
    );

    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "world-stale",
      ok: false,
      error: { code: "DOCUMENT_CONFLICT", message: "Profile revision conflict" },
    });
    expect(connectionInvalidations(harness)).toEqual([]);
  });
  it.each(["update_memory", "forget_memory", "pin_memory"] as const)(
    "returns DOCUMENT_CONFLICT and preserves the record winner for stale %s revisions",
    async (kind) => {
      const memories = new ScopedMemoryStore(await memoryPath());
      const created = await memories.add({
        category: "project",
        summary: "watchtower plan",
        importance: 3,
        scope: "global",
      });
      const winner = await memories.update(created.id, created.revision, { importance: 5 });
      const observed = await memories.export();
      const harness = createHarness({ memories });
      const command =
        kind === "update_memory"
          ? {
              kind,
              id: created.id,
              expectedRevision: observed.revision,
              recordRevision: created.revision,
              patch: { summary: "stale watchtower plan" },
            }
          : kind === "forget_memory"
            ? {
                kind,
                id: created.id,
                expectedRevision: observed.revision,
                recordRevision: created.revision,
              }
            : {
                kind,
                id: created.id,
                expectedRevision: observed.revision,
                recordRevision: created.revision,
                pinned: true,
              };

      harness.send(commandRequest(`stale-${kind}`, command));

      await expect(harness.nextResponse()).resolves.toEqual({
        version: 1,
        id: `stale-${kind}`,
        ok: false,
        error: { code: "DOCUMENT_CONFLICT", message: "Profile revision conflict" },
      });
      await expect(memories.export()).resolves.toMatchObject({
        revision: observed.revision,
        records: [expect.objectContaining(winner)],
      });
    },
  );

  it.each(["add_memory", "update_memory"] as const)(
    "resolves the authoritative world inside the serialized %s mutation",
    async (kind) => {
      const memories = new ScopedMemoryStore(await memoryPath());
      const created =
        kind === "update_memory"
          ? await memories.add({
              category: "project",
              summary: "move to current world",
              importance: 3,
              scope: "global",
            })
          : undefined;
      const observed = await memories.export();
      const worlds: DesktopChildWorldProfileStore = {
        read: async () => ({
          schemaVersion: 1,
          revision: 2,
          updatedAt: "2026-07-29T00:00:02.000Z",
          value: {
            id: "world-b",
            label: "World B",
            instanceFingerprint: "f".repeat(64),
            ownerUsername: "Owner",
            safetyPreset: "standard",
          },
        }),
        bindConfirmedWorld: async () => {
          throw new Error("not used");
        },
        updateSafetyProfile: async () => {
          throw new Error("not used");
        },
      };
      const harness = createHarness({ memories, worldProfiles: worlds });
      const command =
        kind === "add_memory"
          ? {
              kind,
              expectedRevision: observed.revision,
              memory: {
                category: "project" as const,
                summary: "create in current world",
                importance: 3 as const,
                scope: "world" as const,
              },
            }
          : {
              kind,
              id: created!.id,
              expectedRevision: observed.revision,
              recordRevision: created!.revision,
              patch: { scope: "world" as const },
            };

      harness.send(commandRequest(`authoritative-${kind}`, command));

      await expect(harness.nextResponse()).resolves.toMatchObject({
        ok: true,
        result: { record: { scope: "world", worldId: "world-b" } },
      });
    },
  );

  it("returns one coherent search snapshot when a competing read would observe a newer record", async () => {
    const snapshotA = memoryEnvelope(3, "2026-07-29T00:00:03.000Z", "snapshot A");
    const snapshotB = memoryEnvelope(4, "2026-07-29T00:00:04.000Z", "snapshot B");
    const memories: DesktopChildMemoryStore = {
      export: async () => snapshotA,
      search: async () => snapshotB.records,
      searchExport: async () => snapshotB,
      addAtRevision: async () => {
        throw new Error("not used");
      },
      updateAtRevision: async () => {
        throw new Error("not used");
      },
      forgetAtRevision: async () => {
        throw new Error("not used");
      },
      pinAtRevision: async () => {
        throw new Error("not used");
      },
    };
    const harness = createHarness({ memories });

    harness.send(
      commandRequest("coherent-search", {
        kind: "search_memories",
        query: "snapshot",
        scope: { mode: "global" },
      }),
    );

    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "coherent-search",
      ok: true,
      result: snapshotB,
    });
  });

  it("exports only the child-owned redacted memory DTO for historical records", async () => {
    const windowsProfile = ["C:", "Users", "Owner"].join("\\");
    const rawSummary = `玩家：秘密在 ${windowsProfile}\\world，TOKEN=private-token`;
    const snapshot = memoryEnvelope(3, "2026-07-29T00:00:03.000Z", rawSummary);
    const memories: DesktopChildMemoryStore = {
      export: async () => snapshot,
      search: async () => snapshot.records,
      searchExport: async () => snapshot,
      addAtRevision: async () => {
        throw new Error("not used");
      },
      updateAtRevision: async () => {
        throw new Error("not used");
      },
      forgetAtRevision: async () => {
        throw new Error("not used");
      },
      pinAtRevision: async () => {
        throw new Error("not used");
      },
    };
    const harness = createHarness({ memories });

    harness.sendRaw(
      `${JSON.stringify({
        version: DESKTOP_PROTOCOL_VERSION,
        id: "redacted-memory-export",
        command: { kind: "export_redacted_memories" },
      })}\n`,
    );

    const response = await harness.nextResponse();
    expect(response).toMatchObject({
      id: "redacted-memory-export",
      ok: true,
      result: { revision: 3, records: [{ summary: "[REDACTED_MEMORY]" }] },
    });
    const artifact = JSON.stringify(response);
    expect(artifact).not.toContain(rawSummary);
    expect(artifact).not.toContain("C:\\Users\\Owner");
    expect(artifact).not.toContain("private-token");
  });

  it("owns opaque migration previews and commits only the exact retained snapshot", async () => {
    const memories = new ScopedMemoryStore(await memoryPath());
    await memories.add({
      category: "project",
      summary: "move this memory",
      importance: 3,
      scope: "global",
    });
    const sourceRevision = (await memories.export()).revision;
    const migration = new MemoryMigration(memories, memories);
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision: 1,
        updatedAt: "2026-07-29T00:00:01.000Z",
        value: {
          id: "world-authoritative",
          label: "Survival",
          instanceFingerprint: "f".repeat(64),
          ownerUsername: "Owner",
          safetyPreset: "standard",
        },
      }),
      bindConfirmedWorld: async () => {
        throw new Error("not used");
      },
      updateSafetyProfile: async () => {
        throw new Error("not used");
      },
    };
    const harness = createHarness({
      memories,
      memoryMigration: migration,
      worldProfiles: worlds,
      createMemoryMigrationId: () => "migration_owned_1234",
    });

    harness.send(
      commandRequest("migration-preview", {
        kind: "preview_memory_migration",
        scope: "world",
      }),
    );
    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "migration-preview",
      ok: true,
      result: {
        migrationId: "migration_owned_1234",
        sourceRevision,
        targetScope: "world",
        deduplicatedCount: 0,
        movedCount: 1,
      },
    });
    expect((await memories.export()).records[0]).toMatchObject({ scope: "global" });

    harness.send(
      commandRequest("migration-commit", {
        kind: "commit_memory_migration",
        migrationId: "migration_owned_1234",
        sourceRevision,
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "migration-commit",
      ok: true,
      result: { migrationId: "migration_owned_1234", status: "committed" },
    });
    expect((await memories.export()).records[0]).toMatchObject({
      scope: "world",
      worldId: "world-authoritative",
    });
  });

  it("rejects a world migration preview after the authoritative world is rebound", async () => {
    const memories = new ScopedMemoryStore(await memoryPath());
    await memories.add({
      category: "project",
      summary: "keep authority current",
      importance: 3,
      scope: "global",
    });
    const sourceRevision = (await memories.export()).revision;
    const migration = new MemoryMigration(memories, memories);
    let currentWorldId = "world-a";
    let worldRevision = 1;
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision: worldRevision,
        updatedAt: "2026-07-29T00:00:01.000Z",
        value: {
          id: currentWorldId,
          label: currentWorldId,
          instanceFingerprint: "f".repeat(64),
          ownerUsername: "Owner",
          safetyPreset: "standard",
        },
      }),
      bindConfirmedWorld: async (_expectedRevision, _binding, label) => {
        currentWorldId = "world-b";
        worldRevision += 1;
        return {
          schemaVersion: 1,
          revision: worldRevision,
          updatedAt: "2026-07-29T00:00:02.000Z",
          value: {
            id: currentWorldId,
            label,
            instanceFingerprint: "f".repeat(64),
            ownerUsername: "Owner",
            safetyPreset: "standard",
          },
        };
      },
      updateSafetyProfile: async () => {
        throw new Error("not used");
      },
    };
    const harness = createHarness({
      memories,
      memoryMigration: migration,
      worldProfiles: worlds,
      createMemoryMigrationId: () => "migration_world_a",
    });

    harness.send(
      commandRequest("migration-world-a-preview", {
        kind: "preview_memory_migration",
        scope: "world",
      }),
    );
    await harness.nextResponse();
    await worlds.bindConfirmedWorld(
      1,
      {
        canonicalInstancePath: "C:/Minecraft/WorldB",
        javaSession: {
          pid: 2,
          processStartedAt: 2,
          port: 25565,
          version: "1.21.5",
        },
        ownerUsername: "Owner",
        proof: {
          nonce: "world_b_rebind_proof",
          port: 25565,
          issuedAt: 1,
          expiresAt: 10,
        },
      },
      "World B",
    );
    harness.send(
      commandRequest("migration-world-a-commit", {
        kind: "commit_memory_migration",
        migrationId: "migration_world_a",
        sourceRevision,
      }),
    );

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "migration-world-a-commit",
      ok: false,
      error: { code: "DOCUMENT_CONFLICT" },
    });
    expect((await memories.export()).records[0]).toMatchObject({ scope: "global" });
  });

  it("bounds unlimited previews by superseding every older uncommitted capability", async () => {
    const memories = new ScopedMemoryStore(await memoryPath());
    await memories.add({
      category: "project",
      summary: "bounded preview",
      importance: 3,
      scope: "global",
    });
    const sourceRevision = (await memories.export()).revision;
    const migration = new MemoryMigration(memories, memories);
    const ids = ["migration_first", "migration_middle", "migration_latest"];
    const harness = createHarness({
      memories,
      memoryMigration: migration,
      createMemoryMigrationId: () => ids.shift()!,
    });

    for (const [index, migrationId] of [
      "migration_first",
      "migration_middle",
      "migration_latest",
    ].entries()) {
      harness.send(
        commandRequest(`bounded-preview-${index}`, {
          kind: "preview_memory_migration",
          scope: "global",
        }),
      );
      await expect(harness.nextResponse()).resolves.toMatchObject({
        ok: true,
        result: { migrationId },
      });
    }

    harness.send(
      commandRequest("commit-superseded-preview", {
        kind: "commit_memory_migration",
        migrationId: "migration_first",
        sourceRevision,
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      ok: false,
      error: { code: "DOCUMENT_CONFLICT" },
    });

    harness.send(
      commandRequest("commit-latest-preview", {
        kind: "commit_memory_migration",
        migrationId: "migration_latest",
        sourceRevision,
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      ok: true,
      result: { status: "committed" },
    });
  });

  it("expires an uncommitted migration capability before commit", async () => {
    const memories = new ScopedMemoryStore(await memoryPath());
    await memories.add({
      category: "project",
      summary: "expiring preview",
      importance: 3,
      scope: "global",
    });
    const sourceRevision = (await memories.export()).revision;
    let now = 1_000;
    const harness = createHarness({
      memories,
      memoryMigration: new MemoryMigration(memories, memories),
      createMemoryMigrationId: () => "migration_expiring",
      memoryMigrationTtlMs: 50,
      now: () => now,
    });

    harness.send(
      commandRequest("expiring-preview", {
        kind: "preview_memory_migration",
        scope: "global",
      }),
    );
    await harness.nextResponse();
    now = 1_051;
    harness.send(
      commandRequest("expired-commit", {
        kind: "commit_memory_migration",
        migrationId: "migration_expiring",
        sourceRevision,
      }),
    );

    await expect(harness.nextResponse()).resolves.toMatchObject({
      ok: false,
      error: { code: "DOCUMENT_CONFLICT" },
    });
  });

  it("releases a committed rollback snapshot when a new preview supersedes it", async () => {
    const memories = new ScopedMemoryStore(await memoryPath());
    await memories.add({
      category: "project",
      summary: "one rollback only",
      importance: 3,
      scope: "global",
    });
    const migration = new MemoryMigration(memories, memories);
    const ids = ["migration_committed", "migration_replacement"];
    const harness = createHarness({
      memories,
      memoryMigration: migration,
      createMemoryMigrationId: () => ids.shift()!,
    });
    const firstRevision = (await memories.export()).revision;

    harness.send(
      commandRequest("committed-preview", {
        kind: "preview_memory_migration",
        scope: "global",
      }),
    );
    await harness.nextResponse();
    harness.send(
      commandRequest("committed-commit", {
        kind: "commit_memory_migration",
        migrationId: "migration_committed",
        sourceRevision: firstRevision,
      }),
    );
    await harness.nextResponse();

    harness.send(
      commandRequest("replacement-preview", {
        kind: "preview_memory_migration",
        scope: "global",
      }),
    );
    const replacementPreview = await harness.nextResponse();
    if (!replacementPreview.ok) throw new Error("replacement preview failed");
    const replacementSourceRevision = (replacementPreview.result as { sourceRevision: number })
      .sourceRevision;
    await expect(migration.rollback("migration_committed")).rejects.toThrow(
      "migration snapshot is unavailable",
    );
    harness.send(
      commandRequest("released-rollback", {
        kind: "rollback_memory_migration",
        migrationId: "migration_committed",
      }),
    );

    await expect(harness.nextResponse()).resolves.toMatchObject({
      ok: false,
      error: { code: "DOCUMENT_CONFLICT" },
    });

    harness.send(
      commandRequest("replacement-commit", {
        kind: "commit_memory_migration",
        migrationId: "migration_replacement",
        sourceRevision: replacementSourceRevision,
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      ok: true,
      result: { status: "committed" },
    });
    harness.send(
      commandRequest("replacement-rollback", {
        kind: "rollback_memory_migration",
        migrationId: "migration_replacement",
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      ok: true,
      result: { status: "rolled_back" },
    });
    await expect(migration.rollback("migration_replacement")).rejects.toThrow(
      "migration snapshot is unavailable",
    );
    harness.send(
      commandRequest("replacement-rollback-replay", {
        kind: "rollback_memory_migration",
        migrationId: "migration_replacement",
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      ok: false,
      error: { code: "DOCUMENT_CONFLICT" },
    });
  });

  it("serializes profile commands and applies live state only after persistence succeeds", async () => {
    const applyProfile = vi.fn();
    const listModels = vi.fn(async () => ({
      models: [],
      selection: { mode: "automatic" as const },
      legacyMigrationCompleted: false,
    }));
    const selectModel = vi.fn(async () => ({ mode: "automatic" as const }));
    const resolveRuntimeSelection = vi.fn(async () => ({
      modelId: "live-authority-model",
      reasoningEffort: "medium",
    }));
    const runtime: DesktopRuntime = {
      start: async () => undefined,
      stop: async () => undefined,
      stopTask: stopNoTask,
      snapshot: () => idleSnapshot,
      subscribe: () => () => undefined,
      applyProfile,
    };
    const harness = createHarness({
      runtime,
      models: { listModels, selectModel, resolveRuntimeSelection },
    });
    const initial = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
    const changed = {
      ...initial,
      displayName: "小百合",
      persona: "patient builder",
      modelPreference: {
        mode: "explicit" as const,
        modelId: "profile-only-model",
        reasoningEffort: "xhigh",
      },
    };

    harness.send(request("profile-read", "read_profile"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "profile-read",
      ok: true,
      result: { revision: 0, value: initial },
    });
    harness.send(
      commandRequest("profile-update", {
        kind: "update_profile",
        expectedRevision: 0,
        profile: changed,
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "profile-update",
      ok: true,
      result: {
        liveStatus: "applied",
        envelope: { revision: 1, value: changed },
      },
    });
    expect(applyProfile).toHaveBeenCalledOnce();
    expect(applyProfile).toHaveBeenCalledWith(changed);

    harness.send(
      commandRequest("profile-mode", {
        kind: "set_behavior_mode",
        expectedRevision: 1,
        mode: "balanced",
        settings: {
          idleMinutes: 21,
          allowProactiveChat: false,
          allowSuggestions: true,
          allowLowRiskMicroActions: false,
        },
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "profile-mode",
      ok: true,
      result: {
        liveStatus: "applied",
        envelope: {
          revision: 2,
          value: {
            displayName: "小百合",
            persona: "patient builder",
            mode: "balanced",
            modeSettings: { balanced: { idleMinutes: 21 } },
          },
        },
      },
    });
    expect(applyProfile).toHaveBeenCalledTimes(2);
    expect(listModels).not.toHaveBeenCalled();
    expect(selectModel).not.toHaveBeenCalled();
    expect(resolveRuntimeSelection).not.toHaveBeenCalled();
  });

  it("returns a stable conflict without applying stale profile state", async () => {
    const applyProfile = vi.fn();
    const harness = createHarness({
      runtime: {
        start: async () => undefined,
        stop: async () => undefined,
        stopTask: stopNoTask,
        snapshot: () => idleSnapshot,
        subscribe: () => () => undefined,
        applyProfile,
      },
      profiles: {
        update: async () => {
          throw new DocumentStoreError("DOCUMENT_CONFLICT", "private revision details");
        },
      },
    });

    harness.send(
      commandRequest("profile-conflict", {
        kind: "update_profile",
        expectedRevision: 0,
        profile: createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99"),
      }),
    );

    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "profile-conflict",
      ok: false,
      error: { code: "DOCUMENT_CONFLICT", message: "Profile revision conflict" },
    });
    expect(applyProfile).not.toHaveBeenCalled();
  });

  it("redacts profile persistence failures and leaves live state untouched", async () => {
    const applyProfile = vi.fn();
    const harness = createHarness({
      runtime: {
        start: async () => undefined,
        stop: async () => undefined,
        stopTask: stopNoTask,
        snapshot: () => idleSnapshot,
        subscribe: () => () => undefined,
        applyProfile,
      },
      profiles: {
        setBehaviorMode: async () => {
          throw new Error("C:\\private\\active-profile.json token=secret persona=raw");
        },
      },
    });

    harness.send(
      commandRequest("profile-failure", {
        kind: "set_behavior_mode",
        expectedRevision: 0,
        mode: "balanced",
        settings: {
          idleMinutes: 15,
          allowProactiveChat: true,
          allowSuggestions: true,
          allowLowRiskMicroActions: false,
        },
      }),
    );

    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "profile-failure",
      ok: false,
      error: { code: "PROFILE_OPERATION_FAILED", message: "Profile operation failed" },
    });
    expect(applyProfile).not.toHaveBeenCalled();
    expect(harness.lines().join("\n")).not.toContain("private");
    expect(harness.lines().join("\n")).not.toContain("secret");
  });

  it.each(["update_profile", "set_behavior_mode"] as const)(
    "commits %s, contains stale runtime authority, and preserves read/retry/restart semantics",
    async (kind) => {
      let snapshot: RuntimeSnapshot = {
        revision: 0,
        lifecycle: "running",
        minecraft: { state: "connected", sessionId: "profile-runtime-session" },
        codex: { state: "ready", model: "live-authority-model" },
        actions: readyActions,
        task: {
          id: "profile-runtime-task",
          goal: "stale authority",
          status: "running",
          allowedActions: ["move"],
          effectiveLimits: {
            maxToolCalls: 4,
            maxBlockChanges: 8,
            maxHorizontalTravel: 32,
            maxDurationMs: 60_000,
            maxDangerousOperations: 1,
          },
          startedAt: "2026-07-29T01:02:03.004Z",
          budget: {
            active: true,
            stopReason: null,
            limits: {
              maxToolCalls: 4,
              maxBlockChanges: 8,
              maxHorizontalTravel: 32,
              maxDurationMs: 60_000,
              maxDangerousOperations: 1,
            },
            toolCalls: 0,
            blockChanges: 0,
            horizontalTravel: 0,
            dangerousOperations: 0,
            startedAt: 0,
          },
        },
        actionQueue: { goal: "stale authority", items: [] },
        lastError: null,
      };
      const stop = vi.fn(async (_reason: TaskStopReason) => {
        snapshot = {
          revision: snapshot.revision + 1,
          lifecycle: "failed",
          minecraft: { state: "disconnected", sessionId: null },
          codex: { state: "failed", model: null },
          actions: null,
          task: null,
          actionQueue: { goal: null, items: [] },
          lastError: { code: "PROFILE_APPLY_FAILED", message: "Runtime contained" },
        };
      });
      const applyProfile =
        kind === "update_profile"
          ? vi.fn(() => {
              throw new Error("synchronous live profile apply failed");
            })
          : vi.fn(async () => {
              throw new Error("asynchronous live profile apply failed");
            });
      const harness = createHarness({
        runtime: {
          start: async () => undefined,
          stop,
          stopTask: stopNoTask,
          snapshot: () => snapshot,
          subscribe: () => () => undefined,
          applyProfile,
        },
      });
      const initial = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
      const command: DesktopCommand =
        kind === "update_profile"
          ? {
              kind,
              expectedRevision: 0,
              profile: { ...initial, displayName: "已提交配置" },
            }
          : {
              kind,
              expectedRevision: 0,
              mode: "balanced",
              settings: {
                idleMinutes: 17,
                allowProactiveChat: false,
                allowSuggestions: true,
                allowLowRiskMicroActions: false,
              },
            };

      harness.send(commandRequest(`profile-apply-failure-${kind}`, command));
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: `profile-apply-failure-${kind}`,
        ok: true,
        result: {
          liveStatus: "runtime_contained",
          envelope: { revision: 1 },
        },
      });
      expect(applyProfile).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledWith("failed");
      expect(connectionInvalidations(harness)).toContain("runtime_failed");

      harness.send(request(`profile-read-after-${kind}`, "read_profile"));
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: `profile-read-after-${kind}`,
        ok: true,
        result: {
          revision: 1,
          value:
            kind === "update_profile"
              ? { displayName: "已提交配置" }
              : { mode: "balanced", modeSettings: { balanced: { idleMinutes: 17 } } },
        },
      });

      harness.send(commandRequest(`profile-retry-${kind}`, command));
      await expect(harness.nextResponse()).resolves.toEqual({
        version: 1,
        id: `profile-retry-${kind}`,
        ok: false,
        error: { code: "DOCUMENT_CONFLICT", message: "Profile revision conflict" },
      });
      expect(applyProfile).toHaveBeenCalledOnce();

      harness.send(request(`profile-restart-unconfirmed-${kind}`, "start_runtime"));
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: `profile-restart-unconfirmed-${kind}`,
        ok: false,
        error: { code: "CONNECTION_OPERATION_FAILED" },
      });
      harness.send(request(`profile-restart-confirmed-${kind}`, "start_runtime"));
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: `profile-restart-confirmed-${kind}`,
        ok: true,
        result: { lifecycle: "running" },
      });
      expect(harness.runtimeCreations()).toBe(2);
    },
  );

  it("reports the committed profile envelope when runtime containment also fails", async () => {
    const initial = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
    const harness = createHarness({
      runtime: {
        start: async () => undefined,
        stop: async () => {
          throw new Error("runtime stop failed");
        },
        stopTask: stopNoTask,
        snapshot: () => ({
          revision: 0,
          lifecycle: "running",
          minecraft: { state: "connected", sessionId: "stale-runtime-session" },
          codex: { state: "ready", model: "stale-model" },
          actions: readyActions,
          task: null,
          actionQueue: { goal: null, items: [] },
          lastError: null,
        }),
        subscribe: () => () => undefined,
        applyProfile: () => {
          throw new Error("live apply failed");
        },
      },
    });

    harness.send(
      commandRequest("profile-containment-failure", {
        kind: "update_profile",
        expectedRevision: 0,
        profile: { ...initial, displayName: "已落盘但未应用" },
      }),
    );

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "profile-containment-failure",
      ok: false,
      error: {
        code: "PROFILE_RUNTIME_CONTAINMENT_FAILED",
        message: "Profile committed but runtime containment failed",
        committed: {
          revision: 1,
          value: { displayName: "已落盘但未应用" },
        },
      },
    });
    harness.send(request("profile-read-after-containment-failure", "read_profile"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "profile-read-after-containment-failure",
      ok: true,
      result: { revision: 1, value: { displayName: "已落盘但未应用" } },
    });
  });

  it("fails closed before service composition when the config escapes WHITELILY_DATA_ROOT", async () => {
    const previousDataRoot = process.env.WHITELILY_DATA_ROOT;
    const previousExitCode = process.exitCode;
    process.env.WHITELILY_DATA_ROOT = "C:/WhiteLily";
    process.exitCode = undefined;
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr: string[] = [];
    let serviceCreations = 0;
    try {
      const running = runDesktopChild(["C:/outside/config.toml"], {
        input,
        output,
        cwd: "C:/WhiteLily",
        writeStderr: (message) => stderr.push(message),
        createServices: async () => {
          serviceCreations += 1;
          return inertDesktopChildServices();
        },
      });
      input.end(`${JSON.stringify(request("escaped-config", "get_status"))}\n`);
      await running;

      expect(serviceCreations).toBe(0);
      expect(output.readableLength).toBe(0);
      expect(stderr).toEqual(["WhiteLily desktop child failed to initialize"]);
      expect(process.exitCode).toBe(1);
    } finally {
      if (previousDataRoot === undefined) delete process.env.WHITELILY_DATA_ROOT;
      else process.env.WHITELILY_DATA_ROOT = previousDataRoot;
      process.exitCode = previousExitCode;
    }
  });

  it("fails closed when the desktop child working directory differs from WHITELILY_DATA_ROOT", async () => {
    const previousDataRoot = process.env.WHITELILY_DATA_ROOT;
    const previousExitCode = process.exitCode;
    process.env.WHITELILY_DATA_ROOT = "C:/WhiteLily";
    process.exitCode = undefined;
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr: string[] = [];
    let serviceCreations = 0;
    try {
      const running = runDesktopChild(["C:/WhiteLily/config.toml"], {
        input,
        output,
        cwd: "C:/different-working-directory",
        writeStderr: (message) => stderr.push(message),
        createServices: async () => {
          serviceCreations += 1;
          return inertDesktopChildServices();
        },
      });
      input.end(`${JSON.stringify(request("mismatched-root", "get_status"))}\n`);
      await running;

      expect(serviceCreations).toBe(0);
      expect(output.readableLength).toBe(0);
      expect(stderr).toEqual(["WhiteLily desktop child failed to initialize"]);
      expect(process.exitCode).toBe(1);
    } finally {
      if (previousDataRoot === undefined) delete process.env.WHITELILY_DATA_ROOT;
      else process.env.WHITELILY_DATA_ROOT = previousDataRoot;
      process.exitCode = previousExitCode;
    }
  });

  it.each([
    ["a missing version", undefined],
    ["an empty version", ""],
    ["a path-shaped version", "../workspace"],
    ["an overlong version", "x".repeat(65)],
  ])("rejects %s in packaged mode before composing services", async (_label, version) => {
    const previousLayout = process.env.WHITELILY_CODEX_LAYOUT;
    const previousVersion = process.env.WHITELILY_WORKSPACE_VERSION;
    const previousExitCode = process.exitCode;
    process.env.WHITELILY_CODEX_LAYOUT = "packaged";
    if (version === undefined) delete process.env.WHITELILY_WORKSPACE_VERSION;
    else process.env.WHITELILY_WORKSPACE_VERSION = version;
    process.exitCode = undefined;
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr: string[] = [];
    let serviceCreations = 0;
    try {
      const running = runDesktopChild(["C:/WhiteLily/config.toml"], {
        input,
        output,
        cwd: "C:/WhiteLily",
        writeStderr: (message) => stderr.push(message),
        createServices: async () => {
          serviceCreations += 1;
          return inertDesktopChildServices();
        },
      });
      input.end(`${JSON.stringify(request("invalid-workspace-version", "get_status"))}\n`);
      await running;

      expect(serviceCreations).toBe(0);
      expect(output.readableLength).toBe(0);
      expect(stderr).toEqual(["WhiteLily desktop child failed to initialize"]);
      expect(process.exitCode).toBe(1);
    } finally {
      if (previousLayout === undefined) delete process.env.WHITELILY_CODEX_LAYOUT;
      else process.env.WHITELILY_CODEX_LAYOUT = previousLayout;
      if (previousVersion === undefined) delete process.env.WHITELILY_WORKSPACE_VERSION;
      else process.env.WHITELILY_WORKSPACE_VERSION = previousVersion;
      process.exitCode = previousExitCode;
    }
  });

  it("accepts a bounded supervisor-provided workspace version in packaged mode", async () => {
    const previousLayout = process.env.WHITELILY_CODEX_LAYOUT;
    const previousVersion = process.env.WHITELILY_WORKSPACE_VERSION;
    process.env.WHITELILY_CODEX_LAYOUT = "packaged";
    process.env.WHITELILY_WORKSPACE_VERSION = "release-1.2_3";
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    try {
      const running = runDesktopChild(["C:/WhiteLily/config.toml"], {
        input,
        output,
        cwd: "C:/WhiteLily",
        createServices: async () => inertDesktopChildServices(),
      });
      input.write(`${JSON.stringify(request("valid-workspace-version", "get_status"))}\n`);
      await vi.waitFor(() => expect(outputText).toContain("\n"));
      input.end();
      await running;

      expect(parseDesktopResponse(JSON.parse(outputText.trim()))).toMatchObject({
        id: "valid-workspace-version",
        ok: true,
      });
    } finally {
      if (previousLayout === undefined) delete process.env.WHITELILY_CODEX_LAYOUT;
      else process.env.WHITELILY_CODEX_LAYOUT = previousLayout;
      if (previousVersion === undefined) delete process.env.WHITELILY_WORKSPACE_VERSION;
      else process.env.WHITELILY_WORKSPACE_VERSION = previousVersion;
    }
  });

  it("exits on initially empty stdin without composing a runtime or writing output", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr: string[] = [];
    let runtimeCreations = 0;

    const running = runDesktopChild([], {
      input,
      output,
      writeStderr: (message) => stderr.push(message),
      createRuntime: async () => {
        runtimeCreations += 1;
        return new RuntimeFacade({
          lifecycle: {
            start: async () => undefined,
            stop: async () => undefined,
          },
        });
      },
    });
    input.emit("readable");
    input.end();
    await running;

    expect(runtimeCreations).toBe(0);
    expect(output.readableLength).toBe(0);
    expect(stderr).toEqual([]);
  });

  it.each([
    ["a missing seed", ["C:/WhiteLily/config.toml"], 0],
    ["a trusted numeric seed", ["C:/WhiteLily/config.toml", "37"], 37],
  ] as const)("starts the no-runtime public snapshot from %s", async (_label, args, revision) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const running = runDesktopChild(args, {
      input,
      output,
      cwd: "C:/WhiteLily/data",
      createServices: async () => inertDesktopChildServices(),
    });

    input.write(`${JSON.stringify(request("seeded-status", "get_status"))}\n`);
    await vi.waitFor(() => expect(outputText).toContain("\n"));
    input.end();
    await running;

    const response = parseDesktopResponse(JSON.parse(outputText.trim()));
    expect(response).toMatchObject({
      id: "seeded-status",
      ok: true,
      result: { revision, lifecycle: "idle" },
    });
  });

  it.each(["-1", "1.5", "01", "+1", "1e2", "9007199254740992"])(
    "rejects malformed runtime revision seed %j before composing services",
    async (seed) => {
      const priorExitCode = process.exitCode;
      process.exitCode = undefined;
      const input = new PassThrough();
      const output = new PassThrough();
      const stderr: string[] = [];
      let serviceCreations = 0;
      try {
        const running = runDesktopChild(["C:/WhiteLily/config.toml", seed], {
          input,
          output,
          writeStderr: (message) => stderr.push(message),
          createServices: async () => {
            serviceCreations += 1;
            return inertDesktopChildServices();
          },
        });
        input.end(`${JSON.stringify(request("invalid-seed-status", "get_status"))}\n`);
        await running;

        expect(serviceCreations).toBe(0);
        expect(output.readableLength).toBe(0);
        expect(stderr).toEqual(["WhiteLily desktop child failed to initialize"]);
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = priorExitCode;
      }
    },
  );

  it.each([
    ["MINECRAFT_BRIDGE_REQUIRED", "Minecraft Bridge is required"],
    ["MINECRAFT_BRIDGE_REJECTED", "Minecraft Bridge rejected the connection"],
  ] as const)(
    "maps %s startup errors without exposing private Bridge data",
    async (code, message) => {
      const failure = new MineflayerBridgeError(code);
      Object.defineProperty(failure, "cause", {
        value: new Error(
          "nonce-secret 127.0.0.1:25565 C:\\Users\\Owner\\WhiteLily\\bridge\\requests\\private.json",
        ),
      });
      const harness = createHarness({
        runtime: {
          ...throwingRuntime("get_status"),
          start: async () => {
            throw failure;
          },
          snapshot: () => idleSnapshot,
        },
      });

      harness.send(request(`bridge-${code}`, "start_runtime"));
      const response = await harness.nextResponse();

      expect(response).toEqual({
        version: 1,
        id: `bridge-${code}`,
        ok: false,
        error: { code, message },
      });
      expect(JSON.stringify({ response, lines: harness.lines() })).not.toMatch(
        /nonce-secret|25565|bridge\\requests|C:\\Users/iu,
      );
    },
  );

  it("fails closed without a signal or success acknowledgement when replacement containment fails", async () => {
    let releaseFactory = (): void => undefined;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    let factoryEntered = false;
    let candidateRevision = 0;
    const candidateStopReasons: TaskStopReason[] = [];
    const candidate: DesktopRuntime = {
      start: async () => undefined,
      stop: async (reason) => {
        candidateStopReasons.push(reason);
        throw new Error("candidate cleanup failed");
      },
      stopTask: stopNoTask,
      snapshot: () => ({ ...idleSnapshot, revision: candidateRevision }),
      subscribe: () => () => undefined,
    };
    const harness = createHarness({
      createRuntime: async (_connection, initialRevision) => {
        factoryEntered = true;
        await factoryGate;
        candidateRevision = initialRevision;
        return candidate;
      },
    });

    try {
      harness.send(request("cleanup-failure-start", "start_runtime"));
      await harness.nextResponse();
      harness.send(request("cleanup-failure-old-stop", "stop_runtime"));
      await harness.nextResponse();
      harness.send(request("cleanup-failure-replacement", "start_runtime"));
      await vi.waitFor(() => expect(factoryEntered).toBe(true));
      const invalidationsBeforeRace = connectionInvalidations(harness);

      harness.send(request("cleanup-failure-normal", "stop_runtime"));
      harness.send(request("cleanup-failure-emergency", "emergency_stop"));
      releaseFactory();

      await vi.waitFor(() => {
        expect(candidateStopReasons).toEqual(["owner_stop"]);
        const responses = harness.lines().map(
          (line) =>
            JSON.parse(line) as {
              id?: string;
              ok?: boolean;
              error?: { code?: string };
            },
        );
        expect(responses).toContainEqual(
          expect.objectContaining({
            id: "cleanup-failure-normal",
            ok: false,
            error: expect.objectContaining({ code: "RUNTIME_STOP_FAILED" }),
          }),
        );
        expect(responses).toContainEqual(
          expect.objectContaining({
            id: "cleanup-failure-emergency",
            ok: false,
            error: expect.objectContaining({ code: "EMERGENCY_STOP_FAILED" }),
          }),
        );
      });
      expect(connectionInvalidations(harness)).toEqual(invalidationsBeforeRace);
    } finally {
      releaseFactory();
    }
  });

  it("coalesces account loss then emergency against the current runtime with first-wins reason", async () => {
    let accountListener: ((snapshot: AccountSnapshot) => void) | undefined;
    let releaseStop = (): void => undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let lifecycle: RuntimeSnapshot["lifecycle"] = "running";
    const stopReasons: TaskStopReason[] = [];
    const runtime: DesktopRuntime = {
      start: async () => undefined,
      stop: async (reason) => {
        stopReasons.push(reason);
        lifecycle = "stopping";
        await stopGate;
        lifecycle = "stopped";
      },
      stopTask: stopNoTask,
      snapshot: () => ({ ...idleSnapshot, lifecycle }),
      subscribe: () => () => undefined,
    };
    const harness = createHarness({
      runtime,
      account: {
        subscribe: (listener) => {
          accountListener = listener;
          return () => {
            accountListener = undefined;
          };
        },
      },
    });

    try {
      accountListener?.({ status: "signed_out" });
      harness.send(request("current-account-emergency", "emergency_stop"));
      expect(stopReasons).toEqual(["model_unavailable"]);
      expect(connectionInvalidations(harness)).toEqual([]);

      releaseStop();
      await vi.waitFor(() => {
        expect(connectionInvalidations(harness)).toEqual(["account_lost"]);
        expect(
          harness
            .lines()
            .map((line) => JSON.parse(line) as { id?: string; ok?: boolean })
            .filter((response) => response.id === "current-account-emergency"),
        ).toEqual([expect.objectContaining({ ok: true })]);
      });
      expect(stopReasons).toEqual(["model_unavailable"]);
    } finally {
      releaseStop();
    }
  });

  it.each([
    {
      label: "normal stop",
      command: { kind: "stop_runtime" } as const,
      expectedReason: "owner_stop" as const,
    },
    {
      label: "LAN invalidation",
      command: { kind: "invalidate_connection", reason: "lan_changed" } as const,
      expectedReason: "disconnect" as const,
    },
  ])(
    "fences a blocked runtime start before $label acknowledgement",
    async ({ command, expectedReason }) => {
      let releaseStart = (): void => undefined;
      const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      let releaseStop = (): void => undefined;
      const stopGate = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      let startEntered = false;
      const stopReasons: TaskStopReason[] = [];
      const runtime = new RuntimeFacade({
        lifecycle: {
          start: async () => {
            startEntered = true;
            await startGate;
          },
          stop: async () => {
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
          stop: (reason) => stopReasons.push(reason),
        },
      });
      const harness = createHarness({
        runtime,
        createRuntime: async () => {
          throw new Error("fresh runtime must not be created");
        },
      });

      try {
        harness.send(request(`blocked-start-${command.kind}`, "start_runtime"));
        await vi.waitFor(() => expect(startEntered).toBe(true));
        harness.send(commandRequest(`blocked-start-control-${command.kind}`, command));
        const controlResponse = harness.nextResponse();

        await vi.waitFor(() => expect(stopReasons).toEqual([expectedReason]));
        await expect(
          Promise.race([controlResponse.then(() => "acknowledged"), delay(30, "pending")]),
        ).resolves.toBe("pending");

        releaseStop();
        await expect(controlResponse).resolves.toMatchObject({
          id: `blocked-start-control-${command.kind}`,
          ok: true,
          result: { lifecycle: "stopped" },
        });
        releaseStart();
        await expect(harness.nextResponse()).resolves.toMatchObject({
          id: `blocked-start-${command.kind}`,
          ok: false,
          error: { code: "RUNTIME_START_FAILED" },
        });
      } finally {
        releaseStop();
        releaseStart();
      }
    },
  );

  it("composes account services once and keeps runtime creation lazy until start_runtime", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const serviceCreations: string[] = [];
    const stopAccount = vi.fn(async () => undefined);
    const stopModels = vi.fn(() => undefined);
    let runtimeCreations = 0;
    const running = runDesktopChild(["C:/ignored-by-injected-services.toml"], {
      input,
      output,
      cwd: "C:/WhiteLily/data",
      createServices: async ({ configPath, cwd }) => {
        serviceCreations.push(`${configPath}|${cwd}`);
        return {
          ownerIdentity: ownerHarness("HarnessOwner"),
          account: {
            getAccount: async () => ({ status: "signed_out" }),
            startChatGptLogin: async () => ({
              attemptId: "opaque_attempt_1234",
              expiresAt: 60_000,
              loginUrl: "https://auth.openai.com/oauth",
            }),
            cancelChatGptLogin: async (attemptId) => ({
              status: "cancelled",
              attemptId,
            }),
            subscribe: () => () => undefined,
            stop: stopAccount,
          },
          models: {
            listModels: async () => ({
              models: [],
              selection: { mode: "automatic" },
              legacyMigrationCompleted: false,
            }),
            migrateLegacyPreference: async () => ({
              models: [],
              selection: { mode: "automatic" },
              legacyMigrationCompleted: true,
            }),
            selectModel: async () => ({ mode: "automatic" }),
            prepareSelection: async (selection) => ({
              preferenceRevision: 0,
              requested: selection,
              resolved: { modelId: "lazy-live-model", reasoningEffort: "medium" },
            }),
            commitSelection: async (prepared) =>
              prepared.requested.mode === "automatic"
                ? { mode: "automatic" }
                : { ...prepared.requested, available: true },
            resolveRuntimeSelection: async () => ({
              modelId: "lazy-live-model",
              reasoningEffort: "medium",
            }),
            subscribe: () => () => undefined,
            stop: stopModels,
          },
          createRuntime: async () => {
            runtimeCreations += 1;
            return new RuntimeFacade({
              lifecycle: {
                start: async () => undefined,
                stop: async () => undefined,
              },
            });
          },
        };
      },
    });

    input.write(
      `${JSON.stringify(commandRequest("preconfig-account", { kind: "get_account" }))}\n`,
    );
    await vi.waitFor(() => expect(output.readableLength).toBeGreaterThan(0));
    expect(runtimeCreations).toBe(0);
    const proofIssuedAt = Date.now();
    input.write(
      `${JSON.stringify(
        commandRequest("lazy-confirm", {
          kind: "set_confirmed_connection",
          proof: {
            nonce: "proof_nonce_lazy_1234",
            port: 51321,
            issuedAt: proofIssuedAt,
            expiresAt: proofIssuedAt + 10_000,
          },
        }),
      )}\n`,
    );
    await vi.waitFor(() => expect(output.readableLength).toBeGreaterThan(0));
    input.write(`${JSON.stringify(request("lazy-start", "start_runtime"))}\n`);
    await vi.waitFor(() => expect(runtimeCreations).toBe(1));
    input.end();
    await running;

    expect(serviceCreations).toHaveLength(1);
    expect(stopAccount).toHaveBeenCalledTimes(1);
    expect(stopModels).toHaveBeenCalledTimes(1);
  });

  it("returns the public RuntimeFacade snapshot for get_status", async () => {
    const harness = createHarness();

    harness.send(request("status-1", "get_status"));

    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "status-1",
      ok: true,
      result: idleSnapshot,
    });
    expect(harness.lines().map((line) => parseDesktopResponse(JSON.parse(line)))).toHaveLength(1);
  });

  it.each([
    ["stop_runtime", "RUNTIME_STOP_FAILED"],
    ["emergency_stop", "EMERGENCY_STOP_FAILED"],
  ] as const)(
    "settles %s when runtime revision cleanup is exhausted",
    async (kind, expectedCode) => {
      const runtime = new RuntimeFacade({
        initialRevision: Number.MAX_SAFE_INTEGER,
        lifecycle: {
          start: async () => undefined,
          stop: async () => undefined,
        },
      });
      const harness = createHarness({ runtime });

      harness.send(request(`exhausted-${kind}`, kind));
      const response = await Promise.race([
        harness.nextResponse(),
        delay(500).then(() => {
          throw new Error("exhausted runtime command did not settle");
        }),
      ]);

      expect(response).toMatchObject({
        id: `exhausted-${kind}`,
        ok: false,
        error: { code: expectedCode },
      });
      expect(runtime.snapshot()).toMatchObject({
        revision: Number.MAX_SAFE_INTEGER,
        lifecycle: "failed",
        lastError: { code: "RUNTIME_REVISION_EXHAUSTED" },
      });
    },
  );

  it("starts through a fresh RuntimeFacade after a successful normal stop", async () => {
    const harness = createHarness();

    harness.send(request("start-first", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "start-first",
      ok: true,
      result: { lifecycle: "running" },
    });
    harness.send(request("stop-first", "stop_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "stop-first",
      ok: true,
      result: { lifecycle: "stopped" },
    });
    expect(harness.runtimeCreations()).toBe(1);
    harness.send(request("start-second", "start_runtime"));

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "start-second",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(harness.runtimeCreations()).toBe(2);
    expect(harness.lifecycleStarts()).toBe(2);
  });

  it("keeps public runtime revisions monotonic when a stopped facade is replaced", async () => {
    const harness = createHarness();

    harness.send(request("revision-start-first", "start_runtime"));
    await harness.nextResponse();
    harness.send(request("revision-stop", "stop_runtime"));
    await harness.nextResponse();
    harness.send(request("revision-start-second", "start_runtime"));
    await harness.nextResponse();

    const revisions = harness
      .lines()
      .map((line) => JSON.parse(line) as { event?: { revision?: number } })
      .flatMap((line) => (typeof line.event?.revision === "number" ? [line.event.revision] : []));
    expect(revisions.length).toBeGreaterThan(5);
    expect(
      revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!),
    ).toBe(true);
  });

  it("replaces the stopped runtime subscription without leaking old events", async () => {
    const initial = trackingRuntime();
    let fresh: ReturnType<typeof trackingRuntime> | undefined;
    const harness = createHarness({
      runtime: initial.runtime,
      createRuntime: async (_connection, initialRevision) => {
        fresh = trackingRuntime(initialRevision);
        return fresh.runtime;
      },
    });

    harness.send(request("tracked-start-first", "start_runtime"));
    await harness.nextResponse();
    harness.send(request("tracked-stop", "stop_runtime"));
    await harness.nextResponse();
    harness.send(request("tracked-start-second", "start_runtime"));
    await harness.nextResponse();

    expect(initial.listenerCount()).toBe(0);
    expect(fresh?.listenerCount()).toBe(1);
    const lineCount = harness.lines().length;
    initial.emit({ kind: "lifecycle", revision: 1, state: "running" });
    await delay(0);
    expect(harness.lines()).toHaveLength(lineCount);

    fresh?.emit({ kind: "lifecycle", revision: 2, state: "running" });
    await expect(harness.nextEvent()).resolves.toEqual({
      version: 1,
      event: { kind: "lifecycle", revision: 2, state: "running" },
    });
  });

  it("forwards only the strict sanitized action queue runtime event", async () => {
    const tracked = trackingRuntime();
    const harness = createHarness({ runtime: tracked.runtime });
    const actionQueue = {
      goal: "制作面包",
      items: [
        {
          index: 1,
          kind: "harvest_crop",
          summary: "寻找成熟小麦",
          status: "waiting" as const,
          retryCount: 0,
          enqueuedAt: "2026-08-15T00:00:00.000Z",
        },
      ],
    };

    tracked.emit({ kind: "action_queue", revision: 1, actionQueue });

    await expect(harness.nextEvent()).resolves.toEqual({
      version: DESKTOP_PROTOCOL_VERSION,
      event: { kind: "action_queue", revision: 1, actionQueue },
    });
    expect(JSON.stringify(harness.lines())).not.toMatch(/lease|observation|position/iu);
  });

  it.each([
    {
      label: "normal stop",
      command: { kind: "stop_runtime" } as const,
    },
    {
      label: "LAN invalidation",
      command: { kind: "invalidate_connection", reason: "lan_changed" } as const,
    },
  ])("ignores late runtime callbacks after $label", async ({ command }) => {
    const tracked = trackingRuntime();
    const harness = createHarness({ runtime: tracked.runtime });

    harness.send(request(`late-${command.kind}-start`, "start_runtime"));
    await harness.nextResponse();
    harness.send(commandRequest(`late-${command.kind}-control`, command));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: `late-${command.kind}-control`,
      ok: true,
      result: { lifecycle: "stopped" },
    });

    expect(tracked.listenerCount()).toBe(0);
    const lineCount = harness.lines().length;
    tracked.emit({ kind: "lifecycle", revision: 1, state: "running" });
    await delay(0);
    expect(harness.lines()).toHaveLength(lineCount);
  });

  it("retries a failed terminal start through a fresh RuntimeFacade", async () => {
    let freshRuntimeCreations = 0;
    const harness = createHarness({
      runtime: throwingRuntime("start_runtime"),
      createRuntime: async () => {
        freshRuntimeCreations += 1;
        return new RuntimeFacade({
          lifecycle: {
            start: async () => undefined,
            stop: async () => undefined,
          },
        });
      },
    });

    harness.send(request("start-failed", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "start-failed",
      ok: false,
      error: { code: "RUNTIME_START_FAILED" },
    });
    harness.send(request("start-retry", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "start-retry",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(freshRuntimeCreations).toBe(1);
  });

  it("does not reuse connection authority after a failed terminal stop", async () => {
    let freshRuntimeCreations = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          throw new Error("cleanup failed");
        },
      },
    });
    const harness = createHarness({
      runtime,
      createRuntime: async () => {
        freshRuntimeCreations += 1;
        return new RuntimeFacade({
          lifecycle: {
            start: async () => undefined,
            stop: async () => undefined,
          },
        });
      },
    });

    harness.send(request("start-before-stop-failure", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "start-before-stop-failure",
      ok: true,
    });
    harness.send(request("stop-failed", "stop_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "stop-failed",
      ok: false,
      error: { code: "RUNTIME_STOP_FAILED" },
    });
    harness.send(request("start-after-stop-failure", "start_runtime"));

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "start-after-stop-failure",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    expect(freshRuntimeCreations).toBe(0);
  });

  it("awaits RuntimeFacade.stop(emergency_stop) before acknowledging", async () => {
    const harness = createHarness({ blockLifecycleStop: true });

    harness.send(request("emergency-1", "emergency_stop"));
    await vi.waitFor(() => {
      expect(harness.stopReasons).toEqual(["emergency_stop"]);
      expect(harness.lifecycleStops()).toBe(1);
    });
    const responsePromise = harness.nextResponse();

    await expect(
      Promise.race([responsePromise.then(() => "acknowledged"), delay(30, "pending")]),
    ).resolves.toBe("pending");

    harness.releaseLifecycleStop();
    await expect(responsePromise).resolves.toMatchObject({
      id: "emergency-1",
      ok: true,
      result: { lifecycle: "stopped" },
    });
    expect(
      harness
        .lines()
        .map((line) => JSON.parse(line) as { event?: { kind?: string; reason?: string } })
        .find((message) => message.event?.kind === "connection_invalidated"),
    ).toMatchObject({
      event: { kind: "connection_invalidated", reason: "emergency_stop" },
    });
  });

  it("invokes emergency stop ahead of a blocked normal request without acknowledging early", async () => {
    let releaseStart = (): void => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let releaseStop = (): void => undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let startEntered = false;
    const stopReasons: TaskStopReason[] = [];
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => {
          startEntered = true;
          await startGate;
        },
        stop: async () => {
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
        stop: (reason) => stopReasons.push(reason),
      },
    });
    const harness = createHarness({
      runtime,
      createRuntime: async () => {
        throw new Error("fresh runtime must not be created");
      },
    });

    try {
      harness.send(request("blocked-start", "start_runtime"));
      await vi.waitFor(() => expect(startEntered).toBe(true));
      harness.send(request("urgent-stop", "emergency_stop"));
      const emergencyResponse = harness.nextResponse();

      await vi.waitFor(() => expect(stopReasons).toEqual(["emergency_stop"]));
      await expect(
        Promise.race([emergencyResponse.then(() => "acknowledged"), delay(30, "pending")]),
      ).resolves.toBe("pending");

      releaseStop();
      await expect(emergencyResponse).resolves.toMatchObject({
        id: "urgent-stop",
        ok: true,
        result: { lifecycle: "stopped" },
      });
      releaseStart();
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: "blocked-start",
        ok: false,
        error: { code: "RUNTIME_START_FAILED" },
      });
    } finally {
      releaseStop();
      releaseStart();
    }
  });

  it("revokes only task authority ahead of a blocked ordinary request", async () => {
    let releaseAccount = (): void => undefined;
    const accountGate = new Promise<void>((resolve) => {
      releaseAccount = resolve;
    });
    let accountEntered = false;
    const limits = {
      maxToolCalls: 4,
      maxBlockChanges: 8,
      maxHorizontalTravel: 32,
      maxDurationMs: 60_000,
      maxDangerousOperations: 1,
    };
    let snapshot: RuntimeSnapshot = {
      revision: 3,
      lifecycle: "running",
      minecraft: { state: "connected", sessionId: null },
      codex: { state: "ready", model: "gpt-5.6" },
      actions: readyActions,
      task: {
        id: "task_urgent_stop",
        goal: "走到主人身边",
        status: "running",
        allowedActions: ["get_state", "move_to"],
        effectiveLimits: limits,
        startedAt: "2026-07-30T00:00:00.000Z",
        budget: {
          active: true,
          stopReason: null,
          limits,
          toolCalls: 0,
          blockChanges: 0,
          horizontalTravel: 0,
          dangerousOperations: 0,
          startedAt: 1_785_369_600_000,
        },
      },
      actionQueue: { goal: "走到主人身边", items: [] },
      lastError: null,
    };
    const stopTask = vi.fn(async () => {
      snapshot = { ...snapshot, revision: 4, task: null };
    });
    const stopRuntime = vi.fn(async () => undefined);
    const harness = createHarness({
      runtime: {
        start: async () => undefined,
        stop: stopRuntime,
        stopTask,
        snapshot: () => snapshot,
        subscribe: () => () => undefined,
      } as DesktopRuntime & { stopTask(): Promise<void> },
      account: {
        getAccount: async () => {
          accountEntered = true;
          await accountGate;
          return { status: "signed_out" };
        },
      },
    });

    try {
      harness.send(request("blocked-account", "get_account"));
      await vi.waitFor(() => expect(accountEntered).toBe(true));
      harness.send(request("urgent-task-stop", "stop_task"));

      await vi.waitFor(() => expect(stopTask).toHaveBeenCalledOnce());
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: "urgent-task-stop",
        ok: true,
        result: {
          revision: 4,
          lifecycle: "running",
          minecraft: { state: "connected" },
          codex: { state: "ready", model: "gpt-5.6" },
          task: null,
        },
      });
      expect(stopRuntime).not.toHaveBeenCalled();

      harness.send(request("absent-task-stop", "stop_task"));
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: "absent-task-stop",
        ok: true,
        result: { lifecycle: "running", task: null },
      });
      expect(stopRuntime).not.toHaveBeenCalled();
    } finally {
      releaseAccount();
    }
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "blocked-account",
      ok: true,
    });
  });

  it("fails closed when an active runtime does not implement task-only stop", async () => {
    const limits = {
      maxToolCalls: 4,
      maxBlockChanges: 8,
      maxHorizontalTravel: 32,
      maxDurationMs: 60_000,
      maxDangerousOperations: 1,
    };
    const snapshot: RuntimeSnapshot = {
      revision: 3,
      lifecycle: "running",
      minecraft: { state: "connected", sessionId: null },
      codex: { state: "ready", model: "gpt-5.6" },
      actions: readyActions,
      task: {
        id: "task_missing_stop_capability",
        goal: "Keep the task contained",
        status: "running",
        allowedActions: ["wait"],
        effectiveLimits: limits,
        startedAt: "2026-07-30T00:00:00.000Z",
        budget: {
          active: true,
          stopReason: null,
          limits,
          toolCalls: 0,
          blockChanges: 0,
          horizontalTravel: 0,
          dangerousOperations: 0,
          startedAt: 1_785_369_600_000,
        },
      },
      actionQueue: { goal: "Keep the task contained", items: [] },
      lastError: null,
    };
    const stopRuntime = vi.fn(async () => undefined);
    const harness = createHarness({
      runtime: {
        start: async () => undefined,
        stop: stopRuntime,
        snapshot: () => snapshot,
        subscribe: () => () => undefined,
      } as unknown as DesktopRuntime,
    });

    harness.send(request("missing-task-stop-capability", "stop_task"));

    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "missing-task-stop-capability",
      ok: false,
      error: { code: "RUNTIME_STOP_FAILED", message: "Runtime failed to stop" },
    });
    expect(stopRuntime).not.toHaveBeenCalled();
    expect(harness.runtime.snapshot().task).not.toBeNull();
  });

  it.each([
    {
      label: "normal stop",
      command: { kind: "stop_runtime" } as const,
      expectedReason: "owner_stop" as const,
      expectedSignalReason: "owner_stop" as const,
    },
    {
      label: "LAN invalidation",
      command: { kind: "invalidate_connection", reason: "lan_changed" } as const,
      expectedReason: "disconnect" as const,
      expectedSignalReason: "lan_changed" as const,
    },
  ])(
    "fences authority for $label ahead of a blocked account request and contains cleanup before acknowledging",
    async ({ command, expectedReason, expectedSignalReason }) => {
      let accountEntered = false;
      let releaseAccount = (): void => undefined;
      const accountGate = new Promise<void>((resolve) => {
        releaseAccount = resolve;
      });
      const harness = createHarness({
        blockLifecycleStop: true,
        account: {
          getAccount: async () => {
            accountEntered = true;
            await accountGate;
            return { status: "signed_out" };
          },
        },
      });

      try {
        harness.send(request(`blocked-${command.kind}-start`, "start_runtime"));
        await expect(harness.nextResponse()).resolves.toMatchObject({
          id: `blocked-${command.kind}-start`,
          ok: true,
        });
        harness.send(request(`blocked-${command.kind}-account`, "get_account"));
        await vi.waitFor(() => expect(accountEntered).toBe(true));
        harness.send(commandRequest(`urgent-${command.kind}`, command));
        const controlResponse = harness.nextResponse();

        await vi.waitFor(() => expect(harness.stopReasons).toEqual([expectedReason]));
        await expect(
          Promise.race([controlResponse.then(() => "acknowledged"), delay(30, "pending")]),
        ).resolves.toBe("pending");

        harness.releaseLifecycleStop();
        await expect(controlResponse).resolves.toMatchObject({
          id: `urgent-${command.kind}`,
          ok: true,
          result: { lifecycle: "stopped" },
        });
        expect(
          harness
            .lines()
            .map((line) => JSON.parse(line) as { event?: { kind?: string; reason?: string } })
            .find((message) => message.event?.kind === "connection_invalidated"),
        ).toMatchObject({
          event: {
            kind: "connection_invalidated",
            reason: expectedSignalReason,
          },
        });
        releaseAccount();
        await expect(harness.nextResponse()).resolves.toMatchObject({
          id: `blocked-${command.kind}-account`,
          ok: true,
        });
      } finally {
        harness.releaseLifecycleStop();
        releaseAccount();
      }
    },
  );

  it("does not start a queued replacement after a following emergency request", async () => {
    const harness = createHarness();
    harness.send(request("queue-race-start-first", "start_runtime"));
    await harness.nextResponse();
    harness.send(request("queue-race-stop", "stop_runtime"));
    await harness.nextResponse();

    harness.sendRaw(
      `${JSON.stringify(request("queue-race-restart", "start_runtime"))}\n${JSON.stringify(
        request("queue-race-emergency", "emergency_stop"),
      )}\n`,
    );

    await vi.waitFor(() => {
      const responses = harness
        .lines()
        .map((line) => JSON.parse(line) as { id?: string })
        .filter((message) => message.id?.startsWith("queue-race-"));
      expect(responses).toContainEqual(
        expect.objectContaining({
          id: "queue-race-emergency",
          ok: true,
          result: expect.objectContaining({ lifecycle: "stopped" }),
        }),
      );
      expect(responses).toContainEqual(
        expect.objectContaining({
          id: "queue-race-restart",
          ok: false,
          error: expect.objectContaining({ code: "RUNTIME_START_FAILED" }),
        }),
      );
    });
    expect(harness.runtimeCreations()).toBe(1);
  });

  it("stops an in-flight replacement before acknowledging emergency stop", async () => {
    let releaseFactory = (): void => undefined;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    let releaseCandidateStop = (): void => undefined;
    const candidateStopGate = new Promise<void>((resolve) => {
      releaseCandidateStop = resolve;
    });
    let factoryEntered = false;
    let candidateLifecycle: RuntimeSnapshot["lifecycle"] = "idle";
    let candidateRevision = 0;
    const candidateStopReasons: TaskStopReason[] = [];
    const candidate: DesktopRuntime = {
      start: async () => {
        candidateLifecycle = "running";
      },
      stop: async (reason) => {
        candidateStopReasons.push(reason);
        candidateLifecycle = "stopping";
        await candidateStopGate;
        candidateLifecycle = "stopped";
      },
      stopTask: stopNoTask,
      snapshot: () => ({
        ...idleSnapshot,
        revision: candidateRevision,
        lifecycle: candidateLifecycle,
      }),
      subscribe: () => () => undefined,
    };
    const harness = createHarness({
      createRuntime: async (_connection, initialRevision) => {
        factoryEntered = true;
        await factoryGate;
        candidateRevision = initialRevision;
        return candidate;
      },
    });

    try {
      harness.send(request("replacement-race-start", "start_runtime"));
      await harness.nextResponse();
      harness.send(request("replacement-race-stop", "stop_runtime"));
      await harness.nextResponse();
      harness.send(request("replacement-race-restart", "start_runtime"));
      await vi.waitFor(() => expect(factoryEntered).toBe(true));
      harness.send(request("replacement-race-emergency", "emergency_stop"));

      expect(
        harness.lines().some((line) => JSON.parse(line).id === "replacement-race-emergency"),
      ).toBe(false);
      releaseFactory();
      await vi.waitFor(() => expect(candidateStopReasons).toEqual(["emergency_stop"]));
      expect(
        harness.lines().some((line) => JSON.parse(line).id === "replacement-race-emergency"),
      ).toBe(false);

      releaseCandidateStop();
      await vi.waitFor(() => {
        const responses = harness.lines().map((line) => JSON.parse(line));
        expect(responses).toContainEqual(
          expect.objectContaining({
            id: "replacement-race-restart",
            ok: false,
            error: expect.objectContaining({ code: "RUNTIME_START_FAILED" }),
          }),
        );
        expect(responses).toContainEqual(
          expect.objectContaining({
            id: "replacement-race-emergency",
            ok: true,
            result: expect.objectContaining({ lifecycle: "stopped" }),
          }),
        );
      });
    } finally {
      releaseFactory();
      releaseCandidateStop();
    }
  });

  it("coalesces normal then emergency invalidation and publishes only after replacement containment", async () => {
    let releaseFactory = (): void => undefined;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    let releaseCandidateStop = (): void => undefined;
    const candidateStopGate = new Promise<void>((resolve) => {
      releaseCandidateStop = resolve;
    });
    let factoryEntered = false;
    let candidateRevision = 0;
    let candidateLifecycle: RuntimeSnapshot["lifecycle"] = "idle";
    const candidateStopReasons: TaskStopReason[] = [];
    const candidate: DesktopRuntime = {
      start: async () => {
        candidateLifecycle = "running";
      },
      stop: async (reason) => {
        candidateStopReasons.push(reason);
        candidateLifecycle = "stopping";
        await candidateStopGate;
        candidateLifecycle = "stopped";
      },
      stopTask: stopNoTask,
      snapshot: () => ({
        ...idleSnapshot,
        revision: candidateRevision,
        lifecycle: candidateLifecycle,
      }),
      subscribe: () => () => undefined,
    };
    const harness = createHarness({
      createRuntime: async (_connection, initialRevision) => {
        factoryEntered = true;
        await factoryGate;
        candidateRevision = initialRevision;
        return candidate;
      },
    });

    try {
      harness.send(request("coalesced-start", "start_runtime"));
      await harness.nextResponse();
      harness.send(request("coalesced-stop-old", "stop_runtime"));
      await harness.nextResponse();
      harness.send(request("coalesced-replacement", "start_runtime"));
      await vi.waitFor(() => expect(factoryEntered).toBe(true));
      const invalidationsBeforeRace = connectionInvalidations(harness);

      harness.send(request("coalesced-normal", "stop_runtime"));
      harness.send(request("coalesced-emergency", "emergency_stop"));
      expect(connectionInvalidations(harness)).toEqual(invalidationsBeforeRace);

      releaseFactory();
      await vi.waitFor(() => expect(candidateStopReasons).toEqual(["owner_stop"]));
      expect(connectionInvalidations(harness)).toEqual(invalidationsBeforeRace);

      releaseCandidateStop();
      await vi.waitFor(() => {
        expect(connectionInvalidations(harness)).toEqual([
          ...invalidationsBeforeRace,
          "owner_stop",
        ]);
        const responses = harness.lines().map((line) => JSON.parse(line) as { id?: string });
        expect(responses).toContainEqual(expect.objectContaining({ id: "coalesced-normal" }));
        expect(responses).toContainEqual(expect.objectContaining({ id: "coalesced-emergency" }));
      });
    } finally {
      releaseFactory();
      releaseCandidateStop();
    }
  });

  it.each([
    {
      label: "emergency then normal",
      first: "emergency" as const,
      second: "normal" as const,
      stopReason: "emergency_stop" as const,
      publicReason: "emergency_stop" as const,
    },
    {
      label: "LAN then emergency",
      first: "lan" as const,
      second: "emergency" as const,
      stopReason: "disconnect" as const,
      publicReason: "lan_changed" as const,
    },
    {
      label: "model callback then normal",
      first: "model" as const,
      second: "normal" as const,
      stopReason: "model_unavailable" as const,
      publicReason: "model_unavailable" as const,
    },
    {
      label: "account callback then emergency",
      first: "account" as const,
      second: "emergency" as const,
      stopReason: "model_unavailable" as const,
      publicReason: "account_lost" as const,
    },
  ])(
    "uses first-wins reason and one contained signal for $label against an in-flight replacement",
    async ({ first, second, stopReason, publicReason }) => {
      let accountListener: ((snapshot: AccountSnapshot) => void) | undefined;
      let modelListener: ((event: ModelCatalogEvent) => void) | undefined;
      let releaseFactory = (): void => undefined;
      const factoryGate = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      let releaseCandidateStop = (): void => undefined;
      const candidateStopGate = new Promise<void>((resolve) => {
        releaseCandidateStop = resolve;
      });
      let factoryEntered = false;
      let candidateRevision = 0;
      let candidateLifecycle: RuntimeSnapshot["lifecycle"] = "idle";
      const candidateStopReasons: TaskStopReason[] = [];
      const candidate: DesktopRuntime = {
        start: async () => {
          candidateLifecycle = "running";
        },
        stop: async (reason) => {
          candidateStopReasons.push(reason);
          candidateLifecycle = "stopping";
          await candidateStopGate;
          candidateLifecycle = "stopped";
        },
        stopTask: stopNoTask,
        snapshot: () => ({
          ...idleSnapshot,
          revision: candidateRevision,
          lifecycle: candidateLifecycle,
        }),
        subscribe: () => () => undefined,
      };
      const harness = createHarness({
        account: {
          subscribe: (listener) => {
            accountListener = listener;
            return () => {
              accountListener = undefined;
            };
          },
        },
        models: {
          subscribe: (listener) => {
            modelListener = listener;
            return () => {
              modelListener = undefined;
            };
          },
        },
        createRuntime: async (_connection, initialRevision) => {
          factoryEntered = true;
          await factoryGate;
          candidateRevision = initialRevision;
          return candidate;
        },
      });
      const trigger = (kind: typeof first | typeof second, id: string): void => {
        switch (kind) {
          case "normal":
            harness.send(request(id, "stop_runtime"));
            break;
          case "emergency":
            harness.send(request(id, "emergency_stop"));
            break;
          case "lan":
            harness.send(
              commandRequest(id, { kind: "invalidate_connection", reason: "lan_changed" }),
            );
            break;
          case "model":
            modelListener?.({ kind: "selection_invalidated", reason: "model_unavailable" });
            break;
          case "account":
            accountListener?.({ status: "signed_out" });
            break;
        }
      };

      try {
        harness.send(request(`permutation-${first}-${second}-start`, "start_runtime"));
        await harness.nextResponse();
        harness.send(request(`permutation-${first}-${second}-old-stop`, "stop_runtime"));
        await harness.nextResponse();
        harness.send(request(`permutation-${first}-${second}-replacement`, "start_runtime"));
        await vi.waitFor(() => expect(factoryEntered).toBe(true));
        const invalidationsBeforeRace = connectionInvalidations(harness);

        trigger(first, `permutation-${first}-${second}-first`);
        trigger(second, `permutation-${first}-${second}-second`);
        expect(connectionInvalidations(harness)).toEqual(invalidationsBeforeRace);

        releaseFactory();
        await vi.waitFor(() => expect(candidateStopReasons).toEqual([stopReason]));
        expect(connectionInvalidations(harness)).toEqual(invalidationsBeforeRace);

        releaseCandidateStop();
        await vi.waitFor(() =>
          expect(connectionInvalidations(harness)).toEqual([
            ...invalidationsBeforeRace,
            publicReason,
          ]),
        );
      } finally {
        releaseFactory();
        releaseCandidateStop();
      }
    },
  );

  it.each([
    {
      label: "normal stop",
      command: { kind: "stop_runtime" } as const,
      expectedReason: "owner_stop" as const,
    },
    {
      label: "LAN invalidation",
      command: { kind: "invalidate_connection", reason: "lan_changed" } as const,
      expectedReason: "disconnect" as const,
    },
  ])(
    "stops an in-flight replacement before acknowledging $label",
    async ({ command, expectedReason }) => {
      let releaseFactory = (): void => undefined;
      const factoryGate = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      let releaseCandidateStop = (): void => undefined;
      const candidateStopGate = new Promise<void>((resolve) => {
        releaseCandidateStop = resolve;
      });
      let factoryEntered = false;
      let candidateLifecycle: RuntimeSnapshot["lifecycle"] = "idle";
      let candidateRevision = 0;
      const candidateStopReasons: TaskStopReason[] = [];
      const candidate: DesktopRuntime = {
        start: async () => {
          candidateLifecycle = "running";
        },
        stop: async (reason) => {
          candidateStopReasons.push(reason);
          candidateLifecycle = "stopping";
          await candidateStopGate;
          candidateLifecycle = "stopped";
        },
        stopTask: stopNoTask,
        snapshot: () => ({
          ...idleSnapshot,
          revision: candidateRevision,
          lifecycle: candidateLifecycle,
        }),
        subscribe: () => () => undefined,
      };
      const harness = createHarness({
        createRuntime: async (_connection, initialRevision) => {
          factoryEntered = true;
          await factoryGate;
          candidateRevision = initialRevision;
          return candidate;
        },
      });

      try {
        harness.send(request(`replacement-${command.kind}-start`, "start_runtime"));
        await harness.nextResponse();
        harness.send(request(`replacement-${command.kind}-stop`, "stop_runtime"));
        await harness.nextResponse();
        harness.send(request(`replacement-${command.kind}-restart`, "start_runtime"));
        await vi.waitFor(() => expect(factoryEntered).toBe(true));
        harness.send(commandRequest(`replacement-${command.kind}-control`, command));

        expect(
          harness
            .lines()
            .some((line) => JSON.parse(line).id === `replacement-${command.kind}-control`),
        ).toBe(false);
        releaseFactory();
        await vi.waitFor(() => expect(candidateStopReasons).toEqual([expectedReason]));
        expect(
          harness
            .lines()
            .some((line) => JSON.parse(line).id === `replacement-${command.kind}-control`),
        ).toBe(false);

        releaseCandidateStop();
        await vi.waitFor(() => {
          const responses = harness.lines().map((line) => JSON.parse(line));
          expect(responses).toContainEqual(
            expect.objectContaining({
              id: `replacement-${command.kind}-restart`,
              ok: false,
              error: expect.objectContaining({ code: "RUNTIME_START_FAILED" }),
            }),
          );
          expect(responses).toContainEqual(
            expect.objectContaining({
              id: `replacement-${command.kind}-control`,
              ok: true,
              result: expect.objectContaining({ lifecycle: "stopped" }),
            }),
          );
        });
      } finally {
        releaseFactory();
        releaseCandidateStop();
      }
    },
  );

  it("rejects an oversized line immediately, discards its remainder, and resynchronizes", async () => {
    const harness = createHarness();

    harness.sendRaw(Buffer.alloc(MAX_DESKTOP_LINE_BYTES + 1, 0x61));
    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "invalid",
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Invalid desktop request",
      },
    });

    harness.sendRaw(Buffer.alloc(MAX_DESKTOP_LINE_BYTES * 2, 0x62));
    harness.sendRaw(`\n${JSON.stringify(request("status-after-limit", "get_status"))}\n`);
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "status-after-limit",
      ok: true,
      result: idleSnapshot,
    });
    expect(
      harness
        .lines()
        .map((line) => JSON.parse(line) as { id?: string })
        .filter((message) => message.id === "invalid"),
    ).toHaveLength(1);
  });

  it("stops the RuntimeFacade with process_exit when stdin reaches EOF", async () => {
    const harness = createHarness();

    harness.endInput();

    await vi.waitFor(() => expect(harness.stopReasons).toEqual(["process_exit"]));
    await vi.waitFor(() => expect(harness.runtime.snapshot().lifecycle).toBe("stopped"));
    for (const line of harness.lines()) {
      expect(() => parseDesktopEvent(JSON.parse(line))).not.toThrow();
    }
  });

  it("applies process-exit cleanup to the fresh runtime after reconnect", async () => {
    const harness = createHarness();
    harness.send(request("eof-fresh-start-first", "start_runtime"));
    await harness.nextResponse();
    harness.send(request("eof-fresh-stop", "stop_runtime"));
    await harness.nextResponse();
    harness.send(request("eof-fresh-start-second", "start_runtime"));
    await harness.nextResponse();

    harness.endInput();

    await vi.waitFor(() => expect(harness.stopReasons).toEqual(["owner_stop", "process_exit"]));
    expect(harness.lifecycleStops()).toBe(2);
  });

  it.each([
    ["start_runtime", "RUNTIME_START_FAILED", "Runtime failed to start"],
    ["stop_runtime", "RUNTIME_STOP_FAILED", "Runtime failed to stop"],
    ["emergency_stop", "EMERGENCY_STOP_FAILED", "Emergency stop failed"],
  ] as const)(
    "maps a thrown %s error to %s without leaking error details",
    async (kind, code, message) => {
      const runtime = throwingRuntime(kind);
      const harness = createHarness({ runtime });

      harness.send(request(`failure-${kind}`, kind));

      const response = await harness.nextResponse();
      expect(response).toEqual({
        version: 1,
        id: `failure-${kind}`,
        ok: false,
        error: { code, message },
      });
      expect(JSON.stringify(response)).not.toContain("C:\\Users\\private");
      expect(JSON.stringify(response)).not.toContain("stack-secret");
    },
  );

  it("maps unexpected status failures to a bounded INTERNAL_ERROR", async () => {
    const harness = createHarness({
      runtime: throwingRuntime("get_status"),
    });

    harness.send(request("status-failure", "get_status"));

    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "status-failure",
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Internal error" },
    });
  });

  it("keeps every stdout line inside the response or event protocol", async () => {
    const harness = createHarness();

    harness.send(request("start-1", "start_runtime"));
    await harness.nextResponse();
    harness.send(request("stop-1", "stop_runtime"));
    await harness.nextResponse();

    expect(harness.stopReasons).toEqual(["owner_stop"]);
    for (const line of harness.lines()) {
      const value: unknown = JSON.parse(line);
      expect(() => {
        try {
          parseDesktopResponse(value);
        } catch {
          parseDesktopEvent(value);
        }
      }).not.toThrow();
    }
  });

  it("dispatches account, model, and bounded model migration commands through separate services", async () => {
    let modelListener: ((event: ModelCatalogEvent) => void) | undefined;
    const migrateLegacyPreference = vi.fn(async (candidate: ModelSelectionInput | null) => ({
      models: [
        {
          id: "live-model",
          displayName: "Live Model",
          supportedReasoningEfforts: ["medium"] as const,
        },
      ],
      selection:
        candidate?.mode === "explicit"
          ? { ...candidate, available: true as const }
          : ({ mode: "automatic" } as const),
      legacyMigrationCompleted: true,
    }));
    const harness = createHarness({
      runtime: new RuntimeFacade({
        lifecycle: { start: async () => undefined, stop: async () => undefined },
        actions: readyActionAccess,
        switchModel: async (_selection, commitPreference) => commitPreference(),
      }),
      account: {
        getAccount: async () => ({ status: "signed_in", auth: "chatgpt" }),
        startChatGptLogin: async () => ({
          attemptId: "opaque_attempt_1234",
          expiresAt: 123_456,
          loginUrl: "https://auth.openai.com/oauth?state=private",
        }),
        cancelChatGptLogin: async (attemptId) => ({
          status: "cancelled",
          attemptId,
        }),
      },
      models: {
        migrateLegacyPreference,
        listModels: async () => ({
          models: [
            {
              id: "live-model",
              displayName: "Live Model",
              supportedReasoningEfforts: ["medium"],
            },
          ],
          selection: { mode: "automatic" },
          legacyMigrationCompleted: false,
        }),
        selectModel: async () => {
          throw new Error("legacy single-phase selection must not run");
        },
        prepareSelection: async (selection) => ({
          preferenceRevision: 0,
          requested: selection,
          resolved:
            selection.mode === "automatic"
              ? { modelId: "live-model", reasoningEffort: "medium" }
              : { modelId: selection.modelId, reasoningEffort: selection.reasoningEffort },
        }),
        commitSelection: async (prepared) => {
          const selection = prepared.requested;
          const selected =
            selection.mode === "automatic"
              ? ({ mode: "automatic" } as const)
              : ({ ...selection, available: true as const } as const);
          modelListener?.({ kind: "selection_changed", selection: selected });
          return selected;
        },
        subscribe: (listener) => {
          modelListener = listener;
          return () => {
            modelListener = undefined;
          };
        },
      },
    });

    harness.send(request("account-get", "get_account"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "account-get",
      ok: true,
      result: { status: "signed_in", auth: "chatgpt" },
    });
    harness.send(request("login-start", "start_chatgpt_login"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "login-start",
      ok: true,
      result: {
        attempt: { status: "pending", attemptId: "opaque_attempt_1234" },
        loginUrl: "https://auth.openai.com/oauth?state=private",
      },
    });
    harness.send(
      commandRequest("login-cancel", {
        kind: "cancel_chatgpt_login",
        attemptId: "opaque_attempt_1234",
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "login-cancel",
      ok: true,
      result: { status: "cancelled", attemptId: "opaque_attempt_1234" },
    });
    harness.send(
      commandRequest("model-migrate", {
        kind: "migrate_model_preference",
        candidate: {
          mode: "explicit",
          modelId: "live-model",
          reasoningEffort: "medium",
        },
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "model-migrate",
      ok: true,
      result: {
        selection: { mode: "explicit", modelId: "live-model", reasoningEffort: "medium" },
        legacyMigrationCompleted: true,
      },
    });
    expect(migrateLegacyPreference).toHaveBeenCalledWith({
      mode: "explicit",
      modelId: "live-model",
      reasoningEffort: "medium",
    });
    harness.send(request("models-list", "list_models"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "models-list",
      ok: true,
      result: { models: [{ id: "live-model" }], selection: { mode: "automatic" } },
    });
    harness.send(request("model-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "model-start",
      ok: true,
      result: { lifecycle: "running" },
    });
    harness.send(
      commandRequest("model-select", {
        kind: "select_model",
        selection: {
          mode: "explicit",
          modelId: "live-model",
          reasoningEffort: "medium",
        },
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "model-select",
      ok: true,
      result: { mode: "explicit", modelId: "live-model", available: true },
    });
    await Promise.resolve();
    expect(connectionInvalidations(harness)).toEqual([]);
    expect(harness.stopReasons).toEqual([]);
  });

  it("orders a running model selection through prepare, runtime commit, and response", async () => {
    const order: string[] = [];
    const requested: ModelSelectionInput = {
      mode: "explicit",
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
    };
    const prepared: PreparedModelSelection = {
      preferenceRevision: 7,
      requested,
      resolved: { modelId: "gpt-5.6-luna", reasoningEffort: "high" },
    };
    let snapshot: RuntimeSnapshot = {
      revision: 4,
      lifecycle: "running",
      minecraft: { state: "connected", sessionId: "lan-session-1" },
      codex: { state: "ready", model: "gpt-5.6-terra" },
      actions: readyActions,
      task: null,
      actionQueue: { goal: null, items: [] },
      lastError: null,
    };
    const runtime = {
      start: async () => undefined,
      stop: async () => {
        snapshot = {
          ...snapshot,
          lifecycle: "stopped",
          minecraft: { state: "disconnected", sessionId: null },
          codex: { state: "stopped", model: null },
          actions: null,
        };
      },
      stopTask: async () => undefined,
      snapshot: () => structuredClone(snapshot),
      subscribe: () => () => undefined,
      switchModel: async (
        selection: ResolvedModelSelection,
        commitPreference: () => Promise<void>,
      ) => {
        order.push(`runtime:${selection.modelId}`);
        await commitPreference();
        snapshot = { ...snapshot, codex: { state: "ready", model: selection.modelId } };
      },
    };
    const models = {
      selectModel: async (): Promise<ModelSelection> => {
        order.push("legacy-select");
        return { ...requested, available: true };
      },
      prepareSelection: async (selection: ModelSelectionInput) => {
        order.push(`prepare:${selection.mode}`);
        return prepared;
      },
      commitSelection: async (candidate: PreparedModelSelection): Promise<ModelSelection> => {
        expect(candidate).toBe(prepared);
        order.push("commit");
        return { ...requested, available: true };
      },
    };
    const harness = createHarness({ runtime, models });

    harness.send(
      commandRequest("model-two-phase-running", { kind: "select_model", selection: requested }),
    );
    const response = await harness.nextResponse();
    order.push("response");

    expect(response).toMatchObject({
      id: "model-two-phase-running",
      ok: true,
      result: { mode: "explicit", modelId: "gpt-5.6-luna", available: true },
    });
    expect(order).toEqual(["prepare:explicit", "runtime:gpt-5.6-luna", "commit", "response"]);
    expect(snapshot).toMatchObject({
      lifecycle: "running",
      minecraft: { state: "connected", sessionId: "lan-session-1" },
      codex: { state: "ready", model: "gpt-5.6-luna" },
    });
    expect(connectionInvalidations(harness)).toEqual([]);
  });

  it("publishes a provider-qualified live model through events, response, and later status", async () => {
    const requested: ModelSelectionInput = {
      mode: "explicit",
      modelId: "provider:model",
      reasoningEffort: "high",
    };
    const prepared: PreparedModelSelection = {
      preferenceRevision: 14,
      requested,
      resolved: { modelId: "provider:model", reasoningEffort: "high" },
    };
    const runtime = new RuntimeFacade({
      initialRevision: 25,
      lifecycle: { start: async () => undefined, stop: async () => undefined },
      codex: { model: () => "provider-old-model" },
      actions: readyActionAccess,
      switchModel: async (_selection, commitPreference) => commitPreference(),
    });
    await runtime.start();
    const revisionBeforeSwitch = runtime.snapshot().revision;
    const harness = createHarness({
      runtime,
      models: {
        selectModel: async () => {
          throw new Error("legacy single-phase selection must not run");
        },
        prepareSelection: async () => prepared,
        commitSelection: async () => ({ ...requested, available: true }),
      },
    });

    harness.send(
      commandRequest("provider-model-select", { kind: "select_model", selection: requested }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "provider-model-select",
      ok: true,
      result: { mode: "explicit", modelId: "provider:model", available: true },
    });
    const codexEventLine = harness
      .lines()
      .map((line) => JSON.parse(line) as unknown)
      .find(
        (line) =>
          typeof line === "object" &&
          line !== null &&
          (line as { event?: { kind?: string; state?: { model?: string } } }).event?.kind ===
            "codex" &&
          (line as { event?: { state?: { model?: string } } }).event?.state?.model ===
            "provider:model",
      );
    expect(codexEventLine).toBeDefined();
    const codexEvent = parseDesktopEvent(codexEventLine!).event;
    expect(codexEvent).toEqual({
      kind: "codex",
      revision: revisionBeforeSwitch + 1,
      state: { state: "ready", model: "provider:model" },
    });

    harness.send(request("provider-model-status", "get_status"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "provider-model-status",
      ok: true,
      result: {
        revision: revisionBeforeSwitch + 1,
        lifecycle: "running",
        codex: { state: "ready", model: "provider:model" },
      },
    });
    expect(connectionInvalidations(harness)).toEqual([]);
  });

  it("commits an idle model selection without asking the runtime to switch", async () => {
    const order: string[] = [];
    const requested: ModelSelectionInput = {
      mode: "explicit",
      modelId: "gpt-5.6-luna",
      reasoningEffort: "medium",
    };
    const prepared: PreparedModelSelection = {
      preferenceRevision: 3,
      requested,
      resolved: { modelId: "gpt-5.6-luna", reasoningEffort: "medium" },
    };
    const runtime = {
      start: async () => undefined,
      stop: async () => undefined,
      stopTask: async () => undefined,
      snapshot: () => idleSnapshot,
      subscribe: () => () => undefined,
      switchModel: async () => {
        order.push("runtime-switch");
      },
    };
    const models = {
      selectModel: async (): Promise<ModelSelection> => {
        order.push("legacy-select");
        return { ...requested, available: true };
      },
      prepareSelection: async () => {
        order.push("prepare");
        return prepared;
      },
      commitSelection: async (): Promise<ModelSelection> => {
        order.push("commit");
        return { ...requested, available: true };
      },
    };
    const harness = createHarness({ runtime, models });

    harness.send(
      commandRequest("model-two-phase-idle", { kind: "select_model", selection: requested }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "model-two-phase-idle",
      ok: true,
      result: { modelId: "gpt-5.6-luna" },
    });

    expect(order).toEqual(["prepare", "commit"]);
  });

  it("maps a stale live model commit to the stable model operation error", async () => {
    const requested: ModelSelectionInput = {
      mode: "explicit",
      modelId: "gpt-5.6-luna",
      reasoningEffort: "medium",
    };
    const prepared: PreparedModelSelection = {
      preferenceRevision: 9,
      requested,
      resolved: { modelId: "gpt-5.6-luna", reasoningEffort: "medium" },
    };
    const originalSnapshot: RuntimeSnapshot = {
      revision: 10,
      lifecycle: "running",
      minecraft: { state: "connected", sessionId: "lan-session-stale" },
      codex: { state: "ready", model: "gpt-5.6-terra" },
      actions: readyActions,
      task: null,
      actionQueue: { goal: null, items: [] },
      lastError: null,
    };
    let snapshot = structuredClone(originalSnapshot);
    let catalogSelection: ModelSelection = { mode: "automatic" };
    const runtime = {
      start: async () => undefined,
      stop: async () => {
        snapshot = {
          ...snapshot,
          lifecycle: "stopped",
          minecraft: { state: "disconnected", sessionId: null },
          codex: { state: "stopped", model: null },
          actions: null,
        };
      },
      stopTask: async () => undefined,
      snapshot: () => structuredClone(snapshot),
      subscribe: () => () => undefined,
      switchModel: async (
        selection: ResolvedModelSelection,
        commitPreference: () => Promise<void>,
      ) => {
        await commitPreference();
        snapshot = { ...snapshot, codex: { state: "ready", model: selection.modelId } };
      },
    };
    const models = {
      selectModel: async (): Promise<ModelSelection> => {
        catalogSelection = { ...requested, available: true };
        return catalogSelection;
      },
      prepareSelection: async () => prepared,
      commitSelection: async (): Promise<ModelSelection> => {
        throw new DocumentStoreError("DOCUMENT_CONFLICT", "private stale revision");
      },
    };
    const harness = createHarness({ runtime, models });

    harness.send(
      commandRequest("model-two-phase-stale", { kind: "select_model", selection: requested }),
    );
    await expect(harness.nextResponse()).resolves.toEqual({
      version: DESKTOP_PROTOCOL_VERSION,
      id: "model-two-phase-stale",
      ok: false,
      error: { code: "MODEL_OPERATION_FAILED", message: "Model operation failed" },
    });

    expect(snapshot).toEqual(originalSnapshot);
    expect(catalogSelection).toEqual({ mode: "automatic" });
  });

  it("suppresses a live model result completed after its runtime was stopped", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const requested: ModelSelectionInput = {
      mode: "explicit",
      modelId: "gpt-5.6-luna",
      reasoningEffort: "medium",
    };
    const prepared: PreparedModelSelection = {
      preferenceRevision: 11,
      requested,
      resolved: { modelId: "gpt-5.6-luna", reasoningEffort: "medium" },
    };
    let snapshot: RuntimeSnapshot = {
      revision: 12,
      lifecycle: "running",
      minecraft: { state: "connected", sessionId: "lan-session-late" },
      codex: { state: "ready", model: "gpt-5.6-terra" },
      actions: readyActions,
      task: null,
      actionQueue: { goal: null, items: [] },
      lastError: null,
    };
    const runtime = {
      start: async () => undefined,
      stop: async () => {
        snapshot = {
          ...snapshot,
          lifecycle: "stopped",
          minecraft: { state: "disconnected", sessionId: null },
          codex: { state: "stopped", model: null },
          actions: null,
        };
      },
      stopTask: async () => undefined,
      snapshot: () => structuredClone(snapshot),
      subscribe: () => () => undefined,
      switchModel: async (
        _selection: ResolvedModelSelection,
        commitPreference: () => Promise<void>,
      ) => {
        await commitPreference();
        entered.resolve();
        await release.promise;
      },
    };
    const models = {
      selectModel: async (): Promise<ModelSelection> => {
        entered.resolve();
        await release.promise;
        return { ...requested, available: true };
      },
      prepareSelection: async () => prepared,
      commitSelection: async (): Promise<ModelSelection> => ({ ...requested, available: true }),
    };
    const harness = createHarness({ runtime, models });

    harness.send(
      commandRequest("model-late-select", { kind: "select_model", selection: requested }),
    );
    await entered.promise;
    harness.send(request("model-late-stop", "stop_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "model-late-stop",
      ok: true,
      result: { lifecycle: "stopped" },
    });
    release.resolve();

    await expect(harness.nextResponse()).resolves.toEqual({
      version: DESKTOP_PROTOCOL_VERSION,
      id: "model-late-select",
      ok: false,
      error: { code: "MODEL_OPERATION_FAILED", message: "Model operation failed" },
    });
  });

  it("recovers from true model invalidation with the confirmed LAN and world binding", async () => {
    let modelListener: ((event: ModelCatalogEvent) => void) | undefined;
    let profile: WorldProfile | null = null;
    let revision = 0;
    let runtimeCreations = 0;
    const safetyConfigurations: RuntimeSafetyConfiguration[] = [];
    const proof: ConfirmedConnectionProof = {
      nonce: "model_recovery_proof_0001",
      port: 25565,
      issuedAt: 10,
      expiresAt: 9_999,
    };
    const binding: ConfirmedWorldBinding = {
      canonicalInstancePath: "C:/Minecraft/ModelRecovery",
      javaSession: {
        pid: 2468,
        processStartedAt: 20,
        port: 25565,
        version: "1.21.5",
      },
      ownerUsername: "HarnessOwner",
      proof,
    };
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision,
        updatedAt: "2026-08-03T00:00:00.000Z",
        value: profile,
      }),
      bindConfirmedWorld: async (_expectedRevision, confirmed, label) => {
        revision += 1;
        profile = {
          id: "be176ae1-a4b4-4fd6-b04c-89634cd74a99",
          label,
          instanceFingerprint: fingerprintConfirmedWorld(
            confirmed.canonicalInstancePath,
            confirmed.javaSession,
          ),
          ownerUsername: confirmed.ownerUsername,
          safetyPreset: "standard",
        };
        return {
          schemaVersion: 1,
          revision,
          updatedAt: "2026-08-03T00:00:01.000Z",
          value: profile,
        };
      },
      updateSafetyProfile: async () => {
        throw new Error("unused");
      },
    };
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 100,
      worldProfiles: worlds,
      models: {
        resolveRuntimeSelection: async () => ({
          modelId: "gpt-5.6-terra",
          reasoningEffort: "medium",
        }),
        subscribe: (listener) => {
          modelListener = listener;
          return () => {
            modelListener = undefined;
          };
        },
      },
      createRuntime: async (_connection, initialRevision, _selection, safety) => {
        runtimeCreations += 1;
        safetyConfigurations.push(safety);
        return new RuntimeFacade({
          initialRevision,
          lifecycle: { start: async () => undefined, stop: async () => undefined },
        });
      },
    });
    harness.send(
      commandRequest("model-recovery-confirm", { kind: "set_confirmed_connection", proof }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "model-recovery-confirm",
      ok: true,
    });
    harness.sendRaw(privateWorldBindRequest("model-recovery-bind", binding));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "model-recovery-bind",
      ok: true,
    });
    harness.send(request("model-recovery-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "model-recovery-start",
      ok: true,
    });
    expect(safetyConfigurations).toEqual([
      { requestedPreset: "standard", compatibilityVerified: true },
    ]);

    modelListener?.({ kind: "selection_invalidated", reason: "model_unavailable" });
    await vi.waitFor(() => expect(connectionInvalidations(harness)).toContain("model_unavailable"));
    harness.send(request("model-recovery-restart", "start_runtime"));

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "model-recovery-restart",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(safetyConfigurations).toEqual([
      { requestedPreset: "standard", compatibilityVerified: true },
      { requestedPreset: "standard", compatibilityVerified: true },
    ]);
    expect(runtimeCreations).toBe(2);
  });

  it("retains explicit model recovery before connection consumption and beyond proof TTL", async () => {
    let now = 100;
    let modelAvailable = true;
    let modelListener: ((event: ModelCatalogEvent) => void) | undefined;
    const resolveEntered = deferred<void>();
    const releaseResolve = deferred<void>();
    let resolveCalls = 0;
    let profile: WorldProfile | null = null;
    let revision = 0;
    const safetyConfigurations: RuntimeSafetyConfiguration[] = [];
    const proof: ConfirmedConnectionProof = {
      nonce: "preconsume_model_recovery_01",
      port: 25565,
      issuedAt: 100,
      expiresAt: 10_100,
    };
    const binding: ConfirmedWorldBinding = {
      canonicalInstancePath: "C:/Minecraft/PreconsumeRecovery",
      javaSession: {
        pid: 8642,
        processStartedAt: 30,
        port: 25565,
        version: "1.21.5",
      },
      ownerUsername: "HarnessOwner",
      proof,
    };
    const worlds: DesktopChildWorldProfileStore = {
      read: async () => ({
        schemaVersion: 1,
        revision,
        updatedAt: "2026-08-03T00:00:00.000Z",
        value: profile,
      }),
      bindConfirmedWorld: async (_expectedRevision, confirmed, label) => {
        revision += 1;
        profile = {
          id: "be176ae1-a4b4-4fd6-b04c-89634cd74a99",
          label,
          instanceFingerprint: fingerprintConfirmedWorld(
            confirmed.canonicalInstancePath,
            confirmed.javaSession,
          ),
          ownerUsername: confirmed.ownerUsername,
          safetyPreset: "standard",
        };
        return {
          schemaVersion: 1,
          revision,
          updatedAt: "2026-08-03T00:00:01.000Z",
          value: profile,
        };
      },
      updateSafetyProfile: async () => {
        throw new Error("unused");
      },
    };
    const harness = createHarness({
      lazyRuntime: true,
      now: () => now,
      worldProfiles: worlds,
      models: {
        resolveRuntimeSelection: async () => {
          resolveCalls += 1;
          if (resolveCalls === 1) {
            resolveEntered.resolve();
            await releaseResolve.promise;
          }
          if (!modelAvailable) throw new Error("Selected model is unavailable");
          return { modelId: "gpt-5.6-terra", reasoningEffort: "medium" };
        },
        subscribe: (listener) => {
          modelListener = listener;
          return () => {
            modelListener = undefined;
          };
        },
      },
      createRuntime: async (_connection, initialRevision, _selection, safety) => {
        safetyConfigurations.push(safety);
        return new RuntimeFacade({
          initialRevision,
          lifecycle: { start: async () => undefined, stop: async () => undefined },
        });
      },
    });
    harness.send(
      commandRequest("preconsume-recovery-confirm", {
        kind: "set_confirmed_connection",
        proof,
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "preconsume-recovery-confirm",
      ok: true,
    });
    harness.sendRaw(privateWorldBindRequest("preconsume-recovery-bind", binding));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "preconsume-recovery-bind",
      ok: true,
    });

    harness.send(request("preconsume-recovery-first-start", "start_runtime"));
    await resolveEntered.promise;
    modelAvailable = false;
    modelListener?.({ kind: "selection_invalidated", reason: "model_unavailable" });
    await vi.waitFor(() => expect(connectionInvalidations(harness)).toContain("model_unavailable"));
    releaseResolve.resolve();
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "preconsume-recovery-first-start",
      ok: false,
      error: { code: "RUNTIME_START_FAILED" },
    });

    now = 20_000;
    modelAvailable = true;
    harness.send(request("preconsume-recovery-restored", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "preconsume-recovery-restored",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(safetyConfigurations).toEqual([
      { requestedPreset: "standard", compatibilityVerified: true },
    ]);
  });

  it.each([
    { name: "an expired", invalidationNow: 10_100 },
    { name: "a clock-rewound future-issued", invalidationNow: 99 },
  ])(
    "does not upgrade $name accepted connection into explicit model recovery",
    async (scenario) => {
      let now = 100;
      let modelListener: ((event: ModelCatalogEvent) => void) | undefined;
      const harness = createHarness({
        lazyRuntime: true,
        now: () => now,
        models: {
          subscribe: (listener) => {
            modelListener = listener;
            return () => {
              modelListener = undefined;
            };
          },
        },
      });
      harness.send(
        commandRequest("expired-recovery-confirm", {
          kind: "set_confirmed_connection",
          proof: {
            nonce: "expired_model_recovery_01",
            port: 25565,
            issuedAt: 100,
            expiresAt: 10_100,
          },
        }),
      );
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: "expired-recovery-confirm",
        ok: true,
      });

      now = scenario.invalidationNow;
      modelListener?.({ kind: "selection_invalidated", reason: "model_unavailable" });
      await vi.waitFor(() =>
        expect(connectionInvalidations(harness)).toContain("model_unavailable"),
      );
      harness.send(request("expired-recovery-start", "start_runtime"));

      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: "expired-recovery-start",
        ok: false,
        error: { code: "CONNECTION_OPERATION_FAILED" },
      });
      expect(harness.runtimeCreations()).toBe(0);
    },
  );

  it("consumes one-shot confirmation after an ordinary pre-consumption resolve failure", async () => {
    let resolveCalls = 0;
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 100,
      models: {
        resolveRuntimeSelection: async () => {
          resolveCalls += 1;
          if (resolveCalls === 1) throw new Error("ordinary model lookup failure");
          return { modelId: "gpt-5.6-terra", reasoningEffort: "medium" };
        },
      },
    });
    harness.send(
      commandRequest("ordinary-resolve-confirm", {
        kind: "set_confirmed_connection",
        proof: {
          nonce: "ordinary_resolve_failure_01",
          port: 25565,
          issuedAt: 100,
          expiresAt: 10_100,
        },
      }),
    );
    await harness.nextResponse();

    harness.send(request("ordinary-resolve-first", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "ordinary-resolve-first",
      ok: false,
      error: { code: "RUNTIME_START_FAILED" },
    });
    harness.send(request("ordinary-resolve-retry", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "ordinary-resolve-retry",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
  });

  it("serves account state before a Minecraft runtime can be composed", async () => {
    const harness = createHarness({
      lazyRuntime: true,
      createRuntime: async () => {
        throw new Error("missing Minecraft config");
      },
      account: {
        getAccount: async () => ({ status: "signed_out" }),
      },
    });

    harness.send(request("account-before-config", "get_account"));

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "account-before-config",
      ok: true,
      result: { status: "signed_out" },
    });
    expect(harness.runtimeCreations()).toBe(0);
  });

  it("requires a fresh one-shot main proof before composing a loopback runtime", async () => {
    const connections: unknown[] = [];
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 1_000,
      createRuntime: async (connection) => {
        connections.push(connection);
        return new RuntimeFacade({
          lifecycle: {
            start: async () => undefined,
            stop: async () => undefined,
          },
        });
      },
    });

    harness.send(request("start-unconfirmed", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "start-unconfirmed",
      ok: false,
      error: {
        code: "CONNECTION_OPERATION_FAILED",
        message: "Connection operation failed",
      },
    });
    expect(connections).toEqual([]);

    const proof = {
      nonce: "proof_nonce_12345678",
      port: 51321,
      issuedAt: 1_000,
      expiresAt: 11_000,
    } as const;
    harness.send(
      commandRequest("configure", {
        kind: "set_confirmed_connection",
        proof,
      }),
    );
    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "configure",
      ok: true,
      result: { status: "configured", port: 51321, confirmedAt: 1_000 },
    });
    harness.send(
      commandRequest("proof-replay", {
        kind: "set_confirmed_connection",
        proof,
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "proof-replay",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });

    harness.send(request("start-confirmed", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "start-confirmed",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(connections).toEqual([{ host: "127.0.0.1", port: 51321 }]);
  });

  it("expires accepted authority before runtime composition and rejects clock rollback", async () => {
    let now = 1_000;
    const createRuntime = vi.fn(async () => {
      throw new Error("must not compose");
    });
    const harness = createHarness({
      lazyRuntime: true,
      now: () => now,
      createRuntime,
    });
    const configure = async (nonce: string): Promise<void> => {
      harness.send(
        commandRequest(`configure-${nonce}`, {
          kind: "set_confirmed_connection",
          proof: {
            nonce,
            port: 51321,
            issuedAt: 1_000,
            expiresAt: 11_000,
          },
        }),
      );
      await expect(harness.nextResponse()).resolves.toMatchObject({ ok: true });
    };

    await configure("proof_nonce_exactexp1");
    now = 11_000;
    harness.send(request("start-exact-expiry", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "start-exact-expiry",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });

    now = 1_000;
    await configure("proof_nonce_rollback1");
    now = 999;
    harness.send(request("start-after-rollback", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "start-after-rollback",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("keeps a connection accepted at start valid while cold model resolution finishes", async () => {
    let now = 1_000;
    const connections: unknown[] = [];
    const harness = createHarness({
      lazyRuntime: true,
      now: () => now,
      models: {
        resolveRuntimeSelection: async () => {
          now = 11_000;
          return { modelId: "gpt-5.6-terra", reasoningEffort: "medium" };
        },
      },
      createRuntime: async (connection) => {
        connections.push(connection);
        return new RuntimeFacade({
          lifecycle: {
            start: async () => undefined,
            stop: async () => undefined,
          },
        });
      },
    });
    harness.send(
      commandRequest("cold-start-confirm", {
        kind: "set_confirmed_connection",
        proof: {
          nonce: "proof_nonce_coldstart1",
          port: 51_321,
          issuedAt: 1_000,
          expiresAt: 11_000,
        },
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "cold-start-confirm",
      ok: true,
    });

    harness.send(request("cold-start-runtime", "start_runtime"));

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "cold-start-runtime",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(connections).toEqual([{ host: "127.0.0.1", port: 51_321 }]);
  });

  it("requires fresh confirmation after normal and emergency stops", async () => {
    let now = 1_000;
    const harness = createHarness({
      lazyRuntime: true,
      now: () => now,
    });
    const confirm = async (id: string, nonce: string): Promise<void> => {
      harness.send(
        commandRequest(id, {
          kind: "set_confirmed_connection",
          proof: {
            nonce,
            port: 51321,
            issuedAt: now,
            expiresAt: now + 10_000,
          },
        }),
      );
      await expect(harness.nextResponse()).resolves.toMatchObject({ id, ok: true });
    };

    await confirm("confirm-normal", "proof_nonce_normal123");
    harness.send(request("start-normal", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({ ok: true });
    harness.send(request("stop-normal", "stop_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({ ok: true });
    harness.send(request("restart-without-confirm", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "restart-without-confirm",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });

    now = 2_000;
    await confirm("confirm-emergency", "proof_nonce_emergency1");
    harness.send(request("start-emergency", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({ ok: true });
    harness.send(request("stop-emergency", "emergency_stop"));
    await expect(harness.nextResponse()).resolves.toMatchObject({ ok: true });
    harness.send(request("restart-after-emergency", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "restart-after-emergency",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
  });

  it.each([
    {
      label: "normal stop",
      command: { kind: "stop_runtime" } as const,
    },
    {
      label: "LAN invalidation",
      command: { kind: "invalidate_connection", reason: "lan_changed" } as const,
    },
    {
      label: "emergency stop",
      command: { kind: "emergency_stop" } as const,
    },
  ])("fences a queued connection proof and start behind $label", async ({ command }) => {
    let releaseAccount!: () => void;
    const accountGate = new Promise<void>((resolve) => {
      releaseAccount = resolve;
    });
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 1_000,
      account: {
        getAccount: async () => {
          await accountGate;
          return { status: "signed_out" };
        },
      },
    });
    harness.send(request("race-account", "get_account"));
    harness.send(
      commandRequest("race-configure", {
        kind: "set_confirmed_connection",
        proof: {
          nonce: "proof_nonce_race_1234",
          port: 51321,
          issuedAt: 1_000,
          expiresAt: 11_000,
        },
      }),
    );
    harness.send(commandRequest("race-control", command));

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "race-control",
      ok: true,
    });
    releaseAccount();
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "race-account",
      ok: true,
    });
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "race-configure",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    harness.send(request("race-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "race-start",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
  });

  it("requires fresh confirmation after runtime disconnect invalidation", async () => {
    const tracked = trackingRuntime();
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 1_000,
      createRuntime: async () => tracked.runtime,
    });
    harness.send(
      commandRequest("disconnect-confirm", {
        kind: "set_confirmed_connection",
        proof: {
          nonce: "proof_nonce_disconnect",
          port: 51321,
          issuedAt: 1_000,
          expiresAt: 11_000,
        },
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({ ok: true });
    harness.send(request("disconnect-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({ ok: true });

    tracked.emit({
      kind: "minecraft",
      revision: 1,
      state: { state: "disconnected", sessionId: null },
    });
    await vi.waitFor(() =>
      expect(
        harness
          .lines()
          .map((line) => JSON.parse(line) as { event?: { kind?: string; reason?: string } })
          .find((message) => message.event?.kind === "connection_invalidated"),
      ).toMatchObject({
        event: { kind: "connection_invalidated", reason: "world_changed" },
      }),
    );
    harness.send(request("disconnect-restart", "start_runtime"));

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "disconnect-restart",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
  });

  it.each([
    {
      label: "model disappearance",
      validate: async () => ({ modelId: "replacement-live-model", reasoningEffort: "xhigh" }),
    },
    {
      label: "reasoning-effort disappearance",
      validate: async () => ({ modelId: "service-live-model", reasoningEffort: "medium" }),
    },
    {
      label: "catalog refresh failure",
      validate: async () => {
        throw new Error("catalog unavailable");
      },
    },
  ])("fails closed when connected-session $label is observed", async ({ validate }) => {
    vi.useFakeTimers();
    let resolution = 0;
    const harness = createHarness({
      models: {
        resolveRuntimeSelection: async () => {
          resolution += 1;
          if (resolution === 1) {
            return { modelId: "service-live-model", reasoningEffort: "xhigh" };
          }
          return validate();
        },
      },
    });
    harness.send(request("model-monitor-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "model-monitor-start",
      ok: true,
      result: { lifecycle: "running" },
    });

    await vi.advanceTimersByTimeAsync(30_000);

    await vi.waitFor(() => expect(harness.stopReasons).toEqual(["model_unavailable"]));
    expect(resolution).toBe(2);
  });

  it("bounds a hung connected-session model validation and fails closed at its deadline", async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    let resolution = 0;
    const harness = createHarness({
      models: {
        resolveRuntimeSelection: async () => {
          resolution += 1;
          if (resolution === 1) {
            return { modelId: "service-live-model", reasoningEffort: "xhigh" };
          }
          return never;
        },
      },
    });
    harness.send(request("model-timeout-start", "start_runtime"));
    await harness.nextResponse();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.stopReasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.stopReasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    await vi.waitFor(() => expect(harness.stopReasons).toEqual(["model_unavailable"]));
  });

  it("ignores a late old-generation model result after normal retirement and replacement", async () => {
    vi.useFakeTimers();
    let releaseOld!: (selection: { modelId: string; reasoningEffort: string }) => void;
    const oldValidation = new Promise<{ modelId: string; reasoningEffort: string }>((resolve) => {
      releaseOld = resolve;
    });
    let resolution = 0;
    const harness = createHarness({
      models: {
        resolveRuntimeSelection: async () => {
          resolution += 1;
          if (resolution === 1) {
            return { modelId: "service-live-model", reasoningEffort: "xhigh" };
          }
          if (resolution === 2) return oldValidation;
          return { modelId: "replacement-live-model", reasoningEffort: "high" };
        },
      },
    });
    harness.send(request("old-monitor-start", "start_runtime"));
    await harness.nextResponse();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolution).toBe(2);

    harness.send(request("old-monitor-stop", "stop_runtime"));
    await harness.nextResponse();
    expect(vi.getTimerCount()).toBe(0);
    harness.send(request("new-monitor-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "new-monitor-start",
      ok: true,
      result: { lifecycle: "running", codex: { model: null } },
    });
    const invalidationsBeforeLateResult = harness
      .lines()
      .filter(
        (line) =>
          (JSON.parse(line) as { event?: { kind?: string } }).event?.kind ===
          "connection_invalidated",
      ).length;

    releaseOld({ modelId: "removed-old-model", reasoningEffort: "minimal" });
    await Promise.resolve();
    await Promise.resolve();

    expect(
      harness
        .lines()
        .filter(
          (line) =>
            (JSON.parse(line) as { event?: { kind?: string } }).event?.kind ===
            "connection_invalidated",
        ),
    ).toHaveLength(invalidationsBeforeLateResult);
  });

  it("aborts a real catalog timeout so late completion cannot invalidate fresh proof or runtime", async () => {
    vi.useFakeTimers();
    let releaseLate!: (records: Model[]) => void;
    const lateRecords = new Promise<Model[]>((resolve) => {
      releaseLate = resolve;
    });
    let catalogCalls = 0;
    const selected = serviceModel("service-live-model", "xhigh", true);
    const replacement = serviceModel("replacement-live-model", "medium", true);
    const catalog = new ModelCatalog(
      {
        listModelRecords: async () => {
          catalogCalls += 1;
          if (catalogCalls === 3) return lateRecords;
          return [selected];
        },
      },
      {
        getAccount: async () => ({ status: "signed_in", auth: "chatgpt" }),
        subscribe: () => () => undefined,
      },
    );
    await catalog.selectModel({
      mode: "explicit",
      modelId: "service-live-model",
      reasoningEffort: "xhigh",
    });
    const harness = createHarness({
      models: {
        listModels: () => catalog.listModels(),
        selectModel: (selection) => catalog.selectModel(selection),
        resolveRuntimeSelection: (options) => catalog.resolveRuntimeSelection(options),
        subscribe: (listener) => catalog.subscribe(listener),
        stop: () => catalog.stop(),
      },
    });
    harness.send(request("real-catalog-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "real-catalog-start",
      ok: true,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(catalogCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(harness.stopReasons).toEqual(["model_unavailable"]));
    const invalidationsBeforeLateCompletion = connectionInvalidations(harness);
    expect(invalidationsBeforeLateCompletion).toEqual(["model_unavailable"]);

    harness.send(request("real-catalog-fresh-start", "start_runtime"));
    const freshStart = harness.nextResponse();
    releaseLate([replacement]);

    await expect(freshStart).resolves.toMatchObject({
      id: "real-catalog-fresh-start",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(connectionInvalidations(harness)).toEqual(invalidationsBeforeLateCompletion);
    expect(harness.stopReasons).toEqual(["model_unavailable"]);
    expect(harness.runtimeCreations()).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("contains a running runtime when a completed migration refresh loses its selected model", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-model-migration-child-"));
    try {
      let records = [serviceModel("migration-live-model", "xhigh", true)];
      const catalog = new ModelCatalog(
        { listModelRecords: async () => records },
        {
          getAccount: async () => ({ status: "signed_in", auth: "chatgpt" }),
          subscribe: () => () => undefined,
        },
        {
          store: new ModelPreferenceStore({ rootDirectory }),
          legacyConfigCandidate: {
            mode: "explicit",
            modelId: "legacy-config-model",
            reasoningEffort: "medium",
          },
        },
      );
      await catalog.migrateLegacyPreference({
        mode: "explicit",
        modelId: "migration-live-model",
        reasoningEffort: "xhigh",
      });
      const harness = createHarness({
        models: {
          listModels: () => catalog.listModels(),
          selectModel: (selection) => catalog.selectModel(selection),
          resolveRuntimeSelection: (options) => catalog.resolveRuntimeSelection(options),
          subscribe: (listener) => catalog.subscribe(listener),
          stop: () => catalog.stop(),
        },
      });
      harness.send(request("migration-model-start", "start_runtime"));
      await expect(harness.nextResponse()).resolves.toMatchObject({
        id: "migration-model-start",
        ok: true,
        result: { lifecycle: "running" },
      });
      records = [serviceModel("migration-replacement-model", "medium", true)];

      await catalog.migrateLegacyPreference(null);

      await vi.waitFor(() => {
        expect(harness.stopReasons).toEqual(["model_unavailable"]);
        expect(connectionInvalidations(harness)).toEqual(["model_unavailable"]);
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("immediately contains typed recovery-time model authority loss from the exact live runtime", async () => {
    let reportAuthorityLoss:
      | ((event: import("../../src/runtime/runtimeEvents.js").RuntimeAuthorityLoss) => void)
      | undefined;
    const stopReasons: TaskStopReason[] = [];
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
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
        stop: (reason) => stopReasons.push(reason),
      },
      authority: {
        subscribe: (listener) => {
          reportAuthorityLoss = listener;
          return () => {
            reportAuthorityLoss = undefined;
          };
        },
      },
    });
    const harness = createHarness({ runtime });
    harness.send(request("recovery-loss-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "recovery-loss-start",
      ok: true,
    });

    const lateOldAuthorityLoss = reportAuthorityLoss;
    reportAuthorityLoss?.({ reason: "model_unavailable" });
    await vi.waitFor(() =>
      expect(harness.lines().join("\n")).toContain('"reason":"model_unavailable"'),
    );

    expect(stopReasons).toEqual(["model_unavailable"]);
    const invalidations = harness
      .lines()
      .map((line) => JSON.parse(line) as { event?: { kind?: string } })
      .filter((line) => line.event?.kind === "connection_invalidated");
    expect(invalidations).toHaveLength(1);
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "stopped",
      minecraft: { state: "disconnected", sessionId: null },
      codex: { state: "stopped", model: null },
      task: null,
    });

    harness.send(request("recovery-loss-fresh-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "recovery-loss-fresh-start",
      ok: true,
      result: { lifecycle: "running" },
    });
    const invalidationsBeforeLateOldSignal = connectionInvalidations(harness);
    lateOldAuthorityLoss?.({ reason: "model_unavailable" });
    await Promise.resolve();
    await Promise.resolve();
    expect(connectionInvalidations(harness)).toEqual(invalidationsBeforeLateOldSignal);
    expect(harness.runtimeCreations()).toBe(2);
  });

  it("preserves LAN authority and creates a fresh runtime after action authority loss", async () => {
    let reportAuthorityLoss:
      | ((event: import("../../src/runtime/runtimeEvents.js").RuntimeAuthorityLoss) => void)
      | undefined;
    const stopReasons: TaskStopReason[] = [];
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
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
        stop: (reason) => stopReasons.push(reason),
      },
      authority: {
        subscribe: (listener) => {
          reportAuthorityLoss = listener;
          return () => {
            reportAuthorityLoss = undefined;
          };
        },
      },
    });
    const harness = createHarness({ runtime });
    harness.send(request("action-loss-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "action-loss-start",
      ok: true,
    });

    reportAuthorityLoss?.({ reason: "action_unavailable" });
    await vi.waitFor(() =>
      expect(connectionInvalidations(harness)).toEqual(["action_unavailable"]),
    );

    expect(stopReasons).toEqual(["process_exit"]);
    harness.send(request("action-loss-fresh-start", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "action-loss-fresh-start",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(harness.runtimeCreations()).toBe(2);
  });

  it("preserves confirmed LAN authority and creates a fresh runtime after readiness timeout", async () => {
    let creations = 0;
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 1_000,
      createRuntime: async (_connection, initialRevision) => {
        creations += 1;
        const failReadiness = creations === 1;
        return new RuntimeFacade({
          initialRevision,
          lifecycle: {
            start: async () => {
              if (failReadiness) throw new ActionCapabilityError("timeout");
            },
            stop: async () => undefined,
          },
        });
      },
    });
    harness.send(
      commandRequest("action-readiness-confirm", {
        kind: "set_confirmed_connection",
        proof: {
          nonce: "proof_nonce_action_readiness",
          port: 51_321,
          issuedAt: 1_000,
          expiresAt: 11_000,
        },
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({ ok: true });

    harness.send(request("action-readiness-first", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "action-readiness-first",
      ok: false,
      error: { code: "MCP_READINESS_TIMEOUT" },
    });

    harness.send(request("action-readiness-retry", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "action-readiness-retry",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(creations).toBe(2);
  });

  it("consumes authority even when terminal runtime startup fails", async () => {
    const createRuntime = vi.fn(async () => throwingRuntime("start_runtime"));
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 1_000,
      createRuntime,
    });
    harness.send(
      commandRequest("failed-start-confirm", {
        kind: "set_confirmed_connection",
        proof: {
          nonce: "proof_nonce_failedstart",
          port: 51321,
          issuedAt: 1_000,
          expiresAt: 11_000,
        },
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({ ok: true });
    harness.send(request("failed-start-first", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "failed-start-first",
      ok: false,
      error: { code: "RUNTIME_START_FAILED" },
    });
    harness.send(request("failed-start-retry", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "failed-start-retry",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    expect(createRuntime).toHaveBeenCalledOnce();
  });

  it("replaces a failed real facade after fresh confirmation and fences its late events", async () => {
    let now = 1_000;
    let first!: ReturnType<typeof controlledRuntimeFacade>;
    let second!: ReturnType<typeof controlledRuntimeFacade>;
    const createRuntime = vi
      .fn<
        (
          connection: { host: "127.0.0.1"; port: number },
          initialRevision: number,
        ) => Promise<DesktopRuntime>
      >()
      .mockImplementationOnce(async (_connection, initialRevision) => {
        first = controlledRuntimeFacade({ failStart: true, initialRevision });
        return first.runtime;
      })
      .mockImplementationOnce(async (_connection, initialRevision) => {
        second = controlledRuntimeFacade({ initialRevision });
        return second.runtime;
      });
    const harness = createHarness({
      lazyRuntime: true,
      now: () => now,
      createRuntime,
    });
    const confirm = async (id: string, nonce: string): Promise<void> => {
      harness.send(
        commandRequest(id, {
          kind: "set_confirmed_connection",
          proof: {
            nonce,
            port: 51321,
            issuedAt: now,
            expiresAt: now + 10_000,
          },
        }),
      );
      await expect(harness.nextResponse()).resolves.toMatchObject({ id, ok: true });
    };

    await confirm("failed-real-confirm-first", "proof_nonce_real_fail1");
    harness.send(request("failed-real-start-first", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "failed-real-start-first",
      ok: false,
      error: { code: "RUNTIME_START_FAILED" },
    });
    expect(first.runtime.snapshot().lifecycle).toBe("failed");

    now = 2_000;
    await confirm("failed-real-confirm-second", "proof_nonce_real_fail2");
    harness.send(request("failed-real-start-second", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "failed-real-start-second",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(createRuntime).toHaveBeenCalledTimes(2);

    const lineCount = harness.lines().length;
    first.emitLatePublic({
      kind: "minecraft",
      revision: 1,
      state: { state: "reconnecting", sessionId: null },
    });
    await delay(0);
    expect(harness.lines()).toHaveLength(lineCount);
    harness.send(request("failed-real-start-after-late-event", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "failed-real-start-after-late-event",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });

  it("retires a real facade on production reconnecting state before accepting a fresh session", async () => {
    let now = 1_000;
    let first!: ReturnType<typeof controlledRuntimeFacade>;
    let second!: ReturnType<typeof controlledRuntimeFacade>;
    const createRuntime = vi
      .fn<
        (
          connection: { host: "127.0.0.1"; port: number },
          initialRevision: number,
        ) => Promise<DesktopRuntime>
      >()
      .mockImplementationOnce(async (_connection, initialRevision) => {
        first = controlledRuntimeFacade({ initialRevision });
        return first.runtime;
      })
      .mockImplementationOnce(async (_connection, initialRevision) => {
        second = controlledRuntimeFacade({ initialRevision });
        return second.runtime;
      });
    const harness = createHarness({
      lazyRuntime: true,
      now: () => now,
      createRuntime,
    });

    harness.send(
      commandRequest("reconnecting-confirm-first", {
        kind: "set_confirmed_connection",
        proof: {
          nonce: "proof_nonce_reconnect1",
          port: 51321,
          issuedAt: now,
          expiresAt: now + 10_000,
        },
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({ ok: true });
    harness.send(request("reconnecting-start-first", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "reconnecting-start-first",
      ok: true,
      result: { lifecycle: "running" },
    });

    first.emitMinecraft({ kind: "disconnected" });
    expect(first.runtime.snapshot().minecraft.state).toBe("reconnecting");
    await vi.waitFor(() =>
      expect(
        harness
          .lines()
          .map((line) => JSON.parse(line) as { event?: { kind?: string; reason?: string } })
          .find((message) => message.event?.kind === "connection_invalidated"),
      ).toMatchObject({
        event: { kind: "connection_invalidated", reason: "minecraft_disconnect" },
      }),
    );
    await vi.waitFor(() => expect(first.runtime.snapshot().lifecycle).toBe("stopped"));

    harness.send(request("reconnecting-start-without-proof", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "reconnecting-start-without-proof",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });

    now = 2_000;
    harness.send(
      commandRequest("reconnecting-confirm-second", {
        kind: "set_confirmed_connection",
        proof: {
          nonce: "proof_nonce_reconnect2",
          port: 51321,
          issuedAt: now,
          expiresAt: now + 10_000,
        },
      }),
    );
    await expect(harness.nextResponse()).resolves.toMatchObject({ ok: true });
    harness.send(request("reconnecting-start-second", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "reconnecting-start-second",
      ok: true,
      result: { lifecycle: "running" },
    });
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "expired",
      proof: {
        nonce: "proof_nonce_expired1",
        port: 51321,
        issuedAt: 1_000,
        expiresAt: 1_999,
      },
    },
    {
      name: "exact-expiry",
      proof: {
        nonce: "proof_nonce_exactexp2",
        port: 51321,
        issuedAt: 1_000,
        expiresAt: 2_000,
      },
    },
    {
      name: "future-issued",
      proof: {
        nonce: "proof_nonce_future12",
        port: 51321,
        issuedAt: 2_001,
        expiresAt: 3_001,
      },
    },
    {
      name: "overlong",
      proof: {
        nonce: "proof_nonce_overlong1",
        port: 51321,
        issuedAt: 1_000,
        expiresAt: 11_001,
      },
    },
  ])("rejects $name connection proof without changing runtime authority", async ({ proof }) => {
    const createRuntime = vi.fn(async () => {
      throw new Error("must not compose");
    });
    const harness = createHarness({
      lazyRuntime: true,
      now: () => 2_000,
      createRuntime,
    });

    harness.send(
      commandRequest("invalid-proof", {
        kind: "set_confirmed_connection",
        proof,
      }),
    );

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "invalid-proof",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("rejects a new connection proof while the current runtime is active", async () => {
    const harness = createHarness({ now: () => 1_000 });
    harness.send(request("start-active", "start_runtime"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "start-active",
      ok: true,
      result: { lifecycle: "running" },
    });

    harness.send(
      commandRequest("reconfigure-active", {
        kind: "set_confirmed_connection",
        proof: {
          nonce: "proof_nonce_active123",
          port: 51321,
          issuedAt: 1_000,
          expiresAt: 11_000,
        },
      }),
    );

    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "reconfigure-active",
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
  });

  it("keeps account authority alive across terminal runtime replacement and stops it once at EOF", async () => {
    const stopAccount = vi.fn(async () => undefined);
    const getAccount = vi.fn(async () => ({
      status: "signed_in" as const,
      auth: "chatgpt" as const,
    }));
    const harness = createHarness({
      account: { getAccount, stop: stopAccount },
    });
    harness.send(request("shared-start-one", "start_runtime"));
    await harness.nextResponse();
    harness.send(request("shared-stop-one", "stop_runtime"));
    await harness.nextResponse();
    harness.send(request("shared-start-two", "start_runtime"));
    await harness.nextResponse();

    harness.send(request("shared-account", "get_account"));
    await expect(harness.nextResponse()).resolves.toMatchObject({
      id: "shared-account",
      ok: true,
      result: { status: "signed_in", auth: "chatgpt" },
    });
    expect(getAccount).toHaveBeenCalledTimes(1);
    expect(stopAccount).not.toHaveBeenCalled();

    harness.endInput();
    await vi.waitFor(() => expect(stopAccount).toHaveBeenCalledTimes(1));
    await harness.server.stop();
    expect(stopAccount).toHaveBeenCalledTimes(1);
  });

  it("publishes account changes without a login URL and stops services at EOF", async () => {
    const accountListeners = new Set<(snapshot: AccountSnapshot) => void>();
    const stopAccount = vi.fn(async () => undefined);
    const stopModels = vi.fn(() => undefined);
    const harness = createHarness({
      account: {
        getAccount: async () => ({ status: "signed_out" }),
        subscribe: (listener) => {
          accountListeners.add(listener);
          return () => accountListeners.delete(listener);
        },
        stop: stopAccount,
      },
      models: { stop: stopModels },
    });

    for (const listener of accountListeners) {
      listener({ status: "signed_in", auth: "chatgpt" });
    }
    await expect(harness.nextEvent()).resolves.toEqual({
      version: 1,
      event: {
        kind: "account",
        account: { status: "signed_in", auth: "chatgpt" },
      },
    });
    expect(JSON.stringify(harness.lines())).not.toContain("loginUrl");

    harness.endInput();
    await vi.waitFor(() => expect(stopAccount).toHaveBeenCalledTimes(1));
    expect(stopModels).toHaveBeenCalledTimes(1);
  });

  it("redacts account and model failures to fixed protocol errors", async () => {
    const harness = createHarness({
      account: {
        getAccount: async () => {
          throw new Error("https://auth.openai.com/?access_token=secret#private C:\\private\\file");
        },
      },
      models: {
        listModels: async () => {
          throw new Error("token=secret-model");
        },
      },
    });

    harness.send(request("account-secret", "get_account"));
    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "account-secret",
      ok: false,
      error: {
        code: "ACCOUNT_OPERATION_FAILED",
        message: "Account operation failed",
      },
    });
    harness.send(request("model-secret", "list_models"));
    await expect(harness.nextResponse()).resolves.toEqual({
      version: 1,
      id: "model-secret",
      ok: false,
      error: {
        code: "MODEL_OPERATION_FAILED",
        message: "Model operation failed",
      },
    });
    expect(JSON.stringify(harness.lines())).not.toContain("access_token");
    expect(JSON.stringify(harness.lines())).not.toContain("secret-model");
    expect(JSON.stringify(harness.lines())).not.toContain("C:\\\\private");
  });
});

function throwingRuntime(command: DesktopRequest["command"]["kind"]): DesktopRuntime {
  const failure = new Error("C:\\Users\\private\\config.toml\nstack-secret");
  return {
    start: async () => {
      if (command === "start_runtime") throw failure;
    },
    stop: async (_reason: TaskStopReason) => {
      if (command === "stop_runtime" || command === "emergency_stop") throw failure;
    },
    stopTask: async () => {
      if (command === "stop_task") throw failure;
    },
    snapshot: () => {
      if (command === "get_status") throw failure;
      return idleSnapshot;
    },
    subscribe: () => () => undefined,
  };
}

function trackingRuntime(initialRevision = 0): {
  runtime: DesktopRuntime;
  emit(event: RuntimeEvent): void;
  listenerCount(): number;
} {
  let lifecycle: RuntimeSnapshot["lifecycle"] = "idle";
  let revision = initialRevision;
  const listeners = new Set<Parameters<DesktopRuntime["subscribe"]>[0]>();
  return {
    runtime: {
      start: async () => {
        lifecycle = "running";
      },
      stop: async () => {
        lifecycle = "stopped";
      },
      stopTask: stopNoTask,
      snapshot: () => ({ ...idleSnapshot, revision, lifecycle }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit: (event) => {
      revision = event.revision;
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

function controlledRuntimeFacade(options: { failStart?: boolean; initialRevision?: number } = {}): {
  runtime: RuntimeFacade;
  emitMinecraft(event: MinecraftEvent): void;
  emitLatePublic(event: RuntimeEvent): void;
} {
  let minecraftListener: ((event: MinecraftEvent) => void) | undefined;
  let retainedPublicListener: ((event: RuntimeEvent) => void) | undefined;
  const runtime = new RuntimeFacade({
    initialRevision: options.initialRevision ?? 0,
    lifecycle: {
      start: async () => {
        if (options.failStart) throw new Error("controlled startup failure");
      },
      stop: async () => undefined,
    },
    minecraft: {
      subscribe: (listener) => {
        minecraftListener = listener;
        return () => {
          if (minecraftListener === listener) minecraftListener = undefined;
        };
      },
    },
  });
  const subscribe = runtime.subscribe.bind(runtime);
  runtime.subscribe = (listener): (() => void) => {
    retainedPublicListener = listener;
    return subscribe(listener);
  };
  return {
    runtime,
    emitMinecraft: (event) => minecraftListener?.(event),
    emitLatePublic: (event) => retainedPublicListener?.(event),
  };
}
