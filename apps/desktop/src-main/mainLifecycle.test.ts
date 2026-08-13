// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  createApplicationBeforeQuitHandler,
  createApplicationQuitRequest,
  createCloseToTrayHandler,
  createNativeTray,
  prepareElectronPrimary,
  runElectronMainWithFailureDisplay,
  runSingleInstanceApplication,
  showExistingWindow,
  startElectronPrimary,
  startElectronComposition,
  waitForRendererReady,
} from "./main.js";
import { resolveAppPaths } from "./appPaths.js";
import {
  WorkspaceProvisionError,
  type WorkspaceProvisionErrorCode,
} from "./codexWorkspaceProvisioner.js";
import type { RuntimeSnapshot } from "../../../src/runtime/runtimeEvents.js";

class FakeWindow {
  readonly listeners = new Map<string, () => void>();
  readonly closeListeners: Array<(event: { preventDefault(): void }) => void> = [];
  destroyed = false;
  focused = false;
  hidden = false;
  minimized = false;
  restored = false;
  shown = false;

  once(event: "closed" | "ready-to-show", listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }

  on(event: "close", listener: (event: { preventDefault(): void }) => void): this {
    if (event === "close") this.closeListeners.push(listener);
    return this;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.listeners.get("closed")?.();
  }

  show(): void {
    this.shown = true;
  }

  hide(): void {
    this.hidden = true;
  }

