import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskController,
  type TaskAuditCallback,
  type TaskDisclosure,
} from "../../src/companion/taskController.js";
import { TurnToolBudget } from "../../src/mcp/toolBudget.js";
import { HARD_TASK_LIMITS, TaskControllerBudget } from "../../src/safety/taskBudget.js";

const disclosure: TaskDisclosure = {
  goal: "collect four oak logs",
  expectedActions: ["get_state", "find_block", "move_to", "dig_block"],
  limits: { ...HARD_TASK_LIMITS },
  stopCondition: "four logs are collected or the owner stops the task",
};

const requestedLimitFields = [
  "maxToolCalls",
  "maxBlockChanges",
  "maxHorizontalTravel",
  "maxDurationMs",
  "maxDangerousOperations",
] as const;

const invalidRequestedLimitCases = requestedLimitFields.flatMap((field) => [
  { field, label: "NaN", value: Number.NaN },
  { field, label: "positive Infinity", value: Number.POSITIVE_INFINITY },
  { field, label: "negative Infinity", value: Number.NEGATIVE_INFINITY },
  { field, label: "negative value", value: -1 },
]);

function fixedController(audit?: TaskAuditCallback): TaskController {
  return new TaskController(
    new TaskControllerBudget({
      now: () => Date.parse("2026-07-27T08:00:00.000Z"),
      randomId: () => "task-lease-1",
    }),
    audit,
  );
}

