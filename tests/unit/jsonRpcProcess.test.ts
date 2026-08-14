import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createCodexAppServerSpawnSpec,
  createBundledCodexLaunchConfig,
  JsonRpcProcess,
  resolveDefaultCodexExecutable,
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

const reviewedExecutables = [
  "vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  "vendor/x86_64-pc-windows-msvc/bin/codex-code-mode-host.exe",
  "vendor/x86_64-pc-windows-msvc/codex-path/rg.exe",
  "vendor/x86_64-pc-windows-msvc/codex-resources/codex-command-runner.exe",
  "vendor/x86_64-pc-windows-msvc/codex-resources/codex-windows-sandbox-setup.exe",
] as const;

const httpProviderArgs = [
  "-c",
  'model_provider="whitelily_openai_http"',
  "-c",
  'model_providers.whitelily_openai_http.name="WhiteLilyHTTP"',
  "-c",
  'model_providers.whitelily_openai_http.base_url="https://chatgpt.com/backend-api/codex"',
  "-c",
  'model_providers.whitelily_openai_http.wire_api="responses"',
  "-c",
  "model_providers.whitelily_openai_http.requires_openai_auth=true",
  "-c",
  "model_providers.whitelily_openai_http.supports_websockets=false",
  "-c",
  'mcp_servers.minecraft.url="http://127.0.0.1:32123/mcp"',
] as const;

