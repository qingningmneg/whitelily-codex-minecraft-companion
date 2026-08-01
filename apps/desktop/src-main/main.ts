import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BrowserWindowConstructorOptions,
  MenuItemConstructorOptions,
  NativeImage,
} from "electron";
import { ApplicationLifecycle } from "./applicationLifecycle.js";
import { resolveAppPaths } from "./appPaths.js";
import { ChildSupervisor } from "./childSupervisor.js";
import { Pcl2Discovery } from "./discovery/pcl2Discovery.js";
import { WorldBindingAuthority } from "./discovery/worldBindingAuthority.js";
import { LanDetector } from "./discovery/lanDetector.js";
import { createExternalUrlHandlers, ExternalUrlPolicy } from "./externalUrlPolicy.js";
import { registerIpcHandlers } from "./ipcRegistry.js";
import { exportSerializedJson } from "./safeExportDestination.js";
import { saveDiagnosticArchive } from "./diagnosticExport.js";
import { createStartupSettings } from "./startupSettings.js";
import { DesktopPreferences } from "./desktopPreferences.js";
import {
  createSupervisorTrayRuntime,
  createTrayController,
  type TrayAction,
  type TrayController,
  type TraySupervisorPort,
} from "./tray.js";
import { WHITE_LILY_IPC_CHANNELS } from "../src/desktopApi.js";

export function createMainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1_180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}

export interface DesktopCodexResources {
  resourceRoot: string;
  manifestPath: string;
  layout: "development" | "packaged";
}

export function resolveDesktopCodexResources(options: {
  appPath: string;
  resourcesPath: string;
  development: boolean;
}): DesktopCodexResources {
  const repositoryRoot = resolve(options.appPath, "..", "..");
  return options.development
    ? {
        resourceRoot: resolve(repositoryRoot, "node_modules", "@openai", "codex-win32-x64"),
        manifestPath: resolve(repositoryRoot, "packaging", "electron", "runtime-manifest.json"),
        layout: "development",
      }
    : {
        resourceRoot: resolve(options.resourcesPath),
        manifestPath: resolve(options.resourcesPath, "runtime-manifest.json"),
        layout: "packaged",
      };
}

