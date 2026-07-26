import { randomBytes } from "node:crypto";
import type { GameAction } from "../domain/types.js";

export type ToolActionKind = GameAction["kind"] | "get_state" | "find_block";

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
        | "tool call budget exhausted";
    };

const MAX_TOOL_CALLS = 64;

export class TurnToolBudget {
  private active = false;
  private ended = false;
  private totalCalls = 0;
  private attemptedDigCount = 0;
  private attemptedPlaceCount = 0;
  private cumulativeHorizontalTravel = 0;
  private activeLease: string | undefined;

  begin(): string {
    if (this.active) throw new Error("tool turn is already active");
    this.active = true;
    this.ended = false;
    this.totalCalls = 0;
    this.attemptedDigCount = 0;
    this.attemptedPlaceCount = 0;
    this.cumulativeHorizontalTravel = 0;
    this.activeLease = randomBytes(32).toString("base64url");
    return this.activeLease;
  }

  end(): void {
    if (!this.active) return;
    this.active = false;
    this.ended = true;
    this.activeLease = undefined;
  }

  consume(kind: ToolActionKind, lease?: string): BudgetConsumeResult {
    if (!this.active) {
      return { ok: false, reason: this.ended ? "tool turn has ended" : "tool turn has not begun" };
    }
    if (lease === undefined || lease !== this.activeLease) {
      return { ok: false, reason: "tool turn lease is invalid" };
    }
    if (this.totalCalls >= MAX_TOOL_CALLS)
      return { ok: false, reason: "tool call budget exhausted" };

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
