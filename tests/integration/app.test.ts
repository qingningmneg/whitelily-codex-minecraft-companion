import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  createRuntimeFacade,
  type AppCompositionContext,
  type AppPaths,
  type OwnerIdentityProvider,
} from "../../src/app.js";
import { ActionExecutor } from "../../src/actions/actionExecutor.js";
import { CodexAppServerClient } from "../../src/codex/appServerClient.js";
import type { AppConfig } from "../../src/config/schema.js";
import { isMainModule, runCli, type CliDependencies } from "../../src/index.js";
import { TurnToolBudget } from "../../src/mcp/toolBudget.js";
import { createToolRegistry, createTrustedSnapshotStore } from "../../src/mcp/toolRegistry.js";
import { FakeMinecraftPort } from "../../src/minecraft/fakeMinecraftPort.js";
import { ConfirmationStore } from "../../src/safety/confirmationStore.js";
import { SafetyEngine } from "../../src/safety/safetyEngine.js";
import { createCompanionHarness } from "../support/companionHarness.js";
import { ProfileStore } from "../../src/profile/profileStore.js";
import { createJsonRpcLineTransportHarness } from "../support/jsonRpcProcessHarness.js";
import type { OwnerIdentitySnapshot } from "../../src/identity/ownerIdentity.js";
import {
  createAppHarness,
  createCliHarness,
  validConfig,
  type StartupBoundary,
} from "../support/appHarness.js";

const cleanups: Array<() => Promise<void>> = [];

