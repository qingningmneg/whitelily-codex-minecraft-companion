import { describe, expect, it } from "vitest";
import {
  HARD_TASK_LIMITS,
  TaskControllerBudget,
  type TaskLimits,
} from "../../src/safety/taskBudget.js";

describe("TaskControllerBudget", () => {
  it("clamps every requested value to the immutable hard limit", () => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    budget.begin({
      maxToolCalls: 999,
      maxBlockChanges: 999,
      maxHorizontalTravel: 999_999,
      maxDurationMs: 999_999_999,
      maxDangerousOperations: 999,
    });
    expect(budget.snapshot().limits).toEqual(HARD_TASK_LIMITS);
  });

  it("invalidates the lease and refuses all later calls", () => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    const lease = budget.begin();
    budget.invalidate("emergency_stop");
    expect(budget.consume({ lease, kind: "say", now: 1 })).toEqual({
      ok: false,
      reason: "task lease is invalid",
    });
  });

  it("enforces tool calls independently", () => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    const lease = budget.begin();
    for (let index = 0; index < 64; index += 1) {
      expect(budget.consume({ lease, kind: "say", now: 1 }).ok).toBe(true);
    }
    expect(budget.consume({ lease, kind: "say", now: 1 }).ok).toBe(false);
  });

  it.each([
    [
      "block changes",
      { kind: "dig_block", blockChanges: 256, horizontalTravel: 0, dangerousOperations: 0 },
      { kind: "dig_block", blockChanges: 1, horizontalTravel: 0, dangerousOperations: 0 },
    ],
    [
      "horizontal travel",
      { kind: "move_to", blockChanges: 0, horizontalTravel: 1_024, dangerousOperations: 0 },
      { kind: "move_to", blockChanges: 0, horizontalTravel: 1, dangerousOperations: 0 },
    ],
    [
      "dangerous operations",
      { kind: "place_block", blockChanges: 0, horizontalTravel: 0, dangerousOperations: 8 },
      { kind: "place_block", blockChanges: 0, horizontalTravel: 0, dangerousOperations: 1 },
    ],
  ] as const)("enforces %s independently", (_name, allowed, overflow) => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    const lease = budget.begin();
    expect(budget.consume({ lease, now: 1, ...allowed }).ok).toBe(true);
    expect(budget.consume({ lease, now: 1, ...overflow })).toEqual({
      ok: false,
      reason: "task budget exhausted",
    });
  });
});
