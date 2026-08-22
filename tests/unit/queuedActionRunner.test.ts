import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "../../src/actions/actionExecutor.js";
import { CompanionActionQueue } from "../../src/actions/actionQueue.js";
import { QueuedActionRunner } from "../../src/actions/queuedActionRunner.js";
import type { GameAction } from "../../src/domain/types.js";
import type { SafetyContext } from "../../src/safety/safetyEngine.js";
import type { TaskLease } from "../../src/safety/taskBudget.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((next) => {
      resolve = next;
    }),
    resolve: (value) => resolve(value),
  };
}

const taskLease: TaskLease = { id: "task-a", startedAt: 1_000 };
const safetyContext: SafetyContext = {
  owner: { x: 0, y: 64, z: 0 },
};

describe("QueuedActionRunner", () => {
  it("aborts the running action before marking the task suspended", async () => {
    const queue = new CompanionActionQueue({
      createId: (() => {
        let next = 0;
        return () => `queue-${++next}`;
      })(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const result = deferred<ActionResult>();
    const order: string[] = [];
    const executor = {
      execute: (_action: GameAction, _context: SafetyContext) => result.promise,
      stopAll: () => {
        order.push("executor_stopped");
        result.resolve({ status: "cancelled" });
      },
    };
    queue.subscribe((event) => {
      if (event.item.status === "suspended") order.push("queue_suspended");
    });
    const runner = new QueuedActionRunner({
      queue,
      executor,
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.start();
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "wait", milliseconds: 10_000 },
      summary: "等待",
      trustedObservationKey: "observation-a",
    });
    await vi.waitFor(() => expect(queue.snapshot().items[0]?.status).toBe("running"));

    runner.suspend(taskLease, "owner_message");
    await runner.waitForIdle();

    expect(order).toEqual(["executor_stopped", "queue_suspended"]);
    expect(queue.snapshot().items[0]?.status).toBe("suspended");
  });

  it("consumes queued physical actions in FIFO order before becoming idle", async () => {
    const queue = new CompanionActionQueue({
      createId: (() => {
        let next = 0;
        return () => `queue-${++next}`;
      })(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const executed: GameAction[] = [];
    const events: unknown[] = [];
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async (action) => {
          executed.push(action);
          return { status: "completed" };
        },
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.subscribe((event) => events.push(event));
    runner.start();
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "wait", milliseconds: 500 },
      summary: "等待",
      trustedObservationKey: "observation-a",
    });

    await runner.waitForIdle();

    expect(executed).toEqual([{ kind: "jump" }, { kind: "wait", milliseconds: 500 }]);
    expect(queue.snapshot().items.map(({ status }) => status)).toEqual(["completed", "completed"]);
    expect(events).toEqual([{ kind: "batch_completed", taskLease }]);
  });

  it("stops the batch when an action fails", async () => {
    const queue = new CompanionActionQueue({
      createId: (() => {
        let next = 0;
        return () => `queue-${++next}`;
      })(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    let executions = 0;
    const events: unknown[] = [];
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => {
          executions += 1;
          return { status: "failed", reason: "path blocked" };
        },
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.subscribe((event) => events.push(event));
    runner.start();
    for (const summary of ["第一项", "第二项"]) {
      queue.enqueue({
        taskLease,
        worldGeneration: 1,
        action: { kind: "jump" },
        summary,
        trustedObservationKey: "observation-a",
      });
    }

    await runner.waitForIdle();

    expect(executions).toBe(1);
    expect(queue.snapshot().items.map(({ status }) => status)).toEqual(["failed", "waiting"]);
    expect(events).toEqual([{ kind: "action_failed", taskLease, reason: "path blocked" }]);
  });

  it("retries once only when failure proves the world did not mutate", async () => {
    const queue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    let executions = 0;
    const events: unknown[] = [];
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => {
          executions += 1;
          return executions === 1
            ? { status: "failed", reason: "temporary transport failure", worldMutated: false }
            : { status: "completed" };
        },
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.subscribe((event) => events.push(event));
    runner.start();
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });

    await runner.waitForIdle();

    expect(executions).toBe(2);
    expect(queue.snapshot().items[0]).toMatchObject({ status: "completed", retryCount: 1 });
    expect(events).toEqual([{ kind: "batch_completed", taskLease }]);
  });

  it("fails after the single transport retry without a third attempt", async () => {
    const queue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    let executions = 0;
    const events: unknown[] = [];
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => {
          executions += 1;
          return {
            status: "failed",
            reason: "temporary transport failure",
            worldMutated: false,
          };
        },
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.subscribe((event) => events.push(event));
    runner.start();
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });

    await runner.waitForIdle();

    expect(executions).toBe(2);
    expect(queue.snapshot().items[0]).toMatchObject({
      status: "failed",
      retryCount: 1,
      reason: "temporary transport failure",
    });
    expect(events).toEqual([
      { kind: "action_failed", taskLease, reason: "temporary transport failure" },
    ]);
  });

  it("does not revive a cancelled task when the old action reports late success", async () => {
    const queue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const result = deferred<ActionResult>();
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: () => result.promise,
        stopAll: () => result.resolve({ status: "completed" }),
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.start();
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "wait", milliseconds: 10_000 },
      summary: "等待",
      trustedObservationKey: "observation-a",
    });
    await vi.waitFor(() => expect(queue.snapshot().items[0]?.status).toBe("running"));

    runner.cancelTask(taskLease, "owner_stop");
    await runner.waitForIdle();

    expect(queue.snapshot().items[0]).toMatchObject({
      status: "cancelled",
      reason: "owner_stop",
    });
  });

  it("resumes queued work only after the explicit replan gate", async () => {
    const queue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    let executions = 0;
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => {
          executions += 1;
          return { status: "completed" };
        },
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });
    queue.suspendTask(taskLease, "owner_message");
    runner.start();
    await runner.waitForIdle();
    expect(executions).toBe(0);

    runner.resumeAfterReplan(taskLease, 1);
    await runner.waitForIdle();

    expect(executions).toBe(1);
    expect(queue.snapshot().items[0]?.status).toBe("completed");
  });

  it("holds actions enqueued after suspension until the replan gate opens", async () => {
    const queue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    let executions = 0;
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => {
          executions += 1;
          return { status: "completed" };
        },
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.start();
    runner.suspend(taskLease, "owner_message");
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "暂停期间入队",
      trustedObservationKey: "observation-a",
    });

    await runner.waitForIdle();
    expect(executions).toBe(0);
    expect(queue.snapshot().items[0]?.status).toBe("waiting");

    runner.resumeAfterReplan(taskLease, 1);
    await runner.waitForIdle();
    expect(executions).toBe(1);
    expect(queue.snapshot().items[0]?.status).toBe("completed");
  });

  it("reports stale queued work when the world generation changes", async () => {
    const queue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const events: unknown[] = [];
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => ({ status: "completed" }),
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 2, safetyContext }),
    });
    runner.subscribe((event) => events.push(event));
    runner.start();
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "move_to", position: { x: 10, y: 64, z: 10 } },
      summary: "旧世界动作",
      trustedObservationKey: "observation-a",
    });

    await runner.waitForIdle();

    expect(queue.snapshot().items[0]?.status).toBe("cancelled");
    expect(events).toEqual([{ kind: "world_stale", taskLease }]);
  });

  it("reports one world-stale event for a batch of stale actions", async () => {
    const queue = new CompanionActionQueue({
      createId: (() => {
        let next = 0;
        return () => `queue-${++next}`;
      })(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const events: unknown[] = [];
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => ({ status: "completed" }),
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 2, safetyContext }),
    });
    runner.subscribe((event) => events.push(event));
    runner.start();
    for (const summary of ["旧动作一", "旧动作二"]) {
      queue.enqueue({
        taskLease,
        worldGeneration: 1,
        action: { kind: "jump" },
        summary,
        trustedObservationKey: "observation-a",
      });
    }

    await runner.waitForIdle();

    expect(queue.snapshot().items.map(({ status }) => status)).toEqual(["cancelled", "cancelled"]);
    expect(events).toEqual([{ kind: "world_stale", taskLease }]);
  });

  it("reports task budget failures as a budget boundary", async () => {
    const queue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const events: unknown[] = [];
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => ({ status: "failed", reason: "task budget exhausted" }),
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.subscribe((event) => events.push(event));
    runner.start();
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });

    await runner.waitForIdle();

    expect(events).toEqual([
      { kind: "budget_boundary", taskLease, reason: "task budget exhausted" },
    ]);
  });

  it("maps an executor cancellation to a cancelled queue batch", async () => {
    const queue = new CompanionActionQueue({
      createId: (() => {
        let next = 0;
        return () => `queue-${++next}`;
      })(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => ({ status: "cancelled" }),
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.start();
    for (const summary of ["第一项", "第二项"]) {
      queue.enqueue({
        taskLease,
        worldGeneration: 1,
        action: { kind: "jump" },
        summary,
        trustedObservationKey: "observation-a",
      });
    }

    await runner.waitForIdle();

    expect(queue.snapshot().items.map(({ status }) => status)).toEqual(["cancelled", "cancelled"]);
  });

  it("waits for running action cleanup before becoming idle", async () => {
    const queue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const cancelled = deferred<ActionResult>();
    const cleanup = deferred<void>();
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => {
          const result = await cancelled.promise;
          await cleanup.promise;
          return result;
        },
        stopAll: () => cancelled.resolve({ status: "cancelled" }),
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.start();
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "wait", milliseconds: 10_000 },
      summary: "等待",
      trustedObservationKey: "observation-a",
    });
    await vi.waitFor(() => expect(queue.snapshot().items[0]?.status).toBe("running"));

    runner.cancelTask(taskLease, "owner_stop");
    let idleResolved = false;
    const idle = runner.waitForIdle().then(() => {
      idleResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(idleResolved).toBe(false);

    cleanup.resolve(undefined);
    await idle;
    expect(idleResolved).toBe(true);
  });

  it("contains runner event subscriber errors", async () => {
    const queue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const events: unknown[] = [];
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => ({ status: "completed" }),
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.subscribe(() => {
      throw new Error("observer failed");
    });
    runner.subscribe((event) => events.push(event));
    runner.start();
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });

    await runner.waitForIdle();

    expect(queue.snapshot().items[0]?.status).toBe("completed");
    expect(events).toEqual([{ kind: "batch_completed", taskLease }]);
  });

  it("rejects suspension from a different task lease without stopping work", async () => {
    const queue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const result = deferred<ActionResult>();
    let stops = 0;
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: () => result.promise,
        stopAll: () => {
          stops += 1;
        },
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.start();
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "wait", milliseconds: 10_000 },
      summary: "等待",
      trustedObservationKey: "observation-a",
    });
    await vi.waitFor(() => expect(queue.snapshot().items[0]?.status).toBe("running"));

    expect(() => runner.suspend({ id: "task-b", startedAt: 2_000 }, "owner_message")).toThrow(
      "runner task lease mismatch",
    );
    expect(() => runner.cancelTask({ id: "task-b", startedAt: 2_000 }, "owner_stop")).toThrow(
      "runner task lease mismatch",
    );
    expect(stops).toBe(0);
    expect(queue.snapshot().items[0]?.status).toBe("running");

    result.resolve({ status: "completed" });
    await runner.waitForIdle();
    expect(queue.snapshot().items[0]?.status).toBe("completed");
  });

  it("rejects replan resumption from a different task lease", async () => {
    const queue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const otherTaskLease: TaskLease = { id: "task-b", startedAt: 2_000 };
    queue.enqueue({
      taskLease: otherTaskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "其他任务",
      trustedObservationKey: "observation-b",
    });
    queue.suspendTask(otherTaskLease, "owner_message");
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => ({ status: "completed" }),
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 1, safetyContext }),
    });
    runner.start();

    expect(() => runner.resumeAfterReplan(otherTaskLease, 1)).toThrow("runner task lease mismatch");
    expect(queue.snapshot().items[0]?.status).toBe("suspended");
  });

  it("rejects replan resumption for a stale world generation", () => {
    const queue = new CompanionActionQueue({
      createId: () => "queue-1",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "旧世界动作",
      trustedObservationKey: "observation-a",
    });
    queue.suspendTask(taskLease, "owner_message");
    const runner = new QueuedActionRunner({
      queue,
      executor: {
        execute: async () => ({ status: "completed" }),
        stopAll: () => undefined,
      },
      executionContext: () => ({ taskLease, worldGeneration: 2, safetyContext }),
    });
    runner.start();

    expect(() => runner.resumeAfterReplan(taskLease, 1)).toThrow(
      "runner world generation mismatch",
    );
    expect(queue.snapshot().items[0]?.status).toBe("suspended");
  });
});
