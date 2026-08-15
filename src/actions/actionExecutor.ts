import type { GameAction, SafetyDecision } from "../domain/types.js";
import type { MinecraftPort } from "../minecraft/minecraftPort.js";
import type { ConfirmationStore } from "../safety/confirmationStore.js";
import type { SafetyContext } from "../safety/safetyEngine.js";
import type { TaskBudgetDecision, TaskLease } from "../safety/taskBudget.js";

export interface ActionSafety {
  evaluate(action: GameAction, context: SafetyContext): SafetyDecision;
  evaluatePermanent(action: GameAction, context: SafetyContext): SafetyDecision;
}

export type ActionResult =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "denied"; reason: string }
  | { status: "confirmation_required"; confirmationId: number; reason: string }
  | {
      status: "confirmation_invalid";
      reason: "missing" | "expired" | "wrong_operation" | "wrong_task";
    }
  | { status: "failed"; reason: string; worldMutated?: boolean };

export type ActionResultListener = (result: Readonly<ActionResult>) => void;

export interface StopAllOptions {
  readonly preserveTask?: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  settled: boolean;
}

interface ActionJob {
  action: GameAction;
  context: SafetyContext;
  confirmed: boolean;
  generation: number;
  result: Deferred<ActionResult>;
  pending: boolean;
  controller?: AbortController;
  timeout: ReturnType<typeof setTimeout> | undefined;
  timedOut: boolean;
  taskLease?: TaskLease;
}

export interface ConfirmedActionAuthority {
  isLeaseLive(lease: TaskLease): boolean;
  reserveAdditionalTravel(lease: TaskLease, horizontalTravel: number): TaskBudgetDecision;
}

