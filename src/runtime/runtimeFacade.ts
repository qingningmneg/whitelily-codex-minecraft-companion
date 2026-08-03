import { randomUUID } from "node:crypto";
import type { ResolvedModelSelection } from "../codex/modelCatalog.js";
import { isModelId } from "../codex/modelId.js";
import type { ActiveTask, TaskDisclosure } from "../companion/taskController.js";
import { redactPublicText } from "../memory/redaction.js";
import type { MinecraftEvent } from "../minecraft/minecraftPort.js";
import type { TaskBudgetSnapshot, TaskLimits, TaskStopReason } from "../safety/taskBudget.js";
import type { CompanionProfile } from "../profile/profileSchema.js";
import type { MemoryContextScope } from "../memory/scopedMemoryStore.js";
import type {
  PublicTaskSnapshot,
  RuntimeEvent,
  RuntimeEventPayload,
  RuntimeAuthorityLoss,
  RuntimeSnapshot,
} from "./runtimeEvents.js";

interface RuntimeLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeTaskProjection {
  current(): ActiveTask | null;
  budget(): TaskBudgetSnapshot;
  status(): "running" | "waiting_confirmation";
  stop(reason: TaskStopReason): void;
  subscribe(listener: () => void): () => void;
}

interface RuntimeTaskAccess extends Omit<RuntimeTaskProjection, "status" | "subscribe"> {
  status?(): "running" | "waiting_confirmation";
  failClosed?(): void;
  subscribe?(listener: () => void): () => void;
}

export interface RuntimeFacadeDependencies {
  lifecycle: RuntimeLifecycle;
  switchModel?: (
    selection: ResolvedModelSelection,
    commitPreference: () => Promise<void>,
  ) => Promise<void>;
  task?: RuntimeTaskAccess;
  minecraft?: {
    subscribe(listener: (event: MinecraftEvent) => void): () => void;
  };
  codex?: {
    model(): string | null;
  };
  authority?: {
    subscribe(listener: (event: RuntimeAuthorityLoss) => void): () => void;
  };
  profile?: {
    apply(profile: CompanionProfile): void;
  };
  memory?: {
    setScope(scope: MemoryContextScope): void;
  };
  createPublicTaskId?: () => string;
  initialRevision?: number;
}

type InspectedTaskState =
  | { kind: "none" }
  | { kind: "unknown" }
  | {
      kind: "active";
      identity: string;
      leaseId: string;
      goal: string;
      allowedActions: readonly string[];
      effectiveLimits: TaskLimits;
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
  "owner_changed",
  "model_unavailable",
  "model_changed",
  "process_exit",
]);

