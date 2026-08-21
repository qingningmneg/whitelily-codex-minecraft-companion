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
import { MinecraftComponentPreferences } from "./minecraftComponentPreferences.js";
import {
  createMinecraftComponentManager,
  type MinecraftComponentResourceManifest,
} from "./minecraftComponents.js";
import {
  createWorkspaceVersionEnvironment,
  provisionCodexWorkspace,
  resolveDesktopCodexWorkspaceResources,
  WorkspaceProvisionError,
  type WorkspaceProvisionResult,
} from "./codexWorkspaceProvisioner.js";
import {
  createSupervisorTrayRuntime,
  createTrayController,
  type TrayAction,
  type TrayController,
  type TraySupervisorPort,
} from "./tray.js";
import { WHITE_LILY_IPC_CHANNELS } from "../src/desktopApi.js";
import { createAvatarModelComposition } from "./avatar/avatarModelComposition.js";

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

export interface DesktopMinecraftComponentResources {
  readonly resourceDirectory: string;
  readonly presenceDirectory: string;
  readonly manifest: MinecraftComponentResourceManifest;
}

const DESKTOP_MINECRAFT_COMPONENT_MANIFEST: MinecraftComponentResourceManifest = Object.freeze({
  schemaVersion: 1,
  minecraftVersion: "1.21.5",
  artifacts: Object.freeze([
    Object.freeze({
      component: "bridge" as const,
      fileName: "whitelily-bridge-fabric-1.21.5-0.1.2.jar",
      bytes: 53_984,
      sha256: "ac5bfab545b723b2346aeb017b3a6ea3186a6cbced370e16097f3836b128746d",
      modId: "whitelily_bridge",
      version: "0.1.2",
      prior: Object.freeze([
        Object.freeze({
          fileName: "whitelily-bridge-fabric-1.21.5-0.1.1.jar",
          bytes: 52_087,
          sha256: "8a6e00d47a28799798ffa5d561156ea7ceb0f697a0beb2cc7c55b34f6f81b514",
          modId: "whitelily_bridge",
          version: "0.1.1",
        }),
        Object.freeze({
          fileName: "whitelily-bridge-fabric-1.21.5-0.1.0.jar",
          bytes: 51_837,
          sha256: "380721d28236f5ad8206fd8d69af1e5629d741e9d38ec27c26c052c95266b6ce",
          modId: "whitelily_bridge",
          version: "0.1.0",
        }),
      ]),
    }),
    Object.freeze({
      component: "avatar" as const,
      fileName: "whitelily-avatar-fabric-1.21.5-0.1.1.jar",
      bytes: 257_936,
      sha256: "11a4375fada69928a4d1e0d8f6d330bc35ba23ab99c8b8e4c444eaa69f3a9271",
      modId: "whitelily_avatar",
      version: "0.1.1",
      prior: Object.freeze([
        Object.freeze({
          fileName: "whitelily-avatar-fabric-1.21.5-0.1.0.jar",
          bytes: 239_985,
          sha256: "1fdba2b89281d7dbfb96d8e2ab3637caf95b20452831377f46e5285d37531351",
          modId: "whitelily_avatar",
          version: "0.1.0",
        }),
      ]),
    }),
    Object.freeze({
      component: "avatar" as const,
      fileName: "fabric-api-0.128.2+1.21.5.jar",
      bytes: 2_248_994,
      sha256: "a82fd00827206e911936ed1e0ceaec6eb55d061ca5d3c5d63c7f0031426d29ae",
      modId: "fabric-api",
      version: "0.128.2+1.21.5",
      prior: Object.freeze([]),
    }),
  ]),
});

export function resolveDesktopMinecraftComponentResources(options: {
  appPath: string;
  resourcesPath: string;
  dataRoot: string;
  development: boolean;
}): DesktopMinecraftComponentResources {
  const repositoryRoot = resolve(options.appPath, "..", "..");
  return Object.freeze({
    resourceDirectory: options.development
      ? resolve(repositoryRoot, "build", "minecraft-components")
      : resolve(options.resourcesPath, "minecraft-components"),
    presenceDirectory: resolve(options.dataRoot, "bridge", "presence"),
    manifest: DESKTOP_MINECRAFT_COMPONENT_MANIFEST,
  });
}

