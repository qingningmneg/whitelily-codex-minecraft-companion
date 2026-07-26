import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as nativeDelay } from "node:timers/promises";
import { ActionExecutor } from "../../src/actions/actionExecutor.js";
import { parseLocalCommand } from "../../src/commands/commandParser.js";
import { CompanionService } from "../../src/companion/companionService.js";
import type { CodexPort, CodexTurnResult } from "../../src/codex/codexPort.js";
import type { PersistentState } from "../../src/memory/stateStore.js";
import { MemoryStore } from "../../src/memory/memoryStore.js";
import { StateStore } from "../../src/memory/stateStore.js";
import { ModeManager } from "../../src/mode/modeManager.js";
import { TurnToolBudget } from "../../src/mcp/toolBudget.js";
import { createToolRegistry, type ToolResult } from "../../src/mcp/toolRegistry.js";
import { FakeMinecraftPort } from "../../src/minecraft/fakeMinecraftPort.js";
import { ConfirmationStore } from "../../src/safety/confirmationStore.js";
import { SafetyEngine } from "../../src/safety/safetyEngine.js";

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

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const startedAt = process.hrtime.bigint();
  const timeoutNanoseconds = BigInt(timeoutMilliseconds) * 1_000_000n;
  while (!(await condition())) {
    if (process.hrtime.bigint() - startedAt >= timeoutNanoseconds)
      throw new Error(`Timed out waiting for ${description}`);
    await nativeDelay(5);
  }
}

export type FakeCodexResponse =
  string | Error | { text: string; status: CodexTurnResult["status"] };

export interface CompanionHarnessTeardown {
  stop(): Promise<void>;
  cleanup(): Promise<void>;
}

