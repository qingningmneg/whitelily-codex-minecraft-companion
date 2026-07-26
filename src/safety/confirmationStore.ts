import type { ConfirmableOperation, GameAction } from "../domain/types.js";

interface PendingConfirmation {
  id: number;
  reason: string;
  operation: ConfirmableOperation;
  expiresAt: Date;
}

function cloneOperation(operation: ConfirmableOperation): ConfirmableOperation {
  return structuredClone(operation);
}

function cloneConfirmation(confirmation: PendingConfirmation): PendingConfirmation {
  return {
    ...confirmation,
    operation: cloneOperation(confirmation.operation),
    expiresAt: new Date(confirmation.expiresAt),
  };
}

export class ConfirmationStore {
  private nextId = 1;
  private readonly pending = new Map<number, PendingConfirmation>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(reason: string, operation: ConfirmableOperation): PendingConfirmation {
    const now = this.now();
    this.removeExpired(now);
    if (!Number.isSafeInteger(this.nextId) || this.nextId >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Confirmation ID space exhausted");
    }
    const item: PendingConfirmation = {
      id: this.nextId++,
      reason,
      operation: cloneOperation(operation),
      expiresAt: new Date(now.getTime() + 120_000),
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
  ): { ok: true; operation: ConfirmableOperation } | { ok: false; reason: "missing" | "expired" } {
    const item = this.pending.get(id);
    if (!item) return { ok: false, reason: "missing" };
    this.pending.delete(id);
    if (item.expiresAt <= this.now()) return { ok: false, reason: "expired" };
    return { ok: true, operation: cloneOperation(item.operation) };
  }

  allowGameAction(
    id: number,
  ):
    | { ok: true; action: GameAction }
    | { ok: false; reason: "missing" | "expired" | "wrong_operation" } {
    const item = this.pending.get(id);
    if (!item) return { ok: false, reason: "missing" };
    if (item.expiresAt <= this.now()) {
      this.pending.delete(id);
      return { ok: false, reason: "expired" };
    }
    if (item.operation.kind !== "game_action") return { ok: false, reason: "wrong_operation" };
    this.pending.delete(id);
    return { ok: true, action: structuredClone(item.operation.action) };
  }

  deny(id: number): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    this.pending.delete(id);
    return item.expiresAt > this.now();
  }

  clear(): void {
    this.pending.clear();
  }

  private removeExpired(now: Date): void {
    for (const [id, item] of this.pending) {
      if (item.expiresAt <= now) this.pending.delete(id);
    }
  }
}
