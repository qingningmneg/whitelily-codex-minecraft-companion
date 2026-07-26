import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ActionExecutor } from "./actions/actionExecutor.js";
import { AutonomyScheduler } from "./autonomy/autonomyScheduler.js";
import { CodexAppServerClient } from "./codex/appServerClient.js";
import { selectModel } from "./codex/modelSelector.js";
import { ChatRouter } from "./companion/chatRouter.js";
import { CompanionService } from "./companion/companionService.js";
import { TaskController } from "./companion/taskController.js";
import { loadConfig } from "./config/loadConfig.js";
import type { AppConfig } from "./config/schema.js";
import { SafeLogger } from "./logging/safeLogger.js";
import { startMcpServer, type RunningMcpServer } from "./mcp/mcpServer.js";
import { TurnToolBudget } from "./mcp/toolBudget.js";
import {
  createTrustedSnapshotStore,
  type ToolRegistryDependencies,
  type TrustedSnapshotStore,
} from "./mcp/toolRegistry.js";
import { MemoryStore } from "./memory/memoryStore.js";
import { StateStore } from "./memory/stateStore.js";
import type { MinecraftEvent, MinecraftPort } from "./minecraft/minecraftPort.js";
import { MineflayerAdapter } from "./minecraft/mineflayerAdapter.js";
import { ModeManager } from "./mode/modeManager.js";
import { RuntimeFacade } from "./runtime/runtimeFacade.js";
import { ConfirmationStore } from "./safety/confirmationStore.js";
import { SafetyEngine, type SafetyContext } from "./safety/safetyEngine.js";
import { TaskControllerBudget } from "./safety/taskBudget.js";

const MCP_HOST = "127.0.0.1" as const;
const MCP_PORT = 32123;

