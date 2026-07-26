import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  MineflayerConnection,
  type MineflayerConnectionDependencies,
} from "../../src/minecraft/mineflayerConnection.js";

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

function createMineflayerConnectionHarness(options?: {
  configureBot?: (bot: FakeBot, index: number) => void;
  createBotError?: Error;
}) {
  const bots: FakeBot[] = [];
  const timers: TimerRecord[] = [];
  const dependencies: MineflayerConnectionDependencies = {
    config: {
      host: "127.0.0.1",
      port: 25_565,
      botUsername: "WhiteLily",
    },
    createBot: () => {
      if (options?.createBotError) throw options.createBotError;
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
    dependencies,
    end(reason: string, index = bots.length - 1) {
      bots[index]?.emit("end", reason);
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
    harness.runNextTimer();
    harness.bots[1]?._client.emit("login", {
      worldState: { name: "minecraft:overworld" },
    });
    harness.spawn();

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
    harness.bots[0]?._client.emit("login", { worldName: "minecraft:overworld" });
    harness.spawn();
    await initial;
    harness.end("socket closed");
    harness.runNextTimer();
    harness.bots[1]!.game.dimension = "the_nether";
    harness.bots[1]?._client.emit("login", { worldName: "minecraft:the_nether" });
    harness.spawn();

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
    harness.spawn();
    await connecting;

    harness.end("socket closed");
    harness.end("duplicate");

    expect(events).toEqual(["connected", "outage"]);
    expect(harness.scheduledDelays()).toEqual([1_000]);
  });

  it("cancels every retry and active operation on disconnect", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const connecting = connection.connect();
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

    expect(second).toBe(first);
    for (const expectedDelay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      expect(harness.scheduledDelays().at(-1)).toBe(expectedDelay);
      harness.runNextTimer();
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
    harness.spawn();
    await initial;
    harness.end("socket closed");

    const first = connection.connect();
    const second = connection.connect();
    expect(second).toBe(first);
    harness.runNextTimer();
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
    harness.spawn();
    await initial;
    harness.end("first outage");
    harness.runNextTimer();
    harness.end("stale duplicate", 0);
    harness.spawn();
    harness.end("second outage");

    expect(events).toEqual(["connected", "outage", "connected", "outage"]);
    expect(harness.scheduledDelays()).toEqual([1_000, 1_000]);
  });

  it("ignores every stale bot event even when listener removal fails", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const kinds: string[] = [];
    connection.onEvent((event) => kinds.push(event.kind));
    const initial = connection.connect();
    harness.spawn();
    await initial;
    harness.bots[0]!.throwOnRemove = true;
    harness.end("socket closed");
    harness.runNextTimer();
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
    harness.end("socket closed");

    await connection.disconnect();

    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    harness.runTimerEvenIfCancelled(0);
    expect(harness.bots).toHaveLength(1);
    expect(harness.bots[0]?.eventNames()).toEqual([]);
    await expect(connection.connect()).rejects.toThrow("adapter is stopped");
  });

  it("detaches partial handlers and safely ends bots when setup throws", () => {
    const harness = createMineflayerConnectionHarness({
      configureBot: (bot) => {
        bot.throwOnEvent = "death";
        bot.end.mockImplementation(() => {
          throw new Error("end failed");
        });
      },
    });
    const connection = new MineflayerConnection(harness.dependencies);

    void connection.connect();

    expect(harness.bots[0]?.eventNames()).toEqual([]);
    expect(harness.bots[0]?.pathfinder.stop).toHaveBeenCalledOnce();
    expect(harness.bots[0]?.clearControlStates).toHaveBeenCalledOnce();
    expect(harness.bots[0]?.end).toHaveBeenCalledOnce();
    expect(harness.scheduledDelays()).toEqual([1_000]);
  });

  it("forwards Mineflayer events through one detachable subscription", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const kinds: string[] = [];
    const unsubscribe = connection.onEvent((event) => kinds.push(event.kind));
    const connecting = connection.connect();
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

  it.each(["client_end", "socket_end", "socket_destroy"] as const)(
    "establishes a physical session fence through the %s fallback before retrying",
    async (successfulFallback) => {
      const harness = createMineflayerConnectionHarness();
      const connection = new MineflayerConnection(harness.dependencies);
      const connecting = connection.connect();
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
});
