import type { ConfirmableOperation, GameAction } from "../domain/types.js";
import type { TaskLease } from "./taskBudget.js";

interface PendingConfirmation {
  id: number;
  reason: string;
  operation: ConfirmableOperation;
  expiresAt: Date;
}

interface StoredConfirmation extends PendingConfirmation {
  taskLease?: TaskLease;
  reservedHorizontalTravel?: number;
}

export interface GameConfirmationExpiry {
  taskLease: TaskLease;
  expiresAt: Date;
}

function cloneOperation(operation: ConfirmableOperation): ConfirmableOperation {
  return structuredClone(operation);
}

function cloneConfirmation(confirmation: StoredConfirmation): PendingConfirmation {
  return {
    id: confirmation.id,
    reason: confirmation.reason,
    operation: cloneOperation(confirmation.operation),
    expiresAt: new Date(confirmation.expiresAt),
  };
}

export class ConfirmationStore {
  private nextId = 1;
  private readonly pending = new Map<number, StoredConfirmation>();
  private readonly gameActionChangedListeners = new Set<() => void>();
  private readonly gameActionExpiredListeners = new Set<(taskLease: TaskLease) => void>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(reason: string, operation: ConfirmableOperation): PendingConfirmation {
    if (operation.kind === "game_action") {
      throw new Error("game confirmations require a task capability");
    }
    return this.createStored(reason, operation);
  }

  createGameAction(
    reason: string,
    action: GameAction,
    taskLease: TaskLease,
    reservedHorizontalTravel = 0,
  ): PendingConfirmation {
    if (
      typeof taskLease.id !== "string" ||
      taskLease.id.trim().length === 0 ||
      !Number.isFinite(taskLease.startedAt)
    ) {
      throw new Error("game confirmations require a task capability");
    }
    if (!Number.isFinite(reservedHorizontalTravel) || reservedHorizontalTravel < 0) {
      throw new Error("reserved horizontal travel is invalid");
    }
    const created = this.createStored(
      reason,
      { kind: "game_action", action },
      { ...taskLease },
      reservedHorizontalTravel,
    );
    this.notifyGameActionsChanged();
    return created;
  }

  private createStored(
    reason: string,
    operation: ConfirmableOperation,
    taskLease?: TaskLease,
    reservedHorizontalTravel?: number,
  ): PendingConfirmation {
    const now = this.now();
    this.removeExpiredLocalConfirmations(now);
    if (!Number.isSafeInteger(this.nextId) || this.nextId >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Confirmation ID space exhausted");
    }
    const item: StoredConfirmation = {
      id: this.nextId++,
      reason,
      operation: cloneOperation(operation),
      expiresAt: new Date(now.getTime() + 120_000),
      ...(taskLease === undefined ? {} : { taskLease: { ...taskLease } }),
      ...(reservedHorizontalTravel === undefined ? {} : { reservedHorizontalTravel }),
    };
    this.pending.set(item.id, item);
    return cloneConfirmation(item);
  }

  get(id: number): PendingConfirmation | undefined {
    const item = this.pending.get(id);
    if (!item) return undefined;
    if (item.expiresAt <= this.now()) {
      this.deleteExpired(id, item);
      return undefined;
    }
    return cloneConfirmation(item);
  }

  allow(
    id: number,
  ):
    | { ok: true; operation: ConfirmableOperation }
    | { ok: false; reason: "missing" | "expired" | "wrong_operation" } {
    const item = this.pending.get(id);
    if (!item) return { ok: false, reason: "missing" };
    if (item.expiresAt <= this.now()) {
      this.deleteExpired(id, item);
      return { ok: false, reason: "expired" };
    }
    if (item.operation.kind === "game_action") {
      return { ok: false, reason: "wrong_operation" };
    }
    this.pending.delete(id);
    return { ok: true, operation: cloneOperation(item.operation) };
  }

  allowGameAction(
    id: number,
    taskLease: TaskLease,
  ):
    | { ok: true; action: GameAction; reservedHorizontalTravel: number }
    | { ok: false; reason: "missing" | "expired" | "wrong_operation" | "wrong_task" } {
    const item = this.pending.get(id);
    if (!item) return { ok: false, reason: "missing" };
    if (item.expiresAt <= this.now()) {
      this.deleteExpired(id, item);
      return { ok: false, reason: "expired" };
    }
    if (item.operation.kind !== "game_action") return { ok: false, reason: "wrong_operation" };
    if (!item.taskLease || !sameTaskLease(item.taskLease, taskLease)) {
      return { ok: false, reason: "wrong_task" };
    }
    this.pending.delete(id);
    this.notifyGameActionsChanged();
    return {
      ok: true,
      action: structuredClone(item.operation.action),
      reservedHorizontalTravel: item.reservedHorizontalTravel ?? 0,
    };
  }

