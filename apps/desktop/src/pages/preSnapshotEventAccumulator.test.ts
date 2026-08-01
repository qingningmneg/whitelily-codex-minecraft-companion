import { describe, expect, it } from "vitest";
import { createPreSnapshotEventAccumulator } from "./preSnapshotEventAccumulator";

describe("pre-snapshot runtime event accumulator", () => {
  it("drains retained kinds in revision order after later values replace their first slots", () => {
    const accumulator = createPreSnapshotEventAccumulator();
    accumulator.add({ kind: "lifecycle", revision: 1, state: "starting" });
    accumulator.add({
      kind: "minecraft",
      revision: 2,
      state: { state: "connecting", sessionId: null },
    });
    accumulator.add({
      kind: "minecraft",
      revision: 3,
      state: { state: "connected", sessionId: "public-session" },
    });
    accumulator.add({ kind: "lifecycle", revision: 4, state: "running" });

    expect(accumulator.drain().map((event) => event.revision)).toEqual([3, 4]);
  });

  it("retains only the latest event for each of the five disjoint snapshot fields", () => {
    const accumulator = createPreSnapshotEventAccumulator();

    for (let index = 0; index < 20; index += 1) {
      accumulator.add({
        kind: "lifecycle",
        revision: index * 5 + 1,
        state: index % 2 === 0 ? "starting" : "running",
      });
      accumulator.add({
        kind: "minecraft",
        revision: index * 5 + 2,
        state: { state: "connecting", sessionId: `session-${index}` },
      });
      accumulator.add({
        kind: "codex",
        revision: index * 5 + 3,
        state: { state: "ready", model: `model-${index}` },
      });
      accumulator.add({ kind: "task", revision: index * 5 + 4, task: null });
      accumulator.add({
        kind: "error",
        revision: index * 5 + 5,
        error: { code: `ERROR_${index}`, message: `private-${index}` },
      });
    }

    const retained = accumulator.drain();
    expect(retained).toHaveLength(5);
    expect(retained).toEqual(
      expect.arrayContaining([
        { kind: "lifecycle", revision: 96, state: "running" },
        {
          kind: "minecraft",
          revision: 97,
          state: { state: "connecting", sessionId: "session-19" },
        },
        {
          kind: "codex",
          revision: 98,
          state: { state: "ready", model: "model-19" },
        },
        { kind: "task", revision: 99, task: null },
        {
          kind: "error",
          revision: 100,
          error: { code: "ERROR_19", message: "private-19" },
        },
      ]),
    );
  });

  it("permanently releases retained events on clear and after drain", () => {
    const accumulator = createPreSnapshotEventAccumulator();
    accumulator.add({ kind: "lifecycle", revision: 1, state: "starting" });
    accumulator.add({
      kind: "error",
      revision: 2,
      error: { code: "PRIVATE", message: "must not escape" },
    });

    accumulator.clear();
    expect(accumulator.drain()).toEqual([]);

    accumulator.add({
      kind: "minecraft",
      revision: 3,
      state: { state: "connecting", sessionId: "session-after-clear" },
    });
    expect(accumulator.drain()).toEqual([]);

    const drained = createPreSnapshotEventAccumulator();
    drained.add({
      kind: "minecraft",
      revision: 4,
      state: { state: "connecting", sessionId: "session-before-drain" },
    });
    expect(drained.drain()).toEqual([
      {
        kind: "minecraft",
        revision: 4,
        state: { state: "connecting", sessionId: "session-before-drain" },
      },
    ]);
    drained.add({ kind: "lifecycle", revision: 5, state: "running" });
    expect(drained.drain()).toEqual([]);
  });
});
