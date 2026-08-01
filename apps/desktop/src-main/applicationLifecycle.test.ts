// @vitest-environment node

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_PROTOCOL_VERSION,
  parseDesktopRequest,
  type DesktopResponse,
} from "../../../src/desktop/desktopProtocol.js";
import type { RuntimeSnapshot } from "../../../src/runtime/runtimeEvents.js";
import { ApplicationLifecycle } from "./applicationLifecycle.js";
import { ChildSupervisor, type ChildProcessPort } from "./childSupervisor.js";

const idleSnapshot: RuntimeSnapshot = {
  revision: 0,
  lifecycle: "idle",
  minecraft: { state: "disconnected", sessionId: null },
  codex: { state: "stopped", model: null },
  task: null,
  lastError: null,
};

function deferred() {
  let resolve = (): void => undefined;
  let reject = (_error: Error): void => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function caught<T>(promise: Promise<T>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

function createHarness(
  shutdown: () => Promise<void>,
  forceTerminate: () => Promise<void> = async () => undefined,
) {
  const order: string[] = [];
  const supervisor = {
    shutdown: vi.fn(() => {
      order.push("shutdown");
      return shutdown();
    }),
    forceTerminate: vi.fn(() => {
      order.push("forceTerminate");
      return forceTerminate();
    }),
  };
  const cleanup = vi.fn(() => {
    order.push("cleanup");
  });
  const app = {
    quit: vi.fn(() => {
      order.push("app.quit");
    }),
  };
  const lifecycle = new ApplicationLifecycle({ app, cleanup, supervisor });
  return { app, cleanup, lifecycle, order, supervisor };
}

class LifecycleFakeChild extends EventEmitter implements ChildProcessPort {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: string[] = [];
  killCalls = 0;
  killResult = true;
  throwOnKill = false;
  exitOnKill = false;
  alive = true;

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => this.writes.push(chunk));
  }

  kill(): boolean {
    this.killCalls += 1;
    if (this.throwOnKill) throw new Error("kill threw");
    if (this.exitOnKill) this.crash();
    return this.killResult;
  }

  crash(): void {
    if (!this.alive) return;
    this.alive = false;
    this.emit("exit", 1, null);
  }

  finishClose(): void {
    if (!this.alive) return;
    this.alive = false;
    this.emit("close", null, null);
  }

  requests() {
    return this.writes
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => parseDesktopRequest(JSON.parse(line)));
  }

  respond(response: DesktopResponse): void {
    this.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

function createIntegratedHarness() {
  const child = new LifecycleFakeChild();
  const supervisor = new ChildSupervisor({
    childEntry: String.raw`C:\Program Files\WhiteLily\resources\childMain.js`,
    configPath: String.raw`C:\LocalAppData\owner\WhiteLily\config.toml`,
    workingDirectory: String.raw`C:\LocalAppData\owner\WhiteLily`,
    environment: {
      LOCALAPPDATA: String.raw`C:\LocalAppData\owner`,
      WHITELILY_DATA_ROOT: String.raw`C:\LocalAppData\owner\WhiteLily`,
    },
    development: true,
    spawn: () => child,
  });
  supervisor.start();
  const cleanup = vi.fn();
  const app = { quit: vi.fn() };
  const lifecycle = new ApplicationLifecycle({ app, cleanup, supervisor });
  return { app, child, cleanup, lifecycle, supervisor };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ApplicationLifecycle", () => {
  it("does not clean up or call app.quit until safe shutdown confirms child exit", async () => {
    const shutdown = deferred();
    const { app, cleanup, lifecycle, order, supervisor } = createHarness(() => shutdown.promise);

    const quitting = lifecycle.quit();
    expect(lifecycle.isQuitting).toBe(true);
    expect(supervisor.shutdown).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    expect(order).toEqual(["shutdown"]);

    shutdown.resolve();
    await quitting;

    expect(supervisor.forceTerminate).not.toHaveBeenCalled();
    expect(order).toEqual(["shutdown", "cleanup", "app.quit"]);
  });

  it("uses 5,000 ms as the graceful deadline then awaits force confirmation", async () => {
    vi.useFakeTimers();
    const force = deferred();
    const { app, cleanup, lifecycle, order, supervisor } = createHarness(
      () => new Promise<void>(() => undefined),
      () => force.promise,
    );

    const quitting = lifecycle.quit();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(supervisor.forceTerminate).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(supervisor.forceTerminate).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();

    force.resolve();
    await quitting;
    expect(order).toEqual(["shutdown", "forceTerminate", "cleanup", "app.quit"]);
  });

  it("retains authority and resets for retry when force confirmation fails", async () => {
    let forceAttempt = 0;
    const { app, cleanup, lifecycle, supervisor } = createHarness(
      async () => {
        throw new Error("safe shutdown failed");
      },
      async () => {
        forceAttempt += 1;
        if (forceAttempt === 1) throw new Error("child still live");
      },
    );

    const first = lifecycle.quit();
    await expect(first).rejects.toThrow("child still live");
    expect(lifecycle.isQuitting).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();

    const second = lifecycle.quit();
    expect(second).not.toBe(first);
    await second;
    expect(supervisor.shutdown).toHaveBeenCalledTimes(2);
    expect(supervisor.forceTerminate).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("shares one successful quit promise and performs cleanup exactly once", async () => {
    const shutdown = deferred();
    const { app, cleanup, lifecycle, supervisor } = createHarness(() => shutdown.promise);

    const first = lifecycle.quit();
    const second = lifecycle.quit();
    expect(second).toBe(first);
    expect(cleanup).not.toHaveBeenCalled();
    expect(supervisor.shutdown).toHaveBeenCalledOnce();

    shutdown.resolve();
    await Promise.all([first, second]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("lets a child-exit success at 4,999 ms win without a kill request", async () => {
    vi.useFakeTimers();
    const shutdown = deferred();
    const { app, lifecycle, supervisor } = createHarness(() => shutdown.promise);

    const quitting = lifecycle.quit();
    await vi.advanceTimersByTimeAsync(4_999);
    shutdown.resolve();
    await quitting;

    expect(supervisor.forceTerminate).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("coalesces a shutdown rejection racing the deadline into one confirmed force path", async () => {
    vi.useFakeTimers();
    const shutdown = deferred();
    const { app, lifecycle, supervisor } = createHarness(() => shutdown.promise);

    const quitting = lifecycle.quit();
    shutdown.reject(new Error("shutdown raced"));
    await vi.advanceTimersByTimeAsync(5_000);
    await quitting;

    expect(supervisor.forceTerminate).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });
});

describe("ApplicationLifecycle with the real ChildSupervisor", () => {
  it("does not detach after both kill attempts return false and succeeds on a later retry exit", async () => {
    vi.useFakeTimers();
    const { app, child, cleanup, lifecycle } = createIntegratedHarness();
    child.killResult = false;

    const first = caught(lifecycle.quit());
    await vi.advanceTimersByTimeAsync(2_499);
    expect(app.quit).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toMatchObject({
      message: expect.stringContaining("termination was not confirmed"),
    });
    expect(child.killCalls).toBe(2);
    expect(child.alive).toBe(true);
    expect(lifecycle.isQuitting).toBe(false);
    expect(app.quit).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();

    child.killResult = true;
    child.exitOnKill = true;
    await lifecycle.quit();
    expect(child.killCalls).toBe(3);
    expect(child.alive).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("does not detach when kill returns true without an exit or close", async () => {
    vi.useFakeTimers();
    const { app, child, cleanup, lifecycle } = createIntegratedHarness();

    const quitting = caught(lifecycle.quit());
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(quitting).resolves.toMatchObject({
      message: expect.stringContaining("termination was not confirmed"),
    });

    expect(child.killCalls).toBe(2);
    expect(child.alive).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("awaits a real later exit even when both kill requests throw", async () => {
    vi.useFakeTimers();
    const { app, child, cleanup, lifecycle } = createIntegratedHarness();
    child.throwOnKill = true;
    setTimeout(() => child.crash(), 2_000);

    const quitting = lifecycle.quit();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(cleanup).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await quitting;

    expect(child.killCalls).toBe(2);
    expect(child.alive).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("accepts aggregate close as confirmed termination before cleanup", async () => {
    vi.useFakeTimers();
    const { app, child, cleanup, lifecycle } = createIntegratedHarness();
    child.killResult = false;
    setTimeout(() => child.finishClose(), 2_000);

    const quitting = lifecycle.quit();
    await vi.advanceTimersByTimeAsync(2_000);
    await quitting;

    expect(child.killCalls).toBe(2);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("uses the real acknowledged shutdown path without force termination", async () => {
    const { app, child, cleanup, lifecycle } = createIntegratedHarness();
    const quitting = lifecycle.quit();
    const emergency = child.requests()[0]!;
    child.respond({
      version: DESKTOP_PROTOCOL_VERSION,
      id: emergency.id,
      ok: true,
      result: idleSnapshot,
    });
    await Promise.resolve();
    child.crash();
    await quitting;

    expect(child.killCalls).toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });
});
