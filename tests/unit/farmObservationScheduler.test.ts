import { describe, expect, it } from "vitest";
import { FarmObservationScheduler } from "../../src/companion/farmObservationScheduler.js";

describe("FarmObservationScheduler", () => {
  it("emits a due wheat observation without harvesting or holding an action queue slot", () => {
    const scheduler = new FarmObservationScheduler();
    scheduler.schedule({
      worldGeneration: 4,
      position: { x: 12, y: 64, z: -3 },
      earliestAt: 1_000,
      purpose: "wheat_maturity",
    });

    expect(scheduler.due(999)).toEqual([]);
    expect(scheduler.due(1_000)).toEqual([
      {
        worldGeneration: 4,
        position: { x: 12, y: 64, z: -3 },
        purpose: "wheat_maturity",
      },
    ]);
  });

  it("cancels stale world observations", () => {
    const scheduler = new FarmObservationScheduler();
    scheduler.schedule({
      worldGeneration: 4,
      position: { x: 12, y: 64, z: -3 },
      earliestAt: 1_000,
      purpose: "wheat_maturity",
    });

    scheduler.cancelWorld(4);
    expect(scheduler.due(1_000)).toEqual([]);
  });

  it("reports the earliest pending observation for a controlled scheduler tick", () => {
    const scheduler = new FarmObservationScheduler();
    scheduler.schedule({
      worldGeneration: 4,
      position: { x: 12, y: 64, z: -3 },
      earliestAt: 2_000,
      purpose: "wheat_maturity",
    });
    scheduler.schedule({
      worldGeneration: 4,
      position: { x: 13, y: 64, z: -3 },
      earliestAt: 1_000,
      purpose: "wheat_maturity",
    });

    expect(scheduler.nextDueAt()).toBe(1_000);
    scheduler.due(1_000);
    expect(scheduler.nextDueAt()).toBe(2_000);
  });
});
