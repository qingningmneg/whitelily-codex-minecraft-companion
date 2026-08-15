import type { GameAction } from "../domain/types.js";
import { redactPublicText } from "../memory/redaction.js";
import type { TaskLease } from "../safety/taskBudget.js";

export type QueueItemStatus =
  "waiting" | "running" | "suspended" | "waiting_permission" | "completed" | "failed" | "cancelled";

export interface QueueAdmission {
  readonly taskLease: TaskLease;
  readonly worldGeneration: number;
  readonly action: GameAction;
  readonly summary: string;
  readonly trustedObservationKey: string;
}

export interface QueueItemSnapshot {
  readonly id: string;
  readonly index: number;
  readonly kind: GameAction["kind"] | "wheat_farming_permission";
  readonly summary: string;
  readonly status: QueueItemStatus;
  readonly retryCount: number;
  readonly enqueuedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly reason?: string;
}

export interface PermissionQueueAdmission {
  readonly taskLease: TaskLease;
  readonly worldGeneration: number;
  readonly permission: "wheat_farming";
  readonly summary: string;
}

export interface ActionQueueSnapshot {
  readonly items: readonly QueueItemSnapshot[];
}

export interface ActionQueueEvent {
  readonly kind: "item_changed";
  readonly item: QueueItemSnapshot;
}

export interface QueueExecutionItem {
  readonly id: string;
  readonly taskLease: TaskLease;
  readonly worldGeneration: number;
  readonly action: GameAction;
}

interface QueueItem {
  readonly id: string;
  readonly taskLease: TaskLease;
  readonly worldGeneration: number;
  readonly kind: GameAction["kind"] | "wheat_farming_permission";
  readonly action?: GameAction;
  readonly summary: string;
  readonly trustedObservationKey?: string;
  readonly enqueuedAt: string;
  startedAt?: string;
  endedAt?: string;
  reason?: string;
  status: QueueItemStatus;
  retryCount: number;
}

export interface CompanionActionQueueOptions {
  readonly createId: () => string;
  readonly now: () => Date;
}

