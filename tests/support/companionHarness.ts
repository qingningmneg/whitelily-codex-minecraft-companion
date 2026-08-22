import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as nativeDelay } from "node:timers/promises";
import { ActionExecutor } from "../../src/actions/actionExecutor.js";
import { CompanionActionQueue } from "../../src/actions/actionQueue.js";
import { QueuedActionRunner } from "../../src/actions/queuedActionRunner.js";
import { parseLocalCommand } from "../../src/commands/commandParser.js";
import { ChatRouter } from "../../src/companion/chatRouter.js";
import { CompanionService } from "../../src/companion/companionService.js";
import { TaskController } from "../../src/companion/taskController.js";
import type { CodexPort, CodexTurnResult } from "../../src/codex/codexPort.js";
import type { PersistentState, StateToPersist } from "../../src/memory/stateStore.js";
import { MemoryStore } from "../../src/memory/memoryStore.js";
import { StateStore } from "../../src/memory/stateStore.js";
import { ModeManager } from "../../src/mode/modeManager.js";
import { TurnToolBudget } from "../../src/mcp/toolBudget.js";
import { createToolRegistry, type ToolResult } from "../../src/mcp/toolRegistry.js";
import { FakeMinecraftPort } from "../../src/minecraft/fakeMinecraftPort.js";
import type { OwnerIdentitySnapshot } from "../../src/identity/ownerIdentity.js";
import type { FarmingPreferenceStatus } from "../../src/profile/farmingPreferenceStore.js";
import { ConfirmationStore } from "../../src/safety/confirmationStore.js";
import { SafetyEngine } from "../../src/safety/safetyEngine.js";
import {
  TaskControllerBudget,
  type TaskLease,
  type TaskLimits,
} from "../../src/safety/taskBudget.js";

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
export type CodexThreadRole = "intent" | "execution";

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
  role: CodexThreadRole;
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
  readonly startedThreads: Array<{
    cwd: string;
    model: string;
    reasoningEffort: string;
    toolAccess?: "none" | "minecraft";
  }> = [];
  readonly closedThreads: string[] = [];
  readonly threadLifecycle: string[] = [];
  readonly pendingTurns: PendingTurn[] = [];
  startCalls = 0;
  stopCalls = 0;
  listModelCalls = 0;
  validateSelectionCalls = 0;
  private readonly nextTurnByRole: Record<CodexThreadRole, number> = {
    intent: 1,
    execution: 1,
  };
  private readonly nextThreadByRole: Record<CodexThreadRole, number> = {
    intent: 1,
    execution: 1,
  };
  private readonly legacyExecutionResponses: FakeCodexResponse[];
  private readonly responsesByRole: Record<CodexThreadRole, FakeCodexResponse[]>;
  private readonly turnsByRole: Record<CodexThreadRole, Array<{ threadId: string; text: string }>> =
    {
      intent: [],
      execution: [],
    };
  private readonly deferredTurnsByRole: Record<CodexThreadRole, Set<number>>;
  private readonly deferredStarts: Set<number>;
  private readonly threadIdsByRole: Record<CodexThreadRole, string[]>;
  private readonly threadRoles = new Map<string, CodexThreadRole>();
  private nextThreadRole: CodexThreadRole = "intent";
  private threadStartCalls = 0;
  private threadPairRevision = 0;
  private readonly currentThreadIds: {
    intent: string | undefined;
    execution: string | undefined;
  } = {
    intent: undefined,
    execution: undefined,
  };
  private readonly threadStartGates = new Map<number, Deferred<void>>();
  private readonly threadStartReached = new Map<number, Deferred<void>>();
  private readonly threadStartErrors: Array<Error | undefined>;
  private readonly threadCloseErrors: Array<Error | undefined>;
  private readonly startGates = new Map<number, Deferred<void>>();
  private readonly startReached = new Map<number, Deferred<void>>();
  private readonly startErrors: Array<Error | undefined>;
  private readonly modelResults: Array<string[] | Error>;
  private readonly selectionAvailability: boolean[];

  constructor(options: CompanionHarnessOptions) {
    this.legacyExecutionResponses = [...(options.codexResponses ?? [])];
    this.responsesByRole = {
      intent: [...(options.intentResponses ?? [])],
      execution: [...(options.executionResponses ?? [])],
    };
    this.deferredTurnsByRole = {
      intent: new Set(options.deferredIntentTurns ?? []),
      execution: new Set(options.deferredTurns ?? []),
    };
    this.deferredStarts = new Set(options.deferredStarts ?? []);
    this.threadIdsByRole = {
      intent: [...(options.intentThreadIds ?? [])],
      execution: [...(options.threadIds ?? [])],
    };
    for (const call of options.gatedThreadStarts ?? []) {
      this.threadStartGates.set(call, deferred<void>());
      this.threadStartReached.set(call, deferred<void>());
    }
    const gatedStarts = new Set(options.gatedCodexStarts ?? []);
    if (options.gateInitialCodexStart) gatedStarts.add(0);
    for (const call of gatedStarts) {
      this.startGates.set(call, deferred<void>());
      this.startReached.set(call, deferred<void>());
    }
    this.startErrors = [...(options.codexStartErrors ?? [])];
    this.threadStartErrors = [...(options.codexThreadStartErrors ?? [])];
    this.threadCloseErrors = [...(options.codexThreadCloseErrors ?? [])];
    this.modelResults = [...(options.modelResults ?? [])];
    this.selectionAvailability = [...(options.selectionAvailability ?? [])];
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
    this.resetThreadPair();
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

  async validateModelSelection(): Promise<boolean> {
    this.validateSelectionCalls += 1;
    return this.selectionAvailability.shift() ?? true;
  }

  queueResponse(response: FakeCodexResponse): void {
    this.legacyExecutionResponses.push(response);
  }

  queueResponseForThread(role: CodexThreadRole, response: FakeCodexResponse): void {
    this.responsesByRole[role].push(response);
  }

  turnsFor(role: CodexThreadRole): ReadonlyArray<{ threadId: string; text: string }> {
    return this.turnsByRole[role];
  }

  get startedThreadIds(): Readonly<{
    intent: string | undefined;
    execution: string | undefined;
  }> {
    return { ...this.currentThreadIds };
  }

  failNextTurn(reason: string): void {
    const error = new Error(reason);
    error.name = reason;
    this.legacyExecutionResponses.push(error);
  }

  async startThread(options: {
    cwd: string;
    model: string;
    reasoningEffort: string;
    toolAccess?: "none" | "minecraft";
  }): Promise<string> {
    const call = this.threadStartCalls++;
    const role = this.nextThreadRole;
    const revision = this.threadPairRevision;
    const threadId =
      this.threadIdsByRole[role].shift() ??
      `${role === "intent" ? "intent-thread" : "thread"}-${this.nextThreadByRole[role]++}`;
    const gate = this.threadStartGates.get(call);
    if (gate) {
      this.threadStartReached.get(call)?.resolve();
      await gate.promise;
    }
    const error = this.threadStartErrors.shift();
    if (error) {
      this.nextThreadRole = "intent";
      throw error;
    }
    if (revision !== this.threadPairRevision) return threadId;
    this.startedThreads.push(options);
    this.threadRoles.set(threadId, role);
    this.currentThreadIds[role] = threadId;
    this.threadLifecycle.push(`start:${threadId}`);
    this.nextThreadRole = role === "intent" ? "execution" : "intent";
    return threadId;
  }

  releaseThreadStart(call: number): void {
    this.threadStartGates.get(call)?.resolve();
  }

  untilThreadStart(call: number): Promise<void> {
    return this.threadStartReached.get(call)?.promise ?? Promise.resolve();
  }

  sendTurn(
    threadId: string,
    text: string,
    onStarted?: (turnId: string) => void,
  ): Promise<CodexTurnResult> {
    const role = this.threadRoles.get(threadId);
    if (!role) throw new Error(`unknown Codex thread: ${threadId}`);
    const roleIndex = this.turnsByRole[role].length;
    const observed = { threadId, text };
    this.turnsByRole[role].push(observed);
    if (role === "execution") this.turns.push(observed);
    const turn: PendingTurn = {
      role,
      threadId,
      text,
      turnId: `turn-${this.nextTurnByRole[role]++}`,
      ...(onStarted ? { onStarted } : {}),
      result: deferred<CodexTurnResult>(),
      started: false,
      settled: false,
    };
    this.pendingTurns.push(turn);
    if (role !== "execution" || !this.deferredStarts.has(roleIndex)) {
      this.releasePendingTurnStart(turn);
    }
    if (!this.deferredTurnsByRole[role].has(roleIndex)) {
      this.releasePendingTurnResult(turn);
    }
    return turn.result.promise;
  }

  releaseTurnStart(index: number): void {
    const turn = this.pendingTurns.filter((candidate) => candidate.role === "execution")[index];
    if (turn) this.releasePendingTurnStart(turn);
  }

  private releasePendingTurnStart(turn: PendingTurn): void {
    if (turn.started) return;
    turn.started = true;
    turn.onStarted?.(turn.turnId);
  }

  releaseTurnStartFor(role: CodexThreadRole, index = 0): void {
    const turn = this.pendingTurns.filter((candidate) => candidate.role === role)[index];
    if (turn) this.releasePendingTurnStart(turn);
  }

  releaseTurnResult(index: number, override?: FakeCodexResponse): void {
    const turn = this.pendingTurns.filter((candidate) => candidate.role === "execution")[index];
    if (turn) this.releasePendingTurnResult(turn, override);
  }

  private releasePendingTurnResult(turn: PendingTurn, override?: FakeCodexResponse): void {
    if (turn.settled) return;
    turn.settled = true;
    const response =
      override ??
      this.responsesByRole[turn.role].shift() ??
      (turn.role === "intent"
        ? this.automaticLegacyIntentDecision()
        : (this.legacyExecutionResponses.shift() ??
          JSON.stringify({ reply: "", task: null, memoryCandidates: [] })));
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

  releaseTurnResultFor(role: CodexThreadRole, index = 0, override?: FakeCodexResponse): void {
    const turn = this.pendingTurns.filter((candidate) => candidate.role === role)[index];
    if (turn) this.releasePendingTurnResult(turn, override);
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interruptions.push({ threadId, turnId });
  }

  async closeThread(threadId: string): Promise<void> {
    this.closedThreads.push(threadId);
    this.threadLifecycle.push(`close:${threadId}`);
    const error = this.threadCloseErrors.shift();
    if (error) throw error;
    const role = this.threadRoles.get(threadId);
    if (role && this.currentThreadIds[role] === threadId) this.currentThreadIds[role] = undefined;
    this.threadRoles.delete(threadId);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.threadPairRevision += 1;
    this.resetThreadPair();
  }

  private resetThreadPair(): void {
    this.nextThreadRole = "intent";
    this.currentThreadIds.intent = undefined;
    this.currentThreadIds.execution = undefined;
  }

  private automaticLegacyIntentDecision(): string {
    return JSON.stringify({
      kind: "start_task",
      naturalReply: null,
      task: {
        goal: "legacy owner task",
        allowedActions: ["get_state"],
        requestedLimits: {},
      },
      memoryCandidates: [],
    });
  }
}

class GateStateStore extends StateStore {
  readonly savedStates: StateToPersist[] = [];
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

  override async save(state: StateToPersist): Promise<void> {
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
  intentResponses?: FakeCodexResponse[];
  executionResponses?: FakeCodexResponse[];
  deferredTurns?: number[];
  deferredIntentTurns?: number[];
  deferredStarts?: number[];
  intentThreadIds?: string[];
  threadIds?: string[];
  gateInitialCodexStart?: boolean;
  gatedCodexStarts?: number[];
  gatedThreadStarts?: number[];
  codexStartErrors?: Array<Error | undefined>;
  codexThreadStartErrors?: Array<Error | undefined>;
  codexThreadCloseErrors?: Array<Error | undefined>;
  modelResults?: Array<string[] | Error>;
  selectionAvailability?: boolean[];
  persistedState?: StateToPersist;
  gatedStateSaves?: number[];
  gateMemoryFileRename?: boolean;
  activeMinecraftWait?: boolean;
  autonomyCanChat?: boolean;
  storageDirectory?: string;
  requestedTaskLimits?: Partial<TaskLimits>;
  runtimeReasoningEffort?: string;
  manualConfirmationTimers?: boolean;
  confirmationTimerSetThrows?: boolean;
  confirmationTimerClearThrows?: boolean;
  onModelAuthorityLost?: () => void;
  compatibilityVerified?: boolean;
  safetyPresetAllows?: boolean;
  ownerIdentitySnapshot?: OwnerIdentitySnapshot;
  farmingPreferenceStatus?: FarmingPreferenceStatus;
  gateFarmingPermissionSetAllowed?: boolean;
  farmObservationNow?: number;
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

  canSendProactively(_kind: "chat" | "suggestion"): boolean {
    return this.canChat;
  }

  markProactiveChat(): void {
    this.proactiveMarks += 1;
  }
}

export function outcome(
  overrides: Partial<{
    reply: string;
    proactiveKind: "chat" | "suggestion" | null;
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
  const directory =
    options.storageDirectory ?? (await mkdtemp(join(tmpdir(), "whitelily-companion-")));
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
  const taskAuditEvents: string[] = [];
  const taskAuditPayloads: Array<{ event: string; data: unknown }> = [];
  const disclosureChatAtTaskStart: string[][] = [];
  const taskTerminalReasons: string[] = [];
  const taskBudget = new TaskControllerBudget();
  let taskDeadlineCallback: (() => void) | undefined;
  const taskDeadlineTimer = 1 as unknown as ReturnType<typeof setTimeout>;
  const taskController = new TaskController(
    taskBudget,
    (event, data) => {
      taskAuditEvents.push("reason" in data ? `${event}:${data.reason}` : event);
      taskAuditPayloads.push({ event, data: structuredClone(data) });
      if (event === "task_started") disclosureChatAtTaskStart.push([...minecraft.chatLog]);
    },
    {
      onTerminal: (reason) => taskTerminalReasons.push(reason),
      setTimer: (callback) => {
        taskDeadlineCallback = callback;
        return taskDeadlineTimer;
      },
      clearTimer: (timer) => {
        if (timer === taskDeadlineTimer) taskDeadlineCallback = undefined;
      },
    },
  );
  const budget = new TurnToolBudget(taskBudget);
  const executor = new ActionExecutor(
    minecraft,
    new SafetyEngine(confirmations, undefined, (lease) => taskController.isLeaseLive(lease)),
    confirmations,
    () => "TestOwner",
    () => taskController.stop("owner_stop"),
    {
      isLeaseLive: (lease) => taskController.isLeaseLive(lease),
      reserveAdditionalTravel: (lease, horizontalTravel) =>
        taskController.reserveAdditionalTravel(lease, horizontalTravel),
    },
  );
  const actionQueue = new CompanionActionQueue({
    createId: (() => {
      let next = 0;
      return () => `queue-${++next}`;
    })(),
    now: () => new Date(),
  });
  let farmingPreferenceStatus = options.farmingPreferenceStatus ?? "unknown";
  const farmingPermissionSetAllowedReached = deferred<void>();
  const farmingPermissionSetAllowedRelease = deferred<void>();
  const farmingPreference = {
    snapshot: () => Object.freeze({ status: farmingPreferenceStatus }),
    setAllowed: async (guard?: () => boolean) => {
      if (guard?.() === false) throw new Error("farming permission authority is stale");
      if (options.gateFarmingPermissionSetAllowed) {
        farmingPermissionSetAllowedReached.resolve();
        await farmingPermissionSetAllowedRelease.promise;
      }
      if (guard?.() === false) throw new Error("farming permission authority is stale");
      farmingPreferenceStatus = "allowed" as const;
      return Object.freeze({ status: farmingPreferenceStatus });
    },
    setDenied: async () => {
      farmingPreferenceStatus = "denied" as const;
      return Object.freeze({ status: farmingPreferenceStatus });
    },
  };
  let service!: CompanionService;
  const actionRunner = new QueuedActionRunner({
    queue: actionQueue,
    executor,
    executionContext: () => service?.queueExecutionContext() ?? null,
    safetyContextProvider: async () => ({
      spawn: { x: 0, y: 64, z: 0 },
      owner: { x: 0, y: 64, z: 0 },
      wheatFarmingAllowed: farmingPreferenceStatus === "allowed",
    }),
  });
  const autonomy = new FakeAutonomyScheduler(options.autonomyCanChat ?? true);
  let ownerIdentitySnapshot = options.ownerIdentitySnapshot
    ? { ...options.ownerIdentitySnapshot }
    : undefined;
  const ownerIdentity =
    ownerIdentitySnapshot === undefined
      ? undefined
      : {
          snapshot: () => Object.freeze({ ...ownerIdentitySnapshot! }),
          setPresence(input: {
            revision: number;
            ownerUsername: string;
            presence: "online" | "offline";
          }) {
            if (
              input.revision !== ownerIdentitySnapshot?.revision ||
              input.ownerUsername !== ownerIdentitySnapshot.ownerUsername
            ) {
              return;
            }
            ownerIdentitySnapshot = { ...ownerIdentitySnapshot, presence: input.presence };
          },
        };
  const budgetEvents: string[] = [];
  const budgetLeases: Array<string | undefined> = [];
  const budgetTaskLeaseIds: Array<string | undefined> = [];
  const errors: string[] = [];
  const diagnostics: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const begin = budget.begin.bind(budget);
  const end = budget.end.bind(budget);
  budget.begin = (taskLease?: TaskLease, authorization = {}) => {
    budgetEvents.push("begin");
    budgetTaskLeaseIds.push(taskLease?.id);
    const lease = begin(taskLease, authorization);
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
  let nextConfirmationTimerId = 10_000;
  const confirmationTimers = new Map<
    number,
    { callback: () => void; milliseconds: number; cleared: boolean }
  >();
  let nextFarmingPermissionTimerId = 20_000;
  const farmingPermissionTimers = new Map<
    number,
    { callback: () => void; milliseconds: number; cleared: boolean }
  >();
  let farmObservationNow = options.farmObservationNow ?? 0;
  let nextFarmObservationTimerId = 30_000;
  const farmObservationTimers = new Map<
    number,
    { callback: () => void; milliseconds: number; cleared: boolean }
  >();
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
  service = new CompanionService({
    minecraft,
    codex,
    mode,
    memories,
    state,
    confirmations,
    executor,
    actionQueue,
    actionRunner,
    farmingPreference,
    budget,
    taskController,
    autonomy,
    logger: {
      error: async (event: string, fields: Record<string, unknown>) => {
        errors.push(String(fields.code));
        diagnostics.push({ event, fields: structuredClone(fields) });
      },
    },
    safetyContextProvider: async () => ({
      spawn: { x: 0, y: 64, z: 0 },
      owner: { x: 0, y: 64, z: 0 },
      wheatFarmingAllowed: farmingPreferenceStatus === "allowed",
    }),
    ownerUsername: () => "TestOwner",
    ...(ownerIdentity === undefined ? {} : { ownerIdentity }),
    chatRouter: new ChatRouter({ ownerUsername: () => "TestOwner", maxMessageLength: 4_000 }),
    cwd: directory,
    preferredModel: "gpt-5.6-terra",
    reasoningEffort: options.runtimeReasoningEffort ?? "low",
    onAuthorityLost:
      options.onModelAuthorityLost === undefined
        ? undefined
        : (event) => {
            if (event.reason === "model_unavailable") options.onModelAuthorityLost?.();
          },
    requestedTaskLimits: options.requestedTaskLimits,
    ...(options.compatibilityVerified === undefined
      ? {}
      : { compatibilityVerified: async () => options.compatibilityVerified === true }),
    ...(options.safetyPresetAllows === undefined
      ? {}
      : { safetyPresetAllows: async () => options.safetyPresetAllows === true }),
    setTimer: (callback) => {
      const id = nextTimerId++;
      mergeTimers.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      mergeTimers.delete(timer as unknown as number);
    },
    setFarmingPermissionTimer: (callback, milliseconds) => {
      const id = nextFarmingPermissionTimerId++;
      farmingPermissionTimers.set(id, { callback, milliseconds, cleared: false });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearFarmingPermissionTimer: (timer) => {
      const record = farmingPermissionTimers.get(timer as unknown as number);
      if (record) record.cleared = true;
    },
    setFarmObservationTimer: (callback, milliseconds) => {
      const id = nextFarmObservationTimerId++;
      farmObservationTimers.set(id, { callback, milliseconds, cleared: false });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearFarmObservationTimer: (timer) => {
      const record = farmObservationTimers.get(timer as unknown as number);
      if (record) record.cleared = true;
    },
    farmObservationNow: () => farmObservationNow,
    ...(options.manualConfirmationTimers
      ? {
          confirmationNow: () => new Date(),
          setConfirmationTimer: (callback: () => void, milliseconds: number) => {
            if (options.confirmationTimerSetThrows) {
              throw new Error("confirmation timer set failed");
            }
            const id = nextConfirmationTimerId++;
            confirmationTimers.set(id, { callback, milliseconds, cleared: false });
            return id as unknown as ReturnType<typeof setTimeout>;
          },
          clearConfirmationTimer: (timer: ReturnType<typeof setTimeout>) => {
            if (options.confirmationTimerClearThrows) {
              throw new Error("confirmation timer clear failed");
            }
            const record = confirmationTimers.get(timer as unknown as number);
            if (record) record.cleared = true;
          },
        }
      : {}),
  } as ConstructorParameters<typeof CompanionService>[0] & {
    requestedTaskLimits?: Partial<TaskLimits>;
  });
  const tools = createToolRegistry({
    minecraft,
    executor,
    budget,
    safetyContextProvider: async () => ({
      spawn: { x: 0, y: 64, z: 0 },
      owner: { x: 0, y: 64, z: 0 },
      wheatFarmingAllowed: farmingPreferenceStatus === "allowed",
    }),
    ownerUsername: () => "TestOwner",
    latestSnapshot: () => minecraft.world,
    actionQueue,
    worldGeneration: () => service.queueExecutionContext()?.worldGeneration ?? 0,
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
    actionQueue,
    actionRunner,
    currentFarmingPreferenceStatus: () => farmingPreferenceStatus,
    untilFarmingPermissionSetAllowed: () => farmingPermissionSetAllowedReached.promise,
    releaseFarmingPermissionSetAllowed: () => farmingPermissionSetAllowedRelease.resolve(),
    budget,
    taskController,
    taskAuditEvents,
    taskAuditPayloads,
    disclosureChatAtTaskStart,
    taskTerminalReasons,
    budgetEvents,
    budgetLeases,
    budgetTaskLeaseIds,
    autonomy,
    errors,
    diagnostics,
    service,
    tools,
    setOwnerIdentitySnapshot: (snapshot: OwnerIdentitySnapshot) => {
      ownerIdentitySnapshot = { ...snapshot };
    },
    start: () => service.start(),
    stop: () => service.stop(),
    restart: async () => {
      await service.stop();
      await service.start();
    },
    ownerSays: async (message: string) => {
      const priorChatCount = minecraft.chatLog.length;
      const priorTurnCount = codex.turnsFor("intent").length + codex.turnsFor("execution").length;
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
      await waitForCondition(
        () => codex.turnsFor("intent").length + codex.turnsFor("execution").length > priorTurnCount,
        "Codex turn to begin",
      );
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
    releaseThreadStart: (call: number) => codex.releaseThreadStart(call),
    untilThreadStart: (call: number) => codex.untilThreadStart(call),
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
    emitOwnerText: async (message: string) => {
      const priorIntentTurnCount = codex.turnsFor("intent").length;
      minecraft.emit({ kind: "chat", username: "TestOwner", message });
      await waitForCondition(() => mergeTimers.size > 0, "message merge timer");
      const callbacks = [...mergeTimers.values()];
      mergeTimers.clear();
      for (const callback of callbacks) callback();
      await waitForCondition(
        () => codex.turnsFor("intent").length > priorIntentTurnCount,
        "owner intent turn to begin",
      );
    },
    fireTaskDeadline: () => {
      const callback = taskDeadlineCallback;
      if (!callback) throw new Error("no task deadline is pending");
      taskDeadlineCallback = undefined;
      callback();
    },
    farmingPermissionTimerRecords: () =>
      [...farmingPermissionTimers.entries()].map(([id, record]) => ({
        id,
        milliseconds: record.milliseconds,
        cleared: record.cleared,
      })),
    fireFarmingPermissionTimer: (id: number, includeCleared = false) => {
      const record = farmingPermissionTimers.get(id);
      if (!record || (record.cleared && !includeCleared)) {
        throw new Error("no matching farming permission timer is pending");
      }
      record.cleared = true;
      record.callback();
    },
    farmObservationTimerRecords: () =>
      [...farmObservationTimers.entries()].map(([id, record]) => ({
        id,
        milliseconds: record.milliseconds,
        cleared: record.cleared,
      })),
    setFarmObservationNow: (now: number) => {
      farmObservationNow = now;
    },
    fireFarmObservationTimer: (id: number, includeCleared = false) => {
      const record = farmObservationTimers.get(id);
      if (!record || (record.cleared && !includeCleared)) {
        throw new Error("no matching farm observation timer is pending");
      }
      record.cleared = true;
      record.callback();
    },
    confirmationTimerRecords: () =>
      [...confirmationTimers.entries()].map(([id, record]) => ({
        id,
        milliseconds: record.milliseconds,
        cleared: record.cleared,
      })),
    fireConfirmationTimer: (id: number, includeCleared = false) => {
      const record = confirmationTimers.get(id);
      if (!record || (record.cleared && !includeCleared)) {
        throw new Error("no matching confirmation timer is pending");
      }
      record.cleared = true;
      record.callback();
    },
    untilTurnSettled: async () => {
      await waitForCondition(() => !service.isBusyForAutonomy(), "companion turn work to settle");
    },
    untilIntentSettled: async () => {
      await waitForCondition(
        () =>
          (
            service as unknown as {
              activeIntentTurns: ReadonlySet<unknown>;
            }
          ).activeIntentTurns.size === 0,
        "owner intent work to settle",
      );
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
