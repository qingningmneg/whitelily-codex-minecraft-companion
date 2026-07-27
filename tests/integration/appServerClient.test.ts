import { describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  CodexAppServerClient,
  type CodexAppServerClientDependencies,
  type LoginStatusResult,
} from "../../src/codex/appServerClient.js";
import type { AppConfig } from "../../src/config/schema.js";
import { createJsonRpcLineTransportHarness } from "../support/jsonRpcProcessHarness.js";

const config: AppConfig = {
  minecraft: {
    host: "127.0.0.1",
    port: 25565,
    botUsername: "WhiteLily",
    ownerUsername: "Owner",
  },
  codex: {
    preferredModel: "gpt-5.6-terra",
    reasoningEffort: "medium",
    allowApiKeyFallback: false,
  },
  companion: { startMode: "friend", personaName: "白百合" },
  safety: {
    spawnProtectionRadius: 16,
    breakConfirmationThreshold: 32,
    placeConfirmationThreshold: 128,
    travelConfirmationDistance: 256,
  },
};

const initialized = {
  userAgent: "codex/0.145.0",
  codexHome: "D:/codex-home",
  platformFamily: "windows",
  platformOs: "windows",
};

function login(stdout: string, exitCode = 0): () => Promise<LoginStatusResult> {
  return async () => ({ stdout, stderr: "", exitCode });
}

function dependencies(
  harness: ReturnType<typeof createJsonRpcLineTransportHarness>,
  runLoginStatus: (signal: AbortSignal) => Promise<LoginStatusResult> = login(
    "Logged in using ChatGPT\n",
  ),
): CodexAppServerClientDependencies {
  return {
    runLoginStatus,
    createTransport: async () => harness.transport,
    workspacePath: "C:/WhiteLily/codex-workspace",
  };
}

