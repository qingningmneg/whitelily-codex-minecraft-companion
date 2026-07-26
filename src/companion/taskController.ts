import {
  TaskControllerBudget,
  type TaskBudgetDecision,
  type TaskConsumption,
  type TaskLease,
  type TaskLimits,
  type TaskStopReason,
} from "../safety/taskBudget.js";

export interface TaskDisclosure {
  goal: string;
  expectedActions: string[];
  limits: TaskLimits;
  stopCondition: string;
}

export interface ActiveTask {
  id: string;
  lease: TaskLease;
  disclosure: TaskDisclosure;
  startedAt: string;
}

export type TaskAuditEvent = "task_started" | "task_stopped";

export type TaskAuditData = { task: ActiveTask } | { task: ActiveTask; reason: TaskStopReason };

export type TaskAuditCallback = (event: TaskAuditEvent, data: TaskAuditData) => void;

export interface TaskControllerDependencies {
  onTerminal?: (reason: TaskStopReason) => void;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type TaskControllerConsumption = Omit<TaskConsumption, "lease"> & { leaseId: string };

const taskLimitKeys = [
  "maxToolCalls",
  "maxBlockChanges",
  "maxHorizontalTravel",
  "maxDurationMs",
  "maxDangerousOperations",
] as const;

const taskStopReasons = new Set<TaskStopReason>([
  "completed",
  "failed",
  "timeout",
  "budget_exhausted",
  "owner_stop",
  "emergency_stop",
  "disconnect",
  "world_changed",
  "model_unavailable",
  "process_exit",
]);

export class TaskController {
  private activeTask: ActiveTask | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly terminalListeners = new Set<(reason: TaskStopReason) => void>();
  private readonly setTimer: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(
    private readonly budget = new TaskControllerBudget(),
    private readonly audit: TaskAuditCallback = () => undefined,
    private readonly dependencies: TaskControllerDependencies = {},
  ) {
    this.setTimer = dependencies.setTimer ?? setTimeout;
    this.clearTimer = dependencies.clearTimer ?? clearTimeout;
    this.budget.onInvalidated((reason) => this.finish(reason, true));
  }

  start(disclosure: TaskDisclosure, requested?: Partial<TaskLimits>): ActiveTask {
    this.reconcileBudget();
    if (this.activeTask) throw new Error("a task is already active");
    const safeDisclosure = cloneAndValidateDisclosure(disclosure);
    const safeRequested = cloneAndValidateRequestedLimits(requested);
    const lease = this.budget.begin(safeRequested ?? safeDisclosure.limits);
    try {
      if (lease.id.trim().length === 0) throw new Error("task lease id is invalid");
      const startedAt = new Date(lease.startedAt);
      if (Number.isNaN(startedAt.getTime())) throw new Error("task start time is invalid");
      const active: ActiveTask = {
        id: lease.id,
        lease: { ...lease },
        disclosure: {
          ...safeDisclosure,
          limits: { ...this.budget.snapshot().limits },
        },
        startedAt: startedAt.toISOString(),
      };
      this.activeTask = active;
      this.emitAudit("task_started", { task: cloneActiveTask(active) });
      this.scheduleDeadline(active);
      return cloneActiveTask(active);
    } catch (error) {
      this.budget.invalidate("failed");
      throw error;
    }
  }

  consume(input: Omit<TaskConsumption, "lease"> & { leaseId: string }): TaskBudgetDecision {
    this.reconcileBudget();
    const active = this.activeTask;
    if (!active || !isConsumptionInput(input) || input.leaseId !== active.lease.id) {
      return { ok: false, reason: "task lease is invalid" };
    }
    const result = this.budget.consume({
      lease: { ...active.lease },
      kind: input.kind,
      now: input.now,
      ...(input.blockChanges === undefined ? {} : { blockChanges: input.blockChanges }),
      ...(input.horizontalTravel === undefined ? {} : { horizontalTravel: input.horizontalTravel }),
      ...(input.dangerousOperations === undefined
        ? {}
        : { dangerousOperations: input.dangerousOperations }),
    });
    const snapshot = this.budget.snapshot();
    if (!snapshot.active) this.finish(snapshot.stopReason ?? "failed", true);
    return result;
  }

  stop(reason: TaskStopReason): void {
    this.reconcileBudget();
    if (!taskStopReasons.has(reason)) {
      this.finish("failed");
      throw new Error("task stop reason is invalid");
    }
    this.finish(reason);
  }

  current(): ActiveTask | null {
    this.reconcileBudget();
    return this.activeTask ? cloneActiveTask(this.activeTask) : null;
  }

  onTerminal(listener: (reason: TaskStopReason) => void): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  private reconcileBudget(): void {
    if (!this.activeTask) return;
    const snapshot = this.budget.snapshot();
    if (!snapshot.active) this.finish(snapshot.stopReason ?? "failed", true);
  }

