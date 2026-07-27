import { randomBytes } from "node:crypto";

export interface TaskLimits {
  maxToolCalls: number;
  maxBlockChanges: number;
  maxHorizontalTravel: number;
  maxDurationMs: number;
  maxDangerousOperations: number;
}

export const HARD_TASK_LIMITS: Readonly<TaskLimits> = Object.freeze({
  maxToolCalls: 64,
  maxBlockChanges: 256,
  maxHorizontalTravel: 1_024,
  maxDurationMs: 10 * 60 * 1_000,
  maxDangerousOperations: 8,
});

export type TaskStopReason =
  | "completed"
  | "failed"
  | "timeout"
  | "budget_exhausted"
  | "owner_stop"
  | "emergency_stop"
  | "disconnect"
  | "world_changed"
  | "model_unavailable"
  | "process_exit";

export interface TaskLease {
  id: string;
  startedAt: number;
}

export interface TaskConsumption {
  lease: TaskLease;
  kind: string;
  now: number;
  blockChanges?: number;
  horizontalTravel?: number;
  dangerousOperations?: number;
}

export type TaskBudgetDecision =
  | { ok: true; snapshot: TaskBudgetSnapshot }
  | {
      ok: false;
      reason: "task lease is invalid" | "task duration exhausted" | "task budget exhausted";
    };

export interface TaskBudgetSnapshot {
  active: boolean;
  stopReason: TaskStopReason | null;
  limits: TaskLimits;
  toolCalls: number;
  blockChanges: number;
  horizontalTravel: number;
  dangerousOperations: number;
  startedAt: number | null;
}

export type TaskBudgetInvalidationListener = (reason: TaskStopReason) => void;

export function effectiveTaskLimits(requested: Partial<TaskLimits> = {}): TaskLimits {
  return {
    maxToolCalls: clampLimit(requested.maxToolCalls, HARD_TASK_LIMITS.maxToolCalls),
    maxBlockChanges: clampLimit(requested.maxBlockChanges, HARD_TASK_LIMITS.maxBlockChanges),
    maxHorizontalTravel: clampLimit(
      requested.maxHorizontalTravel,
      HARD_TASK_LIMITS.maxHorizontalTravel,
    ),
    maxDurationMs: clampLimit(requested.maxDurationMs, HARD_TASK_LIMITS.maxDurationMs),
    maxDangerousOperations: clampLimit(
      requested.maxDangerousOperations,
      HARD_TASK_LIMITS.maxDangerousOperations,
    ),
  };
}

export class TaskControllerBudget {
  private active = false;
  private stopReason: TaskStopReason | null = null;
  private limits: TaskLimits = { ...HARD_TASK_LIMITS };
  private toolCalls = 0;
  private blockChanges = 0;
  private horizontalTravel = 0;
  private dangerousOperations = 0;
  private activeLease: TaskLease | undefined;
  private readonly invalidationListeners = new Set<TaskBudgetInvalidationListener>();

  constructor(
    private readonly dependencies: {
      now?: () => number;
      randomId?: () => string;
    } = {},
  ) {}

  begin(requested: Partial<TaskLimits> = {}): TaskLease {
    if (this.active) throw new Error("task is already active");
    const startedAt = this.currentTime();
    if (!Number.isFinite(startedAt)) throw new Error("task start time is invalid");

    this.active = true;
    this.stopReason = null;
    this.limits = effectiveTaskLimits(requested);
    this.toolCalls = 0;
    this.blockChanges = 0;
    this.horizontalTravel = 0;
    this.dangerousOperations = 0;
    this.activeLease = Object.freeze({ id: this.randomId(), startedAt });
    return { ...this.activeLease };
  }

  consume(input: TaskConsumption): TaskBudgetDecision {
    if (!isTaskConsumptionShape(input)) return { ok: false, reason: "task lease is invalid" };
    const activeLease = this.activeLease;
    if (
      !this.active ||
      activeLease === undefined ||
      input.lease.id !== activeLease.id ||
      input.lease.startedAt !== activeLease.startedAt
    ) {
      return { ok: false, reason: "task lease is invalid" };
    }
    if (!Number.isFinite(input.now) || input.now < activeLease.startedAt) {
      this.invalidate("timeout");
      return { ok: false, reason: "task duration exhausted" };
    }
    if (input.now - activeLease.startedAt >= this.limits.maxDurationMs) {
      this.invalidate("timeout");
      return { ok: false, reason: "task duration exhausted" };
    }

    const blockChanges = consumptionValue(input.blockChanges);
    const horizontalTravel = consumptionValue(input.horizontalTravel);
    const dangerousOperations = consumptionValue(input.dangerousOperations);
    if (
      blockChanges === undefined ||
      horizontalTravel === undefined ||
      dangerousOperations === undefined ||
      this.toolCalls + 1 > this.limits.maxToolCalls ||
      this.blockChanges + blockChanges > this.limits.maxBlockChanges ||
      this.horizontalTravel + horizontalTravel > this.limits.maxHorizontalTravel ||
      this.dangerousOperations + dangerousOperations > this.limits.maxDangerousOperations
    ) {
      this.invalidate("budget_exhausted");
      return { ok: false, reason: "task budget exhausted" };
    }

    this.toolCalls += 1;
    this.blockChanges += blockChanges;
    this.horizontalTravel += horizontalTravel;
    this.dangerousOperations += dangerousOperations;
    return { ok: true, snapshot: this.snapshot() };
  }

  invalidate(reason: TaskStopReason): void {
    if (!this.active) return;
    this.active = false;
    this.stopReason = reason;
    this.activeLease = undefined;
    for (const listener of this.invalidationListeners) {
      try {
        listener(reason);
      } catch {
        // Invalidating a task lease must not depend on lifecycle observers.
      }
    }
  }

  onInvalidated(listener: TaskBudgetInvalidationListener): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  snapshot(): TaskBudgetSnapshot {
    return Object.freeze({
      active: this.active,
      stopReason: this.stopReason,
      limits: Object.freeze({ ...this.limits }),
      toolCalls: this.toolCalls,
      blockChanges: this.blockChanges,
      horizontalTravel: this.horizontalTravel,
      dangerousOperations: this.dangerousOperations,
      startedAt: this.activeLease?.startedAt ?? null,
    });
  }

  currentTime(): number {
    return (this.dependencies.now ?? Date.now)();
  }

  private randomId(): string {
    return (this.dependencies.randomId ?? (() => randomBytes(32).toString("base64url")))();
  }
}

function clampLimit(requested: number | undefined, hardLimit: number): number {
  if (requested === undefined) return hardLimit;
  if (Number.isNaN(requested)) return 0;
  if (requested === Infinity) return hardLimit;
  if (!Number.isFinite(requested)) return 0;
  return Math.min(Math.max(requested, 0), hardLimit);
}

function consumptionValue(value: number | undefined): number | undefined {
  if (value === undefined) return 0;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isTaskConsumptionShape(input: unknown): input is TaskConsumption {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.kind !== "string" || typeof candidate.now !== "number") return false;
  if (typeof candidate.lease !== "object" || candidate.lease === null) return false;
  const lease = candidate.lease as Record<string, unknown>;
  return typeof lease.id === "string" && Number.isFinite(lease.startedAt);
}
