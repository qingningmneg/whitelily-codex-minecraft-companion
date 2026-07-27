import { describe, expect, it } from "vitest";
import { ConfirmationStore } from "../../src/safety/confirmationStore.js";
import type { TaskLease } from "../../src/safety/taskBudget.js";

describe("ConfirmationStore", () => {
  const taskLease: TaskLease = { id: "task-lease-a", startedAt: 1_000 };

  it("refuses to create a taskless game-action confirmation", () => {
    const store = new ConfirmationStore(() => new Date("2026-07-25T00:00:00Z"));

    expect(() =>
      store.create("taskless", {
        kind: "game_action",
        action: { kind: "wait", milliseconds: 1 },
      }),
    ).toThrow("game confirmations require a task capability");
  });

  it("atomically matches the originating task capability before consuming a game action", () => {
    const store = new ConfirmationStore(() => new Date("2026-07-25T00:00:00Z"));
    const confirmation = store.createGameAction(
      "travel",
      { kind: "move_to", position: { x: 300, y: 64, z: 0 } },
      taskLease,
      300,
    );

    expect(
      store.allowGameAction(confirmation.id, {
        id: "task-lease-b",
        startedAt: taskLease.startedAt,
      }),
    ).toEqual({ ok: false, reason: "wrong_task" });
    expect(store.hasGameActions(taskLease)).toBe(true);
    expect(store.allowGameAction(confirmation.id, taskLease)).toEqual({
      ok: true,
      action: { kind: "move_to", position: { x: 300, y: 64, z: 0 } },
      reservedHorizontalTravel: 300,
    });
    expect(store.hasGameActions(taskLease)).toBe(false);
  });

  it("reveals an isolated game reservation only to the originating live-task caller", () => {
    const store = new ConfirmationStore(() => new Date("2026-07-25T00:00:00Z"));
    const confirmation = store.createGameAction(
      "travel",
      { kind: "move_to", position: { x: 300, y: 64, z: 0 } },
      taskLease,
      300,
    );

    expect(
      store.inspectGameAction(confirmation.id, {
        id: taskLease.id,
        startedAt: taskLease.startedAt + 1,
      }),
    ).toEqual({ ok: false, reason: "wrong_task" });
    const inspected = store.inspectGameAction(confirmation.id, taskLease);
    expect(inspected).toEqual({
      ok: true,
      action: { kind: "move_to", position: { x: 300, y: 64, z: 0 } },
      reservedHorizontalTravel: 300,
    });
    if (inspected.ok && inspected.action.kind === "move_to") inspected.action.position.x = 0;
    expect(store.inspectGameAction(confirmation.id, taskLease)).toEqual({
      ok: true,
      action: { kind: "move_to", position: { x: 300, y: 64, z: 0 } },
      reservedHorizontalTravel: 300,
    });
  });

  it("clears game capabilities without consuming local memory-clear confirmation", () => {
    const store = new ConfirmationStore(() => new Date("2026-07-25T00:00:00Z"));
    store.createGameAction("wait", { kind: "wait", milliseconds: 1 }, taskLease);
    const memory = store.create("clear", { kind: "memory_clear" });

    store.clearGameActions();

    expect(store.hasGameActions(taskLease)).toBe(false);
    expect(store.allow(memory.id)).toEqual({ ok: true, operation: { kind: "memory_clear" } });
  });

  it("creates a pending confirmation that can be retrieved without consuming it", () => {
    const store = new ConfirmationStore(() => new Date("2026-07-25T00:00:00Z"));
    const operation = { kind: "memory_clear" as const };

    const confirmation = store.create("clear memories", operation);

    expect(confirmation).toMatchObject({
      id: 1,
      reason: "clear memories",
      operation,
      expiresAt: new Date("2026-07-25T00:02:00Z"),
    });
    expect(store.get(confirmation.id)).toEqual(confirmation);
  });

  it("allows a pending confirmation exactly once", () => {
    const store = new ConfirmationStore(() => new Date("2026-07-25T00:00:00Z"));
    const operation = { kind: "memory_clear" as const };
    const confirmation = store.create("clear memories", operation);

    expect(store.allow(confirmation.id)).toEqual({ ok: true, operation });
    expect(store.allow(confirmation.id)).toEqual({ ok: false, reason: "missing" });
  });

  it("consumes only game-action confirmations and returns an isolated action copy", () => {
    const store = new ConfirmationStore(() => new Date("2026-07-25T00:00:00Z"));
    const gameAction = store.createGameAction(
      "travel",
      { kind: "move_to", position: { x: 300, y: 64, z: 0 } },
      taskLease,
    );
    const memoryClear = store.create("clear", { kind: "memory_clear" });

    const approved = store.allowGameAction(gameAction.id, taskLease);
    expect(approved).toEqual({
      ok: true,
      action: { kind: "move_to", position: { x: 300, y: 64, z: 0 } },
      reservedHorizontalTravel: 0,
    });
    if (approved.ok && approved.action.kind === "move_to") approved.action.position.x = 0;

    expect(store.allowGameAction(gameAction.id, taskLease)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(store.allowGameAction(memoryClear.id, taskLease)).toEqual({
      ok: false,
      reason: "wrong_operation",
    });
    expect(store.get(memoryClear.id)).toMatchObject({ id: memoryClear.id });
  });

  it("expires confirmations at the 120-second boundary", () => {
    let now = new Date("2026-07-25T00:00:00Z");
    const store = new ConfirmationStore(() => now);
    const confirmation = store.create("clear memories", { kind: "memory_clear" });

    now = new Date("2026-07-25T00:02:00Z");

    expect(store.allow(confirmation.id)).toEqual({ ok: false, reason: "expired" });
    expect(store.allow(confirmation.id)).toEqual({ ok: false, reason: "missing" });
  });

  it("does not return an expired confirmation from get", () => {
    let now = new Date("2026-07-25T00:00:00Z");
    const store = new ConfirmationStore(() => now);
    const confirmation = store.create("clear memories", { kind: "memory_clear" });

    now = new Date("2026-07-25T00:02:00Z");

    expect(store.get(confirmation.id)).toBeUndefined();
    expect(store.allow(confirmation.id)).toEqual({ ok: false, reason: "missing" });
  });

  it("denies and clears pending confirmations", () => {
    const store = new ConfirmationStore(() => new Date("2026-07-25T00:00:00Z"));
    const first = store.create("first", { kind: "memory_clear" });
    const second = store.create("second", { kind: "memory_clear" });

    expect(store.deny(first.id)).toBe(true);
    expect(store.deny(first.id)).toBe(false);
    store.clear();

    expect(store.get(second.id)).toBeUndefined();
    expect(store.allow(second.id)).toEqual({ ok: false, reason: "missing" });
  });

  it("keeps the stored expiry and operation isolated from the create result", () => {
    let now = new Date("2026-07-25T00:00:00Z");
    const store = new ConfirmationStore(() => now);
    const operation = {
      kind: "game_action" as const,
      action: { kind: "place_block" as const, blockName: "stone", position: { x: 1, y: 64, z: 2 } },
    };
    const confirmation = store.createGameAction("place stone", operation.action, taskLease);

    confirmation.expiresAt.setTime(new Date("2026-07-25T01:00:00Z").getTime());
    if (
      confirmation.operation.kind === "game_action" &&
      confirmation.operation.action.kind === "place_block"
    ) {
      confirmation.operation.action.blockName = "tnt";
      confirmation.operation.action.position.x = 99;
    }
    now = new Date("2026-07-25T00:02:00Z");

    expect(operation.action).toEqual({
      kind: "place_block",
      blockName: "stone",
      position: { x: 1, y: 64, z: 2 },
    });
    expect(store.allowGameAction(confirmation.id, taskLease)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("keeps the stored operation isolated from get results", () => {
    let now = new Date("2026-07-25T00:00:00Z");
    const store = new ConfirmationStore(() => now);
    const confirmation = store.createGameAction(
      "place stone",
      { kind: "place_block", blockName: "stone", position: { x: 1, y: 64, z: 2 } },
      taskLease,
    );
    const pending = store.get(confirmation.id)!;

    pending.expiresAt.setTime(new Date("2026-07-25T01:00:00Z").getTime());
    if (
      pending.operation.kind === "game_action" &&
      pending.operation.action.kind === "place_block"
    ) {
      pending.operation.action.blockName = "tnt";
      pending.operation.action.position.x = 99;
    }

    expect(store.get(confirmation.id)).toMatchObject({
      expiresAt: new Date("2026-07-25T00:02:00Z"),
      operation: {
        kind: "game_action",
        action: { kind: "place_block", blockName: "stone", position: { x: 1, y: 64, z: 2 } },
      },
    });
    now = new Date("2026-07-25T00:02:00Z");

    expect(store.allowGameAction(confirmation.id, taskLease)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("returns an allow operation that cannot mutate the caller input", () => {
    const store = new ConfirmationStore(() => new Date("2026-07-25T00:00:00Z"));
    const operation = {
      kind: "game_action" as const,
      action: { kind: "place_block" as const, blockName: "stone", position: { x: 1, y: 64, z: 2 } },
    };
    const confirmation = store.createGameAction("place stone", operation.action, taskLease);
    const result = store.allowGameAction(confirmation.id, taskLease);

    if (result.ok && result.action.kind === "place_block") {
      result.action.blockName = "tnt";
      result.action.position.x = 99;
    }

    expect(operation.action).toEqual({
      kind: "place_block",
      blockName: "stone",
      position: { x: 1, y: 64, z: 2 },
    });
  });

  it("returns the original operation when a get result action is mutated", () => {
    const store = new ConfirmationStore(() => new Date("2026-07-25T00:00:00Z"));
    const confirmation = store.createGameAction(
      "place stone",
      { kind: "place_block", blockName: "stone", position: { x: 1, y: 64, z: 2 } },
      taskLease,
    );
    const pending = store.get(confirmation.id)!;

    if (
      pending.operation.kind === "game_action" &&
      pending.operation.action.kind === "place_block"
    ) {
      pending.operation.action.blockName = "tnt";
      pending.operation.action.position.x = 99;
    }

    expect(store.allowGameAction(confirmation.id, taskLease)).toEqual({
      ok: true,
      action: { kind: "place_block", blockName: "stone", position: { x: 1, y: 64, z: 2 } },
      reservedHorizontalTravel: 0,
    });
  });

  it("returns false and removes an expired confirmation when denied", () => {
    let now = new Date("2026-07-25T00:00:00Z");
    const store = new ConfirmationStore(() => now);
    const confirmation = store.create("clear memories", { kind: "memory_clear" });
    now = new Date("2026-07-25T00:02:00Z");

    expect(store.deny(confirmation.id)).toBe(false);
    expect(store.get(confirmation.id)).toBeUndefined();
  });

  it("removes expired untouched confirmations when a new confirmation is created", () => {
    let now = new Date("2026-07-25T00:00:00Z");
    const store = new ConfirmationStore(() => now);
    const first = store.create("first", { kind: "memory_clear" });
    const second = store.create("second", { kind: "memory_clear" });
    now = new Date("2026-07-25T00:02:00Z");

    const fresh = store.create("fresh", { kind: "memory_clear" });

    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(second.id)).toBeUndefined();
    expect(store.get(fresh.id)).toMatchObject({ id: fresh.id, reason: "fresh" });
  });

  it("refuses to allocate an unsafe confirmation ID without replacing a pending item", () => {
    const store = new ConfirmationStore(() => new Date("2026-07-25T00:00:00Z"));
    const existing = store.create("existing", { kind: "memory_clear" });
    const internal = store as unknown as { nextId: number };
    internal.nextId = Number.MAX_SAFE_INTEGER;

    expect(() => store.create("overflow", { kind: "memory_clear" })).toThrow(
      "Confirmation ID space exhausted",
    );
    expect(store.get(existing.id)).toMatchObject({ id: existing.id, reason: "existing" });
    expect(store.get(Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });
});
