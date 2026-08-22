import type { ActionResult, StopAllOptions } from "./actionExecutor.js";
import type { CompanionActionQueue } from "./actionQueue.js";
import type { GameAction } from "../domain/types.js";
import type { SafetyContext } from "../safety/safetyEngine.js";
import type { TaskLease } from "../safety/taskBudget.js";

interface QueuedActionExecutor {
  execute(action: GameAction, context: SafetyContext): Promise<ActionResult>;
  stopAll(options?: StopAllOptions): void;
}

export interface QueuedActionExecutionContext {
  readonly taskLease: TaskLease;
  readonly worldGeneration: number;
  readonly safetyContext?: SafetyContext;
}

export interface QueuedActionRunnerOptions {
  readonly queue: CompanionActionQueue;
  readonly executor: QueuedActionExecutor;
  readonly executionContext: () => QueuedActionExecutionContext | null;
  readonly safetyContextProvider?: () => Promise<SafetyContext>;
}

export type QueueRunnerEvent =
  | { readonly kind: "batch_completed"; readonly taskLease: TaskLease }
  | { readonly kind: "action_failed"; readonly taskLease: TaskLease; readonly reason: string }
  | { readonly kind: "world_stale"; readonly taskLease: TaskLease }
  | { readonly kind: "budget_boundary"; readonly taskLease: TaskLease; readonly reason: string };

export interface CompletedQueuedAction {
  readonly taskLease: TaskLease;
  readonly action: GameAction;
}

function taskLeaseKey(taskLease: TaskLease): string {
  return `${taskLease.id}\u0000${taskLease.startedAt}`;
}

export class QueuedActionRunner {
  readonly #queue: CompanionActionQueue;
  readonly #executor: QueuedActionExecutor;
  readonly #executionContext: () => QueuedActionExecutionContext | null;
  readonly #safetyContextProvider: (() => Promise<SafetyContext>) | undefined;
  readonly #idleWaiters = new Set<() => void>();
  readonly #listeners = new Set<(event: QueueRunnerEvent) => void>();
  readonly #completedActionListeners = new Set<(event: CompletedQueuedAction) => void>();
  #started = false;
  #scheduled = false;
  #running = false;
  #generation = 0;
  #batchHadWork = false;
  #worldStaleEventPending = false;
  #suspendedTaskKey: string | undefined;

