import { randomUUID } from "node:crypto";
import type { ActiveTask, TaskDisclosure } from "../companion/taskController.js";
import type { MinecraftEvent } from "../minecraft/minecraftPort.js";
import type { TaskBudgetSnapshot, TaskLimits, TaskStopReason } from "../safety/taskBudget.js";
import type { PublicTaskSnapshot, RuntimeEvent, RuntimeSnapshot } from "./runtimeEvents.js";

interface RuntimeLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface RuntimeTaskAccess {
  current(): ActiveTask | null;
  budget(): TaskBudgetSnapshot;
  stop(reason: TaskStopReason): void;
  subscribe?(listener: () => void): () => void;
}

export interface RuntimeFacadeDependencies {
  lifecycle: RuntimeLifecycle;
  task?: RuntimeTaskAccess;
  minecraft?: {
    subscribe(listener: (event: MinecraftEvent) => void): () => void;
  };
  codex?: {
    model(): string | null;
  };
  createPublicTaskId?: () => string;
}

type InspectedTaskState =
  | { kind: "none" }
  | { kind: "unknown" }
  | {
      kind: "active";
      identity: string;
      leaseId: string;
      disclosure: TaskDisclosure;
      startedAt: string;
      budget: TaskBudgetSnapshot;
    };

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

const taskKeys = ["id", "lease", "disclosure", "startedAt"] as const;
const leaseKeys = ["id", "startedAt"] as const;
const disclosureKeys = ["goal", "expectedActions", "limits", "stopCondition"] as const;
const limitKeys = [
  "maxToolCalls",
  "maxBlockChanges",
  "maxHorizontalTravel",
  "maxDurationMs",
  "maxDangerousOperations",
] as const;
const budgetKeys = [
  "active",
  "stopReason",
  "limits",
  "toolCalls",
  "blockChanges",
  "horizontalTravel",
  "dangerousOperations",
  "startedAt",
] as const;

