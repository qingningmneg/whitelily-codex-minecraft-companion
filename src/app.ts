import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ActionExecutor } from "./actions/actionExecutor.js";
import { AutonomyScheduler } from "./autonomy/autonomyScheduler.js";
import { CodexAppServerClient } from "./codex/appServerClient.js";
import {
  createBundledCodexLaunchConfig,
  resolveDefaultCodexLaunchConfig,
  runCodexLoginStatus,
  spawnCodexAppServerTransport,
  type CodexLaunchConfig,
} from "./codex/jsonRpcProcess.js";
import type { ResolvedModelSelection } from "./codex/modelCatalog.js";
import { selectModel } from "./codex/modelSelector.js";
import { ChatRouter } from "./companion/chatRouter.js";
import { CompanionService } from "./companion/companionService.js";
import {
  TaskController,
  type TaskAuditCallback,
  type TaskAuditData,
  type TaskAuditEvent,
} from "./companion/taskController.js";
import { loadConfig, resolveCoreAppPaths } from "./config/loadConfig.js";
import type { AppConfig, AppPaths, ConfirmedRuntimeConnection } from "./config/schema.js";
export type { AppPaths } from "./config/schema.js";
import { AuditLogger, type AuditEvent } from "./logging/auditLogger.js";
import { SafeLogger } from "./logging/safeLogger.js";
import { startMcpServer, type RunningMcpServer } from "./mcp/mcpServer.js";
import { TurnToolBudget } from "./mcp/toolBudget.js";
import {
  createTrustedSnapshotStore,
  type ToolRegistryDependencies,
  type TrustedSnapshotStore,
} from "./mcp/toolRegistry.js";
import { MemoryStore } from "./memory/memoryStore.js";
import { MemoryMigration } from "./memory/memoryMigration.js";
import { ScopedMemoryStore } from "./memory/scopedMemoryStore.js";
import { StateStore } from "./memory/stateStore.js";
import type { MinecraftEvent, MinecraftPort } from "./minecraft/minecraftPort.js";
import { MineflayerAdapter } from "./minecraft/mineflayerAdapter.js";
import { ModeManager } from "./mode/modeManager.js";
import { ProfileStore } from "./profile/profileStore.js";
import type { CompanionProfile } from "./profile/profileSchema.js";
import { OwnerIdentityError, type OwnerIdentitySnapshot } from "./identity/ownerIdentity.js";
import { OwnerIdentityService } from "./identity/ownerIdentityService.js";
import { RuntimeFacade, type RuntimeTaskProjection } from "./runtime/runtimeFacade.js";
import type { RuntimeAuthorityLoss } from "./runtime/runtimeEvents.js";
import { ConfirmationStore } from "./safety/confirmationStore.js";
import { SafetyEngine, type SafetyContext } from "./safety/safetyEngine.js";
import { TaskControllerBudget } from "./safety/taskBudget.js";
import { effectiveSafetyProfile, type RuntimeSafetyConfiguration } from "./safety/safetyProfile.js";

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
  ownerIdentityChanged?(snapshot: OwnerIdentitySnapshot): void;
  applyProfile?(profile: CompanionProfile): void;
  setMemoryScope?(scope: import("./memory/scopedMemoryStore.js").MemoryContextScope): void;
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
  taskProjection?: Pick<RuntimeTaskProjection, "status" | "subscribe">;
}

export interface AppCompositionContext {
  config: AppConfig;
  codexLaunchConfig: CodexLaunchConfig;
  runtimeModelSelection?: ResolvedModelSelection;
  paths: AppPaths;
  mode: ModeManager;
  budget: TurnToolBudget;
  taskController: TaskController;
  ownerIdentity: OwnerIdentityProvider;
  logger: Pick<SafeLogger, "info" | "error">;
  reportAuthorityLoss(event: RuntimeAuthorityLoss): void;
  worldSafety: RuntimeSafetyConfiguration;
}

export interface OwnerIdentityProvider {
  snapshot(): OwnerIdentitySnapshot;
  setPresence(input: {
    revision: number;
    ownerUsername: string;
    presence: "online" | "offline";
  }): void;
  subscribe(listener: (snapshot: OwnerIdentitySnapshot) => void): () => void;
}