describe("CodexAppServerClient", () => {
  it("shares concurrent ChatGPT preflight and reuses it when starting the app server", async () => {
    const harness = createJsonRpcLineTransportHarness();
    let loginCalls = 0;
    let releaseLogin!: (result: LoginStatusResult) => void;
    const client = new CodexAppServerClient(
      config,
      dependencies(
        harness,
        () =>
          new Promise<LoginStatusResult>((resolve) => {
            loginCalls += 1;
            releaseLogin = resolve;
          }),
      ),
    );

    const first = client.assertChatGptLogin();
    const second = client.assertChatGptLogin();
    expect(second).toBe(first);
    expect(loginCalls).toBe(1);
    releaseLogin({ stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0 });
    await Promise.all([first, second]);

    const starting = client.start();
    await expect(harness.nextSent()).resolves.toMatchObject({ id: 1, method: "initialize" });
    harness.receive({ id: 1, result: initialized });
    await starting;
    expect(loginCalls).toBe(1);
    await client.stop();
  });

  it("aborts a deferred preflight without awaiting an abort-ignoring operation, then restarts", async () => {
    const harness = createJsonRpcLineTransportHarness();
    const releases: Array<(result: LoginStatusResult) => void> = [];
    const signals: AbortSignal[] = [];
    const client = new CodexAppServerClient(
      config,
      dependencies(
        harness,
        (signal) =>
          new Promise<LoginStatusResult>((resolve) => {
            signals.push(signal);
            releases.push(resolve);
          }),
      ),
    );

    const checking = client.assertChatGptLogin().catch((error: unknown) => error);
    const stopping = client.stop();
    const duringStop = client.assertChatGptLogin();
    await expect(duringStop).rejects.toThrow("stopping");
    const stopOutcome = await Promise.race([
      stopping.then(() => "stopped"),
      delay(75, "timed_out"),
    ]);
    expect(signals[0]?.aborted).toBe(true);
    expect(stopOutcome).toBe("stopped");
    await expect(checking).resolves.toMatchObject({ message: expect.stringContaining("stopped") });

    releases[0]?.({ stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0 });
    await Promise.resolve();

    const secondCheck = client.assertChatGptLogin();
    expect(signals).toHaveLength(2);
    releases[1]?.({ stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0 });
    await secondCheck;
    const starting = client.start();
    await expect(harness.nextSent()).resolves.toMatchObject({ id: 1, method: "initialize" });
    harness.receive({ id: 1, result: initialized });
    await starting;
    expect(signals).toHaveLength(2);
    await client.stop();
  });

  it("clears the injected preflight timeout when an abort-ignoring check is stopped", async () => {
    vi.useFakeTimers();
    try {
      const harness = createJsonRpcLineTransportHarness();
      const client = new CodexAppServerClient(
        config,
        dependencies(harness, () => new Promise<LoginStatusResult>(() => undefined)),
      );

      const checking = client.assertChatGptLogin().catch((error: unknown) => error);
      expect(vi.getTimerCount()).toBe(1);

      await client.stop();
      await expect(checking).resolves.toMatchObject({
        message: expect.stringContaining("stopped"),
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the typed turn id exactly once before its completion", async () => {
    const harness = createJsonRpcLineTransportHarness();
    const client = new CodexAppServerClient(config, dependencies(harness));
    const starting = client.start();
    await harness.nextSent();
    harness.receive({ id: 1, result: initialized });
    await starting;
    await harness.nextSent();

    const started: string[] = [];
    const turn = client.sendTurn("thread-1", "hello", (turnId) => started.push(turnId));
    await harness.nextSent();
    harness.receive({ id: 2, result: { turn: { id: "turn-callback" } } });
    await Promise.resolve();
    expect(started).toEqual(["turn-callback"]);
    harness.receive({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-callback", status: "completed" } },
    });
    await turn;
    expect(started).toEqual(["turn-callback"]);
  });

  it("rejects instead of hanging when a turn-start callback throws", async () => {
    const harness = createJsonRpcLineTransportHarness();
    const client = new CodexAppServerClient(config, dependencies(harness));
    const starting = client.start();
    await harness.nextSent();
    harness.receive({ id: 1, result: initialized });
    await starting;
    await harness.nextSent();
    const turn = client.sendTurn("thread-1", "hello", () => {
      throw new Error("callback failed");
    });
    await harness.nextSent();
    harness.receive({ id: 2, result: { turn: { id: "turn-callback" } } });
    await expect(turn).rejects.toThrow("callback failed");
  });

  it("runs a ChatGPT-gated read-only session and combines streamed answer deltas", async () => {
    const harness = createJsonRpcLineTransportHarness();
    const client = new CodexAppServerClient(config, dependencies(harness));
    const start = client.start();
    await expect(harness.nextSent()).resolves.toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "whitelily-companion", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    });
    harness.receive({ id: 1, result: initialized });
    await start;
    await expect(harness.nextSent()).resolves.toEqual({ method: "initialized", params: {} });

    const listed = client.listModels();
    await expect(harness.nextSent()).resolves.toEqual({ id: 2, method: "model/list", params: {} });
    harness.receive({
      id: 2,
      result: {
        data: [
          { id: "terra-display", model: "gpt-5.6-terra" },
          { id: "luna-display", model: "gpt-5.6-luna" },
        ],
        nextCursor: null,
      },
    });
    await expect(listed).resolves.toEqual(["gpt-5.6-terra", "gpt-5.6-luna"]);

    const thread = client.startThread({
      cwd: "C:/unsafe-caller-directory",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
    await expect(harness.nextSent()).resolves.toEqual({
      id: 3,
      method: "thread/start",
      params: {
        model: "gpt-5.6-terra",
        cwd: "C:/WhiteLily/codex-workspace",
        sandbox: "read-only",
        approvalPolicy: "never",
      },
    });
    harness.receive({ id: 3, result: { thread: { id: "thread-1" } } });
    await expect(thread).resolves.toBe("thread-1");

    const turn = client.sendTurn("thread-1", "请跟着我");
    await expect(harness.nextSent()).resolves.toEqual({
      id: 4,
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "请跟着我", text_elements: [] }],
        effort: "medium",
      },
    });
    harness.receive({ id: 4, result: { turn: { id: "turn-1" } } });
    harness.receive({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "我在" },
    });
    harness.receive({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "这里。" },
    });
    harness.receive({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    await expect(turn).resolves.toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      text: "我在这里。",
      status: "completed",
    });

    const failedTurn = client.sendTurn("thread-1", "失败测试");
    await expect(harness.nextSent()).resolves.toMatchObject({ id: 5, method: "turn/start" });
    harness.receive({ id: 5, result: { turn: { id: "turn-2" } } });
    harness.receive({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "failed" } },
    });
    await expect(failedTurn).resolves.toMatchObject({
      turnId: "turn-2",
      text: "",
      status: "failed",
    });

    const interruptedTurn = client.sendTurn("thread-1", "中断测试");
    await expect(harness.nextSent()).resolves.toMatchObject({ id: 6, method: "turn/start" });
    harness.receive({ id: 6, result: { turn: { id: "turn-3" } } });
    harness.receive({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-3", status: "interrupted" } },
    });
    await expect(interruptedTurn).resolves.toMatchObject({
      turnId: "turn-3",
      text: "",
      status: "interrupted",
    });
  });

  it("refuses an API-key login before spawning the app server", async () => {
    const harness = createJsonRpcLineTransportHarness();
    let processStarted = false;
    const deps = dependencies(harness, login("Logged in using an API key\n"));
    deps.createTransport = async () => {
      processStarted = true;
      return harness.transport;
    };
    const client = new CodexAppServerClient(config, deps);

    await expect(client.start()).rejects.toThrow(
      "Codex must be signed in with ChatGPT. API-key billing is disabled for WhiteLily.",
    );
    expect(processStarted).toBe(false);
  });

  it("accepts an exact ChatGPT login line within CRLF status output", async () => {
    const harness = createJsonRpcLineTransportHarness();
    const client = new CodexAppServerClient(
      config,
      dependencies(harness, login("Codex status\r\nLogged in using ChatGPT\r\nReady\r\n")),
    );

    await expect(client.assertChatGptLogin()).resolves.toBeUndefined();
  });

  it.each([" Logged in using ChatGPT", "Logged in using ChatGPT ", "Logged in using ChatGPT\t"])(
    "rejects a whitespace-mutated ChatGPT login line: %j",
    async (stdout) => {
      const harness = createJsonRpcLineTransportHarness();
      const client = new CodexAppServerClient(config, dependencies(harness, login(`${stdout}\n`)));

      await expect(client.assertChatGptLogin()).rejects.toThrow(
        "Codex must be signed in with ChatGPT",
      );
    },
  );

  it("adds a doctor hint when login status cannot access Codex credentials", async () => {
    const harness = createJsonRpcLineTransportHarness();
    const client = new CodexAppServerClient(
      config,
      dependencies(harness, login("Access denied\n", 1)),
    );

    await expect(client.start()).rejects.toThrow("scripts\\doctor.ps1");
  });

  it("fails closed when login status exceeds ten seconds", async () => {
    const harness = createJsonRpcLineTransportHarness();
    const deps = dependencies(harness, () => new Promise<LoginStatusResult>(() => undefined));
    deps.loginTimeoutMs = 1;
    const client = new CodexAppServerClient(config, deps);

    await expect(client.start()).rejects.toThrow(
      "Codex must be signed in with ChatGPT. API-key billing is disabled for WhiteLily.",
    );
  });

  it("aborts an injected login status check when its startup timeout expires", async () => {
    const harness = createJsonRpcLineTransportHarness();
    let aborted = false;
    const deps = dependencies(
      harness,
      (signal) =>
        new Promise<LoginStatusResult>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    deps.loginTimeoutMs = 1;
    const client = new CodexAppServerClient(config, deps);

    await expect(client.start()).rejects.toThrow("Codex must be signed in with ChatGPT");
    expect(aborted).toBe(true);
  });

  it("allows only one Codex thread for a game session", async () => {
    const harness = createJsonRpcLineTransportHarness();
    const client = new CodexAppServerClient(config, dependencies(harness));
    const start = client.start();
    await harness.nextSent();
    harness.receive({ id: 1, result: initialized });
    await start;
    await harness.nextSent();

    const firstThread = client.startThread({
      cwd: "C:/ignored",
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
    });
    await harness.nextSent();
    harness.receive({ id: 2, result: { thread: { id: "thread-1" } } });
    await firstThread;

    const duplicate = client.startThread({
      cwd: "C:/ignored",
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
    });
    void duplicate.catch(() => undefined);

    expect(harness.sent()).not.toContainEqual(
      expect.objectContaining({ id: 3, method: "thread/start" }),
    );
  });

  it("settles an active turn when the app-server child exits", async () => {
    const harness = createJsonRpcLineTransportHarness();
    const client = new CodexAppServerClient(config, dependencies(harness));
    const start = client.start();
    await harness.nextSent();
    harness.receive({ id: 1, result: initialized });
    await start;
    await harness.nextSent();

    const turn = client.sendTurn("thread-1", "连接测试");
    await harness.nextSent();
    harness.receive({ id: 2, result: { turn: { id: "turn-1" } } });
    await Promise.resolve();
    harness.exit(new Error("child exited"));

    await expect(turn).rejects.toThrow("child exited");
  });

  it("settles an active turn when the client stops", async () => {
    const harness = createJsonRpcLineTransportHarness();
    const client = new CodexAppServerClient(config, dependencies(harness));
    const start = client.start();
    await harness.nextSent();
    harness.receive({ id: 1, result: initialized });
    await start;
    await harness.nextSent();

    const turn = client.sendTurn("thread-1", "停止测试");
    await harness.nextSent();
    harness.receive({ id: 2, result: { turn: { id: "turn-1" } } });
    await client.stop();

    await expect(turn).rejects.toThrow("stopped");
  });

  it("interrupts an overlong turn, then closes the app server after a bounded grace period", async () => {
    vi.useFakeTimers();
    try {
      const harness = createJsonRpcLineTransportHarness();
      const deps = dependencies(harness);
      deps.requestTimeoutMs = 1_000;
      deps.turnTimeoutMs = 25;
      deps.turnInterruptGraceMs = 10;
      const client = new CodexAppServerClient(config, deps);
      const starting = client.start();
      await harness.nextSent();
      harness.receive({ id: 1, result: initialized });
      await starting;
      await harness.nextSent();

      const turn = client.sendTurn("thread-1", "overlong");
      const outcome = turn.catch((error: unknown) => error);
      await harness.nextSent();
      harness.receive({ id: 2, result: { turn: { id: "turn-overlong" } } });
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(25);
      expect(harness.sent()).toContainEqual({
        id: 3,
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-overlong" },
      });

      await vi.advanceTimersByTimeAsync(10);
      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining("turn timed out"),
      });
      expect(harness.closed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares concurrent startup callers instead of spawning a second app server", async () => {
    const harness = createJsonRpcLineTransportHarness();
    let transports = 0;
    const deps = dependencies(harness);
    deps.createTransport = async () => {
      transports += 1;
      return harness.transport;
    };
    const client = new CodexAppServerClient(config, deps);
    const first = client.start();
    const second = client.start();

    await expect(harness.nextSent()).resolves.toMatchObject({ id: 1, method: "initialize" });
    harness.receive({ id: 1, result: initialized });
    await Promise.all([first, second]);

    expect(transports).toBe(1);
  });

  it("stops during hung transport creation and closes the old transport after a fresh start", async () => {
    const first = createJsonRpcLineTransportHarness();
    const second = createJsonRpcLineTransportHarness();
    let transportCalls = 0;
    let markTransportReached!: () => void;
    const transportReached = new Promise<void>((resolve) => {
      markTransportReached = resolve;
    });
    let releaseFirstTransport!: (transport: typeof first.transport) => void;
    const firstTransport = new Promise<typeof first.transport>((resolve) => {
      releaseFirstTransport = resolve;
    });
    const deps = dependencies(first);
    deps.createTransport = () => {
      transportCalls += 1;
      if (transportCalls === 1) {
        markTransportReached();
        return firstTransport;
      }
      return Promise.resolve(second.transport);
    };
    const client = new CodexAppServerClient(config, deps);

    const oldStart = client.start().catch((error: unknown) => error);
    await transportReached;
    const stopping = client.stop();
    const stopOutcome = await Promise.race([
      stopping.then(() => "stopped"),
      delay(75, "timed_out"),
    ]);

    let freshStart: Promise<void> | undefined;
    if (stopOutcome === "stopped") {
      freshStart = client.start();
      await expect(second.nextSent()).resolves.toMatchObject({ id: 1, method: "initialize" });
      second.receive({ id: 1, result: initialized });
      await freshStart;
    }

    releaseFirstTransport(first.transport);
    await stopping.catch(() => undefined);
    await oldStart;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stopOutcome).toBe("stopped");
    expect(transportCalls).toBe(2);
    expect(first.closed()).toBe(true);
    expect(first.sent()).toEqual([]);
    expect(second.closed()).toBe(false);
    await client.stop();
  });

  it("does not revive after stop races a pending login check", async () => {
    const harness = createJsonRpcLineTransportHarness();
    let resolveLogin!: (result: LoginStatusResult) => void;
    const deps = dependencies(
      harness,
      () =>
        new Promise<LoginStatusResult>((resolveResult) => {
          resolveLogin = resolveResult;
        }),
    );
    let transports = 0;
    deps.createTransport = async () => {
      transports += 1;
      return harness.transport;
    };
    const client = new CodexAppServerClient(config, deps);
    const starting = client.start();
    const stopping = client.stop();
    resolveLogin({ stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0 });

    await stopping;
    await expect(starting).rejects.toThrow("stopped during startup");
    expect(transports).toBe(0);
  });

  it("aborts and stops without waiting for an in-flight login check", async () => {
    const harness = createJsonRpcLineTransportHarness();
    let resolveLogin!: (result: LoginStatusResult) => void;
    let aborted = false;
    const deps = dependencies(
      harness,
      (signal) =>
        new Promise<LoginStatusResult>((resolveResult) => {
          resolveLogin = resolveResult;
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const client = new CodexAppServerClient(config, deps);

    const starting = client.start().catch((error: unknown) => error);
    const stopping = client.stop();
    const stopOutcome = await Promise.race([
      stopping.then(() => "stopped"),
      delay(75, "timed_out"),
    ]);
    expect(aborted).toBe(true);
    expect(stopOutcome).toBe("stopped");
    await expect(starting).resolves.toMatchObject({ message: expect.stringContaining("stopped") });

    resolveLogin({ stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0 });
    await Promise.resolve();
  });

  it("shares concurrent stops and fails closed if app-server termination fails", async () => {
    const harness = createJsonRpcLineTransportHarness();
    const close = vi.fn(async () => {
      throw new Error("process tree could not be terminated");
    });
    harness.transport.close = close;
    const client = new CodexAppServerClient(config, dependencies(harness));
    const starting = client.start();
    await harness.nextSent();
    harness.receive({ id: 1, result: initialized });
    await starting;
    await harness.nextSent();

    const first = client.stop();
    const second = client.stop();

    expect(first).toBe(second);
    await expect(first).rejects.toThrow("process tree could not be terminated");
    await expect(second).rejects.toThrow("process tree could not be terminated");
    expect(close).toHaveBeenCalledOnce();
    await expect(client.start()).rejects.toThrow("stopping");
  });

  it("rejects a fresh start while stopping an in-flight login", async () => {
    const harness = createJsonRpcLineTransportHarness();
    let resolveLogin!: (result: LoginStatusResult) => void;
    const deps = dependencies(
      harness,
      () =>
        new Promise<LoginStatusResult>((resolveResult) => {
          resolveLogin = resolveResult;
        }),
    );
    const client = new CodexAppServerClient(config, deps);

    const starting = client.start();
    const stopping = client.stop();

    await expect(client.start()).rejects.toThrow("stopping");
    resolveLogin({ stdout: "Logged in using ChatGPT\n", stderr: "", exitCode: 0 });
    await stopping;
    await expect(starting).rejects.toThrow("stopped during startup");
  });

  it("can start a fresh app-server generation after a completed stop", async () => {
    const first = createJsonRpcLineTransportHarness();
    const second = createJsonRpcLineTransportHarness();
    let calls = 0;
    const deps = dependencies(first);
    deps.createTransport = async () => (calls++ === 0 ? first.transport : second.transport);
    const client = new CodexAppServerClient(config, deps);
    const startOne = client.start();
    await first.nextSent();
    first.receive({ id: 1, result: initialized });
    await startOne;
    await first.nextSent();
    await client.stop();

    const startTwo = client.start();
    await second.nextSent();
    second.receive({ id: 1, result: initialized });
    await startTwo;
    expect(calls).toBe(2);
  });

  it("follows model-list cursors and rejects a repeated cursor", async () => {
    const harness = createJsonRpcLineTransportHarness();
    const client = new CodexAppServerClient(config, dependencies(harness));
    const start = client.start();
    await harness.nextSent();
    harness.receive({ id: 1, result: initialized });
    await start;
    await harness.nextSent();

    const listed = client.listModels();
    await harness.nextSent();
    harness.receive({
      id: 2,
      result: { data: [{ model: "gpt-5.6-terra" }], nextCursor: "page-2" },
    });
    await Promise.resolve();
    expect(harness.sent()).toContainEqual({
      id: 3,
      method: "model/list",
      params: { cursor: "page-2" },
    });
    harness.receive({ id: 3, result: { data: [{ model: "gpt-5.6-luna" }], nextCursor: null } });
    await expect(listed).resolves.toEqual(["gpt-5.6-terra", "gpt-5.6-luna"]);
  });
});