  constructor(options: QueuedActionRunnerOptions) {
    this.#queue = options.queue;
    this.#executor = options.executor;
    this.#executionContext = options.executionContext;
    this.#safetyContextProvider = options.safetyContextProvider;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#queue.subscribe((event) => {
      if (event.item.status === "waiting") this.#schedule();
      if (event.item.status === "cancelled" && event.item.reason === "world generation changed") {
        const context = this.#executionContext();
        if (context && !this.#worldStaleEventPending) {
          this.#worldStaleEventPending = true;
          this.#publish({ kind: "world_stale", taskLease: { ...context.taskLease } });
          queueMicrotask(() => {
            this.#worldStaleEventPending = false;
          });
        }
      }
    });
    this.#schedule();
  }

  suspend(taskLease: TaskLease, reason: string): void {
    this.#assertCurrentTask(taskLease);
    this.#generation += 1;
    this.#batchHadWork = false;
    this.#suspendedTaskKey = taskLeaseKey(taskLease);
    this.#executor.stopAll({ preserveTask: true });
    this.#queue.suspendTask(taskLease, reason);
  }

  cancelTask(taskLease: TaskLease, reason: string): void {
    this.#assertCurrentTask(taskLease);
    this.#generation += 1;
    this.#batchHadWork = false;
    if (this.#suspendedTaskKey === taskLeaseKey(taskLease)) this.#suspendedTaskKey = undefined;
    this.#executor.stopAll();
    this.#queue.cancelTask(taskLease, reason);
  }

  resumeAfterReplan(taskLease: TaskLease, worldGeneration: number): void {
    const context = this.#assertCurrentTask(taskLease);
    if (context.worldGeneration !== worldGeneration) {
      throw new Error("runner world generation mismatch");
    }
    if (this.#suspendedTaskKey === taskLeaseKey(taskLease)) this.#suspendedTaskKey = undefined;
    this.#queue.resumeTaskAfterReplan(taskLease, worldGeneration);
    this.#schedule();
  }

  waitForIdle(): Promise<void> {
    if (!this.#running && !this.#scheduled) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  subscribe(listener: (event: QueueRunnerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Internal completion signal; action payloads never enter the public queue projection. */
  subscribeCompletedAction(listener: (event: CompletedQueuedAction) => void): () => void {
    this.#completedActionListeners.add(listener);
    return () => this.#completedActionListeners.delete(listener);
  }

  #schedule(): void {
    if (!this.#started || this.#scheduled || this.#running) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      void this.#pump();
    });
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    const context = this.#executionContext();
    if (!context) {
      this.#resolveIdle();
      return;
    }
    if (this.#suspendedTaskKey === taskLeaseKey(context.taskLease)) {
      this.#resolveIdle();
      return;
    }
    const item = this.#queue.claimNext(context.taskLease, context.worldGeneration);
    if (!item) {
      if (this.#batchHadWork) {
        this.#batchHadWork = false;
        this.#publish({ kind: "batch_completed", taskLease: { ...context.taskLease } });
      }
      this.#resolveIdle();
      return;
    }
    this.#batchHadWork = true;
    this.#running = true;
    const generation = this.#generation;
    let continueBatch = false;
    try {
      let safetyContext: SafetyContext;
      try {
        safetyContext = context.safetyContext ?? (await this.#requiredSafetyContextProvider()());
      } catch (error) {
        if (generation === this.#generation) {
          const reason = String(error);
          this.#queue.fail(item.id, context.taskLease, context.worldGeneration, reason);
          this.#batchHadWork = false;
          this.#publish({
            kind: "action_failed",
            taskLease: { ...context.taskLease },
            reason,
          });
        }
        return;
      }
      if (generation !== this.#generation) return;
      let result = await this.#executor.execute(item.action, safetyContext);
      if (generation !== this.#generation) return;
      if (result.status === "failed" && result.worldMutated === false) {
        this.#queue.recordTransportRetry(item.id, context.taskLease, context.worldGeneration);
        result = await this.#executor.execute(item.action, safetyContext);
        if (generation !== this.#generation) return;
      }
      continueBatch = this.#commitResult(item, context, result);
    } finally {
      this.#running = false;
      if (generation === this.#generation && continueBatch) this.#schedule();
      this.#resolveIdle();
    }
  }

  #commitResult(
    item: { readonly id: string; readonly action: GameAction },
    context: QueuedActionExecutionContext,
    result: ActionResult,
  ): boolean {
    if (result.status === "completed") {
      this.#queue.complete(item.id, context.taskLease, context.worldGeneration);
      this.#publishCompletedAction({ taskLease: { ...context.taskLease }, action: item.action });
      return true;
    }
    if (result.status === "cancelled") {
      this.#queue.cancelTask(context.taskLease, "action cancelled");
      this.#batchHadWork = false;
      this.#publish({
        kind: "action_failed",
        taskLease: { ...context.taskLease },
        reason: "action cancelled",
      });
      return false;
    }
    const reason = result.reason;
    this.#queue.fail(item.id, context.taskLease, context.worldGeneration, reason);
    this.#batchHadWork = false;
    if (
      reason === "task budget exhausted" ||
      reason === "task duration exhausted" ||
      reason === "tool call budget exhausted"
    ) {
      this.#publish({ kind: "budget_boundary", taskLease: { ...context.taskLease }, reason });
    } else {
      this.#publish({ kind: "action_failed", taskLease: { ...context.taskLease }, reason });
    }
    return false;
  }

  #publish(event: QueueRunnerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Lifecycle observers cannot affect queue execution.
      }
    }
  }

  #publishCompletedAction(event: CompletedQueuedAction): void {
    for (const listener of this.#completedActionListeners) {
      try {
        listener({ taskLease: { ...event.taskLease }, action: structuredClone(event.action) });
      } catch {
        // Completion observers cannot affect physical action execution.
      }
    }
  }

  #assertCurrentTask(taskLease: TaskLease): QueuedActionExecutionContext {
    const context = this.#executionContext();
    if (
      !context ||
      context.taskLease.id !== taskLease.id ||
      context.taskLease.startedAt !== taskLease.startedAt
    ) {
      throw new Error("runner task lease mismatch");
    }
    return context;
  }

  #requiredSafetyContextProvider(): () => Promise<SafetyContext> {
    if (!this.#safetyContextProvider) throw new Error("runner safety context is unavailable");
    return this.#safetyContextProvider;
  }

  #resolveIdle(): void {
    if (this.#running || this.#scheduled) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}
