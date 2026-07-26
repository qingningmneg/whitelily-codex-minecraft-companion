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
      createPublicTaskId: () => "public-stop-failure-task",
    });
    await runtime.start();

    await expect(runtime.stop("emergency_stop")).rejects.toThrow("Runtime failed to stop");

    expect(lifecycleStops).toBe(1);
    const snapshot = runtime.snapshot();
    expect(snapshot).toMatchObject({
      lifecycle: "stopped",
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
      createPublicTaskId: () => "public-noop-stop-task",
    });
    await runtime.start();

    await expect(runtime.stop("world_changed")).rejects.toThrow("Runtime failed to stop");

    expect(reasons).toEqual(["world_changed"]);
    expect(lifecycleStops).toBe(1);
    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "stopped",
      task: null,
      lastError: {
        code: "RUNTIME_STOP_FAILED",
        message: "Runtime failed to stop",
      },
    });
    expect(JSON.stringify(runtime.snapshot())).not.toContain(leaseId);
  });

  it("maps Minecraft and Codex startup, connection, outage, and terminal states", async () => {
    let minecraftListener: ((event: { kind: string }) => void) | undefined;
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
          minecraftListener = listener as (event: { kind: string }) => void;
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
      state: { state: "connecting", sessionId: null },
    });
    expect(events).toContainEqual({
      kind: "codex",
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
    minecraftListener?.({
      kind: "disconnected",
      sessionId: "C:\\unsafe\\session",
    } as { kind: string });
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
        return "public-task-1";
      },
    });

    const first = runtime.snapshot();
    const second = runtime.snapshot();
    expect(first.task).toMatchObject({
      id: "public-task-1",
      disclosure: {
        goal: "Build a safe house",
        expectedActions: ["move", "place"],
      },
      startedAt: "2023-11-14T22:13:20.000Z",
      budget: {
        active: true,
        startedAt: 1_700_000_000_000,
      },
    });
    expect(second.task?.id).toBe("public-task-1");
    expect(publicIds).toBe(1);
    expect(JSON.stringify({ first, second })).not.toContain("lease-super-secret");

    const observed: RuntimeEvent[] = [];
    runtime.subscribe((event) => {
      if (event.kind === "task" && event.task) {
        (event.task.disclosure.expectedActions as string[]).push("mutated");
      }
    });
    runtime.subscribe((event) => observed.push(event));
    budget = { ...budget, toolCalls: 1 };
    taskListener?.();

    expect(observed.at(-1)).toMatchObject({
      kind: "task",
      task: {
        disclosure: { expectedActions: ["move", "place"] },
        budget: { toolCalls: 1 },
      },
    });
    active = null;
    budget = { ...budget, active: false, stopReason: "completed", startedAt: null };
    taskListener?.();
    expect(observed.at(-1)).toEqual({ kind: "task", task: null });
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

  it("fails closed when a public task ID would equal the lease ID", () => {
    const leaseId = "lease-compatible-id";
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
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
        stop: () => undefined,
      },
      createPublicTaskId: () => leaseId,
    });

    const snapshot = runtime.snapshot();
    expect(snapshot).toMatchObject({
      task: null,
      lastError: {
        code: "TASK_STATE_UNKNOWN",
        message: "Task state is unavailable",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(leaseId);
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
