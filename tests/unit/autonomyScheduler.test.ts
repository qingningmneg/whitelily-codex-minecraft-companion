import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutonomyReason } from "../../src/autonomy/autonomyScheduler.js";
import { createAutonomySchedulerHarness } from "../support/autonomySchedulerHarness.js";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface DeferredValue<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferredValue<T>(): DeferredValue<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("AutonomyScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never performs idle planning in friend mode across ten minutes", async () => {
    const value = createAutonomySchedulerHarness({ mode: "friend" });

    value.scheduler.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(value.reasons).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["balanced", 120_000, "balanced_idle"],
    ["autonomous", 45_000, "autonomous_idle"],
  ] as const)("fires %s idle planning exactly at %d ms", async (mode, interval, reason) => {
    const value = createAutonomySchedulerHarness({ mode });
    value.scheduler.start();

    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(value.reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(value.reasons).toEqual([reason]);
  });

  it.each([
    ["owner offline", { ownerOnline: false }],
    ["paused", { paused: true }],
    ["Codex or action busy", { busy: true }],
  ] as const)("does not request a turn while %s", async (_label, options) => {
    const value = createAutonomySchedulerHarness({ mode: "autonomous", ...options });
    value.scheduler.start();

    await vi.advanceTimersByTimeAsync(45_000);

    expect(value.reasons).toEqual([]);
  });

  it("retries a busy pending event after exactly one second without losing its reason", async () => {
    const value = createAutonomySchedulerHarness({ mode: "autonomous", busy: true });
    value.scheduler.start();
    value.scheduler.notifyThreat();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.reasons).toEqual([]);

    value.setBusy(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(value.reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(value.reasons).toEqual(["nearby_threat"]);
  });

  it("clears offline pending work and returns to the normal idle interval", async () => {
    const value = createAutonomySchedulerHarness({ mode: "autonomous", ownerOnline: false });
    value.scheduler.start();
    value.scheduler.notifyActionFailed();
    await vi.advanceTimersByTimeAsync(0);

    value.setOwnerOnline(true);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(value.reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(value.reasons).toEqual(["autonomous_idle"]);
  });

  it.each([
    [
      "goal",
      "goal_completed",
      (value: ReturnType<typeof createAutonomySchedulerHarness>) =>
        value.scheduler.notifyGoalCompleted(),
    ],
    [
      "action",
      "action_failed",
      (value: ReturnType<typeof createAutonomySchedulerHarness>) =>
        value.scheduler.notifyActionFailed(),
    ],
    [
      "threat",
      "nearby_threat",
      (value: ReturnType<typeof createAutonomySchedulerHarness>) => value.scheduler.notifyThreat(),
    ],
  ] as const)(
    "an immediate %s event cancels the idle timer and drains now",
    async (_label, reason, notify) => {
      const value = createAutonomySchedulerHarness({ mode: "autonomous" });
      value.scheduler.start();
      await vi.advanceTimersByTimeAsync(1_000);

      notify(value);
      await vi.advanceTimersByTimeAsync(0);

      expect(value.reasons).toEqual([reason]);
      expect(vi.getTimerCount()).toBe(1);
    },
  );

  it("coalesces pending events and never overlaps requests", async () => {
    const first = deferred();
    const second = deferred();
    const calls: AutonomyReason[] = [];
    let active = 0;
    let maximumActive = 0;
    const value = createAutonomySchedulerHarness({
      mode: "autonomous",
      requestTurn: async (reason) => {
        calls.push(reason);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await (calls.length === 1 ? first.promise : second.promise);
        active -= 1;
      },
    });
    value.scheduler.start();
    value.scheduler.notifyThreat();
    await vi.advanceTimersByTimeAsync(0);

    value.scheduler.notifyActionFailed();
    value.scheduler.notifyGoalCompleted();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["nearby_threat"]);

    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["nearby_threat", "action_failed"]);
    second.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(maximumActive).toBe(1);
  });

  it("mode changes replace the previous idle interval without resuming a pause", async () => {
    const value = createAutonomySchedulerHarness({ mode: "balanced", paused: true });
    value.scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    value.mode.setMode("autonomous");
    value.scheduler.notifyModeChanged();

    expect(value.mode.snapshot().paused).toBe(true);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(value.reasons).toEqual([]);
    value.mode.resume();
    await vi.advanceTimersByTimeAsync(1);

    expect(value.reasons).toEqual(["autonomous_idle"]);
  });

  it("switching to friend clears a busy pending event instead of replaying it later", async () => {
    const value = createAutonomySchedulerHarness({ mode: "autonomous", busy: true });
    value.scheduler.start();
    value.scheduler.notifyThreat();
    await vi.advanceTimersByTimeAsync(0);

    value.mode.setMode("friend");
    value.scheduler.notifyModeChanged();
    value.setBusy(false);
    value.mode.setMode("balanced");
    value.scheduler.notifyModeChanged();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(value.reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(value.reasons).toEqual(["balanced_idle"]);
  });

  it("invalidates autonomous idle work awaiting owner presence when mode changes to balanced", async () => {
    const online = deferredValue<boolean>();
    const value = createAutonomySchedulerHarness({
      mode: "autonomous",
      isOwnerOnline: () => online.promise,
    });
    value.scheduler.start();
    await vi.advanceTimersByTimeAsync(45_000);

    value.mode.setMode("balanced");
    value.scheduler.notifyModeChanged();
    online.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(value.reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(value.reasons).toEqual(["balanced_idle"]);
  });

  it("suppresses a pending threat when paused during the owner-presence check", async () => {
    const online = deferredValue<boolean>();
    const value = createAutonomySchedulerHarness({
      mode: "autonomous",
      isOwnerOnline: () => online.promise,
    });
    value.scheduler.start();
    value.scheduler.notifyThreat();
    await vi.advanceTimersByTimeAsync(0);

    value.mode.pause();
    online.resolve(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(value.reasons).toEqual([]);
  });

  it("never dispatches a null reason when friend mode clears work awaiting owner presence", async () => {
    const online = deferredValue<boolean>();
    const calls: unknown[] = [];
    const value = createAutonomySchedulerHarness({
      mode: "autonomous",
      isOwnerOnline: () => online.promise,
      requestTurn: async (reason) => {
        calls.push(reason);
      },
    });
    value.scheduler.start();
    value.scheduler.notifyThreat();
    await vi.advanceTimersByTimeAsync(0);

    value.mode.setMode("friend");
    value.scheduler.notifyModeChanged();
    online.resolve(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([]);
  });

  it("a stale pending online check cannot wedge immediate work after restart", async () => {
    const oldOnline = deferredValue<boolean>();
    let checks = 0;
    const value = createAutonomySchedulerHarness({
      mode: "autonomous",
      isOwnerOnline: () => {
        checks += 1;
        return checks === 1 ? oldOnline.promise : Promise.resolve(true);
      },
    });
    value.scheduler.start();
    value.scheduler.notifyThreat();
    await vi.advanceTimersByTimeAsync(0);

    value.scheduler.stop();
    value.scheduler.start();
    value.scheduler.notifyActionFailed();
    await vi.advanceTimersByTimeAsync(0);

    expect(value.reasons).toEqual(["action_failed"]);
  });

  it("a stale pending request turn cannot wedge immediate work after restart", async () => {
    const oldTurn = deferred();
    const calls: AutonomyReason[] = [];
    const value = createAutonomySchedulerHarness({
      mode: "autonomous",
      requestTurn: async (reason) => {
        calls.push(reason);
        if (calls.length === 1) await oldTurn.promise;
      },
    });
    value.scheduler.start();
    value.scheduler.notifyThreat();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["nearby_threat"]);

    value.scheduler.stop();
    value.scheduler.start();
    value.scheduler.notifyGoalCompleted();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual(["nearby_threat", "goal_completed"]);
  });

  it("enforces proactive chat cooldown boundaries in every mode", () => {
    const friend = createAutonomySchedulerHarness({ mode: "friend" });
    const balanced = createAutonomySchedulerHarness({ mode: "balanced" });
    const autonomous = createAutonomySchedulerHarness({ mode: "autonomous" });

    expect(friend.scheduler.canChatProactively()).toBe(false);
    expect(balanced.scheduler.canChatProactively()).toBe(true);
    expect(autonomous.scheduler.canChatProactively()).toBe(true);
    balanced.scheduler.markProactiveChat();
    autonomous.scheduler.markProactiveChat();

    vi.setSystemTime(119_999);
    expect(autonomous.scheduler.canChatProactively()).toBe(false);
    vi.setSystemTime(120_000);
    expect(autonomous.scheduler.canChatProactively()).toBe(true);
    expect(balanced.scheduler.canChatProactively()).toBe(false);
    vi.setSystemTime(179_999);
    expect(balanced.scheduler.canChatProactively()).toBe(false);
    vi.setSystemTime(180_000);
    expect(balanced.scheduler.canChatProactively()).toBe(true);
    expect(friend.scheduler.canChatProactively()).toBe(false);
  });

  it("is idempotently startable and stoppable with no late callback or timer", async () => {
    const value = createAutonomySchedulerHarness({ mode: "autonomous" });

    value.scheduler.start();
    value.scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    value.scheduler.notifyThreat();
    value.scheduler.stop();
    value.scheduler.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(value.reasons).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