export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface ExistingWindowPort {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export function showExistingWindow(window: ExistingWindowPort | undefined): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export interface CloseToTrayEvent {
  preventDefault(): void;
}

export function createCloseToTrayHandler(options: {
  isQuitting(): boolean;
  closeToTray?: () => boolean;
  window: { hide(): void };
}): (event: CloseToTrayEvent) => void {
  return (event) => {
    if (options.isQuitting() || options.closeToTray?.() === false) return;
    event.preventDefault();
    options.window.hide();
  };
}

export function createApplicationBeforeQuitHandler(
  lifecycle: Pick<ApplicationLifecycle, "isQuitting" | "quit">,
): (event: BeforeQuitEvent) => void {
  return (event) => {
    if (lifecycle.isQuitting) return;
    event.preventDefault();
    void lifecycle.quit().catch(() => undefined);
  };
}

export interface SingleInstanceAppPort {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance" | "activate", listener: (...args: unknown[]) => void): unknown;
  whenReady(): Promise<void>;
  quit(): void;
}

export interface SingleInstanceApplicationOptions<TPrepared> {
  app: SingleInstanceAppPort;
  showWindow(): void;
  preparePrimary(): Promise<TPrepared>;
  startPrimary(prepared: TPrepared, ownership: PrimaryStartupOwnership): Promise<void>;
}

export interface PrimaryStartupOwnership {
  transferToComposition(): void;
}

export function runSingleInstanceApplication<TPrepared>(
  options: SingleInstanceApplicationOptions<TPrepared>,
): Promise<void> {
  let quitRequested = false;
  const requestQuitOnce = (): void => {
    if (quitRequested) return;
    quitRequested = true;
    try {
      options.app.quit();
    } catch {
      // This primary has no safe setup work to continue.
    }
  };
  let hasLock = false;
  try {
    hasLock = options.app.requestSingleInstanceLock();
  } catch {
    hasLock = false;
  }
  if (!hasLock) {
    requestQuitOnce();
    return Promise.resolve();
  }

  const showWindow = (): void => {
    try {
      options.showWindow();
    } catch {
      // A second launch or activation cannot destabilize the primary instance.
    }
  };
  try {
    options.app.on("second-instance", showWindow);
    options.app.on("activate", showWindow);
  } catch {
    requestQuitOnce();
    return Promise.resolve();
  }

  let outerOwnsStartup = true;
  const ownership: PrimaryStartupOwnership = {
    transferToComposition: () => {
      outerOwnsStartup = false;
    },
  };
  return (async () => {
    try {
      const prepared = await options.preparePrimary();
      await options.app.whenReady();
      await options.startPrimary(prepared, ownership);
    } catch (error) {
      if (outerOwnsStartup) requestQuitOnce();
      throw error;
    }
  })();
}

export interface ElectronPrimaryPreparationOptions<TPaths extends { dataRoot: string }> {
  localAppData: string | undefined;
  resolvePaths(localAppData: string): TPaths;
  prepareDirectories(paths: TPaths): Promise<void>;
  setPath(name: "userData" | "sessionData", path: string): void;
}

export interface PreparedElectronPrimary<TPaths> {
  localAppData: string;
  paths: TPaths;
}

export interface ElectronPrimaryOptions<TPaths, TSupervisor> {
  createSupervisor(paths: TPaths, localAppData: string): TSupervisor;
  startComposition(supervisor: TSupervisor, transferOwnership: () => void): Promise<void>;
}

export async function prepareElectronPrimary<TPaths extends { dataRoot: string }>(
  options: ElectronPrimaryPreparationOptions<TPaths>,
): Promise<PreparedElectronPrimary<TPaths>> {
  if (!options.localAppData) throw new Error("LOCALAPPDATA is required");
  const paths = options.resolvePaths(options.localAppData);
  await options.prepareDirectories(paths);
  options.setPath("userData", paths.dataRoot);
  options.setPath("sessionData", paths.dataRoot);
  return { localAppData: options.localAppData, paths };
}

export async function startElectronPrimary<TPaths, TSupervisor>(
  options: ElectronPrimaryOptions<TPaths, TSupervisor>,
  prepared: PreparedElectronPrimary<TPaths>,
  ownership: PrimaryStartupOwnership,
): Promise<void> {
  const { localAppData, paths } = prepared;
  const supervisor = options.createSupervisor(paths, localAppData);
  await options.startComposition(supervisor, ownership.transferToComposition);
}

export interface StartupAppPort {
  on(event: "before-quit", listener: (event: BeforeQuitEvent) => void): unknown;
  quit(): void;
}

export interface StartupSupervisorPort {
  start(): void;
  shutdown(): Promise<void>;
  forceTerminate(): Promise<void>;
}

export interface StartupWindowPort extends ExistingWindowPort {
  on(event: "close", listener: (event: CloseToTrayEvent) => void): unknown;
  once(event: "closed" | "ready-to-show", listener: () => void): unknown;
  destroy(): void;
  hide(): void;
}

export interface StartupTrayPort {
  destroy(): void;
}

export interface ElectronStartupOptions<TWindow extends StartupWindowPort> {
  app: StartupAppPort;
  supervisor: StartupSupervisorPort;
  createWindow(): TWindow;
  configureWindow(window: TWindow): void;
  registerIpc(window: TWindow): () => void;
  createTray(window: TWindow, lifecycle: ApplicationLifecycle): StartupTrayPort;
  loadWindow(window: TWindow): Promise<void>;
  diagnostic(message: string): void;
  closeToTray?: () => boolean;
  onLifecycleOwned?(): void;
}

const STARTUP_FAILURE_MESSAGE = "WhiteLily Electron startup failed";

export async function startElectronComposition<TWindow extends StartupWindowPort>(
  options: ElectronStartupOptions<TWindow>,
): Promise<void> {
  let mainWindow: TWindow | undefined;
  let tray: StartupTrayPort | undefined;
  let cleanupIpc = (): void => undefined;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      tray?.destroy();
    } finally {
      try {
        cleanupIpc();
      } finally {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      }
    }
  };
  const lifecycle = new ApplicationLifecycle({
    app: options.app,
    supervisor: options.supervisor,
    cleanup,
  });
  let lifecycleOwnsStartup = options.onLifecycleOwned === undefined;

  try {
    options.app.on("before-quit", createApplicationBeforeQuitHandler(lifecycle));
    options.onLifecycleOwned?.();
    lifecycleOwnsStartup = true;
    options.supervisor.start();
    mainWindow = options.createWindow();
    options.configureWindow(mainWindow);
    cleanupIpc = options.registerIpc(mainWindow);
    tray = options.createTray(mainWindow, lifecycle);
    mainWindow.on(
      "close",
      createCloseToTrayHandler({
        isQuitting: () => lifecycle.isQuitting,
        closeToTray: options.closeToTray,
        window: mainWindow,
      }),
    );
    mainWindow.once("closed", cleanup);
    await options.loadWindow(mainWindow);
    mainWindow.once("ready-to-show", () => mainWindow?.show());
  } catch {
    try {
      options.diagnostic(STARTUP_FAILURE_MESSAGE);
    } catch {
      // Diagnostics cannot skip deterministic startup teardown.
    }
    if (lifecycleOwnsStartup) await lifecycle.quit();
    throw new Error(STARTUP_FAILURE_MESSAGE);
  }
}