function createPackagedCodexFixture(): {
  root: string;
  resources: string;
  dataRoot: string;
  manifestPath: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "whitelily-codex-launch-"));
  const resources = join(root, "resources");
  const native = join(resources, "codex", "native");
  const dataRoot = join(root, "data");
  const exactFiles = reviewedExecutables.map((path, index) => {
    const bytes = Buffer.from(`reviewed-${index}`);
    const target = `codex/native/${path}`;
    const absolute = join(native, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes);
    return {
      source: `node_modules/@openai/codex-win32-x64/${path}`,
      target,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const manifestPath = join(resources, "runtime-manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      paths: {
        codexExecutable: "codex/native/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
      },
      allowlist: {
        exactFiles,
        executableFiles: reviewedExecutables.map((path) => `codex/native/${path}`),
      },
      policySha256: "a".repeat(64),
      resources: exactFiles.map(({ target: path, bytes, sha256 }) => ({
        path,
        bytes,
        sha256,
      })),
    }),
  );
  return {
    root,
    resources,
    dataRoot,
    manifestPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
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

  it("answers an app-server request with the same string request id", async () => {
    const harness = createJsonRpcProcessHarness();
    harness.process.onRequest(async (request) => {
      expect(request).toEqual({
        id: "tool-call-1",
        method: "item/tool/call",
        params: { tool: "minecraft_follow_owner" },
      });
      return { success: true, contentItems: [{ type: "inputText", text: "followed" }] };
    });

    harness.receive({
      id: "tool-call-1",
      method: "item/tool/call",
      params: { tool: "minecraft_follow_owner" },
    });

    await expect(harness.nextSent()).resolves.toEqual({
      id: "tool-call-1",
      result: { success: true, contentItems: [{ type: "inputText", text: "followed" }] },
    });
  });

  it("returns method-not-found when no app-server request handler is registered", async () => {
    const harness = createJsonRpcProcessHarness();

    harness.receive({ id: 91, method: "unknown/request", params: {} });

    await expect(harness.nextSent()).resolves.toEqual({
      id: 91,
      error: { code: -32_601, message: "Method not found" },
    });
  });

  it("sanitizes a failed app-server request handler", async () => {
    const harness = createJsonRpcProcessHarness();
    harness.process.onRequest(async () => {
      throw new Error("private Minecraft coordinates");
    });

    harness.receive({ id: "tool-call-2", method: "item/tool/call", params: {} });

    await expect(harness.nextSent()).resolves.toEqual({
      id: "tool-call-2",
      error: { code: -32_603, message: "Internal error" },
    });
    expect(JSON.stringify(harness.sent())).not.toContain("private Minecraft coordinates");
  });

  it("fatally closes when an app-server response cannot be written", async () => {
    const harness = createJsonRpcProcessHarness();
    harness.process.onRequest(async () => ({ success: true }));
    harness.transport.writeLine = () => {
      throw new Error("response pipe failed");
    };

    harness.receive({ id: "tool-call-3", method: "item/tool/call", params: {} });

    await vi.waitFor(() => expect(harness.closed()).toBe(true));
    await expect(harness.process.request("model/list", {})).rejects.toThrow("stopped");
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

  it("supports a shorter watchdog for a latency-sensitive request", async () => {
    vi.useFakeTimers();
    try {
      const harness = createJsonRpcProcessHarness({ requestTimeoutMs: 1_000 });
      const request = harness.process.request("account/read", {}, { timeoutMs: 25 });
      const outcome = request.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(24);
      expect(harness.closed()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining("account/read"),
      });
      expect(harness.closed()).toBe(true);
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

  it("forces HTTP through a hidden Windows command processor and strips API credentials", () => {
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
        `""C:\\WhiteLily\\node_modules\\.bin\\codex.cmd" ${httpProviderArgs.join(" ")} app-server --listen stdio://"`,
      ],
      env: { PATH: "C:\\Windows" },
      windowsHide: true,
    });
  });

  it("spawns only the trusted bundled executable with a controlled PATH and local Codex home", () => {
    const fixture = createPackagedCodexFixture();
    try {
      const launch = createBundledCodexLaunchConfig(fixture.resources, fixture.dataRoot, "win32", {
        layout: "packaged",
        manifestPath: fixture.manifestPath,
      });
      const spec = createCodexAppServerSpawnSpec("win32", launch, {
        PATH: "C:\\system-node;C:\\system-git;C:\\system-codex",
        Path: "C:\\second-system-path",
        CODEX_HOME: "C:\\Users\\Owner\\.codex",
        OPENAI_API_KEY: "platform-key",
      });

      expect(spec).toMatchObject({
        command: launch.executablePath,
        args: [...httpProviderArgs, "app-server", "--listen", "stdio://"],
        env: {
          CODEX_HOME: launch.codexHome,
          PATH: [
            dirname(launch.executablePath),
            resolve(dirname(launch.executablePath), "..", "codex-path"),
            resolve(dirname(launch.executablePath), "..", "codex-resources"),
          ].join(";"),
        },
        windowsHide: true,
      });
      expect(Object.keys(spec.env)).toEqual(["PATH", "CODEX_HOME"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects an arbitrary absolute Codex launch object that was not manifest-verified", () => {
    expect(() =>
      createCodexAppServerSpawnSpec(
        "win32",
        {
          executablePath: String.raw`C:\unreviewed\codex.exe`,
          codexHome: String.raw`C:\unreviewed\home`,
        },
        {},
      ),
    ).toThrow("not verified");
  });

  it("rejects a missing reviewed native helper and an extra executable", () => {
    const fixture = createPackagedCodexFixture();
    try {
      rmSync(join(fixture.resources, "codex", "native", ...reviewedExecutables[1].split("/")));
      expect(() =>
        createBundledCodexLaunchConfig(fixture.resources, fixture.dataRoot, "win32", {
          layout: "packaged",
          manifestPath: fixture.manifestPath,
        }),
      ).toThrow();

      const repaired = createPackagedCodexFixture();
      try {
        const rogue = join(repaired.resources, "codex", "native", "vendor", "rogue.exe");
        writeFileSync(rogue, "rogue");
        expect(() =>
          createBundledCodexLaunchConfig(repaired.resources, repaired.dataRoot, "win32", {
            layout: "packaged",
            manifestPath: repaired.manifestPath,
          }),
        ).toThrow("allowlist");
      } finally {
        repaired.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a Codex home junction that escapes the WhiteLily data root", () => {
    const fixture = createPackagedCodexFixture();
    try {
      const outside = join(fixture.root, "outside-home");
      mkdirSync(fixture.dataRoot, { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, join(fixture.dataRoot, "codex"), "junction");

      expect(() =>
        createBundledCodexLaunchConfig(fixture.resources, fixture.dataRoot, "win32", {
          layout: "packaged",
          manifestPath: fixture.manifestPath,
        }),
      ).toThrow("escaped");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a native resource junction that escapes its reviewed root", () => {
    const fixture = createPackagedCodexFixture();
    try {
      const native = join(fixture.resources, "codex", "native");
      const vendor = join(native, "vendor");
      const outside = join(fixture.root, "outside-vendor");
      mkdirSync(outside);
      for (const path of reviewedExecutables) {
        const source = join(vendor, ...path.replace("vendor/", "").split("/"));
        const target = join(outside, ...path.replace("vendor/", "").split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(source));
      }
      rmSync(vendor, { recursive: true, force: true });
      symlinkSync(outside, vendor, "junction");

      expect(() =>
        createBundledCodexLaunchConfig(fixture.resources, fixture.dataRoot, "win32", {
          layout: "packaged",
          manifestPath: fixture.manifestPath,
        }),
      ).toThrow("escaped");
    } finally {
      fixture.cleanup();
    }
  });

  it("resolves the exact bundled Windows Codex binary instead of consulting the working directory", () => {
    const cwd = vi
      .spyOn(process, "cwd")
      .mockReturnValue("C:\\Users\\Owner\\AppData\\Local\\WhiteLily\\data");
    try {
      expect(resolveDefaultCodexExecutable("win32", "x64")).toBe(
        resolve(
          import.meta.dirname,
          "..",
          "..",
          "node_modules",
          "@openai",
          "codex-win32-x64",
          "vendor",
          "x86_64-pc-windows-msvc",
          "bin",
          "codex.exe",
        ),
      );
    } finally {
      cwd.mockRestore();
    }
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
