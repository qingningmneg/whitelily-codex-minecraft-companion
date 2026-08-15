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

export class CompanionActionQueue {
  readonly #items: QueueItem[] = [];
  readonly #listeners = new Set<(event: ActionQueueEvent) => void>();

  constructor(private readonly options: CompanionActionQueueOptions) {}

  enqueue(input: QueueAdmission): QueueItemSnapshot {
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
      kind: input.action.kind,
      action: structuredClone(input.action),
      summary: sanitizeDiagnosticText(input.summary, 160),
      trustedObservationKey: input.trustedObservationKey,
      enqueuedAt: this.options.now().toISOString(),
      status: "waiting",
      retryCount: 0,
    };
    this.#items.push(item);
    const snapshot = this.#snapshotItem(item, this.#items.length);
    this.#publish(snapshot);
    return snapshot;
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

  cancelWaiting(taskLease: TaskLease, reason: string): void {
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
      }
    }
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
    const id = this.options.createId();
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) throw new Error("invalid queue item id");
    if (this.#items.some((item) => item.id === id)) throw new Error("queue item id collision");
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