const taskKeys = ["id", "lease", "disclosure", "startedAt"] as const;
const leaseKeys = ["id", "startedAt"] as const;
const disclosureKeys = ["goal", "expectedActions", "limits", "stopCondition"] as const;
const publicTaskIdPattern = /^task_[a-z0-9_-]+$/u;
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
  readonly #authorityLossListeners = new Set<(event: RuntimeAuthorityLoss) => void>();
  readonly #eventQueue: RuntimeEvent[] = [];
  #publishing = false;
  #unsubscribeTask: (() => void) | undefined;
  #unsubscribeMinecraft: (() => void) | undefined;
  #unsubscribeAuthority: (() => void) | undefined;
  #taskEventsFenced = false;
  #snapshot: RuntimeSnapshot = {
    revision: 0,
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
    const initialRevision = dependencies.initialRevision ?? 0;
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) {
      throw new Error("Runtime revision is invalid");
    }
    this.#dependencies = dependencies;
    this.#snapshot = { ...this.#snapshot, revision: initialRevision };
    this.#refreshTask(false);
    if (this.#terminal) return;
    try {
      this.#unsubscribeTask = dependencies.task?.subscribe?.(() => {
        if (this.#taskEventsFenced) return;
        this.#refreshTask(true);
      });
    } catch {
      this.#failTaskState(false);
    }
    if (this.#terminal) return;
    try {
      this.#unsubscribeMinecraft = dependencies.minecraft?.subscribe((event) => {
        if (this.#terminal) return;
        this.#observeMinecraft(event);
      });
    } catch {
      this.#failMinecraftState(false);
    }
    if (this.#terminal) return;
    try {
      this.#unsubscribeAuthority = dependencies.authority?.subscribe((event) => {
        if (this.#terminal) return;
        for (const listener of [...this.#authorityLossListeners]) {
          try {
            listener(event);
          } catch {
            // Authority-loss observers cannot delay runtime containment.
          }
        }
      });
    } catch {
      this.#failOperationalState(
        "RUNTIME_AUTHORITY_STATE_UNKNOWN",
        "Runtime authority state is unavailable",
        false,
      );
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
    try {
      this.#setLifecycle("starting");
      if (this.#terminal) return operation;
      this.#setMinecraft("connecting");
      if (this.#terminal) return operation;
      this.#setCodex("starting", null);
    } catch (error) {
      this.#startPromise = undefined;
      return Promise.reject(error);
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
    this.#taskEventsFenced = true;
    this.#clearTask(false);
    type StopStart = { readonly run: true } | { readonly run: false; readonly error: unknown };
    let beginOperation!: (start: StopStart) => void;
    const operation = new Promise<StopStart>((resolve) => {
      beginOperation = resolve;
    }).then(async (start) => {
      try {
        if (!start.run) throw start.error;
        await this.#stopInternal(reason);
      } catch (error) {
        if (this.#snapshot.lastError?.code === "RUNTIME_REVISION_EXHAUSTED") {
          await this.#cleanupAfterRevisionOverflow();
        }
        throw error;
      }
    });
    this.#stopPromise = operation;
    try {
      this.#setLifecycle("stopping");
      this.#setMinecraft("disconnected");
      this.#setCodex("stopped", null);
    } catch (error) {
      beginOperation({ run: false, error });
      return operation;
    }
    beginOperation({ run: true });
    return operation;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  subscribeAuthorityLoss(listener: (event: RuntimeAuthorityLoss) => void): () => void {
    this.#authorityLossListeners.add(listener);
    return () => this.#authorityLossListeners.delete(listener);
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

  stopTask(): Promise<void> {
    return Promise.resolve().then(() => {
      const before = this.#inspectTask();
      if (before.kind === "unknown") {
        this.#failTaskState(true);
        throw new Error("Task state is unavailable");
      }
      if (before.kind === "none") {
        if (this.#snapshot.task !== null) this.#clearTask(true);
        return;
      }
      try {
        this.#dependencies.task?.stop("owner_stop");
      } catch {
        this.#recordError("TASK_STOP_FAILED", "Task failed to stop");
        throw new Error("Task failed to stop");
      }
      const after = this.#inspectTask();
      if (after.kind !== "none") {
        this.#recordError("TASK_STOP_FAILED", "Task failed to stop");
        throw new Error("Task failed to stop");
      }
      if (this.#snapshot.task !== null) this.#clearTask(true);
    });
  }

  switchModel(
    selection: ResolvedModelSelection,
    commitPreference: () => Promise<void>,
  ): Promise<void> {
    return Promise.resolve().then(async () => {
      if (this.#terminal || this.#snapshot.lifecycle !== "running") {
        throw new Error("Runtime is not running");
      }
      const switchModel = this.#dependencies.switchModel;
      if (!switchModel) throw new Error("Runtime model switching is unavailable");
      await switchModel(selection, commitPreference);
      if (this.#terminal || this.#snapshot.lifecycle !== "running") {
        throw new Error("Runtime model switch was interrupted");
      }
      this.#setCodex("ready", selection.modelId);
    });
  }

  applyProfile(profile: CompanionProfile): void {
    if (this.#terminal) throw new Error("Runtime is terminal; create a new runtime instance");
    this.#dependencies.profile?.apply(profile);
  }

  setMemoryScope(scope: MemoryContextScope): void {
    if (this.#terminal) throw new Error("Runtime is terminal; create a new runtime instance");
    this.#dependencies.memory?.setScope(scope);
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
    if (model !== null && !isModelId(model)) {
      throw new Error("Codex model state is unavailable");
    }
    return model;
  }

  #observeMinecraft(event: MinecraftEvent): void {
    if (this.#terminal) return;
    try {
      const kind = validateMinecraftEvent(event as unknown);
      if (kind === null) {
        this.#failMinecraftState();
        return;
      }
      switch (kind) {
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
        case "world_changed":
          try {
            this.#dependencies.task?.stop("world_changed");
          } catch {
            this.#failTaskState(true);
            return;
          }
          this.#setMinecraft("disconnected");
          return;
        default:
          this.#failMinecraftState();
      }
    } catch {
      this.#failMinecraftState();
    }
  }

  #failMinecraftState(publish = true): void {
    this.#failOperationalState(
      "MINECRAFT_STATE_UNKNOWN",
      "Minecraft state is unavailable",
      publish,
    );
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
        const publicId = (
          this.#dependencies.createPublicTaskId ??
          (() => `task_${randomUUID().replaceAll("-", "_")}`)
        )();
        if (
          publicId.length > 128 ||
          !publicTaskIdPattern.test(publicId) ||
          publicId.includes(inspected.leaseId)
        ) {
          this.#failTaskState(publish);
          return;
        }
        this.#privateTaskIdentity = inspected.identity;
        this.#publicTaskId = publicId;
      }
      this.#setTask(
        {
          id: this.#publicTaskId!,
          goal: inspected.goal,
          status: this.#readTaskStatus(),
          allowedActions: cloneActions(inspected.allowedActions),
          effectiveLimits: cloneLimits(inspected.effectiveLimits),
          startedAt: inspected.startedAt,
          budget: cloneBudget(inspected.budget),
        },
        publish,
      );
    } catch {
      this.#failTaskState(publish);
    }
  }

  #readTaskStatus(): PublicTaskSnapshot["status"] {
    const task = this.#dependencies.task;
    if (!task) throw new Error("Task state is unavailable");
    const descriptor = Object.getOwnPropertyDescriptor(task, "status");
    if (descriptor === undefined) return "running";
    if (!("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new Error("Task state is unavailable");
    }
    const status = descriptor.value.call(task) as unknown;
    if (status !== "running" && status !== "waiting_confirmation") {
      throw new Error("Task state is unavailable");
    }
    return status;
  }

  #failTaskState(publish: boolean): void {
    this.#failOperationalState("TASK_STATE_UNKNOWN", "Task state is unavailable", publish);
  }

  #failOperationalState(code: string, message: string, publish: boolean): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#taskEventsFenced = true;
    const error = {
      code: code.slice(0, 64),
      message: message.slice(0, 160),
    };
    try {
      const task = this.#dependencies.task;
      if (task?.failClosed) task.failClosed();
      else task?.stop("failed");
    } catch {
      // The terminal facade and lifecycle cleanup remain authoritative.
    }
    this.#privateTaskIdentity = undefined;
    this.#publicTaskId = undefined;
    this.#snapshot = {
      revision: this.#snapshot.revision,
      lifecycle: "failed",
      minecraft: { state: "disconnected", sessionId: null },
      codex: { state: "stopped", model: null },
      task: null,
      lastError: error,
    };
    const cleanup = Promise.resolve()
      .then(() => this.#dependencies.lifecycle.stop())
      .catch(() => undefined)
      .then(() => {
        this.#teardownObservers();
      });
    this.#stopPromise = cleanup;
    if (!publish) return;
    this.#publish({ kind: "task", task: null });
    this.#publish({
      kind: "minecraft",
      state: { state: "disconnected", sessionId: null },
    });
    this.#publish({
      kind: "codex",
      state: { state: "stopped", model: null },
    });
    this.#publish({
      kind: "error",
      error: { code: error.code, message: error.message },
    });
    this.#publish({ kind: "lifecycle", state: "failed" });
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
    try {
      this.#unsubscribeAuthority?.();
    } catch {
      // Authority observer teardown cannot affect lifecycle cleanup.
    }
    this.#unsubscribeTask = undefined;
    this.#unsubscribeMinecraft = undefined;
    this.#unsubscribeAuthority = undefined;
    this.#authorityLossListeners.clear();
  }

  #publish(event: RuntimeEventPayload): void {
    if (this.#snapshot.revision >= Number.MAX_SAFE_INTEGER) {
      this.#failRevisionOverflow();
      throw new Error("Runtime revision is exhausted");
    }
    const revision = this.#snapshot.revision + 1;
    this.#snapshot = { ...this.#snapshot, revision };
    this.#eventQueue.push(cloneRuntimeEvent({ ...event, revision } as RuntimeEvent));
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

  #failRevisionOverflow(): void {
    if (this.#terminal && this.#snapshot.lastError?.code === "RUNTIME_REVISION_EXHAUSTED") return;
    this.#terminal = true;
    this.#taskEventsFenced = true;
    this.#privateTaskIdentity = undefined;
    this.#publicTaskId = undefined;
    this.#snapshot = {
      revision: this.#snapshot.revision,
      lifecycle: "failed",
      minecraft: { state: "disconnected", sessionId: null },
      codex: { state: "stopped", model: null },
      task: null,
      lastError: {
        code: "RUNTIME_REVISION_EXHAUSTED",
        message: "Runtime revision is exhausted",
      },
    };
    try {
      const task = this.#dependencies.task;
      if (task?.failClosed) task.failClosed();
      else task?.stop("failed");
    } catch {
      // The terminal revision state remains authoritative.
    }
    if (!this.#stopPromise) {
      this.#stopPromise = this.#cleanupAfterRevisionOverflow();
    }
  }

  async #cleanupAfterRevisionOverflow(): Promise<void> {
    await Promise.resolve()
      .then(() => this.#dependencies.lifecycle.stop())
      .catch(() => undefined);
    this.#teardownObservers();
  }
}

