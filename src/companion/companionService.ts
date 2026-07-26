import { ActionExecutor } from "../actions/actionExecutor.js";
import type { AutonomyReason } from "../autonomy/autonomyScheduler.js";
import type { LocalCommand } from "../commands/commandParser.js";
import type { CodexPort, CodexTurnResult } from "../codex/codexPort.js";
import { selectModel } from "../codex/modelSelector.js";
import type { CompanionMode } from "../domain/types.js";
import { SafeLogger } from "../logging/safeLogger.js";
import { MemoryStore, type MemoryValidationSource } from "../memory/memoryStore.js";
import { StateStore } from "../memory/stateStore.js";
import { ModeManager } from "../mode/modeManager.js";
import { TurnToolBudget } from "../mcp/toolBudget.js";
import type { MinecraftEvent, MinecraftPort } from "../minecraft/minecraftPort.js";
import { ConfirmationStore } from "../safety/confirmationStore.js";
import type { SafetyContext } from "../safety/safetyEngine.js";
import { HARD_TASK_LIMITS, type TaskStopReason } from "../safety/taskBudget.js";
import {
  buildCompanionAutonomousTurn,
  buildCompanionRecoveryTurn,
  buildCompanionTurn,
  companionTurnOutcomeSchema,
  type CompanionTurnOutcome,
} from "./promptBuilder.js";
import { ChatRouter } from "./chatRouter.js";
import { TaskController, type ActiveTask, type TaskDisclosure } from "./taskController.js";

const repairPrompt = "只返回符合既定结构的 JSON，不要使用 Markdown。";
const unavailableMessage =
  "Codex 暂时不可用，我已安全暂停。你仍可以使用 !status、!stop 和记忆命令。";

function attachToolLease(text: string, lease: string, taskLeaseId?: string): string {
  return [
    text,
    "本回合工具租约",
    ...(taskLeaseId === undefined
      ? []
      : [`本次有界任务租约 ID 为 ${JSON.stringify(taskLeaseId)}。`]),
    `每次 minecraft_ 工具调用都必须把 turnLease 设置为 ${JSON.stringify(lease)}。`,
    "这个随机租约只授权本回合；不要在回复、任务或记忆候选中复述它。",
  ].join("\n");
}

const expectedTaskActions = [
  "get_state",
  "find_block",
  "say",
  "move_to",
  "follow_owner",
  "look_at",
  "jump",
  "dig_block",
  "place_block",
  "craft_item",
  "smelt_item",
  "collect_dropped",
  "equip_item",
  "attack_hostile",
  "wait",
] as const;

function turnDisclosure(goal: string): TaskDisclosure {
  return {
    goal,
    expectedActions: [...expectedTaskActions],
    limits: { ...HARD_TASK_LIMITS },
    stopCondition: "完成、失败、中断、达到安全边界或预算耗尽时立即停止",
  };
}

function conciseGoal(goal: string): string {
  const normalized = goal.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= 80 ? normalized : `${characters.slice(0, 79).join("")}…`;
}

function disclosureMessage(disclosure: TaskDisclosure): string {
  return `任务披露：目标“${conciseGoal(disclosure.goal)}”；预计仅使用受限 Minecraft 操作；上限 ${disclosure.limits.maxToolCalls} 次工具调用、${Math.floor(disclosure.limits.maxDurationMs / 60_000)} 分钟；${disclosure.stopCondition}。`;
}

