import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createCodexAppServerSpawnSpec,
  JsonRpcProcess,
  runCodexLoginStatus,
  spawnCodexAppServerTransport,
  terminateCodexProcessTree,
} from "../../src/codex/jsonRpcProcess.js";
import { createJsonRpcProcessHarness } from "../support/jsonRpcProcessHarness.js";

function processDouble(options: { pid?: number; exitCode?: number | null } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: options.pid ?? 42,
    exitCode: options.exitCode ?? null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  });
  return child;
}

describe("JsonRpcProcess", () => {
  it("matches a response to its request id without sending JSON-RPC version fields", async () => {
    const harness = createJsonRpcProcessHarness();
    const response = harness.process.request("model/list", {});

    expect(harness.sent()).toEqual([{ id: 1, method: "model/list", params: {} }]);
    harness.receive({ id: 1, result: { data: [{ id: "gpt-5.6-terra" }] } });

    await expect(response).resolves.toEqual({ data: [{ id: "gpt-5.6-terra" }] });
  });

  it("delivers server notifications to subscribers", () => {
    const harness = createJsonRpcProcessHarness();
    const notifications: unknown[] = [];
    harness.process.onNotification((notification) => notifications.push(notification));

    harness.receive({ method: "turn/completed", params: { threadId: "thread-1" } });

    expect(notifications).toEqual([{ method: "turn/completed", params: { threadId: "thread-1" } }]);
  });

  it("rejects outstanding requests when the child process exits", async () => {
    const harness = createJsonRpcProcessHarness();
    const response = harness.process.request("thread/start", {});
    harness.exit(new Error("child exited"));

    await expect(response).rejects.toThrow("child exited");
  });

  it("rejects a request made after the child exits instead of writing to a dead process", async () => {
    const harness = createJsonRpcProcessHarness();
    harness.exit(new Error("child exited"));

    await expect(harness.process.request("model/list", {})).rejects.toThrow("stopped");
  });

  it("shares a failing transport close with concurrent callers", async () => {
    const harness = createJsonRpcProcessHarness();
    let closeCalls = 0;
    harness.transport.close = async () => {
      closeCalls += 1;
      throw new Error("cannot terminate app server");
    };
    const process = new JsonRpcProcess(harness.transport);

    const first = process.close();
    const second = process.close();

    expect(first).toBe(second);
    await expect(first).rejects.toThrow("cannot terminate app server");
    await expect(second).rejects.toThrow("cannot terminate app server");
    expect(closeCalls).toBe(1);
  });

  it("fatally closes a silent app server when a request watchdog expires", async () => {
    vi.useFakeTimers();
    try {
      const harness = createJsonRpcProcessHarness({ requestTimeoutMs: 25 });
      const request = harness.process.request("model/list", {});
      const outcome = request.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);

      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining("request timed out"),
      });
      expect(harness.closed()).toBe(true);
      await expect(harness.process.request("model/list", {})).rejects.toThrow("stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains child stderr and fatally closes on an oversized stdout line", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    const terminate = vi.fn(async () => undefined);
    const transport = spawnCodexAppServerTransport("C:/WhiteLily/codex.cmd", {
      maxBufferedLineBytes: 32,
      spawnProcess: () => child as never,
      terminateProcessTree: terminate,
    });
    const exit = new Promise<Error | undefined>((resolve) => transport.onExit(resolve));

    expect(child.stderr.readableFlowing).toBe(true);
    for (let chunk = 0; chunk < 128; chunk += 1) {
      child.stderr.write(Buffer.alloc(8_192, 120));
    }
    child.stdout.write(Buffer.alloc(33, 120));

    await expect(exit).resolves.toMatchObject({
      message: expect.stringContaining("line exceeded"),
    });
    expect(terminate).toHaveBeenCalledWith(child);
  });

  it("uses a hidden command processor on Windows and strips API credentials", () => {
    const spec = createCodexAppServerSpawnSpec(
      "win32",
      "C:\\WhiteLily\\node_modules\\.bin\\codex.cmd",
      {
        PATH: "C:\\Windows",
        OPENAI_API_KEY: "platform-key",
        openai_api_key: "mixed-platform-key",
        CODEX_API_KEY: "legacy-key",
        CodEx_AcCeSs_ToKeN: "mixed-access-token",
        CODEX_ACCESS_TOKEN: "access-token",
      },
    );

    expect(spec).toEqual({
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\WhiteLily\\node_modules\\.bin\\codex.cmd" app-server --listen stdio://"',
      ],
      env: { PATH: "C:\\Windows" },
      windowsHide: true,
    });
  });

  it("rejects Windows executable paths that can expand command variables", () => {
    for (const executable of ["C:\\%USERPROFILE%\\codex.cmd", "C:\\!APP!\\codex.cmd"]) {
      expect(() => createCodexAppServerSpawnSpec("win32", executable, {})).toThrow(
        "invalid local Codex executable path",
      );
    }
  });

  it("terminates a hanging login-status child when its timeout expires", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      kill() {
        this.killed = true;
        return true;
      },
    });

    const status = runCodexLoginStatus(
      "C:/WhiteLily/node_modules/.bin/codex.cmd",
      1,
      () => child as never,
      undefined,
      async () => {
        child.kill();
        child.emit("close", 1, null);
      },
    );

    await expect(status).rejects.toThrow("login status timed out");
    expect(child.killed).toBe(true);
  });

  it("waits for process-tree termination before reporting a login timeout", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => true),
    });
    let releaseTermination: (() => void) | undefined;
    const termination = vi.fn(
      () =>
        new Promise<void>((resolveResult) => {
          releaseTermination = resolveResult;
        }),
    );

    const status = runCodexLoginStatus(
      "C:/WhiteLily/node_modules/.bin/codex.cmd",
      1,
      () => child as never,
      undefined,
      termination,
    );
    let rejected = false;
    void status.catch(() => {
      rejected = true;
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(termination).toHaveBeenCalledWith(child);
    expect(rejected).toBe(false);

    releaseTermination?.();
    await expect(status).rejects.toThrow("login status timed out");
    vi.useRealTimers();
  });

  it("waits for process-tree termination before reporting a login cancellation", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => true),
    });
    const controller = new AbortController();
    let releaseTermination: (() => void) | undefined;
    const termination = vi.fn(
      () =>
        new Promise<void>((resolveResult) => {
          releaseTermination = resolveResult;
        }),
    );
    const status = runCodexLoginStatus(
      "C:/WhiteLily/node_modules/.bin/codex.cmd",
      100,
      () => child as never,
      controller.signal,
      termination,
    );
    let rejected = false;
    void status.catch(() => {
      rejected = true;
    });

    controller.abort();
    await Promise.resolve();
    expect(termination).toHaveBeenCalledWith(child);
    expect(rejected).toBe(false);

    releaseTermination?.();
    await expect(status).rejects.toThrow("login status cancelled");
  });

  it("runs fixed Windows taskkill arguments and resolves only after the target closes", async () => {
    const target = processDouble({ pid: 73 });
    const killer = processDouble();
    const spawnKiller = vi.fn(() => killer);

    const termination = terminateCodexProcessTree(target, {
      platform: "win32",
      spawnKiller,
      killerTimeoutMs: 100,
      targetExitTimeoutMs: 100,
    });

    expect(spawnKiller).toHaveBeenCalledWith("taskkill.exe", ["/PID", "73", "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    killer.emit("close", 0);
    let resolved = false;
    void termination.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    target.emit("close", 0);
    await expect(termination).resolves.toBeUndefined();
  });

  it("does not spawn a killer for a target that already exited", async () => {
    const target = processDouble({ exitCode: 0 });
    const spawnKiller = vi.fn();

    await expect(
      terminateCodexProcessTree(target, { platform: "win32", spawnKiller }),
    ).resolves.toBeUndefined();

    expect(spawnKiller).not.toHaveBeenCalled();
  });

  it("rejects when taskkill exits unsuccessfully while the target remains alive", async () => {
    const target = processDouble();
    const killer = processDouble();
    const termination = terminateCodexProcessTree(target, {
      platform: "win32",
      spawnKiller: () => killer,
      targetExitTimeoutMs: 100,
    });

    killer.emit("close", 1);

    await expect(termination).rejects.toThrow("taskkill failed");
  });

  it("rejects if taskkill cannot be spawned", async () => {
    const target = processDouble();

    await expect(
      terminateCodexProcessTree(target, {
        platform: "win32",
        spawnKiller: () => {
          throw new Error("no taskkill");
        },
      }),
    ).rejects.toThrow("failed to start taskkill");
  });

  it("kills taskkill and rejects when its watchdog expires", async () => {
    const target = processDouble();
    const killer = processDouble();

    await expect(
      terminateCodexProcessTree(target, {
        platform: "win32",
        spawnKiller: () => killer,
        killerTimeoutMs: 1,
        targetExitTimeoutMs: 100,
      }),
    ).rejects.toThrow("taskkill timed out");

    expect(killer.kill).toHaveBeenCalledOnce();
  });

  it("rejects if a successful taskkill does not close the target", async () => {
    const target = processDouble();
    const killer = processDouble();
    const termination = terminateCodexProcessTree(target, {
      platform: "win32",
      spawnKiller: () => killer,
      killerTimeoutMs: 100,
      targetExitTimeoutMs: 1,
    });
    killer.emit("close", 0);

    await expect(termination).rejects.toThrow("did not exit");
  });

  it("sends a POSIX termination signal but still waits for the target close", async () => {
    const target = processDouble();
    const termination = terminateCodexProcessTree(target, {
      platform: "linux",
      targetExitTimeoutMs: 100,
    });

    expect(target.kill).toHaveBeenCalledOnce();
    target.emit("close", 0);
    await expect(termination).resolves.toBeUndefined();
  });

  it("rejects when a POSIX process cannot be signalled", async () => {
    const target = processDouble();
    target.kill.mockReturnValue(false);

    await expect(
      terminateCodexProcessTree(target, { platform: "linux", targetExitTimeoutMs: 100 }),
    ).rejects.toThrow("failed to terminate");
  });
});
