import type { CompanionActionQueue } from "../actions/actionQueue.js";
import type { TaskLease } from "../safety/taskBudget.js";

const FARMING_PERMISSION_TIMEOUT_MS = 30_000;

export type FarmingPermissionResult = "allowed" | "denied" | "timeout" | "cancelled";

export interface FarmingPermissionRequest {
  readonly plotSummary: string;
  readonly requestedAt: number;
}

export interface FarmingPermissionExecutionContext {
  readonly taskLease: TaskLease;
  readonly worldGeneration: number;
}

export interface FarmingPermissionCoordinatorOptions {
  readonly actionQueue: CompanionActionQueue;
  readonly executionContext: () => FarmingPermissionExecutionContext | null;
  readonly setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface ActivePermissionRequest {
  readonly epoch: number;
  readonly itemId: string;
  readonly taskLease: TaskLease;
  readonly promise: Promise<FarmingPermissionResult>;
  readonly resolvePromise: (result: FarmingPermissionResult) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class FarmingPermissionCoordinator {
  readonly #setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  #active: ActivePermissionRequest | undefined;
  #nextEpoch = 0;

  constructor(private readonly options: FarmingPermissionCoordinatorOptions) {
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  request(input: FarmingPermissionRequest): Promise<FarmingPermissionResult> {
    if (this.#active !== undefined) {
      throw new Error("farming permission request is already pending");
    }
    if (
      typeof input.plotSummary !== "string" ||
      input.plotSummary.trim().length === 0 ||
      Array.from(input.plotSummary).length > 160 ||
      !Number.isFinite(input.requestedAt)
    ) {
      throw new Error("farming permission request is invalid");
    }
    const context = this.options.executionContext();
    if (context === null) throw new Error("farming permission task authority is unavailable");
    const item = this.options.actionQueue.beginPermissionWait({
      taskLease: context.taskLease,
      worldGeneration: context.worldGeneration,
      permission: "wheat_farming",
      summary: input.plotSummary,
    });
    let resolvePromise!: (result: FarmingPermissionResult) => void;
    const promise = new Promise<FarmingPermissionResult>((resolve) => {
      resolvePromise = resolve;
    });
    const active: ActivePermissionRequest = {
      epoch: ++this.#nextEpoch,
      itemId: item.id,
      taskLease: { ...context.taskLease },
      promise,
      resolvePromise,
    };
    this.#active = active;
    const timer = this.#setTimer(
      () => this.#finish(active, "timeout", "timeout"),
      FARMING_PERMISSION_TIMEOUT_MS,
    );
    if (this.#active === active) active.timer = timer;
    else this.#clearTimer(timer);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    return promise;
  }

  resolve(result: "allowed" | "denied", expectedEpoch?: number): boolean {
    const active = this.#active;
    if (active === undefined || (expectedEpoch !== undefined && active.epoch !== expectedEpoch)) {
      return false;
    }
    this.#finish(active, result, result);
    return true;
  }

  cancel(reason: string): void {
    const active = this.#active;
    if (active === undefined) return;
    this.#finish(active, "cancelled", reason);
  }

  isPending(): boolean {
    return this.#active !== undefined;
  }

  pendingEpoch(): number | undefined {
    return this.#active?.epoch;
  }

  isPendingEpoch(epoch: number): boolean {
    return this.#active?.epoch === epoch;
  }

  #finish(active: ActivePermissionRequest, result: FarmingPermissionResult, reason: string): void {
    if (this.#active !== active) return;
    this.#active = undefined;
    if (active.timer !== undefined) this.#clearTimer(active.timer);
    this.options.actionQueue.resolvePermission(
      active.itemId,
      active.taskLease,
      result === "allowed" || result === "denied" ? "completed" : "cancelled",
      reason,
    );
    active.resolvePromise(result);
  }
}
