import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionExecutor, type ActionSafety } from "../../src/actions/actionExecutor.js";
import type { GameAction, SafetyDecision } from "../../src/domain/types.js";
import { FakeMinecraftPort } from "../../src/minecraft/fakeMinecraftPort.js";
import { ConfirmationStore } from "../../src/safety/confirmationStore.js";
import { SafetyEngine, type SafetyContext } from "../../src/safety/safetyEngine.js";
import { createActionExecutorHarness } from "../support/actionExecutorHarness.js";

const context: SafetyContext = {
  spawn: { x: 0, y: 64, z: 0 },
  owner: { x: 0, y: 64, z: 0 },
};

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function waitsForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(abortError())));
}

afterEach(() => vi.useRealTimers());

describe("ActionExecutor", () => {
  it("stops a running action locally", async () => {
    const minecraft = new FakeMinecraftPort();
    minecraft.wait = (_milliseconds, signal) => waitsForAbort(signal);
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    const running = executor.execute({ kind: "wait", milliseconds: 60_000 }, context);

    await vi.waitFor(() => expect(executor.pendingCount()).toBe(1));
    executor.stopAll();

    await expect(running).resolves.toEqual({ status: "cancelled" });
    expect(executor.pendingCount()).toBe(0);
  });

  it("cancels all queued actions from the old generation and accepts a new action", async () => {
    const minecraft = new FakeMinecraftPort();
    minecraft.wait = (_milliseconds, signal) => waitsForAbort(signal);
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    const running = executor.execute({ kind: "wait", milliseconds: 60_000 }, context);
    const queued = executor.execute({ kind: "say", message: "old" }, context);

    await vi.waitFor(() => expect(executor.pendingCount()).toBe(2));
    executor.stopAll();

    await expect(Promise.all([running, queued])).resolves.toEqual([
      { status: "cancelled" },
      { status: "cancelled" },
    ]);
    await expect(executor.execute({ kind: "say", message: "new" }, context)).resolves.toEqual({
      status: "completed",
    });
    expect(minecraft.chatLog).toEqual(["new"]);
  });

  it("returns cancellation immediately but holds the port queue until an abort-ignoring action settles", async () => {
    vi.useFakeTimers();
    const minecraft = new FakeMinecraftPort();
    let settlePlace: (() => void) | undefined;
    minecraft.placeBlock = async () =>
      new Promise<void>((resolve) => {
        settlePlace = resolve;
      });
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    const running = executor.execute(
      { kind: "place_block", blockName: "stone", position: { x: 30, y: 64, z: 0 } },
      context,
    );
    const oldQueued = executor.execute({ kind: "say", message: "old" }, context);

    await vi.advanceTimersByTimeAsync(0);
    executor.stopAll();
    await vi.advanceTimersByTimeAsync(0);

    await expect(running).resolves.toEqual({ status: "cancelled" });
    await expect(oldQueued).resolves.toEqual({ status: "cancelled" });
    expect(executor.pendingCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const afterStop = executor.execute({ kind: "say", message: "after stop" }, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(executor.pendingCount()).toBe(1);
    expect(minecraft.chatLog).toEqual([]);

    settlePlace?.();
    await expect(afterStop).resolves.toEqual({ status: "completed" });
    expect(minecraft.chatLog).toEqual(["after stop"]);
  });

  it("reports busy until an abort-ignoring Minecraft operation physically settles", async () => {
    const minecraft = new FakeMinecraftPort();
    let settlePlace: (() => void) | undefined;
    minecraft.placeBlock = async () =>
      new Promise<void>((resolve) => {
        settlePlace = resolve;
      });
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    const running = executor.execute(
      { kind: "place_block", blockName: "stone", position: { x: 30, y: 64, z: 0 } },
      context,
    );
    await vi.waitFor(() => expect(executor.pendingCount()).toBe(1));

    executor.stopAll();
    await expect(running).resolves.toEqual({ status: "cancelled" });
    expect(executor.pendingCount()).toBe(0);
    expect(executor.isBusy()).toBe(true);

    settlePlace?.();
    await expect(executor.execute({ kind: "say", message: "settled" }, context)).resolves.toEqual({
      status: "completed",
    });
    expect(executor.isBusy()).toBe(false);
  });

  it("holds the gate through a late aborted-operation rejection without leaking it", async () => {
    const minecraft = new FakeMinecraftPort();
    let rejectPlace: ((error: Error) => void) | undefined;
    minecraft.placeBlock = async () =>
      new Promise<void>((_resolve, reject) => {
        rejectPlace = reject;
      });
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    const running = executor.execute(
      { kind: "place_block", blockName: "stone", position: { x: 30, y: 64, z: 0 } },
      context,
    );
    await vi.waitFor(() => expect(executor.pendingCount()).toBe(1));
    executor.stopAll();
    await expect(running).resolves.toEqual({ status: "cancelled" });

    const afterStop = executor.execute({ kind: "say", message: "after rejection" }, context);
    await Promise.resolve();
    expect(minecraft.chatLog).toEqual([]);
    rejectPlace?.(new Error("late failure"));

    await expect(afterStop).resolves.toEqual({ status: "completed" });
    expect(minecraft.chatLog).toEqual(["after rejection"]);
  });

  it("does not call Minecraft or create a timer when safety denies", async () => {
    vi.useFakeTimers();
    const minecraft = new FakeMinecraftPort();
    const executor = createActionExecutorHarness(minecraft, { kind: "deny", reason: "forbidden" });

    await expect(
      executor.execute(
        { kind: "place_block", blockName: "tnt", position: { x: 20, y: 64, z: 20 } },
        context,
      ),
    ).resolves.toEqual({ status: "denied", reason: "forbidden" });
    expect(minecraft.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(executor.pendingCount()).toBe(0);
  });

  it("returns confirmation requirements without starting Minecraft", async () => {
    const minecraft = new FakeMinecraftPort();
    const decision: SafetyDecision = {
      kind: "confirm",
      reason: "far away",
      confirmationId: 42,
      expiresAt: "2026-07-25T00:02:00.000Z",
    };
    const executor = createActionExecutorHarness(minecraft, decision);

    await expect(
      executor.execute({ kind: "move_to", position: { x: 300, y: 64, z: 0 } }, context),
    ).resolves.toEqual({
      status: "confirmation_required",
      confirmationId: 42,
      reason: "far away",
    });
    expect(minecraft.calls).toEqual([]);
  });

  it("contains a synchronous safety exception and leaves the gate usable", async () => {
    const minecraft = new FakeMinecraftPort();
    const safety: ActionSafety = {
      evaluate: () => {
        throw new Error("safety failed");
      },
      evaluatePermanent: () => ({ kind: "allow" }),
    };
    const executor = new ActionExecutor(minecraft, safety, new ConfirmationStore(), "TestOwner");
    const failed = executor.execute({ kind: "say", message: "blocked" }, context);
    let result: string | undefined;
    void failed.then((value) => {
      result = value.status;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(result).toBe("failed");
    await expect(failed).resolves.toEqual({ status: "failed", reason: "Error: safety failed" });
    expect(executor.pendingCount()).toBe(0);

    safety.evaluate = () => ({ kind: "allow" });
    await expect(
      executor.execute({ kind: "say", message: "after safety" }, context),
    ).resolves.toEqual({
      status: "completed",
    });
    expect(minecraft.chatLog).toEqual(["after safety"]);
  });

  it("times out movement at 30 seconds and reports failure", async () => {
    vi.useFakeTimers();
    const minecraft = new FakeMinecraftPort();
    minecraft.moveTo = (_position, signal) => waitsForAbort(signal);
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    const result = executor.execute({ kind: "move_to", position: { x: 30, y: 64, z: 0 } }, context);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toEqual({ status: "failed", reason: "action timed out" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out world actions at 15 seconds and caps waits at 11 seconds", async () => {
    vi.useFakeTimers();
    const minecraft = new FakeMinecraftPort();
    minecraft.placeBlock = (_position, _blockName, signal) => waitsForAbort(signal);
    minecraft.wait = (_milliseconds, signal) => waitsForAbort(signal);
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });

    const place = executor.execute(
      { kind: "place_block", blockName: "stone", position: { x: 30, y: 64, z: 0 } },
      context,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(place).resolves.toEqual({ status: "failed", reason: "action timed out" });

    const wait = executor.execute({ kind: "wait", milliseconds: 60_000 }, context);
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(wait).resolves.toEqual({ status: "failed", reason: "action timed out" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps smelting alive past 20 seconds, then times out at its 70-second budget without opening the gate", async () => {
    vi.useFakeTimers();
    const minecraft = new FakeMinecraftPort();
    let settleSmelt: (() => void) | undefined;
    minecraft.smeltItem = async () =>
      new Promise<void>((resolve) => {
        settleSmelt = resolve;
      });
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    const smelting = executor.execute(
      { kind: "smelt_item", itemName: "iron_ore", count: 1 },
      context,
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(executor.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50_000);

    await expect(smelting).resolves.toEqual({ status: "failed", reason: "action timed out" });
    const afterSmelt = executor.execute({ kind: "say", message: "after smelt" }, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(minecraft.chatLog).toEqual([]);
    settleSmelt?.();
    await expect(afterSmelt).resolves.toEqual({ status: "completed" });
  });

  it("treats synchronous and asynchronous AbortError results as cancelled", async () => {
    const minecraft = new FakeMinecraftPort();
    minecraft.moveTo = () => {
      throw abortError();
    };
    minecraft.followOwner = async () => {
      throw abortError();
    };
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });

    await expect(
      executor.execute({ kind: "move_to", position: { x: 30, y: 64, z: 0 } }, context),
    ).resolves.toEqual({
      status: "cancelled",
    });
    await expect(executor.execute({ kind: "follow_owner", distance: 2 }, context)).resolves.toEqual(
      {
        status: "cancelled",
      },
    );
  });

  it("retries only navigation and never retries irreversible actions", async () => {
    const minecraft = new FakeMinecraftPort();
    let moves = 0;
    minecraft.moveTo = async () => {
      moves += 1;
      throw new Error("temporary navigation failure");
    };
    let places = 0;
    minecraft.placeBlock = async () => {
      places += 1;
      throw new Error("placement failure");
    };
    let crafts = 0;
    minecraft.craftItem = async () => {
      crafts += 1;
      throw new Error("craft failure");
    };
    let smelts = 0;
    minecraft.smeltItem = async () => {
      smelts += 1;
      throw new Error("smelt failure");
    };
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });

    await executor.execute({ kind: "move_to", position: { x: 30, y: 64, z: 0 } }, context);
    await executor.execute(
      { kind: "place_block", blockName: "stone", position: { x: 30, y: 64, z: 0 } },
      context,
    );
    await executor.execute({ kind: "craft_item", itemName: "stick", count: 1 }, context);
    await executor.execute({ kind: "smelt_item", itemName: "iron_ingot", count: 1 }, context);

    expect(moves).toBe(2);
    expect(places).toBe(1);
    expect(crafts).toBe(1);
    expect(smelts).toBe(1);
  });

  it("dispatches each action to its narrow Minecraft port method", async () => {
    const minecraft = new FakeMinecraftPort();
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    const actions: GameAction[] = [
      { kind: "say", message: "hello" },
      { kind: "move_to", position: { x: 1, y: 2, z: 3 } },
      { kind: "follow_owner", distance: 4 },
      { kind: "look_at", position: { x: 5, y: 6, z: 7 } },
      { kind: "jump" },
      { kind: "dig_block", position: { x: 8, y: 9, z: 10 }, blockName: "stone" },
      { kind: "place_block", position: { x: 11, y: 12, z: 13 }, blockName: "dirt" },
      { kind: "craft_item", itemName: "stick", count: 2 },
      { kind: "smelt_item", itemName: "iron_ingot", count: 3 },
      { kind: "collect_dropped", entityId: 4 },
      { kind: "equip_item", itemName: "iron_helmet", destination: "head" },
      { kind: "attack_hostile", entityId: 5 },
      { kind: "wait", milliseconds: 6 },
    ];

    for (const action of actions)
      await expect(executor.execute(action, context)).resolves.toEqual({ status: "completed" });

    expect(minecraft.chatLog).toEqual(["hello"]);
    expect(minecraft.calls).toEqual([
      { method: "moveTo", args: [{ x: 1, y: 2, z: 3 }] },
      { method: "followOwner", args: ["TestOwner", 4] },
      { method: "lookAt", args: [{ x: 5, y: 6, z: 7 }] },
      { method: "jump", args: [] },
      { method: "digBlock", args: [{ x: 8, y: 9, z: 10 }, "stone"] },
      { method: "placeBlock", args: [{ x: 11, y: 12, z: 13 }, "dirt"] },
      { method: "craftItem", args: ["stick", 2] },
      { method: "smeltItem", args: ["iron_ingot", 3] },
      { method: "collectDropped", args: [4] },
      { method: "equipItem", args: ["iron_helmet", "head"] },
      { method: "attackHostile", args: [5] },
      { method: "wait", args: [6] },
    ]);
  });

  it("executes only the stored confirmed action once and cannot be substituted or replayed", async () => {
    const minecraft = new FakeMinecraftPort();
    const confirmations = new ConfirmationStore();
    const executor = new ActionExecutor(
      minecraft,
      new SafetyEngine(confirmations),
      confirmations,
      "TestOwner",
    );
    const decision = new SafetyEngine(confirmations).evaluate(
      { kind: "move_to", position: { x: 300, y: 64, z: 0 } },
      context,
    );
    if (decision.kind !== "confirm") throw new Error("expected travel confirmation");

    const result = await Reflect.apply(executor.executeConfirmed, executor, [
      decision.confirmationId,
      context,
      { kind: "place_block", blockName: "tnt", position: { x: 30, y: 64, z: 0 } },
    ]);

    expect(result).toEqual({ status: "completed" });
    expect(minecraft.calls).toEqual([{ method: "moveTo", args: [{ x: 300, y: 64, z: 0 }] }]);
    await expect(executor.executeConfirmed(decision.confirmationId, context)).resolves.toEqual({
      status: "confirmation_invalid",
      reason: "missing",
    });
  });

  it("reports expired confirmed IDs without calling Minecraft", async () => {
    let now = new Date("2026-07-25T00:00:00Z");
    const minecraft = new FakeMinecraftPort();
    const confirmations = new ConfirmationStore(() => now);
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" }, confirmations);
    const ticket = confirmations.create("wait", {
      kind: "game_action",
      action: { kind: "wait", milliseconds: 1 },
    });
    now = new Date("2026-07-25T00:02:00Z");

    await expect(executor.executeConfirmed(ticket.id, context)).resolves.toEqual({
      status: "confirmation_invalid",
      reason: "expired",
    });
    expect(minecraft.calls).toEqual([]);
  });

  it("contains permanent safety exceptions after consuming a confirmation", async () => {
    const minecraft = new FakeMinecraftPort();
    const confirmations = new ConfirmationStore();
    const safety: ActionSafety = {
      evaluate: () => ({ kind: "allow" }),
      evaluatePermanent: () => {
        throw new Error("permanent safety failed");
      },
    };
    const executor = new ActionExecutor(minecraft, safety, confirmations, "TestOwner");
    const ticket = confirmations.create("confirmed", {
      kind: "game_action",
      action: { kind: "say", message: "stored" },
    });
    const failed = executor.executeConfirmed(ticket.id, context);
    let result: string | undefined;
    void failed.then((value) => {
      result = value.status;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(result).toBe("failed");
    await expect(failed).resolves.toEqual({
      status: "failed",
      reason: "Error: permanent safety failed",
    });
    await expect(executor.executeConfirmed(ticket.id, context)).resolves.toEqual({
      status: "confirmation_invalid",
      reason: "missing",
    });
    expect(minecraft.calls).toEqual([]);
    expect(executor.pendingCount()).toBe(0);
  });

  it("converts confirmation-store exceptions into failed action results", async () => {
    const minecraft = new FakeMinecraftPort();
    const confirmations = new ConfirmationStore();
    vi.spyOn(confirmations, "allowGameAction").mockImplementation(() => {
      throw new Error("confirmation storage failed");
    });
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" }, confirmations);

    expect(() => executor.executeConfirmed(1, context)).not.toThrow();
    await expect(executor.executeConfirmed(1, context)).resolves.toEqual({
      status: "failed",
      reason: "Error: confirmation storage failed",
    });
    expect(executor.pendingCount()).toBe(0);
    expect(minecraft.calls).toEqual([]);
  });

  it("keeps non-game confirmations pending and rechecks permanent safety before execution", async () => {
    const minecraft = new FakeMinecraftPort();
    const confirmations = new ConfirmationStore();
    const executor = new ActionExecutor(
      minecraft,
      new SafetyEngine(confirmations),
      confirmations,
      "TestOwner",
    );
    const memory = confirmations.create("clear", { kind: "memory_clear" });
    const tnt = confirmations.create("seeded", {
      kind: "game_action",
      action: { kind: "place_block", blockName: "tnt", position: { x: 30, y: 64, z: 0 } },
    });
    const spawn = confirmations.create("seeded", {
      kind: "game_action",
      action: { kind: "dig_block", blockName: "stone", position: { x: 1, y: 64, z: 1 } },
    });
    const protectedTarget = confirmations.create("seeded", {
      kind: "game_action",
      action: { kind: "attack_hostile", entityId: 9 },
    });

    await expect(executor.executeConfirmed(memory.id, context)).resolves.toEqual({
      status: "confirmation_invalid",
      reason: "wrong_operation",
    });
    expect(confirmations.allow(memory.id)).toEqual({
      ok: true,
      operation: { kind: "memory_clear" },
    });
    await expect(executor.executeConfirmed(tnt.id, context)).resolves.toEqual({
      status: "denied",
      reason: "TNT is permanently forbidden",
    });
    await expect(executor.executeConfirmed(spawn.id, context)).resolves.toEqual({
      status: "denied",
      reason: "Spawn protection radius is 16 blocks",
    });
    await expect(
      executor.executeConfirmed(protectedTarget.id, { ...context, protectedTarget: "villager" }),
    ).resolves.toEqual({
      status: "denied",
      reason: "Attacking a villager is permanently forbidden",
    });
    expect(minecraft.calls).toEqual([]);
  });

  it("publishes each real failed action once without listener errors changing the result", async () => {
    const minecraft = new FakeMinecraftPort();
    minecraft.moveTo = async () => {
      throw new Error("path blocked");
    };
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    const failures: string[] = [];
    const unsubscribeThrowing = executor.onResult(() => {
      throw new Error("observer failed");
    });
    const unsubscribeRecording = executor.onResult((result) => {
      if (result.status === "failed") failures.push(result.reason);
    });

    await expect(
      executor.execute({ kind: "move_to", position: { x: 30, y: 64, z: 0 } }, context),
    ).resolves.toEqual({ status: "failed", reason: "Error: path blocked" });
    expect(failures).toEqual(["Error: path blocked"]);

    unsubscribeThrowing();
    unsubscribeRecording();
    await executor.execute({ kind: "move_to", position: { x: 31, y: 64, z: 0 } }, context);
    expect(failures).toEqual(["Error: path blocked"]);
  });

  it("publishes frozen defensive result copies that observers cannot mutate", async () => {
    const minecraft = new FakeMinecraftPort();
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    let firstView: Readonly<{ status: string }> | undefined;
    let laterView: Readonly<{ status: string }> | undefined;
    executor.onResult((result) => {
      firstView = result;
      (result as { status: string }).status = "failed";
    });
    executor.onResult((result) => {
      laterView = result;
    });

    const callerResult = await executor.execute({ kind: "say", message: "safe" }, context);

    expect(callerResult).toEqual({ status: "completed" });
    expect(laterView).toEqual({ status: "completed" });
    expect(Object.isFrozen(firstView)).toBe(true);
    expect(Object.isFrozen(laterView)).toBe(true);
    expect(firstView).not.toBe(laterView);
    expect(laterView).not.toBe(callerResult);
  });
});