export async function runElectronMain(): Promise<void> {
  const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } =
    await import("electron");
  let mainWindow: InstanceType<typeof BrowserWindow> | undefined;
  await runSingleInstanceApplication({
    app,
    showWindow: () => showExistingWindow(mainWindow),
    preparePrimary: () =>
      prepareElectronPrimary({
        localAppData: process.env.LOCALAPPDATA,
        resolvePaths: (localAppData) => resolveAppPaths(localAppData),
        prepareDirectories: async (paths) => {
          await Promise.all([
            mkdir(paths.dataRoot, { recursive: true }),
            mkdir(dirname(paths.configPath), { recursive: true }),
            mkdir(paths.logRoot, { recursive: true }),
          ]);
        },
        setPath: (name, path) => app.setPath(name, path),
      }),
    startPrimary: (prepared, ownership) =>
      startElectronPrimary(
        {
          createSupervisor: (paths, localAppData) => {
            const appPath = app.getAppPath();
            const development = !app.isPackaged;
            const childEntry = development
              ? resolve(appPath, "..", "..", "dist", "src", "desktop", "childMain.js")
              : resolve(process.resourcesPath, "core", "childMain.js");
            const codexResources = resolveDesktopCodexResources({
              appPath,
              resourcesPath: process.resourcesPath,
              development,
            });
            const supervisor = new ChildSupervisor({
              childEntry,
              configPath: paths.configPath,
              workingDirectory: paths.dataRoot,
              environment: {
                ...process.env,
                LOCALAPPDATA: localAppData,
                WHITELILY_DATA_ROOT: paths.dataRoot,
                WHITELILY_CODEX_RESOURCE_ROOT: codexResources.resourceRoot,
                WHITELILY_CODEX_MANIFEST: codexResources.manifestPath,
                WHITELILY_CODEX_LAYOUT: codexResources.layout,
              },
              development,
            });
            return {
              appPath,
              development,
              preloadPath: fileURLToPath(new URL("../preload/preload.cjs", import.meta.url)),
              supervisor,
            };
          },
          startComposition: async (primary, transferOwnership) => {
            const externalUrlPolicy = new ExternalUrlPolicy();
            const pcl2Discovery = new Pcl2Discovery();
            const lanDetector = new LanDetector();
            const worldAuthority = new WorldBindingAuthority({
              configPath: prepared.paths.configPath,
              lanDetector,
            });
            const startupSettings = createStartupSettings({
              isPackaged: app.isPackaged,
              executablePath: process.execPath,
              getLoginItemSettings: (options) => app.getLoginItemSettings(options),
              setLoginItemSettings: (options) => app.setLoginItemSettings(options),
            });
            const desktopPreferences = new DesktopPreferences({
              rootDirectory: prepared.paths.dataRoot,
            });
            let closeToTray = await desktopPreferences.read();
            const closeToTraySettings = {
              read: async () => ({
                revision: closeToTray.revision,
                enabled: closeToTray.value.closeToTray,
              }),
              set: async (expectedRevision: number, enabled: boolean) => {
                closeToTray = await desktopPreferences.setCloseToTray(expectedRevision, enabled);
                return { revision: closeToTray.revision, enabled: closeToTray.value.closeToTray };
              },
            };
            await startElectronComposition({
              app,
              supervisor: primary.supervisor,
              createWindow: () => {
                mainWindow = new BrowserWindow(createMainWindowOptions(primary.preloadPath));
                return mainWindow;
              },
              configureWindow: (window) => {
                const externalUrlHandlers = createExternalUrlHandlers(externalUrlPolicy, (url) =>
                  shell.openExternal(url),
                );
                window.webContents.setWindowOpenHandler(externalUrlHandlers.openWindow);
                window.webContents.on("will-navigate", externalUrlHandlers.navigate);
              },
              registerIpc: (window) =>
                registerIpcHandlers({
                  ipcMain,
                  supervisor: primary.supervisor,
                  publishRuntime: (event) => {
                    if (!window.isDestroyed()) {
                      window.webContents.send(WHITE_LILY_IPC_CHANNELS.runtimeEvent, event);
                    }
                  },
                  publishOwnerIdentity: (owner) => {
                    if (!window.isDestroyed()) {
                      window.webContents.send(WHITE_LILY_IPC_CHANNELS.ownerIdentityEvent, owner);
                    }
                  },
                  externalUrlPolicy,
                  openExternal: (url) => shell.openExternal(url),
                  pcl2Discovery,
                  lanDetector,
                  worldAuthority,
                  startupSettings,
                  closeToTraySettings,
                  exportSerialized: (serialized) =>
                    exportSerializedJson({
                      chooseDestination: () =>
                        dialog.showSaveDialog(window, {
                          title: "Export WhiteLily memories",
                          defaultPath: "whitelily-memories.json",
                          filters: [{ name: "JSON", extensions: ["json"] }],
                          properties: ["createDirectory"],
                        }),
                      serialized,
                    }),
                  exportDiagnostic: (exportId, prepareArchive) =>
                    saveDiagnosticArchive({
                      dataRoot: prepared.paths.dataRoot,
                      exportId,
                      chooseDestination: () =>
                        dialog.showSaveDialog(window, {
                          title: "Export WhiteLily diagnostics",
                          defaultPath: "whitelily-diagnostics.zip",
                          filters: [{ name: "ZIP", extensions: ["zip"] }],
                          properties: ["createDirectory"],
                        }),
                      prepareArchive,
                    }),
                }),
              createTray: (window, lifecycle) =>
                createNativeTray({
                  buildMenu: (template) => Menu.buildFromTemplate(template),
                  createTray: (icon) => new Tray(icon),
                  lifecycle,
                  nativeImage,
                  showWindow: () => showExistingWindow(window),
                  supervisor: primary.supervisor,
                }),
              loadWindow: (window) => {
                if (primary.development) {
                  return window.loadURL("http://127.0.0.1:5173");
                }
                return window.loadFile(resolve(primary.appPath, "dist-renderer", "index.html"));
              },
              diagnostic: (message) => console.error(message),
              closeToTray: () => closeToTray.value.closeToTray,
              onLifecycleOwned: transferOwnership,
            });
          },
        },
        prepared,
        ownership,
      ),
  });
}

