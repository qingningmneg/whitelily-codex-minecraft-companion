import { describe, expect, it } from "vitest";
import { CompanionActionQueue } from "../../src/actions/actionQueue.js";
import type { TaskLease } from "../../src/safety/taskBudget.js";

const taskLease: TaskLease = { id: "task-secret", startedAt: 1_000 };

function sequenceIds(): () => string {
  let next = 0;
  return () => `queue-${++next}`;
}

describe("CompanionActionQueue", () => {
  it("keeps FIFO order and exposes only sanitized queue summaries", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳一下",
      trustedObservationKey: "observation-secret",
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "wait", milliseconds: 500 },
      summary: "短暂等待",
      trustedObservationKey: "observation-secret",
    });

    expect(
      queue.snapshot().items.map(({ status, summary, enqueuedAt }) => ({
        status,
        summary,
        enqueuedAt,
      })),
    ).toEqual([
      {
        status: "waiting",
        summary: "跳一下",
        enqueuedAt: "2026-08-15T00:00:00.000Z",
      },
      {
        status: "waiting",
        summary: "短暂等待",
        enqueuedAt: "2026-08-15T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(queue.snapshot())).not.toContain("task-secret");
    expect(JSON.stringify(queue.snapshot())).not.toContain("observation-secret");
    expect(JSON.stringify(queue.snapshot())).not.toContain("milliseconds");
  });

  it("limits active capacity per task lease", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    for (let index = 0; index < 256; index += 1) {
      queue.enqueue({
        taskLease,
        worldGeneration: 1,
        action: { kind: "jump" },
        summary: `动作 ${index}`,
        trustedObservationKey: "observation-a",
      });
    }

    expect(() =>
      queue.enqueue({
        taskLease,
        worldGeneration: 1,
        action: { kind: "jump" },
        summary: "超出容量",
        trustedObservationKey: "observation-a",
      }),
    ).toThrow("queue capacity exhausted");
    expect(() =>
      queue.enqueue({
        taskLease: { id: "another-task", startedAt: 2_000 },
        worldGeneration: 1,
        action: { kind: "jump" },
        summary: "另一个任务",
        trustedObservationKey: "observation-b",
      }),
    ).not.toThrow();
  });

  it("rejects an over-capacity batch without appending a partial prefix", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    for (let index = 0; index < 255; index += 1) {
      queue.enqueue({
        taskLease,
        worldGeneration: 1,
        action: { kind: "jump" },
        summary: `动作 ${index}`,
        trustedObservationKey: "observation-a",
      });
    }

    expect(() =>
      queue.enqueueBatch([
        {
          taskLease,
          worldGeneration: 1,
          action: { kind: "jump" },
          summary: "动作 256",
          trustedObservationKey: "observation-a",
        },
        {
          taskLease,
          worldGeneration: 1,
          action: { kind: "jump" },
          summary: "动作 257",
          trustedObservationKey: "observation-a",
        },
      ]),
    ).toThrow("queue capacity exhausted");
    expect(queue.snapshot().items).toHaveLength(255);
  });

  it("allows two semantic retries and rejects the third under the same observation and failure", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const admission = {
      taskLease,
      worldGeneration: 1,
      action: { kind: "move_to", position: { x: 2, y: 64, z: 3 } } as const,
      summary: "前往目标",
      trustedObservationKey: "observation-a",
    };
    for (const reason of [" Block   missing ", "block missing", "BLOCK MISSING"]) {
      queue.enqueue(admission);
      const item = queue.claimNext(taskLease, 1);
      if (!item) throw new Error("expected queued action");
      queue.fail(item.id, taskLease, 1, reason);
    }

    expect(() => queue.enqueue(admission)).toThrow("semantic action retry exhausted");
    expect(queue.snapshot().items).toHaveLength(3);
    expect(() =>
      queue.enqueue({
        ...admission,
        trustedObservationKey: "observation-b",
      }),
    ).not.toThrow();
    expect(() =>
      queue.enqueue({
        ...admission,
        action: { kind: "move_to", position: { x: 3, y: 64, z: 3 } },
      }),
    ).not.toThrow();
  });

  it("rejects a duplicate opaque queue item id", () => {
    const queue = new CompanionActionQueue({
      createId: () => "duplicate-id",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const input = {
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" } as const,
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    };
    queue.enqueue(input);

    expect(() => queue.enqueue(input)).toThrow("queue item id collision");
  });

  it.each(["", "space id", "x".repeat(65)])("rejects invalid opaque queue item id %j", (id) => {
    const queue = new CompanionActionQueue({
      createId: () => id,
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });

    expect(() =>
      queue.enqueue({
        taskLease,
        worldGeneration: 1,
        action: { kind: "jump" },
        summary: "跳跃",
        trustedObservationKey: "observation-a",
      }),
    ).toThrow("invalid queue item id");
  });

  it("bounds the diagnostic projection to the latest 256 queue items", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    for (let index = 0; index < 300; index += 1) {
      queue.enqueue({
        taskLease,
        worldGeneration: 1,
        action: { kind: "jump" },
        summary: `动作 ${index + 1}`,
        trustedObservationKey: "observation-a",
      });
      const claimed = queue.claimNext(taskLease, 1);
      if (!claimed) throw new Error("expected queued action");
      queue.complete(claimed.id, taskLease, 1);
    }

    const snapshot = queue.snapshot();
    expect(snapshot.items).toHaveLength(256);
    expect(snapshot.items[0]?.index).toBe(45);
    expect(snapshot.items.at(-1)?.index).toBe(300);
  });

  it("claims the first physical action only for its task lease and world generation", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 7,
      action: { kind: "wait", milliseconds: 750 },
      summary: "等待",
      trustedObservationKey: "observation-a",
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 7,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });

    expect(queue.claimNext({ id: "another-task", startedAt: 2_000 }, 7)).toBeUndefined();
    expect(queue.claimNext(taskLease, 7)).toEqual({
      id: "queue-1",
      taskLease,
      worldGeneration: 7,
      action: { kind: "wait", milliseconds: 750 },
    });
    expect(queue.snapshot().items.map(({ status }) => status)).toEqual(["running", "waiting"]);
    expect(queue.snapshot().items[0]?.startedAt).toBe("2026-08-15T00:00:00.000Z");
  });

  it("cancels stale waiting actions when the world generation changes", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const observed: string[] = [];
    queue.subscribe((event) => observed.push(event.item.status));
    queue.enqueue({
      taskLease,
      worldGeneration: 7,
      action: { kind: "move_to", position: { x: 10, y: 64, z: 10 } },
      summary: "前往旧坐标",
      trustedObservationKey: "observation-a",
    });

    expect(queue.claimNext(taskLease, 8)).toBeUndefined();
    expect(queue.snapshot().items[0]).toMatchObject({
      status: "cancelled",
      reason: "world generation changed",
      endedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(observed).toEqual(["waiting", "cancelled"]);
  });

  it("allows only the owning task and world to complete a running action once", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 3,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });
    const claimed = queue.claimNext(taskLease, 3);
    expect(claimed).toBeDefined();

    expect(() => queue.complete("queue-1", { id: "another-task", startedAt: 2_000 }, 3)).toThrow(
      "queue item authority mismatch",
    );
    expect(() => queue.complete("queue-1", taskLease, 4)).toThrow("queue item authority mismatch");

    queue.complete("queue-1", taskLease, 3);
    expect(queue.snapshot().items[0]).toMatchObject({
      status: "completed",
      endedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(() => queue.complete("queue-1", taskLease, 3)).toThrow("invalid queue item transition");
  });

  it("bounds diagnostic summaries by Unicode characters", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "花".repeat(161),
      trustedObservationKey: "observation-a",
    });

    expect(queue.snapshot().items[0]?.summary).toBe("花".repeat(160));
  });

  it("redacts secrets and local paths from diagnostic text", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: String.raw`password=hunter2 C:\Users\Admin\private\task.txt`,
      trustedObservationKey: "observation-a",
    });
    queue.claimNext(taskLease, 1);
    queue.fail(
      "queue-1",
      taskLease,
      1,
      String.raw`token=private-token C:\Users\Admin\private\failure.txt`,
    );

    const diagnostic = JSON.stringify(queue.snapshot());
    expect(diagnostic).not.toContain("hunter2");
    expect(diagnostic).not.toContain("private-token");
    expect(diagnostic).not.toContain(String.raw`C:\Users\Admin`);
  });

  it("records a bounded failure reason exactly once", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });
    queue.claimNext(taskLease, 1);

    queue.fail("queue-1", taskLease, 1, "错".repeat(241));

    expect(queue.snapshot().items[0]).toMatchObject({
      status: "failed",
      reason: "错".repeat(240),
      endedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(() => queue.fail("queue-1", taskLease, 1, "再次失败")).toThrow(
      "invalid queue item transition",
    );
  });

  it("records at most one transport retry for a running action", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });
    queue.claimNext(taskLease, 1);

    queue.recordTransportRetry("queue-1", taskLease, 1);

    expect(queue.snapshot().items[0]?.retryCount).toBe(1);
    expect(() => queue.recordTransportRetry("queue-1", taskLease, 1)).toThrow(
      "transport retry exhausted",
    );
  });

  it("suspends and cancels only the owning task lease", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const anotherLease: TaskLease = { id: "another-task", startedAt: 2_000 };
    for (const action of [
      { kind: "jump" } as const,
      { kind: "wait", milliseconds: 500 } as const,
    ]) {
      queue.enqueue({
        taskLease,
        worldGeneration: 1,
        action,
        summary: action.kind,
        trustedObservationKey: "observation-a",
      });
    }
    queue.enqueue({
      taskLease: anotherLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "另一个任务",
      trustedObservationKey: "observation-b",
    });
    queue.claimNext(taskLease, 1);

    queue.suspendTask(taskLease, "owner_message");

    expect(queue.snapshot().items.map(({ status }) => status)).toEqual([
      "suspended",
      "suspended",
      "waiting",
    ]);

    queue.cancelTask(taskLease, "owner_stop");

    expect(queue.snapshot().items.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: "cancelled", reason: "owner_stop" },
      { status: "cancelled", reason: "owner_stop" },
      { status: "waiting", reason: undefined },
    ]);
  });

  it("shows permission waits without exposing them as executable actions", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const permission = queue.beginPermissionWait({
      taskLease,
      worldGeneration: 1,
      permission: "wheat_farming",
      summary: "等待小麦种植许可",
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "可逆准备",
      trustedObservationKey: "observation-a",
    });

    expect(permission).toMatchObject({
      id: "queue-1",
      kind: "wheat_farming_permission",
      status: "waiting_permission",
    });
    expect(queue.claimNext(taskLease, 1)?.id).toBe("queue-2");

    queue.resolvePermission("queue-1", taskLease, "completed", "allowed");

    expect(queue.snapshot().items[0]).toMatchObject({
      status: "completed",
      reason: "allowed",
      endedAt: "2026-08-15T00:00:00.000Z",
    });
  });

  it("commits state even when one queue observer throws", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const observed: string[] = [];
    queue.subscribe(() => {
      throw new Error("observer failed");
    });
    const unsubscribe = queue.subscribe((event) => observed.push(event.item.status));

    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });

    expect(queue.snapshot().items[0]?.status).toBe("waiting");
    expect(observed).toEqual(["waiting"]);

    unsubscribe();
    queue.claimNext(taskLease, 1);
    expect(observed).toEqual(["waiting"]);
  });

  it("publishes each physical action lifecycle transition", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const observed: string[] = [];
    queue.subscribe((event) => observed.push(event.item.status));

    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });
    queue.claimNext(taskLease, 1);
    queue.complete("queue-1", taskLease, 1);

    expect(observed).toEqual(["waiting", "running", "completed"]);
  });

  it("publishes the permission wait lifecycle", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const observed: string[] = [];
    queue.subscribe((event) => observed.push(event.item.status));

    queue.beginPermissionWait({
      taskLease,
      worldGeneration: 1,
      permission: "wheat_farming",
      summary: "等待小麦种植许可",
    });
    queue.resolvePermission("queue-1", taskLease, "completed", "allowed");

    expect(observed).toEqual(["waiting_permission", "completed"]);
  });

  it("publishes transport retry and failure diagnostics", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const observed: Array<{ status: string; retryCount: number }> = [];
    queue.subscribe((event) =>
      observed.push({ status: event.item.status, retryCount: event.item.retryCount }),
    );
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });
    queue.claimNext(taskLease, 1);
    queue.recordTransportRetry("queue-1", taskLease, 1);
    queue.fail("queue-1", taskLease, 1, "transport failed");

    expect(observed).toEqual([
      { status: "waiting", retryCount: 0 },
      { status: "running", retryCount: 0 },
      { status: "running", retryCount: 1 },
      { status: "failed", retryCount: 1 },
    ]);
  });

  it("publishes owner suspension and cancellation", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    const observed: string[] = [];
    queue.subscribe((event) => observed.push(event.item.status));
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });
    queue.claimNext(taskLease, 1);

    queue.suspendTask(taskLease, "owner_message");
    queue.cancelTask(taskLease, "owner_stop");

    expect(observed).toEqual(["waiting", "running", "suspended", "cancelled"]);
  });

  it("resumes suspended work only through the replan gate", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "跳跃",
      trustedObservationKey: "observation-a",
    });
    queue.suspendTask(taskLease, "owner_message");

    expect(queue.claimNext(taskLease, 1)).toBeUndefined();

    queue.resumeTaskAfterReplan(taskLease, 1);

    expect(queue.snapshot().items[0]).toMatchObject({ status: "waiting" });
    expect(queue.snapshot().items[0]).not.toHaveProperty("reason");
    expect(queue.claimNext(taskLease, 1)?.id).toBe("queue-1");
  });

  it("never resumes the physical action that was running before suspension", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "move_to", position: { x: 10, y: 64, z: 10 } },
      summary: "前往旧坐标",
      trustedObservationKey: "observation-a",
    });
    queue.claimNext(taskLease, 1);
    queue.suspendTask(taskLease, "owner_message");

    queue.resumeTaskAfterReplan(taskLease, 1);

    expect(queue.snapshot().items[0]).toMatchObject({
      status: "cancelled",
      reason: "replan discarded interrupted action",
      endedAt: "2026-08-15T00:00:00.000Z",
    });
    expect(queue.claimNext(taskLease, 1)).toBeUndefined();
  });

  it("cancels only not-yet-executed physical actions", () => {
    const queue = new CompanionActionQueue({
      createId: sequenceIds(),
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "jump" },
      summary: "正在执行",
      trustedObservationKey: "observation-a",
    });
    queue.enqueue({
      taskLease,
      worldGeneration: 1,
      action: { kind: "wait", milliseconds: 500 },
      summary: "尚未执行",
      trustedObservationKey: "observation-a",
    });
    queue.beginPermissionWait({
      taskLease,
      worldGeneration: 1,
      permission: "wheat_farming",
      summary: "等待许可",
    });
    queue.claimNext(taskLease, 1);

    queue.cancelWaiting(taskLease, "model_replanned");

    expect(queue.snapshot().items.map(({ status }) => status)).toEqual([
      "running",
      "cancelled",
      "waiting_permission",
    ]);
  });
});
