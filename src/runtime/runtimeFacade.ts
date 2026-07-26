import { randomUUID } from "node:crypto";
import type { ActiveTask } from "../companion/taskController.js";
import type { MinecraftEvent } from "../minecraft/minecraftPort.js";
import type { TaskBudgetSnapshot, TaskStopReason } from "../safety/taskBudget.js";
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

export class RuntimeFacade {
  readonly #dependencies: RuntimeFacadeDependencies;
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  #unsubscribeTask: (() => void) | undefined;
  #unsubscribeMinecraft: (() => void) | undefined;
  #taskPushSubscribed = false;
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
        this.#refreshTask(true);
      });
      this.#taskPushSubscribed = this.#unsubscribeTask !== undefined;
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
    if (!this.#terminal) {
      this.#setMinecraft("connecting");
      this.#setCodex("starting", null);
    }
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
    if (this.#snapshot.lifecycle !== "stopped" && this.#snapshot.lifecycle !== "failed") {
      this.#refreshTask(false);
    }
    return cloneFrozen(this.#snapshot);
  }

  async #startInternal(): Promise<void> {
    if (this.#terminal || this.#snapshot.lifecycle !== "starting") return;
    try {
      await this.#dependencies.lifecycle.start();
      if (this.#terminal || this.#snapshot.lifecycle !== "starting") return;
      const model = this.#readCodexModel();
      this.#setCodex("ready", model);
      this.#setLifecycle("running");
    } catch {
      if (this.#terminal) {
        throw new Error("Runtime startup was stopped");
      }
      this.#terminal = true;
      try {
        this.#dependencies.task?.stop("failed");
        if (!this.#taskPushSubscribed) this.#refreshTask(false);
      } catch {
        this.#clearTask(false);
      }
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
      this.#refreshTask(!this.#taskPushSubscribed);
      if (this.#snapshot.task !== null) {
        failed = true;
        this.#clearTask(true);
        this.#recordError("RUNTIME_STOP_FAILED", "Runtime failed to stop");
      }
    } catch {
      failed = true;
      this.#clearTask(true);
      this.#recordError("RUNTIME_STOP_FAILED", "Runtime failed to stop");
    }
    try {
      await this.#dependencies.lifecycle.stop();
    } catch {
      failed = true;
      this.#recordError("RUNTIME_STOP_FAILED", "Runtime failed to stop");
    }
    this.#setLifecycle("stopped");
    this.#teardownObservers();
    if (failed) throw new Error("Runtime failed to stop");
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

  #refreshTask(publish: boolean): void {
    const taskAccess = this.#dependencies.task;
    if (!taskAccess) return;
    try {
      const active = taskAccess.current();
      const budget = taskAccess.budget();
      if (active === null && budget.active === false) {
        if (!validInactiveBudget(budget)) {
          this.#failTaskState(publish);
          return;
        }
        this.#privateTaskIdentity = undefined;
        this.#publicTaskId = undefined;
        this.#setTask(null, publish);
        return;
      }
      if (active === null || budget.active !== true || !validActiveTask(active, budget)) {
        this.#failTaskState(publish);
        return;
      }
      const identity = `${active.lease.id}\u0000${active.lease.startedAt}`;
      if (this.#privateTaskIdentity !== identity) {
        const publicId = (this.#dependencies.createPublicTaskId ?? randomUUID)();
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(publicId) || publicId === active.lease.id) {
          this.#failTaskState(publish);
          return;
        }
        this.#privateTaskIdentity = identity;
        this.#publicTaskId = publicId;
      }
      const task: PublicTaskSnapshot = {
        id: this.#publicTaskId!,
        disclosure: {
          goal: active.disclosure.goal,
          expectedActions: [...active.disclosure.expectedActions],
          limits: { ...active.disclosure.limits },
          stopCondition: active.disclosure.stopCondition,
        },
        startedAt: active.startedAt,
        budget: structuredClone(budget),
      };
      this.#setTask(task, publish);
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
    this.#snapshot = {
      ...this.#snapshot,
      task: task === null ? null : structuredClone(task),
    };
    if (publish) this.#publish({ kind: "task", task });
  }

  #recordError(code: string, message: string, publish = true): void {
    const error = { code: code.slice(0, 64), message: message.slice(0, 160) };
    this.#snapshot = { ...this.#snapshot, lastError: error };
    if (publish) this.#publish({ kind: "error", error });
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
    for (const listener of this.#listeners) {
      try {
        listener(cloneFrozen(event));
      } catch {
        // Desktop listeners cannot affect runtime lifecycle.
      }
    }
  }
}

function validActiveTask(active: ActiveTask, budget: TaskBudgetSnapshot): boolean {
  const startedAt = Date.parse(active.startedAt);
  return (
    typeof active.id === "string" &&
    active.id.length > 0 &&
    active.id.length <= 512 &&
    typeof active.lease?.id === "string" &&
    active.lease.id.length > 0 &&
    active.lease.id.length <= 512 &&
    active.id === active.lease.id &&
    Number.isFinite(active.lease.startedAt) &&
    startedAt === active.lease.startedAt &&
    budget.startedAt === active.lease.startedAt &&
    validDisclosure(active.disclosure) &&
    validBudget(budget)
  );
}

function validDisclosure(disclosure: ActiveTask["disclosure"]): boolean {
  return (
    typeof disclosure === "object" &&
    disclosure !== null &&
    typeof disclosure.goal === "string" &&
    disclosure.goal.length > 0 &&
    disclosure.goal.length <= 4_000 &&
    Array.isArray(disclosure.expectedActions) &&
    disclosure.expectedActions.length <= 16 &&
    disclosure.expectedActions.every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 256,
    ) &&
    validLimits(disclosure.limits) &&
    typeof disclosure.stopCondition === "string" &&
    disclosure.stopCondition.length > 0 &&
    disclosure.stopCondition.length <= 4_000
  );
}

function validBudget(budget: TaskBudgetSnapshot): boolean {
  return (
    typeof budget === "object" &&
    budget !== null &&
    budget.active === true &&
    budget.stopReason === null &&
    validBudgetNumbers(budget) &&
    validLimits(budget.limits)
  );
}

function validInactiveBudget(budget: TaskBudgetSnapshot): boolean {
  return (
    typeof budget === "object" &&
    budget !== null &&
    budget.active === false &&
    budget.startedAt === null &&
    (budget.stopReason === null || taskStopReasons.has(budget.stopReason)) &&
    validBudgetNumbers(budget) &&
    validLimits(budget.limits)
  );
}

function validBudgetNumbers(budget: TaskBudgetSnapshot): boolean {
  return (
    finiteNonnegative(budget.toolCalls) &&
    finiteNonnegative(budget.blockChanges) &&
    finiteNonnegative(budget.horizontalTravel) &&
    finiteNonnegative(budget.dangerousOperations)
  );
}

function validLimits(limits: TaskBudgetSnapshot["limits"]): boolean {
  return (
    typeof limits === "object" &&
    limits !== null &&
    finiteNonnegative(limits.maxToolCalls) &&
    finiteNonnegative(limits.maxBlockChanges) &&
    finiteNonnegative(limits.maxHorizontalTravel) &&
    finiteNonnegative(limits.maxDurationMs) &&
    finiteNonnegative(limits.maxDangerousOperations)
  );
}

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

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cloneFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
