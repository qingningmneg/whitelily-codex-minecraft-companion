import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  createRuntimeFacade,
  McpLifecycle,
  WhiteLilyAppLifecycle,
  type AppCompositionContext,
  type AppPaths,
  type OwnerIdentityProvider,
} from "../../src/app.js";
import { ActionExecutor } from "../../src/actions/actionExecutor.js";
import { CompanionActionQueue } from "../../src/actions/actionQueue.js";
import { QueuedActionRunner } from "../../src/actions/queuedActionRunner.js";
import { CodexAppServerClient } from "../../src/codex/appServerClient.js";
import type { CodexPort, CodexTurnResult } from "../../src/codex/codexPort.js";
import { ChatRouter } from "../../src/companion/chatRouter.js";
import { CompanionService } from "../../src/companion/companionService.js";
import type { AppConfig } from "../../src/config/schema.js";
import { isMainModule, runCli, type CliDependencies } from "../../src/index.js";
import { TurnToolBudget } from "../../src/mcp/toolBudget.js";
import { startMcpServer, type RunningMcpServer } from "../../src/mcp/mcpServer.js";
import { verifyMinecraftMcp, type McpReadinessSnapshot } from "../../src/mcp/mcpReadiness.js";
import {
  createToolRegistry,
  createTrustedSnapshotStore,
  MINECRAFT_EXECUTION_TOOL_NAMES,
  MINECRAFT_TOOL_NAMES,
  type ToolResult,
} from "../../src/mcp/toolRegistry.js";
import { FakeMinecraftPort } from "../../src/minecraft/fakeMinecraftPort.js";
import { MemoryStore } from "../../src/memory/memoryStore.js";
import { StateStore } from "../../src/memory/stateStore.js";
import { ConfirmationStore } from "../../src/safety/confirmationStore.js";
import { SafetyEngine } from "../../src/safety/safetyEngine.js";
import { createCompanionHarness } from "../support/companionHarness.js";
import { TaskController } from "../../src/companion/taskController.js";
import { TaskControllerBudget } from "../../src/safety/taskBudget.js";
import { ProfileStore } from "../../src/profile/profileStore.js";
import { FarmingPreferenceStore } from "../../src/profile/farmingPreferenceStore.js";
import { createJsonRpcLineTransportHarness } from "../support/jsonRpcProcessHarness.js";
import type { OwnerIdentitySnapshot } from "../../src/identity/ownerIdentity.js";
import { provisionCodexWorkspace } from "../../apps/desktop/src-main/codexWorkspaceProvisioner.js";
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