export class RuntimeFacade {
  readonly #dependencies: RuntimeFacadeDependencies;
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  readonly #eventQueue: RuntimeEvent[] = [];
  #publishing = false;
  #unsubscribeTask: (() => void) | undefined;
  #unsubscribeMinecraft: (() => void) | undefined;
  #taskEventsFenced = false;
  #snapshot: RuntimeSnapshot = {
    lifecycle: "idle",
    minecraft: { state: "disconnected", sessionId: null },
    codex: { state: "stopped", model: null },
    task: null,
    lastError: null,
  };
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #terminal = false;
  #privateTaskIdentity: string | undefined;
  #publicTaskId: string | undefined;

  constructor(dependencies: RuntimeFacadeDependencies) {
    this.#dependencies = dependencies;
    this.#refreshTask(false);
    try {
      this.#unsubscribeTask = dependencies.task?.subscribe?.(() => {
        if (this.#taskEventsFenced) return;
        this.#refreshTask(true);
      });
    } catch {
      this.#recordError("TASK_STATE_UNKNOWN", "Task state is unavailable", false);
    }
    try {
      this.#unsubscribeMinecraft = dependencies.minecraft?.subscribe((event) => {
        this.#observeMinecraft(event);
      });
    } catch {
      this.#recordError("MINECRAFT_STATE_UNKNOWN", "Minecraft state is unavailable", false);
    }
  }

  start(): Promise<void> {
    if (this.#terminal) {
      return Promise.reject(new Error("Runtime is terminal; create a new runtime instance"));
    }
    if (this.#startPromise) return this.#startPromise;
    if (this.#snapshot.lifecycle === "running") return Promise.resolve();
    const operation = Promise.resolve().then(() => this.#startInternal());
    this.#startPromise = operation;
    this.#setLifecycle("starting");
    if (this.#terminal) return operation;
    this.#setMinecraft("connecting");
    if (this.#terminal) return operation;
    this.#setCodex("starting", null);
    void operation.then(
      () => {
        if (this.#startPromise === operation) this.#startPromise = undefined;
      },
      () => {
        if (this.#startPromise === operation) this.#startPromise = undefined;
      },
    );
    return operation;
  }

  stop(reason: TaskStopReason): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    if (this.#snapshot.lifecycle === "stopped" || this.#snapshot.lifecycle === "failed") {
      return Promise.resolve();
    }
    this.#terminal = true;
    this.#taskEventsFenced = true;
    this.#clearTask(false);
    const operation = Promise.resolve().then(() => this.#stopInternal(reason));
    this.#stopPromise = operation;
    this.#setLifecycle("stopping");
    this.#setMinecraft("disconnected");
    this.#setCodex("stopped", null);
    return operation;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(): RuntimeSnapshot {
    if (
      !this.#taskEventsFenced &&
      this.#snapshot.lifecycle !== "stopped" &&
      this.#snapshot.lifecycle !== "failed"
    ) {
      this.#refreshTask(false);
    }
    return cloneRuntimeSnapshot(this.#snapshot);
  }

  async #startInternal(): Promise<void> {
    if (this.#terminal || this.#snapshot.lifecycle !== "starting") return;
    try {
      await this.#dependencies.lifecycle.start();
      if (this.#terminal || this.#snapshot.lifecycle !== "starting") return;
      const model = this.#readCodexModel();
      if (this.#terminal || this.#snapshot.lifecycle !== "starting") return;
      this.#setCodex("ready", model);
      if (this.#terminal || this.#snapshot.lifecycle !== "starting") return;
      this.#setLifecycle("running");
    } catch {
      if (this.#terminal) throw new Error("Runtime startup was stopped");
      this.#terminal = true;
      try {
        this.#dependencies.task?.stop("failed");
      } catch {
        // The public failure state below fails closed even when invalidation fails.
      }
      this.#taskEventsFenced = true;
      this.#clearTask(false);
      await this.#dependencies.lifecycle.stop().catch(() => undefined);
      this.#setMinecraft("disconnected");
      this.#setCodex("failed", null);
      this.#recordError("RUNTIME_START_FAILED", "Runtime failed to start");
      this.#setLifecycle("failed");
      this.#teardownObservers();
      throw new Error("Runtime failed to start");
    }
  }

  async #stopInternal(reason: TaskStopReason): Promise<void> {
    let failed = false;
    try {
      this.#dependencies.task?.stop(reason);
    } catch {
      failed = true;
    }

    const afterInvalidation = this.#inspectTask();
    if (afterInvalidation.kind !== "none") failed = true;
    this.#clearTask(true);

    try {
      await this.#dependencies.lifecycle.stop();
    } catch {
      failed = true;
    }

    const afterCleanup = this.#inspectTask();
    if (afterCleanup.kind !== "none") failed = true;
    this.#clearTask(false);

    if (failed) {
      this.#recordError("RUNTIME_STOP_FAILED", "Runtime failed to stop");
      this.#setLifecycle("failed");
      this.#teardownObservers();
      throw new Error("Runtime failed to stop");
    }

    this.#setLifecycle("stopped");
    this.#teardownObservers();
  }

  #setLifecycle(lifecycle: RuntimeSnapshot["lifecycle"]): void {
    this.#snapshot = { ...this.#snapshot, lifecycle };
    this.#publish({ kind: "lifecycle", state: lifecycle });
  }

  #setMinecraft(state: RuntimeSnapshot["minecraft"]["state"]): void {
    const minecraft = { state, sessionId: null } as const;
    this.#snapshot = { ...this.#snapshot, minecraft };
    this.#publish({ kind: "minecraft", state: minecraft });
  }

  #setCodex(state: RuntimeSnapshot["codex"]["state"], model: string | null): void {
    const codex = { state, model };
    this.#snapshot = { ...this.#snapshot, codex };
    this.#publish({ kind: "codex", state: codex });
  }

  #readCodexModel(): string | null {
    const model = this.#dependencies.codex?.model() ?? null;
    if (
      model !== null &&
      (typeof model !== "string" ||
        model.length === 0 ||
        model.length > 128 ||
        !/^[A-Za-z0-9._-]+$/.test(model))
    ) {
      throw new Error("Codex model state is unavailable");
    }
    return model;
  }

  #observeMinecraft(event: MinecraftEvent): void {
    try {
      if (typeof event !== "object" || event === null || typeof event.kind !== "string") {
        this.#failMinecraftState();
        return;
      }
      switch (event.kind) {
        case "connected":
          if (this.#snapshot.lifecycle === "starting" || this.#snapshot.lifecycle === "running") {
            this.#setMinecraft("connected");
          } else if (this.#snapshot.lifecycle === "idle") {
            this.#failMinecraftState();
          }
          return;
        case "disconnected":
          this.#setMinecraft(
            this.#snapshot.lifecycle === "starting" || this.#snapshot.lifecycle === "running"
              ? "reconnecting"
              : "disconnected",
          );
          return;
        case "chat":
        case "owner_online":
        case "owner_offline":
        case "death":
        case "hostile_nearby":
          return;
        default:
          this.#failMinecraftState();
      }
    } catch {
      this.#failMinecraftState();
    }
  }

  #failMinecraftState(): void {
    this.#setMinecraft("disconnected");
    this.#recordError("MINECRAFT_STATE_UNKNOWN", "Minecraft state is unavailable");
  }

  #inspectTask(): InspectedTaskState {
    const taskAccess = this.#dependencies.task;
    if (!taskAccess) return { kind: "none" };
    try {
      const active = taskAccess.current() as unknown;
      const budget = parseBudget(taskAccess.budget() as unknown);
      if (!budget) return { kind: "unknown" };
      if (active === null && budget.active === false) return { kind: "none" };
      if (active === null || budget.active !== true) return { kind: "unknown" };
      return parseActiveTask(active, budget);
    } catch {
      return { kind: "unknown" };
    }
  }

  #refreshTask(publish: boolean): void {
    try {
      const inspected = this.#inspectTask();
      if (inspected.kind === "none") {
        this.#clearTask(publish);
        return;
      }
      if (inspected.kind === "unknown") {
        this.#failTaskState(publish);
        return;
      }
      if (this.#privateTaskIdentity !== inspected.identity) {
        const publicId = (this.#dependencies.createPublicTaskId ?? randomUUID)();
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(publicId) || publicId === inspected.leaseId) {
          this.#failTaskState(publish);
          return;
        }
        this.#privateTaskIdentity = inspected.identity;
        this.#publicTaskId = publicId;
      }
      this.#setTask(
        {
          id: this.#publicTaskId!,
          disclosure: cloneDisclosure(inspected.disclosure),
          startedAt: inspected.startedAt,
          budget: cloneBudget(inspected.budget),
        },
        publish,
      );
    } catch {
      this.#failTaskState(publish);
    }
  }

  #failTaskState(publish: boolean): void {
    this.#clearTask(publish);
    this.#recordError("TASK_STATE_UNKNOWN", "Task state is unavailable", publish);
  }

  #clearTask(publish: boolean): void {
    this.#privateTaskIdentity = undefined;
    this.#publicTaskId = undefined;
    this.#setTask(null, publish);
  }

  #setTask(task: PublicTaskSnapshot | null, publish: boolean): void {
    const safeTask = task === null ? null : clonePublicTask(task);
    this.#snapshot = { ...this.#snapshot, task: safeTask };
    if (publish) {
      this.#publish({
        kind: "task",
        task: safeTask === null ? null : clonePublicTask(safeTask),
      });
    }
  }

  #recordError(code: string, message: string, publish = true): void {
    const error = {
      code: code.slice(0, 64),
      message: message.slice(0, 160),
    };
    this.#snapshot = {
      ...this.#snapshot,
      lastError: { code: error.code, message: error.message },
    };
    if (publish) {
      this.#publish({
        kind: "error",
        error: { code: error.code, message: error.message },
      });
    }
  }

  #teardownObservers(): void {
    try {
      this.#unsubscribeTask?.();
    } catch {
      // Observer teardown cannot affect lifecycle cleanup.
    }
    try {
      this.#unsubscribeMinecraft?.();
    } catch {
      // Observer teardown cannot affect lifecycle cleanup.
    }
    this.#unsubscribeTask = undefined;
    this.#unsubscribeMinecraft = undefined;
  }

  #publish(event: RuntimeEvent): void {
    this.#eventQueue.push(cloneRuntimeEvent(event));
    if (this.#publishing) return;
    this.#publishing = true;
    try {
      while (this.#eventQueue.length > 0) {
        const next = this.#eventQueue.shift()!;
        for (const listener of [...this.#listeners]) {
          try {
            listener(deepFreeze(cloneRuntimeEvent(next)));
          } catch {
            // Desktop listeners cannot affect runtime lifecycle.
          }
        }
      }
    } finally {
      this.#publishing = false;
    }
  }
}

