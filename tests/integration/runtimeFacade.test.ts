import { describe, expect, it } from "vitest";
import type { ActiveTask } from "../../src/companion/taskController.js";
import { RuntimeFacade } from "../../src/runtime/runtimeFacade.js";
import type { RuntimeEvent } from "../../src/runtime/runtimeEvents.js";
import type { TaskBudgetSnapshot, TaskStopReason } from "../../src/safety/taskBudget.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function inactiveBudget(): TaskBudgetSnapshot {
  return {
    active: false,
    stopReason: null,
    limits: {
      maxToolCalls: 64,
      maxBlockChanges: 256,
      maxHorizontalTravel: 1_024,
      maxDurationMs: 600_000,
      maxDangerousOperations: 8,
    },
    toolCalls: 0,
    blockChanges: 0,
    horizontalTravel: 0,
    dangerousOperations: 0,
    startedAt: null,
  };
}

function activeTaskFixture(): ActiveTask {
  return {
    id: "lease-active-fixture",
    lease: { id: "lease-active-fixture", startedAt: 1_700_000_000_000 },
    disclosure: {
      goal: "Build safely",
      expectedActions: ["place"],
      limits: { ...inactiveBudget().limits },
      stopCondition: "Build complete",
    },
    startedAt: "2023-11-14T22:13:20.000Z",
  };
}

function activeBudgetFixture(): TaskBudgetSnapshot {
  return {
    ...inactiveBudget(),
    active: true,
    startedAt: 1_700_000_000_000,
  };
}

let minecraftAccessorReads = 0;
const accessorBackedOwnerOffline = { kind: "owner_offline" };
Object.defineProperty(accessorBackedOwnerOffline, "username", {
  enumerable: true,
  get: () => {
    minecraftAccessorReads += 1;
    return "owner";
  },
});
const nonEnumerableOwnerOnline = { kind: "owner_online" };
Object.defineProperty(nonEnumerableOwnerOnline, "username", {
  enumerable: false,
  value: "owner",
});
const inheritedDeathEvent = Object.assign(Object.create({ inherited: true }) as object, {
  kind: "death",
});

const malformedMinecraftCases: ReadonlyArray<readonly [string, unknown]> = [
  ["connected reason has the wrong type", { kind: "connected", reason: 42 }],
  ["connected reason exceeds its bound", { kind: "connected", reason: "r".repeat(257) }],
  ["disconnected has an extra field", { kind: "disconnected", extra: true }],
  ["world_changed has a symbol field", { kind: "world_changed", [Symbol("private")]: true }],
  ["chat has a non-string message", { kind: "chat", username: "owner", message: 42 }],
  ["chat username exceeds its bound", { kind: "chat", username: "u".repeat(65), message: "hi" }],
  [
    "chat message exceeds its bound",
    { kind: "chat", username: "owner", message: "m".repeat(4_097) },
  ],
  ["owner_online has a non-enumerable username", nonEnumerableOwnerOnline],
  ["owner_offline has an accessor username", accessorBackedOwnerOffline],
  ["death has a custom prototype", inheritedDeathEvent],
  [
    "hostile_nearby has a non-finite entity ID",
    {
      kind: "hostile_nearby",
      entityId: Number.POSITIVE_INFINITY,
      entityKind: "zombie",
      position: { x: 0, y: 64, z: 0 },
    },
  ],
  [
    "hostile_nearby entity kind exceeds its bound",
    {
      kind: "hostile_nearby",
      entityId: 1,
      entityKind: "z".repeat(129),
      position: { x: 0, y: 64, z: 0 },
    },
  ],
  [
    "hostile_nearby has a non-finite Vec3",
    {
      kind: "hostile_nearby",
      entityId: 1,
      entityKind: "zombie",
      position: { x: 0, y: Number.NaN, z: 0 },
    },
  ],
] as const;

function createRuntimeFacadeHarness() {
  const cleanup: string[] = [];
  const stopReasons: TaskStopReason[] = [];
  const runtime = new RuntimeFacade({
    lifecycle: {
      start: async () => undefined,
      stop: async () => {
        cleanup.push("executor", "minecraft", "codex", "mcp");
      },
    },
    task: {
      current: () => null,
      budget: inactiveBudget,
      stop: (reason) => {
        stopReasons.push(reason);
        cleanup.push("task");
      },
    },
  });
  return { runtime, stopReasons, cleanupOrder: () => [...cleanup] };
}