  inspectGameAction(
    id: number,
    taskLease: TaskLease,
  ):
    | { ok: true; action: GameAction; reservedHorizontalTravel: number }
    | { ok: false; reason: "missing" | "expired" | "wrong_operation" | "wrong_task" } {
    const item = this.pending.get(id);
    if (!item) return { ok: false, reason: "missing" };
    if (item.expiresAt <= this.now()) {
      this.deleteExpired(id, item);
      return { ok: false, reason: "expired" };
    }
    if (item.operation.kind !== "game_action") return { ok: false, reason: "wrong_operation" };
    if (!item.taskLease || !sameTaskLease(item.taskLease, taskLease)) {
      return { ok: false, reason: "wrong_task" };
    }
    return {
      ok: true,
      action: structuredClone(item.operation.action),
      reservedHorizontalTravel: item.reservedHorizontalTravel ?? 0,
    };
  }

  deny(id: number): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    if (item.expiresAt <= this.now()) {
      this.deleteExpired(id, item);
      return false;
    }
    if (item.operation.kind === "game_action") return false;
    this.pending.delete(id);
    return true;
  }

  denyGameAction(
    id: number,
    taskLease: TaskLease,
  ):
    { ok: true } | { ok: false; reason: "missing" | "expired" | "wrong_operation" | "wrong_task" } {
    const item = this.pending.get(id);
    if (!item) return { ok: false, reason: "missing" };
    if (item.expiresAt <= this.now()) {
      this.deleteExpired(id, item);
      return { ok: false, reason: "expired" };
    }
    if (item.operation.kind !== "game_action") return { ok: false, reason: "wrong_operation" };
    if (!item.taskLease || !sameTaskLease(item.taskLease, taskLease)) {
      return { ok: false, reason: "wrong_task" };
    }
    this.pending.delete(id);
    this.notifyGameActionsChanged();
    return { ok: true };
  }

  clear(): void {
    const hadGameActions = this.hasStoredGameActions();
    this.pending.clear();
    if (hadGameActions) this.notifyGameActionsChanged();
  }

  clearGameActions(): void {
    let changed = false;
    for (const [id, item] of this.pending) {
      if (item.operation.kind === "game_action") {
        this.pending.delete(id);
        changed = true;
      }
    }
    if (changed) this.notifyGameActionsChanged();
  }

  hasGameActions(taskLease: TaskLease): boolean {
    for (const item of this.pending.values()) {
      if (
        item.operation.kind === "game_action" &&
        item.taskLease &&
        sameTaskLease(item.taskLease, taskLease)
      ) {
        return true;
      }
    }
    return false;
  }

  onGameActionsChanged(listener: () => void): () => void {
    this.gameActionChangedListeners.add(listener);
    return () => this.gameActionChangedListeners.delete(listener);
  }

  onGameActionsExpired(listener: (taskLease: TaskLease) => void): () => void {
    this.gameActionExpiredListeners.add(listener);
    return () => this.gameActionExpiredListeners.delete(listener);
  }

  nextGameActionExpiry(): GameConfirmationExpiry | undefined {
    let next: StoredConfirmation | undefined;
    for (const item of this.pending.values()) {
      if (
        item.operation.kind === "game_action" &&
        item.taskLease &&
        (next === undefined || item.expiresAt < next.expiresAt)
      ) {
        next = item;
      }
    }
    if (!next?.taskLease) return undefined;
    return {
      taskLease: { ...next.taskLease },
      expiresAt: new Date(next.expiresAt),
    };
  }

  expireGameActions(taskLease: TaskLease): number {
    const now = this.now();
    let expired = 0;
    for (const [id, item] of this.pending) {
      if (
        item.operation.kind === "game_action" &&
        item.taskLease &&
        sameTaskLease(item.taskLease, taskLease) &&
        item.expiresAt <= now
      ) {
        this.pending.delete(id);
        expired += 1;
      }
    }
    if (expired > 0) {
      this.notifyGameActionsExpired(taskLease);
      this.notifyGameActionsChanged();
    }
    return expired;
  }

  private deleteExpired(id: number, item: StoredConfirmation): void {
    this.pending.delete(id);
    if (item.operation.kind === "game_action" && item.taskLease) {
      this.notifyGameActionsExpired(item.taskLease);
      this.notifyGameActionsChanged();
    }
  }

  private removeExpiredLocalConfirmations(now: Date): void {
    for (const [id, item] of this.pending) {
      if (item.operation.kind !== "game_action" && item.expiresAt <= now) {
        this.pending.delete(id);
      }
    }
  }

  private hasStoredGameActions(): boolean {
    for (const item of this.pending.values()) {
      if (item.operation.kind === "game_action") return true;
    }
    return false;
  }

  private notifyGameActionsChanged(): void {
    for (const listener of this.gameActionChangedListeners) {
      try {
        listener();
      } catch {
        // Confirmation lifecycle observers cannot veto a fail-closed store mutation.
      }
    }
  }

  private notifyGameActionsExpired(taskLease: TaskLease): void {
    for (const listener of this.gameActionExpiredListeners) {
      try {
        listener({ ...taskLease });
      } catch {
        // Confirmation lifecycle observers cannot veto a fail-closed store mutation.
      }
    }
  }
}

function sameTaskLease(first: TaskLease, second: TaskLease): boolean {
  return first.id === second.id && first.startedAt === second.startedAt;
}