function parseActiveTask(value: unknown, budget: TaskBudgetSnapshot): InspectedTaskState {
  if (!isExactRecord(value, taskKeys)) return { kind: "unknown" };
  const lease = value.lease;
  if (!isExactRecord(lease, leaseKeys)) return { kind: "unknown" };
  const disclosure = value.disclosure;
  if (!isExactRecord(disclosure, disclosureKeys)) return { kind: "unknown" };

  const id = value.id;
  const leaseId = lease.id;
  const leaseStartedAt = lease.startedAt;
  const startedAt = value.startedAt;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 512 ||
    typeof leaseId !== "string" ||
    leaseId.length === 0 ||
    leaseId.length > 512 ||
    id !== leaseId ||
    !finiteNonnegativeInteger(leaseStartedAt) ||
    typeof startedAt !== "string" ||
    startedAt.length === 0 ||
    startedAt.length > 64 ||
    Date.parse(startedAt) !== leaseStartedAt ||
    budget.startedAt !== leaseStartedAt
  ) {
    return { kind: "unknown" };
  }

  const goal = disclosure.goal;
  const stopCondition = disclosure.stopCondition;
  const expectedActions = parseExpectedActions(disclosure.expectedActions);
  const limits = parseLimits(disclosure.limits);
  if (
    typeof goal !== "string" ||
    goal.length === 0 ||
    goal.length > 4_000 ||
    typeof stopCondition !== "string" ||
    stopCondition.length === 0 ||
    stopCondition.length > 4_000 ||
    !expectedActions ||
    !limits ||
    !limitsEqual(limits, budget.limits)
  ) {
    return { kind: "unknown" };
  }

  return {
    kind: "active",
    identity: `${leaseId}\u0000${leaseStartedAt}`,
    leaseId,
    disclosure: {
      goal,
      expectedActions,
      limits,
      stopCondition,
    },
    startedAt,
    budget: cloneBudget(budget),
  };
}

