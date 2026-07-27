import { describe, expect, it } from "vitest";
import {
  HARD_TASK_LIMITS,
  TaskControllerBudget,
  type TaskConsumption,
  type TaskStopReason,
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

  it("charges only additional confirmed travel without adding a second tool call", () => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    const lease = budget.begin({ maxHorizontalTravel: 400 });
    expect(budget.consume({ lease, kind: "move_to", now: 1, horizontalTravel: 300 }).ok).toBe(true);

    expect(budget.consumeAdditionalTravel(lease, 2, 100).ok).toBe(true);
    expect(budget.snapshot()).toMatchObject({
      active: true,
      toolCalls: 1,
      horizontalTravel: 400,
    });
    expect(budget.consumeAdditionalTravel(lease, 3, 1)).toEqual({
      ok: false,
      reason: "task budget exhausted",
    });
    expect(budget.snapshot()).toMatchObject({
      active: false,
      stopReason: "budget_exhausted",
      toolCalls: 1,
      horizontalTravel: 400,
    });
  });

  it("rejects malformed consumption input as an invalid lease without throwing", () => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    budget.begin();

    for (const input of [undefined, null, {}, { lease: null }, { lease: {} }]) {
      expect(budget.consume(input as TaskConsumption)).toEqual({
        ok: false,
        reason: "task lease is invalid",
      });
    }
  });

  it("enforces the ten-minute duration boundary before accepting a call", () => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    const lease = budget.begin();

    expect(budget.consume({ lease, kind: "say", now: HARD_TASK_LIMITS.maxDurationMs - 1 }).ok).toBe(
      true,
    );
    expect(budget.consume({ lease, kind: "say", now: HARD_TASK_LIMITS.maxDurationMs })).toEqual({
      ok: false,
      reason: "task duration exhausted",
    });
    expect(budget.snapshot()).toMatchObject({ active: false, stopReason: "timeout" });
  });

  it("allows only one active task", () => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    budget.begin();

    expect(() => budget.begin()).toThrow("task is already active");
  });

  it.each([Number.NaN, Infinity, -1])(
    "rejects non-finite or negative consumption without changing counters: %s",
    (blockChanges) => {
      const budget = new TaskControllerBudget({ now: () => 0 });
      const lease = budget.begin();
      const before = budget.snapshot();

      expect(budget.consume({ lease, kind: "dig_block", now: 1, blockChanges })).toEqual({
        ok: false,
        reason: "task budget exhausted",
      });
      expect(budget.snapshot()).toMatchObject({
        toolCalls: before.toolCalls,
        blockChanges: before.blockChanges,
        horizontalTravel: before.horizontalTravel,
        dangerousOperations: before.dangerousOperations,
      });
    },
  );

  it("returns immutable snapshot copies", () => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    budget.begin();
    const snapshot = budget.snapshot();

    expect(() => {
      snapshot.toolCalls = 99;
    }).toThrow(TypeError);
    expect(() => {
      snapshot.limits.maxToolCalls = 99;
    }).toThrow(TypeError);
    expect(budget.snapshot().limits.maxToolCalls).toBe(HARD_TASK_LIMITS.maxToolCalls);
  });

  it.each([
    "completed",
    "failed",
    "timeout",
    "budget_exhausted",
    "owner_stop",
    "emergency_stop",
    "disconnect",
    "world_changed",
    "model_unavailable",
    "process_exit",
  ] as const)("records the %s stop reason", (reason: TaskStopReason) => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    budget.begin();

    budget.invalidate(reason);

    expect(budget.snapshot()).toMatchObject({ active: false, stopReason: reason });
  });
});
