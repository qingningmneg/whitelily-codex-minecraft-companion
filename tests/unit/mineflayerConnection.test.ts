import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  MineflayerConnection,
  type MineflayerConnectionDependencies,
} from "../../src/minecraft/mineflayerConnection.js";
import type { BridgeAttemptProof } from "../../src/minecraft/bridgeProofIssuer.js";

class FakeBot extends EventEmitter {
  throwOnEvent: string | undefined;
  throwOnRemove = false;
  readonly game: { dimension: unknown } = { dimension: "overworld" };
  readonly _client = Object.assign(new EventEmitter(), { end: vi.fn() });
  readonly loadPlugin = vi.fn();
  readonly end = vi.fn();
  readonly clearControlStates = vi.fn();
  readonly pathfinder = { stop: vi.fn() };

  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    const result = super.on(eventName, listener);
    if (eventName === this.throwOnEvent) throw new Error(`attach failed for ${String(eventName)}`);
    return result;
  }

  override removeListener(eventName: string | symbol, listener: (...args: any[]) => void): this {
    if (this.throwOnRemove && eventName !== "end") {
      throw new Error(`detach failed for ${String(eventName)}`);
    }
    return super.removeListener(eventName, listener);
  }
}

interface TimerRecord {
  callback: () => void;
  delay: number;
  cancelled: boolean;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAttempt(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createMineflayerConnectionHarness(options?: {
  configureBot?: (bot: FakeBot, index: number) => void;
  createBotError?: Error;
  prepareAttempt?: (port: number) => Promise<BridgeAttemptProof>;
}) {
  const bots: FakeBot[] = [];
  const botOptions: unknown[] = [];
  const proofs: Array<BridgeAttemptProof & { close: ReturnType<typeof vi.fn> }> = [];
  const timers: TimerRecord[] = [];
  const prepareAttempt = vi.fn(
    options?.prepareAttempt ??
      (async () => {
        const index = proofs.length + 1;
        const proof = {
          fakeHost: `127.0.0.1\0WL1\0proof_${String(index).padStart(2, "0")}`,
          close: vi.fn(async () => undefined),
        };
        proofs.push(proof);
        return proof;
      }),
  );
  const dependencies: MineflayerConnectionDependencies = {
    config: {
      host: "127.0.0.1",
      port: 25_565,
      botUsername: "WhiteLily",
    },
    prepareAttempt,
    createBot: (attemptOptions) => {
      if (options?.createBotError) throw options.createBotError;
      botOptions.push(structuredClone(attemptOptions));
      const bot = new FakeBot();
      options?.configureBot?.(bot, bots.length);
      bots.push(bot);
      return bot as never;
    },
    plugin: vi.fn(),
    retryDelaysMs: [1_000, 2_000, 4_000, 8_000, 15_000],
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as TimerRecord).cancelled = true;
    },
  };

  return {
    bots,
    botOptions,
    proofs,
    prepareAttempt,
    dependencies,
    end(reason: string, index = bots.length - 1) {
      bots[index]?.emit("end", reason);
    },
    kick(reason: string, loggedIn: boolean, index = bots.length - 1) {
      bots[index]?.emit("kicked", reason, loggedIn);
    },
    spawn(index = bots.length - 1) {
      bots[index]?.emit("spawn");
    },
    scheduledDelays() {
      return timers.map((timer) => timer.delay);
    },
    pendingTimers() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
    runNextTimer() {
      const timer = timers.find((candidate) => !candidate.cancelled);
      if (!timer) throw new Error("no pending timer");
      timer.cancelled = true;
      timer.callback();
    },
    runTimerEvenIfCancelled(index: number) {
      const timer = timers[index];
      if (!timer) throw new Error(`no timer at index ${index}`);
      timer.callback();
    },
  };
}

