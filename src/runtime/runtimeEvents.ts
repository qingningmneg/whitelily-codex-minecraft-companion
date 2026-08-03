import type { TaskBudgetSnapshot, TaskLimits, TaskStopReason } from "../safety/taskBudget.js";

export type RuntimeCommand =
  | { readonly kind: "start" }
  | { readonly kind: "stop"; readonly reason: TaskStopReason }
  | { readonly kind: "status" };

export interface PublicTaskSnapshot {
  readonly id: string;
  readonly goal: string;
  readonly status: "running" | "waiting_confirmation";
  readonly allowedActions: readonly string[];
  readonly effectiveLimits: TaskLimits;
  readonly startedAt: string;
  readonly budget: TaskBudgetSnapshot;
}

export type ActionCapabilitySnapshot =
  | { readonly state: "starting"; readonly workspaceVersion: string }
  | {
      readonly state: "ready";
      readonly workspaceVersion: string;
      readonly mcpListening: true;
      readonly discoveredToolCount: number;
    }
  | {
      readonly state: "failed";
      readonly workspaceVersion: string | null;
      readonly mcpListening: boolean;
      readonly discoveredToolCount: number;
      readonly errorCode: string;
    };

export interface RuntimeSnapshot {
  readonly revision: number;
  readonly lifecycle: "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";
  readonly minecraft: {
    readonly state: "disconnected" | "connecting" | "connected" | "reconnecting";
    readonly sessionId: string | null;
  };
  readonly codex: {
    readonly state: "stopped" | "starting" | "ready" | "failed";
    readonly model: string | null;
  };
  readonly actions: ActionCapabilitySnapshot | null;
  readonly task: PublicTaskSnapshot | null;
  readonly lastError: { readonly code: string; readonly message: string } | null;
}

export type RuntimeEventPayload =
  | { readonly kind: "lifecycle"; readonly state: RuntimeSnapshot["lifecycle"] }
  | { readonly kind: "minecraft"; readonly state: RuntimeSnapshot["minecraft"] }
  | { readonly kind: "codex"; readonly state: RuntimeSnapshot["codex"] }
  | { readonly kind: "actions"; readonly state: RuntimeSnapshot["actions"] }
  | { readonly kind: "task"; readonly task: PublicTaskSnapshot | null }
  | { readonly kind: "error"; readonly error: { readonly code: string; readonly message: string } };

export type RuntimeEvent = RuntimeEventPayload extends infer Event
  ? Event extends RuntimeEventPayload
    ? Event & { readonly revision: number }
    : never
  : never;

export interface RuntimeAuthorityLoss {
  readonly reason: "model_unavailable" | "action_unavailable";
}