function memoryValidationSource(
  outcome: CompanionTurnOutcome,
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
  memories: MemoryStore;
  state: StateStore;
  confirmations: ConfirmationStore;
  executor: ActionExecutor;
  budget: TurnToolBudget;
  taskController: TaskController;
  autonomy: CompanionAutonomyScheduler;
  safetyContextProvider: () => Promise<SafetyContext>;
  ownerUsername: string;
  chatRouter: ChatRouter;
  cwd: string;
  preferredModel: string;
  reasoningEffort: "low" | "medium";
  logger?: Pick<SafeLogger, "error">;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface CompanionAutonomyScheduler {
  start(): void;
  stop(): void;
  notifyModeChanged(): void;
  notifyGoalCompleted(): void;
  notifyActionFailed(): void;
  notifyThreat(): void;
  canChatProactively(): boolean;
  markProactiveChat(): void;
}

interface ActiveTurn {
  generation: number;
  threadId: string;
  turnId?: string;
  cancel(): void;
}

const noOpLogger: Pick<SafeLogger, "error"> = { error: async () => undefined };

function splitForMinecraft(reply: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of reply) {
    if (chunk.length > 0 && chunk.length + character.length > 240) {
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

export class CompanionService {
  private readonly logger: Pick<SafeLogger, "error">;
  private readonly setTimer: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeActionResult: (() => void) | undefined;
  private mergeTimer: ReturnType<typeof setTimeout> | undefined;
  private mergedMessages: string[] = [];
  private generation = 0;
  private running = false;
  private starting = false;
  private threadId: string | undefined;
  private selectedModel: string | undefined;
  private codexHealthy = true;
  private activeTurn: ActiveTurn | undefined;
  private turnTail: Promise<void> = Promise.resolve();
  private recoveryFlight: Promise<void> | undefined;
  private unfinishedTaskSummary: string | null = null;
  private readonly startupEvents: MinecraftEvent[] = [];
  private turnWorkCount = 0;
  private autonomousRequestCount = 0;
  private externallyManagedCodex = false;

  constructor(private readonly dependencies: CompanionServiceDependencies) {
    this.logger = dependencies.logger ?? noOpLogger;
    this.setTimer = dependencies.setTimer ?? setTimeout;
    this.clearTimer = dependencies.clearTimer ?? clearTimeout;
    dependencies.taskController.onTerminal((reason) => this.handleTaskTerminal(reason));
  }

  async start(preselectedModel?: string): Promise<void> {
    if (this.running || this.starting) throw new Error("CompanionService is already started");
    this.starting = true;
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
      const persisted = await this.dependencies.state.load();
      if (generation !== this.generation) return;
      this.dependencies.confirmations.clear();
      this.dependencies.executor.stopAll();
      this.dependencies.mode.setMode("friend");
      this.dependencies.mode.completeTask();
      this.unfinishedTaskSummary = persisted.unfinishedTaskSummary;
      if (this.unfinishedTaskSummary) this.dependencies.mode.pause();
      else this.dependencies.mode.resume();

      if (preselectedModel === undefined) {
        await this.dependencies.codex.start();
        const available = await this.dependencies.codex.listModels();
        this.selectedModel = selectModel(available, this.dependencies.preferredModel);
      } else {
        this.selectedModel = preselectedModel;
      }
      this.threadId = await this.dependencies.codex.startThread({
        cwd: this.dependencies.cwd,
        model: this.selectedModel,
        reasoningEffort: this.dependencies.reasoningEffort,
      });
      if (generation !== this.generation) return;
      this.codexHealthy = this.unfinishedTaskSummary === null;
      this.running = true;
      this.unsubscribeActionResult = this.dependencies.executor.onResult((result) => {
        if (!this.running || result.status !== "failed") return;
        try {
          this.dependencies.autonomy.notifyActionFailed();
        } catch {
          // Scheduler observation must never affect the action result.
        }
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
    }
  }

  async stop(): Promise<void> {
    if (!this.running && !this.starting) return;
    this.running = false;
    this.generation += 1;
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
    this.interruptActive();
    this.activeTurn = undefined;
    const tail = this.turnTail;
    const recovery = this.recoveryFlight;
    const stoppingCodex = this.externallyManagedCodex
      ? Promise.resolve()
      : this.dependencies.codex
          .stop()
          .catch((error: unknown) =>
            this.logger.error("codex_stop_failed", { code: String(error) }),
          );
    const pendingWork =
      this.externallyManagedCodex && recovery
        ? []
        : [tail.catch(() => undefined), recovery?.catch(() => undefined)];
    await Promise.all([...pendingWork, stoppingCodex]);
  }

  private async handleEvent(event: MinecraftEvent): Promise<void> {
    if (!this.running) return;
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
    if (event.kind === "owner_offline") {
      if (event.username !== this.dependencies.ownerUsername) return;
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
      this.dependencies.confirmations.clear();
      this.dependencies.executor.stopAll();
      this.dependencies.mode.setMode("friend");
      this.dependencies.autonomy.notifyModeChanged();
      this.dependencies.mode.completeTask();
      if (this.unfinishedTaskSummary) this.dependencies.mode.pause();
      else this.dependencies.mode.resume();
      await this.persist();
    }
  }

  private onOwnerMessage(message: string): void {
    if (this.dependencies.mode.getMode() === "autonomous" || this.autonomousRequestCount > 0) {
      this.dependencies.mode.completeTask();
      this.dependencies.taskController.stop("owner_stop");
      this.dependencies.executor.stopAll();
      this.invalidateCurrentTurn();
      this.dependencies.mode.resume();
      this.unfinishedTaskSummary = null;
      void this.persist().catch((error: unknown) =>
        this.logger.error("state_save_failed", { code: String(error) }),
      );
    }
    this.mergedMessages.push(message);
    if (this.mergeTimer !== undefined) return;
    const expectedGeneration = this.generation;
    this.mergeTimer = this.setTimer(() => {
      this.mergeTimer = undefined;
      const combined = this.mergedMessages.splice(0).join("\n");
      if (combined) this.enqueueTurn(combined, expectedGeneration);
    }, 750);
  }

  private enqueueTurn(text: string, generation: number): void {
    this.turnTail = this.turnTail
      .catch(() => undefined)
      .then(() => this.performTurn(text, generation))
      .catch((error: unknown) =>
        this.logger.error("companion_turn_failed", { code: String(error) }),
      );
  }

  private async performTurn(text: string, generation: number): Promise<void> {
    try {
      this.turnWorkCount += 1;
      if (!this.isCurrent(generation) || !this.threadId || this.dependencies.mode.snapshot().paused)
        return;
      const disclosure = turnDisclosure(text);
      let prompt: string;
      try {
        const input = {
          mode: this.dependencies.mode.getMode(),
          world: await this.dependencies.minecraft.snapshot(this.dependencies.ownerUsername),
          memories: (await this.dependencies.memories.search(text)).slice(0, 8),
        };
        prompt = buildCompanionTurn({ ...input, ownerMessage: text });
      } catch (error) {
        await this.failClosed(generation, error);
        return;
      }
      const outcome = await this.resolveOutcome(prompt, generation, text, disclosure);
      if (!outcome || !this.isCurrent(generation)) return;
      await this.persistOutcome(outcome, generation, text);
      if (!this.isCurrent(generation)) return;
      await this.sendOutcomeReply(outcome.reply, generation, false);
    } finally {
      this.turnWorkCount -= 1;
    }
  }

  async requestAutonomousTurn(reason: AutonomyReason): Promise<void> {
    if (!this.running) return;
    const state = this.dependencies.mode.snapshot();
    if (state.mode === "friend" || state.paused) return;
    const generation = this.generation;
    this.autonomousRequestCount += 1;
    const queued = this.turnTail
      .catch(() => undefined)
      .then(() => this.performAutonomousTurn(reason, generation))
      .catch((error: unknown) =>
        this.logger.error("companion_autonomous_turn_failed", { code: String(error) }),
      );
    this.turnTail = queued;
    try {
      await queued;
    } finally {
      this.autonomousRequestCount -= 1;
    }
  }

  isBusyForAutonomy(): boolean {
    return (
      this.turnWorkCount > 0 ||
      this.activeTurn !== undefined ||
      this.recoveryFlight !== undefined ||
      this.dependencies.executor.isBusy() ||
      this.mergeTimer !== undefined ||
      this.mergedMessages.length > 0
    );
  }

  private async performAutonomousTurn(reason: AutonomyReason, generation: number): Promise<void> {
    this.turnWorkCount += 1;
    try {
      if (!this.isCurrent(generation) || !this.threadId) return;
      const state = this.dependencies.mode.snapshot();
      if (state.mode === "friend" || state.paused) return;
      if (!(await this.dependencies.minecraft.isOwnerOnline(this.dependencies.ownerUsername)))
        return;
      if (!this.isCurrent(generation)) return;
      const disclosure = turnDisclosure(`自主微任务：${reason}`);
      let prompt: string;
      try {
        prompt = buildCompanionAutonomousTurn({
          mode: this.dependencies.mode.getMode(),
          reason,
          world: await this.dependencies.minecraft.snapshot(this.dependencies.ownerUsername),
          memories: (await this.dependencies.memories.search(reason)).slice(0, 8),
        });
      } catch (error) {
        await this.failClosed(generation, error);
        return;
      }
      const outcome = await this.resolveOutcome(prompt, generation, undefined, disclosure);
      if (!outcome || !this.isCurrent(generation)) return;
      await this.persistOutcome(outcome, generation);
      if (!this.isCurrent(generation)) return;
      await this.sendOutcomeReply(outcome.reply, generation, true);
    } finally {
      this.turnWorkCount -= 1;
    }
  }

  private async resolveOutcome(
    prompt: string,
    generation: number,
    ownerText?: string,
    disclosure?: TaskDisclosure,
  ): Promise<CompanionTurnOutcome | undefined> {
    let outcome: CompanionTurnOutcome | undefined;
    let task: ActiveTask | undefined;
    let taskStopReason: TaskStopReason = "failed";
    try {
      if (disclosure) {
        task = this.dependencies.taskController.start(disclosure);
        await this.say(disclosureMessage(task.disclosure));
        if (!this.isCurrent(generation)) return undefined;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await this.sendAttempt(
          attempt === 0 ? prompt : repairPrompt,
          generation,
          true,
          task,
        );
        if (!result) return undefined;
        const parsed = companionTurnOutcomeSchema.safeParse(this.parseJson(result.text));
        if (!parsed.success || !this.memoryCandidatesValid(parsed.data, ownerText)) continue;
        outcome = parsed.data;
        break;
      }
      if (!outcome) {
        if (task) {
          this.dependencies.taskController.stop("failed");
          task = undefined;
        }
        await this.failClosed(generation, new Error("invalid structured Codex output"));
        return undefined;
      }
      taskStopReason = "completed";
      return outcome;
    } catch (error) {
      if (task) {
        this.dependencies.taskController.stop("failed");
        task = undefined;
      }
      await this.failClosed(generation, error);
      return undefined;
    } finally {
      if (task && this.dependencies.taskController.current()?.id === task.id) {
        this.dependencies.taskController.stop(taskStopReason);
      }
    }
  }

  private async sendOutcomeReply(
    reply: string,
    generation: number,
    proactive: boolean,
  ): Promise<void> {
    if (!reply || !this.isCurrent(generation)) return;
    if (proactive) {
      if (
        this.dependencies.mode.getMode() === "friend" ||
        !this.dependencies.autonomy.canChatProactively()
      ) {
        return;
      }
    }
    let marked = false;
    for (const chunk of splitForMinecraft(reply)) {
      if (!this.isCurrent(generation)) return;
      await this.dependencies.minecraft.say(chunk);
      if (proactive && !marked) {
        this.dependencies.autonomy.markProactiveChat();
        marked = true;
      }
    }
  }

  private async sendAttempt(
    text: string,
    generation: number,
    failClosedOnError = true,
    task?: ActiveTask,
  ): Promise<CodexTurnResult | undefined> {
    if (!this.threadId || !this.isCurrent(generation)) return undefined;
    let cancel!: () => void;
    const cancelled = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined);
    });
    const attemptThreadId = this.threadId;
    const active: ActiveTurn = { generation, threadId: attemptThreadId, cancel };
    this.activeTurn = active;
    let budgetStarted = false;
    try {
      if (task && this.dependencies.taskController.current()?.id !== task.id) {
        return undefined;
      }
      const toolLease = this.dependencies.budget.begin(task?.lease);
      budgetStarted = true;
      const original = this.dependencies.codex.sendTurn(
        attemptThreadId,
        attachToolLease(text, toolLease, task?.lease.id),
        (turnId) => {
          if (!this.isCurrent(generation) || this.activeTurn !== active) {
            void this.dependencies.codex
              .interrupt(attemptThreadId, turnId)
              .catch((error: unknown) =>
                this.logger.error("codex_interrupt_failed", { code: String(error) }),
              );
            return;
          }
          active.turnId = turnId;
        },
      );
      const result = await Promise.race([original, cancelled]);
      if (!result) return undefined;
      if (!this.isCurrent(generation)) return undefined;
      if (result.status !== "completed") {
        if (task) this.dependencies.taskController.stop("failed");
        if (failClosedOnError) {
          await this.failClosed(generation, new Error(`Codex turn ${result.status}`));
        }
        return undefined;
      }
      return result;
    } catch (error) {
      if (failClosedOnError) await this.failClosed(generation, error);
      else if (task) this.dependencies.taskController.stop("failed");
      return undefined;
    } finally {
      try {
        if (budgetStarted) this.dependencies.budget.end();
      } finally {
        if (this.activeTurn === active) this.activeTurn = undefined;
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

  private memoryCandidatesValid(outcome: CompanionTurnOutcome, ownerText?: string): boolean {
    try {
      const source = memoryValidationSource(outcome, ownerText);
      for (const candidate of outcome.memoryCandidates)
        this.dependencies.memories.validateCandidate(candidate, source);
      return true;
    } catch {
      return false;
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
    const queued = this.turnTail.catch(() => undefined).then(() => this.recover(generation));
    let tracked!: Promise<void>;
    tracked = queued.finally(() => {
      if (this.recoveryFlight === tracked) this.recoveryFlight = undefined;
    });
    this.recoveryFlight = tracked;
    this.turnTail = tracked.catch((error: unknown) =>
      this.logger.error("companion_recovery_failed", { code: String(error) }),
    );
    return tracked;
  }

  private async recover(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    this.codexHealthy = false;
    this.dependencies.mode.pause();
    try {
      await this.persist();
      if (!this.isCurrent(generation)) return;
      await this.dependencies.codex.stop().catch(() => undefined);
      if (!this.isCurrent(generation)) return;
      await this.dependencies.codex.start();
      if (!this.isCurrent(generation)) {
        await this.closeStaleCodex(generation);
        return;
      }
      const models = await this.dependencies.codex.listModels();
      if (!this.isCurrent(generation)) {
        await this.closeStaleCodex(generation);
        return;
      }
      this.selectedModel = selectModel(models, this.dependencies.preferredModel);
      if (!this.isCurrent(generation)) return;
      this.threadId = await this.dependencies.codex.startThread({
        cwd: this.dependencies.cwd,
        model: this.selectedModel,
        reasoningEffort: this.dependencies.reasoningEffort,
      });
      if (!this.isCurrent(generation)) {
        await this.closeStaleCodex(generation);
        return;
      }
      const summary = this.unfinishedTaskSummary ?? "Codex session recovery handshake";
      const prompt = buildCompanionRecoveryTurn({
        mode: this.dependencies.mode.getMode(),
        world: await this.dependencies.minecraft.snapshot(this.dependencies.ownerUsername),
        memories: (await this.dependencies.memories.search(summary)).slice(0, 8),
        summary,
      });
      let recovered: CompanionTurnOutcome | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await this.sendAttempt(
          attempt === 0 ? prompt : repairPrompt,
          generation,
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
          if (!this.codexHealthy || this.unfinishedTaskSummary) {
            await this.recoverSingleFlight();
            return;
          }
          this.dependencies.mode.resume();
          await this.persist();
          await this.say("已恢复。");
          return;
        case "stop":
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
          this.dependencies.confirmations.deny(command.confirmationId);
          await this.say("已取消确认。");
          return;
        case "allow":
          await this.allow(command.confirmationId);
          return;
      }
    } catch (error) {
      await this.logger.error("local_command_failed", { code: String(error) });
      await this.say("本地命令未能完成。");
    }
  }

  private async allow(id: number): Promise<void> {
    const pendingBeforeContext = this.dependencies.confirmations.get(id);
    if (!pendingBeforeContext) {
      await this.say("确认不存在或已过期。");
      return;
    }
    if (pendingBeforeContext.operation.kind === "game_action") {
      let context: SafetyContext;
      try {
        context = await this.dependencies.safetyContextProvider();
      } catch {
        await this.say("无法取得安全上下文，确认未被使用。");
        return;
      }
      const pending = this.dependencies.confirmations.get(id);
      if (!pending || pending.operation.kind !== "game_action") {
        await this.say("确认不存在或已过期。");
        return;
      }
      const result = await this.dependencies.executor.executeConfirmed(id, context);
      await this.say(result.status === "completed" ? "已执行确认动作。" : "确认动作未能执行。");
      return;
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

  private interruptActive(): void {
    const active = this.activeTurn;
    if (!active) return;
    active.cancel();
    if (!active.turnId) return;
    void this.dependencies.codex
      .interrupt(active.threadId, active.turnId)
      .catch((error: unknown) =>
        this.logger.error("codex_interrupt_failed", { code: String(error) }),
      );
  }

  private handleTaskTerminal(reason: TaskStopReason): void {
    if (reason !== "timeout" && reason !== "budget_exhausted") return;
    this.invalidateCurrentTurn();
    try {
      this.dependencies.executor.stopAll();
    } catch (error) {
      void this.logger.error("task_terminal_executor_stop_failed", { code: String(error) });
    }
    try {
      this.dependencies.confirmations.clear();
    } catch (error) {
      void this.logger.error("task_terminal_confirmation_clear_failed", { code: String(error) });
    }
    try {
      this.dependencies.mode.stop();
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
    this.activeTurn = undefined;
    this.generation += 1;
    this.clearMergedMessages();
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