function truncateCharacters(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function sanitizeDiagnosticText(value: string, maximum: number): string {
  return truncateCharacters(redactPublicText(value), maximum);
}

function taskLeaseKey(taskLease: TaskLease): string {
  return `${taskLease.id}\u0000${taskLease.startedAt}`;
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeFailureReason(value: string): string {
  return sanitizeDiagnosticText(value, 240).trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

export class CompanionActionQueue {
  readonly #items: QueueItem[] = [];
  readonly #listeners = new Set<(event: ActionQueueEvent) => void>();

  constructor(private readonly options: CompanionActionQueueOptions) {}

  enqueue(input: QueueAdmission): QueueItemSnapshot {
    return this.enqueueBatch([input])[0]!;
  }

  assertBatchCanEnqueue(inputs: readonly QueueAdmission[]): void {
    const additions = new Map<string, number>();
    for (const input of inputs) {
      const key = taskLeaseKey(input.taskLease);
      additions.set(key, (additions.get(key) ?? 0) + 1);
      const failedByReason = new Map<string, number>();
      const actionKey = canonicalValue(input.action);
      for (const item of this.#items) {
        if (
          item.status !== "failed" ||
          item.reason === undefined ||
          item.action === undefined ||
          taskLeaseKey(item.taskLease) !== key ||
          item.trustedObservationKey !== input.trustedObservationKey ||
          canonicalValue(item.action) !== actionKey
        ) {
          continue;
        }
        const reason = normalizeFailureReason(item.reason);
        failedByReason.set(reason, (failedByReason.get(reason) ?? 0) + 1);
      }
      if ([...failedByReason.values()].some((count) => count >= 3)) {
        throw new Error("semantic action retry exhausted");
      }
    }
    for (const [key, count] of additions) {
      const active = this.#items.filter(
        (item) =>
          taskLeaseKey(item.taskLease) === key &&
          item.status !== "completed" &&
          item.status !== "failed" &&
          item.status !== "cancelled",
      ).length;
      if (active + count > 256) throw new Error("queue capacity exhausted");
    }
  }

  enqueueBatch(inputs: readonly QueueAdmission[]): readonly QueueItemSnapshot[] {
    this.assertBatchCanEnqueue(inputs);
    const knownIds = new Set(this.#items.map((item) => item.id));
    const enqueuedAt = this.options.now().toISOString();
    const items = inputs.map((input): QueueItem => {
      const id = this.#createUniqueId(knownIds);
      knownIds.add(id);
      return {
        id,
        taskLease: { ...input.taskLease },
        worldGeneration: input.worldGeneration,
        kind: input.action.kind,
        action: structuredClone(input.action),
        summary: sanitizeDiagnosticText(input.summary, 160),
        trustedObservationKey: input.trustedObservationKey,
        enqueuedAt,
        status: "waiting",
        retryCount: 0,
      };
    });
    const start = this.#items.length;
    this.#items.push(...items);
    const snapshots = items.map((item, index) => this.#snapshotItem(item, start + index + 1));
    for (const snapshot of snapshots) this.#publish(snapshot);
    return snapshots;
  }

  beginPermissionWait(input: PermissionQueueAdmission): QueueItemSnapshot {
    const activeForTask = this.#items.filter(
      (item) =>
        item.taskLease.id === input.taskLease.id &&
        item.taskLease.startedAt === input.taskLease.startedAt &&
        item.status !== "completed" &&
        item.status !== "failed" &&
        item.status !== "cancelled",
    ).length;
    if (activeForTask >= 256) throw new Error("queue capacity exhausted");
    const item: QueueItem = {
      id: this.#createId(),
      taskLease: { ...input.taskLease },
      worldGeneration: input.worldGeneration,
      kind: "wheat_farming_permission",
      summary: sanitizeDiagnosticText(input.summary, 160),
      enqueuedAt: this.options.now().toISOString(),
      status: "waiting_permission",
      retryCount: 0,
    };
    this.#items.push(item);
    const snapshot = this.#snapshotItem(item, this.#items.length);
    this.#publish(snapshot);
    return snapshot;
  }

  claimNext(taskLease: TaskLease, worldGeneration: number): QueueExecutionItem | undefined {
    for (const candidate of this.#items) {
      if (
        candidate.status === "waiting" &&
        candidate.action !== undefined &&
        candidate.worldGeneration !== worldGeneration &&
        candidate.taskLease.id === taskLease.id &&
        candidate.taskLease.startedAt === taskLease.startedAt
      ) {
        candidate.status = "cancelled";
        candidate.reason = "world generation changed";
        candidate.endedAt = this.options.now().toISOString();
        this.#publishItem(candidate);
      }
    }
    const item = this.#items.find(
      (candidate) =>
        candidate.status === "waiting" &&
        candidate.worldGeneration === worldGeneration &&
        candidate.taskLease.id === taskLease.id &&
        candidate.taskLease.startedAt === taskLease.startedAt,
    );
    if (!item?.action) return undefined;
    item.status = "running";
    item.startedAt = this.options.now().toISOString();
    this.#publishItem(item);
    return {
      id: item.id,
      taskLease: { ...item.taskLease },
      worldGeneration: item.worldGeneration,
      action: structuredClone(item.action),
    };
  }

  resolvePermission(
    id: string,
    taskLease: TaskLease,
    result: "completed" | "cancelled",
    reason: string,
  ): void {
    const item = this.#items.find((candidate) => candidate.id === id);
    if (!item) throw new Error("queue item not found");
    if (item.taskLease.id !== taskLease.id || item.taskLease.startedAt !== taskLease.startedAt) {
      throw new Error("queue item authority mismatch");
    }
    if (
      item.kind === "wheat_farming_permission" &&
      item.status === result &&
      (result === "completed" || result === "cancelled")
    ) {
      return;
    }
    if (item.status !== "waiting_permission" || item.kind !== "wheat_farming_permission") {
      throw new Error("invalid queue item transition");
    }
    item.status = result;
    item.reason = sanitizeDiagnosticText(reason, 240);
    item.endedAt = this.options.now().toISOString();
    this.#publishItem(item);
  }

  complete(id: string, taskLease: TaskLease, worldGeneration: number): void {
    const item = this.#items.find((candidate) => candidate.id === id);
    if (!item) throw new Error("queue item not found");
    if (
      item.taskLease.id !== taskLease.id ||
      item.taskLease.startedAt !== taskLease.startedAt ||
      item.worldGeneration !== worldGeneration
    ) {
      throw new Error("queue item authority mismatch");
    }
    if (item.status !== "running") throw new Error("invalid queue item transition");
    item.status = "completed";
    item.endedAt = this.options.now().toISOString();
    this.#publishItem(item);
  }

  fail(id: string, taskLease: TaskLease, worldGeneration: number, reason: string): void {
    const item = this.#items.find((candidate) => candidate.id === id);
    if (!item) throw new Error("queue item not found");
    if (
      item.taskLease.id !== taskLease.id ||
      item.taskLease.startedAt !== taskLease.startedAt ||
      item.worldGeneration !== worldGeneration
    ) {
      throw new Error("queue item authority mismatch");
    }
    if (item.status !== "running") throw new Error("invalid queue item transition");
    item.status = "failed";
    item.reason = sanitizeDiagnosticText(reason, 240);
    item.endedAt = this.options.now().toISOString();
    this.#publishItem(item);
  }

  recordTransportRetry(id: string, taskLease: TaskLease, worldGeneration: number): void {
    const item = this.#items.find((candidate) => candidate.id === id);
    if (!item) throw new Error("queue item not found");
    if (
      item.taskLease.id !== taskLease.id ||
      item.taskLease.startedAt !== taskLease.startedAt ||
      item.worldGeneration !== worldGeneration
    ) {
      throw new Error("queue item authority mismatch");
    }
    if (item.status !== "running") throw new Error("invalid queue item transition");
    if (item.retryCount >= 1) throw new Error("transport retry exhausted");
    item.retryCount += 1;
    this.#publishItem(item);
  }

  suspendTask(taskLease: TaskLease, reason: string): void {
    for (const item of this.#items) {
      if (
        item.taskLease.id === taskLease.id &&
        item.taskLease.startedAt === taskLease.startedAt &&
        (item.status === "waiting" || item.status === "running")
      ) {
        item.status = "suspended";
        item.reason = sanitizeDiagnosticText(reason, 240);
        this.#publishItem(item);
      }
    }
  }

  resumeTaskAfterReplan(taskLease: TaskLease, worldGeneration: number): void {
    for (const item of this.#items) {
      if (
        item.taskLease.id === taskLease.id &&
        item.taskLease.startedAt === taskLease.startedAt &&
        item.worldGeneration === worldGeneration &&
        item.status === "suspended"
      ) {
        if (item.startedAt !== undefined) {
          item.status = "cancelled";
          item.reason = "replan discarded interrupted action";
          item.endedAt = this.options.now().toISOString();
        } else {
          item.status = "waiting";
          delete item.reason;
        }
        this.#publishItem(item);
      }
    }
  }

  cancelWaiting(taskLease: TaskLease, reason: string): number {
    let cancelled = 0;
    for (const item of this.#items) {
      if (
        item.taskLease.id === taskLease.id &&
        item.taskLease.startedAt === taskLease.startedAt &&
        item.action !== undefined &&
        item.status === "waiting"
      ) {
        item.status = "cancelled";
        item.reason = sanitizeDiagnosticText(reason, 240);
        item.endedAt = this.options.now().toISOString();
        this.#publishItem(item);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  cancelKinds(
    taskLease: TaskLease,
    kinds: ReadonlySet<GameAction["kind"]>,
    reason: string,
  ): number {
    let cancelled = 0;
    for (const item of this.#items) {
      if (
        item.taskLease.id === taskLease.id &&
        item.taskLease.startedAt === taskLease.startedAt &&
        item.action !== undefined &&
        kinds.has(item.action.kind) &&
        (item.status === "waiting" || item.status === "suspended")
      ) {
        item.status = "cancelled";
        item.reason = sanitizeDiagnosticText(reason, 240);
        item.endedAt = this.options.now().toISOString();
        this.#publishItem(item);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  cancelTask(taskLease: TaskLease, reason: string): void {
    for (const item of this.#items) {
      if (
        item.taskLease.id === taskLease.id &&
        item.taskLease.startedAt === taskLease.startedAt &&
        item.status !== "completed" &&
        item.status !== "failed" &&
        item.status !== "cancelled"
      ) {
        item.status = "cancelled";
        item.reason = sanitizeDiagnosticText(reason, 240);
        item.endedAt = this.options.now().toISOString();
        this.#publishItem(item);
      }
    }
  }

  hasActiveTask(taskLease: TaskLease): boolean {
    return this.#items.some(
      (item) =>
        item.taskLease.id === taskLease.id &&
        item.taskLease.startedAt === taskLease.startedAt &&
        item.status !== "completed" &&
        item.status !== "failed" &&
        item.status !== "cancelled",
    );
  }

  snapshot(): ActionQueueSnapshot {
    const start = Math.max(0, this.#items.length - 256);
    return {
      items: this.#items
        .slice(start)
        .map((item, index) => this.#snapshotItem(item, start + index + 1)),
    };
  }

  subscribe(listener: (event: ActionQueueEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #createId(): string {
    return this.#createUniqueId(new Set(this.#items.map((item) => item.id)));
  }

  #createUniqueId(knownIds: ReadonlySet<string>): string {
    const id = this.options.createId();
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) throw new Error("invalid queue item id");
    if (knownIds.has(id)) throw new Error("queue item id collision");
    return id;
  }

  #publishItem(item: QueueItem): void {
    this.#publish(this.#snapshotItem(item, this.#items.indexOf(item) + 1));
  }

  #publish(item: QueueItemSnapshot): void {
    const event: ActionQueueEvent = { kind: "item_changed", item };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Diagnostic observers cannot affect queue state.
      }
    }
  }

  #snapshotItem(item: QueueItem, index: number): QueueItemSnapshot {
    return {
      id: item.id,
      index,
      kind: item.kind,
      summary: item.summary,
      status: item.status,
      retryCount: item.retryCount,
      enqueuedAt: item.enqueuedAt,
      ...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
      ...(item.endedAt === undefined ? {} : { endedAt: item.endedAt }),
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    };
  }
}