interface NativeTrayPort {
  setContextMenu(menu: unknown): void;
  setToolTip(toolTip: string): void;
  on(event: "click", listener: () => void): unknown;
  isDestroyed(): boolean;
  destroy(): void;
}

export function createNativeTray(options: {
  createTray(icon: NativeImage): NativeTrayPort;
  buildMenu(template: MenuItemConstructorOptions[]): unknown;
  nativeImage: {
    createFromBitmap(
      buffer: Buffer,
      options: { width: number; height: number; scaleFactor: number },
    ): NativeImage;
  };
  supervisor: TraySupervisorPort;
  lifecycle: ApplicationLifecycle;
  showWindow(): void;
}): TrayController {
  const tray = options.createTray(createFallbackTrayIcon(options.nativeImage));
  let controller: TrayController;
  const rebuildMenu = (actions: readonly TrayAction[]): void => {
    tray.setContextMenu(
      options.buildMenu(
        actions.map((action) => ({
          id: action.id,
          label: action.label,
          enabled: action.enabled,
          click: () => {
            void action.invoke();
          },
        })),
      ),
    );
  };
  controller = createTrayController({
    runtime: createSupervisorTrayRuntime(options.supervisor),
    showWindow: options.showWindow,
    quit: () => options.lifecycle.quit(),
    // Plan 03 must inject a real persisted proactive-message callback before enabling this item.
    onActionsChanged: rebuildMenu,
    destroyTray: () => {
      if (!tray.isDestroyed()) tray.destroy();
    },
    onError: () => console.error("WhiteLily tray action failed"),
  });
  tray.setToolTip("WhiteLily");
  tray.on("click", () => {
    const open = controller.actions.find((action) => action.id === "open");
    if (open) void open.invoke();
  });
  return controller;
}

function createFallbackTrayIcon(nativeImage: {
  createFromBitmap(
    buffer: Buffer,
    options: { width: number; height: number; scaleFactor: number },
  ): NativeImage;
}): NativeImage {
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const petal = (x >= 6 && x <= 9) || (y >= 6 && y <= 9);
      bitmap[offset] = petal ? 0xf0 : 0x72;
      bitmap[offset + 1] = petal ? 0xf7 : 0x45;
      bitmap[offset + 2] = petal ? 0xff : 0x6c;
      bitmap[offset + 3] = 0xff;
    }
  }
  // Packaging can replace this generated fallback with the final signed asset later.
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size, scaleFactor: 1 });
}

if (process.versions.electron) {
  void runElectronMain().catch(() => {
    process.exitCode = 1;
  });
}