describe("TaskController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows only one active task", () => {
    const controller = fixedController();
    controller.start(disclosure);

    expect(() => controller.start(disclosure)).toThrow("a task is already active");
  });

  it("invalidates the active task when owner revision changes", () => {
    let identityRevision = 4;
    const audit = vi.fn<TaskAuditCallback>();
    const controller = new TaskController(
      new TaskControllerBudget({
        now: () => Date.parse("2026-07-27T08:00:00.000Z"),
        randomId: () => "task-lease-1",
      }),
      audit,
      { ownerIdentityRevision: () => identityRevision },
    );
    const active = controller.start(disclosure);

    identityRevision = 5;

    expect(controller.isLeaseLive(active.lease)).toBe(false);
    expect(controller.current()).toBeNull();
    expect(audit).toHaveBeenLastCalledWith(
      "task_stopped",
      expect.objectContaining({ reason: "owner_changed" }),
    );
  });

  it.each(["emergency_stop", "disconnect", "world_changed", "model_unavailable"] as const)(
    "invalidates tool work on %s",
    (reason) => {
      const controller = fixedController();
      const task = controller.start(disclosure);

      controller.stop(reason);

      expect(
        controller.consume({
          leaseId: task.lease.id,
          kind: "say",
          now: Date.parse("2026-07-27T08:00:01.000Z"),
        }),
      ).toEqual({ ok: false, reason: "task lease is invalid" });
      expect(controller.current()).toBeNull();
    },
  );

  it("matches only the complete currently live task capability", () => {
    const controller = fixedController();
    const task = controller.start(disclosure);

    expect(controller.isLeaseLive(task.lease)).toBe(true);
    expect(controller.isLeaseLive({ ...task.lease, startedAt: task.lease.startedAt + 1 })).toBe(
      false,
    );
    controller.stop("completed");
    expect(controller.isLeaseLive(task.lease)).toBe(false);
  });

  it("reserves additional confirmed travel against the same live task", () => {
    const controller = fixedController();
    const task = controller.start(disclosure, { maxHorizontalTravel: 5 });

    expect(controller.reserveAdditionalTravel(task.lease, 5).ok).toBe(true);
    expect(controller.reserveAdditionalTravel(task.lease, 1)).toEqual({
      ok: false,
      reason: "task budget exhausted",
    });
    expect(controller.current()).toBeNull();
  });

  it.each([
    [{ ...disclosure, goal: "" }, "task goal cannot be empty"],
    [{ ...disclosure, goal: " \t\n " }, "task goal cannot be empty"],
    [{ ...disclosure, stopCondition: "" }, "task stop condition cannot be empty"],
    [{ ...disclosure, stopCondition: " \t\n " }, "task stop condition cannot be empty"],
    [
      {
        ...disclosure,
        expectedActions: Array.from({ length: 17 }, (_, index) => `action-${index}`),
      },
      "task expected actions cannot exceed 16 labels",
    ],
    [
      { ...disclosure, expectedActions: ["get_state", " "] },
      "task expected action labels must be non-empty strings",
    ],
  ] as const)("rejects an ambiguous disclosure: %s", (invalid, message) => {
    const controller = fixedController();

    expect(() => controller.start(invalid as TaskDisclosure)).toThrow(message);
    expect(controller.current()).toBeNull();
  });

  it.each([
    [{ ...disclosure, expectedActions: "say" }, "task expected actions must be an array"],
    [
      { ...disclosure, limits: { ...disclosure.limits, maxToolCalls: Number.NaN } },
      "task limits are invalid",
    ],
    [{ ...disclosure, limits: null }, "task limits are invalid"],
  ])("rejects malformed disclosure structure before opening a lease", (invalid, message) => {
    const controller = fixedController();

    expect(() => controller.start(invalid as TaskDisclosure)).toThrow(message);
    expect(controller.current()).toBeNull();
  });

  it("rejects malformed requested limits before opening a lease", () => {
    const controller = fixedController();

    expect(() =>
      controller.start(disclosure, { maxToolCalls: "3" } as unknown as { maxToolCalls: number }),
    ).toThrow("requested task limits are invalid");
    expect(() =>
      controller.start(disclosure, { unknownLimit: 1 } as unknown as { maxToolCalls: number }),
    ).toThrow("requested task limits are invalid");
    expect(controller.current()).toBeNull();
  });

  it.each(invalidRequestedLimitCases)(
    "rejects $label for requested $field without opening or auditing a task",
    ({ field, value }) => {
      const events: string[] = [];
      const controller = new TaskController(
        new TaskControllerBudget({
          now: () => Date.parse("2026-07-27T08:00:00.000Z"),
          randomId: () => "task-lease-1",
        }),
        (event) => events.push(event),
      );

      expect(() => controller.start(disclosure, { [field]: value })).toThrow(
        "requested task limits are invalid",
      );
      expect(controller.current()).toBeNull();
      expect(events).toEqual([]);
    },
  );

  it("clones disclosure input and every active-task output", () => {
    const controller = fixedController();
    const input = structuredClone(disclosure);
    const started = controller.start(input, { maxToolCalls: 3 });

    input.goal = "mutated input";
    input.expectedActions.push("attack_hostile");
    input.limits.maxToolCalls = 999;
    started.disclosure.goal = "mutated started output";
    started.disclosure.expectedActions.push("place_block");
    started.disclosure.limits.maxToolCalls = 999;
    started.lease.id = "mutated lease";

    const firstCurrent = controller.current();
    expect(firstCurrent).toEqual({
      id: "task-lease-1",
      lease: {
        id: "task-lease-1",
        startedAt: Date.parse("2026-07-27T08:00:00.000Z"),
      },
      disclosure: {
        ...disclosure,
        expectedActions: [...disclosure.expectedActions],
        limits: { ...disclosure.limits, maxToolCalls: 3 },
      },
      startedAt: "2026-07-27T08:00:00.000Z",
    });

    if (!firstCurrent) throw new Error("expected an active task");
    firstCurrent.disclosure.goal = "mutated current output";
    firstCurrent.disclosure.expectedActions.splice(0);
    firstCurrent.disclosure.limits.maxDurationMs = 0;
    firstCurrent.lease.id = "mutated current lease";

    expect(controller.current()).toEqual({
      id: "task-lease-1",
      lease: {
        id: "task-lease-1",
        startedAt: Date.parse("2026-07-27T08:00:00.000Z"),
      },
      disclosure: {
        ...disclosure,
        expectedActions: [...disclosure.expectedActions],
        limits: { ...disclosure.limits, maxToolCalls: 3 },
      },
      startedAt: "2026-07-27T08:00:00.000Z",
    });
  });

  it("audits actual transitions once with reason and defensive data", () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const observedLimits: number[] = [];
    const controller = fixedController((event, data) => {
      events.push({ event, data });
      observedLimits.push(data.limits.maxToolCalls);
      data.limits.maxToolCalls = 0;
    });

    const started = controller.start(disclosure);
    controller.stop("owner_stop");
    controller.stop("disconnect");

    expect(started.id).toBe("task-lease-1");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event: "task_started",
      data: {
        startedAt: "2026-07-27T08:00:00.000Z",
        expectedActionCategoryCount: 4,
        limits: { maxToolCalls: 0 },
      },
    });
    expect(events[1]).toMatchObject({
      event: "task_stopped",
      data: {
        startedAt: "2026-07-27T08:00:00.000Z",
        expectedActionCategoryCount: 4,
        limits: { maxToolCalls: 0 },
        reason: "owner_stop",
      },
    });
    expect(started).toMatchObject({
      id: "task-lease-1",
      lease: { id: "task-lease-1" },
      disclosure: { goal: disclosure.goal },
    });
    expect(observedLimits).toEqual([64, 64]);
  });

  it("keeps audit callback payloads free of task authority and private task text", () => {
    const records: Array<{ event: string; data: unknown }> = [];
    const controller = fixedController((event, data) => {
      records.push({ event, data: structuredClone(data) });
    });

    controller.start(disclosure, { maxToolCalls: 3 });
    controller.stop("owner_stop");

    expect(records).toEqual([
      {
        event: "task_started",
        data: {
          startedAt: "2026-07-27T08:00:00.000Z",
          expectedActionCategoryCount: 4,
          limits: { ...HARD_TASK_LIMITS, maxToolCalls: 3 },
        },
      },
      {
        event: "task_stopped",
        data: {
          startedAt: "2026-07-27T08:00:00.000Z",
          expectedActionCategoryCount: 4,
          limits: { ...HARD_TASK_LIMITS, maxToolCalls: 3 },
          reason: "owner_stop",
        },
      },
    ]);
    expect(JSON.stringify(records)).not.toMatch(
      /task-lease-1|collect four oak logs|stopCondition|expectedActions|"(?:task|lease|id)"\s*:/iu,
    );
  });

  it("fails closed on an invalid stop reason without letting audit errors escape", () => {
    const events: string[] = [];
    const controller = fixedController((event) => {
      events.push(event);
      throw new Error("audit sink failed");
    });
    const task = controller.start(disclosure);

    expect(() => controller.stop("ambiguous" as never)).toThrow("task stop reason is invalid");
    expect(controller.current()).toBeNull();
    expect(
      controller.consume({
        leaseId: task.lease.id,
        kind: "say",
        now: Date.parse("2026-07-27T08:00:01.000Z"),
      }),
    ).toEqual({ ok: false, reason: "task lease is invalid" });
    expect(events).toEqual(["task_started", "task_stopped"]);
  });

  it("audits budget exhaustion as the single stopping transition", () => {
    const events: string[] = [];
    const controller = fixedController((event) => events.push(event));
    const task = controller.start(disclosure, { maxToolCalls: 0 });

    expect(
      controller.consume({
        leaseId: task.lease.id,
        kind: "get_state",
        now: Date.parse("2026-07-27T08:00:01.000Z"),
      }),
    ).toEqual({ ok: false, reason: "task budget exhausted" });
    controller.stop("failed");

    expect(events).toEqual(["task_started", "task_stopped"]);
    expect(controller.current()).toBeNull();
  });

  it("invalidates state and completes synchronous cleanup before the stopped audit", () => {
    const order: string[] = [];
    let cleanupComplete = false;
    const budget = new TaskControllerBudget({
      now: () => Date.parse("2026-07-27T08:00:00.000Z"),
      randomId: () => "task-lease-1",
    });
    let controller!: TaskController;
    controller = new TaskController(budget, (event, data) => {
      if (event !== "task_stopped" || !("reason" in data)) return;
      order.push(
        `audit:${data.reason}:${cleanupComplete}:${budget.snapshot().active}:${controller.current() === null}`,
      );
    });
    controller.onTerminal((reason) => {
      order.push(`cleanup:${reason}`);
      cleanupComplete = true;
      controller.stop("owner_stop");
    });
    controller.start(disclosure);

    controller.stop("timeout");

    expect(order).toEqual(["cleanup:timeout", "audit:timeout:true:false:true"]);
  });

  it("provides a dedicated fail-closed capability without changing ordinary failed stops", () => {
    const forcedCleanup: boolean[] = [];
    const controller = fixedController();
    controller.onTerminal((_reason, forced) => forcedCleanup.push(forced));

    controller.start(disclosure);
    controller.stop("failed");
    controller.start(disclosure);
    controller.failClosed();

    expect(forcedCleanup).toEqual([false, true]);
    expect(controller.current()).toBeNull();
  });

  it("fires the deadline terminal hook without another consume call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T08:00:00.000Z"));
    const events: string[] = [];
    const terminalReasons: string[] = [];
    const budget = new TaskControllerBudget({
      now: () => Date.now(),
      randomId: () => "task-lease-1",
    });
    const controller = new TaskController(
      budget,
      (event, data) => {
        events.push("reason" in data ? `${event}:${data.reason}` : event);
      },
      {
        onTerminal: (reason: string) => terminalReasons.push(reason),
      },
    );
    controller.start(disclosure, { maxDurationMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(controller.current()).toBeNull();
    expect(budget.snapshot()).toMatchObject({ active: false, stopReason: "timeout" });
    expect(events).toEqual(["task_started", "task_stopped:timeout"]);
    expect(terminalReasons).toEqual(["timeout"]);
  });

  it.each(["completed", "owner_stop"] as const)(
    "clears the deadline after %s and ignores its stale callback during a later task",
    (reason) => {
      const callbacks = new Map<number, () => void>();
      const clearedTimers: number[] = [];
      let nextTimer = 1;
      let nextLease = 1;
      const budget = new TaskControllerBudget({
        now: () => Date.parse("2026-07-27T08:00:00.000Z"),
        randomId: () => `task-lease-${nextLease++}`,
      });
      const controller = new TaskController(budget, () => undefined, {
        setTimer: (callback) => {
          const timer = nextTimer++;
          callbacks.set(timer, callback);
          return timer as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: (timer) => {
          const id = timer as unknown as number;
          clearedTimers.push(id);
          callbacks.delete(id);
        },
      });
      const first = controller.start(disclosure, { maxDurationMs: 1_000 });
      const staleDeadline = callbacks.get(1);
      if (!staleDeadline) throw new Error("expected the first deadline callback");

      controller.stop(reason);
      const second = controller.start(disclosure, { maxDurationMs: 1_000 });
      staleDeadline();

      expect(clearedTimers).toContain(1);
      expect(controller.current()?.id).toBe(second.id);
      expect(controller.current()?.id).not.toBe(first.id);
      controller.stop("completed");
      expect(clearedTimers).toEqual([1, 2]);
    },
  );

  it("unrefs the production deadline handle", () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setTimeout>;
    const controller = new TaskController(
      new TaskControllerBudget({
        now: () => Date.parse("2026-07-27T08:00:00.000Z"),
        randomId: () => "task-lease-1",
      }),
      () => undefined,
      {
        setTimer: () => timer,
        clearTimer: () => undefined,
      },
    );

    controller.start(disclosure);

    expect(unref).toHaveBeenCalledTimes(1);
    controller.stop("completed");
  });

  it("reconciles exhaustion consumed directly by the shared turn budget", () => {
    const events: Array<{ event: string; reason?: string }> = [];
    const taskBudget = new TaskControllerBudget({
      now: () => Date.parse("2026-07-27T08:00:00.000Z"),
      randomId: () => "task-lease-1",
    });
    const controller = new TaskController(taskBudget, (event, data) => {
      events.push({ event, ...("reason" in data ? { reason: data.reason } : {}) });
    });
    const turnBudget = new TurnToolBudget(taskBudget);
    const task = controller.start(disclosure, { maxToolCalls: 0 });
    const turnLease = turnBudget.begin(task.lease);

    expect(turnBudget.consume("get_state", turnLease)).toEqual({
      ok: false,
      reason: "tool call budget exhausted",
    });
    expect(events).toEqual([
      { event: "task_started" },
      { event: "task_stopped", reason: "budget_exhausted" },
    ]);
    expect(controller.current()).toBeNull();
    controller.stop("completed");
    expect(events).toHaveLength(2);
  });

  it("rejects malformed consumption without spending the active budget", () => {
    const controller = fixedController();
    const task = controller.start(disclosure, { maxToolCalls: 1 });

    expect(
      controller.consume({
        leaseId: "",
        kind: "say",
        now: Date.parse("2026-07-27T08:00:01.000Z"),
      }),
    ).toEqual({ ok: false, reason: "task lease is invalid" });
    expect(
      controller.consume({
        leaseId: task.lease.id,
        kind: "say",
        now: Date.parse("2026-07-27T08:00:01.000Z"),
      }).ok,
    ).toBe(true);
  });
});