async function createAttestedWorkspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "whitelily-real-action-workspace-"));
  const resourceDirectory = join(root, "resources", "codex-workspace");
  const dataRoot = join(root, "data");
  await Promise.all([
    mkdir(join(resourceDirectory, ".codex"), { recursive: true }),
    mkdir(dataRoot),
  ]);
  const payloads = [
    [".codex/config.toml", await readFile("codex-workspace/.codex/config.toml")],
    ["AGENTS.md", await readFile("codex-workspace/AGENTS.md")],
  ] as const;
  for (const [portablePath, bytes] of payloads) {
    await writeFile(join(resourceDirectory, ...portablePath.split("/")), bytes);
  }
  await writeFile(
    join(resourceDirectory, "workspace-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        contentVersion: "task-6-real-mcp",
        files: payloads.map(([path, bytes]) => ({
          path,
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { root, resourceDirectory, dataRoot };
}

interface AuditDeferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function auditDeferred<T>(): AuditDeferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class PersistentAuditCodex implements CodexPort {
  private threadCount = 0;
  private turnCount = 0;
  private readonly execution = auditDeferred<CodexTurnResult>();

  constructor(private readonly intentDecision: string) {}

  async start(): Promise<void> {}

  async listModels(): Promise<string[]> {
    return ["gpt-5.6-terra"];
  }

  async validateModelSelection(): Promise<boolean> {
    return true;
  }

  async startThread(): Promise<string> {
    this.threadCount += 1;
    return this.threadCount === 1 ? "persistent-audit-intent" : "persistent-audit-execution";
  }

  async sendTurn(
    threadId: string,
    _text: string,
    onStarted?: (turnId: string) => void,
  ): Promise<CodexTurnResult> {
    const turnId = `persistent-audit-turn-${++this.turnCount}`;
    onStarted?.(turnId);
    if (threadId === "persistent-audit-intent") {
      return {
        threadId,
        turnId,
        text: this.intentDecision,
        status: "completed",
      };
    }
    return this.execution.promise;
  }

  releaseExecution(reply: string): void {
    this.execution.resolve({
      threadId: "persistent-audit-execution",
      turnId: `persistent-audit-turn-${this.turnCount}`,
      text: JSON.stringify({ reply, status: "completed", memoryCandidates: [] }),
      status: "completed",
    });
  }

  async interrupt(): Promise<void> {}

  async closeThread(): Promise<void> {}

  async stop(): Promise<void> {}
}

interface PersistedTaskAuditRecord {
  readonly kind: string;
  readonly detail: {
    readonly expectedActionCategoryCount: number;
    readonly toolCalls: number;
    readonly horizontalTravel: number;
    readonly reason?: string;
  };
}

type PersistedActionScenario =
  | { readonly kind: "position"; readonly ownerText: "查看一下你现在的位置" }
  | { readonly kind: "follow"; readonly ownerText: "走到我身边来" };

async function runPersistedActionScenario(scenario: PersistedActionScenario) {
  const files = await createCliHarness();
  const decision = JSON.stringify({
    kind: "start_task",
    naturalReply: null,
    task: {
      goal: scenario.kind === "position" ? "查看当前位置" : "走到主人身边",
      allowedActions: scenario.kind === "position" ? ["get_state"] : ["follow_owner", "move_to"],
      requestedLimits:
        scenario.kind === "position"
          ? { maxToolCalls: 2 }
          : { maxToolCalls: 2, maxHorizontalTravel: 16 },
    },
    memoryCandidates: [],
  });
  const codex = new PersistentAuditCodex(decision);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let context: AppCompositionContext | undefined;
  let minecraft: FakeMinecraftPort | undefined;
  let toolResult: ToolResult | undefined;
  let executeScenarioTool: (() => Promise<ToolResult>) | undefined;
  let turnLease: string | undefined;
  let turnBudget: ReturnType<AppCompositionContext["budget"]["snapshot"]> | undefined;
  const executorResults: unknown[] = [];

  try {
    app = await createApp(files.configPath, {
      cwd: files.directory,
      runtimeFactory: (createdContext) => {
        context = createdContext;
        minecraft = new FakeMinecraftPort();
        minecraft.ownerOnline = true;
        if (scenario.kind === "follow") {
          minecraft.world.ownerPosition = { x: 6, y: 64, z: 0 };
        }
        const confirmations = new ConfirmationStore();
        const executor = new ActionExecutor(
          minecraft,
          new SafetyEngine(confirmations, createdContext.config.safety, (lease) =>
            createdContext.taskController.isLeaseLive(lease),
          ),
          confirmations,
          () => "TestOwner",
          () => createdContext.taskController.stop("owner_stop"),
          {
            isLeaseLive: (lease) => createdContext.taskController.isLeaseLive(lease),
            reserveAdditionalTravel: (lease, horizontalTravel) =>
              createdContext.taskController.reserveAdditionalTravel(lease, horizontalTravel),
          },
        );
        executor.onResult((result) => executorResults.push(result));
        const safetyContextProvider = async () => ({
          spawn: { x: 0, y: 64, z: 0 },
          owner: { ...(minecraft?.world.ownerPosition ?? { x: 0, y: 64, z: 0 }) },
        });
        const actionQueue = new CompanionActionQueue({
          createId: (() => {
            let next = 0;
            return () => `queue-${++next}`;
          })(),
          now: () => new Date(),
        });
        let service!: CompanionService;
        const actionRunner = new QueuedActionRunner({
          queue: actionQueue,
          executor,
          executionContext: () => service?.queueExecutionContext() ?? null,
          safetyContextProvider,
        });
        service = new CompanionService({
          minecraft,
          codex,
          mode: createdContext.mode,
          memories: new MemoryStore(createdContext.paths.memories),
          state: new StateStore(createdContext.paths.state),
          confirmations,
          executor,
          actionQueue,
          actionRunner,
          farmingPreference: createdContext.farmingPreference,
          budget: createdContext.budget,
          taskController: createdContext.taskController,
          autonomy: {
            start: () => undefined,
            stop: () => undefined,
            notifyModeChanged: () => undefined,
            notifyGoalCompleted: () => undefined,
            notifyActionFailed: () => undefined,
            notifyThreat: () => undefined,
            canChatProactively: () => false,
            canSendProactively: () => false,
            markProactiveChat: () => undefined,
          },
          safetyContextProvider,
          ownerUsername: () => "TestOwner",
          ownerIdentity: createdContext.ownerIdentity,
          chatRouter: new ChatRouter({ ownerUsername: () => "TestOwner", maxMessageLength: 4_000 }),
          cwd: createdContext.paths.cwd,
          preferredModel: "gpt-5.6-terra",
          reasoningEffort: "low",
          logger: createdContext.logger,
          compatibilityVerified: () => true,
          safetyPresetAllows: () => true,
          setTimer: (callback) => {
            queueMicrotask(callback);
            return 1 as unknown as ReturnType<typeof setTimeout>;
          },
          clearTimer: () => undefined,
        });
        const tools = createToolRegistry({
          minecraft,
          executor,
          budget: createdContext.budget,
          safetyContextProvider,
          ownerUsername: () => "TestOwner",
          actionQueue,
          worldGeneration: () => service.queueExecutionContext()?.worldGeneration ?? 0,
        });
        const begin = createdContext.budget.begin.bind(createdContext.budget);
        createdContext.budget.begin = (taskLease, authorization = {}) => {
          turnLease = begin(taskLease, authorization);
          return turnLease;
        };
        executeScenarioTool = async () => {
          if (!turnLease) throw new Error("expected a production turn lease");
          if (scenario.kind === "position") {
            return tools.minecraft_get_state.execute({ turnLease });
          }
          return tools.minecraft_follow_owner.execute({ distance: 3, turnLease });
        };
        return {
          preferredModel: "gpt-5.6-terra",
          mcp: { start: async () => undefined, stop: async () => undefined },
          codex: {
            assertChatGptLogin: async () => undefined,
            start: () => codex.start(),
            listModels: () => codex.listModels(),
            stop: () => codex.stop(),
          },
          selectModel: (_models, preferred) => preferred,
          switchModel: async (_selection, commitPreference) => commitPreference(),
          minecraft,
          companion: service,
          executor,
        };
      },
    });
    await app.start();
    minecraft!.emit({ kind: "chat", username: "TestOwner", message: scenario.ownerText });
    await vi.waitFor(() => {
      expect(context?.taskController.current()).not.toBeNull();
      expect(turnLease).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    });
    if (!executeScenarioTool) throw new Error("scenario tool was not composed");
    toolResult = await executeScenarioTool();
    turnBudget = context!.budget.snapshot();
    codex.releaseExecution(scenario.kind === "position" ? "位置已确认" : "已到达");
    await vi.waitFor(() => expect(context?.taskController.current()).toBeNull());
    await app.stop();

    const auditRecords = (await readFile(context!.paths.audit, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PersistedTaskAuditRecord);
    return {
      auditRecords,
      executorResults,
      minecraftCalls: [...minecraft!.calls],
      toolResult,
      turnBudget,
    };
  } finally {
    await app?.stop().catch(() => undefined);
    await files.cleanup();
  }
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("WhiteLilyApp composition", () => {
  it("provisions the attested workspace and creates both Codex threads only after real MCP discovery", async () => {
    const fixture = await createAttestedWorkspaceFixture();
    cleanups.push(() => rm(fixture.root, { recursive: true, force: true }));
    const provisioned = await provisionCodexWorkspace(fixture);
    const events: string[] = [];
    const minecraft = new FakeMinecraftPort();
    minecraft.ownerOnline = true;
    const taskBudget = new TaskControllerBudget();
    const taskController = new TaskController(taskBudget);
    const turnBudget = new TurnToolBudget(taskBudget);
    const confirmations = new ConfirmationStore();
    const executor = new ActionExecutor(
      minecraft,
      new SafetyEngine(confirmations, undefined, (lease) => taskController.isLeaseLive(lease)),
      confirmations,
      () => "TestOwner",
    );
    const actionQueue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const mcp = new McpLifecycle(
      {
        minecraft,
        executor,
        budget: turnBudget,
        safetyContextProvider: async () => ({
          spawn: { x: 0, y: 64, z: 0 },
          owner: { x: 0, y: 64, z: 0 },
        }),
        ownerUsername: () => "TestOwner",
        actionQueue,
        worldGeneration: () => 0,
      },
      {
        workspaceVersion: provisioned.contentVersion,
        startServer: async (options) => {
          const server = await startMcpServer({ ...options, port: 0 });
          events.push("mcp:listening");
          return server;
        },
        verify: async (options) => {
          const snapshot = await verifyMinecraftMcp(options);
          if (snapshot.state === "ready") events.push("mcp:tools/list:ready");
          return snapshot;
        },
      },
    );
    const transport = createJsonRpcLineTransportHarness();
    const codex = new CodexAppServerClient(realCodexConfig, {
      runLoginStatus: async () => ({
        stdout: "Logged in using ChatGPT\n",
        stderr: "",
        exitCode: 0,
      }),
      createTransport: async () => transport.transport,
      workspacePath: provisioned.targetDirectory,
    });
    codex.configureRuntime({ workspacePath: provisioned.targetDirectory, reasoningEffort: "low" });
    const threadIds: string[] = [];
    const app = new WhiteLilyAppLifecycle({
      preferredModel: "gpt-5.6-terra",
      minecraft: {
        connect: async () => {
          events.push("minecraft:connected");
        },
        disconnect: async () => {
          events.push("minecraft:disconnected");
        },
      },
      mcp,
      codex,
      selectModel: (models, preferred) => {
        if (!models.includes(preferred)) throw new Error("preferred model unavailable");
        return preferred;
      },
      switchModel: async (_selection, commitPreference) => commitPreference(),
      companion: {
        start: async (model) => {
          for (const role of ["intent", "execution"] as const) {
            events.push(`thread:${role}:requested`);
            threadIds.push(
              await codex.startThread({
                cwd: "C:/caller-must-not-win",
                model,
                reasoningEffort: "low",
              }),
            );
          }
        },
        switchModel: async (_selection, commitPreference) => commitPreference(),
        stop: async () => undefined,
      },
      executor,
    });

    try {
      const starting = app.start();
      const initialize = await transport.nextSent();
      expect(events).toContain("mcp:tools/list:ready");
      expect(initialize).toMatchObject({ id: 1, method: "initialize" });
      transport.receive({
        id: 1,
        result: {
          userAgent: "codex/0.145.0",
          codexHome: "D:/codex-home",
          platformFamily: "windows",
          platformOs: "windows",
        },
      });
      await transport.nextSent();
      await expect(transport.nextSent()).resolves.toEqual({
        id: 2,
        method: "model/list",
        params: {},
      });
      transport.receive({
        id: 2,
        result: { data: [{ model: "gpt-5.6-terra" }], nextCursor: null },
      });
      for (const [id, role] of [
        [3, "intent"],
        [4, "execution"],
      ] as const) {
        const request = await transport.nextSent();
        expect(events.indexOf("mcp:tools/list:ready")).toBeLessThan(
          events.indexOf(`thread:${role}:requested`),
        );
        expect(request).toEqual({
          id,
          method: "thread/start",
          params: {
            model: "gpt-5.6-terra",
            cwd: provisioned.targetDirectory,
            sandbox: "read-only",
            approvalPolicy: "never",
          },
        });
        transport.receive({ id, result: { thread: { id: `thread-${role}` } } });
      }
      await starting;

      expect(threadIds).toEqual(["thread-intent", "thread-execution"]);
      await expect(readFile(join(provisioned.targetDirectory, "AGENTS.md"), "utf8")).resolves.toBe(
        await readFile("codex-workspace/AGENTS.md", "utf8"),
      );
      await expect(
        readFile(join(provisioned.targetDirectory, ".codex", "config.toml"), "utf8"),
      ).resolves.toContain('url = "http://127.0.0.1:32123/mcp"');
      expect(mcp.snapshot()).toEqual({
        state: "ready",
        workspaceVersion: "task-6-real-mcp",
        mcpListening: true,
        discoveredToolCount: MINECRAFT_TOOL_NAMES.length,
      });
    } finally {
      await app.stop();
    }
  });

  it.each([
    {
      label: "port conflict",
      expectedCode: "port_conflict",
      startError: Object.assign(new Error("busy"), { code: "EADDRINUSE" }),
    },
    {
      label: "probe timeout",
      expectedCode: "timeout",
      readiness: {
        state: "failed",
        listening: true,
        discoveredToolCount: 0,
        errorCode: "timeout",
      } satisfies McpReadinessSnapshot,
    },
    {
      label: "missing tool",
      expectedCode: "missing_tools",
      readiness: {
        state: "failed",
        listening: true,
        discoveredToolCount: 14,
        errorCode: "missing_tools",
      } satisfies McpReadinessSnapshot,
    },
    {
      label: "extra tool",
      expectedCode: "extra_tools",
      readiness: {
        state: "failed",
        listening: true,
        discoveredToolCount: 16,
        errorCode: "extra_tools",
      } satisfies McpReadinessSnapshot,
    },
    {
      label: "probe exception",
      expectedCode: "connection_failed",
      verifyError: new Error("private probe failure"),
    },
  ])(
    "gates all Codex and task startup on $label action readiness failure",
    async ({ expectedCode, startError, readiness, verifyError }) => {
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const serverStop = vi.fn(async () => {
        resolveClosed();
      });
      const server: RunningMcpServer = {
        host: "127.0.0.1",
        port: 32123,
        url: "http://127.0.0.1:32123/mcp",
        closed,
        stop: serverStop,
      };
      const actionStates: unknown[] = [];
      const lifecycleEvents: string[] = [];
      const assertChatGptLogin = vi.fn(async () => undefined);
      const codexStart = vi.fn(async () => undefined);
      const listModels = vi.fn(async () => ["gpt-5.6-terra"]);
      const selectModel = vi.fn(() => "gpt-5.6-terra");
      const startThread = vi.fn(async () => "thread-should-not-start");
      const companionStart = vi.fn(async () => undefined);
      const taskAudit = vi.fn();
      const taskController = new TaskController(undefined, taskAudit, {
        setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimer: () => undefined,
      });
      const mcp = new McpLifecycle({} as never, {
        workspaceVersion: "workspace-1",
        startServer: async () => {
          if (startError) throw startError;
          return server;
        },
        verify: async () => {
          if (verifyError) throw verifyError;
          return readiness!;
        },
      });
      mcp.subscribe((snapshot) => actionStates.push(snapshot));
      const app = new WhiteLilyAppLifecycle({
        preferredModel: "gpt-5.6-terra",
        minecraft: {
          connect: async () => {
            lifecycleEvents.push("minecraft:connect");
          },
          disconnect: async () => {
            lifecycleEvents.push("minecraft:disconnect");
          },
        },
        mcp: {
          start: () => mcp.start(),
          stop: async () => {
            lifecycleEvents.push("mcp:stop");
            await mcp.stop();
          },
        },
        codex: {
          assertChatGptLogin,
          start: codexStart,
          listModels,
          stop: async () => {
            lifecycleEvents.push("codex:stop");
          },
        },
        selectModel,
        switchModel: async (_selection, commitPreference) => commitPreference(),
        companion: {
          start: async () => {
            await companionStart();
            await startThread();
            taskController.start({
              goal: "must remain unaccepted while actions are unavailable",
              expectedActions: ["move_to"],
              limits: {
                maxToolCalls: 1,
                maxBlockChanges: 0,
                maxHorizontalTravel: 1,
                maxDurationMs: 1_000,
                maxDangerousOperations: 0,
              },
              stopCondition: "action capability is unavailable",
            });
          },
          switchModel: async (_selection, commitPreference) => commitPreference(),
          stop: async () => {
            lifecycleEvents.push("companion:stop");
          },
        },
        executor: { stopAll: () => undefined },
      });

      await expect(app.start()).rejects.toMatchObject({
        name: "ActionCapabilityError",
        code: expectedCode,
      });

      expect(assertChatGptLogin).not.toHaveBeenCalled();
      expect(codexStart).not.toHaveBeenCalled();
      expect(listModels).not.toHaveBeenCalled();
      expect(selectModel).not.toHaveBeenCalled();
      expect(companionStart).not.toHaveBeenCalled();
      expect(startThread).not.toHaveBeenCalled();
      expect(taskAudit).not.toHaveBeenCalled();
      expect(taskController.current()).toBeNull();
      expect(lifecycleEvents).toEqual(["minecraft:connect", "mcp:stop", "minecraft:disconnect"]);
      expect(actionStates).toEqual([
        { state: "starting", workspaceVersion: "workspace-1" },
        expect.objectContaining({ state: "failed", errorCode: expectedCode }),
        null,
      ]);
      expect(serverStop).toHaveBeenCalledTimes(startError ? 0 : 1);
    },
  );

  it("rejects a server close before readiness without reviving Codex or task authority", async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let resolveReadiness!: (snapshot: McpReadinessSnapshot) => void;
    const readiness = new Promise<McpReadinessSnapshot>((resolve) => {
      resolveReadiness = resolve;
    });
    const serverStop = vi.fn(async () => {
      resolveClosed();
    });
    const server: RunningMcpServer = {
      host: "127.0.0.1",
      port: 32123,
      url: "http://127.0.0.1:32123/mcp",
      closed,
      stop: serverStop,
    };
    const verify = vi.fn(async () => readiness);
    const actionStates: unknown[] = [];
    const assertChatGptLogin = vi.fn(async () => undefined);
    const codexStart = vi.fn(async () => undefined);
    const listModels = vi.fn(async () => ["gpt-5.6-terra"]);
    const selectModel = vi.fn(() => "gpt-5.6-terra");
    const startThread = vi.fn(async () => "thread-should-not-start");
    const companionStart = vi.fn(async () => undefined);
    const taskAudit = vi.fn();
    const taskController = new TaskController(undefined, taskAudit, {
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    const actionUnavailable = vi.fn();
    const authorityLost = vi.fn();
    const lifecycleEvents: string[] = [];
    const mcp = new McpLifecycle({} as never, {
      workspaceVersion: "workspace-1",
      startServer: async () => server,
      verify,
      onActionUnavailable: actionUnavailable,
      reportAuthorityLoss: authorityLost,
    });
    mcp.subscribe((snapshot) => actionStates.push(snapshot));
    const app = new WhiteLilyAppLifecycle({
      preferredModel: "gpt-5.6-terra",
      minecraft: {
        connect: async () => {
          lifecycleEvents.push("minecraft:connect");
        },
        disconnect: async () => {
          lifecycleEvents.push("minecraft:disconnect");
        },
      },
      mcp: {
        start: () => mcp.start(),
        stop: async () => {
          lifecycleEvents.push("mcp:stop");
          await mcp.stop();
        },
      },
      codex: {
        assertChatGptLogin,
        start: codexStart,
        listModels,
        stop: async () => {
          lifecycleEvents.push("codex:stop");
        },
      },
      selectModel,
      switchModel: async (_selection, commitPreference) => commitPreference(),
      companion: {
        start: async () => {
          await companionStart();
          await startThread();
          taskController.start({
            goal: "must not be accepted after a pre-ready close",
            expectedActions: ["move_to"],
            limits: {
              maxToolCalls: 1,
              maxBlockChanges: 0,
              maxHorizontalTravel: 1,
              maxDurationMs: 1_000,
              maxDangerousOperations: 0,
            },
            stopCondition: "the action server closes",
          });
        },
        switchModel: async (_selection, commitPreference) => commitPreference(),
        stop: async () => {
          lifecycleEvents.push("companion:stop");
        },
      },
      executor: { stopAll: () => undefined },
    });

    const starting = app.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    expect(mcp.snapshot()).toEqual({ state: "starting", workspaceVersion: "workspace-1" });

    resolveClosed();
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    resolveReadiness({
      state: "ready",
      listening: true,
      discoveredToolCount: 15,
      errorCode: null,
    });

    await expect(starting).resolves.toMatchObject({
      name: "ActionCapabilityError",
      code: "server_closed",
    });
    expect(actionStates).not.toContainEqual(expect.objectContaining({ state: "ready" }));
    expect(assertChatGptLogin).not.toHaveBeenCalled();
    expect(codexStart).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    expect(selectModel).not.toHaveBeenCalled();
    expect(companionStart).not.toHaveBeenCalled();
    expect(startThread).not.toHaveBeenCalled();
    expect(taskAudit).not.toHaveBeenCalled();
    expect(taskController.current()).toBeNull();
    expect(actionUnavailable).not.toHaveBeenCalled();
    expect(authorityLost).not.toHaveBeenCalled();
    expect(serverStop).toHaveBeenCalledTimes(1);
    expect(lifecycleEvents).toEqual(["minecraft:connect", "mcp:stop", "minecraft:disconnect"]);
  });

  it("makes concurrent MCP starts await one deferred successful readiness operation", async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let resolveReadiness!: (snapshot: McpReadinessSnapshot) => void;
    const readiness = new Promise<McpReadinessSnapshot>((resolve) => {
      resolveReadiness = resolve;
    });
    const serverStop = vi.fn(async () => {
      resolveClosed();
    });
    const startServer = vi.fn(async (): Promise<RunningMcpServer> => ({
      host: "127.0.0.1",
      port: 32123,
      url: "http://127.0.0.1:32123/mcp",
      closed,
      stop: serverStop,
    }));
    const verify = vi.fn(async () => readiness);
    const mcp = new McpLifecycle({} as never, {
      workspaceVersion: "workspace-1",
      startServer,
      verify,
    });

    const first = mcp.start();
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    let secondSettled = false;
    const second = mcp.start().then(() => {
      secondSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);

    resolveReadiness({
      state: "ready",
      listening: true,
      discoveredToolCount: 15,
      errorCode: null,
    });
    await Promise.all([first, second]);

    expect(startServer).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(mcp.snapshot()).toEqual({
      state: "ready",
      workspaceVersion: "workspace-1",
      mcpListening: true,
      discoveredToolCount: 15,
    });
    await mcp.stop();
    expect(serverStop).toHaveBeenCalledTimes(1);
  });

  it("makes concurrent MCP starts reject with the same deferred readiness failure", async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let resolveReadiness!: (snapshot: McpReadinessSnapshot) => void;
    const readiness = new Promise<McpReadinessSnapshot>((resolve) => {
      resolveReadiness = resolve;
    });
    const serverStop = vi.fn(async () => {
      resolveClosed();
    });
    const startServer = vi.fn(async (): Promise<RunningMcpServer> => ({
      host: "127.0.0.1",
      port: 32123,
      url: "http://127.0.0.1:32123/mcp",
      closed,
      stop: serverStop,
    }));
    const verify = vi.fn(async () => readiness);
    const mcp = new McpLifecycle({} as never, {
      workspaceVersion: "workspace-1",
      startServer,
      verify,
    });

    const first = mcp.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    let secondSettled = false;
    const second = mcp.start().then(
      () => {
        secondSettled = true;
        return undefined;
      },
      (error: unknown) => {
        secondSettled = true;
        return error;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);

    resolveReadiness({
      state: "failed",
      listening: true,
      discoveredToolCount: 14,
      errorCode: "missing_tools",
    });
    const [firstError, secondError] = await Promise.all([first, second]);

    expect(firstError).toMatchObject({ name: "ActionCapabilityError", code: "missing_tools" });
    expect(secondError).toMatchObject({ name: "ActionCapabilityError", code: "missing_tools" });
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(serverStop).toHaveBeenCalledTimes(1);
  });

  it("treats a stop racing deferred readiness as intentional and cleans the server once", async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let resolveReadiness!: (snapshot: McpReadinessSnapshot) => void;
    const readiness = new Promise<McpReadinessSnapshot>((resolve) => {
      resolveReadiness = resolve;
    });
    const serverStop = vi.fn(async () => {
      resolveClosed();
    });
    const verify = vi.fn(async () => readiness);
    const actionUnavailable = vi.fn();
    const authorityLost = vi.fn();
    const actionStates: unknown[] = [];
    const mcp = new McpLifecycle({} as never, {
      workspaceVersion: "workspace-1",
      startServer: async () => ({
        host: "127.0.0.1",
        port: 32123,
        url: "http://127.0.0.1:32123/mcp",
        closed,
        stop: serverStop,
      }),
      verify,
      onActionUnavailable: actionUnavailable,
      reportAuthorityLoss: authorityLost,
    });
    mcp.subscribe((snapshot) => actionStates.push(snapshot));

    const starting = mcp.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    await mcp.stop();
    resolveReadiness({
      state: "failed",
      listening: true,
      discoveredToolCount: 0,
      errorCode: "timeout",
    });

    await expect(starting).resolves.toMatchObject({
      name: "ActionCapabilityError",
      code: "startup_stopped",
    });
    expect(actionStates).toEqual([{ state: "starting", workspaceVersion: "workspace-1" }, null]);
    expect(serverStop).toHaveBeenCalledTimes(1);
    expect(actionUnavailable).not.toHaveBeenCalled();
    expect(authorityLost).not.toHaveBeenCalled();
  });

  it("reports action authority loss only for an unexpected close after readiness", async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const actionUnavailable = vi.fn(() => {
      throw new Error("private containment observer failed");
    });
    const authorityLost = vi.fn();
    const server: RunningMcpServer = {
      host: "127.0.0.1",
      port: 32123,
      url: "http://127.0.0.1:32123/mcp",
      closed,
      stop: async () => {
        resolveClosed();
      },
    };
    const mcp = new McpLifecycle({} as never, {
      workspaceVersion: "workspace-1",
      startServer: async () => server,
      verify: async () => ({
        state: "ready",
        listening: true,
        discoveredToolCount: 15,
        errorCode: null,
      }),
      onActionUnavailable: actionUnavailable,
      reportAuthorityLoss: authorityLost,
    });

    await mcp.start();
    resolveClosed();
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mcp.snapshot()).toEqual({
      state: "failed",
      workspaceVersion: "workspace-1",
      mcpListening: false,
      discoveredToolCount: 15,
      errorCode: "server_closed",
    });
    expect(actionUnavailable).toHaveBeenCalledTimes(1);
    expect(authorityLost).toHaveBeenCalledWith({ reason: "action_unavailable" });
  });

  it("protects authoritative nonzero and changing world spawn through the real tool chain", async () => {
    const appModule = await import("../../src/app.js");
    const createProvider = (
      appModule as typeof appModule & {
        createTrustedSafetyContextProvider?: (
          minecraft: FakeMinecraftPort,
          ownerUsername: () => string,
          snapshots: ReturnType<typeof createTrustedSnapshotStore>,
          wheatFarmingAllowed?: () => boolean,
        ) => () => Promise<{
          spawn?: { x: number; y: number; z: number };
          owner: { x: number; y: number; z: number };
          wheatFarmingAllowed?: boolean;
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
    let farmingAllowed = true;
    const safetyContextProvider = createProvider(
      minecraft,
      () => "TestOwner",
      snapshots,
      () => farmingAllowed,
    );
    await expect(safetyContextProvider()).resolves.toMatchObject({
      wheatFarmingAllowed: true,
    });
    farmingAllowed = false;
    await expect(safetyContextProvider()).resolves.toMatchObject({
      wheatFarmingAllowed: false,
    });
    const confirmations = new ConfirmationStore();
    const executor = new ActionExecutor(
      minecraft,
      new SafetyEngine(confirmations),
      confirmations,
      () => "TestOwner",
    );
    const budget = new TurnToolBudget();
    const firstLease = budget.begin();
    const actionQueue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const tools = createToolRegistry({
      minecraft,
      executor,
      budget,
      safetyContextProvider,
      ownerUsername: () => "TestOwner",
      latestSnapshot: snapshots.latest,
      observeSnapshot: snapshots.publish,
      actionQueue,
      worldGeneration: () => 0,
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
      "minecraft:connect",
      "mcp:start",
      "codex:auth-check",
      "codex:start",
      "codex:model-list",
      "codex:model-select:gpt-5.6-terra",
      "companion:start:gpt-5.6-terra",
    ]);

    await harness.app.stop();
    expect(harness.events.slice(-5)).toEqual([
      "companion:stop",
      "actions:stop",
      "codex:stop",
      "mcp:stop",
      "minecraft:disconnect",
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
    expect(harness.events).toEqual([
      "minecraft:connect",
      "minecraft:disconnect",
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
    expect(harness.events).toContain("minecraft:connect");
    expect(harness.events).toContain("minecraft:disconnect");
    expect(harness.events).not.toContain("companion:start:gpt-5.6-terra");
  });

  it.each<{
    boundary: StartupBoundary;
    expected: string[];
  }>([
    {
      boundary: "mcp",
      expected: ["minecraft:connect", "mcp:start", "mcp:stop", "minecraft:disconnect"],
    },
    {
      boundary: "auth",
      expected: [
        "minecraft:connect",
        "mcp:start",
        "codex:auth-check",
        "codex:stop",
        "mcp:stop",
        "minecraft:disconnect",
      ],
    },
    {
      boundary: "codex",
      expected: [
        "minecraft:connect",
        "mcp:start",
        "codex:auth-check",
        "codex:start",
        "codex:stop",
        "mcp:stop",
        "minecraft:disconnect",
      ],
    },
    {
      boundary: "models",
      expected: [
        "minecraft:connect",
        "mcp:start",
        "codex:auth-check",
        "codex:start",
        "codex:model-list",
        "codex:stop",
        "mcp:stop",
        "minecraft:disconnect",
      ],
    },
    {
      boundary: "selection",
      expected: [
        "minecraft:connect",
        "mcp:start",
        "codex:auth-check",
        "codex:start",
        "codex:model-list",
        "codex:model-select:gpt-5.6-terra",
        "codex:stop",
        "mcp:stop",
        "minecraft:disconnect",
      ],
    },
    {
      boundary: "minecraft",
      expected: ["minecraft:connect", "minecraft:disconnect"],
    },
    {
      boundary: "companion",
      expected: [
        "minecraft:connect",
        "mcp:start",
        "codex:auth-check",
        "codex:start",
        "codex:model-list",
        "codex:model-select:gpt-5.6-terra",
        "companion:start:gpt-5.6-terra",
        "companion:stop",
        "actions:stop",
        "codex:stop",
        "mcp:stop",
        "minecraft:disconnect",
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
      "codex:stop",
      "mcp:stop",
      "minecraft:disconnect",
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
          switchModel: async (_selection, commitPreference) => commitPreference(),
          minecraft: { connect: async () => undefined, disconnect: async () => undefined },
          companion: {
            start: async () => undefined,
            switchModel: async (_selection, commitPreference) => commitPreference(),
            stop: async () => undefined,
          },
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
          switchModel: async (_selection, commitPreference) => commitPreference(),
          minecraft: { connect: async () => undefined, disconnect: async () => undefined },
          companion: {
            start: async () => undefined,
            switchModel: async (_selection, commitPreference) => commitPreference(),
            stop: async () => undefined,
          },
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
          switchModel: async (_selection, commitPreference) => commitPreference(),
          minecraft: { connect: async () => undefined, disconnect },
          companion: {
            start: async () => undefined,
            switchModel: async (_selection, commitPreference) => commitPreference(),
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

  it("persists production audit counters for the exact installed position action", async () => {
    const result = await runPersistedActionScenario({
      kind: "position",
      ownerText: "查看一下你现在的位置",
    });

    expect(result.toolResult?.isError).not.toBe(true);
    expect(JSON.parse(result.toolResult?.text ?? "null")).toMatchObject({
      botPosition: { x: 0, y: 64, z: 0 },
    });
    expect(result.turnBudget).toMatchObject({ totalCalls: 1, cumulativeHorizontalTravel: 0 });
    expect(result.auditRecords).toHaveLength(2);
    expect(result.auditRecords[0]).toMatchObject({
      kind: "task_started",
      detail: { expectedActionCategoryCount: 1, toolCalls: 0, horizontalTravel: 0 },
    });
    expect(result.auditRecords[1]).toMatchObject({
      kind: "task_stopped",
      detail: {
        expectedActionCategoryCount: 1,
        toolCalls: 1,
        horizontalTravel: 0,
        reason: "completed",
      },
    });
  });

  it("persists production budget counters and executor success for the exact installed follow action", async () => {
    const result = await runPersistedActionScenario({
      kind: "follow",
      ownerText: "走到我身边来",
    });

    expect(result.toolResult).toEqual({ text: '{"status":"completed"}' });
    expect(result.executorResults).toEqual([{ status: "completed" }]);
    expect(result.minecraftCalls).toContainEqual({
      method: "followOwner",
      args: ["TestOwner", 3],
    });
    expect(result.turnBudget).toMatchObject({ totalCalls: 1, cumulativeHorizontalTravel: 6 });
    expect(result.auditRecords).toHaveLength(2);
    expect(result.auditRecords[1]).toMatchObject({
      kind: "task_stopped",
      detail: {
        expectedActionCategoryCount: 2,
        toolCalls: 1,
        horizontalTravel: result.turnBudget?.cumulativeHorizontalTravel,
        reason: "completed",
      },
    });
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
        "codex:stop",
        "mcp:stop",
        "minecraft:disconnect",
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
          switchModel: async (_selection, commitPreference) => commitPreference(),
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
            switchModel: async (_selection, commitPreference) => commitPreference(),
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

    minecraftListener?.({
      kind: "bridge_failed",
      code: "MINECRAFT_BRIDGE_REJECTED",
    });
    await runtime.stop("emergency_stop");
    expect(events.slice(-5)).toEqual([
      "companion:stop",
      "actions:stop",
      "codex:stop",
      "mcp:stop",
      "minecraft:disconnect",
    ]);
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      minecraft: { state: "disconnected", sessionId: null },
      codex: { state: "stopped", model: null },
      task: null,
      lastError: {
        code: "MINECRAFT_BRIDGE_REJECTED",
        message: "Minecraft Bridge rejected the connection",
      },
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
          switchModel: async (_selection, commitPreference) => commitPreference(),
          minecraft: { connect: async () => undefined, disconnect: async () => undefined },
          companion: {
            start: async () => undefined,
            switchModel: async (_selection, commitPreference) => commitPreference(),
            stop: async () => undefined,
          },
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

  it("loads and atomically updates the global farming preference projection", async () => {
    const files = await createCliHarness();
    cleanups.push(files.cleanup);
    const preferenceRoot = join(files.directory, "config");
    await mkdir(preferenceRoot, { recursive: true });
    const persistedStore = new FarmingPreferenceStore({
      rootDirectory: preferenceRoot,
      clock: () => new Date("2026-08-15T08:00:00.000Z"),
    });
    await persistedStore.setAllowed(0);
    let context: AppCompositionContext | undefined;
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
            listModels: async () => [createdContext.config.codex.preferredModel],
            stop: async () => undefined,
          },
          selectModel: (_available, preferred) => preferred,
          switchModel: async (_selection, commitPreference) => commitPreference(),
          minecraft: { connect: async () => undefined, disconnect: async () => undefined },
          companion: {
            start: async () => undefined,
            switchModel: async (_selection, commitPreference) => commitPreference(),
            stop: async () => undefined,
          },
          executor: { stopAll: () => undefined },
        };
      },
    });
    if (!context) throw new Error("runtime context was not composed");

    expect(context.farmingPreference.snapshot().status).toBe("allowed");
    await context.farmingPreference.setDenied();
    expect(context.farmingPreference.snapshot().status).toBe("denied");
    await expect(
      new FarmingPreferenceStore({ rootDirectory: preferenceRoot }).read(),
    ).resolves.toMatchObject({
      revision: 2,
      value: { status: "denied" },
    });

    const external = new FarmingPreferenceStore({ rootDirectory: preferenceRoot });
    await external.setAllowed(2);
    await expect(context.farmingPreference.setDenied()).rejects.toMatchObject({
      code: "DOCUMENT_CONFLICT",
    });
    expect(context.farmingPreference.snapshot().status).toBe("denied");
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
          switchModel: async (_selection, commitPreference) => commitPreference(),
          minecraft: {
            connect: async () => undefined,
            disconnect: async () => undefined,
          },
          companion: {
            start: async (model) => {
              companionStarts.push(model);
            },
            switchModel: async (_selection, commitPreference) => commitPreference(),
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

  it("delegates a live model switch through the composed runtime before publishing it", async () => {
    const files = await createCliHarness();
    cleanups.push(files.cleanup);
    const order: string[] = [];
    const runtime = await createRuntimeFacade(files.configPath, {
      cwd: files.directory,
      runtimeModelSelection: {
        modelId: "gpt-5.6-terra",
        reasoningEffort: "medium",
      },
      runtimeFactory: (context) => ({
        preferredModel: context.config.codex.preferredModel,
        mcp: {
          start: async () => undefined,
          stop: async () => undefined,
          snapshot: () => ({
            state: "ready" as const,
            workspaceVersion: "workspace-1",
            mcpListening: true as const,
            discoveredToolCount: 15,
          }),
          subscribe: () => () => undefined,
        },
        codex: {
          assertChatGptLogin: async () => undefined,
          start: async () => undefined,
          listModels: async () => ["gpt-5.6-terra"],
          stop: async () => undefined,
        },
        selectModel: () => "gpt-5.6-terra",
        switchModel: async (selection, commitPreference) => {
          order.push(`runtime:${selection.modelId}:${selection.reasoningEffort}`);
          await commitPreference();
          order.push("runtime:published");
        },
        minecraft: { connect: async () => undefined, disconnect: async () => undefined },
        companion: {
          start: async () => undefined,
          stop: async () => undefined,
          switchModel: async () => {
            throw new Error("facade must use the AppRuntime switch boundary");
          },
        },
        executor: { stopAll: () => undefined },
      }),
    });
    await runtime.start();
    const before = runtime.snapshot();

    await runtime.switchModel({ modelId: "gpt-5.6-luna", reasoningEffort: "high" }, async () => {
      order.push("commit");
    });

    expect(order).toEqual(["runtime:gpt-5.6-luna:high", "commit", "runtime:published"]);
    expect(runtime.snapshot()).toEqual({
      ...before,
      revision: before.revision + 1,
      codex: { state: "ready", model: "gpt-5.6-luna" },
    });
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
          switchModel: async (_selection, commitPreference) => commitPreference(),
          minecraft: {
            connect: async () => undefined,
            disconnect: async () => undefined,
          },
          companion: {
            start: async () => undefined,
            switchModel: async (_selection, commitPreference) => commitPreference(),
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

    const starting = production.codex.start();
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
    await expect(transport.nextSent()).resolves.toEqual({ method: "initialized", params: {} });
    await expect(transport.nextSent()).resolves.toEqual({
      id: 2,
      method: "config/mcpServer/reload",
      params: {},
    });
    transport.receive({ id: 2, result: {} });
    await starting;

    const companionStarting = production.companion.start("service-live-model");
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
    transport.receive({ id: 3, result: { thread: { id: "thread-service-live-intent" } } });
    const executionThreadStart = await transport.nextSent();
    expect(executionThreadStart).toMatchObject({
      id: 4,
      method: "thread/start",
      params: {
        model: "service-live-model",
        cwd: resolve(files.directory, "codex-workspace"),
        sandbox: "read-only",
        approvalPolicy: "never",
      },
    });
    if (!("params" in executionThreadStart)) throw new Error("expected thread start parameters");
    const dynamicTools = (executionThreadStart.params as { dynamicTools?: Array<{ name: string }> })
      .dynamicTools;
    expect(dynamicTools?.map((tool) => tool.name)).toEqual(MINECRAFT_EXECUTION_TOOL_NAMES);
    transport.receive({ id: 4, result: { thread: { id: "thread-service-live-execution" } } });
    await companionStarting;

    const turn = codex.sendTurn("thread-service-live-execution", "transport pair check");
    await expect(transport.nextSent()).resolves.toEqual({
      id: 5,
      method: "turn/start",
      params: {
        threadId: "thread-service-live-execution",
        input: [{ type: "text", text: "transport pair check", text_elements: [] }],
        effort: "xhigh",
      },
    });
    transport.receive({ id: 5, result: { turn: { id: "turn-service-live" } } });
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

  it("projects and logs only the sanitized action queue whitelist", async () => {
    const files = await createCliHarness();
    cleanups.push(files.cleanup);
    const appModule = await import("../../src/app.js");
    let production: import("../../src/app.js").AppRuntime | undefined;
    let logPath = "";
    const runtime = await createRuntimeFacade(files.configPath, {
      cwd: files.directory,
      runtimeFactory: (context) => {
        logPath = context.paths.log;
        production = appModule.createProductionRuntime(context);
        return production;
      },
    });
    const queue = production?.actionQueueProjection as CompanionActionQueue | undefined;
    if (!queue) throw new Error("production action queue projection was not composed");

    queue.enqueue({
      taskLease: { id: "private-task-lease", startedAt: 1_700_000_000_000 },
      worldGeneration: 7,
      action: { kind: "move_to", position: { x: 1_234.5, y: 64, z: -987.5 } },
      summary: "前往目标",
      trustedObservationKey: "private-observation-key",
    });

    let record: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      const lines = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      record = lines.find((line) => line.event === "action_queue_item_changed");
      expect(record).toBeDefined();
    });
    expect(Object.keys(record!).sort()).toEqual(
      [
        "at",
        "enqueuedAt",
        "event",
        "index",
        "kind",
        "level",
        "retryCount",
        "status",
        "summary",
      ].sort(),
    );
    expect(JSON.stringify(record)).not.toMatch(
      /private-task-lease|private-observation-key|1234\.5|-987\.5|position|owner|prompt/iu,
    );
    expect(runtime.snapshot().actionQueue.items[0]).toMatchObject({
      kind: "move_to",
      summary: "前往目标",
      status: "waiting",
    });
    await runtime.stop("process_exit");
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
        switchModel: async (_selection, commitPreference) => commitPreference(),
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
          switchModel: async (_selection, commitPreference) => commitPreference(),
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
      "codex:stop",
      "mcp:stop",
      "minecraft:disconnect",
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
        toolAccess: "none",
      },
      {
        cwd: harness.directory,
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        toolAccess: "minecraft",
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
