import { describe, expect, it } from "vitest";
import { TurnToolBudget } from "../../src/mcp/toolBudget.js";

describe("TurnToolBudget", () => {
  it("rejects the sixty-fifth attempted call", () => {
    const budget = new TurnToolBudget();
    const lease = budget.begin();

    for (let call = 0; call < 64; call += 1) expect(budget.consume("say", lease).ok).toBe(true);
    expect(budget.consume("say", lease)).toEqual({
      ok: false,
      reason: "tool call budget exhausted",
    });
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
});