describe("MineflayerConnection", () => {
  it("suppresses initial and same-dimension spawns but emits one trusted world change", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const events: string[] = [];
    connection.onEvent((event) => events.push(event.kind));
    const connecting = connection.connect();
    await flushAttempt();
    harness.bots[0]?._client.emit("login", { worldName: "minecraft:overworld" });
    harness.spawn();
    await connecting;

    harness.bots[0]?._client.emit("respawn", { worldName: "minecraft:overworld" });
    harness.bots[0]!.game.dimension = "the_nether";
    harness.bots[0]?._client.emit("respawn", { worldName: "minecraft:the_nether" });
    harness.bots[0]?._client.emit("respawn", { worldName: "minecraft:the_nether" });

    expect(events).toEqual(["connected", "world_changed"]);
  });

  it("detects a trusted world-name transition with the same dimension type", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const events: string[] = [];
    connection.onEvent((event) => events.push(event.kind));
    const connecting = connection.connect();
    await flushAttempt();
    harness.bots[0]?._client.emit("login", { worldName: "minecraft:overworld" });
    harness.spawn();
    await connecting;

    harness.bots[0]?._client.emit("respawn", { worldName: "custom:mirror_world" });
    harness.bots[0]?._client.emit("respawn", { worldName: "custom:mirror_world" });

    expect(events).toEqual(["connected", "world_changed"]);
  });

  it("normalizes modern nested worldState.name and ignores stale nested respawns", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const events: string[] = [];
    connection.onEvent((event) => events.push(event.kind));
    const initial = connection.connect();
    await flushAttempt();
    harness.bots[0]?._client.emit("login", {
      worldState: { name: "minecraft:overworld" },
    });
    harness.spawn();
    await initial;

    harness.bots[0]?._client.emit("respawn", {
      worldState: { name: "minecraft:overworld" },
    });
    harness.bots[0]?._client.emit("respawn", {
      worldState: { name: "custom:mirror_world" },
    });
    harness.bots[0]?._client.emit("respawn", {
      worldState: { name: "custom:mirror_world" },
    });
    harness.end("socket closed");
    await flushAttempt();
    harness.runNextTimer();
    await flushAttempt();
    harness.bots[1]?._client.emit("login", {
      worldState: { name: "minecraft:overworld" },
    });
    harness.spawn();
    await flushAttempt();

    harness.bots[0]?._client.emit("respawn", {
      worldState: { name: "minecraft:the_end" },
    });
    harness.bots[1]?._client.emit("respawn", {
      worldState: { name: { malformed: true } },
    });
    harness.bots[1]?._client.emit("respawn", {
      worldState: { name: { malformed: true } },
    });

    expect(events).toEqual(["connected", "world_changed", "outage", "connected", "world_changed"]);
  });

  it("fails closed once for malformed identity while ignoring stale and replacement initial spawns", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const events: string[] = [];
    connection.onEvent((event) => events.push(event.kind));
    const initial = connection.connect();
    await flushAttempt();
    harness.bots[0]?._client.emit("login", { worldName: "minecraft:overworld" });
    harness.spawn();
    await initial;
    harness.end("socket closed");
    await flushAttempt();
    harness.runNextTimer();
    await flushAttempt();
    harness.bots[1]!.game.dimension = "the_nether";
    harness.bots[1]?._client.emit("login", { worldName: "minecraft:the_nether" });
    harness.spawn();
    await flushAttempt();

    harness.bots[0]!.game.dimension = "the_end";
    harness.bots[0]?._client.emit("respawn", { worldName: "minecraft:the_end" });
    harness.bots[1]!.game.dimension = { malformed: true };
    harness.bots[1]?._client.emit("respawn", { worldName: { malformed: true } });
    harness.bots[1]?._client.emit("respawn", { worldName: { malformed: true } });

    expect(events).toEqual(["connected", "outage", "connected", "world_changed"]);
  });

  it("emits one outage and retries with the bounded delay sequence", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const events: string[] = [];
    connection.onEvent((event) => events.push(event.kind));
    const connecting = connection.connect();
    await flushAttempt();
    harness.spawn();
    await connecting;

    harness.end("socket closed");
    harness.end("duplicate");
    await flushAttempt();

    expect(events).toEqual(["connected", "outage"]);
    expect(harness.scheduledDelays()).toEqual([1_000]);
  });

  it("owns bot errors and fences the transport without writing through Mineflayer's logger", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const events: string[] = [];
    connection.onEvent((event) => events.push(event.kind));
    const connecting = connection.connect();
    await flushAttempt();
    harness.spawn();
    await connecting;
    const bot = harness.bots[0]!;

    expect(() =>
      bot.emit("error", new Error("private stack must stay off protocol stdout")),
    ).not.toThrow();
    await flushAttempt();

    expect(bot.end).toHaveBeenCalledWith("Minecraft connection error");
    expect(events).toEqual(["connected", "outage"]);
    expect(connection.state()).toBe("retrying");
    expect(harness.scheduledDelays()).toEqual([1_000]);

    expect(() => bot.emit("error", new Error("late private stack"))).not.toThrow();
    expect(bot.end).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["connected", "outage"]);
    expect(harness.scheduledDelays()).toEqual([1_000]);
  });

  it("fences every pre-spawn kick, uses bounded retries, and rejects without exposing reasons", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const events: Array<{ kind: string; reason?: string }> = [];
    connection.onEvent((event) => events.push(event));
    const connecting = connection.connect();
    await flushAttempt();
    const rejected = expect(connecting).rejects.toMatchObject({
      code: "MINECRAFT_BRIDGE_REJECTED",
    });
    const privateReason = '{"translate":"multiplayer.disconnect.private-owner-policy"}';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const bot = harness.bots[attempt]!;
      expect(() => harness.kick(privateReason, false, attempt)).not.toThrow();
      expect(bot.end).toHaveBeenCalledWith("Minecraft connection rejected");

      expect(() => harness.kick(`late kick ${attempt}`, false, attempt)).not.toThrow();
      expect(() => bot.emit("error", new Error(`late error ${attempt}`))).not.toThrow();
      expect(() => harness.end(`late end ${attempt}`, attempt)).not.toThrow();
      expect(bot.end).toHaveBeenCalledTimes(1);
      await flushAttempt();

      if (attempt < 4) {
        harness.runNextTimer();
        await flushAttempt();
      }
    }

    await rejected;
    expect(harness.scheduledDelays()).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(events).toEqual([{ kind: "outage", reason: "Minecraft connection rejected" }]);
    expect(JSON.stringify(events)).not.toContain(privateReason);
    expect(connection.state()).toBe("exhausted");
  });

  it("uses the physical socket fallback before retrying a rejected login", async () => {
    const socketEnd = vi.fn();
    const harness = createMineflayerConnectionHarness({
      configureBot: (bot) => {
        bot.end.mockImplementation(() => {
          throw new Error("bot end failed");
        });
        Object.assign(bot._client, { socket: { end: socketEnd, destroy: vi.fn() } });
      },
    });
    const connection = new MineflayerConnection(harness.dependencies);
    void connection.connect().catch(() => undefined);
    await flushAttempt();

    harness.kick("private rejection", false);
    await flushAttempt();

    expect(socketEnd).toHaveBeenCalledOnce();
    expect(connection.state()).toBe("retrying");
    expect(harness.scheduledDelays()).toEqual([1_000]);
  });

  it("fails a connected kick closed once despite duplicate and delayed lifecycle events", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const events: Array<{ kind: string; reason?: string }> = [];
    connection.onEvent((event) => events.push(event));
    const connecting = connection.connect();
    await flushAttempt();
    harness.spawn();
    await connecting;
    const bot = harness.bots[0]!;

    expect(() => harness.kick("private connected rejection", true)).not.toThrow();
    expect(() => harness.kick("duplicate private rejection", true)).not.toThrow();
    expect(() => bot.emit("error", new Error("delayed private error"))).not.toThrow();
    expect(() => harness.end("delayed private end")).not.toThrow();
    await flushAttempt();

    expect(bot.end).toHaveBeenCalledTimes(1);
    expect(bot.end).toHaveBeenCalledWith("Minecraft connection rejected");
    expect(events).toEqual([
      { kind: "connected" },
      { kind: "outage", reason: "Minecraft connection rejected" },
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(harness.scheduledDelays()).toEqual([1_000]);
    expect(connection.state()).toBe("retrying");
  });

  it("does not close or retry twice when kick fencing synchronously emits an error", async () => {
    const harness = createMineflayerConnectionHarness({
      configureBot: (bot) => {
        bot.end.mockImplementation(() => {
          bot.emit("error", new Error("private error during close"));
        });
      },
    });
    const connection = new MineflayerConnection(harness.dependencies);
    const events: string[] = [];
    connection.onEvent((event) => events.push(event.kind));
    const connecting = connection.connect();
    await flushAttempt();
    harness.spawn();
    await connecting;

    expect(() => harness.kick("private rejection", true)).not.toThrow();
    await flushAttempt();

    expect(harness.bots[0]?.end).toHaveBeenCalledOnce();
    expect(events).toEqual(["connected", "outage"]);
    expect(harness.scheduledDelays()).toEqual([1_000]);
  });

  it("keeps a terminally fenced bot error-safe without repeating outage or retry", async () => {
    const harness = createMineflayerConnectionHarness({
      configureBot: (bot) => {
        bot.end.mockImplementation(() => {
          throw new Error("bot end failed");
        });
      },
    });
    const connection = new MineflayerConnection(harness.dependencies);
    const events: string[] = [];
    connection.onEvent((event) => events.push(event.kind));
    const connecting = connection.connect();
    await flushAttempt();
    harness.spawn();
    await connecting;
    const bot = harness.bots[0]!;

    expect(() => bot.emit("error", new Error("first private stack"))).not.toThrow();
    expect(connection.state()).toBe("exhausted");
    expect(events).toEqual(["connected", "outage"]);
    expect(harness.pendingTimers()).toBe(0);

    expect(() => bot.emit("error", new Error("late private stack"))).not.toThrow();
    expect(bot.end).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["connected", "outage"]);
    expect(harness.pendingTimers()).toBe(0);
  });

  it("keeps a detached old bot error-safe after a normal end", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const events: string[] = [];
    connection.onEvent((event) => events.push(event.kind));
    const connecting = connection.connect();
    await flushAttempt();
    harness.spawn();
    await connecting;
    const bot = harness.bots[0]!;

    harness.end("socket closed");
    await flushAttempt();
    expect(connection.state()).toBe("retrying");

    expect(() => bot.emit("error", new Error("late private stack"))).not.toThrow();
    expect(bot.end).not.toHaveBeenCalled();
    expect(events).toEqual(["connected", "outage"]);
    expect(harness.scheduledDelays()).toEqual([1_000]);
  });

  it("cancels every retry and active operation on disconnect", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const connecting = connection.connect();
    await flushAttempt();
    harness.spawn();
    await connecting;
    const cancelOperation = vi.fn();
    connection.registerActiveOperation(cancelOperation);
    harness.end("socket closed");

    await connection.disconnect();

    expect(cancelOperation).toHaveBeenCalledOnce();
    expect(harness.pendingTimers()).toBe(0);
    expect(connection.state()).toBe("stopped");
  });

  it("uses the full retry sequence and rejects the shared connect promise on exhaustion", async () => {
    const harness = createMineflayerConnectionHarness({
      createBotError: new Error("socket refused"),
    });
    const connection = new MineflayerConnection(harness.dependencies);
    const first = connection.connect();
    const second = connection.connect();
    const rejected = expect(first).rejects.toThrow("retries exhausted");
    await flushAttempt();

    expect(second).toBe(first);
    for (const expectedDelay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      expect(harness.scheduledDelays().at(-1)).toBe(expectedDelay);
      harness.runNextTimer();
      await flushAttempt();
    }

    await rejected;
    await expect(second).rejects.toThrow("retries exhausted");
    expect(harness.scheduledDelays()).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
    expect(connection.state()).toBe("exhausted");
    await expect(connection.connect()).rejects.toThrow("adapter is stopped");
  });

  it("shares connect callers during a retry and resolves them when the replacement spawns", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const initial = connection.connect();
    await flushAttempt();
    harness.spawn();
    await initial;
    harness.end("socket closed");
    await flushAttempt();

    const first = connection.connect();
    const second = connection.connect();
    expect(second).toBe(first);
    harness.runNextTimer();
    await flushAttempt();
    const third = connection.connect();
    expect(third).toBe(first);
    harness.spawn();

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(connection.state()).toBe("connected");
  });

  it("ignores stale bot events after a replacement and resets outage deduplication after spawn", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const events: string[] = [];
    connection.onEvent((event) => events.push(event.kind));
    const initial = connection.connect();
    await flushAttempt();
    harness.spawn();
    await initial;
    harness.end("first outage");
    await flushAttempt();
    harness.runNextTimer();
    await flushAttempt();
    harness.end("stale duplicate", 0);
    harness.spawn();
    await flushAttempt();
    harness.end("second outage");
    await flushAttempt();

    expect(events).toEqual(["connected", "outage", "connected", "outage"]);
    expect(harness.scheduledDelays()).toEqual([1_000, 1_000]);
  });

  it("ignores every stale bot event even when listener removal fails", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const kinds: string[] = [];
    connection.onEvent((event) => kinds.push(event.kind));
    const initial = connection.connect();
    await flushAttempt();
    harness.spawn();
    await initial;
    harness.bots[0]!.throwOnRemove = true;
    harness.end("socket closed");
    await flushAttempt();
    harness.runNextTimer();
    await flushAttempt();
    harness.spawn();
    const beforeStaleEvents = [...kinds];

    harness.bots[0]?.emit("chat", "Owner", "stale");
    harness.bots[0]?.emit("death");
    harness.bots[0]?.emit("entitySpawn", { id: 7 });
    harness.bots[0]?.emit("move");
    harness.bots[0]?._client.emit("spawn_position", {});

    expect(kinds).toEqual(beforeStaleEvents);
  });

  it("disconnect rejects a pending connect with AbortError and prevents timer callbacks restarting it", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const connecting = connection.connect();
    await flushAttempt();
    harness.end("socket closed");
    await flushAttempt();

    await connection.disconnect();

    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    harness.runTimerEvenIfCancelled(0);
    expect(harness.bots).toHaveLength(1);
    expect(harness.bots[0]?.eventNames()).toEqual(["error", "kicked"]);
    expect(() => harness.bots[0]?.emit("error", new Error("late private stack"))).not.toThrow();
    expect(() => harness.bots[0]?.emit("kicked", "late private rejection", false)).not.toThrow();
    await expect(connection.connect()).rejects.toThrow("adapter is stopped");
  });

  it("detaches partial handlers and safely ends bots when setup throws", async () => {
    const socketEnd = vi.fn();
    const harness = createMineflayerConnectionHarness({
      configureBot: (bot) => {
        bot.throwOnEvent = "death";
        bot.end.mockImplementation(() => {
          throw new Error("end failed");
        });
        Object.assign(bot._client, {
          socket: { end: socketEnd, destroy: vi.fn() },
        });
      },
    });
    const connection = new MineflayerConnection(harness.dependencies);

    void connection.connect();
    await flushAttempt();

    expect(harness.bots[0]?.eventNames()).toEqual(["error", "kicked"]);
    expect(() => harness.bots[0]?.emit("error", new Error("late private stack"))).not.toThrow();
    expect(() => harness.bots[0]?.emit("kicked", "late private rejection", false)).not.toThrow();
    expect(harness.bots[0]?.pathfinder.stop).toHaveBeenCalledOnce();
    expect(harness.bots[0]?.clearControlStates).toHaveBeenCalledOnce();
    expect(harness.bots[0]?.end).toHaveBeenCalledOnce();
    expect(socketEnd).toHaveBeenCalledOnce();
    expect(harness.scheduledDelays()).toEqual([1_000]);
  });

  it("forwards Mineflayer events through one detachable subscription", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const kinds: string[] = [];
    const unsubscribe = connection.onEvent((event) => kinds.push(event.kind));
    const connecting = connection.connect();
    await flushAttempt();
    const bot = harness.bots[0];

    bot?.emit("chat", "Owner", "hello");
    bot?.emit("playerJoined", { username: "Owner" });
    bot?.emit("playerLeft", { username: "Owner" });
    bot?.emit("death");
    bot?.emit("entitySpawn", { id: 1 });
    bot?.emit("entityMoved", { id: 1 });
    bot?.emit("entityGone", { id: 1 });
    bot?.emit("move");
    bot?.emit("forcedMove");
    bot?._client.emit("spawn_position", { location: { x: 1, y: 2, z: 3 } });
    harness.spawn();
    await connecting;
    unsubscribe();
    bot?.emit("death");

    expect(kinds).toEqual([
      "chat",
      "owner_online",
      "owner_offline",
      "death",
      "entity_spawn",
      "entity_moved",
      "entity_gone",
      "move",
      "forced_move",
      "spawn_position",
      "connected",
    ]);
  });

  it("does not cancel an operation after it unregisters", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const connecting = connection.connect();
    await flushAttempt();
    harness.spawn();
    await connecting;
    const cancel = vi.fn();
    const unregister = connection.registerActiveOperation(cancel);
    unregister();

    harness.end("socket closed");

    expect(cancel).not.toHaveBeenCalled();
  });

  it("continues cancelling operations when one cleanup throws", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const connecting = connection.connect();
    await flushAttempt();
    harness.spawn();
    await connecting;
    const secondCancel = vi.fn();
    connection.registerActiveOperation(() => {
      throw new Error("cleanup failed");
    });
    connection.registerActiveOperation(secondCancel);

    await expect(connection.disconnect()).resolves.toBeUndefined();

    expect(secondCancel).toHaveBeenCalledOnce();
    expect(connection.state()).toBe("stopped");
  });

  it("keeps the active bot bound until explicit disconnect establishes a socket fallback fence", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const kinds: string[] = [];
    connection.onEvent((event) => kinds.push(event.kind));
    const connecting = connection.connect();
    await flushAttempt();
    harness.spawn();
    await connecting;
    const bot = harness.bots[0]!;
    bot.end.mockImplementation(() => {
      throw new Error("bot end failed");
    });
    const socketEnd = vi.fn(() => {
      expect(connection.currentBot()).toBe(bot);
    });
    const socketDestroy = vi.fn();
    Object.assign(bot._client, {
      socket: { end: socketEnd, destroy: socketDestroy },
    });
    const cancel = vi.fn();
    connection.registerActiveOperation(cancel);

    await expect(connection.disconnect()).resolves.toBeUndefined();

    expect(bot.end).toHaveBeenCalledOnce();
    expect(bot._client.end).not.toHaveBeenCalled();
    expect(socketEnd).toHaveBeenCalledOnce();
    expect(socketDestroy).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(connection.currentBot()).toBeUndefined();
    expect(connection.state()).toBe("stopped");
    const beforeStaleEvent = [...kinds];
    bot.emit("chat", "Owner", "stale");
    bot.emit("end", "stale end");
    expect(kinds).toEqual(beforeStaleEvent);

    await expect(connection.disconnect()).resolves.toBeUndefined();
    expect(bot.end).toHaveBeenCalledOnce();
    expect(socketEnd).toHaveBeenCalledOnce();
  });

  it("rejects explicit disconnect and terminates without retry when every transport close fails", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const connecting = connection.connect();
    await flushAttempt();
    harness.spawn();
    await connecting;
    const bot = harness.bots[0]!;
    bot.end.mockImplementation(() => {
      throw new Error("bot end failed");
    });
    const socketEnd = vi.fn(() => {
      throw new Error("socket end failed");
    });
    const socketDestroy = vi.fn(() => {
      throw new Error("socket destroy failed");
    });
    Object.assign(bot._client, {
      socket: { end: socketEnd, destroy: socketDestroy },
    });
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    connection.registerActiveOperation(firstCancel);
    connection.registerActiveOperation(secondCancel);

    let disconnectSettlements = 0;
    const disconnecting = connection.disconnect();
    void disconnecting.then(
      () => {
        disconnectSettlements += 1;
      },
      () => {
        disconnectSettlements += 1;
      },
    );
    await expect(disconnecting).rejects.toThrow("physical transport fence failed");
    await Promise.resolve();

    expect(bot._client.end).not.toHaveBeenCalled();
    expect(socketEnd).toHaveBeenCalledOnce();
    expect(socketDestroy).toHaveBeenCalledOnce();
    expect(firstCancel).toHaveBeenCalledOnce();
    expect(secondCancel).toHaveBeenCalledOnce();
    expect(disconnectSettlements).toBe(1);
    expect(connection.currentBot()).toBeUndefined();
    expect(connection.state()).toBe("exhausted");
    expect(harness.pendingTimers()).toBe(0);
    await expect(connection.connect()).rejects.toThrow("adapter is stopped");
    await expect(connection.disconnect()).rejects.toThrow("physical transport fence failed");
    expect(firstCancel).toHaveBeenCalledOnce();
    expect(secondCancel).toHaveBeenCalledOnce();
  });

  it.each(["load_plugin", "attach"] as const)(
    "uses a socket fallback to isolate a partial bot after %s setup failure",
    async (failurePoint) => {
      let harness!: ReturnType<typeof createMineflayerConnectionHarness>;
      const socketEnd = vi.fn(() => {
        expect(harness.scheduledDelays()).toEqual([]);
      });
      const socketDestroy = vi.fn();
      harness = createMineflayerConnectionHarness({
        configureBot: (bot) => {
          if (failurePoint === "load_plugin") {
            bot.loadPlugin.mockImplementation(() => {
              throw new Error("load plugin failed");
            });
          } else {
            bot.throwOnEvent = "death";
          }
          bot.end.mockImplementation(() => {
            throw new Error("bot end failed");
          });
          Object.assign(bot._client, {
            socket: { end: socketEnd, destroy: socketDestroy },
          });
        },
      });
      const connection = new MineflayerConnection(harness.dependencies);
      let rejection: unknown;
      const connecting = connection.connect().catch((error: unknown) => {
        rejection = error;
      });
      await flushAttempt();
      const bot = harness.bots[0]!;

      expect(bot.end).toHaveBeenCalledOnce();
      expect(bot._client.end).not.toHaveBeenCalled();
      expect(socketEnd).toHaveBeenCalledOnce();
      expect(socketDestroy).not.toHaveBeenCalled();
      expect(connection.currentBot()).toBeUndefined();
      expect(connection.state()).toBe("retrying");
      expect(harness.scheduledDelays()).toEqual([1_000]);
      const eventNames = bot.eventNames();
      bot.emit("spawn");
      bot.emit("end", "stale");
      expect(bot.eventNames()).toEqual(eventNames);

      await connection.disconnect();
      await connecting;
      expect(rejection).toMatchObject({ name: "AbortError" });
      expect(harness.pendingTimers()).toBe(0);
    },
  );

  it("rejects setup connect and never retries when partial-bot transport fencing fails", async () => {
    const socketEnd = vi.fn(() => {
      throw new Error("socket end failed");
    });
    const socketDestroy = vi.fn(() => {
      throw new Error("socket destroy failed");
    });
    const harness = createMineflayerConnectionHarness({
      configureBot: (bot) => {
        bot.loadPlugin.mockImplementation(() => {
          throw new Error("load plugin failed");
        });
        bot.end.mockImplementation(() => {
          throw new Error("bot end failed");
        });
        Object.assign(bot._client, {
          socket: { end: socketEnd, destroy: socketDestroy },
        });
      },
    });
    const connection = new MineflayerConnection(harness.dependencies);
    let rejection: unknown;
    const connecting = connection.connect().catch((error: unknown) => {
      rejection = error;
    });
    await flushAttempt();
    const observedState = connection.state();
    const observedTimers = harness.pendingTimers();
    if (observedState !== "exhausted") await connection.disconnect();
    await connecting;

    expect(rejection).toMatchObject({
      name: "MineflayerTransportFenceError",
      message: expect.stringContaining("physical transport fence failed"),
    });
    expect(observedState).toBe("exhausted");
    expect(observedTimers).toBe(0);
    expect(connection.currentBot()).toBeUndefined();
    expect(socketEnd).toHaveBeenCalledOnce();
    expect(socketDestroy).toHaveBeenCalledOnce();
    expect(harness.bots[0]?.eventNames()).toEqual(["error", "kicked"]);
    expect(() => harness.bots[0]?.emit("error", new Error("late private stack"))).not.toThrow();
    expect(() => harness.bots[0]?.emit("kicked", "late private rejection", false)).not.toThrow();
  });

  it.each(["client_end", "socket_end", "socket_destroy"] as const)(
    "establishes a physical session fence through the %s fallback before retrying",
    async (successfulFallback) => {
      const harness = createMineflayerConnectionHarness();
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect();
      await flushAttempt();
      harness.spawn();
      await connecting;
      const bot = harness.bots[0]!;
      const botEnd = bot.end;
      if (successfulFallback === "client_end") {
        delete (bot as unknown as { end?: (reason?: string) => void }).end;
      } else {
        bot.end.mockImplementation(() => {
          throw new Error("bot end failed");
        });
      }
      const clientEnd = vi.fn(() => {
        if (successfulFallback !== "client_end") throw new Error("client end failed");
      });
      const socketEnd = vi.fn(() => {
        if (successfulFallback !== "socket_end") throw new Error("socket end failed");
      });
      const socketDestroy = vi.fn(() => {
        if (successfulFallback !== "socket_destroy") throw new Error("socket destroy failed");
      });
      Object.assign(bot._client, {
        end: clientEnd,
        socket: { end: socketEnd, destroy: socketDestroy },
      });
      const session = connection.currentSession();
      if (!session) throw new Error("expected an active session");

      expect(() => connection.fenceActiveSession(session, "cancel timed out")).not.toThrow();
      await flushAttempt();

      expect(botEnd).toHaveBeenCalledTimes(successfulFallback === "client_end" ? 0 : 1);
      expect(clientEnd).toHaveBeenCalledTimes(successfulFallback === "client_end" ? 1 : 0);
      expect(socketEnd).toHaveBeenCalledTimes(successfulFallback === "client_end" ? 0 : 1);
      expect(socketDestroy).toHaveBeenCalledTimes(successfulFallback === "socket_destroy" ? 1 : 0);
      expect(connection.currentBot()).toBeUndefined();
      expect(connection.state()).toBe("retrying");
      expect(harness.pendingTimers()).toBe(1);
    },
  );

  it("enters terminal exhaustion and reports a fatal error when every physical fence fails", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const connecting = connection.connect();
    await flushAttempt();
    harness.spawn();
    await connecting;
    const bot = harness.bots[0]!;
    bot.end.mockImplementation(() => {
      throw new Error("bot end failed");
    });
    Object.assign(bot._client, {
      end: vi.fn(() => {
        throw new Error("client end failed");
      }),
      socket: {
        end: vi.fn(() => {
          throw new Error("socket end failed");
        }),
        destroy: vi.fn(() => {
          throw new Error("socket destroy failed");
        }),
      },
    });
    const session = connection.currentSession();
    if (!session) throw new Error("expected an active session");

    expect(() => connection.fenceActiveSession(session, "cancel timed out")).toThrow(
      "physical transport fence failed",
    );

    expect(bot._client.end).not.toHaveBeenCalled();
    expect(connection.currentBot()).toBeUndefined();
    expect(connection.state()).toBe("exhausted");
    expect(harness.pendingTimers()).toBe(0);
    await expect(connection.connect()).rejects.toThrow("adapter is stopped");
  });

  it("fails closed if lifecycle state is corrupted", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    (
      connection as unknown as {
        lifecycleState: string;
      }
    ).lifecycleState = "unknown";

    await expect(connection.connect()).rejects.toThrow("unknown state");
  });

  describe("Bridge attempt proof ownership", () => {
    it("waits for preparation and passes the exact per-attempt fake host to Mineflayer", async () => {
      const pending = deferred<BridgeAttemptProof>();
      const proof = {
        fakeHost: "127.0.0.1\0WL1\0delayed-proof",
        close: vi.fn(async () => undefined),
      };
      const harness = createMineflayerConnectionHarness({
        prepareAttempt: () => pending.promise,
      });
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect();

      await flushAttempt();
      const botCountBeforePreparation = harness.bots.length;
      pending.resolve(proof);
      await flushAttempt();
      harness.spawn();
      await connecting;

      expect(harness.prepareAttempt).toHaveBeenCalledOnce();
      expect(harness.prepareAttempt).toHaveBeenCalledWith(25_565);
      expect(botCountBeforePreparation).toBe(0);
      expect(harness.botOptions).toEqual([
        expect.objectContaining({
          fakeHost: proof.fakeHost,
          hideErrors: false,
          logErrors: false,
        }),
      ]);
      expect(proof.close).toHaveBeenCalledOnce();
      await connection.disconnect();
    });

    it("invalidates pending preparation on stop and closes the late proof without creating a bot", async () => {
      const pending = deferred<BridgeAttemptProof>();
      const proof = {
        fakeHost: "127.0.0.1\0WL1\0late-after-stop",
        close: vi.fn(async () => undefined),
      };
      const harness = createMineflayerConnectionHarness({
        prepareAttempt: () => pending.promise,
      });
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect().catch((error: unknown) => error);

      await flushAttempt();
      let disconnectSettled = false;
      const disconnecting = connection.disconnect().finally(() => {
        disconnectSettled = true;
      });
      await flushAttempt();
      expect(disconnectSettled).toBe(false);
      pending.resolve(proof);
      await disconnecting;
      const rejection = await connecting;

      expect(rejection).toMatchObject({ name: "AbortError" });
      expect(harness.bots).toHaveLength(0);
      expect(proof.close).toHaveBeenCalledOnce();
    });

    it("waits for an in-flight proof close before disconnect settles", async () => {
      const closeGate = deferred<void>();
      const proof = {
        fakeHost: "127.0.0.1\0WL1\0disconnect-close-gate",
        close: vi.fn(() => closeGate.promise),
      };
      const harness = createMineflayerConnectionHarness({
        prepareAttempt: async () => proof,
      });
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect().catch((error: unknown) => error);
      await flushAttempt();

      let disconnectSettled = false;
      const disconnecting = connection.disconnect().finally(() => {
        disconnectSettled = true;
      });
      await flushAttempt();

      expect(proof.close).toHaveBeenCalledOnce();
      expect(disconnectSettled).toBe(false);
      closeGate.resolve();
      await disconnecting;
      await connecting;
      expect(disconnectSettled).toBe(true);
    });

    it("does not schedule the next attempt until the prior proof close settles", async () => {
      const closeGate = deferred<void>();
      const firstProof = {
        fakeHost: "127.0.0.1\0WL1\0retry-close-gate",
        close: vi.fn(() => closeGate.promise),
      };
      const secondProof = {
        fakeHost: "127.0.0.1\0WL1\0after-close-gate",
        close: vi.fn(async () => undefined),
      };
      const prepareAttempt = vi
        .fn<(port: number) => Promise<BridgeAttemptProof>>()
        .mockResolvedValueOnce(firstProof)
        .mockResolvedValueOnce(secondProof);
      const harness = createMineflayerConnectionHarness({ prepareAttempt });
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect().catch((error: unknown) => error);
      await flushAttempt();

      harness.kick("private rejection", false);
      await flushAttempt();
      expect(firstProof.close).toHaveBeenCalledOnce();
      expect(harness.pendingTimers()).toBe(0);
      expect(prepareAttempt).toHaveBeenCalledOnce();

      closeGate.resolve();
      await flushAttempt();
      expect(harness.pendingTimers()).toBe(1);
      harness.runNextTimer();
      await flushAttempt();
      expect(prepareAttempt).toHaveBeenCalledTimes(2);
      await connection.disconnect();
      await connecting;
    });

    it("maps proof close rejection to a fixed Bridge failure without exposing its cause", async () => {
      const secret =
        "close-secret 127.0.0.1:25565 C:\\Users\\Owner\\bridge\\requests\\private.json";
      const proof = {
        fakeHost: "127.0.0.1\0WL1\0close-rejection",
        close: vi.fn(async () => {
          throw new Error(secret);
        }),
      };
      const harness = createMineflayerConnectionHarness({
        prepareAttempt: async () => proof,
      });
      const connection = new MineflayerConnection(harness.dependencies);
      const events: unknown[] = [];
      connection.onEvent((event) => events.push(event));
      const connecting = connection.connect().catch((error: unknown) => error);
      await flushAttempt();

      harness.spawn();
      const rejection = await connecting;

      expect(rejection).toMatchObject({ code: "MINECRAFT_BRIDGE_REQUIRED" });
      expect(connection.state()).toBe("exhausted");
      expect(proof.close).toHaveBeenCalledOnce();
      expect(JSON.stringify({ rejection: String(rejection), events })).not.toContain(secret);
    });

    it.each(["createBot", "setup", "error", "kicked", "end"] as const)(
      "fails closed with the stable Bridge code when proof cleanup rejects after %s",
      async (failurePoint) => {
        const secret = `private ${failurePoint} close failure C:\\Users\\Owner\\request.json`;
        const proof = {
          fakeHost: `127.0.0.1\0WL1\0close-failure-${failurePoint}`,
          close: vi.fn(async () => {
            throw new Error(secret);
          }),
        };
        const harness = createMineflayerConnectionHarness({
          prepareAttempt: async () => proof,
          ...(failurePoint === "createBot" ? { createBotError: new Error("private setup") } : {}),
          ...(failurePoint === "setup"
            ? {
                configureBot: (bot: FakeBot) => {
                  bot.loadPlugin.mockImplementation(() => {
                    throw new Error("private setup");
                  });
                },
              }
            : {}),
        });
        const connection = new MineflayerConnection(harness.dependencies);
        const events: unknown[] = [];
        connection.onEvent((event) => events.push(event));
        const connecting = connection.connect().catch((error: unknown) => error);
        await flushAttempt();

        if (failurePoint === "error") {
          harness.bots[0]?.emit("error", new Error("private transport"));
        } else if (failurePoint === "kicked") {
          harness.kick("private transport", false);
        } else if (failurePoint === "end") {
          harness.end("private transport");
        }
        const rejection = await connecting;

        expect(rejection).toMatchObject({ code: "MINECRAFT_BRIDGE_REQUIRED" });
        expect(proof.close).toHaveBeenCalledOnce();
        expect(connection.state()).toBe("exhausted");
        expect(harness.pendingTimers()).toBe(0);
        expect(JSON.stringify({ rejection: String(rejection), events })).not.toContain(secret);
      },
    );

    it("rejects disconnect with a fixed code after draining a failed proof close", async () => {
      const secret = "private disconnect close failure C:\\Users\\Owner\\request.json";
      const proof = {
        fakeHost: "127.0.0.1\0WL1\0disconnect-close-failure",
        close: vi.fn(async () => {
          throw new Error(secret);
        }),
      };
      const harness = createMineflayerConnectionHarness({
        prepareAttempt: async () => proof,
      });
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect().catch((error: unknown) => error);
      await flushAttempt();

      const rejection = await connection.disconnect().catch((error: unknown) => error);
      await connecting;

      expect(rejection).toMatchObject({ code: "MINECRAFT_BRIDGE_REQUIRED" });
      expect(String(rejection)).not.toContain(secret);
      expect(proof.close).toHaveBeenCalledOnce();
      expect(connection.state()).toBe("stopped");
    });

    it("closes a stale preparation when crossed retry callbacks advance the generation", async () => {
      const initialProof = {
        fakeHost: "127.0.0.1\0WL1\0initial-generation",
        close: vi.fn(async () => undefined),
      };
      const stalePreparation = deferred<BridgeAttemptProof>();
      const staleProof = {
        fakeHost: "127.0.0.1\0WL1\0stale-generation",
        close: vi.fn(async () => undefined),
      };
      const currentPreparation = deferred<BridgeAttemptProof>();
      const currentProof = {
        fakeHost: "127.0.0.1\0WL1\0current-generation",
        close: vi.fn(async () => undefined),
      };
      const prepareAttempt = vi
        .fn<(port: number) => Promise<BridgeAttemptProof>>()
        .mockResolvedValueOnce(initialProof)
        .mockReturnValueOnce(stalePreparation.promise)
        .mockReturnValueOnce(currentPreparation.promise);
      const harness = createMineflayerConnectionHarness({ prepareAttempt });
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect();
      await flushAttempt();
      harness.end("first attempt ended");
      await flushAttempt();

      harness.runNextTimer();
      harness.runTimerEvenIfCancelled(0);
      stalePreparation.resolve(staleProof);
      await flushAttempt();

      expect(staleProof.close).toHaveBeenCalledOnce();
      expect(harness.bots).toHaveLength(1);
      currentPreparation.resolve(currentProof);
      await flushAttempt();
      expect(harness.bots).toHaveLength(2);
      expect(harness.botOptions[1]).toEqual(
        expect.objectContaining({ fakeHost: currentProof.fakeHost }),
      );
      harness.spawn(1);
      await connecting;

      expect(initialProof.close).toHaveBeenCalledOnce();
      expect(currentProof.close).toHaveBeenCalledOnce();
      await connection.disconnect();
    });

    it("maps preparation failure to the stable Bridge-required code without exposing its cause", async () => {
      const secret =
        "nonce-secret 127.0.0.1:25565 C:\\Users\\Owner\\WhiteLily\\bridge-requests\\secret.json";
      const harness = createMineflayerConnectionHarness({
        prepareAttempt: async () => {
          throw new Error(secret);
        },
      });
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect().catch((error: unknown) => error);

      await flushAttempt();
      if (harness.bots.length > 0) await connection.disconnect();
      const rejection = await connecting;

      expect(rejection).toMatchObject({ code: "MINECRAFT_BRIDGE_REQUIRED" });
      expect(String(rejection)).not.toContain(secret);
      expect(harness.bots).toHaveLength(0);
      expect(connection.state()).toBe("exhausted");
    });

    it("fails closed before bot creation if an issuer reuses a fake host", async () => {
      const firstProof = {
        fakeHost: "127.0.0.1\0WL1\0must-not-repeat",
        close: vi.fn(async () => undefined),
      };
      const repeatedProof = {
        fakeHost: firstProof.fakeHost,
        close: vi.fn(async () => undefined),
      };
      const prepareAttempt = vi
        .fn<(port: number) => Promise<BridgeAttemptProof>>()
        .mockResolvedValueOnce(firstProof)
        .mockResolvedValueOnce(repeatedProof);
      const harness = createMineflayerConnectionHarness({ prepareAttempt });
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect().catch((error: unknown) => error);
      await flushAttempt();
      harness.end("first attempt ended");
      await flushAttempt();
      harness.runNextTimer();
      await flushAttempt();
      if (harness.bots.length > 1) await connection.disconnect();
      const rejection = await connecting;

      expect(rejection).toMatchObject({ code: "MINECRAFT_BRIDGE_REQUIRED" });
      expect(harness.bots).toHaveLength(1);
      expect(firstProof.close).toHaveBeenCalledOnce();
      expect(repeatedProof.close).toHaveBeenCalledOnce();
    });

    it("fails closed if an issuer reuses a closed proof object with changed text", async () => {
      const reusedProof = {
        fakeHost: "127.0.0.1\0WL1\0first-proof-text",
        close: vi.fn(async () => undefined),
      };
      const prepareAttempt = vi.fn(async () => reusedProof);
      const harness = createMineflayerConnectionHarness({ prepareAttempt });
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect().catch((error: unknown) => error);
      await flushAttempt();
      harness.end("first attempt ended");
      reusedProof.fakeHost = "127.0.0.1\0WL1\0changed-proof-text";
      await flushAttempt();
      harness.runNextTimer();
      await flushAttempt();
      if (harness.bots.length > 1) await connection.disconnect();
      const rejection = await connecting;

      expect(rejection).toMatchObject({ code: "MINECRAFT_BRIDGE_REQUIRED" });
      expect(harness.bots).toHaveLength(1);
      expect(reusedProof.close).toHaveBeenCalledOnce();
    });

    it("replaces a raw pre-spawn end payload with a fixed public outage reason", async () => {
      const secret =
        "nonce-secret 127.0.0.1:25565 C:\\Users\\Owner\\WhiteLily\\bridge\\requests\\private.json";
      const harness = createMineflayerConnectionHarness();
      const connection = new MineflayerConnection(harness.dependencies);
      const events: unknown[] = [];
      connection.onEvent((event) => events.push(event));
      const connecting = connection.connect().catch((error: unknown) => error);
      await flushAttempt();

      harness.end(secret);

      expect(events).toEqual([{ kind: "outage", reason: "Minecraft connection ended" }]);
      expect(JSON.stringify(events)).not.toContain(secret);
      await connection.disconnect();
      await connecting;
    });

    it.each(["createBot", "setup"] as const)(
      "closes the proof exactly once when %s throws and never exposes the thrown text",
      async (failurePoint) => {
        const secret = "nonce-secret C:\\private\\bridge-request.json";
        const harness = createMineflayerConnectionHarness({
          ...(failurePoint === "createBot" ? { createBotError: new Error(secret) } : {}),
          ...(failurePoint === "setup"
            ? {
                configureBot: (bot: FakeBot) => {
                  bot.loadPlugin.mockImplementation(() => {
                    throw new Error(secret);
                  });
                },
              }
            : {}),
        });
        const connection = new MineflayerConnection(harness.dependencies);
        const events: string[] = [];
        connection.onEvent((event) => events.push(JSON.stringify(event)));
        const connecting = connection.connect().catch((error: unknown) => error);

        await flushAttempt();
        expect(harness.proofs).toHaveLength(1);
        expect(harness.proofs[0]?.close).toHaveBeenCalledOnce();
        expect(events.join(" ")).not.toContain(secret);
        await connection.disconnect();
        await connecting;
      },
    );

    it.each(["error", "kicked", "end"] as const)(
      "closes a pre-spawn proof once across crossed and duplicate %s callbacks",
      async (terminalEvent) => {
        const harness = createMineflayerConnectionHarness();
        const connection = new MineflayerConnection(harness.dependencies);
        const connecting = connection.connect().catch((error: unknown) => error);
        await flushAttempt();
        const bot = harness.bots[0]!;

        if (terminalEvent === "error") {
          bot.emit("error", new Error("nonce-secret"));
          bot.emit("error", new Error("duplicate-secret"));
          bot.emit("kicked", "crossed-secret", false);
          bot.emit("end", "crossed-end-secret");
        } else if (terminalEvent === "kicked") {
          bot.emit("kicked", "nonce-secret", false);
          bot.emit("kicked", "duplicate-secret", false);
          bot.emit("error", new Error("crossed-secret"));
          bot.emit("end", "crossed-end-secret");
        } else {
          bot.emit("end", "nonce-secret");
          bot.emit("end", "duplicate-secret");
          bot.emit("error", new Error("crossed-secret"));
          bot.emit("kicked", "crossed-kick-secret", false);
        }

        await flushAttempt();
        expect(harness.proofs).toHaveLength(1);
        expect(harness.proofs[0]?.close).toHaveBeenCalledOnce();
        expect(harness.pendingTimers()).toBe(1);
        await connection.disconnect();
        await connecting;
      },
    );

    it("closes a connected attempt proof once before later disconnect callbacks", async () => {
      const harness = createMineflayerConnectionHarness();
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect();
      await flushAttempt();
      harness.spawn();
      await connecting;

      expect(harness.proofs[0]?.close).toHaveBeenCalledOnce();
      harness.end("private disconnect reason");
      harness.end("duplicate private disconnect reason");
      expect(harness.proofs[0]?.close).toHaveBeenCalledOnce();
      await connection.disconnect();
    });

    it("uses a unique proof for every attempt and terminates at exactly five login rejections", async () => {
      const harness = createMineflayerConnectionHarness();
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect().catch((error: unknown) => error);

      await flushAttempt();
      for (let rejectionIndex = 0; rejectionIndex < 5; rejectionIndex += 1) {
        harness.kick(`private rejection ${rejectionIndex}`, false);
        await flushAttempt();
        if (rejectionIndex < 4) {
          expect(harness.pendingTimers()).toBe(1);
          harness.runNextTimer();
          await flushAttempt();
        }
      }

      expect(connection.state()).toBe("exhausted");
      expect(harness.pendingTimers()).toBe(0);
      const rejection = await connecting;
      expect(rejection).toMatchObject({ code: "MINECRAFT_BRIDGE_REJECTED" });
      expect(harness.proofs).toHaveLength(5);
      expect(new Set(harness.proofs.map((proof) => proof.fakeHost)).size).toBe(5);
      expect(harness.botOptions).toEqual(
        harness.proofs.map((proof) => expect.objectContaining({ fakeHost: proof.fakeHost })),
      );
      for (const proof of harness.proofs) expect(proof.close).toHaveBeenCalledOnce();
    });

    it("does not classify five post-login kicks as Bridge login rejections", async () => {
      const harness = createMineflayerConnectionHarness();
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect().catch((error: unknown) => error);

      await flushAttempt();
      for (let kickIndex = 0; kickIndex < 5; kickIndex += 1) {
        harness.kick(`private post-login kick ${kickIndex}`, true);
        await flushAttempt();
        expect(harness.pendingTimers()).toBe(1);
        if (kickIndex < 4) {
          harness.runNextTimer();
          await flushAttempt();
        }
      }

      expect(connection.state()).toBe("retrying");
      expect(harness.bots).toHaveLength(5);
      let settled = false;
      void connecting.then(() => {
        settled = true;
      });
      await flushAttempt();
      expect(settled).toBe(false);
      await connection.disconnect();
      await connecting;
    });

    it("counts only confirmed login rejections across mixed retry failures", async () => {
      const harness = createMineflayerConnectionHarness();
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect().catch((error: unknown) => error);
      await flushAttempt();

      for (let rejectionIndex = 0; rejectionIndex < 4; rejectionIndex += 1) {
        harness.kick(`private rejection ${rejectionIndex}`, false);
        await flushAttempt();
        harness.runNextTimer();
        await flushAttempt();
      }
      harness.bots.at(-1)?.emit("error", new Error("private unrelated failure"));
      await flushAttempt();
      expect(connection.state()).toBe("retrying");
      harness.runNextTimer();
      await flushAttempt();
      harness.kick("private fifth rejection", false);

      const rejection = await connecting;
      expect(rejection).toMatchObject({ code: "MINECRAFT_BRIDGE_REJECTED" });
      expect(harness.bots).toHaveLength(6);
      expect(harness.pendingTimers()).toBe(0);
    });

    it("emits one terminal Bridge code after post-connect automatic rejection retries", async () => {
      const harness = createMineflayerConnectionHarness();
      const connection = new MineflayerConnection(harness.dependencies);
      const events: unknown[] = [];
      connection.onEvent((event) => events.push(event));
      const connecting = connection.connect();
      await flushAttempt();
      harness.spawn();
      await connecting;

      harness.end("connected session ended");
      await flushAttempt();
      for (let rejectionIndex = 0; rejectionIndex < 5; rejectionIndex += 1) {
        harness.runNextTimer();
        await flushAttempt();
        harness.kick(`private rejection ${rejectionIndex}`, false);
        await flushAttempt();
      }

      expect(connection.state()).toBe("exhausted");
      expect(harness.proofs).toHaveLength(6);
      expect(
        events.filter((event) => (event as { kind?: string }).kind === "bridge_failed"),
      ).toEqual([{ kind: "bridge_failed", code: "MINECRAFT_BRIDGE_REJECTED" }]);
    });

    it.each(["prepare", "close"] as const)(
      "emits one Bridge-required terminal event when post-connect proof %s fails",
      async (failurePoint) => {
        const secret = `private ${failurePoint} failure C:\\Users\\Owner\\request.json`;
        const firstProof = {
          fakeHost: "127.0.0.1\0WL1\0post-connect-first",
          close: vi.fn(async () => undefined),
        };
        const secondProof = {
          fakeHost: "127.0.0.1\0WL1\0post-connect-second",
          close: vi.fn(async () => {
            if (failurePoint === "close") throw new Error(secret);
          }),
        };
        const prepareAttempt = vi
          .fn<(port: number) => Promise<BridgeAttemptProof>>()
          .mockResolvedValueOnce(firstProof)
          .mockImplementationOnce(async () => {
            if (failurePoint === "prepare") throw new Error(secret);
            return secondProof;
          });
        const harness = createMineflayerConnectionHarness({ prepareAttempt });
        const connection = new MineflayerConnection(harness.dependencies);
        const events: unknown[] = [];
        connection.onEvent((event) => events.push(event));
        const connecting = connection.connect();
        await flushAttempt();
        harness.spawn();
        await connecting;

        harness.end("connected session ended");
        await flushAttempt();
        harness.runNextTimer();
        await flushAttempt();
        if (failurePoint === "close") harness.spawn(1);
        await flushAttempt();

        expect(connection.state()).toBe("exhausted");
        expect(
          events.filter((event) => (event as { kind?: string }).kind === "bridge_failed"),
        ).toEqual([{ kind: "bridge_failed", code: "MINECRAFT_BRIDGE_REQUIRED" }]);
        expect(JSON.stringify(events)).not.toContain(secret);
      },
    );

    it("closes the proof once and enters a terminal fence when every close API fails", async () => {
      const harness = createMineflayerConnectionHarness({
        configureBot: (bot) => {
          bot.end.mockImplementation(() => {
            throw new Error("private bot close failure");
          });
          Object.assign(bot._client, {
            end: undefined,
            socket: {
              end: vi.fn(() => {
                throw new Error("private socket end failure");
              }),
              destroy: vi.fn(() => {
                throw new Error("private socket destroy failure");
              }),
            },
          });
        },
      });
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect().catch((error: unknown) => error);
      await flushAttempt();
      harness.bots[0]?.emit("error", new Error("private nonce"));
      const rejection = await connecting;

      expect(rejection).toMatchObject({ name: "MineflayerTransportFenceError" });
      expect(harness.proofs[0]?.close).toHaveBeenCalledOnce();
      expect(connection.state()).toBe("exhausted");
      expect(harness.pendingTimers()).toBe(0);
    });
  });
});