export interface CreateAppOptions {
  cwd?: string;
  dataRoot?: string;
  codexResourceDirectory?: string;
  codexClient?: CodexAppServerClient;
  confirmedMinecraftConnection?: ConfirmedRuntimeConnection;
  runtimeInitialRevision?: number;
  runtimeModelSelection?: ResolvedModelSelection;
  worldSafety?: RuntimeSafetyConfiguration;
  ownerIdentity?: OwnerIdentityProvider;
  runtimeFactory?: (context: AppCompositionContext) => AppRuntime | Promise<AppRuntime>;
}

interface RuntimeCompositionObservers {
  taskChanged?(): void;
  modelSelected?(model: string): void;
  invalidateTaskBeforeStartupCleanup?: boolean;
  authorityLost?(event: RuntimeAuthorityLoss): void;
}

interface ComposedApp {
  lifecycle: WhiteLilyAppLifecycle;
  runtime: AppRuntime;
  taskBudget: TaskControllerBudget;
  taskController: TaskController;
  mode: ModeManager;
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
  beforeStopCleanup?(): void;
  afterCleanup?(): void | Promise<void>;
}

class PersistentTaskAudit {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly logger: Pick<SafeLogger, "info" | "error">,
    private readonly audit: Pick<AuditLogger, "append">,
    private readonly budget: TaskControllerBudget,
  ) {}

  readonly record: TaskAuditCallback = (event, data) => {
    const fields = taskAuditFields(event, data, this.budget);
    const auditEvent = taskAuditEvent(event, data, this.budget);
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        let failed = false;
        try {
          await this.audit.append(auditEvent);
        } catch {
          failed = true;
        }
        try {
          await this.logger.info(event, fields);
        } catch {
          failed = true;
        }
        if (failed) throw new Error("task audit write failed");
      })
      .catch(() =>
        Promise.resolve()
          .then(() =>
            this.logger.error("task_audit_write_failed", {
              code: "audit_write_failed",
            }),
          )
          .catch(() => undefined),
      );
  };

  async flush(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.tail;
      await pending;
    } while (pending !== this.tail);
  }
}

function taskAuditEvent(
  event: TaskAuditEvent,
  data: TaskAuditData,
  budget: TaskControllerBudget,
): AuditEvent {
  const snapshot = budget.snapshot();
  return {
    schemaVersion: 1,
    timestamp: event === "task_started" ? data.startedAt : new Date().toISOString(),
    kind: event,
    detail: {
      startedAt: data.startedAt,
      expectedActionCategoryCount: data.expectedActionCategoryCount,
      maxToolCalls: data.limits.maxToolCalls,
      maxBlockChanges: data.limits.maxBlockChanges,
      maxHorizontalTravel: data.limits.maxHorizontalTravel,
      maxDurationMs: data.limits.maxDurationMs,
      maxDangerousOperations: data.limits.maxDangerousOperations,
      toolCalls: snapshot.toolCalls,
      blockChanges: snapshot.blockChanges,
      horizontalTravel: snapshot.horizontalTravel,
      dangerousOperations: snapshot.dangerousOperations,
      ...(event === "task_stopped" && "reason" in data ? { reason: data.reason } : {}),
    },
  };
}