describe("RuntimeFacade", () => {
  it("forwards a memory-scope change without changing the Minecraft lifecycle", () => {
    const scopes: unknown[] = [];
    const runtime = new RuntimeFacade({
      lifecycle: { start: async () => undefined, stop: async () => undefined },
      memory: { setScope: (scope) => scopes.push(scope) },
    });

    runtime.setMemoryScope({ mode: "layered", worldId: "world-a" });

    expect(scopes).toEqual([{ mode: "layered", worldId: "world-a" }]);
    expect(runtime.snapshot().minecraft).toEqual({ state: "disconnected", sessionId: null });
  });
  it("publishes strictly increasing revisions and snapshots the latest public revision", async () => {
    const harness = createRuntimeFacadeHarness();
    const revisions: Array<number | undefined> = [];
    harness.runtime.subscribe((event) => {
      revisions.push((event as RuntimeEvent & { revision?: number }).revision);
    });

    await harness.runtime.start();

    expect(revisions).toEqual([1, 2, 3, 4, 5]);
    expect((harness.runtime.snapshot() as { revision?: number }).revision).toBe(5);
  });

  it("fails closed instead of publishing an unsafe revision after exhaustion", async () => {
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      initialRevision: Number.MAX_SAFE_INTEGER,
    } as ConstructorParameters<typeof RuntimeFacade>[0]);
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await expect(runtime.start()).rejects.toThrow(/revision/iu);

    expect(events).toEqual([]);
    expect(runtime.snapshot()).toMatchObject({
      revision: Number.MAX_SAFE_INTEGER,
      lifecycle: "failed",
      lastError: {
        code: "RUNTIME_REVISION_EXHAUSTED",
        message: "Runtime revision is exhausted",
      },
    });
  });

  it.each([
    {
      operation: "start",
      initialRevision: Number.MAX_SAFE_INTEGER - 1,
      expectedEventRevisions: [Number.MAX_SAFE_INTEGER],
    },
    {
      operation: "start",
      initialRevision: Number.MAX_SAFE_INTEGER,
      expectedEventRevisions: [],
    },
    {
      operation: "stop",
      initialRevision: Number.MAX_SAFE_INTEGER - 1,
      expectedEventRevisions: [Number.MAX_SAFE_INTEGER],
    },
    {
      operation: "stop",
      initialRevision: Number.MAX_SAFE_INTEGER,
      expectedEventRevisions: [],
    },
  ] as const)(
    "$operation fails closed without an unhandled rejection from revision $initialRevision",
    async ({ operation, initialRevision, expectedEventRevisions }) => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      let cleanupCalls = 0;
      const runtime = new RuntimeFacade({
        initialRevision,
        lifecycle: {
          start: async () => undefined,
          stop: async () => {
            cleanupCalls += 1;
          },
        },
      });
      const events: RuntimeEvent[] = [];
      runtime.subscribe((event) => events.push(event));

      try {
        const operationPromise =
          operation === "start" ? runtime.start() : runtime.stop("process_exit");
        await expect(operationPromise).rejects.toThrow(/revision/iu);
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(unhandled).toEqual([]);
        expect(cleanupCalls).toBe(1);
        expect(events.map((event) => event.revision)).toEqual(expectedEventRevisions);
        expect(events.every((event) => Number.isSafeInteger(event.revision))).toBe(true);
        expect(runtime.snapshot()).toMatchObject({
          revision: Number.MAX_SAFE_INTEGER,
          lifecycle: "failed",
          lastError: {
            code: "RUNTIME_REVISION_EXHAUSTED",
          },
        });
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    },
  );

  it("publishes ordered startup and stop state", async () => {
    const harness = createRuntimeFacadeHarness();
    const states: string[] = [];
    harness.runtime.subscribe((event) => {
      if (event.kind === "lifecycle") states.push(event.state);
    });

    await harness.runtime.start();
    await harness.runtime.stop("owner_stop");

    expect(states).toEqual(["starting", "running", "stopping", "stopped"]);
  });

  it("stops the task before executor and Minecraft cleanup", async () => {
    const harness = createRuntimeFacadeHarness();

    await harness.runtime.start();
    await harness.runtime.stop("emergency_stop");

    expect(harness.cleanupOrder()).toEqual(["task", "executor", "minecraft", "codex", "mcp"]);
    expect(harness.stopReasons).toEqual(["emergency_stop"]);
  });

  it.each(["owner_changed", "model_changed"] as const)(
    "accepts %s as a terminal task-budget reason",
    (reason) => {
      const runtime = new RuntimeFacade({
        lifecycle: { start: async () => undefined, stop: async () => undefined },
        task: {
          current: () => null,
          budget: () => ({ ...inactiveBudget(), stopReason: reason }),
          stop: () => undefined,
        },
      });

      expect(runtime.snapshot()).toMatchObject({ task: null, lastError: null });
    },
  );

  it("shares a concurrent start and emits one startup transition", async () => {
    const gate = deferred();
    let starts = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: () => {
          starts += 1;
          return gate.promise;
        },
        stop: async () => undefined,
      },
    });
    const states: string[] = [];
    runtime.subscribe((event) => {
      if (event.kind === "lifecycle") states.push(event.state);
    });

    const first = runtime.start();
    const second = runtime.start();
    expect(second).toBe(first);
    gate.resolve();
    await Promise.all([first, second]);

    expect(starts).toBe(1);
    expect(states).toEqual(["starting", "running"]);
  });

  it("shares a start re-entered by a lifecycle listener", async () => {
    const gate = deferred();
    let starts = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: () => {
          starts += 1;
          return gate.promise;
        },
        stop: async () => undefined,
      },
    });
    let nested: Promise<void> | undefined;
    runtime.subscribe((event) => {
      if (event.kind === "lifecycle" && event.state === "starting" && !nested) {
        nested = runtime.start();
      }
    });

    const first = runtime.start();
    expect(nested).toBe(first);
    gate.resolve();
    await first;

    expect(starts).toBe(1);
  });

  it("queues a reentrant stop until every listener receives starting", async () => {
    const deliveries: string[] = [];
    let stopping: Promise<void> | undefined;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
    });
    runtime.subscribe((event) => {
      if (event.kind !== "lifecycle") return;
      deliveries.push(`first:${event.state}`);
      if (event.state === "starting") stopping = runtime.stop("process_exit");
    });
    runtime.subscribe((event) => {
      if (event.kind === "lifecycle") deliveries.push(`second:${event.state}`);
    });

    await runtime.start();
    await stopping;

    expect(deliveries).toEqual([
      "first:starting",
      "second:starting",
      "first:stopping",
      "second:stopping",
      "first:stopped",
      "second:stopped",
    ]);
    expect(runtime.snapshot().lifecycle).toBe("stopped");
  });

  it("does not publish running when a Codex-ready listener stops startup", async () => {
    const deliveries: string[] = [];
    let stopping: Promise<void> | undefined;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      codex: {
        model: () => "gpt-5.6-terra",
      },
    });
    runtime.subscribe((event) => {
      if (event.kind === "codex") {
        deliveries.push(`first:codex:${event.state.state}`);
        if (event.state.state === "ready") stopping = runtime.stop("process_exit");
      }
      if (event.kind === "lifecycle") deliveries.push(`first:lifecycle:${event.state}`);
    });
    runtime.subscribe((event) => {
      if (event.kind === "codex") deliveries.push(`second:codex:${event.state.state}`);
      if (event.kind === "lifecycle") deliveries.push(`second:lifecycle:${event.state}`);
    });

    await runtime.start();
    await stopping;

    expect(deliveries).toContain("first:codex:ready");
    expect(deliveries).toContain("second:codex:ready");
    expect(deliveries).not.toContain("first:lifecycle:running");
    expect(deliveries).not.toContain("second:lifecycle:running");
    expect(deliveries.indexOf("second:codex:ready")).toBeLessThan(
      deliveries.indexOf("first:lifecycle:stopping"),
    );
    expect(runtime.snapshot().lifecycle).toBe("stopped");
  });

  it("fences a stop during startup from later publishing running", async () => {
    const gate = deferred();
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: () => gate.promise,
        stop: async () => undefined,
      },
    });
    const states: string[] = [];
    runtime.subscribe((event) => {
      if (event.kind === "lifecycle") states.push(event.state);
    });

    const starting = runtime.start();
    await runtime.stop("process_exit");
    gate.resolve();
    await starting;

    expect(states).toEqual(["starting", "stopping", "stopped"]);
    expect(runtime.snapshot().lifecycle).toBe("stopped");
  });

  it("publishes failed with a bounded sanitized error and delegates startup cleanup", async () => {
    let stops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => {
          throw new Error("secret=sk-test-credential C:\\Users\\Owner\\private lease-super-secret");
        },
        stop: async () => {
          stops += 1;
        },
      },
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await expect(runtime.start()).rejects.toThrow("Runtime failed to start");

    const snapshot = runtime.snapshot();
    expect(snapshot).toMatchObject({
      lifecycle: "failed",
      minecraft: { state: "disconnected", sessionId: null },
      codex: { state: "failed", model: null },
      lastError: {
        code: "RUNTIME_START_FAILED",
        message: "Runtime failed to start",
      },
    });
    expect(stops).toBe(1);
    expect(events).toContainEqual({
      kind: "error",
      revision: 6,
      error: {
        code: "RUNTIME_START_FAILED",
        message: "Runtime failed to start",
      },
    });
    const serialized = JSON.stringify({ snapshot, events });
    expect(serialized).not.toContain("sk-test");
    expect(serialized).not.toContain("C:\\Users");
    expect(serialized).not.toContain("lease-super-secret");
    await expect(runtime.start()).rejects.toThrow("create a new runtime");
  });

  it("shares concurrent stop, preserves the first exact reason, and rejects restart", async () => {
    const gate = deferred();
    const reasons: TaskStopReason[] = [];
    let lifecycleStops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: () => {
          lifecycleStops += 1;
          return gate.promise;
        },
      },
      task: {
        current: () => null,
        budget: inactiveBudget,
        stop: (reason) => reasons.push(reason),
      },
    });
    await runtime.start();

    const first = runtime.stop("emergency_stop");
    const second = runtime.stop("owner_stop");
    expect(second).toBe(first);
    gate.resolve();
    await Promise.all([first, second]);
    await runtime.stop("completed");

    expect(reasons).toEqual(["emergency_stop"]);
    expect(lifecycleStops).toBe(1);
    await expect(runtime.start()).rejects.toThrow("create a new runtime");
  });

  it("continues lifecycle cleanup and hides task state when invalidation fails", async () => {
    let lifecycleStops = 0;
    const leaseId = "lease-stop-failure-secret";
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
        },
      },
      task: {
        current: () => ({
          id: leaseId,
          lease: { id: leaseId, startedAt: 1_700_000_000_000 },
          disclosure: {
            goal: "Build safely",
            expectedActions: ["place"],
            limits: { ...inactiveBudget().limits },
            stopCondition: "Build complete",
          },
          startedAt: "2023-11-14T22:13:20.000Z",
        }),
        budget: () => ({
          ...inactiveBudget(),
          active: true,
          startedAt: 1_700_000_000_000,
        }),
        stop: () => {
          throw new Error(`failed to invalidate ${leaseId} at C:\\private`);
        },
      },
      createPublicTaskId: () => "task_public_stop_failure_task",
    });
    await runtime.start();

    await expect(runtime.stop("emergency_stop")).rejects.toThrow("Runtime failed to stop");

    expect(lifecycleStops).toBe(1);
    const snapshot = runtime.snapshot();
    expect(snapshot).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: {
        code: "RUNTIME_STOP_FAILED",
        message: "Runtime failed to stop",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(leaseId);
    expect(JSON.stringify(snapshot)).not.toContain("C:\\private");
  });

  it("fails closed when task invalidation returns but leaves the task active", async () => {
    const leaseId = "lease-noop-stop-secret";
    const reasons: TaskStopReason[] = [];
    let lifecycleStops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
        },
      },
      task: {
        current: () => ({
          id: leaseId,
          lease: { id: leaseId, startedAt: 1_700_000_000_000 },
          disclosure: {
            goal: "Build safely",
            expectedActions: ["place"],
            limits: { ...inactiveBudget().limits },
            stopCondition: "Build complete",
          },
          startedAt: "2023-11-14T22:13:20.000Z",
        }),
        budget: () => ({
          ...inactiveBudget(),
          active: true,
          startedAt: 1_700_000_000_000,
        }),
        stop: (reason) => {
          reasons.push(reason);
        },
      },
      createPublicTaskId: () => "task_public_noop_stop_task",
    });
    await runtime.start();

    await expect(runtime.stop("world_changed")).rejects.toThrow("Runtime failed to stop");

    expect(reasons).toEqual(["world_changed"]);
    expect(lifecycleStops).toBe(1);
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: {
        code: "RUNTIME_STOP_FAILED",
        message: "Runtime failed to stop",
      },
    });
    expect(JSON.stringify(runtime.snapshot())).not.toContain(leaseId);
  });

  it("treats an accessor throw after invalidation as unknown and still cleans up", async () => {
    const leaseId = "lease-accessor-throw-secret";
    let invalidated = false;
    let lifecycleStops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
        },
      },
      task: {
        current: () => {
          if (invalidated) throw new Error(`cannot read ${leaseId} at C:\\private`);
          return {
            id: leaseId,
            lease: { id: leaseId, startedAt: 1_700_000_000_000 },
            disclosure: {
              goal: "Build safely",
              expectedActions: ["place"],
              limits: { ...inactiveBudget().limits },
              stopCondition: "Build complete",
            },
            startedAt: "2023-11-14T22:13:20.000Z",
          };
        },
        budget: () => ({
          ...inactiveBudget(),
          active: !invalidated,
          stopReason: invalidated ? "emergency_stop" : null,
          startedAt: invalidated ? null : 1_700_000_000_000,
        }),
        stop: () => {
          invalidated = true;
        },
      },
      createPublicTaskId: () => "task_public_accessor_throw_task",
    });
    await runtime.start();

    await expect(runtime.stop("emergency_stop")).rejects.toThrow("Runtime failed to stop");

    expect(lifecycleStops).toBe(1);
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: {
        code: "RUNTIME_STOP_FAILED",
        message: "Runtime failed to stop",
      },
    });
    const serialized = JSON.stringify(runtime.snapshot());
    expect(serialized).not.toContain(leaseId);
    expect(serialized).not.toContain("C:\\private");
  });

  it("fences task events during cleanup and rejects a task created late", async () => {
    const lateLeaseId = "lease-created-during-cleanup";
    let active: ActiveTask | null = null;
    let budget = inactiveBudget();
    let taskListener: (() => void) | undefined;
    const publishedTasks: RuntimeEvent[] = [];
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          active = {
            id: lateLeaseId,
            lease: { id: lateLeaseId, startedAt: 1_700_000_000_000 },
            disclosure: {
              goal: "Late unsafe task",
              expectedActions: ["place"],
              limits: { ...inactiveBudget().limits },
              stopCondition: "Never",
            },
            startedAt: "2023-11-14T22:13:20.000Z",
          };
          budget = {
            ...inactiveBudget(),
            active: true,
            startedAt: 1_700_000_000_000,
          };
          taskListener?.();
        },
      },
      task: {
        current: () => active,
        budget: () => budget,
        stop: () => undefined,
        subscribe: (listener) => {
          taskListener = listener;
          return () => {
            taskListener = undefined;
          };
        },
      },
      createPublicTaskId: () => "task_public_late_cleanup_task",
    });
    runtime.subscribe((event) => {
      if (event.kind === "task") publishedTasks.push(event);
    });
    await runtime.start();

    await expect(runtime.stop("process_exit")).rejects.toThrow("Runtime failed to stop");

    expect(publishedTasks).not.toContainEqual(
      expect.objectContaining({
        kind: "task",
        task: expect.objectContaining({ id: "public-late-cleanup-task" }),
      }),
    );
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: {
        code: "RUNTIME_STOP_FAILED",
        message: "Runtime failed to stop",
      },
    });
    expect(JSON.stringify(runtime.snapshot())).not.toContain(lateLeaseId);
  });

  it("maps Minecraft and Codex startup, connection, outage, and terminal states", async () => {
    let minecraftListener: ((event: { kind: string; reason?: string }) => void) | undefined;
    let selectedModel: string | null = null;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => {
          selectedModel = "gpt-5.6-terra";
        },
        stop: async () => undefined,
      },
      minecraft: {
        subscribe: (listener) => {
          minecraftListener = listener as (event: { kind: string; reason?: string }) => void;
          return () => {
            minecraftListener = undefined;
          };
        },
      },
      codex: { model: () => selectedModel },
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.start();
    expect(events).toContainEqual({
      kind: "minecraft",
      revision: 2,
      state: { state: "connecting", sessionId: null },
    });
    expect(events).toContainEqual({
      kind: "codex",
      revision: 3,
      state: { state: "starting", model: null },
    });
    expect(runtime.snapshot().codex).toEqual({
      state: "ready",
      model: "gpt-5.6-terra",
    });

    minecraftListener?.({ kind: "connected" });
    expect(runtime.snapshot().minecraft).toEqual({
      state: "connected",
      sessionId: null,
    });
    minecraftListener?.({ kind: "world_changed" });
    expect(runtime.snapshot()).toMatchObject({
      minecraft: { state: "disconnected", sessionId: null },
      lastError: null,
    });
    minecraftListener?.({
      kind: "disconnected",
      reason: "network outage",
    });
    expect(runtime.snapshot().minecraft).toEqual({
      state: "reconnecting",
      sessionId: null,
    });

    await runtime.stop("process_exit");
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "stopped",
      minecraft: { state: "disconnected", sessionId: null },
      codex: { state: "stopped", model: null },
    });
  });

  it("ignores a late Minecraft connection while terminal cleanup is pending", async () => {
    const stopGate = deferred();
    let minecraftListener: ((event: { kind: string }) => void) | undefined;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: () => stopGate.promise,
      },
      minecraft: {
        subscribe: (listener) => {
          minecraftListener = listener as (event: { kind: string }) => void;
          return () => {
            minecraftListener = undefined;
          };
        },
      },
    });
    await runtime.start();
    minecraftListener?.({ kind: "connected" });

    const stopping = runtime.stop("process_exit");
    minecraftListener?.({ kind: "connected" });

    expect(runtime.snapshot().minecraft).toEqual({
      state: "disconnected",
      sessionId: null,
    });
    stopGate.resolve();
    await stopping;
  });

  it("maps tasks to a stable public ID without serializing the lease", () => {
    let taskListener: (() => void) | undefined;
    let status: "running" | "waiting_confirmation" = "running";
    let budget: TaskBudgetSnapshot = {
      ...inactiveBudget(),
      active: true,
      startedAt: 1_700_000_000_000,
    };
    let active: ActiveTask | null = {
      id: "lease-super-secret",
      lease: { id: "lease-super-secret", startedAt: 1_700_000_000_000 },
      disclosure: {
        goal: "Build a safe house",
        expectedActions: ["move", "place"],
        limits: { ...budget.limits },
        stopCondition: "House complete",
      },
      startedAt: "2023-11-14T22:13:20.000Z",
    };
    let publicIds = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: () => active,
        budget: () => budget,
        status: () => status,
        stop: () => undefined,
        subscribe: (listener) => {
          taskListener = listener;
          return () => {
            taskListener = undefined;
          };
        },
      },
      createPublicTaskId: () => {
        publicIds += 1;
        return "task_public_1";
      },
    });

    const first = runtime.snapshot();
    const second = runtime.snapshot();
    expect(first.task).toEqual({
      id: "task_public_1",
      goal: "Build a safe house",
      status: "running",
      allowedActions: ["move", "place"],
      effectiveLimits: budget.limits,
      startedAt: "2023-11-14T22:13:20.000Z",
      budget,
    });
    expect(second.task?.id).toBe("task_public_1");
    expect(second.task?.id).not.toBe(active.lease.id);
    expect(publicIds).toBe(1);
    expect(JSON.stringify({ first, second })).not.toContain("lease-super-secret");
    expect(JSON.stringify({ first, second })).not.toContain("ownerUsername");
    expect(JSON.stringify({ first, second })).not.toContain("prompt");

    const observed: RuntimeEvent[] = [];
    runtime.subscribe((event) => {
      if (event.kind === "task" && event.task) {
        (event.task.allowedActions as string[]).push("mutated");
      }
    });
    runtime.subscribe((event) => observed.push(event));
    budget = { ...budget, toolCalls: 1 };
    taskListener?.();

    expect(observed.at(-1)).toMatchObject({
      kind: "task",
      task: {
        id: "task_public_1",
        goal: "Build a safe house",
        status: "running",
        allowedActions: ["move", "place"],
        effectiveLimits: budget.limits,
        budget: { toolCalls: 1 },
      },
    });
    status = "waiting_confirmation";
    taskListener?.();
    expect(observed.at(-1)).toMatchObject({
      kind: "task",
      task: { id: "task_public_1", status: "waiting_confirmation" },
    });
    active = null;
    budget = { ...budget, active: false, stopReason: "completed", startedAt: null };
    taskListener?.();
    expect(observed.at(-1)).toEqual({ kind: "task", revision: 3, task: null });
  });

  it("stops only the current task idempotently while preserving runtime authority", async () => {
    let active: ActiveTask | null = activeTaskFixture();
    let budget = activeBudgetFixture();
    const stopReasons: TaskStopReason[] = [];
    let lifecycleStops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
        },
      },
      codex: { model: () => "gpt-5.6" },
      task: {
        current: () => active,
        budget: () => budget,
        status: () => "running",
        stop: (reason) => {
          stopReasons.push(reason);
          active = null;
          budget = { ...budget, active: false, stopReason: reason, startedAt: null };
        },
      },
      createPublicTaskId: () => "task_stop_only",
    });
    await runtime.start();
    const authorityBefore = runtime.snapshot();

    await expect(runtime.stopTask()).resolves.toBeUndefined();
    await expect(runtime.stopTask()).resolves.toBeUndefined();

    expect(stopReasons).toEqual(["owner_stop"]);
    expect(lifecycleStops).toBe(0);
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: authorityBefore.lifecycle,
      minecraft: authorityBefore.minecraft,
      codex: authorityBefore.codex,
      task: null,
      lastError: null,
    });
  });

  it("redacts credentials and local paths from every public disclosure string", () => {
    let taskListener: (() => void) | undefined;
    const budget = activeBudgetFixture();
    const task = activeTaskFixture();
    task.disclosure = {
      ...task.disclosure,
      goal: `Collect spruce safely password=hunter2 Authorization: Bearer abc+def== Bearer abcdefghijklmnopqrstuvwxyz.123456 Bearer abcdefghijklmnop+private== authorization: bearer abcdefghijklmnop/private= at C:\\Users\\Owner\\private with ${task.lease.id}`,
      expectedActions: [
        "move SERVICE_TOKEN=private-action-token",
        "place redis://player:private-uri-password@localhost/world",
        String.raw`inspect \\workstation\owner-share\private`,
        JSON.stringify({ token: "json-private-secret", note: "craft safely" }),
        "wait turnLease=turn-private-lease-id",
        "read file:///home/file-owner/private and file:///D:/PrivateWorkspace/owner/private",
        "connect https://opaque-access-token@example.invalid/world",
        "connect redis://cache-user%3Aprivate-password@example.invalid/0",
      ],
      stopCondition:
        "Stop safely under %USERPROFILE%\\WhiteLily or ~/private or /home/owner/private or /var/tmp/private",
    };
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: () => task,
        budget: () => budget,
        stop: () => undefined,
        subscribe: (listener) => {
          taskListener = listener;
          return () => {
            taskListener = undefined;
          };
        },
      },
      createPublicTaskId: () => "task_public_redacted_task",
    });
    const taskEvents: RuntimeEvent[] = [];
    runtime.subscribe((event) => {
      if (event.kind === "task") taskEvents.push(event);
    });

    taskListener?.();

    const snapshot = runtime.snapshot();
    const cliJson = JSON.stringify({ snapshot, events: taskEvents });
    expect(snapshot.task?.goal).toContain("Collect spruce safely");
    expect(task.disclosure.goal).toContain("hunter2");
    expect(task.disclosure.goal).toContain(task.lease.id);
    expect(snapshot.task?.allowedActions).toHaveLength(8);
    expect(cliJson).toContain("craft safely");
    expect(cliJson).not.toContain("Stop safely");
    for (const sensitive of [
      "hunter2",
      "abc+def==",
      "abcdefghijklmnopqrstuvwxyz.123456",
      "+private==",
      "/private=",
      "opaque-access-token",
      "cache-user%3Aprivate-password",
      "private-action-token",
      "private-uri-password",
      "json-private-secret",
      "turn-private-lease-id",
      "C:\\Users\\Owner",
      "\\\\workstation\\owner-share",
      "%USERPROFILE%",
      "~/private",
      "/home/owner",
      "/var/tmp/private",
      "/home/file-owner",
      "D:/PrivateWorkspace/owner",
      task.lease.id,
    ]) {
      expect(cliJson).not.toContain(sensitive);
    }
    expect(Object.isFrozen(snapshot.task)).toBe(true);
    expect(Object.isFrozen(snapshot.task?.allowedActions)).toBe(true);
    expect(Object.isFrozen(taskEvents.at(-1))).toBe(true);
  });

  it("fully consumes spaced and quoted paths and embedded credentials in every public disclosure", () => {
    const windowsRaw = "C:" + String.raw`\Users\Jane Doe\Private Notes\todo.txt`;
    const windowsEscaped = "C:" + String.raw`\\Users\\Jane Doe\\Escaped Notes\\todo.txt`;
    const windowsForward = "D:/" + "Users/Jane Doe/Forward Notes/todo.txt";
    const fileWindows = "file:///C:/" + "Users/Jane%20Doe/Private%20Notes/todo.txt";
    const task = activeTaskFixture();
    task.disclosure = {
      ...task.disclosure,
      goal: `Inspect ${windowsRaw}, "${windowsEscaped}", and '${windowsForward}'; password="Jane Doe private phrase" token='Jane Doe\\'s token value'`,
      expectedActions: [
        String.raw`read "\\server\Jane Doe\Secret Share\plan.txt" credential="credential value with spaces"`,
        String.raw`read '//server/Jane Doe/Forward Share/plan.txt' secret='secret value with spaces'`,
        String.raw`read '\\server/Jane Doe/Mixed Share\plan.txt' lease="lease value with spaces"`,
        `inspect before {"password":"Jane Doe json password","token":"Jane Doe json token","note":"safe"} after`,
        "connect https://Jane%20Doe:secret%20password@example.invalid/world",
      ],
      stopCondition: `Stop after ${fileWindows}, "file:///home/Jane Doe/Private Notes/todo.txt", ~/Jane Doe/Home Notes/todo.txt, and /var/lib/Jane Doe/Unix Notes/todo.txt; password='final spaced password'`,
    };
    let taskListener: (() => void) | undefined;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: () => task,
        budget: activeBudgetFixture,
        stop: () => undefined,
        subscribe: (listener) => {
          taskListener = listener;
          return () => undefined;
        },
      },
      createPublicTaskId: () => "task_public_spaced_redaction_task",
    });
    const taskEvents: RuntimeEvent[] = [];
    runtime.subscribe((event) => {
      if (event.kind === "task") taskEvents.push(event);
    });

    taskListener?.();

    const publicValues = [
      JSON.stringify(runtime.snapshot()),
      JSON.stringify(taskEvents),
      JSON.stringify({ snapshot: runtime.snapshot(), events: taskEvents }),
    ];
    for (const serialized of publicValues) {
      for (const privateSuffix of [
        "Jane Doe",
        "Private Notes",
        "Escaped Notes",
        "Forward Notes",
        "Secret Share",
        "Forward Share",
        "Mixed Share",
        "private phrase",
        "token value",
        "credential value",
        "secret value",
        "lease value",
        "json password",
        "json token",
        "secret%20password",
        "Home Notes",
        "Unix Notes",
        "final spaced password",
      ]) {
        expect(serialized).not.toContain(privateSuffix);
      }
      expect(serialized).toContain("safe");
    }
    expect(task.disclosure.goal).toContain("Jane Doe");
    expect(task.disclosure.expectedActions[3]).toContain("json password");
    expect(task.disclosure.stopCondition).toContain("Private Notes");
  });

  it("never exposes path suffixes after valid punctuation or bare profile fragments", () => {
    const punctuatedDrive =
      "C:" + String.raw`\Users\Jane,Doe\Folder(1)\draft[final]{private};notes.txt`;
    const escapedQuotedDrive =
      "D:" + String.raw`\Users\Jane Doe\Quote\"Inside\Private Notes\draft.txt`;
    const forwardDrive = "E:/" + "Users/Jane Doe/Forward,Notes/(draft)[private]{v1}.txt";
    const fileSingleSlash = "file:/C:/" + "Users/Jane Doe/Single,Slash/(private)[draft]{v1}.txt";
    const task = activeTaskFixture();
    task.disclosure = {
      ...task.disclosure,
      goal: `Inspect ${punctuatedDrive}\nthen "${escapedQuotedDrive}" and "${fileSingleSlash}"`,
      expectedActions: [
        `read '${forwardDrive}'`,
        String.raw`read "Users\Jane Doe\Bare,Profile\(private)[draft]{v1}.txt"`,
        String.raw`read '//server/Jane Doe/Forward,Share/(private)[draft]{v1}.txt'`,
        String.raw`read "\\server/Jane Doe\Mixed,Share/(private)[draft]{v1}.txt"`,
        "read 'home/Jane Doe/Bare,Home/(private)[draft]{v1}.txt'",
      ],
      stopCondition:
        `Stop after file://server/Jane Doe/Raw,Share/(private)[draft]{v1}.txt\n` +
        `or "file:///home/Jane Doe/Triple,Slash/(private)[draft]{v1}.txt"\n` +
        `or /var/lib/Jane Doe/Unix,Path/(private)[draft]{v1}.txt\n` +
        `or ~/Jane Doe/Home,Path/(private)[draft]{v1}.txt`,
    };
    let taskListener: (() => void) | undefined;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: () => task,
        budget: activeBudgetFixture,
        stop: () => undefined,
        subscribe: (listener) => {
          taskListener = listener;
          return () => undefined;
        },
      },
      createPublicTaskId: () => "task_public_punctuated_path_task",
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => {
      if (event.kind === "task") events.push(event);
    });

    taskListener?.();

    for (const serialized of [
      JSON.stringify(runtime.snapshot()),
      JSON.stringify(events),
      JSON.stringify({ snapshot: runtime.snapshot(), events }),
    ]) {
      for (const privateSuffix of [
        "Jane,Doe",
        "Jane Doe",
        "Folder(1)",
        "draft[final]",
        "{private}",
        "Quote",
        "Inside",
        "Private Notes",
        "Forward,Notes",
        "Bare,Profile",
        "Forward,Share",
        "Mixed,Share",
        "Bare,Home",
        "Raw,Share",
        "Triple,Slash",
        "Unix,Path",
        "Home,Path",
        "(private)",
        "[draft]",
        "{v1}",
      ]) {
        expect(serialized).not.toContain(privateSuffix);
      }
      expect(serialized).not.toContain("fil[REDACTED_PATH]");
      expect(serialized).not.toContain("file:");
    }
  });

  it("bounds public task text by Unicode code points without splitting safe text", () => {
    const task = activeTaskFixture();
    task.disclosure = {
      ...task.disclosure,
      goal: `Keep safe ${"🌸".repeat(4_100)}`,
      expectedActions: [`move-${"🌿".repeat(300)}`],
      stopCondition: `Stop safely ${"🛑".repeat(4_100)}`,
    };
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: () => task,
        budget: activeBudgetFixture,
        stop: () => undefined,
      },
      createPublicTaskId: () => "task_public_unicode_task",
    });

    const publicTask = runtime.snapshot().task;
    expect(publicTask?.goal.startsWith("Keep safe ")).toBe(true);
    expect(Array.from(publicTask?.goal ?? "")).toHaveLength(4_000);
    expect(Array.from(publicTask?.allowedActions[0] ?? "")).toHaveLength(256);
    expect(publicTask?.goal.endsWith("🌸")).toBe(true);
    expect(publicTask?.allowedActions[0]?.endsWith("🌿")).toBe(true);
    expect(JSON.stringify(publicTask)).not.toContain("Stop safely");
  });

  it("fails closed before scanning a disclosure string above the raw work bound", () => {
    const task = activeTaskFixture();
    task.disclosure.goal = "x".repeat(32_001);
    let taskStops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: () => task,
        budget: activeBudgetFixture,
        stop: () => {
          taskStops += 1;
        },
      },
    });

    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: { code: "TASK_STATE_UNKNOWN" },
    });
    expect(taskStops).toBe(1);
  });

  it("scans a near-limit adversarial disclosure in bounded linear time", () => {
    const task = activeTaskFixture();
    const adversarialUnit = String.raw`a"'\b`;
    task.disclosure.goal = adversarialUnit
      .repeat(Math.ceil(32_000 / adversarialUnit.length))
      .slice(0, 32_000);
    const started = performance.now();

    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: () => task,
        budget: activeBudgetFixture,
        stop: () => undefined,
      },
      createPublicTaskId: () => "task_public_linear_scan_task",
    });
    const snapshot = runtime.snapshot();
    const elapsed = performance.now() - started;

    expect(snapshot.lifecycle).toBe("idle");
    expect(Array.from(snapshot.task?.goal ?? "")).toHaveLength(4_000);
    expect(elapsed).toBeLessThan(500);
  });

  it("never truncates a sanitization marker into a misleading fragment", () => {
    const task = activeTaskFixture();
    task.disclosure.goal = `${"a".repeat(3_990)} C:\\Users\\Owner\\private`;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: () => task,
        budget: activeBudgetFixture,
        stop: () => undefined,
      },
      createPublicTaskId: () => "task_public_marker_boundary_task",
    });

    const goal = runtime.snapshot().task?.goal ?? "";
    expect(Array.from(goal).length).toBeLessThanOrEqual(4_000);
    expect(goal).not.toMatch(/\[REDACTED(?:_[A-Z]*)?$/u);
    expect(goal).not.toContain("C:\\Users\\Owner");
    expect(goal.endsWith(" ")).toBe(true);
  });

  it.each([
    {
      boundary: "active task",
      task: () =>
        ({
          ...activeTaskFixture(),
          leaseId: "EXTRA_LEASE_ID_SECRET",
        }) as ActiveTask,
      budget: activeBudgetFixture,
    },
    {
      boundary: "task lease",
      task: () => {
        const task = activeTaskFixture();
        return {
          ...task,
          lease: { ...task.lease, credential: "EXTRA_CREDENTIAL_SECRET" },
        } as ActiveTask;
      },
      budget: activeBudgetFixture,
    },
    {
      boundary: "task disclosure",
      task: () => {
        const task = activeTaskFixture();
        return {
          ...task,
          disclosure: { ...task.disclosure, path: "C:\\EXTRA_PRIVATE_PATH" },
        } as ActiveTask;
      },
      budget: activeBudgetFixture,
    },
    {
      boundary: "expected actions",
      task: () => {
        const task = activeTaskFixture();
        const actions = [...task.disclosure.expectedActions] as string[] & {
          credential?: string;
        };
        actions.credential = "EXTRA_ACTION_SECRET";
        return {
          ...task,
          disclosure: { ...task.disclosure, expectedActions: actions },
        };
      },
      budget: activeBudgetFixture,
    },
    {
      boundary: "disclosure limits",
      task: () => {
        const task = activeTaskFixture();
        return {
          ...task,
          disclosure: {
            ...task.disclosure,
            limits: {
              ...task.disclosure.limits,
              privateText: "X".repeat(10_000),
            },
          },
        } as ActiveTask;
      },
      budget: activeBudgetFixture,
    },
    {
      boundary: "task budget",
      task: activeTaskFixture,
      budget: () =>
        ({
          ...activeBudgetFixture(),
          leaseId: "EXTRA_BUDGET_LEASE_SECRET",
        }) as TaskBudgetSnapshot,
    },
  ])("rejects non-allowlisted properties at the $boundary boundary", ({ task, budget }) => {
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: task,
        budget,
        stop: () => undefined,
      },
      createPublicTaskId: () => "task_public_exact_shape_task",
    });

    const snapshot = runtime.snapshot();
    expect(snapshot).toMatchObject({
      task: null,
      lastError: {
        code: "TASK_STATE_UNKNOWN",
        message: "Task state is unavailable",
      },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("EXTRA_");
    expect(serialized.length).toBeLessThan(2_048);
  });

  it.each(["accessor", "non-enumerable"] as const)(
    "rejects a task disclosure with a %s required field without reading it",
    (descriptorKind) => {
      const task = activeTaskFixture();
      let accessorReads = 0;
      Object.defineProperty(task.disclosure, "goal", {
        configurable: true,
        enumerable: descriptorKind !== "non-enumerable",
        ...(descriptorKind === "accessor"
          ? {
              get: () => {
                accessorReads += 1;
                return "Accessor goal";
              },
            }
          : { value: "Hidden goal", writable: true }),
      });
      let taskStops = 0;
      const runtime = new RuntimeFacade({
        lifecycle: {
          start: async () => undefined,
          stop: async () => undefined,
        },
        task: {
          current: () => task,
          budget: activeBudgetFixture,
          stop: () => {
            taskStops += 1;
          },
        },
      });

      expect(runtime.snapshot()).toMatchObject({
        lifecycle: "failed",
        task: null,
        lastError: { code: "TASK_STATE_UNKNOWN" },
      });
      expect(accessorReads).toBe(0);
      expect(taskStops).toBe(1);
    },
  );

  it("rejects an accessor-backed expected-action index without reading it", () => {
    const task = activeTaskFixture();
    let accessorReads = 0;
    Object.defineProperty(task.disclosure.expectedActions, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return "place";
      },
    });
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: () => task,
        budget: activeBudgetFixture,
        stop: () => undefined,
      },
    });

    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: { code: "TASK_STATE_UNKNOWN" },
    });
    expect(accessorReads).toBe(0);
  });

  it("rejects a non-native expectedActions array without invoking overridden methods", () => {
    const task = activeTaskFixture();
    let overriddenCalls = 0;
    const injectedPrototype = Object.create(Array.prototype) as {
      map: typeof Array.prototype.map;
      some: typeof Array.prototype.some;
    };
    injectedPrototype.map = () => {
      overriddenCalls += 1;
      throw new Error("overridden map must not run");
    };
    injectedPrototype.some = () => {
      overriddenCalls += 1;
      throw new Error("overridden some must not run");
    };
    Object.setPrototypeOf(task.disclosure.expectedActions, injectedPrototype);
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: () => task,
        budget: activeBudgetFixture,
        stop: () => undefined,
      },
    });

    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: { code: "TASK_STATE_UNKNOWN" },
    });
    expect(overriddenCalls).toBe(0);
  });

  it("terminally revokes an active task whose observed shape becomes unknown", async () => {
    let active: ActiveTask | null = activeTaskFixture();
    let budget = activeBudgetFixture();
    let taskListener: (() => void) | undefined;
    let lifecycleStops = 0;
    const stopReasons: TaskStopReason[] = [];
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
        },
      },
      task: {
        current: () => active,
        budget: () => budget,
        stop: (reason) => {
          stopReasons.push(reason);
          active = null;
          budget = {
            ...inactiveBudget(),
            stopReason: reason,
          };
        },
        subscribe: (listener) => {
          taskListener = listener;
          return () => undefined;
        },
      },
      createPublicTaskId: () => "task_public_terminal_task",
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    await runtime.start();

    active = {
      ...activeTaskFixture(),
      disclosure: {
        ...activeTaskFixture().disclosure,
        path: "C:\\Users\\Owner\\private",
      },
    } as ActiveTask;
    budget = activeBudgetFixture();
    taskListener?.();

    expect(stopReasons).toEqual(["failed"]);
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: {
        code: "TASK_STATE_UNKNOWN",
        message: "Task state is unavailable",
      },
    });
    await expect(runtime.stop("process_exit")).resolves.toBeUndefined();
    expect(lifecycleStops).toBe(1);

    active = activeTaskFixture();
    budget = activeBudgetFixture();
    taskListener?.();
    expect(runtime.snapshot().task).toBeNull();
    expect(stopReasons).toEqual(["failed"]);
    const terminalErrorIndex = events.findIndex(
      (event) => event.kind === "error" && event.error.code === "TASK_STATE_UNKNOWN",
    );
    expect(terminalErrorIndex).toBeGreaterThanOrEqual(0);
    expect(events.slice(terminalErrorIndex + 1)).not.toContainEqual(
      expect.objectContaining({
        kind: "task",
        task: expect.objectContaining({ id: "public-terminal-task" }),
      }),
    );
  });

  it("fails constructor-time unknown task state synchronously and absorbs cleanup rejection", async () => {
    const leaseId = "lease-constructor-private";
    let lifecycleStops = 0;
    let taskStops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
          throw new Error(`cleanup password=hunter2 C:\\Users\\Owner\\private ${leaseId}`);
        },
      },
      task: {
        current: () => {
          throw new Error(`unknown ${leaseId}`);
        },
        budget: activeBudgetFixture,
        stop: () => {
          taskStops += 1;
        },
      },
    });

    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: {
        code: "TASK_STATE_UNKNOWN",
        message: "Task state is unavailable",
      },
    });
    expect(taskStops).toBe(1);
    await expect(runtime.stop("process_exit")).resolves.toBeUndefined();
    expect(lifecycleStops).toBe(1);
    const serialized = JSON.stringify(runtime.snapshot());
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("C:\\Users");
    expect(serialized).not.toContain(leaseId);
  });

  it.each(["task subscription", "Minecraft subscription"] as const)(
    "fails a constructor-time %s error through one observed cleanup promise",
    async (boundary) => {
      let lifecycleStops = 0;
      let taskStops = 0;
      const lifecycle = {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
        },
      };
      const task = {
        current: () => null,
        budget: inactiveBudget,
        stop: () => {
          taskStops += 1;
        },
      };
      const runtime =
        boundary === "task subscription"
          ? new RuntimeFacade({
              lifecycle,
              task: {
                ...task,
                subscribe: () => {
                  throw new Error("task subscribe password=hunter2 C:\\Users\\Owner\\private");
                },
              },
            })
          : new RuntimeFacade({
              lifecycle,
              task,
              minecraft: {
                subscribe: () => {
                  throw new Error("Minecraft subscribe password=hunter2 C:\\Users\\Owner\\private");
                },
              },
            });

      expect(runtime.snapshot()).toMatchObject({
        lifecycle: "failed",
        task: null,
        lastError: {
          code: boundary === "task subscription" ? "TASK_STATE_UNKNOWN" : "MINECRAFT_STATE_UNKNOWN",
        },
      });
      expect(taskStops).toBe(1);
      await expect(runtime.stop("process_exit")).resolves.toBeUndefined();
      expect(lifecycleStops).toBe(1);
      const serialized = JSON.stringify(runtime.snapshot());
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("C:\\Users");
    },
  );

  it("keeps the first unknown-state cause when task revocation and cleanup both throw", async () => {
    const leaseId = "lease-throwing-terminal-private";
    let taskStops = 0;
    let lifecycleStops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
          throw new Error(`cleanup ${leaseId} at C:\\Users\\Owner\\private`);
        },
      },
      task: {
        current: () =>
          ({
            ...activeTaskFixture(),
            lease: {
              ...activeTaskFixture().lease,
              credential: "private-extra-shape",
            },
          }) as ActiveTask,
        budget: activeBudgetFixture,
        stop: () => {
          taskStops += 1;
          throw new Error(`cannot revoke ${leaseId} password=hunter2`);
        },
      },
    });

    expect(taskStops).toBe(1);
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: {
        code: "TASK_STATE_UNKNOWN",
        message: "Task state is unavailable",
      },
    });
    await expect(runtime.stop("process_exit")).resolves.toBeUndefined();
    expect(lifecycleStops).toBe(1);
    const serialized = JSON.stringify(runtime.snapshot());
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("C:\\Users");
    expect(serialized).not.toContain(leaseId);
    expect(serialized).not.toContain("private-extra-shape");
  });

  it.each([
    "maxToolCalls",
    "maxBlockChanges",
    "maxHorizontalTravel",
    "maxDurationMs",
    "maxDangerousOperations",
  ] as const)("rejects a %s mismatch between disclosure and budget limits", (key) => {
    const task = activeTaskFixture();
    task.disclosure.limits[key] = task.disclosure.limits[key] - 1;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: () => task,
        budget: activeBudgetFixture,
        stop: () => undefined,
      },
    });

    expect(runtime.snapshot()).toMatchObject({
      task: null,
      lastError: {
        code: "TASK_STATE_UNKNOWN",
        message: "Task state is unavailable",
      },
    });
  });

  it.each([
    { counter: "toolCalls", limit: "maxToolCalls" },
    { counter: "blockChanges", limit: "maxBlockChanges" },
    { counter: "horizontalTravel", limit: "maxHorizontalTravel" },
    { counter: "dangerousOperations", limit: "maxDangerousOperations" },
  ] as const)("rejects $counter above $limit", ({ counter, limit }) => {
    const budget = activeBudgetFixture();
    budget[counter] = budget.limits[limit] + 1;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: activeTaskFixture,
        budget: () => budget,
        stop: () => undefined,
      },
    });

    expect(runtime.snapshot()).toMatchObject({
      task: null,
      lastError: {
        code: "TASK_STATE_UNKNOWN",
        message: "Task state is unavailable",
      },
    });
  });

  it("returns deeply frozen independent snapshots and event payloads", async () => {
    const runtime = createRuntimeFacadeHarness().runtime;
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    await runtime.start();

    const first = runtime.snapshot();
    const second = runtime.snapshot();
    expect(first).not.toBe(second);
    expect(first.minecraft).not.toBe(second.minecraft);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.minecraft)).toBe(true);
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it("terminally revokes a task when its public ID would equal the lease ID", async () => {
    const leaseId = "lease-compatible-id";
    let taskStops = 0;
    let lifecycleStops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
        },
      },
      task: {
        current: () => ({
          id: leaseId,
          lease: { id: leaseId, startedAt: 1_700_000_000_000 },
          disclosure: {
            goal: "Build safely",
            expectedActions: ["place"],
            limits: { ...inactiveBudget().limits },
            stopCondition: "Build complete",
          },
          startedAt: "2023-11-14T22:13:20.000Z",
        }),
        budget: () => ({
          ...inactiveBudget(),
          active: true,
          startedAt: 1_700_000_000_000,
        }),
        stop: () => {
          taskStops += 1;
        },
      },
      createPublicTaskId: () => leaseId,
    });

    const snapshot = runtime.snapshot();
    expect(snapshot).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: {
        code: "TASK_STATE_UNKNOWN",
        message: "Task state is unavailable",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(leaseId);
    expect(taskStops).toBe(1);
    await expect(runtime.stop("process_exit")).resolves.toBeUndefined();
    expect(lifecycleStops).toBe(1);
  });

  it.each([
    ["private lease as a prefix", (leaseId: string) => `${leaseId}-public`],
    ["private lease as a suffix", (leaseId: string) => `public-${leaseId}`],
  ])("terminally rejects a generated public ID containing the %s", async (_label, publicId) => {
    const task = activeTaskFixture();
    let taskStops = 0;
    let lifecycleStops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
        },
      },
      task: {
        current: () => task,
        budget: activeBudgetFixture,
        stop: () => {
          taskStops += 1;
        },
      },
      createPublicTaskId: () => publicId(task.lease.id),
    });

    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: { code: "TASK_STATE_UNKNOWN" },
    });
    expect(JSON.stringify(runtime.snapshot())).not.toContain(task.lease.id);
    expect(taskStops).toBe(1);
    await expect(runtime.stop("process_exit")).resolves.toBeUndefined();
    expect(lifecycleStops).toBe(1);
  });

  it.each([
    ["uppercase characters", "task_Public_1"],
    ["a missing task prefix", "public_task_1"],
    ["an empty task suffix", "task_"],
  ])("terminally rejects a generated public ID with %s", async (_label, generatedId) => {
    let taskStops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: activeTaskFixture,
        budget: activeBudgetFixture,
        stop: () => {
          taskStops += 1;
        },
      },
      createPublicTaskId: () => generatedId,
    });

    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: { code: "TASK_STATE_UNKNOWN" },
    });
    expect(taskStops).toBe(1);
  });

  it("terminally fails closed without publishing a task when public ID generation throws", async () => {
    let taskSubscriptions = 0;
    let taskStops = 0;
    let lifecycleStops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
        },
      },
      task: {
        current: activeTaskFixture,
        budget: activeBudgetFixture,
        stop: () => {
          taskStops += 1;
        },
        subscribe: () => {
          taskSubscriptions += 1;
          return () => undefined;
        },
      },
      createPublicTaskId: () => {
        throw new Error("private generator failure");
      },
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: { code: "TASK_STATE_UNKNOWN" },
    });
    expect(events).toEqual([]);
    expect(taskSubscriptions).toBe(0);
    expect(taskStops).toBe(1);
    await expect(runtime.stop("process_exit")).resolves.toBeUndefined();
    expect(lifecycleStops).toBe(1);
  });

  it.each(malformedMinecraftCases)(
    "terminally rejects a known Minecraft event when %s",
    async (_label, malformedEvent) => {
      let minecraftListener: ((event: unknown) => void) | undefined;
      let taskStops = 0;
      let lifecycleStops = 0;
      const runtime = new RuntimeFacade({
        lifecycle: {
          start: async () => undefined,
          stop: async () => {
            lifecycleStops += 1;
          },
        },
        task: {
          current: activeTaskFixture,
          budget: activeBudgetFixture,
          stop: () => {
            taskStops += 1;
          },
        },
        minecraft: {
          subscribe: (listener) => {
            minecraftListener = listener as (event: unknown) => void;
            return () => undefined;
          },
        },
        createPublicTaskId: () => "task_public_malformed_minecraft_task",
      });
      await runtime.start();

      minecraftListener?.(malformedEvent);

      expect(runtime.snapshot()).toMatchObject({
        lifecycle: "failed",
        minecraft: { state: "disconnected", sessionId: null },
        task: null,
        lastError: { code: "MINECRAFT_STATE_UNKNOWN" },
      });
      expect(taskStops).toBe(1);
      await expect(runtime.stop("process_exit")).resolves.toBeUndefined();
      expect(lifecycleStops).toBe(1);
    },
  );

  it("does not invoke an accessor while rejecting a malformed Minecraft event", () => {
    minecraftAccessorReads = 0;
    let minecraftListener: ((event: unknown) => void) | undefined;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      minecraft: {
        subscribe: (listener) => {
          minecraftListener = listener as (event: unknown) => void;
          return () => undefined;
        },
      },
    });

    minecraftListener?.(accessorBackedOwnerOffline);

    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      lastError: { code: "MINECRAFT_STATE_UNKNOWN" },
    });
    expect(minecraftAccessorReads).toBe(0);
  });

  it("accepts exact bounded Minecraft event variants including world_changed", async () => {
    let minecraftListener: ((event: unknown) => void) | undefined;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      minecraft: {
        subscribe: (listener) => {
          minecraftListener = listener as (event: unknown) => void;
          return () => undefined;
        },
      },
    });
    await runtime.start();

    for (const event of [
      { kind: "connected" },
      { kind: "connected", reason: "ready" },
      { kind: "disconnected", reason: "retry" },
      { kind: "chat", username: "owner", message: "hello" },
      { kind: "owner_online", username: "owner" },
      { kind: "owner_offline", username: "owner" },
      { kind: "death" },
      {
        kind: "hostile_nearby",
        entityId: 1,
        entityKind: "zombie",
        position: { x: 0.5, y: 64, z: -2.5 },
      },
      { kind: "world_changed" },
    ]) {
      minecraftListener?.(event);
    }

    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "running",
      minecraft: { state: "disconnected", sessionId: null },
      lastError: null,
    });
  });

  it("isolates listener exceptions and fails unknown backend state closed", () => {
    let minecraftListener: ((event: unknown) => void) | undefined;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      minecraft: {
        subscribe: (listener) => {
          minecraftListener = listener as (event: unknown) => void;
          return () => undefined;
        },
      },
    });
    const observed: RuntimeEvent[] = [];
    runtime.subscribe(() => {
      throw new Error("desktop listener failed");
    });
    runtime.subscribe((event) => observed.push(event));

    expect(() =>
      minecraftListener?.({
        kind: "unknown",
        credential: "sk-test-credential",
        path: "C:\\Users\\Owner\\private",
        leaseId: "lease-super-secret",
      }),
    ).not.toThrow();

    expect(runtime.snapshot()).toMatchObject({
      minecraft: { state: "disconnected", sessionId: null },
      lastError: {
        code: "MINECRAFT_STATE_UNKNOWN",
        message: "Minecraft state is unavailable",
      },
    });
    const serialized = JSON.stringify({ snapshot: runtime.snapshot(), observed });
    expect(serialized.length).toBeLessThan(4_096);
    expect(serialized).not.toContain("sk-test");
    expect(serialized).not.toContain("C:\\Users");
    expect(serialized).not.toContain("lease-super-secret");
  });

  it("terminally fails a malformed Minecraft event during reentrant publication", async () => {
    let minecraftListener: ((event: unknown) => void) | undefined;
    let active: ActiveTask | null = activeTaskFixture();
    let budget = activeBudgetFixture();
    let lifecycleStops = 0;
    const stopReasons: TaskStopReason[] = [];
    const deliveries: string[] = [];
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
        },
      },
      task: {
        current: () => active,
        budget: () => budget,
        stop: (reason) => {
          stopReasons.push(reason);
          active = null;
          budget = { ...inactiveBudget(), stopReason: reason };
        },
      },
      minecraft: {
        subscribe: (listener) => {
          minecraftListener = listener as (event: unknown) => void;
          return () => undefined;
        },
      },
      createPublicTaskId: () => "task_public_reentrant_task",
    });
    let injectedUnknown = false;
    runtime.subscribe((event) => {
      deliveries.push(`first:${event.kind}`);
      if (!injectedUnknown && event.kind === "minecraft" && event.state.state === "connected") {
        injectedUnknown = true;
        minecraftListener?.({
          kind: "unknown",
          credential: "sk-test-credential",
          path: "C:\\Users\\Owner\\private",
        });
      }
    });
    runtime.subscribe((event) => deliveries.push(`second:${event.kind}`));
    await runtime.start();

    minecraftListener?.({ kind: "connected" });

    expect(stopReasons).toEqual(["failed"]);
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      minecraft: { state: "disconnected", sessionId: null },
      task: null,
      lastError: {
        code: "MINECRAFT_STATE_UNKNOWN",
        message: "Minecraft state is unavailable",
      },
    });
    const firstConnected = deliveries.indexOf("first:minecraft");
    const secondConnected = deliveries.indexOf("second:minecraft", firstConnected);
    const firstError = deliveries.indexOf("first:error");
    expect(firstConnected).toBeGreaterThanOrEqual(0);
    expect(secondConnected).toBeGreaterThan(firstConnected);
    expect(firstError).toBeGreaterThan(secondConnected);

    await expect(runtime.stop("process_exit")).resolves.toBeUndefined();
    expect(lifecycleStops).toBe(1);
    const terminalDeliveryCount = deliveries.length;
    minecraftListener?.({ kind: "connected" });
    expect(deliveries).toHaveLength(terminalDeliveryCount);
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      minecraft: { state: "disconnected", sessionId: null },
      task: null,
      lastError: { code: "MINECRAFT_STATE_UNKNOWN" },
    });
    expect(stopReasons).toEqual(["failed"]);
  });

  it("fails a malformed inactive task budget closed with bounded error data", () => {
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      task: {
        current: () => null,
        budget: () => ({
          ...inactiveBudget(),
          toolCalls: Number.POSITIVE_INFINITY,
        }),
        stop: () => undefined,
      },
    });

    expect(runtime.snapshot()).toMatchObject({
      task: null,
      lastError: {
        code: "TASK_STATE_UNKNOWN",
        message: "Task state is unavailable",
      },
    });
    expect(JSON.stringify(runtime.snapshot()).length).toBeLessThan(2_048);
  });
});
