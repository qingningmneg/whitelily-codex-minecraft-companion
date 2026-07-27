import { describe, expect, it } from "vitest";
import { TurnToolBudget } from "../../src/mcp/toolBudget.js";
import { TaskControllerBudget } from "../../src/safety/taskBudget.js";

describe("TurnToolBudget", () => {
  it("rejects every attempted call after the sixty-fourth with the legacy budget error", () => {
    const budget = new TurnToolBudget();
    const lease = budget.begin();

    for (let call = 0; call < 64; call += 1) expect(budget.consume("say", lease).ok).toBe(true);
    for (let call = 0; call < 2; call += 1) {
      expect(budget.consume("say", lease)).toEqual({
        ok: false,
        reason: "tool call budget exhausted",
      });
    }
  });

  it("tracks real attempted edits and saturates unsafe travel conservatively", () => {
    const budget = new TurnToolBudget();
    const lease = budget.begin();

    for (let call = 0; call < 32; call += 1) budget.consume("dig_block", lease);
    for (let call = 0; call < 32; call += 1) budget.consume("place_block", lease);
    budget.recordHorizontalTravel(Number.MAX_VALUE);
    budget.recordHorizontalTravel(Number.MAX_VALUE);

    expect(budget.snapshot()).toMatchObject({
      attemptedDigCount: 32,
      attemptedPlaceCount: 32,
      cumulativeHorizontalTravel: Infinity,
    });
  });

  it("rejects negative travel and saturates non-finite travel", () => {
    const budget = new TurnToolBudget();
    budget.begin();

    expect(() => budget.recordHorizontalTravel(-1)).toThrow("travel distance cannot be negative");
    budget.recordHorizontalTravel(Number.NaN);
    expect(budget.snapshot().cumulativeHorizontalTravel).toBe(Infinity);
  });

  it("refuses calls before begin and after end", () => {
    const budget = new TurnToolBudget();
    expect(budget.consume("say")).toEqual({ ok: false, reason: "tool turn has not begun" });
    budget.begin();
    budget.end();
    expect(budget.consume("say")).toEqual({ ok: false, reason: "tool turn has ended" });
  });

  it("rejects a canceled turn lease after a newer turn begins without spending the new budget", () => {
    const budget = new TurnToolBudget();
    const oldLease = budget.begin();
    expect(budget.consume("say", oldLease).ok).toBe(true);
    budget.end();

    const newLease = budget.begin();
    expect(newLease).not.toBe(oldLease);
    expect(budget.consume("say", oldLease)).toEqual({
      ok: false,
      reason: "tool turn lease is invalid",
    });
    expect(budget.snapshot().totalCalls).toBe(0);
    expect(budget.consume("say", newLease).ok).toBe(true);
  });

  it("checks turn authority without consuming either the turn or task budget", () => {
    const taskBudget = new TaskControllerBudget();
    const budget = new TurnToolBudget(taskBudget);
    const turnLease = budget.begin(taskBudget.begin());

    expect(budget.checkLease(turnLease).ok).toBe(true);
    expect(budget.checkLease("x".repeat(43))).toEqual({
      ok: false,
      reason: "tool turn lease is invalid",
    });
    expect(budget.snapshot().totalCalls).toBe(0);
    expect(taskBudget.snapshot().toolCalls).toBe(0);
  });

  it("exposes the live task capability only to its matching active turn", () => {
    const taskBudget = new TaskControllerBudget();
    const taskLease = taskBudget.begin();
    const budget = new TurnToolBudget(taskBudget);
    const turnLease = budget.begin(taskLease);

    expect(budget.currentTaskLease(turnLease)).toEqual(taskLease);
    expect(budget.currentTaskLease("x".repeat(43))).toBeUndefined();
    taskBudget.invalidate("owner_stop");
    expect(budget.currentTaskLease(turnLease)).toBeUndefined();
  });

  it("delegates accepted calls to its supplied task lease", () => {
    const taskBudget = new TaskControllerBudget();
    const taskLease = taskBudget.begin();
    const budget = new TurnToolBudget(taskBudget);
    const turnLease = budget.begin(taskLease);

    expect(budget.consume("say", turnLease).ok).toBe(true);
    expect(taskBudget.snapshot().toolCalls).toBe(1);
  });

  it("forwards trusted dangerous-operation consumption to its task lease", () => {
    const taskBudget = new TaskControllerBudget();
    const taskLease = taskBudget.begin();
    const budget = new TurnToolBudget(taskBudget);
    const turnLease = budget.begin(taskLease);

    expect(budget.consume("place_block", turnLease, { dangerousOperations: 1 }).ok).toBe(true);
    expect(taskBudget.snapshot().dangerousOperations).toBe(1);
  });

  it("uses the task budget clock for supplied task leases", () => {
    let now = 0;
    const taskBudget = new TaskControllerBudget({ now: () => now });
    const taskLease = taskBudget.begin();
    const budget = new TurnToolBudget(taskBudget);
    const turnLease = budget.begin(taskLease);

    now = 1;
    expect(budget.consume("say", turnLease).ok).toBe(true);
  });
});