export interface WhiteLilyApp {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ManagedMcp {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ManagedCodex {
  assertChatGptLogin(): Promise<void>;
  start(): Promise<void>;
  listModels(): Promise<string[]>;
  stop(): Promise<void>;
}

interface ManagedMinecraft {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onEvent?(listener: (event: MinecraftEvent) => void): () => void;
}

interface ManagedCompanion {
  start(preselectedModel: string): Promise<void>;
  stop(): Promise<void>;
}

interface ManagedExecutor {
  stopAll(): void | Promise<void>;
}

export interface AppRuntime {
  preferredModel: string;
  mcp: ManagedMcp;
  codex: ManagedCodex;
  selectModel(available: readonly string[], preferred: string): string | Promise<string>;
  minecraft: ManagedMinecraft;
  companion: ManagedCompanion;
  executor: ManagedExecutor;
}

export interface AppPaths {
  cwd: string;
  memories: string;
  state: string;
  log: string;
  codexWorkspace: string;
}

export interface AppCompositionContext {
  config: AppConfig;
  paths: AppPaths;
  mode: ModeManager;
  budget: TurnToolBudget;
  taskController: TaskController;
}

export interface CreateAppOptions {
  cwd?: string;
  runtimeFactory?: (context: AppCompositionContext) => AppRuntime | Promise<AppRuntime>;
}

interface RuntimeCompositionObservers {
  taskChanged?(): void;
  modelSelected?(model: string): void;
  invalidateTaskBeforeStartupCleanup?: boolean;
}

interface ComposedApp {
  lifecycle: WhiteLilyAppLifecycle;
  runtime: AppRuntime;
  taskBudget: TaskControllerBudget;
  taskController: TaskController;
}

interface AttemptedComponents {
  mcp: boolean;
  codex: boolean;
  minecraft: boolean;
  companion: boolean;
}

interface StartupAttempt {
  phases: AttemptedComponents;
  cancelled: boolean;
  cleanupPromise?: Promise<void>;
}

interface WhiteLilyLifecycleHooks {
  beforeStartupCleanup?(): void | Promise<void>;
}

function emptyAttempts(): AttemptedComponents {
  return { mcp: false, codex: false, minecraft: false, companion: false };
}

async function writeWhenMissing(path: string, contents: string): Promise<void> {
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function initializeStorage(paths: AppPaths): Promise<void> {
  await mkdir(join(paths.cwd, "data"), { recursive: true });
  await mkdir(join(paths.cwd, "logs"), { recursive: true });
  await writeWhenMissing(paths.memories, "[]\n");
  await writeWhenMissing(
    paths.state,
    `${JSON.stringify(
      {
        lastMode: "friend",
        paused: false,
        unfinishedTaskSummary: null,
      },
      null,
      2,
    )}\n`,
  );
  await writeWhenMissing(paths.log, "");
}

export function createTrustedSafetyContextProvider(
  minecraft: Pick<MinecraftPort, "snapshot">,
  ownerUsername: string,
  trustedSnapshots: TrustedSnapshotStore,
): () => Promise<SafetyContext> {
  return async (): Promise<SafetyContext> => {
    const snapshot = await minecraft.snapshot(ownerUsername);
    trustedSnapshots.publish(snapshot);
    const owner = structuredClone(snapshot.ownerPosition ?? snapshot.botPosition);
    if (snapshot.worldSpawn === undefined) return { owner };
    return {
      spawn: structuredClone(snapshot.worldSpawn),
      owner,
    };
  };
}

class McpLifecycle implements ManagedMcp {
  private server: RunningMcpServer | undefined;
  private starting: { generation: number; operation: Promise<void> } | undefined;
  private generation = 0;

  constructor(private readonly dependencies: ToolRegistryDependencies) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (this.starting) {
      await this.starting.operation;
      return;
    }
    const generation = ++this.generation;
    const operation = (async (): Promise<void> => {
      const server = await startMcpServer({
        host: MCP_HOST,
        port: MCP_PORT,
        dependencies: this.dependencies,
      });
      if (generation !== this.generation) {
        await server.stop();
        throw new Error("MCP server stopped during startup");
      }
      this.server = server;
    })();
    this.starting = { generation, operation };
    try {
      await operation;
    } finally {
      if (this.starting?.operation === operation) this.starting = undefined;
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    const server = this.server;
    this.server = undefined;
    await server?.stop();
  }
}

function createProductionRuntime(context: AppCompositionContext): AppRuntime {
  const { config, paths, mode, budget, taskController } = context;
  const confirmations = new ConfirmationStore();
  const safety = new SafetyEngine(confirmations, config.safety);
  const minecraft = new MineflayerAdapter(config.minecraft);
  const executor = new ActionExecutor(
    minecraft,
    safety,
    confirmations,
    config.minecraft.ownerUsername,
    () => taskController.stop("owner_stop"),
  );
  const memories = new MemoryStore(paths.memories);
  const state = new StateStore(paths.state);
  const logger = new SafeLogger(paths.log);
  const codex = new CodexAppServerClient(config, {
    workspacePath: paths.codexWorkspace,
  });
  const trustedSnapshots = createTrustedSnapshotStore();
  const safetyContextProvider = createTrustedSafetyContextProvider(
    minecraft,
    config.minecraft.ownerUsername,
    trustedSnapshots,
  );

  let companion: CompanionService | undefined;
  const autonomy = new AutonomyScheduler({
    mode,
    minecraft,
    ownerUsername: config.minecraft.ownerUsername,
    requestTurn: async (reason) => {
      if (!companion) throw new Error("companion composition is incomplete");
      await companion.requestAutonomousTurn(reason);
    },
    isBusy: () => companion?.isBusyForAutonomy() ?? true,
  });
  companion = new CompanionService({
    minecraft,
    codex,
    mode,
    memories,
    state,
    confirmations,
    executor,
    budget,
    taskController,
    autonomy,
    safetyContextProvider,
    ownerUsername: config.minecraft.ownerUsername,
    chatRouter: new ChatRouter({
      ownerUsername: config.minecraft.ownerUsername,
      maxMessageLength: 4_000,
    }),
    cwd: paths.cwd,
    preferredModel: config.codex.preferredModel,
    reasoningEffort: config.codex.reasoningEffort,
    logger,
  });
  const toolDependencies: ToolRegistryDependencies = {
    minecraft,
    executor,
    budget,
    safetyContextProvider,
    ownerUsername: config.minecraft.ownerUsername,
    latestSnapshot: trustedSnapshots.latest,
    observeSnapshot: trustedSnapshots.publish,
  };

  return {
    preferredModel: config.codex.preferredModel,
    mcp: new McpLifecycle(toolDependencies),
    codex,
    selectModel,
    minecraft,
    companion,
    executor,
  };
}

class WhiteLilyAppLifecycle implements WhiteLilyApp {
  #state: "idle" | "starting" | "running" | "terminal" = "idle";
  #attempt: StartupAttempt | undefined;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #stopCompleted = false;
  readonly #runtime: AppRuntime;
  readonly #hooks: WhiteLilyLifecycleHooks;

  constructor(runtime: AppRuntime, hooks: WhiteLilyLifecycleHooks = {}) {
    this.#runtime = runtime;
    this.#hooks = hooks;
  }

  start(): Promise<void> {
    if (this.#state === "terminal") {
      return Promise.reject(new Error("WhiteLily app is terminal; create a new app instance"));
    }
    if (this.#startPromise) return this.#startPromise;
    if (this.#state === "running") return Promise.resolve();
    const attempt: StartupAttempt = {
      phases: emptyAttempts(),
      cancelled: false,
    };
    this.#attempt = attempt;
    this.#stopCompleted = false;
    this.#state = "starting";
    const operation = this.#startInternal(attempt);
    this.#startPromise = operation;
    void operation.then(
      () => {
        if (this.#startPromise === operation) this.#startPromise = undefined;
      },
      () => {
        if (this.#startPromise === operation) this.#startPromise = undefined;
      },
    );
    return operation;
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    if (this.#stopCompleted) return Promise.resolve();
    const attempt = this.#attempt;
    if (attempt) attempt.cancelled = true;
    this.#state = "terminal";
    const operation = this.#stopInternal(attempt);
    this.#stopPromise = operation;
    void operation.then(
      () => {
        if (this.#stopPromise === operation) this.#stopPromise = undefined;
      },
      () => {
        if (this.#stopPromise === operation) this.#stopPromise = undefined;
      },
    );
    return operation;
  }

  async #startInternal(attempt: StartupAttempt): Promise<void> {
    try {
      attempt.phases.mcp = true;
      await this.#runtime.mcp.start();
      await this.#finishBoundary(attempt, "mcp");

      attempt.phases.codex = true;
      await this.#runtime.codex.assertChatGptLogin();
      await this.#finishBoundary(attempt, "codex");
      await this.#runtime.codex.start();
      await this.#finishBoundary(attempt, "codex");
      const available = await this.#runtime.codex.listModels();
      await this.#finishBoundary(attempt, "codex");
      const model = await this.#runtime.selectModel(available, this.#runtime.preferredModel);
      await this.#finishBoundary(attempt);

      attempt.phases.minecraft = true;
      await this.#runtime.minecraft.connect();
      await this.#finishBoundary(attempt, "minecraft");

      attempt.phases.companion = true;
      await this.#runtime.companion.start(model);
      await this.#finishBoundary(attempt, "companion");
      this.#state = "running";
    } catch (error) {
      attempt.cancelled = true;
      await Promise.resolve()
        .then(() => this.#hooks.beforeStartupCleanup?.())
        .catch(() => undefined);
      await this.#queueCleanup(attempt).catch(() => undefined);
      this.#state = "terminal";
      if (this.#attempt === attempt) this.#attempt = undefined;
      throw error;
    }
  }

  async #stopInternal(attempt: StartupAttempt | undefined): Promise<void> {
    let cleanupError: unknown;
    if (attempt) {
      try {
        await this.#queueCleanup(attempt);
      } catch (error) {
        cleanupError = error;
      }
    }
    this.#stopCompleted = true;
    if (!this.#startPromise && this.#attempt === attempt) this.#attempt = undefined;
    if (cleanupError !== undefined) throw cleanupError;
  }

  async #finishBoundary(
    attempt: StartupAttempt,
    lateComponent?: keyof AttemptedComponents,
  ): Promise<void> {
    if (!attempt.cancelled && this.#attempt === attempt) return;
    await attempt.cleanupPromise?.catch(() => undefined);
    if (lateComponent) await this.#cleanupLateComponent(lateComponent);
    throw new Error("WhiteLily startup was stopped");
  }

  #queueCleanup(attempt: StartupAttempt): Promise<void> {
    attempt.cleanupPromise ??= this.#cleanup(attempt.phases);
    return attempt.cleanupPromise;
  }

  async #cleanupLateComponent(component: keyof AttemptedComponents): Promise<void> {
    if (component === "companion") {
      await this.#runtime.companion.stop().catch(() => undefined);
      await Promise.resolve()
        .then(() => this.#runtime.executor.stopAll())
        .catch(() => undefined);
    }
    if (component === "minecraft") {
      await this.#runtime.minecraft.disconnect().catch(() => undefined);
    }
    if (component === "codex") {
      await this.#runtime.codex.stop().catch(() => undefined);
    }
    if (component === "mcp") {
      await this.#runtime.mcp.stop().catch(() => undefined);
    }
  }

  async #cleanup(attempted: AttemptedComponents): Promise<void> {
    let firstError: unknown;
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        firstError ??= error;
      }
    };

    if (attempted.companion) {
      await attempt(() => this.#runtime.companion.stop());
      await attempt(() => this.#runtime.executor.stopAll());
    }
    if (attempted.minecraft) await attempt(() => this.#runtime.minecraft.disconnect());
    if (attempted.codex) await attempt(() => this.#runtime.codex.stop());
    if (attempted.mcp) await attempt(() => this.#runtime.mcp.stop());
    if (firstError !== undefined) throw firstError;
  }
}

export async function createApp(
  configPath: string,
  options: CreateAppOptions = {},
): Promise<WhiteLilyApp> {
  const composition = await composeApp(configPath, options);
  return composition.lifecycle;
}

export async function createRuntimeFacade(
  configPath: string,
  options: CreateAppOptions = {},
): Promise<RuntimeFacade> {
  const taskListeners = new Set<() => void>();
  let selectedModel: string | null = null;
  const composition = await composeApp(configPath, options, {
    taskChanged: () => {
      for (const listener of taskListeners) {
        try {
          listener();
        } catch {
          // Runtime task observers cannot affect task lifecycle.
        }
      }
    },
    modelSelected: (model) => {
      selectedModel = model;
    },
    invalidateTaskBeforeStartupCleanup: true,
  });
  const minecraft = composition.runtime.minecraft.onEvent
    ? {
        subscribe: (listener: (event: MinecraftEvent) => void) =>
          composition.runtime.minecraft.onEvent!(listener),
      }
    : undefined;
  return new RuntimeFacade({
    lifecycle: composition.lifecycle,
    task: {
      current: () => composition.taskController.current(),
      budget: () => composition.taskBudget.snapshot(),
      stop: (reason) => composition.taskController.stop(reason),
      subscribe: (listener) => {
        taskListeners.add(listener);
        return () => taskListeners.delete(listener);
      },
    },
    ...(minecraft ? { minecraft } : {}),
    codex: { model: () => selectedModel },
  });
}

async function composeApp(
  configPath: string,
  options: CreateAppOptions,
  observers: RuntimeCompositionObservers = {},
): Promise<ComposedApp> {
  const config = await loadConfig(configPath);
  const cwd = resolve(options.cwd ?? process.cwd());
  const paths: AppPaths = {
    cwd,
    memories: join(cwd, "data", "memories.json"),
    state: join(cwd, "data", "state.json"),
    log: join(cwd, "logs", "companion.log"),
    codexWorkspace: join(cwd, "codex-workspace"),
  };
  await initializeStorage(paths);
  const taskBudget = new TaskControllerBudget();
  const taskController = new TaskController(taskBudget, () => observers.taskChanged?.());
  const context: AppCompositionContext = {
    config,
    paths,
    mode: new ModeManager(),
    budget: new TurnToolBudget(taskBudget),
    taskController,
  };
  const runtime = await (options.runtimeFactory ?? createProductionRuntime)(context);
  const lifecycleRuntime: AppRuntime = observers.modelSelected
    ? {
        preferredModel: runtime.preferredModel,
        mcp: runtime.mcp,
        codex: runtime.codex,
        selectModel: async (available, preferred) => {
          const model = await runtime.selectModel(available, preferred);
          observers.modelSelected?.(model);
          return model;
        },
        minecraft: runtime.minecraft,
        companion: runtime.companion,
        executor: runtime.executor,
      }
    : runtime;
  return {
    lifecycle: new WhiteLilyAppLifecycle(lifecycleRuntime, {
      ...(observers.invalidateTaskBeforeStartupCleanup
        ? {
            beforeStartupCleanup: () => taskController.stop("failed"),
          }
        : {}),
    }),
    runtime,
    taskBudget,
    taskController,
  };
}