const noConfirmedActionAuthority: ConfirmedActionAuthority = {
  isLeaseLive: () => false,
  reserveAdditionalTravel: () => ({ ok: false, reason: "task lease is invalid" }),
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve(value: T): void {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
    settled: false,
  };
  return result;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTransportFenceError(error: unknown): boolean {
  return error instanceof Error && error.name === "MineflayerTransportFenceError";
}

export class ActionExecutor {
  private current: ActionJob | null = null;
  private gate = Promise.resolve();
  private generation = 0;
  private pending = 0;
  private readonly jobs = new Set<ActionJob>();
  private readonly resultListeners = new Set<ActionResultListener>();

  constructor(
    private readonly minecraft: MinecraftPort,
    private readonly safety: ActionSafety,
    private readonly confirmations: ConfirmationStore,
    private readonly ownerUsername: () => string,
    private readonly beforeStopAll: () => void = () => undefined,
    private readonly confirmedActionAuthority: ConfirmedActionAuthority = noConfirmedActionAuthority,
  ) {}

  execute(action: GameAction, context: SafetyContext): Promise<ActionResult> {
    return this.enqueue(action, context, false);
  }

  executeConfirmed(
    confirmationId: number,
    context: SafetyContext,
    taskLease?: TaskLease,
    additionalHorizontalTravel = 0,
  ): Promise<ActionResult> {
    try {
      if (!taskLease || !this.confirmedActionAuthority.isLeaseLive(taskLease)) {
        return Promise.resolve({ status: "confirmation_invalid", reason: "wrong_task" });
      }
      const approved = this.confirmations.allowGameAction(confirmationId, taskLease);
      if (!approved.ok) {
        return Promise.resolve({ status: "confirmation_invalid", reason: approved.reason });
      }
      if (!this.confirmedActionAuthority.isLeaseLive(taskLease)) {
        return Promise.resolve({ status: "confirmation_invalid", reason: "wrong_task" });
      }
      if (additionalHorizontalTravel > 0) {
        const reserved = this.confirmedActionAuthority.reserveAdditionalTravel(
          taskLease,
          additionalHorizontalTravel,
        );
        if (!reserved.ok) {
          const result = { status: "failed" as const, reason: reserved.reason };
          this.publishResult(result);
          return Promise.resolve(result);
        }
      }
      return this.enqueue(approved.action, context, true, taskLease);
    } catch (error) {
      const result = { status: "failed" as const, reason: String(error) };
      this.publishResult(result);
      return Promise.resolve(result);
    }
  }

  onResult(listener: ActionResultListener): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  stopAll(options: StopAllOptions = {}): void {
    if (!options.preserveTask) this.beforeStopAll();
    const stoppedGeneration = this.generation;
    this.generation += 1;
    for (const job of this.jobs) {
      if (job.generation === stoppedGeneration && job !== this.current) {
        this.finishUser(job, { status: "cancelled" });
      }
    }
    if (this.current?.generation === stoppedGeneration) {
      this.clearTimeout(this.current);
      this.current.controller?.abort();
    }
  }

  pendingCount(): number {
    return this.pending;
  }

  isBusy(): boolean {
    return this.jobs.size > 0;
  }

  private enqueue(
    action: GameAction,
    context: SafetyContext,
    confirmed: boolean,
    taskLease?: TaskLease,
  ): Promise<ActionResult> {
    const job: ActionJob = {
      action,
      context,
      confirmed,
      generation: this.generation,
      result: deferred<ActionResult>(),
      pending: true,
      timeout: undefined,
      timedOut: false,
      ...(taskLease === undefined ? {} : { taskLease: { ...taskLease } }),
    };
    this.pending += 1;
    this.jobs.add(job);
    this.gate = this.gate.then(
      () => this.run(job),
      () => this.run(job),
    );
    return job.result.promise;
  }

  private async run(job: ActionJob): Promise<void> {
    try {
      if (job.result.settled || job.generation !== this.generation) {
        this.finishUser(job, { status: "cancelled" });
        return;
      }
      if (job.taskLease && !this.confirmedActionAuthority.isLeaseLive(job.taskLease)) {
        this.finishUser(job, { status: "cancelled" });
        return;
      }
      const decision = job.confirmed
        ? this.safety.evaluatePermanent(job.action, job.context)
        : this.safety.evaluate(job.action, job.context);
      if (decision.kind === "deny") {
        this.finishUser(job, { status: "denied", reason: decision.reason });
        return;
      }
      if (decision.kind === "confirm") {
        this.finishUser(job, {
          status: "confirmation_required",
          confirmationId: decision.confirmationId,
          reason: decision.reason,
        });
        return;
      }

      job.controller = new AbortController();
      this.current = job;
      job.timeout = setTimeout(() => {
        job.timedOut = true;
        this.clearTimeout(job);
        job.controller?.abort();
      }, this.timeoutFor(job.action));
      try {
        await this.dispatch(job.action, job.controller.signal);
        this.finishUser(
          job,
          job.timedOut
            ? { status: "failed", reason: "action timed out" }
            : job.controller.signal.aborted
              ? { status: "cancelled" }
              : { status: "completed" },
        );
      } catch (error) {
        if (isTransportFenceError(error)) {
          this.finishUser(job, { status: "failed", reason: String(error) });
        } else if (job.timedOut) {
          this.finishUser(job, { status: "failed", reason: "action timed out" });
        } else if (job.controller.signal.aborted || isAbortError(error)) {
          this.finishUser(job, { status: "cancelled" });
        } else {
          this.finishUser(job, { status: "failed", reason: String(error) });
        }
      } finally {
        this.clearTimeout(job);
        if (this.current === job) this.current = null;
      }
    } catch (error) {
      this.finishUser(job, { status: "failed", reason: String(error) });
    } finally {
      this.clearTimeout(job);
      if (this.current === job) this.current = null;
      this.jobs.delete(job);
    }
  }

  private finishUser(job: ActionJob, result: ActionResult): void {
    if (job.result.settled) return;
    job.result.resolve(result);
    if (job.pending) {
      job.pending = false;
      this.pending -= 1;
    }
    this.publishResult(result);
  }

  private publishResult(result: ActionResult): void {
    for (const listener of this.resultListeners) {
      try {
        listener(Object.freeze({ ...result }) as ActionResult);
      } catch {
        // Observers are diagnostic/lifecycle notifications and cannot affect action results.
      }
    }
  }

  private clearTimeout(job: ActionJob): void {
    if (job.timeout !== undefined) clearTimeout(job.timeout);
    job.timeout = undefined;
  }

  private timeoutFor(action: GameAction): number {
    if (action.kind === "move_to" || action.kind === "follow_owner") return 30_000;
    if (action.kind === "craft_item") return 20_000;
    if (action.kind === "smelt_item") return 70_000;
    if (action.kind === "wait") return Math.min(action.milliseconds + 1_000, 11_000);
    if (action.kind === "dig_block" || action.kind === "place_block") return 15_000;
    return 10_000;
  }

  private async dispatch(action: GameAction, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw this.abortError();
    switch (action.kind) {
      case "say":
        await this.minecraft.say(action.message);
        return;
      case "move_to":
        await this.minecraft.moveTo(action.position, signal);
        return;
      case "follow_owner":
        await this.minecraft.followOwner(this.ownerUsername(), action.distance, signal);
        return;
      case "look_at":
        await this.minecraft.lookAt(action.position, signal);
        return;
      case "jump":
        await this.minecraft.jump(signal);
        return;
      case "dig_block":
        await this.minecraft.digBlock(action.position, action.blockName, signal);
        return;
      case "place_block":
        await this.minecraft.placeBlock(action.position, action.blockName, signal);
        return;
      case "craft_item":
        await this.minecraft.craftItem(action.itemName, action.count, signal);
        return;
      case "smelt_item":
        await this.minecraft.smeltItem(action.itemName, action.count, signal);
        return;
      case "collect_dropped":
        await this.minecraft.collectDropped(action.entityId, signal);
        return;
      case "equip_item":
        await this.minecraft.equipItem(action.itemName, action.destination, signal);
        return;
      case "attack_hostile":
        await this.minecraft.attackHostile(action.entityId, signal);
        return;
      case "wait":
        await this.minecraft.wait(action.milliseconds, signal);
        return;
      case "fish":
        await this.minecraft.fish(signal);
        return;
      case "consume_item":
        await this.minecraft.consumeItem(action.itemName, signal);
        return;
      case "sleep_in_bed":
        await this.minecraft.sleepInBed(action.position, signal);
        return;
      case "wake_up":
        await this.minecraft.wakeUp(signal);
        return;
      case "till_soil":
        await this.minecraft.tillSoil(action.position, signal);
        return;
      case "plant_crop":
        await this.minecraft.plantCrop(action.position, action.seedName, signal);
        return;
      case "harvest_crop":
        await this.minecraft.harvestCrop(action.position, action.cropName, signal);
        return;
      default: {
        const exhaustive: never = action;
        throw new Error(`Unhandled action: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private abortError(): Error {
    const error = new Error("aborted");
    error.name = "AbortError";
    return error;
  }
}