function taskAuditFields(
  event: TaskAuditEvent,
  data: TaskAuditData,
  budget: TaskControllerBudget,
): Record<string, unknown> {
  const snapshot = budget.snapshot();
  return {
    startedAt: data.startedAt,
    expectedActionCategoryCount: data.expectedActionCategoryCount,
    limits: {
      maxToolCalls: data.limits.maxToolCalls,
      maxBlockChanges: data.limits.maxBlockChanges,
      maxHorizontalTravel: data.limits.maxHorizontalTravel,
      maxDurationMs: data.limits.maxDurationMs,
      maxDangerousOperations: data.limits.maxDangerousOperations,
    },
    counters: {
      toolCalls: snapshot.toolCalls,
      blockChanges: snapshot.blockChanges,
      horizontalTravel: snapshot.horizontalTravel,
      dangerousOperations: snapshot.dangerousOperations,
    },
    ...(event === "task_stopped" && "reason" in data ? { reason: data.reason } : {}),
  };
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
  await Promise.all([
    mkdir(dirname(paths.memories), { recursive: true }),
    mkdir(paths.profiles, { recursive: true }),
    mkdir(paths.worlds, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.diagnostics, { recursive: true }),
    mkdir(paths.migrationSnapshots, { recursive: true }),
  ]);
  await writeWhenMissing(paths.memories, "[]\n");
  await writeWhenMissing(
    paths.runtimeState,
    `${JSON.stringify(
      {
        lastMode: "friend",
        paused: false,
        unfinishedTaskSummary: null,
        worldInvalidated: false,
      },
      null,
      2,
    )}\n`,
  );
  await writeWhenMissing(paths.log, "");
}

