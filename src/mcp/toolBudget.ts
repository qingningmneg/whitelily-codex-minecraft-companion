import { randomBytes } from "node:crypto";
import { GAME_ACTION_KINDS } from "../domain/types.js";
import { TaskControllerBudget, type TaskLease } from "../safety/taskBudget.js";

export const TOOL_ACTION_KINDS = [...GAME_ACTION_KINDS, "get_state", "find_block"] as const;
export type ToolActionKind = (typeof TOOL_ACTION_KINDS)[number];

export interface TrustedToolConsumption {
  blockChanges?: 0 | 1;
  horizontalTravel?: number;
  dangerousOperations?: 0 | 1;
}

export interface TurnToolAuthorization {
  readonly allowedActions?: readonly ToolActionKind[];
}

export interface TurnToolBudgetSnapshot {
  active: boolean;
  ended: boolean;
  totalCalls: number;
  attemptedDigCount: number;
  attemptedPlaceCount: number;
  cumulativeHorizontalTravel: number;
}

export type BudgetConsumeResult =
  | { ok: true; snapshot: TurnToolBudgetSnapshot }
  | {
      ok: false;
      reason:
        | "tool turn has not begun"
        | "tool turn has ended"
        | "tool turn lease is invalid"
        | "tool action is not allowed"
        | "tool call budget exhausted";
    };

export class TurnToolBudget {
  private active = false;
  private ended = false;
  private totalCalls = 0;
  private attemptedDigCount = 0;
  private attemptedPlaceCount = 0;
  private cumulativeHorizontalTravel = 0;
  private activeLease: string | undefined;
  private taskLease: TaskLease | undefined;
  private ownsTaskLease = false;
  private allowedActions: ReadonlySet<ToolActionKind> | undefined;

  constructor(private readonly taskBudget = new TaskControllerBudget()) {}

  begin(taskLease?: TaskLease, authorization: TurnToolAuthorization = {}): string {
    if (this.active) throw new Error("tool turn is already active");
    this.active = true;
    this.ended = false;
    this.totalCalls = 0;
    this.attemptedDigCount = 0;
    this.attemptedPlaceCount = 0;
    this.cumulativeHorizontalTravel = 0;
    this.taskLease = taskLease ?? this.taskBudget.begin();
    this.ownsTaskLease = taskLease === undefined;
    this.allowedActions =
      authorization.allowedActions === undefined
        ? undefined
        : new Set<ToolActionKind>(authorization.allowedActions);
    this.activeLease = randomBytes(32).toString("base64url");
    return this.activeLease;
  }

  end(): void {
    if (!this.active) return;
    this.active = false;
    this.ended = true;
    this.activeLease = undefined;
    if (this.ownsTaskLease) this.taskBudget.invalidate("completed");
    this.taskLease = undefined;
    this.ownsTaskLease = false;
    this.allowedActions = undefined;
  }

  checkLease(lease?: string): BudgetConsumeResult {
    if (!this.active) {
      return { ok: false, reason: this.ended ? "tool turn has ended" : "tool turn has not begun" };
    }
    if (lease === undefined || lease !== this.activeLease || this.taskLease === undefined) {
      return { ok: false, reason: "tool turn lease is invalid" };
    }
    return { ok: true, snapshot: this.snapshot() };
  }

  currentTaskLease(lease?: string): TaskLease | undefined {
    if (!this.checkLease(lease).ok || !this.taskLease) return undefined;
    return this.taskBudget.isLeaseActive(this.taskLease) ? { ...this.taskLease } : undefined;
  }

  consume(
    kind: ToolActionKind,
    lease?: string,
    trustedConsumption: TrustedToolConsumption = {},
  ): BudgetConsumeResult {
    const authorization = this.checkLease(lease);
    if (!authorization.ok) return authorization;
    if (this.allowedActions !== undefined && !this.allowedActions.has(kind)) {
      return { ok: false, reason: "tool action is not allowed" };
    }
    const taskLease = this.taskLease;
    if (!taskLease) return { ok: false, reason: "tool turn lease is invalid" };
    const taskResult = this.taskBudget.consume({
      lease: taskLease,
      kind,
      now: this.taskBudget.currentTime(),
      ...(trustedConsumption.blockChanges === undefined
        ? {}
        : { blockChanges: trustedConsumption.blockChanges }),
      ...(trustedConsumption.horizontalTravel === undefined
        ? {}
        : { horizontalTravel: trustedConsumption.horizontalTravel }),
      ...(trustedConsumption.dangerousOperations === undefined
        ? {}
        : { dangerousOperations: trustedConsumption.dangerousOperations }),
    });
    if (!taskResult.ok) {
      return {
        ok: false,
        reason:
          taskResult.reason === "task lease is invalid" &&
          this.taskBudget.snapshot().stopReason !== "budget_exhausted"
            ? "tool turn lease is invalid"
            : "tool call budget exhausted",
      };
    }

    this.totalCalls += 1;
    if (kind === "dig_block") this.attemptedDigCount += 1;
    if (kind === "place_block") this.attemptedPlaceCount += 1;
    return { ok: true, snapshot: this.snapshot() };
  }

  recordHorizontalTravel(distance: number): void {
    if (!this.active) return;
    if (distance < 0) throw new Error("travel distance cannot be negative");
    if (!Number.isFinite(distance)) {
      this.cumulativeHorizontalTravel = Infinity;
      return;
    }
    const total = this.cumulativeHorizontalTravel + distance;
    this.cumulativeHorizontalTravel = Number.isFinite(total) ? total : Infinity;
  }

  snapshot(): TurnToolBudgetSnapshot {
    return {
      active: this.active,
      ended: this.ended,
      totalCalls: this.totalCalls,
      attemptedDigCount: this.attemptedDigCount,
      attemptedPlaceCount: this.attemptedPlaceCount,
      cumulativeHorizontalTravel: this.cumulativeHorizontalTravel,
    };
  }
}