function controlledOwnerIdentity(ownerUsername: string | null) {
  let snapshot: OwnerIdentitySnapshot = {
    revision: 0,
    ownerUsername,
    configured: ownerUsername !== null,
    presence: "unknown",
  };
  const listeners = new Set<(value: OwnerIdentitySnapshot) => void>();
  const ownerIdentity: OwnerIdentityProvider = {
    snapshot: () => snapshot,
    setPresence(input) {
      if (input.revision !== snapshot.revision || input.ownerUsername !== snapshot.ownerUsername) {
        return;
      }
      snapshot = { ...snapshot, presence: input.presence };
      for (const listener of listeners) listener(snapshot);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    ownerIdentity,
    commit(nextOwner: string) {
      snapshot = {
        revision: snapshot.revision + 1,
        ownerUsername: nextOwner,
        configured: true,
        presence: "unknown",
      };
      for (const listener of listeners) listener(snapshot);
    },
    listenerCount: () => listeners.size,
  };
}
const realCodexConfig: AppConfig = {
  minecraft: {
    host: "127.0.0.1",
    port: 25565,
    botUsername: "WhiteLily",
    ownerUsername: "TestOwner",
  },
  codex: {
    preferredModel: "gpt-5.6-terra",
    reasoningEffort: "low",
    allowApiKeyFallback: false,
  },
  companion: { startMode: "friend", personaName: "白百合" },
  safety: {
    spawnProtectionRadius: 16,
    breakConfirmationThreshold: 32,
    placeConfirmationThreshold: 128,
    travelConfirmationDistance: 256,
  },
};

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("WhiteLilyApp composition", () => {
  it("protects authoritative nonzero and changing world spawn through the real tool chain", async () => {
    const appModule = await import("../../src/app.js");
    const createProvider = (
      appModule as typeof appModule & {
        createTrustedSafetyContextProvider?: (
          minecraft: FakeMinecraftPort,
          ownerUsername: () => string,
          snapshots: ReturnType<typeof createTrustedSnapshotStore>,
        ) => () => Promise<{
          spawn?: { x: number; y: number; z: number };
          owner: { x: number; y: number; z: number };
        }>;
      }
    ).createTrustedSafetyContextProvider;
    expect(createProvider).toBeTypeOf("function");
    if (!createProvider) throw new Error("missing trusted safety-context provider");

    const minecraft = new FakeMinecraftPort();
    const world = minecraft.world as typeof minecraft.world & {
      worldSpawn?: { x: number; y: number; z: number };
    };
    world.worldSpawn = { x: 120, y: 70, z: -45 };
    world.botPosition = { x: 140, y: 70, z: -45 };
    const snapshots = createTrustedSnapshotStore();
    const safetyContextProvider = createProvider(minecraft, () => "TestOwner", snapshots);
    const confirmations = new ConfirmationStore();
    const executor = new ActionExecutor(
      minecraft,
      new SafetyEngine(confirmations),
      confirmations,
      () => "TestOwner",
    );
    const budget = new TurnToolBudget();
    const firstLease = budget.begin();
    const tools = createToolRegistry({
      minecraft,
      executor,
      budget,
      safetyContextProvider,
      ownerUsername: () => "TestOwner",
      latestSnapshot: snapshots.latest,
      observeSnapshot: snapshots.publish,
    });

    await expect(
      tools.minecraft_dig_block.execute({
        x: 120,
        y: 70,
        z: -45,
        blockName: "stone",
        turnLease: firstLease,
      }),
    ).resolves.toMatchObject({ isError: true, text: expect.stringContaining("Spawn protection") });

    world.worldSpawn = { x: 300, y: 72, z: 80 };
    await expect(
      tools.minecraft_dig_block.execute({
        x: 120,
        y: 70,
        z: -45,
        blockName: "stone",
        turnLease: firstLease,
      }),
    ).resolves.toEqual({ text: '{"status":"completed"}' });
    await expect(
      tools.minecraft_dig_block.execute({
        x: 300,
        y: 72,
        z: 80,
        blockName: "stone",
        turnLease: firstLease,
      }),
    ).resolves.toMatchObject({ isError: true, text: expect.stringContaining("Spawn protection") });

    delete world.worldSpawn;
    await expect(
      tools.minecraft_place_block.execute({
        x: 500,
        y: 70,
        z: 500,
        blockName: "stone",
        turnLease: firstLease,
      }),
    ).resolves.toMatchObject({
      isError: true,
      text: expect.stringContaining("World spawn is unknown"),
    });
  });

  it("starts in the required order with a Terra/Luna model and stops in reverse order", async () => {
    const harness = await createAppHarness();
    cleanups.push(harness.cleanup);

    await harness.app.start();
    expect(harness.events).toEqual([
      "mcp:start",
      "codex:auth-check",
      "codex:start",
      "codex:model-list",
      "codex:model-select:gpt-5.6-terra",
      "minecraft:connect",
      "companion:start:gpt-5.6-terra",
    ]);

    await harness.app.stop();
    expect(harness.events.slice(-5)).toEqual([
      "companion:stop",
      "actions:stop",
      "minecraft:disconnect",
      "codex:stop",
      "mcp:stop",
    ]);
  });

  it("shares concurrent starts and stops and makes repeated lifecycle calls no-ops", async () => {
    const harness = await createAppHarness({ gateAt: "mcp" });
    cleanups.push(harness.cleanup);

    const firstStart = harness.app.start();
    const secondStart = harness.app.start();
    expect(secondStart).toBe(firstStart);
    await harness.untilBoundary();
    harness.releaseBoundary();
    await Promise.all([firstStart, secondStart]);
    await harness.app.start();
    expect(harness.events.filter((event) => event === "mcp:start")).toHaveLength(1);

    const firstStop = harness.app.stop();
    const secondStop = harness.app.stop();
    expect(secondStop).toBe(firstStop);
    await Promise.all([firstStop, secondStop]);
    await harness.app.stop();
    expect(harness.events.filter((event) => event === "mcp:stop")).toHaveLength(1);
  });

  it("fences a stop racing an in-flight startup before later components can revive", async () => {
    const harness = await createAppHarness({ gateAt: "minecraft" });
    cleanups.push(harness.cleanup);

    const starting = harness.app.start().catch((error: unknown) => error);
    await harness.untilBoundary();
    const stopping = harness.app.stop();
    harness.releaseBoundary();

    await expect(starting).resolves.toMatchObject({ message: "WhiteLily startup was stopped" });
    await stopping;
    expect(harness.events).not.toContain("companion:start:gpt-5.6-terra");
    expect(harness.events.slice(-4)).toEqual([
      "minecraft:disconnect",
      "codex:stop",
      "mcp:stop",
      "minecraft:disconnect",
    ]);
  });

  it.each(["mcp", "auth", "codex", "models", "minecraft", "companion"] as const)(
    "stops a permanently hung %s startup without releasing it and fences its late completion",
    async (boundary) => {
      const harness = await createAppHarness({ gateAt: boundary });
      cleanups.push(harness.cleanup);
      const starting = harness.app.start().catch((error: unknown) => error);
      await harness.untilBoundary();

      const stopping = harness.app.stop();
      const outcome = await Promise.race([
        stopping.then(
          () => "stopped",
          () => "cleanup_failed",
        ),
        delay(75, "timed_out"),
      ]);
      const eventsAtStop = [...harness.events];
      const retryOutcome = await Promise.race([
        harness.app.start().then(
          () => "restarted",
          (error: unknown) => error,
        ),
        delay(25, "timed_out"),
      ]);
      expect(retryOutcome).toMatchObject({
        message: expect.stringContaining("create a new app"),
      });
      expect(harness.events).toEqual(eventsAtStop);

      harness.releaseBoundary();
      await starting;
      await stopping.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(outcome).toBe("stopped");
      const gatedEvent = {
        mcp: "mcp:start",
        auth: "codex:auth-check",
        codex: "codex:start",
        models: "codex:model-list",
        minecraft: "minecraft:connect",
        companion: "companion:start:gpt-5.6-terra",
      }[boundary];
      const gatedIndex = eventsAtStop.indexOf(gatedEvent);
      expect(gatedIndex).toBeGreaterThanOrEqual(0);
      const startupEvents = harness.events.filter(
        (event) =>
          event.includes(":start") ||
          event.includes(":connect") ||
          event.includes("auth-check") ||
          event.includes("model-list"),
      );
      expect(startupEvents.at(-1)).toBe(gatedEvent);
      expect(harness.activeComponents).toEqual({
        mcp: false,
        codex: false,
        minecraft: false,
        companion: false,
      });
    },
  );

  it("stops through the real Codex client while transport creation is hung", async () => {
    const transport = createJsonRpcLineTransportHarness();
    let markTransportReached!: () => void;
    const transportReached = new Promise<void>((resolve) => {
      markTransportReached = resolve;
    });
    let releaseTransport!: (value: typeof transport.transport) => void;
    const pendingTransport = new Promise<typeof transport.transport>((resolve) => {
      releaseTransport = resolve;
    });
    const codex = new CodexAppServerClient(realCodexConfig, {
      runLoginStatus: async () => ({
        stdout: "Logged in using ChatGPT\n",
        stderr: "",
        exitCode: 0,
      }),
      createTransport: () => {
        markTransportReached();
        return pendingTransport;
      },
      workspacePath: "C:/WhiteLily/codex-workspace",
    });
    const harness = await createAppHarness({ codex });
    cleanups.push(harness.cleanup);

    const starting = harness.app.start().catch((error: unknown) => error);
    await transportReached;
    const stopping = harness.app.stop();
    const stopOutcome = await Promise.race([
      stopping.then(() => "stopped"),
      delay(75, "timed_out"),
    ]);
    await expect(starting).resolves.toMatchObject({
      message: expect.stringContaining("stopped"),
    });

    releaseTransport(transport.transport);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stopOutcome).toBe("stopped");
    expect(transport.closed()).toBe(true);
    expect(transport.sent()).toEqual([]);
    expect(harness.events).not.toContain("minecraft:connect");
  });

  it.each<{
    boundary: StartupBoundary;
    expected: string[];
  }>([
    { boundary: "mcp", expected: ["mcp:start", "mcp:stop"] },
    {
      boundary: "auth",
      expected: ["mcp:start", "codex:auth-check", "codex:stop", "mcp:stop"],
    },
    {
      boundary: "codex",
      expected: ["mcp:start", "codex:auth-check", "codex:start", "codex:stop", "mcp:stop"],
    },
    {
      boundary: "models",
      expected: [
        "mcp:start",
        "codex:auth-check",
        "codex:start",
        "codex:model-list",
        "codex:stop",
        "mcp:stop",
      ],
    },
    {
      boundary: "selection",
      expected: [
        "mcp:start",
        "codex:auth-check",
        "codex:start",
        "codex:model-list",
        "codex:model-select:gpt-5.6-terra",
        "codex:stop",
        "mcp:stop",
      ],
    },
    {
      boundary: "minecraft",
      expected: [
        "mcp:start",
        "codex:auth-check",
        "codex:start",
        "codex:model-list",
        "codex:model-select:gpt-5.6-terra",
        "minecraft:connect",
        "minecraft:disconnect",
        "codex:stop",
        "mcp:stop",
      ],
    },
    {
      boundary: "companion",
      expected: [
        "mcp:start",
        "codex:auth-check",
        "codex:start",
        "codex:model-list",
        "codex:model-select:gpt-5.6-terra",
        "minecraft:connect",
        "companion:start:gpt-5.6-terra",
        "companion:stop",
        "actions:stop",
        "minecraft:disconnect",
        "codex:stop",
        "mcp:stop",
      ],
    },
  ])(
    "rolls back the attempted $boundary boundary and preserves its error",
    async ({ boundary, expected }) => {
      const harness = await createAppHarness({
        failAt: boundary,
        cleanupFailures: ["companion", "codex"],
      });
      cleanups.push(harness.cleanup);

      await expect(harness.app.start()).rejects.toThrow(`startup:${boundary}`);
      expect(harness.events).toEqual(expected);
    },
  );

  it("continues every normal cleanup and reports only the first cleanup error", async () => {
    const harness = await createAppHarness({
      cleanupFailures: ["companion", "minecraft", "mcp"],
    });
    cleanups.push(harness.cleanup);
    await harness.app.start();

    await expect(harness.app.stop()).rejects.toThrow("cleanup:companion");
    expect(harness.events.slice(-5)).toEqual([
      "companion:stop",
      "actions:stop",
      "minecraft:disconnect",
      "codex:stop",
      "mcp:stop",
    ]);
  });

  it.each(["minecraft", "companion"] as const)(
    "makes the same app terminal after %s startup rollback",
    async (boundary) => {
      const harness = await createAppHarness({ failAt: boundary });
      cleanups.push(harness.cleanup);
      await expect(harness.app.start()).rejects.toThrow(`startup:${boundary}`);
      const afterRollback = [...harness.events];

      await expect(harness.app.start()).rejects.toThrow("create a new app");
      expect(harness.events).toEqual(afterRollback);
    },
  );

  it("initializes cwd-local valid stores without overwriting existing content", async () => {
    const harness = await createAppHarness();
    cleanups.push(harness.cleanup);
    expect(await harness.readData()).toEqual({
      memories: "[]\n",
      state:
        '{\n  "lastMode": "friend",\n  "paused": false,\n  "unfinishedTaskSummary": null,\n  "worldInvalidated": false\n}\n',
      log: "",
    });
    await mkdir(join(harness.directory, "data"), { recursive: true });
    await writeFile(join(harness.directory, "data", "memories.json"), "existing-memory", "utf8");
    await writeFile(join(harness.directory, "data", "state.json"), "existing-state", "utf8");
    await writeFile(join(harness.directory, "logs", "companion.log"), "existing-log", "utf8");

    await createApp(harness.configPath, {
      cwd: harness.directory,
      runtimeFactory: () => {
        throw new Error("second runtime composed");
      },
    }).catch(() => undefined);
    expect(await harness.readData()).toEqual({
      memories: "existing-memory",
      state: "existing-state",
      log: "existing-log",
    });
  });

  it("derives the expanded core paths from one injected desktop data root", async () => {
    const harness = await createCliHarness();
    cleanups.push(harness.cleanup);
    const dataRoot = join(harness.directory, "desktop-data");
    const resourceRoot = resolve(
      import.meta.dirname,
      "..",
      "..",
      "node_modules",
      "@openai",
      "codex-win32-x64",
    );
    const configPath = join(dataRoot, "config.toml");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(configPath, validConfig, "utf8");
    let paths: AppPaths;
    let codexLaunchConfig: { executablePath: string; codexHome: string } | undefined;

    const app = await createApp(configPath, {
      cwd: join(harness.directory, "untrusted-working-directory"),
      dataRoot,
      runtimeFactory: (context) => {
        paths = context.paths;
        codexLaunchConfig = (
          context as typeof context & {
            codexLaunchConfig: { executablePath: string; codexHome: string };
          }
        ).codexLaunchConfig;
        return {
          preferredModel: context.config.codex.preferredModel,
          mcp: { start: async () => undefined, stop: async () => undefined },
          codex: {
            assertChatGptLogin: async () => undefined,
            start: async () => undefined,
            listModels: async () => ["gpt-5.6-terra"],
            stop: async () => undefined,
          },
          selectModel: (available) => available[0]!,
          minecraft: { connect: async () => undefined, disconnect: async () => undefined },
          companion: { start: async () => undefined, stop: async () => undefined },
          executor: { stopAll: () => undefined },
        };
      },
    });
    cleanups.push(() => app.stop());

    expect(paths!).toEqual({
      cwd: dataRoot,
      dataRoot,
      config: configPath,
      profiles: join(dataRoot, "config", "profiles"),
      memories: join(dataRoot, "data", "memories.json"),
      worlds: join(dataRoot, "config", "worlds"),
      logs: join(dataRoot, "logs"),
      audit: join(dataRoot, "logs", "audit.jsonl"),
      diagnostics: join(dataRoot, "diagnostics"),
      migrationSnapshots: join(dataRoot, "data", "migration-snapshots"),
      runtimeState: join(dataRoot, "data", "state.json"),
      codexWorkspace: join(dataRoot, "codex-workspace"),
      state: join(dataRoot, "data", "state.json"),
      log: join(dataRoot, "logs", "companion.log"),
    });
    expect(codexLaunchConfig).toEqual({
      executablePath: join(resourceRoot, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      codexHome: join(dataRoot, "codex"),
    });
  });

  it("keeps legacy CLI path derivation when no data root is injected", async () => {
    const harness = await createAppHarness();
    cleanups.push(harness.cleanup);

    expect(harness.composition.paths).toEqual({
      cwd: harness.directory,
      dataRoot: harness.directory,
      config: harness.configPath,
      profiles: join(harness.directory, "config", "profiles"),
      memories: join(harness.directory, "data", "memories.json"),
      worlds: join(harness.directory, "config", "worlds"),
      logs: join(harness.directory, "logs"),
      audit: join(harness.directory, "logs", "audit.jsonl"),
      diagnostics: join(harness.directory, "diagnostics"),
      migrationSnapshots: join(harness.directory, "data", "migration-snapshots"),
      runtimeState: join(harness.directory, "data", "state.json"),
      codexWorkspace: join(harness.directory, "codex-workspace"),
      state: join(harness.directory, "data", "state.json"),
      log: join(harness.directory, "logs", "companion.log"),
    });
  });

  it("composes legacy CLI with an external config while keeping runtime data under cwd", async () => {
    const harness = await createCliHarness();
    cleanups.push(harness.cleanup);
    const runtimeDirectory = join(harness.directory, "legacy-runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    let paths: AppPaths | undefined;
    const app = await createApp(harness.configPath, {
      cwd: runtimeDirectory,
      runtimeFactory: (context) => {
        paths = context.paths;
        return {
          preferredModel: context.config.codex.preferredModel,
          mcp: { start: async () => undefined, stop: async () => undefined },
          codex: {
            assertChatGptLogin: async () => undefined,
            start: async () => undefined,
            listModels: async () => ["gpt-5.6-terra"],
            stop: async () => undefined,
          },
          selectModel: (_available, preferred) => preferred,
          minecraft: { connect: async () => undefined, disconnect: async () => undefined },
          companion: { start: async () => undefined, stop: async () => undefined },
          executor: { stopAll: () => undefined },
        };
      },
    });
    cleanups.push(() => app.stop());

    expect(paths).toEqual({
      cwd: runtimeDirectory,
      dataRoot: runtimeDirectory,
      config: harness.configPath,
      profiles: join(runtimeDirectory, "config", "profiles"),
      memories: join(runtimeDirectory, "data", "memories.json"),
      worlds: join(runtimeDirectory, "config", "worlds"),
      logs: join(runtimeDirectory, "logs"),
      audit: join(runtimeDirectory, "logs", "audit.jsonl"),
      diagnostics: join(runtimeDirectory, "diagnostics"),
      migrationSnapshots: join(runtimeDirectory, "data", "migration-snapshots"),
      runtimeState: join(runtimeDirectory, "data", "state.json"),
      codexWorkspace: join(runtimeDirectory, "codex-workspace"),
      state: join(runtimeDirectory, "data", "state.json"),
      log: join(runtimeDirectory, "logs", "companion.log"),
    });
    await expect(readFile(join(runtimeDirectory, "data", "memories.json"), "utf8")).resolves.toBe(
      "[]\n",
    );
    await expect(readFile(join(runtimeDirectory, "data", "state.json"), "utf8")).resolves.toContain(
      '"lastMode": "friend"',
    );
  });

  it("rejects an injected config path that escapes the desktop data root", async () => {
    const harness = await createCliHarness();
    cleanups.push(harness.cleanup);
    const dataRoot = join(harness.directory, "desktop-data");

    await expect(
      createApp(harness.configPath, {
        dataRoot,
        runtimeFactory: () => {
          throw new Error("must not compose");
        },
      }),
    ).rejects.toThrow("config must stay within the WhiteLily data root");
    await expect(access(dataRoot)).rejects.toThrow();
  });

  it("rejects invalid configuration before storage or runtime composition", async () => {
    const harness = await createCliHarness();
    cleanups.push(harness.cleanup);
    const invalidPath = join(harness.directory, "invalid.toml");
    await writeFile(invalidPath, validConfig.replace('host = "127.0.0.1"', 'host = "0.0.0.0"'));
    let composed = false;

    await expect(
      createApp(invalidPath, {
        cwd: harness.directory,
        runtimeFactory: () => {
          composed = true;
          throw new Error("must not compose");
        },
      }),
    ).rejects.toThrow();
    expect(composed).toBe(false);
    await expect(access(join(harness.directory, "data"))).rejects.toThrow();
    await expect(access(join(harness.directory, "logs"))).rejects.toThrow();
  });

  it("uses exactly one shared mode manager and one shared tool budget", async () => {
    const harness = await createAppHarness();
    cleanups.push(harness.cleanup);
    expect(harness.runtimeFactoryCalls()).toBe(1);
    expect(harness.identities.schedulerMode).toBe(harness.composition.mode);
    expect(harness.identities.companionMode).toBe(harness.composition.mode);
    expect(harness.identities.mcpBudget).toBe(harness.composition.budget);
    expect(harness.identities.companionBudget).toBe(harness.composition.budget);
  });

  it("revokes old-owner work through the shared identity and retires its listener on cleanup", async () => {
    const files = await createCliHarness();
    cleanups.push(files.cleanup);
    const identity = controlledOwnerIdentity("OldOwner");
    const disconnect = vi.fn(async () => undefined);
    const stopCodex = vi.fn(async () => undefined);
    const ownerChanges: OwnerIdentitySnapshot[] = [];
    let composition: AppCompositionContext | undefined;
    const app = await createApp(files.configPath, {
      cwd: files.directory,
      ownerIdentity: identity.ownerIdentity,
      runtimeFactory: (context) => {
        composition = context;
        return {
          preferredModel: context.config.codex.preferredModel,
          mcp: { start: async () => undefined, stop: async () => undefined },
          codex: {
            assertChatGptLogin: async () => undefined,
            start: async () => undefined,
            listModels: async () => ["gpt-5.6-terra"],
            stop: stopCodex,
          },
          selectModel: (_available, preferred) => preferred,
          minecraft: { connect: async () => undefined, disconnect },
          companion: {
            start: async () => undefined,
            stop: async () => undefined,
            ownerIdentityChanged: (snapshot: OwnerIdentitySnapshot) => ownerChanges.push(snapshot),
          },
          executor: { stopAll: () => undefined },
        };
      },
    });
    if (!composition) throw new Error("runtime was not composed");
    await app.start();
    composition.taskController.start({
      goal: "old owner task",
      expectedActions: ["get_state"],
      limits: {
        maxToolCalls: 1,
        maxBlockChanges: 0,
        maxHorizontalTravel: 0,
        maxDurationMs: 1_000,
        maxDangerousOperations: 0,
      },
      stopCondition: "the owner changes",
    });

    identity.commit("NewOwner");

    expect(composition.taskController.current()).toBeNull();
    expect(ownerChanges).toHaveLength(1);
    expect(disconnect).not.toHaveBeenCalled();
    expect(stopCodex).not.toHaveBeenCalled();
    expect(identity.listenerCount()).toBe(1);

    await app.stop();
    expect(identity.listenerCount()).toBe(0);
    identity.commit("LaterOwner");
    expect(ownerChanges).toHaveLength(1);
  });

  it("rejects runtime composition when the canonical owner identity is unconfigured", async () => {
    const files = await createCliHarness();
    cleanups.push(files.cleanup);
    let composed = false;

    await expect(
      createApp(files.configPath, {
        cwd: files.directory,
        ownerIdentity: controlledOwnerIdentity(null).ownerIdentity,
        runtimeFactory: () => {
          composed = true;
          throw new Error("must not compose");
        },
      }),
    ).rejects.toMatchObject({ code: "OWNER_IDENTITY_REQUIRED" });
    expect(composed).toBe(false);
  });

  it("persists sanitized task start and completed audit records through legacy createApp", async () => {
    const harness = await createAppHarness();
    cleanups.push(harness.cleanup);
    await harness.app.start();
    const rawGoal =
      "Use password=hunter2 from D:\\PrivateRoot\\AuditOwner\\private\\task.txt for TestOwner";
    const active = harness.composition.taskController.start(
      {
        goal: rawGoal,
        expectedActions: ["get_state", "move_to", "dig_block"],
        limits: {
          maxToolCalls: 5,
          maxBlockChanges: 6,
          maxHorizontalTravel: 7,
          maxDurationMs: 8_000,
          maxDangerousOperations: 1,
        },
        stopCondition: "finish safely",
      },
      {
        maxToolCalls: 5,
        maxBlockChanges: 6,
        maxHorizontalTravel: 7,
        maxDurationMs: 8_000,
        maxDangerousOperations: 1,
      },
    );
    expect(
      harness.composition.taskController.consume({
        leaseId: active.lease.id,
        kind: "get_state",
        now: active.lease.startedAt + 1,
      }).ok,
    ).toBe(true);

    harness.composition.taskController.stop("completed");
    await harness.app.stop();

    const output = (await harness.readData()).log;
    const auditOutput = await harness.readAudit();
    const auditRecords = auditOutput
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const records = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => record.event)).toEqual(["task_started", "task_stopped"]);
    expect(auditRecords.map((record) => record.kind)).toEqual(["task_started", "task_stopped"]);
    expect(records[0]).toMatchObject({
      limits: {
        maxToolCalls: 5,
        maxBlockChanges: 6,
        maxHorizontalTravel: 7,
        maxDurationMs: 8_000,
        maxDangerousOperations: 1,
      },
      counters: {
        toolCalls: 0,
        blockChanges: 0,
        horizontalTravel: 0,
        dangerousOperations: 0,
      },
      expectedActionCategoryCount: 3,
    });
    expect(records[1]).toMatchObject({
      reason: "completed",
      counters: {
        toolCalls: 1,
        blockChanges: 0,
        horizontalTravel: 0,
        dangerousOperations: 0,
      },
    });
    for (const sensitive of [
      active.id,
      active.lease.id,
      rawGoal,
      "hunter2",
      "PrivateRoot",
      "AuditOwner",
      "private",
      "task.txt",
      "TestOwner",
    ]) {
      expect(output).not.toContain(sensitive);
    }
  });

  it("flushes the process_exit task audit before legacy app.stop resolves", async () => {
    const harness = await createAppHarness();
    cleanups.push(harness.cleanup);
    await harness.app.start();
    harness.composition.taskController.start({
      goal: "keep this raw goal private",
      expectedActions: ["wait"],
      limits: {
        maxToolCalls: 1,
        maxBlockChanges: 0,
        maxHorizontalTravel: 0,
        maxDurationMs: 1_000,
        maxDangerousOperations: 0,
      },
      stopCondition: "process exits",
    });

    await harness.app.stop();

    const records = (await harness.readData()).log
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => [record.event, record.reason ?? null])).toEqual([
      ["task_started", null],
      ["task_stopped", "process_exit"],
    ]);
  });

  it.each([
    "completed",
    "failed",
    "timeout",
    "budget_exhausted",
    "owner_stop",
    "emergency_stop",
    "disconnect",
    "world_changed",
    "model_unavailable",
    "model_changed",
    "process_exit",
  ] as const)("persists exactly one start and one %s terminal audit", async (reason) => {
    const harness = await createAppHarness();
    cleanups.push(harness.cleanup);
    await harness.app.start();
    harness.composition.taskController.start({
      goal: "private lifecycle goal",
      expectedActions: ["wait"],
      limits: {
        maxToolCalls: 1,
        maxBlockChanges: 0,
        maxHorizontalTravel: 0,
        maxDurationMs: 1_000,
        maxDangerousOperations: 0,
      },
      stopCondition: "terminal transition",
    });
    if (reason !== "process_exit") harness.composition.taskController.stop(reason);

    await harness.app.stop();

    const records = (await harness.readData()).log
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => [record.event, record.reason ?? null])).toEqual([
      ["task_started", null],
      ["task_stopped", reason],
    ]);
  });

  it("keeps process-exit revocation and cleanup fail-closed when every audit write throws", async () => {
    const harness = await createAppHarness();
    cleanups.push(harness.cleanup);
    await harness.app.start();
    const logPath = join(harness.directory, "logs", "companion.log");
    await rm(logPath);
    await mkdir(logPath);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      const active = harness.composition.taskController.start({
        goal: "password=hunter2 D:\\PrivateRoot\\PrivateOwner\\secret.txt",
        expectedActions: ["wait"],
        limits: {
          maxToolCalls: 1,
          maxBlockChanges: 0,
          maxHorizontalTravel: 0,
          maxDurationMs: 1_000,
          maxDangerousOperations: 0,
        },
        stopCondition: "process exits",
      });

      await expect(harness.app.stop()).resolves.toBeUndefined();

      expect(harness.composition.taskController.current()).toBeNull();
      expect(
        harness.composition.taskController.consume({
          leaseId: active.lease.id,
          kind: "wait",
          now: active.lease.startedAt + 1,
        }),
      ).toEqual({ ok: false, reason: "task lease is invalid" });
      expect(harness.events.slice(-5)).toEqual([
        "companion:stop",
        "actions:stop",
        "minecraft:disconnect",
        "codex:stop",
        "mcp:stop",
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("returns only the public start/stop surface without reflective runtime state", async () => {
    const harness = await createAppHarness();
    cleanups.push(harness.cleanup);

    expect(Reflect.ownKeys(harness.app)).toEqual([]);
    expect(
      Reflect.ownKeys(Object.getPrototypeOf(harness.app) as object)
        .filter((key) => key !== "constructor")
        .sort(),
    ).toEqual(["start", "stop"]);
  });

  it("composes a reusable runtime facade without changing createApp", async () => {
    const files = await createCliHarness();
    cleanups.push(files.cleanup);
    const events: string[] = [];
    let context: import("../../src/app.js").AppCompositionContext | undefined;
    let minecraftListener:
      ((event: import("../../src/minecraft/minecraftPort.js").MinecraftEvent) => void) | undefined;
    const runtime = await createRuntimeFacade(files.configPath, {
      cwd: files.directory,
      runtimeFactory: (createdContext) => {
        context = createdContext;
        return {
          preferredModel: createdContext.config.codex.preferredModel,
          mcp: {
            start: async () => {
              events.push("mcp:start");
            },
            stop: async () => {
              events.push("mcp:stop");
            },
          },
          codex: {
            assertChatGptLogin: async () => {
              events.push("codex:auth-check");
            },
            start: async () => {
              events.push("codex:start");
            },
            listModels: async () => ["gpt-5.6-terra"],
            stop: async () => {
              events.push("codex:stop");
            },
          },
          selectModel: (models, preferred) => {
            if (!models.includes(preferred)) throw new Error("model unavailable");
            events.push(`codex:model-select:${preferred}`);
            return preferred;
          },
          minecraft: {
            connect: async () => {
              events.push("minecraft:connect");
              minecraftListener?.({ kind: "connected" });
            },
            disconnect: async () => {
              events.push("minecraft:disconnect");
            },
            onEvent: (listener) => {
              minecraftListener = listener;
              return () => {
                minecraftListener = undefined;
              };
            },
          },
          companion: {
            start: async (model) => {
              events.push(`companion:start:${model}`);
            },
            stop: async () => {
              events.push("companion:stop");
            },
          },
          executor: {
            stopAll: async () => {
              events.push("actions:stop");
            },
          },
        };
      },
    });
    if (!context) throw new Error("runtime context was not composed");
    const taskEvents: Array<
      Extract<
        import("../../src/runtime/runtimeEvents.js").RuntimeEvent,
        {
          kind: "task";
        }
      >
    > = [];
    runtime.subscribe((event) => {
      if (event.kind === "task") taskEvents.push(event);
    });

    await runtime.start();
    const active = context.taskController.start({
      goal: "Build a safe house",
      expectedActions: ["move", "place"],
      limits: {
        maxToolCalls: 8,
        maxBlockChanges: 16,
        maxHorizontalTravel: 64,
        maxDurationMs: 60_000,
        maxDangerousOperations: 0,
      },
      stopCondition: "House complete",
    });

    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "running",
      minecraft: { state: "connected", sessionId: null },
      codex: { state: "ready", model: "gpt-5.6-terra" },
      task: {
        goal: "Build a safe house",
      },
    });
    expect(runtime.snapshot().task?.id).not.toBe(active.lease.id);
    expect(JSON.stringify({ snapshot: runtime.snapshot(), taskEvents })).not.toContain(
      active.lease.id,
    );

    await runtime.stop("emergency_stop");
    expect(events.slice(-5)).toEqual([
      "companion:stop",
      "actions:stop",
      "minecraft:disconnect",
      "codex:stop",
      "mcp:stop",
    ]);
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "stopped",
      minecraft: { state: "disconnected", sessionId: null },
      codex: { state: "stopped", model: null },
      task: null,
    });
  });

  it("loads the latest persisted active profile on composition and accepts live profile replacement", async () => {
    const files = await createCliHarness();
    cleanups.push(files.cleanup);
    const profiles = new ProfileStore({
      rootDirectory: join(files.directory, "config", "profiles"),
      createProfileId: () => "be176ae1-a4b4-4fd6-b04c-89634cd74a99",
    });
    const initial = await profiles.read();
    const persisted = await profiles.update(initial.revision, {
      ...initial.value,
      displayName: "小百合",
      mode: "balanced",
      persona: "persisted builder",
    });
    let context: import("../../src/app.js").AppCompositionContext | undefined;
    const runtime = await createRuntimeFacade(files.configPath, {
      cwd: files.directory,
      runtimeFactory: (createdContext) => {
        context = createdContext;
        return {
          preferredModel: createdContext.config.codex.preferredModel,
          mcp: { start: async () => undefined, stop: async () => undefined },
          codex: {
            assertChatGptLogin: async () => undefined,
            start: async () => undefined,
            listModels: async () => ["gpt-5.6-terra"],
            stop: async () => undefined,
          },
          selectModel: (_available, preferred) => preferred,
          minecraft: { connect: async () => undefined, disconnect: async () => undefined },
          companion: { start: async () => undefined, stop: async () => undefined },
          executor: { stopAll: () => undefined },
        };
      },
    });
    if (!context) throw new Error("runtime context was not composed");

    expect(context.mode.getProfile()).toEqual(persisted.value);
    runtime.applyProfile({
      ...persisted.value,
      displayName: "即时百合",
      mode: "autonomous",
      persona: "live replacement",
    });

    expect(context.mode.getProfile()).toMatchObject({
      displayName: "即时百合",
      mode: "autonomous",
      persona: "live replacement",
    });
    await runtime.stop("process_exit");
  });

  it("uses the desktop live model selection instead of legacy config defaults", async () => {
    const files = await createCliHarness();
    cleanups.push(files.cleanup);
    const legacySelector = vi.fn(() => {
      throw new Error("legacy model selector must not run");
    });
    const companionStarts: string[] = [];
    let context: import("../../src/app.js").AppCompositionContext | undefined;
    const runtime = await createRuntimeFacade(files.configPath, {
      cwd: files.directory,
      runtimeModelSelection: {
        modelId: "service-live-model",
        reasoningEffort: "xhigh",
      },
      runtimeFactory: (createdContext) => {
        context = createdContext;
        return {
          preferredModel: createdContext.config.codex.preferredModel,
          mcp: { start: async () => undefined, stop: async () => undefined },
          codex: {
            assertChatGptLogin: async () => undefined,
            start: async () => undefined,
            listModels: async () => ["service-live-model"],
            stop: async () => undefined,
          },
          selectModel: legacySelector,
          minecraft: {
            connect: async () => undefined,
            disconnect: async () => undefined,
          },
          companion: {
            start: async (model) => {
              companionStarts.push(model);
            },
            stop: async () => undefined,
          },
          executor: { stopAll: () => undefined },
        };
      },
    });

    await runtime.start();

    expect(context?.runtimeModelSelection).toEqual({
      modelId: "service-live-model",
      reasoningEffort: "xhigh",
    });
    expect(legacySelector).not.toHaveBeenCalled();
    expect(companionStarts).toEqual(["service-live-model"]);
    expect(runtime.snapshot().codex.model).toBe("service-live-model");
  });

  it("forwards typed model authority loss only while the exact facade is live", async () => {
    const files = await createCliHarness();
    cleanups.push(files.cleanup);
    let context: import("../../src/app.js").AppCompositionContext | undefined;
    const runtime = await createRuntimeFacade(files.configPath, {
      cwd: files.directory,
      runtimeFactory: (createdContext) => {
        context = createdContext;
        return {
          preferredModel: "service-live-model",
          mcp: { start: async () => undefined, stop: async () => undefined },
          codex: {
            assertChatGptLogin: async () => undefined,
            start: async () => undefined,
            listModels: async () => ["service-live-model"],
            stop: async () => undefined,
          },
          selectModel: () => "service-live-model",
          minecraft: {
            connect: async () => undefined,
            disconnect: async () => undefined,
          },
          companion: {
            start: async () => undefined,
            stop: async () => undefined,
          },
          executor: { stopAll: () => undefined },
        };
      },
    });
    if (!context) throw new Error("runtime context was not composed");
    const losses: string[] = [];
    runtime.subscribeAuthorityLoss((event) => losses.push(event.reason));

    context.reportAuthorityLoss({ reason: "model_unavailable" });
    expect(losses).toEqual(["model_unavailable"]);

    await runtime.stop("owner_stop");
    context.reportAuthorityLoss({ reason: "model_unavailable" });
    expect(losses).toEqual(["model_unavailable"]);
  });

  it("carries a non-legacy model and xhigh effort through production thread and turn transport", async () => {
    const files = await createCliHarness();
    cleanups.push(files.cleanup);
    const transport = createJsonRpcLineTransportHarness();
    const codex = new CodexAppServerClient(realCodexConfig, {
      runLoginStatus: async () => ({
        stdout: "Logged in using ChatGPT\n",
        stderr: "",
        exitCode: 0,
      }),
      createTransport: async () => transport.transport,
      workspacePath: "C:/legacy/workspace-must-not-win",
    });
    const appModule = await import("../../src/app.js");
    const createProductionRuntime = (
      appModule as typeof appModule & {
        createProductionRuntime?: (
          context: import("../../src/app.js").AppCompositionContext,
          client: CodexAppServerClient,
        ) => import("../../src/app.js").AppRuntime;
      }
    ).createProductionRuntime;
    expect(createProductionRuntime).toBeTypeOf("function");
    if (!createProductionRuntime) throw new Error("production runtime composition is unavailable");
    let production: import("../../src/app.js").AppRuntime | undefined;
    await createRuntimeFacade(files.configPath, {
      cwd: files.directory,
      codexClient: codex,
      runtimeModelSelection: {
        modelId: "service-live-model",
        reasoningEffort: "xhigh",
      },
      runtimeFactory: (context) => {
        production = createProductionRuntime(context, codex);
        return production;
      },
    });
    if (!production) throw new Error("production runtime was not composed");

    const starting = codex.start();
    await expect(transport.nextSent()).resolves.toMatchObject({ id: 1, method: "initialize" });
    transport.receive({
      id: 1,
      result: {
        userAgent: "codex/0.145.0",
        codexHome: "D:/codex-home",
        platformFamily: "windows",
        platformOs: "windows",
      },
    });
    await starting;
    await expect(transport.nextSent()).resolves.toEqual({ method: "initialized", params: {} });

    const companionStarting = production.companion.start("service-live-model");
    await expect(transport.nextSent()).resolves.toEqual({
      id: 2,
      method: "thread/start",
      params: {
        model: "service-live-model",
        cwd: resolve(files.directory, "codex-workspace"),
        sandbox: "read-only",
        approvalPolicy: "never",
      },
    });
    transport.receive({ id: 2, result: { thread: { id: "thread-service-live-intent" } } });
    await expect(transport.nextSent()).resolves.toEqual({
      id: 3,
      method: "thread/start",
      params: {
        model: "service-live-model",
        cwd: resolve(files.directory, "codex-workspace"),
        sandbox: "read-only",
        approvalPolicy: "never",
      },
    });
    transport.receive({ id: 3, result: { thread: { id: "thread-service-live-execution" } } });
    await companionStarting;

    const turn = codex.sendTurn("thread-service-live-execution", "transport pair check");
    await expect(transport.nextSent()).resolves.toEqual({
      id: 4,
      method: "turn/start",
      params: {
        threadId: "thread-service-live-execution",
        input: [{ type: "text", text: "transport pair check", text_elements: [] }],
        effort: "xhigh",
      },
    });
    transport.receive({ id: 4, result: { turn: { id: "turn-service-live" } } });
    transport.receive({
      method: "turn/completed",
      params: {
        threadId: "thread-service-live-execution",
        turn: { id: "turn-service-live", status: "completed" },
      },
    });
    await expect(turn).resolves.toMatchObject({
      threadId: "thread-service-live-execution",
      turnId: "turn-service-live",
      status: "completed",
    });
    expect(JSON.stringify(transport.sent())).not.toContain("gpt-5.6-terra");
    expect(JSON.stringify(transport.sent())).not.toContain('"effort":"low"');

    await production.companion.stop();
    await codex.stop();
  });

  it("invalidates a startup-created task before component failure cleanup", async () => {
    const files = await createCliHarness();
    cleanups.push(files.cleanup);
    const events: string[] = [];
    const runtime = await createRuntimeFacade(files.configPath, {
      cwd: files.directory,
      runtimeFactory: (context) => ({
        preferredModel: context.config.codex.preferredModel,
        mcp: {
          start: async () => {
            events.push("mcp:start");
          },
          stop: async () => {
            events.push("mcp:stop");
          },
        },
        codex: {
          assertChatGptLogin: async () => {
            events.push("codex:auth-check");
          },
          start: async () => {
            events.push("codex:start");
          },
          listModels: async () => ["gpt-5.6-terra"],
          stop: async () => {
            events.push("codex:stop");
          },
        },
        selectModel: (_models, preferred) => preferred,
        minecraft: {
          connect: async () => {
            events.push("minecraft:connect");
          },
          disconnect: async () => {
            events.push("minecraft:disconnect");
          },
        },
        companion: {
          start: async () => {
            events.push("companion:start");
            context.taskController.start({
              goal: "Task created during startup",
              expectedActions: ["place"],
              limits: {
                maxToolCalls: 8,
                maxBlockChanges: 16,
                maxHorizontalTravel: 64,
                maxDurationMs: 60_000,
                maxDangerousOperations: 0,
              },
              stopCondition: "Startup completes",
            });
            throw new Error("startup:companion");
          },
          stop: async () => {
            events.push("companion:stop");
          },
        },
        executor: {
          stopAll: async () => {
            events.push("actions:stop");
          },
        },
      }),
    });
    runtime.subscribe((event) => {
      if (event.kind === "task") events.push(event.task ? "task:started" : "task:stopped");
    });

    await expect(runtime.start()).rejects.toThrow("Runtime failed to start");

    const stoppedIndex = events.indexOf("task:stopped");
    expect(stoppedIndex).toBeGreaterThan(events.indexOf("task:started"));
    expect(events.slice(stoppedIndex)).toEqual([
      "task:stopped",
      "companion:stop",
      "actions:stop",
      "minecraft:disconnect",
      "codex:stop",
      "mcp:stop",
    ]);
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
    });
  });
});

