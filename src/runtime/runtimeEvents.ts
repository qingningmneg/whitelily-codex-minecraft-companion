import type { TaskDisclosure } from "../companion/taskController.js";
import type { TaskBudgetSnapshot, TaskStopReason } from "../safety/taskBudget.js";

export type RuntimeCommand =
  | { readonly kind: "start" }
  | { readonly kind: "stop"; readonly reason: TaskStopReason }
  | { readonly kind: "status" };

export interface PublicTaskSnapshot {
  readonly id: string;
  readonly disclosure: TaskDisclosure;
  readonly startedAt: string;
  readonly budget: TaskBudgetSnapshot;
}

export interface RuntimeSnapshot {
  readonly lifecycle: "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";
  readonly minecraft: {
    readonly state: "disconnected" | "connecting" | "connected" | "reconnecting";
    readonly sessionId: string | null;
  };
  readonly codex: {
    readonly state: "stopped" | "starting" | "ready" | "failed";
    readonly model: string | null;
  };
  readonly task: PublicTaskSnapshot | null;
  readonly lastError: { readonly code: string; readonly message: string } | null;
}

export type RuntimeEvent =
  | { readonly kind: "lifecycle"; readonly state: RuntimeSnapshot["lifecycle"] }
  | { readonly kind: "minecraft"; readonly state: RuntimeSnapshot["minecraft"] }
  | { readonly kind: "codex"; readonly state: RuntimeSnapshot["codex"] }
  | { readonly kind: "task"; readonly task: PublicTaskSnapshot | null }
  | { readonly kind: "error"; readonly error: { readonly code: string; readonly message: string } };