function parseBudget(value: unknown): TaskBudgetSnapshot | null {
  if (!isExactRecord(value, budgetKeys)) return null;
  const active = value.active;
  const stopReason = value.stopReason;
  const limits = parseLimits(value.limits);
  const toolCalls = value.toolCalls;
  const blockChanges = value.blockChanges;
  const horizontalTravel = value.horizontalTravel;
  const dangerousOperations = value.dangerousOperations;
  const startedAt = value.startedAt;
  if (
    typeof active !== "boolean" ||
    (stopReason !== null &&
      (typeof stopReason !== "string" || !taskStopReasons.has(stopReason as TaskStopReason))) ||
    !limits ||
    !finiteNonnegativeInteger(toolCalls) ||
    !finiteNonnegativeInteger(blockChanges) ||
    !finiteNonnegative(horizontalTravel) ||
    !finiteNonnegativeInteger(dangerousOperations) ||
    toolCalls > limits.maxToolCalls ||
    blockChanges > limits.maxBlockChanges ||
    horizontalTravel > limits.maxHorizontalTravel ||
    dangerousOperations > limits.maxDangerousOperations
  ) {
    return null;
  }
  let safeStartedAt: number | null;
  if (active) {
    if (stopReason !== null || !finiteNonnegativeInteger(startedAt)) return null;
    safeStartedAt = startedAt;
  } else {
    if (startedAt !== null) return null;
    safeStartedAt = null;
  }
  return {
    active,
    stopReason: stopReason as TaskStopReason | null,
    limits,
    toolCalls,
    blockChanges,
    horizontalTravel,
    dangerousOperations,
    startedAt: safeStartedAt,
  };
}