function validateMinecraftEvent(value: unknown): MinecraftEvent["kind"] | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (
    kindDescriptor?.enumerable !== true ||
    !("value" in kindDescriptor) ||
    typeof kindDescriptor.value !== "string"
  ) {
    return null;
  }
  const kind = kindDescriptor.value;
  switch (kind) {
    case "connected":
    case "disconnected": {
      const hasReason = Object.prototype.hasOwnProperty.call(value, "reason");
      if (!isExactRecord(value, hasReason ? ["kind", "reason"] : ["kind"])) return null;
      return !hasReason || isBoundedMinecraftString(value.reason, 256, true) ? kind : null;
    }
    case "world_changed":
    case "death":
      return isExactRecord(value, ["kind"]) ? kind : null;
    case "chat":
      return isExactRecord(value, ["kind", "username", "message"]) &&
        isBoundedMinecraftString(value.username, 64) &&
        isBoundedMinecraftString(value.message, 4_096, true)
        ? kind
        : null;
    case "owner_online":
    case "owner_offline":
      return isExactRecord(value, ["kind", "username"]) &&
        isBoundedMinecraftString(value.username, 64)
        ? kind
        : null;
    case "hostile_nearby":
      return isExactRecord(value, ["kind", "entityId", "entityKind", "position"]) &&
        typeof value.entityId === "number" &&
        Number.isSafeInteger(value.entityId) &&
        isBoundedMinecraftString(value.entityKind, 128) &&
        isExactFiniteVec3(value.position)
        ? kind
        : null;
    default:
      return null;
  }
}

