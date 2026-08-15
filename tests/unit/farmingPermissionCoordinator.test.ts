import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionActionQueue } from "../../src/actions/actionQueue.js";
import { FarmingPermissionCoordinator } from "../../src/companion/farmingPermissionCoordinator.js";
import type { TaskLease } from "../../src/safety/taskBudget.js";

const taskLease: TaskLease = { id: "task-permission", startedAt: 1_000 };

function harness() {
  let nextId = 0;
  const actionQueue = new CompanionActionQueue({
    createId: () => `permission-${++nextId}`,
    now: () => new Date("2026-08-15T08:00:00.000Z"),
  });
  const coordinator = new FarmingPermissionCoordinator({
    actionQueue,
    executionContext: () => ({ taskLease, worldGeneration: 4 }),
  });
  return { actionQueue, coordinator };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FarmingPermissionCoordinator", () => {
  it("falls back exactly after 30 seconds and terminates the diagnostic item", async () => {
    vi.useFakeTimers();
    const { actionQueue, coordinator } = harness();
    const result = coordinator.request({
      plotSummary: "靠近水源的一小块安全空地",
      requestedAt: Date.parse("2026-08-15T08:00:00.000Z"),
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(coordinator.isPending()).toBe(true);
    expect(actionQueue.snapshot().items[0]).toMatchObject({
      kind: "wheat_farming_permission",
      status: "waiting_permission",
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe("timeout");
    expect(coordinator.isPending()).toBe(false);
    expect(actionQueue.snapshot().items[0]).toMatchObject({
      status: "cancelled",
      reason: "timeout",
    });
  });

  it("allows only one active request and completes it from one owner decision", async () => {
    vi.useFakeTimers();
    const { actionQueue, coordinator } = harness();
    const first = coordinator.request({ plotSummary: "小麦地候选", requestedAt: 1_000 });

    expect(() => coordinator.request({ plotSummary: "另一个候选", requestedAt: 1_001 })).toThrow(
      "farming permission request is already pending",
    );

    coordinator.resolve("allowed");

    await expect(first).resolves.toBe("allowed");
    expect(actionQueue.snapshot().items[0]).toMatchObject({
      status: "completed",
      reason: "allowed",
    });
    coordinator.resolve("denied");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(actionQueue.snapshot().items).toHaveLength(1);
  });

  it("cancels the active timer when the task stops", async () => {
    vi.useFakeTimers();
    const { actionQueue, coordinator } = harness();
    const result = coordinator.request({ plotSummary: "小麦地候选", requestedAt: 1_000 });

    coordinator.cancel("owner_stop");
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toBe("cancelled");
    expect(actionQueue.snapshot().items[0]).toMatchObject({
      status: "cancelled",
      reason: "owner_stop",
    });
  });

  it("settles the request when its task was already cancelled", async () => {
    const { actionQueue, coordinator } = harness();
    const result = coordinator.request({ plotSummary: "小麦地候选", requestedAt: 1_000 });

    actionQueue.cancelTask(taskLease, "owner_stop");

    expect(() => coordinator.cancel("owner_stop")).not.toThrow();
    await expect(result).resolves.toBe("cancelled");
    expect(coordinator.isPending()).toBe(false);
    expect(actionQueue.snapshot().items[0]).toMatchObject({
      status: "cancelled",
      reason: "owner_stop",
    });
  });
});