function parseLimits(value: unknown): TaskLimits | null {
  if (!isExactRecord(value, limitKeys)) return null;
  const maxToolCalls = value.maxToolCalls;
  const maxBlockChanges = value.maxBlockChanges;
  const maxHorizontalTravel = value.maxHorizontalTravel;
  const maxDurationMs = value.maxDurationMs;
  const maxDangerousOperations = value.maxDangerousOperations;
  if (
    !finiteNonnegative(maxToolCalls) ||
    !finiteNonnegative(maxBlockChanges) ||
    !finiteNonnegative(maxHorizontalTravel) ||
    !finiteNonnegative(maxDurationMs) ||
    !finiteNonnegative(maxDangerousOperations)
  ) {
    return null;
  }
  return {
    maxToolCalls,
    maxBlockChanges,
    maxHorizontalTravel,
    maxDurationMs,
    maxDangerousOperations,
  };
}

function parseExpectedActions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 16 || !hasExactArrayKeys(value)) {
    return null;
  }
  if (value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 256)) {
    return null;
  }
  return value.map((item) => item as string);
}

function isExactRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
): value is Record<K[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function hasExactArrayKeys(value: unknown[]): boolean {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== value.length + 1 || !actual.includes("length")) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!actual.includes(String(index))) return false;
  }
  return true;
}

function limitsEqual(left: TaskLimits, right: TaskLimits): boolean {
  return limitKeys.every((key) => left[key] === right[key]);
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finiteNonnegativeInteger(value: unknown): value is number {
  return finiteNonnegative(value) && Number.isSafeInteger(value);
}

function cloneLimits(limits: TaskLimits): TaskLimits {
  return {
    maxToolCalls: limits.maxToolCalls,
    maxBlockChanges: limits.maxBlockChanges,
    maxHorizontalTravel: limits.maxHorizontalTravel,
    maxDurationMs: limits.maxDurationMs,
    maxDangerousOperations: limits.maxDangerousOperations,
  };
}

function cloneDisclosure(disclosure: TaskDisclosure): TaskDisclosure {
  return {
    goal: disclosure.goal,
    expectedActions: disclosure.expectedActions.map((action) => action),
    limits: cloneLimits(disclosure.limits),
    stopCondition: disclosure.stopCondition,
  };
}

function cloneBudget(budget: TaskBudgetSnapshot): TaskBudgetSnapshot {
  return {
    active: budget.active,
    stopReason: budget.stopReason,
    limits: cloneLimits(budget.limits),
    toolCalls: budget.toolCalls,
    blockChanges: budget.blockChanges,
    horizontalTravel: budget.horizontalTravel,
    dangerousOperations: budget.dangerousOperations,
    startedAt: budget.startedAt,
  };
}

function clonePublicTask(task: PublicTaskSnapshot): PublicTaskSnapshot {
  return {
    id: task.id,
    disclosure: cloneDisclosure(task.disclosure),
    startedAt: task.startedAt,
    budget: cloneBudget(task.budget),
  };
}

function cloneRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  switch (event.kind) {
    case "lifecycle":
      return { kind: "lifecycle", state: event.state };
    case "minecraft":
      return {
        kind: "minecraft",
        state: {
          state: event.state.state,
          sessionId: event.state.sessionId,
        },
      };
    case "codex":
      return {
        kind: "codex",
        state: {
          state: event.state.state,
          model: event.state.model,
        },
      };
    case "task":
      return {
        kind: "task",
        task: event.task === null ? null : clonePublicTask(event.task),
      };
    case "error":
      return {
        kind: "error",
        error: {
          code: event.error.code,
          message: event.error.message,
        },
      };
    default:
      return assertNever(event);
  }
}

function cloneRuntimeSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return deepFreeze({
    lifecycle: snapshot.lifecycle,
    minecraft: {
      state: snapshot.minecraft.state,
      sessionId: snapshot.minecraft.sessionId,
    },
    codex: {
      state: snapshot.codex.state,
      model: snapshot.codex.model,
    },
    task: snapshot.task === null ? null : clonePublicTask(snapshot.task),
    lastError:
      snapshot.lastError === null
        ? null
        : {
            code: snapshot.lastError.code,
            message: snapshot.lastError.message,
          },
  });
}

function assertNever(value: never): never {
  throw new Error(`Unexpected runtime event: ${String(value)}`);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
