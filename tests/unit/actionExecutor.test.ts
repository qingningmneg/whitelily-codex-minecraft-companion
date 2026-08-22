import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionExecutor, type ActionSafety } from "../../src/actions/actionExecutor.js";
import type { GameAction, SafetyDecision } from "../../src/domain/types.js";
import { FakeMinecraftPort } from "../../src/minecraft/fakeMinecraftPort.js";
import type {
  BlockSearchResult,
  FoodDelta,
  FurnaceSnapshot,
  InspectedBlock,
  InventoryDelta,
} from "../../src/minecraft/minecraftPort.js";
import { ConfirmationStore } from "../../src/safety/confirmationStore.js";
import { SafetyEngine, type SafetyContext } from "../../src/safety/safetyEngine.js";
import type { TaskLease } from "../../src/safety/taskBudget.js";
import { createActionExecutorHarness } from "../support/actionExecutorHarness.js";

const context: SafetyContext = {
  spawn: { x: 0, y: 64, z: 0 },
  owner: { x: 0, y: 64, z: 0 },
};
const taskLease: TaskLease = { id: "task-lease-a", startedAt: 1_000 };

function confirmedExecutor(
  minecraft: FakeMinecraftPort,
  safety: ActionSafety,
  confirmations: ConfirmationStore,
): ActionExecutor {
  return new ActionExecutor(minecraft, safety, confirmations, () => "TestOwner", undefined, {
    isLeaseLive: (lease) => lease.id === taskLease.id && lease.startedAt === taskLease.startedAt,
    reserveAdditionalTravel: () => {
      throw new Error("no additional travel expected");
    },
  });
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function waitsForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(abortError())));
}

const livingActions = [
  {
    label: "fish",
    action: { kind: "fish" } as const,
    timeout: 60_000,
    install: (minecraft: FakeMinecraftPort) => {
      minecraft.fish = async (signal) => {
        await waitsForAbort(signal);
        return { added: [], removed: [] };
      };
    },
  },
  {
    label: "consume_item",
    action: { kind: "consume_item", itemName: "bread" } as const,
    timeout: 10_000,
    install: (minecraft: FakeMinecraftPort) => {
      minecraft.consumeItem = async (_itemName, signal) => {
        await waitsForAbort(signal);
        return { healthBefore: 20, healthAfter: 20, foodBefore: 10, foodAfter: 15 };
      };
    },
  },
  {
    label: "sleep_in_bed",
    action: { kind: "sleep_in_bed", position: { x: 1, y: 64, z: 1 } } as const,
    timeout: 20_000,
    install: (minecraft: FakeMinecraftPort) => {
      minecraft.sleepInBed = (_position, signal) => waitsForAbort(signal);
    },
  },
  {
    label: "wake_up",
    action: { kind: "wake_up" } as const,
    timeout: 10_000,
    install: (minecraft: FakeMinecraftPort) => {
      minecraft.wakeUp = (signal) => waitsForAbort(signal);
    },
  },
  {
    label: "till_soil",
    action: { kind: "till_soil", position: { x: 2, y: 64, z: 2 } } as const,
    timeout: 15_000,
    install: (minecraft: FakeMinecraftPort) => {
      minecraft.tillSoil = (_position, signal) => waitsForAbort(signal);
    },
  },
  {
    label: "plant_crop",
    action: {
      kind: "plant_crop",
      position: { x: 2, y: 64, z: 2 },
      seedName: "wheat_seeds",
    } as const,
    timeout: 15_000,
    install: (minecraft: FakeMinecraftPort) => {
      minecraft.plantCrop = (_position, _seedName, signal) => waitsForAbort(signal);
    },
  },
  {
    label: "harvest_crop",
    action: {
      kind: "harvest_crop",
      position: { x: 3, y: 64, z: 3 },
      cropName: "wheat",
    } as const,
    timeout: 15_000,
    install: (minecraft: FakeMinecraftPort) => {
      minecraft.harvestCrop = (_position, _cropName, signal) => waitsForAbort(signal);
    },
  },
] satisfies readonly {
  label: string;
  action: GameAction;
  timeout: number;
  install(minecraft: FakeMinecraftPort): void;
}[];

afterEach(() => vi.useRealTimers());