describe("externally composed CompanionService startup", () => {
  it("uses the exact preselected model without Codex start/model-list and leaves Codex shutdown to app", async () => {
    const harness = await createCompanionHarness();
    cleanups.push(harness.cleanup);

    await harness.service.start("gpt-5.6-luna");
    expect(harness.codex.startCalls).toBe(0);
    expect(harness.codex.listModelCalls).toBe(0);
    expect(harness.codex.startedThreads).toEqual([
      {
        cwd: harness.directory,
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
      },
      {
        cwd: harness.directory,
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
      },
    ]);

    await harness.service.stop();
    expect(harness.codex.stopCalls).toBe(0);
  });
});

describe("Windows CLI", () => {
  it("detects a current drive-letter main module and rejects a different URL", () => {
    const argv1 = resolve("dist/src/index.js");
    expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
    expect(isMainModule("file:///C:/different.js", argv1)).toBe(false);
    expect(isMainModule(pathToFileURL(argv1).href, undefined)).toBe(false);
  });

  it("checks valid configuration read-only without instantiating the app", async () => {
    const harness = await createCliHarness();
    cleanups.push(harness.cleanup);

    await harness.run(["--check-config", harness.configPath]);
    expect(harness.stdout).toEqual(["Configuration OK"]);
    expect(harness.stderr).toEqual([]);
    expect(harness.createAppCalls()).toBe(0);
    await expect(access(join(harness.directory, "data"))).rejects.toThrow();
    await expect(access(join(harness.directory, "logs"))).rejects.toThrow();
  });

  it("rejects missing check path and a non-loopback host without creating an app", async () => {
    const missing = await createCliHarness();
    const invalid = await createCliHarness();
    cleanups.push(missing.cleanup, invalid.cleanup);
    const invalidPath = join(invalid.directory, "invalid.toml");
    await writeFile(
      invalidPath,
      validConfig.replace('host = "127.0.0.1"', 'host = "192.168.1.10"'),
      "utf8",
    );

    await missing.run(["--check-config"]);
    await invalid.run(["--check-config", invalidPath]);
    expect(missing.process.exitCode).toBe(1);
    expect(invalid.process.exitCode).toBe(1);
    expect(missing.createAppCalls()).toBe(0);
    expect(invalid.createAppCalls()).toBe(0);
  });

  it("defaults the config path and makes an in-flight marker inert when a signal wins shutdown", async () => {
    const harness = await createCliHarness();
    cleanups.push(harness.cleanup);
    await writeFile(join(harness.directory, "config.toml"), validConfig, "utf8");

    await harness.run([]);
    expect(harness.createdConfigPaths).toEqual([join(harness.directory, "config.toml")]);
    expect(harness.startCalls()).toBe(1);
    expect(harness.pollCount()).toBe(1);
    const marker = harness.observeMarker();
    harness.emitSignal("SIGINT");
    harness.emitSignal("SIGTERM");
    await marker;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.stopCalls()).toBe(1);
    expect(harness.pollCount()).toBe(0);
    expect(harness.deletedMarker()).toBeUndefined();
    expect(harness.signalListenerCount("SIGINT")).toBe(0);
    expect(harness.signalListenerCount("SIGTERM")).toBe(0);
  });

  it("cleans controls and reports a concise startup failure without a stack or credential", async () => {
    const harness = await createCliHarness({
      app: {
        start: async () => {
          throw new Error("secret=sk-test-credential\nstack: private path");
        },
        stop: async () => undefined,
      },
    });
    cleanups.push(harness.cleanup);

    await harness.run([harness.configPath]);
    expect(harness.process.exitCode).toBe(1);
    expect(harness.pollCount()).toBe(0);
    expect(harness.stderr.join("\n")).toBe("WhiteLily failed to start");
    expect(harness.stderr.join("\n")).not.toContain("sk-test");
  });

  it("coalesces overlapping marker polls into one exact deletion and one shutdown", async () => {
    const harness = await createCliHarness();
    cleanups.push(harness.cleanup);
    await harness.run([harness.configPath]);

    await harness.observeMarkerTwice();

    expect(harness.deletedMarkers).toEqual([join(harness.directory, "data", "stop.request")]);
    expect(harness.stopCalls()).toBe(1);
  });

  it("invalidates a pending marker probe when startup fails before the probe resolves true", async () => {
    let rejectStart!: (error: Error) => void;
    const harness = await createCliHarness({
      deferredMarkerProbe: true,
      app: {
        start: () =>
          new Promise<void>((_resolve, reject) => {
            rejectStart = reject;
          }),
        stop: async () => undefined,
      },
    });
    cleanups.push(harness.cleanup);
    const running = harness.run([harness.configPath]);
    await harness.beginMarkerProbe();
    rejectStart(new Error("startup failed"));
    await running;
    const stderr = [...harness.stderr];
    const exitCode = harness.process.exitCode;

    harness.resolveMarkerProbe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.deletedMarkers).toEqual([]);
    expect(harness.stopCalls()).toBe(1);
    expect(harness.stderr).toEqual(stderr);
    expect(harness.process.exitCode).toBe(exitCode);
    expect(harness.pollCount()).toBe(0);
    expect(harness.signalListenerCount("SIGINT")).toBe(0);
    expect(harness.signalListenerCount("SIGTERM")).toBe(0);
  });

  it("invalidates a rejecting marker probe after signal shutdown", async () => {
    const harness = await createCliHarness({ deferredMarkerProbe: true });
    cleanups.push(harness.cleanup);
    await harness.run([harness.configPath]);
    await harness.beginMarkerProbe();
    harness.emitSignal("SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stderr = [...harness.stderr];
    const exitCode = harness.process.exitCode;

    harness.rejectMarkerProbe(new Error("stale stat failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.deletedMarkers).toEqual([]);
    expect(harness.stopCalls()).toBe(1);
    expect(harness.stderr).toEqual(stderr);
    expect(harness.process.exitCode).toBe(exitCode);
    expect(harness.pollCount()).toBe(0);
    expect(harness.signalListenerCount("SIGINT")).toBe(0);
    expect(harness.signalListenerCount("SIGTERM")).toBe(0);
  });

  it("translates a signal to the exact process_exit runtime stop reason", async () => {
    let signalListener: (() => void) | undefined;
    const reasons: string[] = [];
    await runCli(["config.toml"], {
      cwd: "C:\\WhiteLily",
      createRuntime: async () => ({
        start: async () => undefined,
        stop: async (reason) => {
          reasons.push(reason);
        },
        subscribe: () => () => undefined,
      }),
      onSignal: (_signal, listener) => {
        signalListener = listener;
      },
      offSignal: () => undefined,
      setPoll: () => 1,
      clearPoll: () => undefined,
      markerExists: async () => false,
    } satisfies CliDependencies);

    signalListener?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(reasons).toEqual(["process_exit"]);
  });

  it("translates the stop marker to the exact process_exit runtime stop reason", async () => {
    let poll: (() => void) | undefined;
    const reasons: string[] = [];
    const deleted: string[] = [];
    await runCli(["config.toml"], {
      cwd: "C:\\WhiteLily",
      createRuntime: async () => ({
        start: async () => undefined,
        stop: async (reason) => {
          reasons.push(reason);
        },
        subscribe: () => () => undefined,
      }),
      onSignal: () => undefined,
      offSignal: () => undefined,
      setPoll: (listener) => {
        poll = listener;
        return 1;
      },
      clearPoll: () => undefined,
      markerExists: async () => true,
      deleteMarker: async (path) => {
        deleted.push(path);
      },
    } satisfies CliDependencies);

    poll?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(reasons).toEqual(["process_exit"]);
    expect(deleted).toEqual(["C:\\WhiteLily\\data\\stop.request"]);
  });
});