function isBoundedMinecraftString(
  value: unknown,
  maxCodePoints: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value === value.toWellFormed() &&
    (allowEmpty || value.length > 0) &&
    Array.from(value).length <= maxCodePoints
  );
}

function isExactFiniteVec3(value: unknown): boolean {
  return (
    isExactRecord(value, ["x", "y", "z"]) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.z === "number" &&
    Number.isFinite(value.z)
  );
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
    goal.trim().length === 0 ||
    typeof stopCondition !== "string" ||
    stopCondition.trim().length === 0 ||
    !expectedActions ||
    !limits ||
    !limitsEqual(limits, budget.limits)
  ) {
    return { kind: "unknown" };
  }
  const publicDisclosure = serializePublicDisclosure(
    {
      goal,
      expectedActions,
      limits,
      stopCondition,
    },
    [id, leaseId],
  );
  if (!publicDisclosure) return { kind: "unknown" };

  return {
    kind: "active",
    identity: `${leaseId}\u0000${leaseStartedAt}`,
    leaseId,
    goal: publicDisclosure.goal,
    allowedActions: publicDisclosure.expectedActions,
    effectiveLimits: publicDisclosure.limits,
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
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 16 ||
    !hasExactArrayKeys(value)
  ) {
    return null;
  }
  const actions: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const item = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof item !== "string" || item.trim().length === 0) return null;
    actions.push(item);
  }
  return actions;
}