  private finish(reason: TaskStopReason, budgetAlreadyStopped = false): void {
    const active = this.activeTask;
    if (!active) return;
    this.activeTask = undefined;
    this.clearDeadline();
    if (!budgetAlreadyStopped) this.budget.invalidate(reason);
    this.emitAudit("task_stopped", {
      task: cloneActiveTask(active),
      reason,
    });
    try {
      this.dependencies.onTerminal?.(reason);
    } catch {
      // Terminal observers cannot affect task lifecycle or lease invalidation.
    }
    for (const listener of this.terminalListeners) {
      try {
        listener(reason);
      } catch {
        // Terminal observers cannot affect task lifecycle or lease invalidation.
      }
    }
  }

  private scheduleDeadline(active: ActiveTask): void {
    const leaseId = active.lease.id;
    const timer = this.setTimer(() => {
      if (this.deadlineTimer !== timer) return;
      this.deadlineTimer = undefined;
      if (this.activeTask?.lease.id !== leaseId) return;
      this.finish("timeout");
    }, active.disclosure.limits.maxDurationMs);
    this.deadlineTimer = timer;
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  }

  private clearDeadline(): void {
    const timer = this.deadlineTimer;
    this.deadlineTimer = undefined;
    if (timer !== undefined) this.clearTimer(timer);
  }

  private emitAudit(event: TaskAuditEvent, data: TaskAuditData): void {
    try {
      this.audit(event, cloneAuditData(data));
    } catch {
      // Audit observers cannot affect task lifecycle or lease invalidation.
    }
  }
}

function cloneAndValidateDisclosure(input: TaskDisclosure): TaskDisclosure {
  if (typeof input !== "object" || input === null) throw new Error("task disclosure is invalid");
  const candidate = input as unknown as Record<string, unknown>;
  const goal = candidate.goal;
  const stopCondition = candidate.stopCondition;
  const actionInput = candidate.expectedActions;
  if (typeof goal !== "string" || goal.trim().length === 0)
    throw new Error("task goal cannot be empty");
  if (typeof stopCondition !== "string" || stopCondition.trim().length === 0)
    throw new Error("task stop condition cannot be empty");
  if (!Array.isArray(actionInput)) throw new Error("task expected actions must be an array");
  const expectedActions = [...actionInput] as unknown[];
  if (expectedActions.length > 16) throw new Error("task expected actions cannot exceed 16 labels");
  if (expectedActions.some((label) => typeof label !== "string" || label.trim().length === 0)) {
    throw new Error("task expected action labels must be non-empty strings");
  }
  const limits = cloneAndValidateLimits(candidate.limits as TaskLimits);
  return {
    goal,
    expectedActions: expectedActions as string[],
    limits,
    stopCondition,
  };
}

function cloneAndValidateLimits(input: TaskLimits): TaskLimits {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("task limits are invalid");
  const candidate = input as unknown as Record<string, unknown>;
  const cloned: Record<string, number> = {};
  for (const key of taskLimitKeys) {
    const value = candidate[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new Error("task limits are invalid");
    cloned[key] = value;
  }
  return {
    maxToolCalls: cloned.maxToolCalls!,
    maxBlockChanges: cloned.maxBlockChanges!,
    maxHorizontalTravel: cloned.maxHorizontalTravel!,
    maxDurationMs: cloned.maxDurationMs!,
    maxDangerousOperations: cloned.maxDangerousOperations!,
  };
}

function cloneAndValidateRequestedLimits(
  input: Partial<TaskLimits> | undefined,
): Partial<TaskLimits> | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("requested task limits are invalid");
  const values = input as Record<string, unknown>;
  const requested: Partial<Record<(typeof taskLimitKeys)[number], number>> = {};
  for (const key of Object.keys(values)) {
    if (!taskLimitKeys.includes(key as (typeof taskLimitKeys)[number]))
      throw new Error("requested task limits are invalid");
    const value = values[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new Error("requested task limits are invalid");
    requested[key as (typeof taskLimitKeys)[number]] = value;
  }
  return requested;
}

function isConsumptionInput(input: unknown): input is TaskControllerConsumption {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.leaseId === "string" &&
    candidate.leaseId.trim().length > 0 &&
    typeof candidate.kind === "string" &&
    candidate.kind.trim().length > 0 &&
    typeof candidate.now === "number" &&
    Number.isFinite(candidate.now)
  );
}

function cloneActiveTask(task: ActiveTask): ActiveTask {
  return {
    id: task.id,
    lease: { ...task.lease },
    disclosure: {
      goal: task.disclosure.goal,
      expectedActions: [...task.disclosure.expectedActions],
      limits: { ...task.disclosure.limits },
      stopCondition: task.disclosure.stopCondition,
    },
    startedAt: task.startedAt,
  };
}

function cloneAuditData(data: TaskAuditData): TaskAuditData {
  if ("reason" in data) return { task: cloneActiveTask(data.task), reason: data.reason };
  return { task: cloneActiveTask(data.task) };
}
