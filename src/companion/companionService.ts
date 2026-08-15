import { ActionExecutor } from "../actions/actionExecutor.js";
import type { CompanionActionQueue } from "../actions/actionQueue.js";
import type {
  QueuedActionExecutionContext,
  QueuedActionRunner,
} from "../actions/queuedActionRunner.js";
import type { AutonomyReason } from "../autonomy/autonomyScheduler.js";
import type { LocalCommand } from "../commands/commandParser.js";
import type { CodexPort, CodexTurnResult } from "../codex/codexPort.js";
import type { ResolvedModelSelection } from "../codex/modelCatalog.js";
import { selectModel } from "../codex/modelSelector.js";
import type { CompanionMode } from "../domain/types.js";
import { SafeLogger } from "../logging/safeLogger.js";
import { MemoryStore, type MemoryValidationSource } from "../memory/memoryStore.js";
import { ScopedMemoryStore } from "../memory/scopedMemoryStore.js";
import { MemoryMigration } from "../memory/memoryMigration.js";
import { StateStore } from "../memory/stateStore.js";
import { ModeManager } from "../mode/modeManager.js";
import { TOOL_ACTION_KINDS, TurnToolBudget, type ToolActionKind } from "../mcp/toolBudget.js";
import type { MinecraftEvent, MinecraftPort } from "../minecraft/minecraftPort.js";
import type { OwnerIdentityAccess, OwnerIdentitySnapshot } from "../identity/ownerIdentity.js";
import { ConfirmationStore } from "../safety/confirmationStore.js";
import type { SafetyContext } from "../safety/safetyEngine.js";
import {
  effectiveTaskLimits,
  HARD_TASK_LIMITS,
  type TaskLease,
  type TaskLimits,
  type TaskStopReason,
} from "../safety/taskBudget.js";
import type { RuntimeAuthorityLoss } from "../runtime/runtimeEvents.js";
import { isUnsolicitedActivityAllowed } from "../profile/behaviorPolicy.js";
import type { CompanionProfile } from "../profile/profileSchema.js";
import type { FarmingPreferenceAccess } from "../profile/farmingPreferenceStore.js";
import {
  buildCompanionAutonomousTurn,
  buildCompanionRecoveryTurn,
  buildCompanionTaskExecutionTurn,
  companionTaskExecutionOutcomeSchema,
  companionTurnOutcomeSchema,
  type CompanionTurnOutcome,
  type ProactiveKind,
} from "./promptBuilder.js";
import {
  buildOwnerIntentTurn,
  ownerIntentRepairPrompt,
  parseOwnerIntentDecision,
  type IntentMemoryCandidate,
  type OwnerIntentDecision,
} from "./intentRouter.js";
import { ChatRouter } from "./chatRouter.js";
import {
  FarmingPermissionCoordinator,
  type FarmingPermissionResult,
} from "./farmingPermissionCoordinator.js";
import { TaskController, type ActiveTask, type TaskDisclosure } from "./taskController.js";

const repairPrompt = "只返回符合既定结构的 JSON，不要使用 Markdown。";
const recoveryRepairPrompt = [
  repairPrompt,
  "Recovery turns do not authorize Minecraft tools.",
  "Do not call any minecraft_ tool during recovery.",
].join("\n");
const autonomousRepairPrompt = [
  repairPrompt,
  "Unsolicited autonomous turns must return task as null.",
  "Do not propose or persist a task, project, world mutation, or high-risk action.",
].join("\n");
function balancedRepairPrompt(allowedKinds: readonly ProactiveKind[]): string {
  const allowed =
    allowedKinds.length === 1
      ? JSON.stringify(allowedKinds[0])
      : allowedKinds.map((kind) => JSON.stringify(kind)).join(" or ");
  return [
    repairPrompt,
    `proactiveKind must be ${allowed}.`,
    "Balanced unsolicited turns must return task as null and must not use Minecraft tools.",
  ].join("\n");
}
const unavailableMessage =
  "Codex 暂时不可用，我已安全暂停。你仍可以使用 !status、!stop 和记忆命令。";

const intentClarificationMessage = "你希望我陪你聊聊天，还是要我在游戏里做一件事？";
const taskFailureMessage = "这次没能完成，请再试一次。";
const farmingPermissionQuestion = "我可以在这里种小麦吗？";
const farmingFallbackConstraint = "不得新建农田，寻找现成的成熟小麦";
const farmingMutationKinds = new Set(["till_soil", "plant_crop"] as const);
const filteredModelReply = "好，我知道了。";
const ambiguousNaturalToolNames = new Set<ToolActionKind>(["say", "jump", "wait"]);
const ambiguousNaturalToolNamePattern = [...ambiguousNaturalToolNames].join("|");
const bareInternalToolNamePattern = new RegExp(
  `\\b(?:${TOOL_ACTION_KINDS.filter((name) => !ambiguousNaturalToolNames.has(name)).join("|")})\\b`,
  "iu",
);
const ambiguousToolInvocationPattern = new RegExp(
  `(?:\`\\s*(?:${ambiguousNaturalToolNamePattern})\\s*\`)|(?:(?:\\b(?:call|invoke|execute|tool|action)\\b|(?:准备|将要|正在)?\\s*(?:调用|执行)|工具)[^\\r\\n.!?。！？]{0,32}\\b(?:${ambiguousNaturalToolNamePattern})\\b)`,
  "iu",
);
const internalModelMetadataPattern =
  /任务披露|minecraft_[a-z0-9_]+|工具调用|预算|租约|停止条件|expectedActions|allowedActions|maxToolCalls|maxBlockChanges|maxHorizontalTravel|maxDurationMs|maxDangerousOperations|leaseId|stopCondition/iu;
const transportFailureThreshold = 3;

function containsInternalModelDisclosure(reply: string): boolean {
  return (
    internalModelMetadataPattern.test(reply) ||
    bareInternalToolNamePattern.test(reply) ||
    ambiguousToolInvocationPattern.test(reply)
  );
}

export type CodexFailureScope = "turn" | "service";

const authenticationErrorNames = new Set([
  "AuthenticationError",
  "CodexAuthenticationError",
  "UnauthorizedError",
]);
const authenticationErrorCodes = new Set([
  "AUTHENTICATION_REQUIRED",
  "AUTH_REQUIRED",
  "UNAUTHORIZED",
]);
const serviceTerminationErrorNames = new Set([
  "CodexProcessExitError",
  "CodexServiceTerminatedError",
]);
const serviceTerminationErrorCodes = new Set(["CODEX_PROCESS_EXITED", "CODEX_SERVICE_TERMINATED"]);
const transportErrorNames = new Set(["CodexTransportError"]);
const transportErrorCodes = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"]);

function errorName(error: unknown): string {
  return error instanceof Error && error.name.length > 0 ? error.name : "unknown";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function isAuthenticationFailure(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    authenticationErrorNames.has(errorName(error)) ||
    authenticationErrorCodes.has(errorCode(error) ?? "") ||
    message === "chatgpt authentication is required" ||
    message === "authentication required" ||
    message === "unauthorized"
  );
}

function isServiceTermination(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    serviceTerminationErrorNames.has(errorName(error)) ||
    serviceTerminationErrorCodes.has(errorCode(error) ?? "") ||
    message === "process exited" ||
    message === "codex app server exited" ||
    message.startsWith("codex app server exited (") ||
    message === "codex app server stopped" ||
    message === "codex app server is stopped" ||
    message === "codex app-server stdout line exceeded the byte limit"
  );
}

function isTransportFailure(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    transportErrorNames.has(errorName(error)) ||
    transportErrorCodes.has(errorCode(error) ?? "") ||
    message === "transport failed" ||
    message === "model transport rejected" ||
    message.startsWith("codex transport ") ||
    message === "codex app-server request failed" ||
    message.startsWith("codex app-server request timed out:") ||
    message === "codex turn timed out"
  );
}

export function codexFailureScope(
  error: unknown,
  consecutiveTransportFailures: number,
): CodexFailureScope {
  if (isAuthenticationFailure(error) || isServiceTermination(error)) return "service";
  if (isTransportFailure(error) && consecutiveTransportFailures >= transportFailureThreshold) {
    return "service";
  }
  return "turn";
}

function attachToolLease(
  text: string,
  lease: string,
  taskLeaseId?: string,
  allowedToolActions?: readonly ToolActionKind[],
): string {
  return [
    text,
    "本回合工具租约",
    ...(allowedToolActions === undefined
      ? []
      : [
          `本回合只授权这些低风险 minecraft_ 动作：${allowedToolActions.join("、")}。其他动作会被本地拒绝。`,
        ]),
    ...(taskLeaseId === undefined
      ? []
      : [`本次有界任务租约 ID 为 ${JSON.stringify(taskLeaseId)}。`]),
    `每次 minecraft_ 工具调用都必须把 turnLease 设置为 ${JSON.stringify(lease)}。`,
    "这个随机租约只授权本回合；不要在回复、任务或记忆候选中复述它。",
  ].join("\n");
}

const autonomousMicroToolActions = [
  "get_state",
  "find_block",
  "say",
  "look_at",
  "jump",
  "wait",
] as const satisfies readonly ToolActionKind[];

function autonomousMicroTaskDisclosure(reason: AutonomyReason): TaskDisclosure {
  return {
    goal: `自主微任务：${reason}`,
    expectedActions: [...autonomousMicroToolActions],
    limits: {
      maxToolCalls: 8,
      maxBlockChanges: 0,
      maxHorizontalTravel: 0,
      maxDurationMs: 60_000,
      maxDangerousOperations: 0,
    },
    stopCondition: "完成一次低风险观察、交流、转向、跳跃或等待后立即停止。",
  };
}

type CompanionTaskExecutionOutcome = ReturnType<typeof companionTaskExecutionOutcomeSchema.parse>;
type ValidatedTaskDecision = Extract<
  OwnerIntentDecision,
  { kind: "start_task" | "continue_task" | "priority_task" | "replace_task" }
>;
type FarmingPermissionDecision = Extract<
  OwnerIntentDecision,
  {
    kind: "grant_farming_permission" | "deny_farming_permission" | "revoke_farming_permission";
  }
>;
type TaskControlDecision =
  ValidatedTaskDecision | Extract<OwnerIntentDecision, { kind: "stop_task" }>;

const taskLimitKeys = [
  "maxToolCalls",
  "maxBlockChanges",
  "maxHorizontalTravel",
  "maxDurationMs",
  "maxDangerousOperations",
] as const satisfies readonly (keyof TaskLimits)[];

function canReuseTaskAuthority(decision: ValidatedTaskDecision, task: ActiveTask): boolean {
  const currentActions = new Set(task.disclosure.expectedActions);
  if (!decision.task.allowedActions.every((action) => currentActions.has(action))) return false;
  const requestedLimits = effectiveTaskLimits(decision.task.requestedLimits);
  return taskLimitKeys.every((key) => requestedLimits[key] <= task.disclosure.limits[key]);
}