function serializePublicDisclosure(
  disclosure: TaskDisclosure,
  privateValues: readonly string[],
): TaskDisclosure | null {
  try {
    const goal = serializePublicString(disclosure.goal, 4_000, privateValues);
    const stopCondition = serializePublicString(disclosure.stopCondition, 4_000, privateValues);
    const expectedActions: string[] = [];
    for (let index = 0; index < disclosure.expectedActions.length; index += 1) {
      const action = serializePublicString(disclosure.expectedActions[index]!, 256, privateValues);
      if (action === null) return null;
      expectedActions.push(action);
    }
    if (!goal || !stopCondition) return null;
    return {
      goal,
      expectedActions,
      limits: cloneLimits(disclosure.limits),
      stopCondition,
    };
  } catch {
    return null;
  }
}

function serializePublicString(
  value: string,
  maxCodePoints: number,
  privateValues: readonly string[],
): string | null {
  if (value.length > maxCodePoints * 8) return null;
  let sanitized = value.toWellFormed();
  for (const privateValue of privateValues) {
    if (privateValue.length > 0) {
      sanitized = sanitized.replaceAll(privateValue, "[REDACTED_LEASE]");
    }
  }
  sanitized = redactPublicText(sanitized);
  const truncated = Array.from(sanitized).slice(0, maxCodePoints).join("");
  const markerStart = truncated.lastIndexOf("[");
  const completeMarker =
    markerStart < 0
      ? undefined
      : sanitized.slice(markerStart).match(/^\[REDACTED(?:_[A-Z]+)?\]/u)?.[0];
  const bounded =
    completeMarker !== undefined && !truncated.slice(markerStart).startsWith(completeMarker)
      ? truncated.slice(0, markerStart)
      : truncated;
  return bounded.trim().length === 0 ? null : bounded;
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
  return (
    actual.length === keys.length &&
    keys.every((key) => {
      if (!actual.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    })
  );
}

function hasExactArrayKeys(value: unknown[]): boolean {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== value.length + 1 || !actual.includes("length")) return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor ||
    lengthDescriptor.enumerable ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.value !== value.length
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (!actual.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || !("value" in descriptor)) return false;
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

function cloneActions(actions: readonly string[]): string[] {
  const cloned: string[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    cloned.push(actions[index]!);
  }
  return cloned;
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
    goal: task.goal,
    status: task.status,
    allowedActions: cloneActions(task.allowedActions),
    effectiveLimits: cloneLimits(task.effectiveLimits),
    startedAt: task.startedAt,
    budget: cloneBudget(task.budget),
  };
}

function cloneRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  switch (event.kind) {
    case "lifecycle":
      return { kind: "lifecycle", revision: event.revision, state: event.state };
    case "minecraft":
      return {
        kind: "minecraft",
        revision: event.revision,
        state: {
          state: event.state.state,
          sessionId: event.state.sessionId,
        },
      };
    case "codex":
      return {
        kind: "codex",
        revision: event.revision,
        state: {
          state: event.state.state,
          model: event.state.model,
        },
      };
    case "task":
      return {
        kind: "task",
        revision: event.revision,
        task: event.task === null ? null : clonePublicTask(event.task),
      };
    case "error":
      return {
        kind: "error",
        revision: event.revision,
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
    revision: snapshot.revision,
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