  focus(): void {
    this.focused = true;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  restore(): void {
    this.restored = true;
    this.minimized = false;
  }
}

function createStartupHarness() {
  let beforeQuit: ((event: { preventDefault(): void }) => void) | undefined;
  const app = {
    on: vi.fn((_event: "before-quit", listener: (event: { preventDefault(): void }) => void) => {
      beforeQuit = listener;
    }),
    quit: vi.fn(),
  };
  const supervisor = {
    start: vi.fn(),
    shutdown: vi.fn<() => Promise<void>>(async () => undefined),
    forceTerminate: vi.fn<() => Promise<void>>(async () => undefined),
  };
  const diagnostic = vi.fn();
  return {
    app,
    beforeQuit: () => beforeQuit,
    diagnostic,
    supervisor,
  };
}

function createPrimaryOwnerHarness(whenReady: () => Promise<void> = async () => undefined) {
  const app = {
    requestSingleInstanceLock: vi.fn(() => true),
    on: vi.fn(),
    whenReady: vi.fn(whenReady),
    quit: vi.fn(),
  };
  return { app };
}

describe("Electron application ownership", () => {
  it("binds both Electron storage paths to the prepared local data root before readiness", async () => {
    const order: string[] = [];
    const dataRoot = String.raw`C:\LocalAppData\owner\WhiteLily`;
    const app = {
      requestSingleInstanceLock: vi.fn(() => {
        order.push("lock");
        return true;
      }),
      on: vi.fn((event: string) => {
        order.push(`on:${event}`);
      }),
      whenReady: vi.fn(async () => {
        order.push("whenReady");
      }),
      quit: vi.fn(() => {
        order.push("quit");
      }),
    };

    await runSingleInstanceApplication({
      app,
      showWindow: vi.fn(),
      preparePrimary: () =>
        prepareElectronPrimary({
          localAppData: String.raw`C:\LocalAppData\owner`,
          resolvePaths: (localAppData) => {
            order.push("resolve");
            return resolveAppPaths(localAppData);
          },
          prepareDirectories: async () => {
            order.push("mkdir");
          },
          setPath: (name, path) => {
            order.push(`setPath:${name}:${path}`);
          },
        }),
      startPrimary: async (prepared) => {
        expect(prepared.paths.dataRoot).toBe(dataRoot);
        order.push("startPrimary");
      },
    });

    expect(order).toEqual([
      "lock",
      "on:second-instance",
      "on:activate",
      "resolve",
      "mkdir",
      `setPath:userData:${dataRoot}`,
      `setPath:sessionData:${dataRoot}`,
      "whenReady",
      "startPrimary",
    ]);
  });

  it("rebinds the same empty local data root after simulated deletion without a roaming fallback", async () => {
    const dataRoot = String.raw`C:\LocalAppData\owner\WhiteLily`;
    let rootExists = false;
    const preparedRoots: string[] = [];
    const boundPaths: Array<[string, string]> = [];
    const prepare = () =>
      prepareElectronPrimary({
        localAppData: String.raw`C:\LocalAppData\owner`,
        resolvePaths: resolveAppPaths,
        prepareDirectories: async (paths) => {
          rootExists = true;
          preparedRoots.push(paths.dataRoot);
        },
        setPath: (name, path) => {
          expect(rootExists).toBe(true);
          boundPaths.push([name, path]);
        },
      });

    await prepare();
    rootExists = false; // Models an uninstall deleting only dataRoot; no real Electron binary is used.
    await prepare();

    expect(preparedRoots).toEqual([dataRoot, dataRoot]);
    expect(boundPaths).toEqual([
      ["userData", dataRoot],
      ["sessionData", dataRoot],
      ["userData", dataRoot],
      ["sessionData", dataRoot],
    ]);
    expect(boundPaths.flat().join("|")).not.toMatch(/Roaming|appData/u);
  });

  it("requests the single-instance lock synchronously before whenReady and primary setup", async () => {
    const order: string[] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const app = {
      requestSingleInstanceLock: vi.fn(() => {
        order.push("lock");
        return true;
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        order.push(`on:${event}`);
        listeners.set(event, listener);
      }),
      whenReady: vi.fn(async () => {
        order.push("whenReady");
      }),
      quit: vi.fn(() => {
        order.push("quit");
      }),
    };
    const startPrimary = vi.fn(async () => {
      order.push("startPrimary");
    });
    const preparePrimary = vi.fn(async () => {
      order.push("preparePrimary");
    });
    const showWindow = vi.fn();

    const started = runSingleInstanceApplication({
      app,
      showWindow,
      preparePrimary,
      startPrimary,
    });
    expect(order[0]).toBe("lock");
    await started;

    expect(order).toEqual([
      "lock",
      "on:second-instance",
      "on:activate",
      "preparePrimary",
      "whenReady",
      "startPrimary",
    ]);
    expect(app.quit).not.toHaveBeenCalled();

    listeners.get("second-instance")?.(
      {},
      ["WhiteLily.exe", "--untrusted"],
      String.raw`C:\untrusted`,
      { arbitrary: true },
    );
    listeners.get("activate")?.({}, true);
    expect(showWindow).toHaveBeenCalledTimes(2);
    expect(showWindow).toHaveBeenNthCalledWith(1);
    expect(showWindow).toHaveBeenNthCalledWith(2);
    expect(startPrimary).toHaveBeenCalledOnce();
  });

  it("quits immediately after a failed lock without readiness, handlers, data, window, or child setup", async () => {
    const app = {
      requestSingleInstanceLock: vi.fn(() => false),
      on: vi.fn(),
      whenReady: vi.fn(async () => undefined),
      quit: vi.fn(),
    };
    const preparePrimary = vi.fn(async () => undefined);
    const startPrimary = vi.fn(async () => undefined);

    await runSingleInstanceApplication({
      app,
      showWindow: vi.fn(),
      preparePrimary,
      startPrimary,
    });

    expect(app.quit).toHaveBeenCalledOnce();
    expect(app.whenReady).not.toHaveBeenCalled();
    expect(app.on).not.toHaveBeenCalled();
    expect(preparePrimary).not.toHaveBeenCalled();
    expect(startPrimary).not.toHaveBeenCalled();
  });

  it("releases the primary exactly once when whenReady rejects", async () => {
    const { app } = createPrimaryOwnerHarness(async () => {
      throw new Error("ready failed");
    });
    const startPrimary = vi.fn(async () => undefined);

    await expect(
      runSingleInstanceApplication({
        app,
        showWindow: vi.fn(),
        preparePrimary: async () => undefined,
        startPrimary,
      }),
    ).rejects.toThrow("ready failed");

    expect(startPrimary).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("releases the primary on missing LOCALAPPDATA before any setup phase", async () => {
    const { app } = createPrimaryOwnerHarness();
    const resolvePaths = vi.fn();
    const prepareDirectories = vi.fn();
    const createSupervisor = vi.fn();
    const startComposition = vi.fn();

    await expect(
      runSingleInstanceApplication({
        app,
        showWindow: vi.fn(),
        preparePrimary: () =>
          prepareElectronPrimary({
            localAppData: undefined,
            resolvePaths,
            prepareDirectories,
            setPath: vi.fn(),
          }),
        startPrimary: (prepared, ownership) =>
          startElectronPrimary(
            {
              prepareSupervisor: async () => undefined,
              createSupervisor,
              startComposition,
            },
            prepared,
            ownership,
          ),
      }),
    ).rejects.toThrow("LOCALAPPDATA is required");

    expect(resolvePaths).not.toHaveBeenCalled();
    expect(prepareDirectories).not.toHaveBeenCalled();
    expect(createSupervisor).not.toHaveBeenCalled();
    expect(startComposition).not.toHaveBeenCalled();
    expect(app.whenReady).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("fails closed when LOCALAPPDATA path validation rejects the input", async () => {
    const { app } = createPrimaryOwnerHarness();
    const setPath = vi.fn();
    const startPrimary = vi.fn();

    await expect(
      runSingleInstanceApplication({
        app,
        showWindow: vi.fn(),
        preparePrimary: () =>
          prepareElectronPrimary({
            localAppData: "relative-local-data",
            resolvePaths: () => {
              throw new Error("absolute LOCALAPPDATA required");
            },
            prepareDirectories: vi.fn(),
            setPath,
          }),
        startPrimary,
      }),
    ).rejects.toThrow("absolute LOCALAPPDATA required");

    expect(setPath).not.toHaveBeenCalled();
    expect(app.whenReady).not.toHaveBeenCalled();
    expect(startPrimary).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("releases the primary on path or directory setup failure", async () => {
    const { app } = createPrimaryOwnerHarness();
    const createSupervisor = vi.fn();
    const startComposition = vi.fn();

    await expect(
      runSingleInstanceApplication({
        app,
        showWindow: vi.fn(),
        preparePrimary: () =>
          prepareElectronPrimary({
            localAppData: String.raw`C:\LocalAppData\owner`,
            resolvePaths: () => ({ dataRoot: String.raw`C:\LocalAppData\owner\WhiteLily` }),
            prepareDirectories: async () => {
              throw new Error("mkdir failed");
            },
            setPath: vi.fn(),
          }),
        startPrimary: (prepared, ownership) =>
          startElectronPrimary(
            {
              prepareSupervisor: async () => undefined,
              createSupervisor,
              startComposition,
            },
            prepared,
            ownership,
          ),
      }),
    ).rejects.toThrow("mkdir failed");

    expect(createSupervisor).not.toHaveBeenCalled();
    expect(startComposition).not.toHaveBeenCalled();
    expect(app.whenReady).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it.each(["userData", "sessionData"] as const)(
    "fails closed when binding Electron %s storage throws",
    async (failingName) => {
      const { app } = createPrimaryOwnerHarness();
      const startPrimary = vi.fn();
      const setPath = vi.fn((name: "userData" | "sessionData") => {
        if (name === failingName) throw new Error(`${name} setPath failed`);
      });

      await expect(
        runSingleInstanceApplication({
          app,
          showWindow: vi.fn(),
          preparePrimary: () =>
            prepareElectronPrimary({
              localAppData: String.raw`C:\LocalAppData\owner`,
              resolvePaths: () => ({
                dataRoot: String.raw`C:\LocalAppData\owner\WhiteLily`,
              }),
              prepareDirectories: async () => undefined,
              setPath,
            }),
          startPrimary,
        }),
      ).rejects.toThrow(`${failingName} setPath failed`);

      expect(app.whenReady).not.toHaveBeenCalled();
      expect(startPrimary).not.toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalledOnce();
    },
  );

  it("releases the primary when supervisor construction throws", async () => {
    const { app } = createPrimaryOwnerHarness();
    const startComposition = vi.fn();

    await expect(
      runSingleInstanceApplication({
        app,
        showWindow: vi.fn(),
        preparePrimary: () =>
          prepareElectronPrimary({
            localAppData: String.raw`C:\LocalAppData\owner`,
            resolvePaths: () => ({ dataRoot: String.raw`C:\LocalAppData\owner\WhiteLily` }),
            prepareDirectories: async () => undefined,
            setPath: vi.fn(),
          }),
        startPrimary: (prepared, ownership) =>
          startElectronPrimary(
            {
              prepareSupervisor: async () => undefined,
              createSupervisor: () => {
                throw new Error("supervisor failed");
              },
              startComposition,
            },
            prepared,
            ownership,
          ),
      }),
    ).rejects.toThrow("supervisor failed");

    expect(startComposition).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("prepares the workspace before constructing and starting the child supervisor", async () => {
    const order: string[] = [];

    await startElectronPrimary(
      {
        prepareSupervisor: async (paths, localAppData) => {
          expect(paths).toEqual({ dataRoot: String.raw`C:\LocalAppData\owner\WhiteLily` });
          expect(localAppData).toBe(String.raw`C:\LocalAppData\owner`);
          order.push("prepare workspace");
        },
        createSupervisor: () => {
          order.push("create supervisor");
          return { id: "supervisor" };
        },
        startComposition: async () => {
          order.push("start composition");
        },
      },
      {
        localAppData: String.raw`C:\LocalAppData\owner`,
        paths: { dataRoot: String.raw`C:\LocalAppData\owner\WhiteLily` },
      },
      { transferToComposition: vi.fn() },
    );

    expect(order).toEqual(["prepare workspace", "create supervisor", "start composition"]);
  });

  it("does not construct or start a child when workspace preparation fails", async () => {
    const createSupervisor = vi.fn();
    const startComposition = vi.fn();

    await expect(
      startElectronPrimary(
        {
          prepareSupervisor: async () => {
            throw new Error("workspace provisioning failed");
          },
          createSupervisor,
          startComposition,
        },
        {
          localAppData: String.raw`C:\LocalAppData\owner`,
          paths: { dataRoot: String.raw`C:\LocalAppData\owner\WhiteLily` },
        },
        { transferToComposition: vi.fn() },
      ),
    ).rejects.toThrow("workspace provisioning failed");
    expect(createSupervisor).not.toHaveBeenCalled();
    expect(startComposition).not.toHaveBeenCalled();
  });

  it.each([
    [
      "WORKSPACE_RESOURCE_INVALID",
      "无法验证 WhiteLily 动作工作区（WORKSPACE_RESOURCE_INVALID）。请重新安装 WhiteLily 后重试。",
    ],
    [
      "WORKSPACE_DEPLOY_FAILED",
      "无法部署 WhiteLily 动作工作区（WORKSPACE_DEPLOY_FAILED）。请关闭 WhiteLily 后重试；如仍失败，请重新安装。",
    ],
    [
      "WORKSPACE_ROLLBACK_FAILED",
      "无法恢复 WhiteLily 动作工作区（WORKSPACE_ROLLBACK_FAILED）。请保留当前用户数据并重新安装 WhiteLily。",
    ],
  ] as const)(
    "shows one stable local error for %s before any supervisor is created",
    async (code, expectedMessage) => {
      const createSupervisor = vi.fn();
      const startComposition = vi.fn();
      const displayError = vi.fn(async () => undefined);
      const setExitCode = vi.fn();

      await runElectronMainWithFailureDisplay({
        run: () =>
          startElectronPrimary(
            {
              prepareSupervisor: async () => {
                throw new WorkspaceProvisionError(code as WorkspaceProvisionErrorCode);
              },
              createSupervisor,
              startComposition,
            },
            {
              localAppData: String.raw`C:\LocalAppData\owner`,
              paths: { dataRoot: String.raw`C:\LocalAppData\owner\WhiteLily` },
            },
            { transferToComposition: vi.fn() },
          ),
        displayError,
        setExitCode,
      });

      expect(createSupervisor).not.toHaveBeenCalled();
      expect(startComposition).not.toHaveBeenCalled();
      expect(displayError).toHaveBeenCalledOnce();
      expect(displayError).toHaveBeenCalledWith("WhiteLily 启动失败", expectedMessage);
      expect(setExitCode).toHaveBeenCalledOnce();
      expect(setExitCode).toHaveBeenCalledWith(1);
    },
  );

  it("redacts an unexpected startup failure before displaying it locally", async () => {
    const displayError = vi.fn(async () => undefined);
    const setExitCode = vi.fn();

    await runElectronMainWithFailureDisplay({
      run: async () => {
        throw new Error(String.raw`failed at C:\private\owner\workspace`);
      },
      displayError,
      setExitCode,
    });

    expect(displayError).toHaveBeenCalledOnce();
    expect(displayError).toHaveBeenCalledWith(
      "WhiteLily 启动失败",
      "WhiteLily 无法启动（STARTUP_FAILED）。请重新启动；如仍失败，请重新安装。",
    );
    expect(JSON.stringify(displayError.mock.calls)).not.toContain("private");
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it("does not double quit after composition takes startup ownership", async () => {
    const { app } = createPrimaryOwnerHarness();

    await expect(
      runSingleInstanceApplication({
        app,
        showWindow: vi.fn(),
        preparePrimary: () =>
          prepareElectronPrimary({
            localAppData: String.raw`C:\LocalAppData\owner`,
            resolvePaths: () => ({ dataRoot: String.raw`C:\LocalAppData\owner\WhiteLily` }),
            prepareDirectories: async () => undefined,
            setPath: vi.fn(),
          }),
        startPrimary: (prepared, ownership) =>
          startElectronPrimary(
            {
              prepareSupervisor: async () => undefined,
              createSupervisor: () => ({ id: "supervisor" }),
              startComposition: async (_supervisor, transferOwnership) => {
                transferOwnership();
                transferOwnership();
                app.quit();
                throw new Error("composition-owned failure");
              },
            },
            prepared,
            ownership,
          ),
      }),
    ).rejects.toThrow("composition-owned failure");

    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("contains restore failures from second-instance and activate callbacks", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const app = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      whenReady: vi.fn(async () => undefined),
      quit: vi.fn(),
    };
    await runSingleInstanceApplication({
      app,
      showWindow: () => {
        throw new Error("window unavailable");
      },
      preparePrimary: async () => undefined,
      startPrimary: async () => undefined,
    });

    expect(() => listeners.get("second-instance")?.({}, [], "", {})).not.toThrow();
    expect(() => listeners.get("activate")?.()).not.toThrow();
  });

  it("restores, shows, and focuses only an existing window", () => {
    const existing = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    showExistingWindow(existing);
    expect(existing.restore).toHaveBeenCalledOnce();
    expect(existing.show).toHaveBeenCalledOnce();
    expect(existing.focus).toHaveBeenCalledOnce();

    const destroyed = {
      isDestroyed: vi.fn(() => true),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    showExistingWindow(destroyed);
    expect(destroyed.restore).not.toHaveBeenCalled();
    expect(destroyed.show).not.toHaveBeenCalled();
    expect(destroyed.focus).not.toHaveBeenCalled();
  });

  it("hides ordinary closes to tray but bypasses hiding during application quit", () => {
    const window = { hide: vi.fn() };
    let isQuitting = false;
    const handler = createCloseToTrayHandler({
      isQuitting: () => isQuitting,
      window,
    });
    const ordinaryClose = { preventDefault: vi.fn() };
    handler(ordinaryClose);
    expect(ordinaryClose.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();

    isQuitting = true;
    const quittingClose = { preventDefault: vi.fn() };
    handler(quittingClose);
    expect(quittingClose.preventDefault).not.toHaveBeenCalled();
    expect(window.hide).toHaveBeenCalledOnce();
  });

  it("prevents only the initial before-quit event and allows lifecycle recursion", () => {
    let isQuitting = false;
    const lifecycle = {
      get isQuitting() {
        return isQuitting;
      },
      quit: vi.fn(() => {
        isQuitting = true;
        return Promise.resolve();
      }),
    };
    const handler = createApplicationBeforeQuitHandler(lifecycle);
    const initial = { preventDefault: vi.fn() };
    handler(initial);
    expect(initial.preventDefault).toHaveBeenCalledOnce();
    expect(lifecycle.quit).toHaveBeenCalledOnce();

    const recursive = { preventDefault: vi.fn() };
    handler(recursive);
    expect(recursive.preventDefault).not.toHaveBeenCalled();
    expect(lifecycle.quit).toHaveBeenCalledOnce();
  });
});

describe("native tray composition", () => {
  it("keeps a neutral label after renderer state changes while clicking uses fresh status", async () => {
    let snapshot: RuntimeSnapshot = {
      revision: 0,
      lifecycle: "stopped",
      minecraft: { state: "disconnected", sessionId: null },
      codex: { state: "stopped", model: null },
      actions: null,
      task: null,
      lastError: null,
    };
    const request = vi.fn(async (command: { kind: string }) => {
      if (command.kind === "start_runtime") {
        snapshot = {
          ...snapshot,
          lifecycle: "running",
          minecraft: { state: "connected", sessionId: "session_7F2A" },
          actions: {
            state: "ready",
            workspaceVersion: "workspace-1",
            mcpListening: true,
            discoveredToolCount: 15,
          },
        };
      } else if (command.kind === "stop_runtime") {
        snapshot = {
          ...snapshot,
          lifecycle: "stopped",
          minecraft: { state: "disconnected", sessionId: null },
          actions: null,
        };
      }
      return snapshot;
    });
    type NativeItem = {
      id?: string;
      label?: string;
      enabled?: boolean;
      click?: () => void;
    };
    let currentMenu: NativeItem[] = [];
    const tray = {
      setContextMenu: vi.fn((menu: unknown) => {
        currentMenu = menu as NativeItem[];
      }),
      setToolTip: vi.fn(),
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      destroy: vi.fn(),
    };
    createNativeTray({
      createTray: () => tray,
      buildMenu: (template) => template,
      nativeImage: {
        createFromBitmap: () => ({}) as never,
      },
      supervisor: {
        request,
        emergencyStop: async () => snapshot,
      },
      lifecycle: {
        quit: async () => undefined,
      } as never,
      showWindow: vi.fn(),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(currentMenu.find((item) => item.id === "connect_or_disconnect")?.label).toBe(
      "连接或断开",
    );

    await request({ kind: "start_runtime" });
    const connectOrDisconnect = currentMenu.find((item) => item.id === "connect_or_disconnect");
    expect(connectOrDisconnect?.label).toBe("连接或断开");
    connectOrDisconnect?.click?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(request.mock.calls.map(([command]) => command.kind)).toEqual([
      "start_runtime",
      "get_status",
      "stop_runtime",
    ]);
  });
});

describe("Electron startup composition", () => {
  it("creates the production quit request from only the existing lifecycle", async () => {
    const quit = vi.fn<() => Promise<void>>(async () => undefined);
    const appQuit = vi.fn();
    const processKill = vi.fn();
    const forceTerminate = vi.fn();
    const lifecycle = { quit, appQuit, processKill, forceTerminate };

    const requestApplicationQuit = createApplicationQuitRequest(lifecycle);
    await Promise.all([requestApplicationQuit(), requestApplicationQuit()]);

    expect(quit).toHaveBeenCalledTimes(2);
    expect(appQuit).not.toHaveBeenCalled();
    expect(processKill).not.toHaveBeenCalled();
    expect(forceTerminate).not.toHaveBeenCalled();
  });

  it("gives IPC registration the same lifecycle used by startup and tray", async () => {
    const { app, diagnostic, supervisor } = createStartupHarness();
    const mainWindow = new FakeWindow();
    let requestApplicationQuit: (() => Promise<void>) | undefined;
    let trayLifecycle: { quit(): Promise<void> } | undefined;

    await startElectronComposition({
      app,
      supervisor,
      createWindow: () => mainWindow,
      configureWindow: vi.fn(),
      registerIpc: (_window, lifecycle) => {
        requestApplicationQuit = () => lifecycle.quit();
        return () => undefined;
      },
      createTray: (_window, lifecycle) => {
        trayLifecycle = lifecycle;
        return { destroy: vi.fn() };
      },
      loadWindow: async () => undefined,
      diagnostic,
    });

    expect(requestApplicationQuit).toBeTypeOf("function");
    expect(trayLifecycle).toBeDefined();
    const first = requestApplicationQuit!();
    const second = trayLifecycle!.quit();
    await Promise.all([first, second]);

    expect(supervisor.shutdown).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("keeps the main window hidden until the verified renderer load completes", async () => {
    const { app, diagnostic, supervisor } = createStartupHarness();
    const mainWindow = new FakeWindow();
    const createTray = vi.fn(() => ({ destroy: vi.fn() }));
    const onRendererReady = vi.fn();
    let finishLoad = (): void => undefined;
    const load = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });

    const startup = startElectronComposition({
      app,
      supervisor,
      createWindow: () => mainWindow,
      configureWindow: vi.fn(),
      registerIpc: () => () => undefined,
      createTray,
      loadWindow: () => load,
      diagnostic,
      onRendererReady,
    });
    await Promise.resolve();

    expect(mainWindow.shown).toBe(false);
    expect(createTray).not.toHaveBeenCalled();
    expect(onRendererReady).not.toHaveBeenCalled();
    finishLoad();
    await startup;
    expect(onRendererReady).toHaveBeenCalledWith(mainWindow);
    expect(createTray).toHaveBeenCalledOnce();
    expect(mainWindow.shown).toBe(true);
  });

  it("fails closed when the renderer never mounts visible application content", async () => {
    const probe = vi.fn(async () => false);
    const wait = vi.fn(async () => undefined);

    await expect(
      waitForRendererReady({
        attempts: 3,
        probe,
        wait,
      }),
    ).rejects.toThrow("WhiteLily renderer did not mount");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("applies the renderer deadline even when a probe never settles", async () => {
    await expect(
      waitForRendererReady({
        deadline: Promise.resolve(),
        probe: () => new Promise<never>(() => undefined),
      }),
    ).rejects.toThrow("WhiteLily renderer did not mount");
  }, 1_000);

  it("does not probe again when the renderer deadline wins during a polling wait", async () => {
    let expire = (): void => undefined;
    const deadline = new Promise<void>((resolve) => {
      expire = resolve;
    });
    let releaseWait = (): void => undefined;
    const wait = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseWait = resolve;
        }),
    );
    const probe = vi.fn(async () => false);
    const readiness = waitForRendererReady({
      attempts: 3,
      deadline,
      probe,
      wait,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();

    expire();
    await expect(readiness).rejects.toThrow("WhiteLily renderer did not mount");
    releaseWait();
    await Promise.resolve();
    await Promise.resolve();

    expect(probe).toHaveBeenCalledOnce();
  });

  it("accepts the renderer when application content mounts during the bounded wait", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const wait = vi.fn(async () => undefined);

    await waitForRendererReady({
      attempts: 3,
      probe,
      wait,
    });

    expect(probe).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it("installs the quit guard before a BrowserWindow construction failure", async () => {
    const { app, beforeQuit, diagnostic, supervisor } = createStartupHarness();

    const startup = startElectronComposition({
      app,
      supervisor,
      createWindow: () => {
        expect(beforeQuit()).toBeTypeOf("function");
        throw new Error(String.raw`could not load C:\private\renderer.html`);
      },
      configureWindow: () => undefined,
      registerIpc: () => () => undefined,
      createTray: () => ({ destroy: vi.fn() }),
      loadWindow: async () => undefined,
      diagnostic,
    });

    await expect(startup).rejects.toThrow("WhiteLily Electron startup failed");
    expect(supervisor.start).toHaveBeenCalledOnce();
    expect(supervisor.shutdown).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith("WhiteLily Electron startup failed");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private");
  });

  it("cleans IPC and destroys the hidden window when renderer loading fails", async () => {
    const { app, diagnostic, supervisor } = createStartupHarness();
    const mainWindow = new FakeWindow();
    const cleanupIpc = vi.fn();

    const startup = startElectronComposition({
      app,
      supervisor,
      createWindow: () => mainWindow,
      configureWindow: vi.fn(),
      registerIpc: () => cleanupIpc,
      createTray: () => ({ destroy: vi.fn() }),
      loadWindow: async () => {
        throw new Error("renderer load failed");
      },
      diagnostic,
    });

    await expect(startup).rejects.toThrow("WhiteLily Electron startup failed");
    expect(cleanupIpc).toHaveBeenCalledOnce();
    expect(mainWindow.destroyed).toBe(true);
    expect(supervisor.shutdown).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("destroys the window and shuts down when IPC registration fails", async () => {
    const { app, diagnostic, supervisor } = createStartupHarness();
    const mainWindow = new FakeWindow();

    const startup = startElectronComposition({
      app,
      supervisor,
      createWindow: () => mainWindow,
      configureWindow: vi.fn(),
      registerIpc: () => {
        throw new Error("IPC registration failed");
      },
      createTray: () => ({ destroy: vi.fn() }),
      loadWindow: async () => undefined,
      diagnostic,
    });

    await expect(startup).rejects.toThrow("WhiteLily Electron startup failed");
    expect(mainWindow.destroyed).toBe(true);
    expect(supervisor.shutdown).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it("coalesces a before-quit and startup-failure race into one cleanup", async () => {
    const { app, beforeQuit, diagnostic, supervisor } = createStartupHarness();
    const mainWindow = new FakeWindow();
    const cleanupIpc = vi.fn();
    let rejectLoad = (_error: Error): void => undefined;
    const load = new Promise<void>((_resolve, reject) => {
      rejectLoad = reject;
    });
    let resolveShutdown = (): void => undefined;
    supervisor.shutdown.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
    );

    const startup = startElectronComposition({
      app,
      supervisor,
      createWindow: () => mainWindow,
      configureWindow: vi.fn(),
      registerIpc: () => cleanupIpc,
      createTray: () => ({ destroy: vi.fn() }),
      loadWindow: () => load,
      diagnostic,
    });
    await Promise.resolve();
    const quitEvent = { preventDefault: vi.fn() };
    beforeQuit()!(quitEvent);
    rejectLoad(new Error("load raced with quit"));
    await Promise.resolve();

    expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
    expect(cleanupIpc).not.toHaveBeenCalled();
    expect(mainWindow.destroyed).toBe(false);
    expect(supervisor.shutdown).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();

    resolveShutdown();
    await expect(startup).rejects.toThrow("WhiteLily Electron startup failed");
    expect(app.quit).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(cleanupIpc).toHaveBeenCalledOnce();
    expect(mainWindow.destroyed).toBe(true);
  });

  it("owns close-to-tray, tray cleanup, and bounded before-quit through one lifecycle", async () => {
    const { app, beforeQuit, diagnostic, supervisor } = createStartupHarness();
    const mainWindow = new FakeWindow();
    const cleanupIpc = vi.fn();
    const destroyTray = vi.fn();
    let lifecycleRef:
      | {
          readonly isQuitting: boolean;
          quit(): Promise<void>;
        }
      | undefined;

    await startElectronComposition({
      app,
      supervisor,
      createWindow: () => mainWindow,
      configureWindow: vi.fn(),
      registerIpc: () => cleanupIpc,
      createTray: (_window, lifecycle) => {
        expect(lifecycle.isQuitting).toBe(false);
        lifecycleRef = lifecycle;
        return { destroy: destroyTray };
      },
      loadWindow: async () => undefined,
      diagnostic,
    });

    const closeEvent = { preventDefault: vi.fn() };
    mainWindow.closeListeners[0]?.(closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(mainWindow.hidden).toBe(true);
    expect(mainWindow.destroyed).toBe(false);

    const quitEvent = { preventDefault: vi.fn() };
    beforeQuit()!(quitEvent);
    expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
    await lifecycleRef!.quit();

    expect(destroyTray).toHaveBeenCalledOnce();
    expect(cleanupIpc).toHaveBeenCalledOnce();
    expect(mainWindow.destroyed).toBe(true);
    expect(supervisor.shutdown).toHaveBeenCalledOnce();
    expect(supervisor.forceTerminate).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledOnce();

    mainWindow.listeners.get("closed")?.();
    expect(destroyTray).toHaveBeenCalledOnce();
    expect(cleanupIpc).toHaveBeenCalledOnce();
  });
});
