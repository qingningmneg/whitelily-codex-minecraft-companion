import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  type AppCompositionContext,
  type AppRuntime,
  type WhiteLilyApp,
} from "../../src/app.js";
import { runCli, type CliDependencies } from "../../src/index.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export const validConfig = `[minecraft]
host = "127.0.0.1"
port = 25565
bot_username = "WhiteLily"
owner_username = "TestOwner"

[codex]
preferred_model = "gpt-5.6-terra"
reasoning_effort = "low"
allow_api_key_fallback = false

[companion]
start_mode = "friend"
persona_name = "白百合"

[safety]
spawn_protection_radius = 16
break_confirmation_threshold = 32
place_confirmation_threshold = 128
travel_confirmation_distance = 256
`;

export type StartupBoundary =
  "mcp" | "auth" | "codex" | "models" | "selection" | "minecraft" | "companion";

export type CleanupBoundary = "companion" | "actions" | "minecraft" | "codex" | "mcp";

export interface AppHarnessOptions {
  failAt?: StartupBoundary;
  cleanupFailures?: CleanupBoundary[];
  gateAt?: StartupBoundary;
  availableModels?: string[];
  codex?: AppRuntime["codex"];
  existingMemories?: string;
  existingState?: string;
  existingLog?: string;
}

export async function createAppHarness(options: AppHarnessOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "whitelily-app-"));
  const configPath = join(directory, "config.toml");
  await writeFile(configPath, validConfig, "utf8");
  const events: string[] = [];
  const activeComponents = {
    mcp: false,
    codex: false,
    minecraft: false,
    companion: false,
  };
  const reached = deferred<void>();
  const release = deferred<void>();
  let composition: AppCompositionContext | undefined;
  let runtimeFactoryCalls = 0;
  let identities:
    | {
        schedulerMode: AppCompositionContext["mode"];
        companionMode: AppCompositionContext["mode"];
        mcpBudget: AppCompositionContext["budget"];
        companionBudget: AppCompositionContext["budget"];
      }
    | undefined;

  const step = async (boundary: StartupBoundary, event: string): Promise<void> => {
    events.push(event);
    if (options.gateAt === boundary) {
      reached.resolve();
      await release.promise;
    }
    if (boundary === "mcp") activeComponents.mcp = true;
    if (boundary === "codex") activeComponents.codex = true;
    if (boundary === "minecraft") activeComponents.minecraft = true;
    if (boundary === "companion") activeComponents.companion = true;
    if (options.failAt === boundary) throw new Error(`startup:${boundary}`);
  };

  const cleanup = async (boundary: CleanupBoundary, event: string): Promise<void> => {
    events.push(event);
    if (boundary === "mcp") activeComponents.mcp = false;
    if (boundary === "codex") activeComponents.codex = false;
    if (boundary === "minecraft") activeComponents.minecraft = false;
    if (boundary === "companion") activeComponents.companion = false;
    if (options.cleanupFailures?.includes(boundary)) throw new Error(`cleanup:${boundary}`);
  };

  const app = await createApp(configPath, {
    cwd: directory,
    runtimeFactory: (context): AppRuntime => {
      runtimeFactoryCalls += 1;
      composition = context;
      identities = {
        schedulerMode: context.mode,
        companionMode: context.mode,
        mcpBudget: context.budget,
        companionBudget: context.budget,
      };
      return {
        preferredModel: context.config.codex.preferredModel,
        mcp: {
          start: () => step("mcp", "mcp:start"),
          stop: () => cleanup("mcp", "mcp:stop"),
        },
        codex:
          options.codex ??
          ({
            assertChatGptLogin: () => step("auth", "codex:auth-check"),
            start: () => step("codex", "codex:start"),
            listModels: async () => {
              await step("models", "codex:model-list");
              return options.availableModels ?? ["gpt-5.6-terra", "gpt-5.6-luna"];
            },
            stop: () => cleanup("codex", "codex:stop"),
          } satisfies AppRuntime["codex"]),
        selectModel: async (models, preferred) => {
          await step("selection", `codex:model-select:${preferred}`);
          if (!models.includes(preferred)) throw new Error("preferred model unavailable");
          return preferred;
        },
        minecraft: {
          connect: () => step("minecraft", "minecraft:connect"),
          disconnect: () => cleanup("minecraft", "minecraft:disconnect"),
        },
        companion: {
          start: (model) => step("companion", `companion:start:${model}`),
          stop: () => cleanup("companion", "companion:stop"),
        },
        executor: {
          stopAll: async () => cleanup("actions", "actions:stop"),
        },
      };
    },
  });

  if (!composition || !identities) throw new Error("runtime was not composed");
  return {
    app,
    directory,
    configPath,
    events,
    activeComponents,
    composition,
    identities,
    runtimeFactoryCalls: () => runtimeFactoryCalls,
    untilBoundary: () => reached.promise,
    releaseBoundary: () => release.resolve(),
    readData: async () => ({
      memories: await readFile(join(directory, "data", "memories.json"), "utf8"),
      state: await readFile(join(directory, "data", "state.json"), "utf8"),
      log: await readFile(join(directory, "logs", "companion.log"), "utf8"),
    }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

class FakeProcess extends EventEmitter {
  exitCode: number | undefined;
}

export interface CliHarnessOptions {
  app?: WhiteLilyApp;
  createAppError?: Error;
  deferredMarkerProbe?: boolean;
}

export async function createCliHarness(options: CliHarnessOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "whitelily-cli-"));
  const configPath = join(directory, "valid.toml");
  await writeFile(configPath, validConfig, "utf8");
  const process = new FakeProcess();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const intervals = new Map<number, () => void>();
  let nextInterval = 1;
  let createAppCalls = 0;
  let startCalls = 0;
  let stopCalls = 0;
  let markerPresent = false;
  const markerProbe = deferred<boolean>();
  const markerProbeReached = deferred<void>();
  let deletedMarker: string | undefined;
  const deletedMarkers: string[] = [];
  const createdConfigPaths: string[] = [];
  const app: WhiteLilyApp = {
    start: async () => {
      startCalls += 1;
      await options.app?.start();
    },
    stop: async () => {
      stopCalls += 1;
      await options.app?.stop();
    },
  };

  const dependencies: CliDependencies = {
    cwd: directory,
    createApp: async (path) => {
      createAppCalls += 1;
      createdConfigPaths.push(path);
      if (options.createAppError) throw options.createAppError;
      return app;
    },
    writeStdout: (message) => stdout.push(message),
    writeStderr: (message) => stderr.push(message),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    onSignal: (signal, listener) => process.on(signal, listener),
    offSignal: (signal, listener) => process.off(signal, listener),
    setPoll: (listener, milliseconds) => {
      if (milliseconds !== 500) throw new Error("unexpected poll interval");
      const id = nextInterval++;
      intervals.set(id, listener);
      return id;
    },
    clearPoll: (id) => intervals.delete(id as number),
    markerExists: async () => {
      if (!options.deferredMarkerProbe) return markerPresent;
      markerProbeReached.resolve();
      return markerProbe.promise;
    },
    deleteMarker: async (path) => {
      deletedMarker = path;
      deletedMarkers.push(path);
      markerPresent = false;
    },
  };

  return {
    directory,
    configPath,
    stdout,
    stderr,
    process,
    dependencies,
    run: (args: string[]) => runCli(args, dependencies),
    emitSignal: (signal: "SIGINT" | "SIGTERM") => process.emit(signal),
    observeMarker: async () => {
      markerPresent = true;
      for (const listener of [...intervals.values()]) listener();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    observeMarkerTwice: async () => {
      markerPresent = true;
      for (const listener of [...intervals.values()]) {
        listener();
        listener();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    beginMarkerProbe: async () => {
      for (let attempt = 0; attempt < 20 && intervals.size === 0; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (intervals.size === 0) throw new Error("marker poll was not installed");
      for (const listener of [...intervals.values()]) listener();
      await markerProbeReached.promise;
    },
    resolveMarkerProbe: (value: boolean) => markerProbe.resolve(value),
    rejectMarkerProbe: (error: unknown) => markerProbe.reject(error),
    pollCount: () => intervals.size,
    createAppCalls: () => createAppCalls,
    startCalls: () => startCalls,
    stopCalls: () => stopCalls,
    deletedMarker: () => deletedMarker,
    deletedMarkers,
    createdConfigPaths,
    signalListenerCount: (signal: "SIGINT" | "SIGTERM") => process.listenerCount(signal),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