export function createTrustedSafetyContextProvider(
  minecraft: Pick<MinecraftPort, "snapshot">,
  ownerUsername: () => string,
  trustedSnapshots: TrustedSnapshotStore,
): () => Promise<SafetyContext> {
  return async (): Promise<SafetyContext> => {
    const snapshot = await minecraft.snapshot(ownerUsername());
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

export function createProductionRuntime(
  context: AppCompositionContext,
  sharedCodexClient?: CodexAppServerClient,
): AppRuntime {
  const { config, paths, mode, budget, taskController, logger } = context;
  const effectiveWorldSafety = effectiveSafetyProfile(
    context.worldSafety.requestedPreset,
    context.worldSafety.compatibilityVerified,
  );
  const runtimeModelSelection = context.runtimeModelSelection;
  const preferredModel = runtimeModelSelection?.modelId ?? config.codex.preferredModel;
  const reasoningEffort = runtimeModelSelection?.reasoningEffort ?? config.codex.reasoningEffort;
  const ownerUsername = (): string => {
    const snapshot = context.ownerIdentity.snapshot();
    if (!snapshot.configured || snapshot.ownerUsername === null) {
      throw new OwnerIdentityError("OWNER_IDENTITY_REQUIRED");
    }
    return snapshot.ownerUsername;
  };
  const confirmations = new ConfirmationStore();
  const safety = new SafetyEngine(confirmations, config.safety, (lease) =>
    taskController.isLeaseLive(lease),
  );
  const minecraft = new MineflayerAdapter(config.minecraft);
  const executor = new ActionExecutor(
    minecraft,
    safety,
    confirmations,
    ownerUsername,
    () => taskController.stop("owner_stop"),
    {
      isLeaseLive: (lease) => taskController.isLeaseLive(lease),
      reserveAdditionalTravel: (lease, horizontalTravel) =>
        taskController.reserveAdditionalTravel(lease, horizontalTravel),
    },
  );
  const legacyMemories = new MemoryStore(paths.memories);
  const memories = new ScopedMemoryStore(`${paths.memories}.scoped.json`);
  const memoryMigration = new MemoryMigration(undefined, memories, { legacy: legacyMemories });
  const state = new StateStore(paths.state);
  const codex =
    sharedCodexClient ??
    new CodexAppServerClient(config, {
      runLoginStatus: (signal) =>
        runCodexLoginStatus(context.codexLaunchConfig, 10_000, undefined, signal),
      createTransport: async () => spawnCodexAppServerTransport(context.codexLaunchConfig),
      workspacePath: paths.codexWorkspace,
    });
  codex.configureRuntime({
    workspacePath: paths.codexWorkspace,
    reasoningEffort,
  });
  const trustedSnapshots = createTrustedSnapshotStore();
  const safetyContextProvider = createTrustedSafetyContextProvider(
    minecraft,
    ownerUsername,
    trustedSnapshots,
  );

  let companion: CompanionService | undefined;
  const autonomy = new AutonomyScheduler({
    mode,
    minecraft,
    ownerUsername,
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
    memoryMigration,
    state,
    confirmations,
    executor,
    budget,
    taskController,
    autonomy,
    safetyContextProvider,
    ownerUsername,
    ownerIdentity: context.ownerIdentity,
    chatRouter: new ChatRouter({
      ownerUsername,
      maxMessageLength: 4_000,
    }),
    cwd: paths.cwd,
    preferredModel,
    reasoningEffort,
    onAuthorityLost: context.reportAuthorityLoss,
    requestedTaskLimits: effectiveWorldSafety.taskLimits,
    compatibilityVerified: () => context.worldSafety.compatibilityVerified,
    safetyPresetAllows: () =>
      effectiveWorldSafety.preset === "standard" && context.worldSafety.compatibilityVerified,
    logger,
  });
  const toolDependencies: ToolRegistryDependencies = {
    minecraft,
    executor,
    budget,
    safetyContextProvider,
    ownerUsername,
    latestSnapshot: trustedSnapshots.latest,
    observeSnapshot: trustedSnapshots.publish,
  };

  return {
    preferredModel,
    mcp: new McpLifecycle(toolDependencies),
    codex,
    selectModel,
    minecraft,
    companion,
    executor,
    taskProjection: {
      status: () => {
        const active = taskController.current();
        if (active === null) return "running";
        return confirmations.hasGameActions(active.lease) ? "waiting_confirmation" : "running";
      },
      subscribe: (listener) => confirmations.onGameActionsChanged(listener),
    },
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
      await Promise.resolve()
        .then(() => this.#hooks.afterCleanup?.())
        .catch(() => undefined);
      this.#state = "terminal";
      if (this.#attempt === attempt) this.#attempt = undefined;
      throw error;
    }
  }

  async #stopInternal(attempt: StartupAttempt | undefined): Promise<void> {
    let cleanupError: unknown;
    try {
      this.#hooks.beforeStopCleanup?.();
    } catch {
      // Task invalidation failures cannot block the remaining safety cleanup.
    }
    if (attempt) {
      try {
        await this.#queueCleanup(attempt);
      } catch (error) {
        cleanupError = error;
      }
    }
    await Promise.resolve()
      .then(() => this.#hooks.afterCleanup?.())
      .catch(() => undefined);
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
    await Promise.resolve()
      .then(() => this.#hooks.afterCleanup?.())
      .catch(() => undefined);
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
  const authorityLossListeners = new Set<(event: RuntimeAuthorityLoss) => void>();
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
    authorityLost: (event) => {
      for (const listener of [...authorityLossListeners]) {
        try {
          listener(event);
        } catch {
          // Runtime authority observers cannot block production recovery containment.
        }
      }
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
    ...(options.runtimeInitialRevision === undefined
      ? {}
      : { initialRevision: options.runtimeInitialRevision }),
    lifecycle: composition.lifecycle,
    task: {
      current: () => composition.taskController.current(),
      budget: () => composition.taskBudget.snapshot(),
      status: () => composition.runtime.taskProjection?.status() ?? "running",
      stop: (reason) => composition.taskController.stop(reason),
      failClosed: () => composition.taskController.failClosed(),
      subscribe: (listener) => {
        taskListeners.add(listener);
        const unsubscribeProjection = composition.runtime.taskProjection?.subscribe(listener);
        return () => {
          taskListeners.delete(listener);
          unsubscribeProjection?.();
        };
      },
    },
    ...(minecraft ? { minecraft } : {}),
    codex: { model: () => selectedModel },
    authority: {
      subscribe: (listener) => {
        authorityLossListeners.add(listener);
        return () => authorityLossListeners.delete(listener);
      },
    },
    profile: {
      apply: (profile) => {
        const applyProfile = composition.runtime.companion.applyProfile;
        if (applyProfile) {
          applyProfile.call(composition.runtime.companion, profile);
          return;
        }
        composition.mode.applyProfile(profile);
      },
    },
    memory: {
      setScope: (scope) => composition.runtime.companion.setMemoryScope?.(scope),
    },
  });
}

async function composeApp(
  configPath: string,
  options: CreateAppOptions,
  observers: RuntimeCompositionObservers = {},
): Promise<ComposedApp> {
  const paths = resolveCoreAppPaths(configPath, {
    cwd: options.cwd ?? process.cwd(),
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
  });
  const ownerIdentity = options.ownerIdentity ?? (await OwnerIdentityService.open(paths.config));
  const initialOwner = ownerIdentity.snapshot();
  if (!initialOwner.configured || initialOwner.ownerUsername === null) {
    throw new OwnerIdentityError("OWNER_IDENTITY_REQUIRED");
  }
  const config = await loadConfig(paths.config, options.confirmedMinecraftConnection);
  await initializeStorage(paths);
  const activeProfile = await new ProfileStore({ rootDirectory: paths.profiles }).read();
  const taskBudget = new TaskControllerBudget();
  const logger = new SafeLogger(paths.log);
  const audit = new AuditLogger(paths.audit);
  const taskAudit = new PersistentTaskAudit(logger, audit, taskBudget);
  const taskController = new TaskController(
    taskBudget,
    (event, data) => {
      try {
        observers.taskChanged?.();
      } finally {
        taskAudit.record(event, data);
      }
    },
    {
      ownerIdentityRevision: () => ownerIdentity.snapshot().revision,
    },
  );
  const context: AppCompositionContext = {
    config,
    codexLaunchConfig:
      options.codexResourceDirectory === undefined
        ? resolveDefaultCodexLaunchConfig(paths.dataRoot)
        : createBundledCodexLaunchConfig(
            options.codexResourceDirectory,
            paths.dataRoot,
            process.platform,
          ),
    ...(options.runtimeModelSelection
      ? { runtimeModelSelection: options.runtimeModelSelection }
      : {}),
    paths,
    mode: new ModeManager(activeProfile.value),
    budget: new TurnToolBudget(taskBudget),
    taskController,
    ownerIdentity,
    logger,
    reportAuthorityLoss: (event) => observers.authorityLost?.(event),
    worldSafety: options.worldSafety ?? { compatibilityVerified: false },
  };
  const runtime = await (
    options.runtimeFactory ??
    ((productionContext: AppCompositionContext) =>
      createProductionRuntime(productionContext, options.codexClient))
  )(context);
  let observedOwnerRevision = ownerIdentity.snapshot().revision;
  const unsubscribeOwner = ownerIdentity.subscribe((snapshot) => {
    if (snapshot.revision === observedOwnerRevision) return;
    observedOwnerRevision = snapshot.revision;
    taskController.stop("owner_changed");
    runtime.companion.ownerIdentityChanged?.(snapshot);
  });
  const selectedRuntimeModel = options.runtimeModelSelection;
  const runtimeForSelection: AppRuntime = selectedRuntimeModel
    ? {
        preferredModel: selectedRuntimeModel.modelId,
        mcp: runtime.mcp,
        codex: runtime.codex,
        selectModel: (available) => {
          if (!available.includes(selectedRuntimeModel.modelId)) {
            throw new Error("Selected live model is unavailable");
          }
          return selectedRuntimeModel.modelId;
        },
        minecraft: runtime.minecraft,
        companion: runtime.companion,
        executor: runtime.executor,
      }
    : runtime;
  const lifecycleRuntime: AppRuntime = observers.modelSelected
    ? {
        preferredModel: runtimeForSelection.preferredModel,
        mcp: runtimeForSelection.mcp,
        codex: runtimeForSelection.codex,
        selectModel: async (available, preferred) => {
          const model = await runtimeForSelection.selectModel(available, preferred);
          observers.modelSelected?.(model);
          return model;
        },
        minecraft: runtimeForSelection.minecraft,
        companion: runtimeForSelection.companion,
        executor: runtimeForSelection.executor,
      }
    : runtimeForSelection;
  return {
    lifecycle: new WhiteLilyAppLifecycle(lifecycleRuntime, {
      ...(observers.invalidateTaskBeforeStartupCleanup
        ? {
            beforeStartupCleanup: () => taskController.stop("failed"),
          }
        : {}),
      beforeStopCleanup: () => taskController.stop("process_exit"),
      afterCleanup: async () => {
        unsubscribeOwner();
        await taskAudit.flush();
      },
    }),
    runtime,
    taskBudget,
    taskController,
    mode: context.mode,
  };
}