describe("ActionExecutor", () => {
  it("reads the current owner when follow work reaches Minecraft", async () => {
    const minecraft = new FakeMinecraftPort();
    let owner = "OldOwner";
    const confirmations = new ConfirmationStore();
    const executor = new ActionExecutor(
      minecraft,
      new SafetyEngine(confirmations),
      confirmations,
      () => owner,
    );
    owner = "NewOwner";

    await expect(executor.execute({ kind: "follow_owner", distance: 4 }, context)).resolves.toEqual(
      { status: "completed" },
    );
    expect(minecraft.calls).toContainEqual({
      method: "followOwner",
      args: ["NewOwner", 4],
    });
  });

  it("invalidates task work synchronously before cancellation aborts the action", async () => {
    const minecraft = new FakeMinecraftPort();
    const order: string[] = [];
    let waitStarted = false;
    minecraft.wait = (_milliseconds, signal) => {
      waitStarted = true;
      signal.addEventListener("abort", () => order.push("action_aborted"), { once: true });
      return waitsForAbort(signal);
    };
    const confirmations = new ConfirmationStore();
    const executor = new ActionExecutor(
      minecraft,
      new SafetyEngine(confirmations),
      confirmations,
      () => "TestOwner",
      () => order.push("task_invalidated"),
    );
    const running = executor.execute({ kind: "wait", milliseconds: 60_000 }, context);
    await vi.waitFor(() => expect(waitStarted).toBe(true));

    executor.stopAll();

    expect(order).toEqual(["task_invalidated", "action_aborted"]);
    await expect(running).resolves.toEqual({ status: "cancelled" });
  });

  it("can abort physical work while preserving the active task authority", async () => {
    const minecraft = new FakeMinecraftPort();
    const order: string[] = [];
    let waitStarted = false;
    minecraft.wait = (_milliseconds, signal) => {
      waitStarted = true;
      signal.addEventListener("abort", () => order.push("action_aborted"), { once: true });
      return waitsForAbort(signal);
    };
    const confirmations = new ConfirmationStore();
    const executor = new ActionExecutor(
      minecraft,
      new SafetyEngine(confirmations),
      confirmations,
      () => "TestOwner",
      () => order.push("task_invalidated"),
    );
    const running = executor.execute({ kind: "wait", milliseconds: 60_000 }, context);
    await vi.waitFor(() => expect(waitStarted).toBe(true));

    executor.stopAll({ preserveTask: true });

    expect(order).toEqual(["action_aborted"]);
    await expect(running).resolves.toEqual({ status: "cancelled" });
  });

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

  it("waits for active port cancellation before publishing one cancelled result", async () => {
    const minecraft = new FakeMinecraftPort();
    let settleDig: (() => void) | undefined;
    minecraft.digBlock = async () =>
      new Promise<void>((resolve) => {
        settleDig = resolve;
      });
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    const published: string[] = [];
    executor.onResult((result) => published.push(result.status));
    const running = executor.execute(
      { kind: "dig_block", blockName: "stone", position: { x: 1, y: 64, z: 1 } },
      context,
    );
    await vi.waitFor(() => expect(settleDig).toBeTypeOf("function"));
    let outcome = "pending";
    void running.then((result) => {
      outcome = result.status;
    });

    executor.stopAll();
    await Promise.resolve();

    expect(outcome).toBe("pending");
    expect(published).toEqual([]);
    settleDig?.();
    await expect(running).resolves.toEqual({ status: "cancelled" });
    expect(published).toEqual(["cancelled"]);
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

  it("holds cancellation and the port queue until an abort-ignoring action settles", async () => {
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

    await expect(oldQueued).resolves.toEqual({ status: "cancelled" });
    let runningOutcome = "pending";
    void running.then((result) => {
      runningOutcome = result.status;
    });
    expect(runningOutcome).toBe("pending");
    expect(executor.pendingCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    const afterStop = executor.execute({ kind: "say", message: "after stop" }, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(executor.pendingCount()).toBe(2);
    expect(minecraft.chatLog).toEqual([]);

    settlePlace?.();
    await expect(running).resolves.toEqual({ status: "cancelled" });
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
    expect(executor.pendingCount()).toBe(1);
    expect(executor.isBusy()).toBe(true);

    settlePlace?.();
    await expect(running).resolves.toEqual({ status: "cancelled" });
    expect(executor.pendingCount()).toBe(0);
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

    const afterStop = executor.execute({ kind: "say", message: "after rejection" }, context);
    await Promise.resolve();
    expect(minecraft.chatLog).toEqual([]);
    rejectPlace?.(new Error("late failure"));

    await expect(running).resolves.toEqual({ status: "cancelled" });
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
    const executor = new ActionExecutor(
      minecraft,
      safety,
      new ConfirmationStore(),
      () => "TestOwner",
    );
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

  it.each(livingActions)("times out $label with conservative mutation evidence", async (entry) => {
    vi.useFakeTimers();
    const minecraft = new FakeMinecraftPort();
    entry.install(minecraft);
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    const result = executor.execute(entry.action, {
      ...context,
      wheatFarmingAllowed: true,
    });

    await vi.advanceTimersByTimeAsync(entry.timeout);

    await expect(result).resolves.toEqual({
      status: "failed",
      reason: "action timed out",
      worldMutated: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(livingActions)("cancels $label when the owner preempts the queue", async (entry) => {
    const minecraft = new FakeMinecraftPort();
    entry.install(minecraft);
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });
    const result = executor.execute(entry.action, {
      ...context,
      wheatFarmingAllowed: true,
    });
    await vi.waitFor(() => expect(executor.pendingCount()).toBe(1));

    executor.stopAll({ preserveTask: true });

    await expect(result).resolves.toEqual({ status: "cancelled" });
  });

  it("defaults living failures to mutated and accepts only explicit adapter no-mutation evidence", async () => {
    const minecraft = new FakeMinecraftPort();
    const unchanged = Object.assign(new Error("cast was never sent"), { worldMutated: false });
    minecraft.fish = async () => {
      throw unchanged;
    };
    minecraft.consumeItem = async () => {
      throw new Error("consume status is unknown");
    };
    const executor = createActionExecutorHarness(minecraft, { kind: "allow" });

    await expect(executor.execute({ kind: "fish" }, context)).resolves.toEqual({
      status: "failed",
      reason: "Error: cast was never sent",
      worldMutated: false,
    });
    await expect(
      executor.execute({ kind: "consume_item", itemName: "bread" }, context),
    ).resolves.toEqual({
      status: "failed",
      reason: "Error: consume status is unknown",
      worldMutated: true,
    });
  });

  it("does not publish a smelt timeout until physical cancellation settles", async () => {
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
    let smeltOutcome = "pending";
    void smelting.then((result) => {
      smeltOutcome = result.status;
    });
    await vi.advanceTimersByTimeAsync(50_000);

    expect(smeltOutcome).toBe("pending");
    expect(executor.pendingCount()).toBe(1);
    const afterSmelt = executor.execute({ kind: "say", message: "after smelt" }, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(minecraft.chatLog).toEqual([]);
    settleSmelt?.();
    await expect(smelting).resolves.toEqual({ status: "failed", reason: "action timed out" });
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

  it("never retries actions inside ActionExecutor", async () => {
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

    expect(moves).toBe(1);
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
      { kind: "fish" },
      { kind: "consume_item", itemName: "bread" },
      { kind: "sleep_in_bed", position: { x: 14, y: 15, z: 16 } },
      { kind: "wake_up" },
      { kind: "till_soil", position: { x: 17, y: 18, z: 19 } },
      {
        kind: "plant_crop",
        position: { x: 20, y: 21, z: 22 },
        seedName: "wheat_seeds",
      },
      { kind: "harvest_crop", position: { x: 23, y: 24, z: 25 }, cropName: "wheat" },
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
      { method: "fish", args: [] },
      { method: "consumeItem", args: ["bread"] },
      { method: "sleepInBed", args: [{ x: 14, y: 15, z: 16 }] },
      { method: "wakeUp", args: [] },
      { method: "tillSoil", args: [{ x: 17, y: 18, z: 19 }] },
      { method: "plantCrop", args: [{ x: 20, y: 21, z: 22 }, "wheat_seeds"] },
      { method: "harvestCrop", args: [{ x: 23, y: 24, z: 25 }, "wheat"] },
    ]);
  });

  it("executes only the stored confirmed action once and cannot be substituted or replayed", async () => {
    const minecraft = new FakeMinecraftPort();
    const confirmations = new ConfirmationStore();
    const safety = new SafetyEngine(confirmations, undefined, () => true);
    const executor = confirmedExecutor(minecraft, safety, confirmations);
    const decision = safety.evaluate(
      { kind: "move_to", position: { x: 300, y: 64, z: 0 } },
      { ...context, taskLease, reservedHorizontalTravel: 300 },
    );
    if (decision.kind !== "confirm") throw new Error("expected travel confirmation");

    const result = await executor.executeConfirmed(decision.confirmationId, context, taskLease);

    expect(result).toEqual({ status: "completed" });
    expect(minecraft.calls).toEqual([{ method: "moveTo", args: [{ x: 300, y: 64, z: 0 }] }]);
    await expect(
      executor.executeConfirmed(decision.confirmationId, context, taskLease),
    ).resolves.toEqual({
      status: "confirmation_invalid",
      reason: "missing",
    });
  });

  it("does not consume another task's confirmation and executes it once for the live owner task", async () => {
    const minecraft = new FakeMinecraftPort();
    const confirmations = new ConfirmationStore();
    const executor = new ActionExecutor(
      minecraft,
      {
        evaluate: () => ({ kind: "allow" }),
        evaluatePermanent: () => ({ kind: "allow" }),
      },
      confirmations,
      () => "TestOwner",
      undefined,
      {
        isLeaseLive: (lease) =>
          lease.id === taskLease.id && lease.startedAt === taskLease.startedAt,
        reserveAdditionalTravel: () => {
          throw new Error("no additional travel expected");
        },
      },
    );
    const ticket = confirmations.createGameAction(
      "stored",
      { kind: "say", message: "confirmed" },
      taskLease,
    );
    const otherLease = { id: "task-lease-b", startedAt: taskLease.startedAt };

    await expect(executor.executeConfirmed(ticket.id, context, otherLease)).resolves.toEqual({
      status: "confirmation_invalid",
      reason: "wrong_task",
    });
    expect(confirmations.hasGameActions(taskLease)).toBe(true);
    expect(minecraft.chatLog).toEqual([]);

    await expect(executor.executeConfirmed(ticket.id, context, taskLease)).resolves.toEqual({
      status: "completed",
    });
    await expect(executor.executeConfirmed(ticket.id, context, taskLease)).resolves.toEqual({
      status: "confirmation_invalid",
      reason: "missing",
    });
    expect(minecraft.chatLog).toEqual(["confirmed"]);
  });

  it("does not dispatch a consumed confirmation after its task capability becomes stale", async () => {
    const minecraft = new FakeMinecraftPort();
    const confirmations = new ConfirmationStore();
    let live = true;
    const executor = new ActionExecutor(
      minecraft,
      {
        evaluate: () => ({ kind: "allow" }),
        evaluatePermanent: () => ({ kind: "allow" }),
      },
      confirmations,
      () => "TestOwner",
      undefined,
      {
        isLeaseLive: () => live,
        reserveAdditionalTravel: () => {
          throw new Error("no additional travel expected");
        },
      },
    );
    const ticket = confirmations.createGameAction(
      "stored",
      { kind: "say", message: "must not dispatch" },
      taskLease,
    );

    const pending = executor.executeConfirmed(ticket.id, context, taskLease);
    live = false;

    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(minecraft.chatLog).toEqual([]);
  });

  it("reports expired confirmed IDs without calling Minecraft", async () => {
    let now = new Date("2026-07-25T00:00:00Z");
    const minecraft = new FakeMinecraftPort();
    const confirmations = new ConfirmationStore(() => now);
    const safety: ActionSafety = {
      evaluate: () => ({ kind: "allow" }),
      evaluatePermanent: () => ({ kind: "allow" }),
    };
    const executor = confirmedExecutor(minecraft, safety, confirmations);
    const ticket = confirmations.createGameAction(
      "wait",
      { kind: "wait", milliseconds: 1 },
      taskLease,
    );
    now = new Date("2026-07-25T00:02:00Z");

    await expect(executor.executeConfirmed(ticket.id, context, taskLease)).resolves.toEqual({
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
    const executor = confirmedExecutor(minecraft, safety, confirmations);
    const ticket = confirmations.createGameAction(
      "confirmed",
      { kind: "say", message: "stored" },
      taskLease,
    );
    const failed = executor.executeConfirmed(ticket.id, context, taskLease);
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
    await expect(executor.executeConfirmed(ticket.id, context, taskLease)).resolves.toEqual({
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
    const executor = confirmedExecutor(
      minecraft,
      {
        evaluate: () => ({ kind: "allow" }),
        evaluatePermanent: () => ({ kind: "allow" }),
      },
      confirmations,
    );

    expect(() => executor.executeConfirmed(1, context, taskLease)).not.toThrow();
    await expect(executor.executeConfirmed(1, context, taskLease)).resolves.toEqual({
      status: "failed",
      reason: "Error: confirmation storage failed",
    });
    expect(executor.pendingCount()).toBe(0);
    expect(minecraft.calls).toEqual([]);
  });

  it("keeps non-game confirmations pending and rechecks permanent safety before execution", async () => {
    const minecraft = new FakeMinecraftPort();
    const confirmations = new ConfirmationStore();
    const executor = confirmedExecutor(minecraft, new SafetyEngine(confirmations), confirmations);
    const memory = confirmations.create("clear", { kind: "memory_clear" });
    const tnt = confirmations.createGameAction(
      "seeded",
      { kind: "place_block", blockName: "tnt", position: { x: 30, y: 64, z: 0 } },
      taskLease,
    );
    const spawn = confirmations.createGameAction(
      "seeded",
      { kind: "dig_block", blockName: "stone", position: { x: 1, y: 64, z: 1 } },
      taskLease,
    );
    const protectedTarget = confirmations.createGameAction(
      "seeded",
      { kind: "attack_hostile", entityId: 9 },
      taskLease,
    );

    await expect(executor.executeConfirmed(memory.id, context, taskLease)).resolves.toEqual({
      status: "confirmation_invalid",
      reason: "wrong_operation",
    });
    expect(confirmations.allow(memory.id)).toEqual({
      ok: true,
      operation: { kind: "memory_clear" },
    });
    await expect(executor.executeConfirmed(tnt.id, context, taskLease)).resolves.toEqual({
      status: "denied",
      reason: "TNT is permanently forbidden",
    });
    await expect(executor.executeConfirmed(spawn.id, context, taskLease)).resolves.toEqual({
      status: "denied",
      reason: "Spawn protection radius is 16 blocks",
    });
    await expect(
      executor.executeConfirmed(
        protectedTarget.id,
        { ...context, protectedTarget: "villager" },
        taskLease,
      ),
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

  it("does not expose mutable fake-port read model state", async () => {
    const minecraft = new FakeMinecraftPort();
    const inspected: InspectedBlock = {
      name: "wheat",
      position: { x: 1, y: 64, z: 2 },
      properties: { age: 7 },
    };
    const furnace: FurnaceSnapshot = {
      position: { x: 3, y: 64, z: 4 },
      input: { name: "raw_cod", count: 1 },
      fuel: { name: "coal", count: 1 },
      output: null,
      progress: 0.5,
    };
    minecraft.inspectBlockResult = inspected;
    minecraft.findBlocksResult = { blocks: [inspected], truncated: false };
    minecraft.furnaceSnapshotResult = furnace;

    const firstBlock = await minecraft.inspectBlock(inspected.position);
    const firstSearch = await minecraft.findBlocks({
      names: ["wheat"],
      maxDistance: 16,
      maxResults: 8,
    });
    const firstFurnace = await minecraft.furnaceSnapshot(furnace.position);
    (firstBlock as { position: { x: number } }).position.x = 99;
    (firstSearch as unknown as { blocks: Array<{ name: string }> }).blocks[0]!.name = "stone";
    (firstFurnace as { progress: number }).progress = 1;

    expect(await minecraft.inspectBlock(inspected.position)).toEqual(inspected);
    expect(
      await minecraft.findBlocks({ names: ["wheat"], maxDistance: 16, maxResults: 8 }),
    ).toEqual({ blocks: [inspected], truncated: false } satisfies BlockSearchResult);
    expect(await minecraft.furnaceSnapshot(furnace.position)).toEqual(furnace);
  });

  it("does not expose mutable fake-port living action deltas", async () => {
    const minecraft = new FakeMinecraftPort();
    const fishResult: InventoryDelta = {
      added: [{ name: "cod", count: 1 }],
      removed: [],
    };
    const consumeResult: FoodDelta = {
      healthBefore: 18,
      healthAfter: 18,
      foodBefore: 12,
      foodAfter: 17,
    };
    minecraft.fishResult = fishResult;
    minecraft.consumeItemResult = consumeResult;
    const signal = new AbortController().signal;

    const firstFish = await minecraft.fish(signal);
    const firstConsume = await minecraft.consumeItem("bread", signal);
    (firstFish as unknown as { added: Array<{ count: number }> }).added[0]!.count = 99;
    (firstConsume as { foodAfter: number }).foodAfter = 0;

    expect(await minecraft.fish(signal)).toEqual(fishResult);
    expect(await minecraft.consumeItem("bread", signal)).toEqual(consumeResult);
  });
});
