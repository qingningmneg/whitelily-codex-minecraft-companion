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
    return this.createStored(
      reason,
      { kind: "game_action", action },
      { ...taskLease },
      reservedHorizontalTravel,
    );
  }

  private createStored(
    reason: string,
    operation: ConfirmableOperation,
    taskLease?: TaskLease,
    reservedHorizontalTravel?: number,
  ): PendingConfirmation {
    const now = this.now();
    this.removeExpired(now);
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
      this.pending.delete(id);
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
      this.pending.delete(id);
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
      this.pending.delete(id);
      return { ok: false, reason: "expired" };
    }
    if (item.operation.kind !== "game_action") return { ok: false, reason: "wrong_operation" };
    if (!item.taskLease || !sameTaskLease(item.taskLease, taskLease)) {
      return { ok: false, reason: "wrong_task" };
    }
    this.pending.delete(id);
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
      this.pending.delete(id);
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
      this.pending.delete(id);
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
      this.pending.delete(id);
      return { ok: false, reason: "expired" };
    }
    if (item.operation.kind !== "game_action") return { ok: false, reason: "wrong_operation" };
    if (!item.taskLease || !sameTaskLease(item.taskLease, taskLease)) {
      return { ok: false, reason: "wrong_task" };
    }
    this.pending.delete(id);
    return { ok: true };
  }

  clear(): void {
    this.pending.clear();
  }

  clearGameActions(): void {
    for (const [id, item] of this.pending) {
      if (item.operation.kind === "game_action") this.pending.delete(id);
    }
  }

  hasGameActions(taskLease: TaskLease): boolean {
    this.removeExpired(this.now());
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

  private removeExpired(now: Date): void {
    for (const [id, item] of this.pending) {
      if (item.expiresAt <= now) this.pending.delete(id);
    }
  }
}

function sameTaskLease(first: TaskLease, second: TaskLease): boolean {
  return first.id === second.id && first.startedAt === second.startedAt;
}