async function teardownCompanionHarness(value: CompanionHarnessTeardown): Promise<void> {
  const errors: unknown[] = [];
  try {
    await value.stop();
  } catch (error) {
    errors.push(error);
  }
  try {
    await value.cleanup();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Companion stop and cleanup both failed");
}

export async function teardownCompanionHarnesses(
  values: readonly CompanionHarnessTeardown[],
): Promise<void> {
  const results = await Promise.allSettled(values.map(teardownCompanionHarness));
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Multiple companion teardowns failed");
}

interface PendingTurn {
  threadId: string;
  text: string;
  turnId: string;
  onStarted?: (turnId: string) => void;
  result: Deferred<CodexTurnResult>;
  started: boolean;
  settled: boolean;
}

class FakeCodexPort implements CodexPort {
  readonly turns: Array<{ threadId: string; text: string }> = [];
  readonly interruptions: Array<{ threadId: string; turnId: string }> = [];
  readonly startedThreads: Array<{ cwd: string; model: string; reasoningEffort: string }> = [];
  readonly pendingTurns: PendingTurn[] = [];
  startCalls = 0;
  stopCalls = 0;
  listModelCalls = 0;
  private nextTurn = 1;
  private nextThread = 1;
  private readonly responses: FakeCodexResponse[];
  private readonly deferredTurns: Set<number>;
  private readonly deferredStarts: Set<number>;
  private readonly threadIds: string[];
  private readonly startGates = new Map<number, Deferred<void>>();
  private readonly startReached = new Map<number, Deferred<void>>();
  private readonly startErrors: Array<Error | undefined>;
  private readonly modelResults: Array<string[] | Error>;

  constructor(options: CompanionHarnessOptions) {
    this.responses = [...(options.codexResponses ?? [])];
    this.deferredTurns = new Set(options.deferredTurns ?? []);
    this.deferredStarts = new Set(options.deferredStarts ?? []);
    this.threadIds = [...(options.threadIds ?? [])];
    const gatedStarts = new Set(options.gatedCodexStarts ?? []);
    if (options.gateInitialCodexStart) gatedStarts.add(0);
    for (const call of gatedStarts) {
      this.startGates.set(call, deferred<void>());
      this.startReached.set(call, deferred<void>());
    }
    this.startErrors = [...(options.codexStartErrors ?? [])];
    this.modelResults = [...(options.modelResults ?? [])];
  }

  async start(): Promise<void> {
    const call = this.startCalls++;
    const gate = this.startGates.get(call);
    if (gate) {
      this.startReached.get(call)?.resolve();
      await gate.promise;
    }
    const error = this.startErrors.shift();
    if (error) throw error;
  }

  releaseInitialStart(): void {
    this.releaseStart(0);
  }

  releaseStart(call: number): void {
    this.startGates.get(call)?.resolve();
  }

  untilStart(call: number): Promise<void> {
    return this.startReached.get(call)?.promise ?? Promise.resolve();
  }

  async listModels(): Promise<string[]> {
    this.listModelCalls += 1;
    const result = this.modelResults.shift() ?? ["gpt-5.6-terra"];
    if (result instanceof Error) throw result;
    return [...result];
  }

  queueResponse(response: FakeCodexResponse): void {
    this.responses.push(response);
  }

  failNextTurn(reason: string): void {
    const error = new Error(reason);
    error.name = reason;
    this.responses.push(error);
  }

  async startThread(options: {
    cwd: string;
    model: string;
    reasoningEffort: "low" | "medium";
  }): Promise<string> {
    this.startedThreads.push(options);
    return this.threadIds.shift() ?? `thread-${this.nextThread++}`;
  }

  sendTurn(
    threadId: string,
    text: string,
    onStarted?: (turnId: string) => void,
  ): Promise<CodexTurnResult> {
    const index = this.turns.length;
    this.turns.push({ threadId, text });
    const turn: PendingTurn = {
      threadId,
      text,
      turnId: `turn-${this.nextTurn++}`,
      ...(onStarted ? { onStarted } : {}),
      result: deferred<CodexTurnResult>(),
      started: false,
      settled: false,
    };
    this.pendingTurns.push(turn);
    if (!this.deferredStarts.has(index)) this.releaseTurnStart(index);
    if (!this.deferredTurns.has(index)) this.releaseTurnResult(index);
    return turn.result.promise;
  }

  releaseTurnStart(index: number): void {
    const turn = this.pendingTurns[index];
    if (!turn || turn.started) return;
    turn.started = true;
    turn.onStarted?.(turn.turnId);
  }

  releaseTurnResult(index: number, override?: FakeCodexResponse): void {
    const turn = this.pendingTurns[index];
    if (!turn || turn.settled) return;
    turn.settled = true;
    const response =
      override ??
      this.responses.shift() ??
      JSON.stringify({ reply: "", task: null, memoryCandidates: [] });
    if (response instanceof Error) {
      turn.result.reject(response);
      return;
    }
    const normalized =
      typeof response === "string" ? { text: response, status: "completed" as const } : response;
    turn.result.resolve({
      threadId: turn.threadId,
      turnId: turn.turnId,
      text: normalized.text,
      status: normalized.status,
    });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interruptions.push({ threadId, turnId });
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

class GateStateStore extends StateStore {
  readonly savedStates: Array<Omit<PersistentState, "updatedAt">> = [];
  private saveIndex = 0;
  private readonly gates = new Map<number, Deferred<void>>();
  private readonly reached = new Map<number, Deferred<void>>();

  constructor(path: string, gatedSaves: number[]) {
    super(path);
    for (const index of gatedSaves) {
      this.gates.set(index, deferred<void>());
      this.reached.set(index, deferred<void>());
    }
  }

  override async save(state: Omit<PersistentState, "updatedAt">): Promise<void> {
    this.savedStates.push(structuredClone(state));
    const index = this.saveIndex++;
    const gate = this.gates.get(index);
    if (gate) {
      this.reached.get(index)?.resolve();
      await gate.promise;
    }
    await super.save(state);
  }

  releaseSave(index: number): void {
    this.gates.get(index)?.resolve();
  }

  untilSave(index: number): Promise<void> {
    return this.reached.get(index)?.promise ?? Promise.resolve();
  }
}

export interface CompanionHarnessOptions {
  codexResponses?: FakeCodexResponse[];
  deferredTurns?: number[];
  deferredStarts?: number[];
  threadIds?: string[];
  gateInitialCodexStart?: boolean;
  gatedCodexStarts?: number[];
  codexStartErrors?: Array<Error | undefined>;
  modelResults?: Array<string[] | Error>;
  persistedState?: Omit<PersistentState, "updatedAt">;
  gatedStateSaves?: number[];
  gateMemoryFileRename?: boolean;
  activeMinecraftWait?: boolean;
  autonomyCanChat?: boolean;
}

class FakeAutonomyScheduler {
  startCalls = 0;
  stopCalls = 0;
  modeChanged = 0;
  goalsCompleted = 0;
  actionsFailed = 0;
  threats = 0;
  proactiveMarks = 0;
  canChat: boolean;

  constructor(canChat: boolean) {
    this.canChat = canChat;
  }

  start(): void {
    this.startCalls += 1;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  notifyModeChanged(): void {
    this.modeChanged += 1;
  }

  notifyGoalCompleted(): void {
    this.goalsCompleted += 1;
  }

  notifyActionFailed(): void {
    this.actionsFailed += 1;
  }

  notifyThreat(): void {
    this.threats += 1;
  }

  canChatProactively(): boolean {
    return this.canChat;
  }

  markProactiveChat(): void {
    this.proactiveMarks += 1;
  }
}

export function outcome(
  overrides: Partial<{
    reply: string;
    task: {
      goal: string;
      allowedActions: string[];
      actionBudget: number;
      successCondition: string;
      stopCondition: string;
      status: "active" | "completed" | "stopped";
    } | null;
    memoryCandidates: Array<{
      category: "preference" | "place" | "project" | "promise" | "experience";
      summary: string;
      importance: 1 | 2 | 3 | 4 | 5;
    }>;
  }> = {},
): string {
  return JSON.stringify({
    reply: "",
    task: null,
    memoryCandidates: [],
    ...overrides,
  });
}

export async function createCompanionHarness(options: CompanionHarnessOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "whitelily-companion-"));
  const minecraft = new FakeMinecraftPort();
  minecraft.ownerOnline = true;
  const codex = new FakeCodexPort(options);
  const mode = new ModeManager();
  const memoryRenameReached = deferred<void>();
  const memoryRenameRelease = deferred<void>();
  const memoryPath = join(directory, "memories.json");
  const memories = new MemoryStore(memoryPath, {
    beforeRename: async (path) => {
      if (options.gateMemoryFileRename && path === memoryPath) {
        memoryRenameReached.resolve();
        await memoryRenameRelease.promise;
      }
    },
  });
  const state = new GateStateStore(join(directory, "state.json"), options.gatedStateSaves ?? []);
  if (options.persistedState) await StateStore.prototype.save.call(state, options.persistedState);
  const confirmations = new ConfirmationStore();
  const executor = new ActionExecutor(
    minecraft,
    new SafetyEngine(confirmations),
    confirmations,
    "TestOwner",
  );
  const budget = new TurnToolBudget();
  const autonomy = new FakeAutonomyScheduler(options.autonomyCanChat ?? true);
  const budgetEvents: string[] = [];
  const budgetLeases: Array<string | undefined> = [];
  const errors: string[] = [];
  const begin = budget.begin.bind(budget);
  const end = budget.end.bind(budget);
  budget.begin = () => {
    budgetEvents.push("begin");
    const lease = begin();
    budgetLeases.push(lease);
    return lease;
  };
  budget.end = () => {
    budgetEvents.push("end");
    end();
  };
  let activeWaitAbort: AbortSignal | undefined;
  let nextTimerId = 1;
  const mergeTimers = new Map<number, () => void>();
  if (options.activeMinecraftWait) {
    minecraft.wait = async (_milliseconds, signal) => {
      activeWaitAbort = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    };
  }
  const service = new CompanionService({
    minecraft,
    codex,
    mode,
    memories,
    state,
    confirmations,
    executor,
    budget,
    autonomy,
    logger: {
      error: async (_event: string, fields: Record<string, unknown>) => {
        errors.push(String(fields.code));
      },
    },
    safetyContextProvider: async () => ({
      spawn: { x: 0, y: 64, z: 0 },
      owner: { x: 0, y: 64, z: 0 },
    }),
    ownerUsername: "TestOwner",
    cwd: directory,
    preferredModel: "gpt-5.6-terra",
    reasoningEffort: "low",
    setTimer: (callback) => {
      const id = nextTimerId++;
      mergeTimers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      mergeTimers.delete(timer as unknown as number);
    },
  });
  const tools = createToolRegistry({
    minecraft,
    executor,
    budget,
    safetyContextProvider: async () => ({
      spawn: { x: 0, y: 64, z: 0 },
      owner: { x: 0, y: 64, z: 0 },
    }),
    ownerUsername: "TestOwner",
  });
  return {
    directory,
    minecraft,
    codex,
    mode,
    memories,
    state,
    savedStates: state.savedStates,
    confirmations,
    executor,
    budget,
    budgetEvents,
    budgetLeases,
    autonomy,
    errors,
    service,
    tools,
    start: () => service.start(),
    stop: () => service.stop(),
    restart: async () => {
      await service.stop();
      await service.start();
    },
    ownerSays: async (message: string) => {
      const priorChatCount = minecraft.chatLog.length;
      const priorTurnCount = codex.turns.length;
      minecraft.emit({ kind: "chat", username: "TestOwner", message });
      if (parseLocalCommand(message)) {
        await waitForCondition(
          () => minecraft.chatLog.length > priorChatCount,
          `command response to ${message}`,
        );
        return;
      }
      const callbacks = [...mergeTimers.values()];
      mergeTimers.clear();
      for (const callback of callbacks) callback();
      await waitForCondition(() => codex.turns.length > priorTurnCount, "Codex turn to begin");
      await waitForCondition(() => !service.isBusyForAutonomy(), "companion turn to settle");
    },
    codexCalls: async (name: keyof typeof tools, input: unknown): Promise<ToolResult> => {
      const tool = tools[name] as {
        schema: { parse(value: unknown): unknown };
        execute(value: never): Promise<ToolResult>;
      };
      const turnLease = budget.begin();
      try {
        const leasedInput = {
          ...(typeof input === "object" && input !== null
            ? (input as Record<string, unknown>)
            : {}),
          turnLease,
        };
        return await tool.execute(tool.schema.parse(leasedInput) as never);
      } finally {
        budget.end();
      }
    },
    executeRawTool: async (name: keyof typeof tools, input: unknown): Promise<ToolResult> => {
      const tool = tools[name] as {
        execute(value: never): Promise<ToolResult>;
      };
      return tool.execute(input as never);
    },
    cleanup: () => rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 10 }),
    releaseStartup: () => codex.releaseInitialStart(),
    releaseCodexStart: (call: number) => codex.releaseStart(call),
    untilCodexStart: (call: number) => codex.untilStart(call),
    releaseStateSave: (index: number) => state.releaseSave(index),
    untilStateSave: (index: number) => state.untilSave(index),
    releaseMemoryRename: () => memoryRenameRelease.resolve(),
    untilMemoryRename: () => memoryRenameReached.promise,
    activeWaitWasAborted: () => activeWaitAbort?.aborted ?? false,
    pendingMergeTimers: () => mergeTimers.size,
    untilMergeTimer: async () => {
      await waitForCondition(() => mergeTimers.size > 0, "message merge timer");
    },
    fireMergeTimers: () => {
      const callbacks = [...mergeTimers.values()];
      mergeTimers.clear();
      for (const callback of callbacks) callback();
    },
    untilTurnSettled: async () => {
      await waitForCondition(() => !service.isBusyForAutonomy(), "companion turn work to settle");
    },
    untilActiveWaitStarted: async () => {
      await waitForCondition(() => activeWaitAbort !== undefined, "Minecraft wait action to start");
    },
    untilActionIdle: async () => {
      await waitForCondition(() => !executor.isBusy(), "Minecraft action work to settle");
    },
    untilCodexTurns: async (count: number) => {
      await waitForCondition(() => codex.turns.length >= count, `${count} Codex turns to begin`);
    },
    untilChat: async (message: string) => {
      await waitForCondition(
        () => minecraft.chatLog.includes(message),
        `Minecraft chat message ${message}`,
      );
    },
    untilState: async (predicate: (value: PersistentState) => boolean) => {
      await waitForCondition(
        async () => predicate(await state.load()),
        "persistent state condition",
      );
    },
    untilMemories: async (
      predicate: (value: Awaited<ReturnType<MemoryStore["list"]>>) => boolean,
    ) => {
      await waitForCondition(
        async () => predicate(await memories.list()),
        "persistent memory condition",
      );
    },
  };
}