const APPLICATION_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function createDesktopAppVersionEnvironment(
  appVersion: string,
): Readonly<{ WHITELILY_APP_VERSION: string }> {
  if (!APPLICATION_VERSION_PATTERN.test(appVersion)) {
    throw new Error("WhiteLily application version is invalid");
  }
  return Object.freeze({ WHITELILY_APP_VERSION: appVersion });
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
  prepareSupervisor(paths: TPaths, localAppData: string): Promise<void>;
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
  await options.prepareSupervisor(paths, localAppData);
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

export function createApplicationQuitRequest(
  lifecycle: Pick<ApplicationLifecycle, "quit">,
): () => Promise<void> {
  return () => lifecycle.quit();
}

export interface ElectronStartupOptions<TWindow extends StartupWindowPort> {
  app: StartupAppPort;
  supervisor: StartupSupervisorPort;
  createWindow(): TWindow;
  configureWindow(window: TWindow): void;
  registerIpc(window: TWindow, lifecycle: ApplicationLifecycle): () => void;
  createTray(window: TWindow, lifecycle: ApplicationLifecycle): StartupTrayPort;
  loadWindow(window: TWindow): Promise<void>;
  diagnostic(message: string): void;
  closeToTray?: () => boolean;
  onLifecycleOwned?(): void;
  onRendererReady?(window: TWindow): void;
}

const RENDERER_MOUNT_FAILURE_MESSAGE = "WhiteLily renderer did not mount";

export async function waitForRendererReady(options: {
  probe(): Promise<unknown>;
  wait?(milliseconds: number): Promise<void>;
  attempts?: number;
  deadline?: Promise<void>;
  timeoutMilliseconds?: number;
}): Promise<void> {
  const attempts = options.attempts ?? 120;
  const wait =
    options.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline =
    options.deadline ??
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, options.timeoutMilliseconds ?? 30_000);
    });
  let stopped = false;
  const poll = async (): Promise<void> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (stopped) return;
      const ready = await options.probe();
      if (stopped) return;
      if (ready === true) return;
      if (attempt + 1 < attempts) await wait(250);
    }
    throw new Error(RENDERER_MOUNT_FAILURE_MESSAGE);
  };
  try {
    await Promise.race([
      poll(),
      deadline.then(() => {
        throw new Error(RENDERER_MOUNT_FAILURE_MESSAGE);
      }),
    ]);
  } finally {
    stopped = true;
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

const STARTUP_FAILURE_MESSAGE = "WhiteLily Electron startup failed";
const STARTUP_ERROR_TITLE = "WhiteLily 启动失败";

export interface ElectronMainFailureDisplayOptions {
  run(): Promise<void>;
  displayError(title: string, message: string): void | Promise<void>;
  setExitCode(code: number): void;
}

export async function runElectronMainWithFailureDisplay(
  options: ElectronMainFailureDisplayOptions,
): Promise<void> {
  try {
    await options.run();
  } catch (error) {
    const message = localStartupFailureMessage(error);
    try {
      await options.displayError(STARTUP_ERROR_TITLE, message);
    } catch {
      // Failure display is best effort; deterministic process failure still follows.
    }
    try {
      options.setExitCode(1);
    } catch {
      // The outer Electron process has no additional trusted recovery path.
    }
  }
}

function localStartupFailureMessage(error: unknown): string {
  if (error instanceof WorkspaceProvisionError) {
    switch (error.code) {
      case "WORKSPACE_RESOURCE_INVALID":
        return "无法验证 WhiteLily 动作工作区（WORKSPACE_RESOURCE_INVALID）。请重新安装 WhiteLily 后重试。";
      case "WORKSPACE_DEPLOY_FAILED":
        return "无法部署 WhiteLily 动作工作区（WORKSPACE_DEPLOY_FAILED）。请关闭 WhiteLily 后重试；如仍失败，请重新安装。";
      case "WORKSPACE_ROLLBACK_FAILED":
        return "无法恢复 WhiteLily 动作工作区（WORKSPACE_ROLLBACK_FAILED）。请保留当前用户数据并重新安装 WhiteLily。";
    }
  }
  return "WhiteLily 无法启动（STARTUP_FAILED）。请重新启动；如仍失败，请重新安装。";
}

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
    cleanupIpc = options.registerIpc(mainWindow, lifecycle);
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
    options.onRendererReady?.(mainWindow);
    tray = options.createTray(mainWindow, lifecycle);
    mainWindow.show();
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
  let workspaceProvision: WorkspaceProvisionResult | undefined;
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
            mkdir(paths.avatarModelRoot, { recursive: true }),
            mkdir(paths.avatarModelStagingRoot, { recursive: true }),
            mkdir(paths.avatarModelBridgeRoot, { recursive: true }),
          ]);
        },
        setPath: (name, path) => app.setPath(name, path),
      }),
    startPrimary: (prepared, ownership) =>
      startElectronPrimary(
        {
          prepareSupervisor: async (paths) => {
            workspaceProvision = undefined;
            const workspaceResources = resolveDesktopCodexWorkspaceResources({
              appPath: app.getAppPath(),
              resourcesPath: process.resourcesPath,
              development: !app.isPackaged,
            });
            workspaceProvision = await provisionCodexWorkspace({
              resourceDirectory: workspaceResources.resourceDirectory,
              dataRoot: paths.dataRoot,
              diagnostic: (code) => console.error(code),
            });
          },
          createSupervisor: (paths, localAppData) => {
            if (workspaceProvision === undefined) {
              throw new Error("WhiteLily workspace was not provisioned");
            }
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
                ...createDesktopAppVersionEnvironment(app.getVersion()),
                ...createWorkspaceVersionEnvironment(workspaceProvision),
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
            const minecraftComponentResources = resolveDesktopMinecraftComponentResources({
              appPath: app.getAppPath(),
              resourcesPath: process.resourcesPath,
              dataRoot: prepared.paths.dataRoot,
              development: !app.isPackaged,
            });
            const minecraftComponentManager = createMinecraftComponentManager({
              lanDetector,
              worldBindingAuthority: worldAuthority,
              ...minecraftComponentResources,
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
            await new MinecraftComponentPreferences({
              dataRoot: prepared.paths.dataRoot,
            }).initializeDefaults();
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
            const avatarModels = await createAvatarModelComposition({
              dataRoot: prepared.paths.dataRoot,
              resourcesPath: primary.development
                ? resolve(primary.appPath, "resources")
                : process.resourcesPath,
              showOpenDialog: (options) =>
                dialog.showOpenDialog({
                  title: options.title,
                  properties: [...options.properties],
                  filters: options.filters.map((filter) => ({
                    name: filter.name,
                    extensions: [...filter.extensions],
                  })),
                }),
              choosePortrait: async () => {
                const choice = await dialog.showMessageBox({
                  type: "question",
                  title: "Optional portrait",
                  message: "Choose an optional full portrait for this Minecraft skin?",
                  buttons: ["Choose portrait", "Skip", "Cancel"],
                  defaultId: 1,
                  cancelId: 2,
                  noLink: true,
                });
                return choice.response === 0 ? "pick" : choice.response === 1 ? "skip" : "cancel";
              },
              subscribeRuntime: (listener) =>
                primary.supervisor.subscribe((event) => listener(event)),
              diagnostic: (code, modelId) =>
                console.error(modelId === undefined ? code : `${code}:${modelId}`),
            });
            try {
              await startElectronComposition({
                app,
                supervisor: primary.supervisor,
                createWindow: () => new BrowserWindow(createMainWindowOptions(primary.preloadPath)),
                configureWindow: (window) => {
                  const externalUrlHandlers = createExternalUrlHandlers(externalUrlPolicy, (url) =>
                    shell.openExternal(url),
                  );
                  window.webContents.setWindowOpenHandler(externalUrlHandlers.openWindow);
                  window.webContents.on("will-navigate", externalUrlHandlers.navigate);
                },
                registerIpc: (window, lifecycle) => {
                  const cleanupIpc = registerIpcHandlers({
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
                    publishAvatarModels: (snapshot) => {
                      if (!window.isDestroyed()) {
                        window.webContents.send(
                          WHITE_LILY_IPC_CHANNELS.avatarModelsEvent,
                          snapshot,
                        );
                      }
                    },
                    externalUrlPolicy,
                    openExternal: (url) => shell.openExternal(url),
                    pcl2Discovery,
                    lanDetector,
                    worldAuthority,
                    minecraftComponentManager,
                    startupSettings,
                    closeToTraySettings,
                    avatarModels,
                    requestApplicationQuit: createApplicationQuitRequest(lifecycle),
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
                  });
                  return () => {
                    try {
                      cleanupIpc();
                    } finally {
                      avatarModels.dispose();
                    }
                  };
                },
                createTray: (window, lifecycle) =>
                  createNativeTray({
                    buildMenu: (template) => Menu.buildFromTemplate(template),
                    createTray: (icon) => new Tray(icon),
                    lifecycle,
                    nativeImage,
                    showWindow: () => showExistingWindow(window),
                    supervisor: primary.supervisor,
                  }),
                loadWindow: async (window) => {
                  if (primary.development) {
                    await window.loadURL("http://127.0.0.1:5173");
                  } else {
                    await window.loadFile(resolve(primary.appPath, "dist-renderer", "index.html"));
                  }
                  await waitForRendererReady({
                    probe: () =>
                      window.webContents.executeJavaScript(
                        'document.querySelector("#root")?.childElementCount > 0',
                      ),
                  });
                },
                diagnostic: (message) => console.error(message),
                closeToTray: () => closeToTray.value.closeToTray,
                onLifecycleOwned: transferOwnership,
                onRendererReady: (window) => {
                  mainWindow = window;
                },
              });
            } catch (error) {
              avatarModels.dispose();
              throw error;
            }
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
  void runElectronMainWithFailureDisplay({
    run: runElectronMain,
    displayError: async (title, message) => {
      const { dialog } = await import("electron");
      dialog.showErrorBox(title, message);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
  });
}