function memoryValidationSource(
  outcome: Pick<CompanionTurnOutcome, "reply" | "memoryCandidates"> & {
    task?: CompanionTurnOutcome["task"];
  },
  ownerText?: string,
): MemoryValidationSource {
  const task = outcome.task;
  const modelText = [
    outcome.reply,
    task?.goal,
    task?.allowedActions.join(" "),
    task?.successCondition,
    task?.stopCondition,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  return {
    ...(ownerText === undefined ? {} : { ownerText }),
    ...(modelText.length === 0 ? {} : { modelText }),
  };
}

export interface CompanionServiceDependencies {
  minecraft: MinecraftPort;
  codex: CodexPort;
  mode: ModeManager;
  memories: MemoryStore | ScopedMemoryStore;
  memoryMigration?: MemoryMigration;
  state: StateStore;
  confirmations: ConfirmationStore;
  executor: ActionExecutor;
  actionQueue: CompanionActionQueue;
  actionRunner: QueuedActionRunner;
  farmingPreference: FarmingPreferenceAccess;
  budget: TurnToolBudget;
  taskController: TaskController;
  autonomy: CompanionAutonomyScheduler;
  safetyContextProvider: () => Promise<SafetyContext>;
  ownerUsername: () => string;
  ownerIdentity?: Pick<OwnerIdentityAccess, "snapshot" | "setPresence">;
  chatRouter: ChatRouter;
  cwd: string;
  preferredModel: string;
  reasoningEffort: string;
  onAuthorityLost?: (event: RuntimeAuthorityLoss) => void;
  requestedTaskLimits?: Partial<TaskLimits>;
  logger?: Pick<SafeLogger, "error">;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  setFarmingPermissionTimer?: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  clearFarmingPermissionTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  confirmationNow?: () => Date;
  setConfirmationTimer?: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  clearConfirmationTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  compatibilityVerified?: () => boolean | Promise<boolean>;
  safetyPresetAllows?: () => boolean | Promise<boolean>;
}

export interface CompanionAutonomyScheduler {
  start(): void;
  stop(): void;
  notifyModeChanged(): void;
  notifyGoalCompleted(): void;
  notifyActionFailed(): void;
  notifyThreat(): void;
  canChatProactively(): boolean;
  canSendProactively(kind: ProactiveKind): boolean;
  markProactiveChat(): void;
}

interface ActiveTurn {
  generation: number;
  threadId: string;
  turnId?: string;
  cancel(): void;
}

interface CodexThreadPair {
  readonly intentThreadId: string;
  readonly executionThreadId: string;
}

interface IntentStamp {
  readonly generation: number;
  readonly messageSequence: number;
  readonly ownerRevision: number;
  readonly worldGeneration: number;
  readonly taskLeaseAtDispatch: Readonly<TaskLease> | null;
  readonly farmingPermissionEpochAtDispatch: number | undefined;
  readonly threadPair: CodexThreadPair;
}

interface SuspendedTaskGoal {
  readonly taskLease: Readonly<TaskLease>;
  readonly disclosure: TaskDisclosure;
}

const noOpLogger: Pick<SafeLogger, "error"> = { error: async () => undefined };

function splitForMinecraft(reply: string, maxLength = 240): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of reply) {
    if (chunk.length > 0 && chunk.length + character.length > maxLength) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function compactTask(outcome: CompanionTurnOutcome): string | null {
  if (!outcome.task || outcome.task.status !== "active") return null;
  return JSON.stringify({
    goal: outcome.task.goal,
    success: outcome.task.successCondition,
    stop: outcome.task.stopCondition,
  });
}

function taskLeaseKey(taskLease: TaskLease): string {
  return `${taskLease.id}\u0000${taskLease.startedAt}`;
}

function sameTaskLease(first: TaskLease, second: TaskLease): boolean {
  return first.id === second.id && first.startedAt === second.startedAt;
}

function cloneTaskDisclosure(disclosure: TaskDisclosure): TaskDisclosure {
  return {
    goal: disclosure.goal,
    expectedActions: [...disclosure.expectedActions],
    limits: { ...disclosure.limits },
    stopCondition: disclosure.stopCondition,
  };
}

export class CompanionService {
  private readonly logger: Pick<SafeLogger, "error">;
  private readonly setTimer: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly confirmationNow: () => Date;
  private readonly setConfirmationTimer: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearConfirmationTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly farmingPermissionCoordinator: FarmingPermissionCoordinator;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeActionResult: (() => void) | undefined;
  private mergeTimer: ReturnType<typeof setTimeout> | undefined;
  private confirmationExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  private mergedMessages: string[] = [];
  private generation = 0;
  private messageSequence = 0;
  private worldGeneration = 0;
  private running = false;
  private starting = false;
  private ownerChangedDuringStartup = false;
  private intentThreadId: string | undefined;
  private executionThreadId: string | undefined;
  private selectedModel: string | undefined;
  private selectedReasoningEffort: string | undefined;
  private codexHealthy = true;
  private consecutiveTransportFailures = 0;
  private readonly activeIntentTurns = new Set<ActiveTurn>();
  private activeExecutionTurn: ActiveTurn | undefined;
  private intentTurnTail: Promise<void> = Promise.resolve();
  private executionTurnTail: Promise<void> = Promise.resolve();
  private confirmationTail: Promise<void> = Promise.resolve();
  private modelSwitchTail: Promise<void> = Promise.resolve();
  private recoveryFlight: Promise<void> | undefined;
  private unfinishedTaskSummary: string | null = null;
  private readonly startupEvents: MinecraftEvent[] = [];
  private turnWorkCount = 0;
  private autonomousRequestCount = 0;
  private externallyManagedCodex = false;
  private reportedModelAuthorityLossGeneration: number | undefined;
  private worldInvalidated = false;
  private memoryScope: { mode: "global" | "world" | "layered"; worldId?: string } = {
    mode: "global",
  };
  private locallyContainedTaskLeaseKey: string | undefined;
  private readonly pendingConfirmationTerminalReasons = new Map<string, "failed" | "owner_stop">();
  private readonly suspendedTaskGoals: SuspendedTaskGoal[] = [];
  private preservedTerminalLeaseKey: string | undefined;

  constructor(private readonly dependencies: CompanionServiceDependencies) {
    this.logger = dependencies.logger ?? noOpLogger;
    this.setTimer = dependencies.setTimer ?? setTimeout;
    this.clearTimer = dependencies.clearTimer ?? clearTimeout;
    this.confirmationNow = dependencies.confirmationNow ?? (() => new Date());
    this.setConfirmationTimer = dependencies.setConfirmationTimer ?? setTimeout;
    this.clearConfirmationTimer = dependencies.clearConfirmationTimer ?? clearTimeout;
    this.farmingPermissionCoordinator = new FarmingPermissionCoordinator({
      actionQueue: dependencies.actionQueue,
      executionContext: () => this.queueExecutionContext(),
      ...(dependencies.setFarmingPermissionTimer === undefined
        ? {}
        : { setTimer: dependencies.setFarmingPermissionTimer }),
      ...(dependencies.clearFarmingPermissionTimer === undefined
        ? {}
        : { clearTimer: dependencies.clearFarmingPermissionTimer }),
    });
    dependencies.taskController.onTerminal((reason, forceCleanup, task) =>
      this.handleTaskTerminal(reason, forceCleanup, task.lease),
    );
    dependencies.confirmations.onGameActionsChanged(() => this.scheduleConfirmationExpiry());
    dependencies.confirmations.onGameActionsExpired((taskLease) =>
      this.queueFailedConfirmation(taskLease),
    );
  }

  /** Memory scope only changes future prompts; it never changes the Minecraft connection. */
  setMemoryScope(scope: { mode: "global" | "world" | "layered"; worldId?: string }): void {
    if (
      (scope.mode === "world" || scope.mode === "layered") &&
      (typeof scope.worldId !== "string" || scope.worldId.length === 0)
    ) {
      throw new Error("world id is required");
    }
    if (scope.mode === "global" && scope.worldId !== undefined) {
      throw new Error("global memory scope cannot include a world id");
    }
    this.memoryScope = { ...scope };
    this.invalidateCurrentTurn();
  }

  getMemoryScope(): { mode: "global" | "world" | "layered"; worldId?: string } {
    return { ...this.memoryScope };
  }

  private searchMemories(query: string) {
    const memories = this.dependencies.memories;
    return memories instanceof ScopedMemoryStore
      ? memories.search(query, this.memoryScope)
      : memories.search(query);
  }

  private async startThreadPair(selection: ResolvedModelSelection): Promise<CodexThreadPair> {
    let intentThreadId: string | undefined;
    try {
      intentThreadId = await this.dependencies.codex.startThread({
        cwd: this.dependencies.cwd,
        model: selection.modelId,
        reasoningEffort: selection.reasoningEffort,
        toolAccess: "none",
      });
      const executionThreadId = await this.dependencies.codex.startThread({
        cwd: this.dependencies.cwd,
        model: selection.modelId,
        reasoningEffort: selection.reasoningEffort,
        toolAccess: "minecraft",
      });
      return Object.freeze({ intentThreadId, executionThreadId });
    } catch (error) {
      if (intentThreadId !== undefined) {
        await this.rollbackStagedThreads([intentThreadId], error);
      }
      throw error;
    }
  }

  private async rollbackStagedThreadPair(pair: CodexThreadPair, cause: unknown): Promise<never> {
    return this.rollbackStagedThreads([pair.intentThreadId, pair.executionThreadId], cause);
  }

  private async rollbackStagedThreads(
    threadIds: readonly string[],
    cause: unknown,
  ): Promise<never> {
    const results = await Promise.allSettled(
      threadIds.map(async (threadId) => this.dependencies.codex.closeThread(threadId)),
    );
    const cleanupFailures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [cause, ...cleanupFailures],
        "Companion model switch rollback failed",
      );
    }
    throw cause;
  }

  private async retireThreadPair(pair: CodexThreadPair): Promise<void> {
    await Promise.all([
      this.retireThread(pair.intentThreadId),
      this.retireThread(pair.executionThreadId),
    ]);
  }

  private async retireThread(threadId: string): Promise<void> {
    try {
      await this.dependencies.codex.closeThread(threadId);
    } catch (error) {
      try {
        await this.logger.error("codex_thread_retire_failed", {
          code: "thread_archive_failed",
        });
      } catch {
        // Thread retirement diagnostics cannot change the active authority.
      }
    }
  }

  private currentThreadPair(): CodexThreadPair | undefined {
    if (!this.intentThreadId || !this.executionThreadId) return undefined;
    return Object.freeze({
      intentThreadId: this.intentThreadId,
      executionThreadId: this.executionThreadId,
    });
  }

  private publishThreadPair(pair: CodexThreadPair, selection: ResolvedModelSelection): void {
    this.intentThreadId = pair.intentThreadId;
    this.executionThreadId = pair.executionThreadId;
    this.selectedModel = selection.modelId;
    this.selectedReasoningEffort = selection.reasoningEffort;
  }

  async start(preselectedModel?: string): Promise<void> {
    if (this.running || this.starting) throw new Error("CompanionService is already started");
    this.starting = true;
    this.ownerChangedDuringStartup = false;
    this.externallyManagedCodex = preselectedModel !== undefined;
    const generation = ++this.generation;
    try {
      this.unsubscribe = this.dependencies.minecraft.onEvent((event) => {
        if (this.starting) {
          this.startupEvents.push(event);
          return;
        }
        void this.handleEvent(event).catch((error: unknown) => {
          void this.logger.error("companion_event_failed", { code: String(error) });
        });
      });
      await this.dependencies.memoryMigration?.migrateLegacyOnce();
      const persisted = await this.dependencies.state.load();
      if (generation !== this.generation) return;
      this.dependencies.confirmations.clear();
      this.dependencies.executor.stopAll();
      this.dependencies.actionRunner.start();
      this.dependencies.mode.resetModeFromProfile();
      this.dependencies.mode.completeTask();
      this.unfinishedTaskSummary = persisted.unfinishedTaskSummary;
      this.worldInvalidated = persisted.worldInvalidated;
      if (this.ownerChangedDuringStartup || this.worldInvalidated || this.unfinishedTaskSummary) {
        this.dependencies.mode.pause();
      } else this.dependencies.mode.resume();

      if (preselectedModel === undefined) {
        await this.dependencies.codex.start();
        const available = await this.dependencies.codex.listModels();
        this.selectedModel = selectModel(available, this.dependencies.preferredModel);
      } else {
        this.selectedModel = preselectedModel;
      }
      const selection = Object.freeze({
        modelId: this.selectedModel,
        reasoningEffort: this.dependencies.reasoningEffort,
      });
      const pair = await this.startThreadPair(selection);
      if (generation !== this.generation) {
        await this.retireThreadPair(pair);
        await this.closeStaleCodex(generation);
        return;
      }
      this.publishThreadPair(pair, selection);
      this.consecutiveTransportFailures = 0;
      this.codexHealthy = this.unfinishedTaskSummary === null;
      this.running = true;
      void this.refreshOwnerPresence();
      this.scheduleConfirmationExpiry();
      this.unsubscribeActionResult = this.dependencies.executor.onResult((result) => {
        if (!this.running || result.status !== "failed") return;
        try {
          this.dependencies.autonomy.notifyActionFailed();
        } catch {
          // Scheduler observation must never affect the action result.
        }
        // A live execution turn receives the failed tool result and can recover safely.
        // Fail closed only when no model turn is present to handle the action outcome.
        if (this.activeExecutionTurn !== undefined) return;
        if (this.dependencies.taskController.current() === null) return;
        const error = new Error();
        error.name = "MinecraftToolError";
        void this.failTaskOnly(this.generation, error, taskFailureMessage).catch(
          (failure: unknown) =>
            this.logger.error("task_failure_containment_failed", {
              code: errorName(failure),
            }),
        );
      });
      this.dependencies.autonomy.start();
      while (this.startupEvents.length > 0) {
        const event = this.startupEvents.shift();
        if (event) await this.handleEvent(event);
      }
      // This transition must remain synchronous with the empty check above.
      this.starting = false;
    } catch (error) {
      this.running = false;
      this.intentThreadId = undefined;
      this.executionThreadId = undefined;
      this.startupEvents.splice(0);
      this.dependencies.autonomy.stop();
      this.unsubscribeActionResult?.();
      this.unsubscribeActionResult = undefined;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      if (!this.externallyManagedCodex) {
        await this.dependencies.codex.stop().catch(() => undefined);
      }
      throw error;
    } finally {
      this.starting = false;
      this.ownerChangedDuringStartup = false;
    }
  }

  switchModel(
    selection: ResolvedModelSelection,
    commitPreference: () => Promise<void>,
  ): Promise<void> {
    const queued = this.modelSwitchTail.then(() =>
      this.performModelSwitch(selection, commitPreference),
    );
    this.modelSwitchTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  actionCapabilityLost(): void {
    if (!this.running || !this.codexHealthy) return;
    const failedTask = this.dependencies.taskController.current();
    if (failedTask) this.locallyContainedTaskLeaseKey = taskLeaseKey(failedTask.lease);
    this.codexHealthy = false;
    this.dependencies.taskController.stop("failed");
    this.dependencies.confirmations.clear();
    this.dependencies.executor.stopAll();
    this.dependencies.budget.end();
    this.dependencies.mode.pause();
    this.dependencies.autonomy.stop();
    this.invalidateCurrentTurn();
    this.intentThreadId = undefined;
    this.executionThreadId = undefined;
    this.unfinishedTaskSummary = null;
    void this.persist().catch((error: unknown) =>
      this.logger.error("action_authority_state_save_failed", { code: errorName(error) }),
    );
  }

  private async performModelSwitch(
    selection: ResolvedModelSelection,
    commitPreference: () => Promise<void>,
  ): Promise<void> {
    if (!this.running) throw new Error("CompanionService is not running");
    if (!this.codexHealthy) throw new Error("Codex is unavailable");
    const previousPair = this.currentThreadPair();
    if (!previousPair || !this.selectedModel || !this.selectedReasoningEffort) {
      throw new Error("Companion model authority is unavailable");
    }

    this.dependencies.taskController.stop("model_changed");
    this.invalidateCurrentTurn();
    this.dependencies.budget.end();
    const generation = this.generation;
    const stagedPair = await this.startThreadPair(selection);
    if (!this.isCurrent(generation) || !this.codexHealthy) {
      await this.rollbackStagedThreadPair(
        stagedPair,
        new Error("Companion model authority changed during switch"),
      );
    }
    try {
      await commitPreference();
    } catch (error) {
      await this.rollbackStagedThreadPair(stagedPair, error);
    }
    if (!this.isCurrent(generation) || !this.codexHealthy) {
      await this.rollbackStagedThreadPair(
        stagedPair,
        new Error("Companion model authority changed during switch"),
      );
    }

    this.publishThreadPair(stagedPair, selection);
    await this.retireThreadPair(previousPair);
  }

  async stop(): Promise<void> {
    if (!this.running && !this.starting) return;
    this.running = false;
    this.generation += 1;
    this.clearConfirmationExpiry();
    this.dependencies.autonomy.stop();
    this.unsubscribeActionResult?.();
    this.unsubscribeActionResult = undefined;
    this.clearMergedMessages();
    this.startupEvents.splice(0);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.dependencies.taskController.stop("process_exit");
    this.dependencies.executor.stopAll();
    this.dependencies.confirmations.clear();
    const hasActiveRecoveryTurn =
      this.recoveryFlight !== undefined &&
      (this.activeIntentTurns.size > 0 || this.activeExecutionTurn !== undefined);
    this.interruptActive();
    this.activeExecutionTurn = undefined;
    this.intentThreadId = undefined;
    this.executionThreadId = undefined;
    const intentTail = this.intentTurnTail;
    const executionTail = this.executionTurnTail;
    const recovery = this.recoveryFlight;
    const confirmation = this.confirmationTail.catch(() => undefined);
    const stoppingCodex = this.externallyManagedCodex
      ? Promise.resolve()
      : this.dependencies.codex
          .stop()
          .catch((error: unknown) =>
            this.logger.error("codex_stop_failed", { code: String(error) }),
          );
    const pendingWork =
      this.externallyManagedCodex && recovery && !hasActiveRecoveryTurn
        ? [confirmation]
        : [
            intentTail.catch(() => undefined),
            executionTail.catch(() => undefined),
            recovery?.catch(() => undefined),
            confirmation,
          ];
    await Promise.all([...pendingWork, stoppingCodex]);
  }

  applyProfile(profile: CompanionProfile): void {
    const previousMode = this.dependencies.mode.getMode();
    const previousSettings = this.dependencies.mode.getModeSettings();
    this.dependencies.mode.applyProfile(profile);
    const nextMode = this.dependencies.mode.getMode();
    const nextSettings = this.dependencies.mode.getModeSettings();
    const modeAuthority = { friend: 0, balanced: 1, autonomous: 2 } as const;
    const restrictionsTightened =
      modeAuthority[nextMode] < modeAuthority[previousMode] ||
      (previousMode === "balanced" &&
        nextMode === "balanced" &&
        ((previousSettings.allowProactiveChat && !nextSettings.allowProactiveChat) ||
          (previousSettings.allowSuggestions && !nextSettings.allowSuggestions))) ||
      (previousMode === "autonomous" &&
        nextMode === "autonomous" &&
        previousSettings.allowLowRiskMicroActions &&
        !nextSettings.allowLowRiskMicroActions);
    const hasLiveAutonomousAuthority =
      this.autonomousRequestCount > 0 || this.dependencies.taskController.current() !== null;
    if (restrictionsTightened && hasLiveAutonomousAuthority) {
      try {
        this.dependencies.taskController.stop("owner_stop");
      } finally {
        this.dependencies.budget.end();
        try {
          this.dependencies.executor.stopAll();
        } finally {
          this.invalidateCurrentTurn();
          this.dependencies.mode.completeTask();
          this.unfinishedTaskSummary = null;
        }
      }
      void this.persist().catch((error: unknown) =>
        this.logger.error("profile_restriction_state_save_failed", { code: String(error) }),
      );
    }
    try {
      this.dependencies.autonomy.notifyModeChanged();
    } catch {
      // Profile authority has already been applied and cannot be weakened by observers.
    }
  }

  ownerIdentityChanged(_snapshot: OwnerIdentitySnapshot): void {
    this.dependencies.taskController.stop("owner_changed");
    this.dependencies.confirmations.clear();
    this.dependencies.executor.stopAll();
    if (this.starting && !this.running) this.invalidateStartupOwnerWork();
    else this.invalidateCurrentTurn();
    this.dependencies.mode.pause();
    void this.refreshOwnerPresence();
  }

  private async handleEvent(event: MinecraftEvent): Promise<void> {
    if (!this.running) return;
    if (
      event.kind === "connected" ||
      event.kind === "disconnected" ||
      event.kind === "world_changed"
    ) {
      this.worldGeneration += 1;
    }
    if (event.kind === "chat") {
      const route = this.dependencies.chatRouter.route(event);
      if (route.kind === "ignore") return;
      if (route.kind === "command") {
        await this.handleCommand(route.command);
        return;
      }
      this.onOwnerMessage(route.text);
      return;
    }
    if (event.kind === "owner_online" || event.kind === "owner_offline") {
      if (event.username !== this.dependencies.ownerUsername()) return;
      this.setOwnerPresence(event.kind === "owner_online" ? "online" : "offline");
      if (event.kind === "owner_online") return;
      this.dependencies.taskController.stop("disconnect");
      this.invalidateCurrentTurn();
      this.dependencies.confirmations.clear();
      this.dependencies.executor.stopAll();
      this.dependencies.mode.pause();
      await this.persist();
      return;
    }
    if (event.kind === "hostile_nearby") {
      this.dependencies.autonomy.notifyThreat();
      return;
    }
    if (event.kind === "world_changed") {
      this.worldInvalidated = true;
      this.dependencies.taskController.stop("world_changed");
      this.invalidateCurrentTurn();
      this.dependencies.confirmations.clear();
      this.dependencies.executor.stopAll();
      this.dependencies.mode.stop();
      this.unfinishedTaskSummary = null;
      this.dependencies.autonomy.notifyModeChanged();
      await this.persist();
      return;
    }
    if (event.kind === "death" || event.kind === "disconnected") {
      this.dependencies.taskController.stop("disconnect");
      this.invalidateCurrentTurn();
      this.dependencies.confirmations.clear();
      this.dependencies.executor.stopAll();
      this.dependencies.mode.pause();
      await this.persist();
      return;
    }
    if (event.kind === "connected") {
      void this.refreshOwnerPresence();
      this.dependencies.confirmations.clear();
      this.dependencies.taskController.stop("disconnect");
      this.dependencies.executor.stopAll();
      this.dependencies.mode.resetModeFromProfile();
      this.dependencies.autonomy.notifyModeChanged();
      this.dependencies.mode.completeTask();
      if (this.worldInvalidated || this.unfinishedTaskSummary) this.dependencies.mode.pause();
      else this.dependencies.mode.resume();
      await this.persist();
    }
  }

  private onOwnerMessage(message: string): void {
    const activeTask = this.dependencies.taskController.current();
    if (activeTask) this.dependencies.actionRunner.suspend(activeTask.lease, "owner_message");
    if (!this.codexHealthy || this.currentThreadPair() === undefined) return;
    this.mergedMessages.push(message);
    if (this.mergeTimer !== undefined) return;
    const expectedGeneration = this.generation;
    this.mergeTimer = this.setTimer(() => {
      this.mergeTimer = undefined;
      const combined = this.mergedMessages.splice(0).join("\n");
      if (combined) {
        this.messageSequence += 1;
        this.enqueueTurn(combined, expectedGeneration, this.captureIntentStamp());
      }
    }, 750);
  }

  private enqueueTurn(text: string, generation: number, capturedStamp: Promise<IntentStamp>): void {
    this.interruptIntentTurns();
    this.intentTurnTail = this.intentTurnTail
      .catch(() => undefined)
      .then(() => this.performTurn(text, generation, capturedStamp))
      .catch((error: unknown) =>
        this.logger.error("companion_turn_failed", { code: String(error) }),
      );
  }

  private async performTurn(
    text: string,
    generation: number,
    capturedStamp: Promise<IntentStamp>,
  ): Promise<void> {
    try {
      this.turnWorkCount += 1;
      if (
        !this.isCurrent(generation) ||
        !this.intentThreadId ||
        !this.executionThreadId ||
        this.dependencies.mode.snapshot().paused
      )
        return;
      const stamp = await capturedStamp;
      if (stamp.generation !== generation || !this.isIntentCurrent(stamp)) return;
      await this.routeOwnerMessage(text, stamp);
    } finally {
      this.turnWorkCount -= 1;
    }
  }

  private async routeOwnerMessage(text: string, stamp: IntentStamp): Promise<void> {
    const decision = await this.resolveOwnerIntent(text, stamp);
    if (!decision || !this.isIntentCurrent(stamp)) return;
    switch (decision.kind) {
      case "chat":
        await this.persistIntentMemories(decision.memoryCandidates, text, stamp);
        if (this.isIntentCurrent(stamp))
          await this.sendOutcomeReply(decision.reply, stamp.generation, false);
        if (this.isIntentCurrent(stamp)) this.queueCurrentTaskReplan(stamp);
        return;
      case "clarify":
        if (this.isIntentCurrent(stamp)) {
          await this.sendOutcomeReply(decision.question, stamp.generation, false);
        }
        return;
      case "grant_farming_permission":
      case "deny_farming_permission":
      case "revoke_farming_permission":
        await this.applyFarmingPermissionDecision(decision, stamp);
        return;
      default:
        await this.applyTaskDecision(decision, text, stamp);
    }
  }

  private async applyFarmingPermissionDecision(
    decision: FarmingPermissionDecision,
    stamp: IntentStamp,
  ): Promise<void> {
    if (!this.isIntentCurrent(stamp)) return;
    const permissionEpoch = stamp.farmingPermissionEpochAtDispatch;
    const answersActiveTicket =
      permissionEpoch !== undefined &&
      this.farmingPermissionCoordinator.isPendingEpoch(permissionEpoch);
    switch (decision.kind) {
      case "grant_farming_permission":
        if (
          !answersActiveTicket &&
          this.dependencies.farmingPreference.snapshot().status !== "denied"
        ) {
          return;
        }
        await this.dependencies.farmingPreference.setAllowed(
          () =>
            this.isIntentCurrent(stamp) &&
            (answersActiveTicket
              ? this.farmingPermissionCoordinator.isPendingEpoch(permissionEpoch!)
              : this.dependencies.farmingPreference.snapshot().status === "denied"),
        );
        if (!this.isIntentCurrent(stamp)) return;
        if (
          answersActiveTicket &&
          !this.farmingPermissionCoordinator.resolve("allowed", permissionEpoch)
        ) {
          return;
        }
        if (decision.reply) await this.sendOutcomeReply(decision.reply, stamp.generation, false);
        if (this.isIntentCurrent(stamp)) {
          this.queueFarmingPermissionReplan(stamp, "小麦种植权限已明确允许，请重新观察后规划。");
        }
        return;
      case "deny_farming_permission":
        if (!answersActiveTicket) return;
        if (!this.farmingPermissionCoordinator.resolve("denied", permissionEpoch)) return;
        if (decision.reply) await this.sendOutcomeReply(decision.reply, stamp.generation, false);
        if (this.isIntentCurrent(stamp)) {
          this.queueFarmingPermissionReplan(stamp, farmingFallbackConstraint);
        }
        return;
      case "revoke_farming_permission": {
        await this.dependencies.farmingPreference.setDenied();
        if (!this.isIntentCurrent(stamp)) return;
        this.farmingPermissionCoordinator.cancel("permission revoked");
        const task = this.dependencies.taskController.current();
        if (task) {
          this.dependencies.actionQueue.cancelKinds(
            task.lease,
            farmingMutationKinds,
            "farming permission revoked",
          );
        }
        if (decision.reply) await this.sendOutcomeReply(decision.reply, stamp.generation, false);
        if (this.isIntentCurrent(stamp)) {
          this.queueFarmingPermissionReplan(stamp, farmingFallbackConstraint);
        }
      }
    }
  }

  private async resolveOwnerIntent(
    text: string,
    stamp: IntentStamp,
  ): Promise<OwnerIntentDecision | undefined> {
    let prompt: string;
    try {
      const activeTask = this.dependencies.taskController.current();
      prompt = buildOwnerIntentTurn({
        ownerMessage: text,
        mode: this.dependencies.mode.getMode(),
        profile: this.dependencies.mode.getProfile(),
        world: await this.dependencies.minecraft.snapshot(this.dependencies.ownerUsername()),
        memories: (await this.searchMemories(text)).slice(0, 8),
        activeTask: activeTask
          ? {
              goal: activeTask.disclosure.goal,
              allowedActions: activeTask.disclosure.expectedActions,
              limits: activeTask.disclosure.limits,
            }
          : null,
        farmingPermission: {
          status: this.dependencies.farmingPreference.snapshot().status,
          pending: this.farmingPermissionCoordinator.isPending(),
        },
      });
    } catch (error) {
      if (this.isIntentCurrent(stamp)) {
        await this.failTaskOnly(stamp.generation, error, taskFailureMessage);
      }
      return undefined;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.sendAttempt(
        "intent",
        attempt === 0 ? prompt : ownerIntentRepairPrompt,
        stamp.generation,
        true,
        undefined,
        false,
        undefined,
        () => this.isIntentCurrent(stamp),
        stamp.threadPair,
      );
      if (!result || !this.isIntentCurrent(stamp)) return undefined;
      try {
        return parseOwnerIntentDecision(this.parseJson(result.text));
      } catch {
        // One context-free schema-repair turn is allowed before natural clarification.
      }
    }
    if (!this.isIntentCurrent(stamp)) return undefined;
    try {
      await this.logger.error("intent_invalid_structure", { code: "invalid_structure" });
    } catch {
      // Diagnostic observers cannot suppress the fixed clarification.
    }
    if (this.isIntentCurrent(stamp)) await this.say(intentClarificationMessage);
    return undefined;
  }

  private async persistIntentMemories(
    memoryCandidates: readonly IntentMemoryCandidate[],
    ownerText: string,
    stamp: IntentStamp,
  ): Promise<void> {
    const candidates = memoryCandidates
      .filter((candidate) => candidate.importance >= 3)
      .map((candidate) => ({ ...candidate }));
    if (candidates.length === 0) return;
    await this.dependencies.memories.addBatch(candidates, () => this.isIntentCurrent(stamp), {
      ownerText,
    });
  }

  private isIntentCurrent(stamp: IntentStamp): boolean {
    if (
      !this.isCurrent(stamp.generation) ||
      stamp.messageSequence !== this.messageSequence ||
      stamp.worldGeneration !== this.worldGeneration
    ) {
      return false;
    }
    try {
      return stamp.ownerRevision === (this.dependencies.ownerIdentity?.snapshot().revision ?? 0);
    } catch {
      return false;
    }
  }

  private async captureIntentStamp(): Promise<IntentStamp> {
    const messageSequence = this.messageSequence;
    const ownerRevision = this.dependencies.ownerIdentity?.snapshot().revision ?? 0;
    const worldGeneration = this.worldGeneration;
    const taskLease = this.dependencies.taskController.current()?.lease ?? null;
    const taskLeaseAtDispatch =
      taskLease === null
        ? null
        : Object.freeze({ id: taskLease.id, startedAt: taskLease.startedAt });
    const farmingPermissionEpochAtDispatch = this.farmingPermissionCoordinator.pendingEpoch();
    await this.modelSwitchTail;
    const threadPair = this.currentThreadPair();
    if (!threadPair) throw new Error("Companion model authority is unavailable");
    return Object.freeze({
      generation: this.generation,
      messageSequence,
      ownerRevision,
      worldGeneration,
      taskLeaseAtDispatch,
      farmingPermissionEpochAtDispatch,
      threadPair,
    });
  }

  private isTaskDecisionCurrent(decision: TaskControlDecision, stamp: IntentStamp): boolean {
    if (!this.isIntentCurrent(stamp)) return false;
    if (decision.kind === "start_task") return true;
    const currentLease = this.dependencies.taskController.current()?.lease ?? null;
    if (stamp.taskLeaseAtDispatch === null || currentLease === null) {
      return stamp.taskLeaseAtDispatch === null && currentLease === null;
    }
    return sameTaskLease(stamp.taskLeaseAtDispatch, currentLease);
  }

  private async applyTaskDecision(
    decision: TaskControlDecision,
    text: string,
    stamp: IntentStamp,
  ): Promise<void> {
    if (!this.isTaskDecisionCurrent(decision, stamp)) return;
    if (decision.kind === "stop_task") {
      this.revokeCurrentTask("owner_stop");
      this.clearSuspendedTaskGoals("owner stop");
      this.unfinishedTaskSummary = null;
      if (this.isIntentCurrent(stamp)) await this.persist();
      if (decision.reply && this.isIntentCurrent(stamp)) {
        await this.sendOutcomeReply(decision.reply, stamp.generation, false);
      }
      return;
    }

    if (
      (decision.kind === "start_task" || decision.kind === "replace_task") &&
      (this.dependencies.taskController.current() !== null || this.autonomousRequestCount > 0)
    ) {
      this.revokeCurrentTask("owner_stop");
      this.clearSuspendedTaskGoals("task replaced");
      this.unfinishedTaskSummary = null;
      if (this.isIntentCurrent(stamp)) await this.persist();
      if (!this.isIntentCurrent(stamp)) return;
    }
    if (decision.kind === "continue_task") {
      const currentTask = this.dependencies.taskController.current();
      if (!currentTask) {
        await this.sendOutcomeReply(
          "当前没有可继续的任务，请说明要开始的新任务。",
          stamp.generation,
          false,
        );
        return;
      }
      if (!canReuseTaskAuthority(decision, currentTask)) {
        await this.sendOutcomeReply(
          "继续请求超出当前任务权限，请明确替换任务。",
          stamp.generation,
          false,
        );
        return;
      }
      this.interruptExecutionTurn();
    }
    if (decision.kind === "priority_task") {
      const currentTask = this.dependencies.taskController.current();
      if (currentTask) {
        this.interruptExecutionTurn();
        this.dependencies.confirmations.clearGameActions();
        this.suspendedTaskGoals.push({
          taskLease: Object.freeze({ ...currentTask.lease }),
          disclosure: cloneTaskDisclosure(currentTask.disclosure),
        });
        this.preservedTerminalLeaseKey = taskLeaseKey(currentTask.lease);
        this.dependencies.taskController.stop("owner_stop");
        this.dependencies.budget.end();
        this.dependencies.mode.completeTask();
      }
    }

    this.queueValidatedTask(decision, text, stamp);
  }

  private queueCurrentTaskReplan(stamp: IntentStamp): void {
    const task = this.dependencies.taskController.current();
    if (
      !task ||
      stamp.taskLeaseAtDispatch === null ||
      !sameTaskLease(task.lease, stamp.taskLeaseAtDispatch)
    ) {
      return;
    }
    this.interruptExecutionTurn();
    const allowedActions = task.disclosure.expectedActions.filter(
      (action): action is ToolActionKind => TOOL_ACTION_KINDS.includes(action as ToolActionKind),
    );
    this.queueValidatedTask(
      {
        kind: "continue_task",
        naturalReply: null,
        task: {
          goal: task.disclosure.goal,
          allowedActions,
          requestedLimits: { ...task.disclosure.limits },
        },
        memoryCandidates: [],
      },
      `主人消息已处理，请重新观察当前世界并规划当前目标：${task.disclosure.goal}`,
      stamp,
    );
  }

  private queueFarmingPermissionReplan(stamp: IntentStamp, context: string): void {
    const task = this.dependencies.taskController.current();
    if (
      !task ||
      stamp.taskLeaseAtDispatch === null ||
      !sameTaskLease(task.lease, stamp.taskLeaseAtDispatch)
    ) {
      return;
    }
    this.interruptExecutionTurn();
    const allowedActions = task.disclosure.expectedActions.filter(
      (action): action is ToolActionKind => TOOL_ACTION_KINDS.includes(action as ToolActionKind),
    );
    this.queueValidatedTask(
      {
        kind: "continue_task",
        naturalReply: null,
        task: {
          goal: task.disclosure.goal,
          allowedActions,
          requestedLimits: { ...task.disclosure.limits },
        },
        memoryCandidates: [],
      },
      context,
      stamp,
    );
  }

  private async queueFarmingPermissionReplanFromCurrent(context: string): Promise<void> {
    if (!this.running || this.dependencies.taskController.current() === null) return;
    try {
      const stamp = await this.captureIntentStamp();
      if (!this.isIntentCurrent(stamp)) return;
      this.queueFarmingPermissionReplan(stamp, context);
    } catch (error) {
      await this.logger.error("farming_permission_replan_failed", { code: errorName(error) });
    }
  }

  private beginFarmingPermissionRequest(plotSummary: string): boolean {
    if (
      this.dependencies.farmingPreference.snapshot().status !== "unknown" ||
      this.farmingPermissionCoordinator.isPending()
    ) {
      return false;
    }
    const result = this.farmingPermissionCoordinator.request({
      plotSummary,
      requestedAt: Date.now(),
    });
    void result
      .then((permissionResult) => this.handleFarmingPermissionResult(permissionResult))
      .catch((error: unknown) =>
        this.logger.error("farming_permission_result_failed", { code: errorName(error) }),
      );
    return true;
  }

  private async handleFarmingPermissionResult(result: FarmingPermissionResult): Promise<void> {
    if (result !== "timeout") return;
    await this.queueFarmingPermissionReplanFromCurrent(farmingFallbackConstraint);
  }

  private queueValidatedTask(
    decision: ValidatedTaskDecision,
    ownerText: string,
    stamp: IntentStamp,
  ): void {
    const queued = this.executionTurnTail
      .catch(() => undefined)
      .then(() => this.startValidatedTask(decision, ownerText, stamp))
      .catch((error: unknown) =>
        this.logger.error("companion_task_turn_failed", { code: String(error) }),
      );
    this.executionTurnTail = queued;
  }

  private clearSuspendedTaskGoals(reason: string): void {
    for (const suspended of this.suspendedTaskGoals.splice(0)) {
      this.dependencies.actionQueue.cancelTask(suspended.taskLease, reason);
    }
  }

  private async resumeLatestSuspendedGoal(stamp: IntentStamp): Promise<void> {
    const suspended = this.suspendedTaskGoals.pop();
    if (!suspended || !this.isIntentCurrent(stamp)) return;
    this.dependencies.actionQueue.cancelTask(suspended.taskLease, "priority task replan");
    const allowedActions = suspended.disclosure.expectedActions.filter(
      (action): action is ToolActionKind => TOOL_ACTION_KINDS.includes(action as ToolActionKind),
    );
    await this.startValidatedTask(
      {
        kind: "start_task",
        naturalReply: null,
        task: {
          goal: suspended.disclosure.goal,
          allowedActions,
          requestedLimits: { ...suspended.disclosure.limits },
        },
        memoryCandidates: [],
      },
      `优先帮助任务已完成，请重新观察当前世界并规划原目标：${suspended.disclosure.goal}`,
      stamp,
    );
  }

  private async startValidatedTask(
    decision: ValidatedTaskDecision,
    ownerText: string,
    stamp: IntentStamp,
  ): Promise<void> {
    this.turnWorkCount += 1;
    let task: ActiveTask | undefined;
    let prepared: TaskDisclosure | undefined;
    let taskStopReason: TaskStopReason = "failed";
    let keepTaskAlive = false;
    let resumeSuspendedGoal = false;
    try {
      if (!this.isIntentCurrent(stamp)) return;
      if (decision.kind === "continue_task") {
        const currentTask = this.dependencies.taskController.current();
        if (
          !currentTask ||
          stamp.taskLeaseAtDispatch === null ||
          !sameTaskLease(currentTask.lease, stamp.taskLeaseAtDispatch)
        )
          return;
        task = currentTask;
      } else {
        const disclosure: TaskDisclosure = {
          goal: decision.task.goal,
          expectedActions: [...decision.task.allowedActions],
          limits: effectiveTaskLimits(decision.task.requestedLimits),
          stopCondition: "完成、失败、安全边界或预算耗尽时停止",
        };
        prepared = this.dependencies.taskController.prepare(
          disclosure,
          decision.task.requestedLimits,
        );
      }
      await this.persistIntentMemories(decision.memoryCandidates, ownerText, stamp);
      if (!this.isIntentCurrent(stamp)) return;
      let prompt: string;
      try {
        const currentDisclosure = task?.disclosure;
        const plan =
          decision.kind === "continue_task" && currentDisclosure
            ? {
                goal: currentDisclosure.goal,
                allowedActions: decision.task.allowedActions.filter((action) =>
                  currentDisclosure.expectedActions.includes(action),
                ),
                requestedLimits: decision.task.requestedLimits,
              }
            : decision.task;
        const input = {
          mode: this.dependencies.mode.getMode(),
          profile: this.dependencies.mode.getProfile(),
          world: await this.dependencies.minecraft.snapshot(this.dependencies.ownerUsername()),
          memories: (await this.searchMemories(ownerText)).slice(0, 8),
          ownerMessage: ownerText,
          plan,
          farmingPermission: {
            status: this.dependencies.farmingPreference.snapshot().status,
            pending: this.farmingPermissionCoordinator.isPending(),
          },
        };
        prompt = buildCompanionTaskExecutionTurn(input);
      } catch (error) {
        if (this.isIntentCurrent(stamp)) {
          await this.failTaskOnly(stamp.generation, error, taskFailureMessage);
        }
        return;
      }

      if (!this.isIntentCurrent(stamp)) return;
      if (task) {
        if (this.dependencies.taskController.current()?.id !== task.id) return;
      } else {
        if (!prepared) throw new Error("validated task disclosure is missing");
        if (this.dependencies.taskController.current() !== null) return;
        this.locallyContainedTaskLeaseKey = undefined;
        task = this.dependencies.taskController.start(prepared, prepared.limits);
      }
      if (decision.naturalReply && this.isIntentCurrent(stamp)) {
        await this.sendOutcomeReply(decision.naturalReply, stamp.generation, false);
      }
      if (!this.isIntentCurrent(stamp)) return;

      let outcome: CompanionTaskExecutionOutcome | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await this.sendAttempt(
          "execution",
          attempt === 0 ? prompt : repairPrompt,
          stamp.generation,
          true,
          task,
          true,
          decision.task.allowedActions,
          () => this.isIntentCurrent(stamp),
          stamp.threadPair,
        );
        if (!result || !this.isIntentCurrent(stamp)) return;
        const parsed = companionTaskExecutionOutcomeSchema.safeParse(this.parseJson(result.text));
        if (!parsed.success || !this.memoryCandidatesValid(parsed.data, ownerText)) continue;
        outcome = parsed.data;
        break;
      }
      if (!outcome) {
        const error = new Error();
        error.name = "CodexInvalidStructureError";
        await this.failTaskOnly(stamp.generation, error, taskFailureMessage);
        task = undefined;
        return;
      }

      const requestedFarmingPermission =
        outcome.farmingPermissionRequest == null
          ? false
          : this.beginFarmingPermissionRequest(outcome.farmingPermissionRequest.plotSummary);
      taskStopReason = "completed";
      await this.persistTaskExecutionOutcome(task.disclosure.goal, outcome, stamp, ownerText);
      if (!this.isIntentCurrent(stamp)) return;
      if (decision.kind === "continue_task" && outcome.status === "active") {
        this.dependencies.actionRunner.resumeAfterReplan(task.lease, this.worldGeneration);
      }
      keepTaskAlive =
        outcome.status === "active" && this.dependencies.actionQueue.hasActiveTask(task.lease);
      if (outcome.status !== "active") {
        this.dependencies.actionQueue.cancelTask(task.lease, "task outcome finished");
        resumeSuspendedGoal = decision.kind === "priority_task";
      }
      if (requestedFarmingPermission) {
        await this.sendOutcomeReply(farmingPermissionQuestion, stamp.generation, false);
      } else {
        await this.sendOutcomeReply(outcome.reply, stamp.generation, false);
      }
    } catch (error) {
      if (
        task &&
        this.isIntentCurrent(stamp) &&
        this.dependencies.taskController.current()?.id === task.id
      ) {
        this.dependencies.taskController.stop("failed");
        task = undefined;
      }
      if (this.isIntentCurrent(stamp)) {
        await this.failTaskOnly(stamp.generation, error, taskFailureMessage);
      }
    } finally {
      if (
        task &&
        this.isIntentCurrent(stamp) &&
        this.dependencies.taskController.current()?.id === task.id
      ) {
        if (
          !keepTaskAlive &&
          (taskStopReason !== "completed" ||
            !this.dependencies.confirmations.hasGameActions(task.lease))
        ) {
          this.dependencies.taskController.stop(taskStopReason);
        }
      }
      this.turnWorkCount -= 1;
      if (
        resumeSuspendedGoal &&
        this.isIntentCurrent(stamp) &&
        this.dependencies.taskController.current() === null
      ) {
        await this.resumeLatestSuspendedGoal(stamp);
      }
    }
  }

  async requestAutonomousTurn(reason: AutonomyReason): Promise<void> {
    await this.modelSwitchTail;
    if (!this.running) return;
    const threadPair = this.currentThreadPair();
    if (!threadPair) return;
    const state = this.dependencies.mode.snapshot();
    if (state.mode === "friend" || state.paused) return;
    if (this.autonomousRequestCount > 0 || this.hasActiveTask()) return;
    const generation = this.generation;
    this.autonomousRequestCount += 1;
    const queued = this.executionTurnTail
      .catch(() => undefined)
      .then(() => this.performAutonomousTurn(reason, generation, threadPair))
      .catch((error: unknown) =>
        this.logger.error("companion_autonomous_turn_failed", { code: String(error) }),
      );
    this.executionTurnTail = queued;
    try {
      await queued;
    } finally {
      this.autonomousRequestCount -= 1;
    }
  }

  isBusyForAutonomy(): boolean {
    return (
      this.turnWorkCount > 0 ||
      this.activeIntentTurns.size > 0 ||
      this.activeExecutionTurn !== undefined ||
      this.recoveryFlight !== undefined ||
      this.autonomousRequestCount > 0 ||
      this.hasActiveTask() ||
      this.dependencies.executor.isBusy() ||
      this.mergeTimer !== undefined ||
      this.mergedMessages.length > 0
    );
  }

  queueExecutionContext(): QueuedActionExecutionContext | null {
    const task = this.dependencies.taskController.current();
    if (!task) return null;
    return {
      taskLease: { ...task.lease },
      worldGeneration: this.worldGeneration,
    };
  }

  private async performAutonomousTurn(
    reason: AutonomyReason,
    generation: number,
    threadPair: CodexThreadPair,
  ): Promise<void> {
    this.turnWorkCount += 1;
    try {
      if (!this.isCurrent(generation) || !this.executionThreadId) return;
      const state = this.dependencies.mode.snapshot();
      if (state.mode === "friend" || state.paused) return;
      if (this.hasActiveTask()) return;
      const ownerOnline = await this.dependencies.minecraft.isOwnerOnline(
        this.dependencies.ownerUsername(),
      );
      const compatibilityVerified =
        state.mode === "autonomous"
          ? await (this.dependencies.compatibilityVerified?.() ?? false)
          : false;
      const safetyPresetAllows =
        state.mode === "autonomous"
          ? await (this.dependencies.safetyPresetAllows?.() ?? false)
          : false;
      const settings = this.dependencies.mode.getModeSettings();
      const policyInput = {
        mode: state.mode,
        settings,
        ownerOnline,
        hasActiveTask: this.hasActiveTask(),
        compatibilityVerified,
        safetyPresetAllows,
      } as const;
      const allowedProactiveKinds: ProactiveKind[] =
        state.mode === "balanced"
          ? [
              ...(isUnsolicitedActivityAllowed({
                ...policyInput,
                activity: "proactive_chat",
              })
                ? (["chat"] as const)
                : []),
              ...(isUnsolicitedActivityAllowed({
                ...policyInput,
                activity: "suggestion",
              })
                ? (["suggestion"] as const)
                : []),
            ]
          : [];
      if (
        state.mode === "balanced"
          ? allowedProactiveKinds.length === 0
          : !isUnsolicitedActivityAllowed({
              ...policyInput,
              activity: "low_risk_micro_action",
            })
      )
        return;
      if (!this.isCurrent(generation)) return;
      const permitsTools = state.mode === "autonomous";
      const disclosure = permitsTools ? autonomousMicroTaskDisclosure(reason) : undefined;
      let prompt: string;
      try {
        prompt = buildCompanionAutonomousTurn({
          mode: this.dependencies.mode.getMode(),
          profile: this.dependencies.mode.getProfile(),
          reason,
          world: await this.dependencies.minecraft.snapshot(this.dependencies.ownerUsername()),
          memories: (await this.searchMemories(reason)).slice(0, 8),
        });
      } catch (error) {
        await this.failTaskOnly(generation, error, taskFailureMessage);
        return;
      }
      const outcome = await this.resolveOutcome(
        prompt,
        generation,
        undefined,
        disclosure,
        {
          toolsEnabled: permitsTools,
          taskForbidden: true,
          repairPrompt:
            state.mode === "balanced"
              ? balancedRepairPrompt(allowedProactiveKinds)
              : autonomousRepairPrompt,
          ...(state.mode === "balanced" ? { allowedProactiveKinds } : {}),
          ...(permitsTools ? { allowedToolActions: autonomousMicroToolActions } : {}),
        },
        threadPair,
      );
      if (!outcome || !this.isCurrent(generation)) return;
      await this.persistOutcome(outcome, generation);
      if (!this.isCurrent(generation)) return;
      await this.sendOutcomeReply(outcome.reply, generation, true, outcome.proactiveKind ?? "chat");
    } finally {
      this.turnWorkCount -= 1;
    }
  }

  private async resolveOutcome(
    prompt: string,
    generation: number,
    ownerText?: string,
    disclosure?: TaskDisclosure,
    options: {
      readonly toolsEnabled?: boolean;
      readonly taskForbidden?: boolean;
      readonly allowedToolActions?: readonly ToolActionKind[];
      readonly repairPrompt?: string;
      readonly allowedProactiveKinds?: readonly ProactiveKind[];
    } = {},
    threadPair?: CodexThreadPair,
  ): Promise<CompanionTurnOutcome | undefined> {
    let outcome: CompanionTurnOutcome | undefined;
    let task: ActiveTask | undefined;
    let taskStopReason: TaskStopReason = "failed";
    try {
      if (disclosure) {
        const prepared = this.dependencies.taskController.prepare(
          disclosure,
          this.dependencies.requestedTaskLimits,
        );
        if (!this.isCurrent(generation)) return undefined;
        this.locallyContainedTaskLeaseKey = undefined;
        task = this.dependencies.taskController.start(prepared, prepared.limits);
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await this.sendAttempt(
          "execution",
          attempt === 0 ? prompt : (options.repairPrompt ?? repairPrompt),
          generation,
          true,
          task,
          options.toolsEnabled ?? true,
          options.allowedToolActions,
          undefined,
          threadPair,
        );
        if (!result) return undefined;
        const parsed = companionTurnOutcomeSchema.safeParse(this.parseJson(result.text));
        if (
          !parsed.success ||
          (options.taskForbidden === true && parsed.data.task !== null) ||
          (options.allowedProactiveKinds !== undefined &&
            (parsed.data.proactiveKind === null ||
              parsed.data.proactiveKind === undefined ||
              !options.allowedProactiveKinds.includes(parsed.data.proactiveKind))) ||
          !this.memoryCandidatesValid(parsed.data, ownerText)
        )
          continue;
        outcome = parsed.data;
        break;
      }
      if (!outcome) {
        const error = new Error();
        error.name = "CodexInvalidStructureError";
        await this.failTaskOnly(generation, error, taskFailureMessage);
        task = undefined;
        return undefined;
      }
      taskStopReason = "completed";
      return outcome;
    } catch (error) {
      if (task) {
        this.dependencies.taskController.stop("failed");
        task = undefined;
      }
      await this.failTaskOnly(generation, error, taskFailureMessage);
      return undefined;
    } finally {
      if (task && this.dependencies.taskController.current()?.id === task.id) {
        if (
          taskStopReason !== "completed" ||
          !this.dependencies.confirmations.hasGameActions(task.lease)
        ) {
          this.dependencies.taskController.stop(taskStopReason);
        }
      }
    }
  }

  private async sendOutcomeReply(
    reply: string,
    generation: number,
    proactive: boolean,
    proactiveKind: ProactiveKind = "chat",
  ): Promise<void> {
    if (!reply || !this.isCurrent(generation)) return;
    const publicReply = containsInternalModelDisclosure(reply) ? filteredModelReply : reply;
    if (proactive) {
      if (
        this.dependencies.mode.getMode() === "friend" ||
        !this.dependencies.autonomy.canSendProactively(proactiveKind)
      ) {
        return;
      }
    }
    let marked = false;
    for (const chunk of splitForMinecraft(publicReply)) {
      if (!this.isCurrent(generation)) return;
      await this.dependencies.minecraft.say(chunk);
      if (proactive && !marked) {
        this.dependencies.autonomy.markProactiveChat();
        marked = true;
      }
    }
  }

  private async sendAttempt(
    role: "intent" | "execution",
    prompt: string,
    generation: number,
    trackAsActive: boolean,
    task: ActiveTask | undefined,
    toolsEnabled: boolean,
    allowedToolActions?: readonly ToolActionKind[],
    isApplicable: () => boolean = () => true,
    threadPair?: CodexThreadPair,
  ): Promise<CodexTurnResult | undefined> {
    if (role === "intent" && toolsEnabled) {
      throw new Error("intent turns cannot enable tools");
    }
    const pair = threadPair ?? this.currentThreadPair();
    const threadId = role === "intent" ? pair?.intentThreadId : pair?.executionThreadId;
    const isAttemptCurrent = () => this.isCurrent(generation) && isApplicable();
    if (!threadId || !isAttemptCurrent()) return undefined;
    let cancel!: () => void;
    const cancelled = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined);
    });
    const attemptThreadId = threadId;
    const active: ActiveTurn = { generation, threadId: attemptThreadId, cancel };
    if (trackAsActive) {
      if (role === "intent") this.activeIntentTurns.add(active);
      else this.activeExecutionTurn = active;
    }
    let budgetStarted = false;
    try {
      if (task && this.dependencies.taskController.current()?.id !== task.id) {
        return undefined;
      }
      let turnText = prompt;
      if (toolsEnabled) {
        const toolLease = this.dependencies.budget.begin(task?.lease, {
          ...(allowedToolActions === undefined ? {} : { allowedActions: allowedToolActions }),
        });
        budgetStarted = true;
        turnText = attachToolLease(prompt, toolLease, task?.lease.id, allowedToolActions);
      }
      const original = this.dependencies.codex.sendTurn(attemptThreadId, turnText, (turnId) => {
        const trackedActive =
          role === "intent"
            ? this.activeIntentTurns.has(active)
            : this.activeExecutionTurn === active;
        if (!isAttemptCurrent() || (trackAsActive && !trackedActive)) {
          void this.dependencies.codex
            .interrupt(attemptThreadId, turnId)
            .catch((error: unknown) =>
              this.logger.error("codex_interrupt_failed", { code: String(error) }),
            );
          return;
        }
        active.turnId = turnId;
      });
      const result = await Promise.race([original, cancelled]);
      if (!result) return undefined;
      if (!isAttemptCurrent()) return undefined;
      this.consecutiveTransportFailures = 0;
      if (result.status !== "completed") {
        if (trackAsActive && this.codexHealthy) {
          const error = new Error();
          error.name =
            result.status === "interrupted" ? "CodexTurnInterruptedError" : "CodexTurnFailedError";
          await this.handleCodexFailure(generation, error);
        }
        return undefined;
      }
      return result;
    } catch (error) {
      if (isAttemptCurrent() && trackAsActive && this.codexHealthy) {
        await this.handleCodexFailure(generation, error);
      }
      return undefined;
    } finally {
      try {
        if (budgetStarted) this.dependencies.budget.end();
      } finally {
        if (role === "intent") this.activeIntentTurns.delete(active);
        if (role === "execution" && this.activeExecutionTurn === active) {
          this.activeExecutionTurn = undefined;
        }
      }
    }
  }

  private parseJson(value: string): unknown {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }

  private hasActiveTask(): boolean {
    return (
      this.dependencies.taskController.current() !== null ||
      this.dependencies.mode.snapshot().taskId !== null
    );
  }

  private memoryCandidatesValid(
    outcome: Pick<CompanionTurnOutcome, "reply" | "memoryCandidates"> & {
      task?: CompanionTurnOutcome["task"];
    },
    ownerText?: string,
  ): boolean {
    try {
      const source = memoryValidationSource(outcome, ownerText);
      for (const candidate of outcome.memoryCandidates)
        this.dependencies.memories.validateCandidate(candidate, source);
      return true;
    } catch {
      return false;
    }
  }

  private async persistTaskExecutionOutcome(
    taskGoal: string,
    outcome: CompanionTaskExecutionOutcome,
    stamp: IntentStamp,
    ownerText: string,
  ): Promise<void> {
    const candidates = outcome.memoryCandidates.filter((candidate) => candidate.importance >= 3);
    if (candidates.length > 0) {
      await this.dependencies.memories.addBatch(
        candidates,
        () => this.isIntentCurrent(stamp),
        memoryValidationSource(outcome, ownerText),
      );
    }
    if (!this.isIntentCurrent(stamp)) return;
    this.unfinishedTaskSummary =
      outcome.status === "active" ? JSON.stringify({ goal: taskGoal }) : null;
    if (outcome.status === "active") this.dependencies.mode.startTask(taskGoal);
    else this.dependencies.mode.completeTask();
    await this.persist();
    if (this.isIntentCurrent(stamp) && outcome.status === "completed") {
      try {
        this.dependencies.autonomy.notifyGoalCompleted();
      } catch (error) {
        await this.logger.error("autonomy_goal_notification_failed", { code: String(error) });
      }
    }
  }

  private async persistOutcome(
    outcome: CompanionTurnOutcome,
    generation: number,
    ownerText?: string,
  ): Promise<void> {
    const taskSummary = compactTask(outcome);
    const candidates = outcome.memoryCandidates.filter((candidate) => candidate.importance >= 3);
    if (candidates.length > 0) {
      await this.dependencies.memories.addBatch(
        candidates,
        () => this.isCurrent(generation),
        memoryValidationSource(outcome, ownerText),
      );
    }
    if (!this.isCurrent(generation)) return;
    this.unfinishedTaskSummary = taskSummary;
    if (outcome.task?.status === "active") this.dependencies.mode.startTask(outcome.task.goal);
    else this.dependencies.mode.completeTask();
    await this.persist();
    if (this.isCurrent(generation) && outcome.task?.status === "completed") {
      try {
        this.dependencies.autonomy.notifyGoalCompleted();
      } catch (error) {
        await this.logger.error("autonomy_goal_notification_failed", { code: String(error) });
      }
    }
  }

  private recoverSingleFlight(): Promise<void> {
    if (this.recoveryFlight) return this.recoveryFlight;
    const generation = this.generation;
    const queued = Promise.all([
      this.intentTurnTail.catch(() => undefined),
      this.executionTurnTail.catch(() => undefined),
    ]).then(() => this.recover(generation));
    let tracked!: Promise<void>;
    tracked = queued.finally(() => {
      if (this.recoveryFlight === tracked) this.recoveryFlight = undefined;
    });
    this.recoveryFlight = tracked;
    const observed = tracked.catch((error: unknown) =>
      this.logger.error("companion_recovery_failed", { code: String(error) }),
    );
    this.intentTurnTail = observed;
    this.executionTurnTail = observed;
    return tracked;
  }

  private async recover(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    this.codexHealthy = false;
    this.dependencies.mode.pause();
    try {
      await this.persist();
      if (!this.isCurrent(generation)) return;
      this.intentThreadId = undefined;
      this.executionThreadId = undefined;
      await this.dependencies.codex.stop().catch(() => undefined);
      if (!this.isCurrent(generation)) return;
      await this.dependencies.codex.start();
      if (!this.isCurrent(generation)) {
        await this.closeStaleCodex(generation);
        return;
      }
      if (this.externallyManagedCodex) {
        const selectedModel = this.selectedModel;
        const selectedReasoningEffort = this.selectedReasoningEffort;
        const available =
          selectedModel !== undefined &&
          selectedReasoningEffort !== undefined &&
          (await this.dependencies.codex.validateModelSelection({
            modelId: selectedModel,
            reasoningEffort: selectedReasoningEffort,
          }));
        if (!available) {
          this.reportModelAuthorityLoss(generation);
          throw new Error("Selected live model is unavailable");
        }
      } else {
        const models = await this.dependencies.codex.listModels();
        this.selectedModel = selectModel(models, this.dependencies.preferredModel);
        this.selectedReasoningEffort = this.dependencies.reasoningEffort;
      }
      if (!this.isCurrent(generation)) return;
      const selectedModel = this.selectedModel;
      const selectedReasoningEffort = this.selectedReasoningEffort;
      if (!selectedModel || !selectedReasoningEffort) {
        throw new Error("Selected live model is unavailable");
      }
      const selection = Object.freeze({
        modelId: selectedModel,
        reasoningEffort: selectedReasoningEffort,
      });
      const pair = await this.startThreadPair(selection);
      if (!this.isCurrent(generation)) {
        await this.retireThreadPair(pair);
        return;
      }
      this.publishThreadPair(pair, selection);
      const summary = this.unfinishedTaskSummary ?? "Codex session recovery handshake";
      const prompt = buildCompanionRecoveryTurn({
        mode: this.dependencies.mode.getMode(),
        profile: this.dependencies.mode.getProfile(),
        world: await this.dependencies.minecraft.snapshot(this.dependencies.ownerUsername()),
        memories: (await this.searchMemories(summary)).slice(0, 8),
        summary,
      });
      let recovered: CompanionTurnOutcome | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await this.sendAttempt(
          "execution",
          attempt === 0 ? prompt : recoveryRepairPrompt,
          generation,
          true,
          undefined,
          false,
        );
        if (!result) throw new Error("Codex recovery turn failed");
        const parsed = companionTurnOutcomeSchema.safeParse(this.parseJson(result.text));
        if (!parsed.success || !this.memoryCandidatesValid(parsed.data)) continue;
        recovered = parsed.data;
        break;
      }
      if (!recovered) throw new Error("invalid structured Codex recovery output");
      const candidates = recovered.memoryCandidates.filter(
        (candidate) => candidate.importance >= 3,
      );
      if (candidates.length > 0) {
        await this.dependencies.memories.addBatch(
          candidates,
          () => this.isCurrent(generation),
          memoryValidationSource(recovered),
        );
      }
      if (!this.isCurrent(generation)) return;
      this.unfinishedTaskSummary = compactTask(recovered);
      if (recovered.task?.status === "active") {
        this.dependencies.mode.startTask(recovered.task.goal);
        this.dependencies.mode.pause();
      } else {
        this.dependencies.mode.completeTask();
      }
      this.codexHealthy = true;
      this.dependencies.mode.resume();
      await this.persist();
      if (this.isCurrent(generation)) await this.say("已恢复。");
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.intentThreadId = undefined;
      this.executionThreadId = undefined;
      this.codexHealthy = false;
      this.dependencies.mode.pause();
      await this.persist();
      await this.say(unavailableMessage);
      await this.logger.error("codex_recovery_failed", {
        code: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  private async closeStaleCodex(generation: number): Promise<void> {
    if (this.externallyManagedCodex && !this.isCurrent(generation)) return;
    await this.dependencies.codex
      .stop()
      .catch((error: unknown) =>
        this.logger.error("codex_stale_session_stop_failed", { code: String(error) }),
      );
  }

  private reportModelAuthorityLoss(generation: number): void {
    if (!this.isCurrent(generation) || this.reportedModelAuthorityLossGeneration === generation) {
      return;
    }
    this.reportedModelAuthorityLossGeneration = generation;
    try {
      this.dependencies.onAuthorityLost?.({ reason: "model_unavailable" });
    } catch {
      // The recovery failure remains contained if an internal observer misbehaves.
    }
  }

  private async handleCommand(command: LocalCommand): Promise<void> {
    try {
      switch (command.kind) {
        case "mode":
          if (this.autonomousRequestCount > 0) {
            this.dependencies.taskController.stop("owner_stop");
            this.dependencies.executor.stopAll();
            this.invalidateCurrentTurn();
          }
          this.dependencies.mode.setMode(command.mode);
          this.dependencies.autonomy.notifyModeChanged();
          await this.persist();
          await this.say(
            `已切换到${command.mode === "friend" ? "朋友" : command.mode === "balanced" ? "平衡" : "自主"}模式。`,
          );
          return;
        case "pause":
          this.dependencies.taskController.stop("owner_stop");
          this.invalidateCurrentTurn();
          this.dependencies.executor.stopAll();
          this.dependencies.mode.pause();
          this.interruptActive();
          await this.persist();
          await this.say("已暂停，当前任务已保留。");
          return;
        case "resume":
          this.worldInvalidated = false;
          if (!this.codexHealthy || this.unfinishedTaskSummary) {
            await this.persist();
            await this.recoverSingleFlight();
            return;
          }
          this.dependencies.mode.resume();
          await this.persist();
          await this.say("已恢复。");
          return;
        case "stop":
          this.worldInvalidated = false;
          this.dependencies.taskController.stop("owner_stop");
          this.invalidateCurrentTurn();
          this.dependencies.executor.stopAll();
          this.dependencies.confirmations.clear();
          this.dependencies.mode.stop();
          this.unfinishedTaskSummary = null;
          this.clearMergedMessages();
          await this.persist();
          await this.say("已停止当前任务和所有动作。");
          return;
        case "status": {
          const state = this.dependencies.mode.snapshot();
          await this.say(
            `模式：${state.mode}；暂停：${state.paused ? "是" : "否"}；当前任务：${this.unfinishedTaskSummary ?? "无"}；模型：${this.selectedModel ?? "未选择"}；Codex：${this.codexHealthy ? "可用" : "不可用"}`,
          );
          return;
        }
        case "memory_show": {
          const memories = (await this.dependencies.memories.list()).slice(0, 20);
          await this.say(
            memories.length
              ? memories.map((item) => `${item.id}. ${item.summary}`).join(" | ")
              : "没有记忆。",
          );
          return;
        }
        case "memory_search": {
          const memories = (await this.dependencies.memories.search(command.query)).slice(0, 10);
          await this.say(
            memories.length
              ? memories.map((item) => `${item.id}. ${item.summary}`).join(" | ")
              : "没有匹配记忆。",
          );
          return;
        }
        case "memory_forget":
          await this.dependencies.memories.forget(command.memoryId);
          await this.say("已删除记忆。");
          return;
        case "memory_clear": {
          const confirmation = this.dependencies.confirmations.create("清除全部记忆", {
            kind: "memory_clear",
          });
          await this.say(`请使用 !allow ${confirmation.id} 确认清除记忆。`);
          return;
        }
        case "deny":
          await this.serializeConfirmation(() => this.deny(command.confirmationId));
          return;
        case "allow":
          await this.serializeConfirmation(() => this.allow(command.confirmationId));
          return;
      }
    } catch (error) {
      await this.logger.error("local_command_failed", { code: String(error) });
      await this.say("本地命令未能完成。");
    }
  }

  private serializeConfirmation(operation: () => Promise<void>): Promise<void> {
    const queued = this.confirmationTail.then(operation, operation);
    this.confirmationTail = queued.catch(() => undefined);
    return queued;
  }

  private scheduleConfirmationExpiry(): void {
    this.clearConfirmationExpiry();
    if (!this.running) return;
    const next = this.dependencies.confirmations.nextGameActionExpiry();
    if (!next) return;
    const delay = Math.max(0, next.expiresAt.getTime() - this.confirmationNow().getTime());
    const taskLease = { ...next.taskLease };
    let timer!: ReturnType<typeof setTimeout>;
    try {
      timer = this.setConfirmationTimer(() => {
        if (this.confirmationExpiryTimer !== timer) return;
        this.confirmationExpiryTimer = undefined;
        if (!this.running) return;
        const current = this.dependencies.taskController.current();
        if (!current || !sameTaskLease(current.lease, taskLease)) {
          this.scheduleConfirmationExpiry();
          return;
        }
        const expired = this.dependencies.confirmations.expireGameActions(taskLease);
        if (expired === 0) this.scheduleConfirmationExpiry();
      }, delay);
    } catch (error) {
      this.failConfirmationTimer(taskLease, error);
      return;
    }
    this.confirmationExpiryTimer = timer;
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }

  private clearConfirmationExpiry(): void {
    const timer = this.confirmationExpiryTimer;
    this.confirmationExpiryTimer = undefined;
    if (timer === undefined) return;
    try {
      this.clearConfirmationTimer(timer);
    } catch (error) {
      this.logConfirmationSafetyError("confirmation_expiry_timer_clear_failed", error);
    }
  }

  private failConfirmationTimer(taskLease: TaskLease, error: unknown): void {
    this.dependencies.confirmations.clearGameActions();
    this.queueFailedConfirmation(taskLease);
    this.logConfirmationSafetyError("confirmation_expiry_timer_set_failed", error);
  }

  private queueFailedConfirmation(taskLease: TaskLease): void {
    if (!this.running) return;
    const safeLease = { ...taskLease };
    const key = taskLeaseKey(safeLease);
    this.pendingConfirmationTerminalReasons.set(key, "failed");
    void this.serializeConfirmation(async () => {
      if (!this.pendingConfirmationTerminalReasons.has(key)) return;
      await this.settleConfirmationTask(safeLease, "failed");
    }).catch((error: unknown) => {
      this.logConfirmationSafetyError("confirmation_expiry_settlement_failed", error);
    });
  }

  private logConfirmationSafetyError(event: string, error: unknown): void {
    try {
      void this.logger.error(event, { code: String(error) }).catch(() => undefined);
    } catch {
      // Timer safety must not depend on diagnostic observers.
    }
  }

  private async allow(id: number): Promise<void> {
    const task = this.dependencies.taskController.current();
    const inspected = task
      ? this.dependencies.confirmations.inspectGameAction(id, task.lease)
      : undefined;
    if (task && inspected?.ok) {
      let context: SafetyContext;
      try {
        context = await this.dependencies.safetyContextProvider();
      } catch {
        await this.say("无法取得安全上下文，确认未被使用。");
        return;
      }
      let additionalHorizontalTravel = 0;
      if (inspected.action.kind === "move_to") {
        let snapshot;
        try {
          snapshot = await this.dependencies.minecraft.snapshot(this.dependencies.ownerUsername());
        } catch {
          await this.say("无法取得安全上下文，确认未被使用。");
          return;
        }
        const freshDistance = Math.hypot(
          inspected.action.position.x - snapshot.botPosition.x,
          inspected.action.position.z - snapshot.botPosition.z,
        );
        if (!Number.isFinite(freshDistance)) {
          await this.say("无法取得安全上下文，确认未被使用。");
          return;
        }
        additionalHorizontalTravel = Math.max(
          0,
          freshDistance - inspected.reservedHorizontalTravel,
        );
      }
      const result = await this.dependencies.executor.executeConfirmed(
        id,
        { ...context, taskLease: { ...task.lease } },
        task.lease,
        additionalHorizontalTravel,
      );
      const leaseKey = taskLeaseKey(task.lease);
      if (this.locallyContainedTaskLeaseKey === leaseKey) {
        this.locallyContainedTaskLeaseKey = undefined;
        return;
      }
      await this.settleConfirmationTask(
        task.lease,
        result.status === "completed" ? "completed" : "failed",
      );
      await this.say(result.status === "completed" ? "已执行确认动作。" : "确认动作未能执行。");
      return;
    }
    if (task && inspected && !inspected.ok) {
      if (inspected.reason === "expired") {
        await this.settleConfirmationTask(task.lease, "failed");
      }
      if (inspected.reason === "expired" || inspected.reason === "wrong_task") {
        await this.say("确认不存在或已过期。");
        return;
      }
    }
    const pending = this.dependencies.confirmations.get(id);
    if (!pending || pending.operation.kind !== "memory_clear") {
      await this.say("确认不存在或已过期。");
      return;
    }
    const allowed = this.dependencies.confirmations.allow(id);
    if (allowed.ok && allowed.operation.kind === "memory_clear") {
      await this.dependencies.memories.clear();
      await this.say("已清除记忆。");
      return;
    }
    await this.say("确认不存在或已过期。");
  }

  private async deny(id: number): Promise<void> {
    const task = this.dependencies.taskController.current();
    if (task) {
      const denied = this.dependencies.confirmations.denyGameAction(id, task.lease);
      if (denied.ok) {
        await this.settleConfirmationTask(task.lease, "owner_stop");
        await this.say("已取消确认。");
        return;
      }
      if (denied.reason === "expired") {
        await this.settleConfirmationTask(task.lease, "failed");
      }
      if (denied.reason === "expired" || denied.reason === "wrong_task") {
        await this.say("已取消确认。");
        return;
      }
    }
    this.dependencies.confirmations.deny(id);
    await this.say("已取消确认。");
  }

  private async settleConfirmationTask(
    taskLease: TaskLease,
    reason: "completed" | "failed" | "owner_stop",
  ): Promise<boolean> {
    this.dependencies.confirmations.expireGameActions(taskLease);
    const key = taskLeaseKey(taskLease);
    const pendingReason = this.pendingConfirmationTerminalReasons.get(key);
    if (reason === "failed" || (reason === "owner_stop" && pendingReason !== "failed")) {
      this.pendingConfirmationTerminalReasons.set(key, reason);
    }
    if (this.dependencies.confirmations.hasGameActions(taskLease)) return false;
    if (!this.dependencies.taskController.isLeaseLive(taskLease)) {
      this.pendingConfirmationTerminalReasons.delete(key);
      return false;
    }
    const terminalReason = this.pendingConfirmationTerminalReasons.get(key) ?? reason;
    this.dependencies.taskController.stop(terminalReason);
    this.invalidateCurrentTurn();
    try {
      this.dependencies.executor.stopAll();
    } catch (error) {
      this.logConfirmationSafetyError("confirmation_settlement_executor_stop_failed", error);
    }
    if (terminalReason === "completed") this.dependencies.mode.completeTask();
    else this.dependencies.mode.stop();
    this.unfinishedTaskSummary = null;
    await this.persist();
    if (terminalReason === "completed") {
      try {
        this.dependencies.autonomy.notifyGoalCompleted();
      } catch (error) {
        await this.logger.error("autonomy_goal_notification_failed", { code: String(error) });
      }
    }
    return true;
  }

  private interruptActive(): void {
    this.interruptIntentTurns();
    this.interruptExecutionTurn();
  }

  private interruptIntentTurns(): void {
    const intentTurns = [...this.activeIntentTurns];
    this.activeIntentTurns.clear();
    for (const active of intentTurns) this.interruptTurn(active);
  }

  private interruptExecutionTurn(): void {
    const active = this.activeExecutionTurn;
    this.activeExecutionTurn = undefined;
    if (active) this.interruptTurn(active);
  }

  private interruptTurn(active: ActiveTurn): void {
    active.cancel();
    if (!active.turnId) return;
    void this.dependencies.codex
      .interrupt(active.threadId, active.turnId)
      .catch((error: unknown) =>
        this.logger.error("codex_interrupt_failed", { code: String(error) }),
      );
  }

  private revokeCurrentTask(reason: TaskStopReason): void {
    const activeTask = this.dependencies.taskController.current();
    this.interruptExecutionTurn();
    this.dependencies.confirmations.clear();
    if (activeTask) {
      try {
        this.dependencies.actionRunner.cancelTask(activeTask.lease, reason);
      } catch {
        this.dependencies.executor.stopAll();
        this.dependencies.actionQueue.cancelTask(activeTask.lease, reason);
      }
    } else {
      this.dependencies.executor.stopAll();
    }
    this.dependencies.taskController.stop(reason);
    this.dependencies.budget.end();
    this.dependencies.mode.completeTask();
  }

  private handleTaskTerminal(
    reason: TaskStopReason,
    forceCleanup = false,
    taskLease?: TaskLease,
  ): void {
    this.farmingPermissionCoordinator.cancel(reason);
    if (taskLease) {
      const key = taskLeaseKey(taskLease);
      if (this.preservedTerminalLeaseKey === key) {
        this.preservedTerminalLeaseKey = undefined;
      } else {
        this.dependencies.actionQueue.cancelTask(taskLease, reason);
      }
    }
    this.pendingConfirmationTerminalReasons.clear();
    try {
      this.dependencies.confirmations.clearGameActions();
    } catch (error) {
      void this.logger.error("task_terminal_confirmation_clear_failed", { code: String(error) });
    }
    const taskOnlyStop = reason === "owner_stop" || reason === "model_changed";
    if (!taskOnlyStop && !forceCleanup && reason !== "timeout" && reason !== "budget_exhausted") {
      return;
    }
    if (taskOnlyStop) this.interruptExecutionTurn();
    else this.invalidateCurrentTurn();
    try {
      this.dependencies.executor.stopAll();
    } catch (error) {
      void this.logger.error("task_terminal_executor_stop_failed", { code: String(error) });
    }
    try {
      if (taskOnlyStop) this.dependencies.mode.completeTask();
      else this.dependencies.mode.stop();
    } catch (error) {
      void this.logger.error("task_terminal_mode_stop_failed", { code: String(error) });
    }
    this.unfinishedTaskSummary = null;
    void this.persist().catch((error: unknown) =>
      this.logger.error("task_terminal_state_save_failed", { code: String(error) }),
    );
  }

  private invalidateCurrentTurn(): void {
    this.interruptActive();
    this.activeExecutionTurn = undefined;
    this.generation += 1;
    this.clearMergedMessages();
  }

  private invalidateStartupOwnerWork(): void {
    this.interruptActive();
    this.activeExecutionTurn = undefined;
    this.clearMergedMessages();
    const retainedEvents = this.startupEvents.filter((event) => event.kind !== "chat");
    this.startupEvents.splice(0, this.startupEvents.length, ...retainedEvents);
    this.ownerChangedDuringStartup = true;
  }

  private async refreshOwnerPresence(): Promise<void> {
    const identity = this.dependencies.ownerIdentity;
    if (!identity) return;
    const snapshot = identity.snapshot();
    if (!snapshot.configured || snapshot.ownerUsername === null) return;
    const revision = snapshot.revision;
    const ownerUsername = snapshot.ownerUsername;
    try {
      const online = await this.dependencies.minecraft.isOwnerOnline(ownerUsername);
      identity.setPresence({
        revision,
        ownerUsername,
        presence: online ? "online" : "offline",
      });
    } catch {
      // Presence is advisory; authority remains with the configured owner.
    }
  }

  private setOwnerPresence(presence: "online" | "offline"): void {
    const identity = this.dependencies.ownerIdentity;
    if (!identity) return;
    const snapshot = identity.snapshot();
    if (!snapshot.configured || snapshot.ownerUsername === null) return;
    identity.setPresence({
      revision: snapshot.revision,
      ownerUsername: snapshot.ownerUsername,
      presence,
    });
  }

  private async handleCodexFailure(generation: number, error: unknown): Promise<void> {
    if (isTransportFailure(error)) {
      this.consecutiveTransportFailures = Math.min(
        transportFailureThreshold,
        this.consecutiveTransportFailures + 1,
      );
    } else {
      this.consecutiveTransportFailures = 0;
    }
    if (codexFailureScope(error, this.consecutiveTransportFailures) === "service") {
      await this.failClosed(generation, error);
      return;
    }
    await this.failTaskOnly(generation, error, taskFailureMessage);
  }

  private async failTaskOnly(generation: number, error: unknown, message: string): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const failedTask = this.dependencies.taskController.current();
    if (failedTask) this.locallyContainedTaskLeaseKey = taskLeaseKey(failedTask.lease);
    // ActionExecutor.stopAll invokes its owner-stop hook, so establish the failure reason first.
    this.dependencies.taskController.stop("failed");
    this.interruptExecutionTurn();
    this.dependencies.confirmations.clear();
    this.dependencies.executor.stopAll();
    this.dependencies.taskController.stop("failed");
    this.dependencies.budget.end();
    this.dependencies.mode.completeTask();
    this.unfinishedTaskSummary = null;
    await this.persist();
    if (this.isCurrent(generation)) await this.say(message);
    try {
      await this.logger.error("codex_task_failed", { code: errorName(error) });
    } catch {
      // Diagnostic observers cannot weaken local failure containment.
    }
  }

  private async failClosed(generation: number, error: unknown): Promise<void> {
    if (!this.isCurrent(generation) || !this.codexHealthy) return;
    this.codexHealthy = false;
    this.dependencies.taskController.stop("model_unavailable");
    this.dependencies.executor.stopAll();
    this.dependencies.mode.pause();
    await this.persist();
    if (this.isCurrent(generation)) await this.say(unavailableMessage);
    await this.logger.error("codex_unavailable", {
      code: error instanceof Error ? error.name : "unknown",
    });
  }

  private async persist(): Promise<void> {
    const state = this.dependencies.mode.snapshot();
    await this.dependencies.state.save({
      lastMode: state.mode,
      paused: state.paused,
      unfinishedTaskSummary: this.unfinishedTaskSummary,
      worldInvalidated: this.worldInvalidated,
    });
  }

  private async say(message: string): Promise<void> {
    if (!this.running) return;
    for (const chunk of splitForMinecraft(message)) await this.dependencies.minecraft.say(chunk);
  }

  private clearMergedMessages(): void {
    if (this.mergeTimer !== undefined) this.clearTimer(this.mergeTimer);
    this.mergeTimer = undefined;
    this.mergedMessages = [];
  }

  private isCurrent(generation: number): boolean {
    return this.running && generation === this.generation;
  }
}
