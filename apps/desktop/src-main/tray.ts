import type { DesktopCommand } from "../../../src/desktop/desktopProtocol.js";
import type { RuntimeSnapshot } from "../../../src/runtime/runtimeEvents.js";

export type TrayActionId =
  "open" | "connect_or_disconnect" | "toggle_proactive_messages" | "emergency_stop" | "quit";

export interface TrayAction {
  readonly id: TrayActionId;
  readonly label: string;
  readonly enabled: boolean;
  invoke(): Promise<void>;
}

export interface TrayRuntimePort {
  status(): Promise<RuntimeSnapshot>;
  start(): Promise<RuntimeSnapshot>;
  stop(): Promise<RuntimeSnapshot>;
  emergencyStop(): Promise<RuntimeSnapshot>;
}

export interface TraySupervisorPort {
  request(
    command: Extract<DesktopCommand, { kind: "get_status" | "start_runtime" | "stop_runtime" }>,
  ): Promise<RuntimeSnapshot>;
  emergencyStop(): Promise<RuntimeSnapshot>;
}

export function createSupervisorTrayRuntime(supervisor: TraySupervisorPort): TrayRuntimePort {
  return {
    status: () => supervisor.request({ kind: "get_status" }),
    start: () => supervisor.request({ kind: "start_runtime" }),
    stop: () => supervisor.request({ kind: "stop_runtime" }),
    emergencyStop: () => supervisor.emergencyStop(),
  };
}

export interface ProactiveMessagesPort {
  isPaused(): boolean;
  toggle(): Promise<void>;
}

export interface TrayControllerOptions {
  runtime: TrayRuntimePort;
  showWindow(): void;
  quit(): Promise<void>;
  proactiveMessages?: ProactiveMessagesPort;
  onActionsChanged(actions: readonly TrayAction[]): void;
  destroyTray(): void;
  onError?(error: Error): void;
}

export interface TrayController {
  readonly actions: readonly TrayAction[];
  destroy(): void;
}

export function createTrayController(options: TrayControllerOptions): TrayController {
  let destroyed = false;

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error instanceof Error ? error : new Error("WhiteLily tray action failed"));
    } catch {
      // Diagnostics cannot turn a contained tray callback failure into an unhandled error.
    }
  };

  const run = async (operation: () => void | Promise<void>): Promise<void> => {
    if (destroyed) return;
    try {
      await operation();
    } catch (error) {
      reportError(error);
    }
  };

  const isConnected = (snapshot: RuntimeSnapshot): boolean =>
    snapshot.lifecycle === "running" ||
    snapshot.lifecycle === "starting" ||
    snapshot.minecraft.state !== "disconnected";

  const proactiveState = (): { enabled: boolean; paused: boolean } => {
    if (!options.proactiveMessages) return { enabled: false, paused: false };
    try {
      return { enabled: true, paused: options.proactiveMessages.isPaused() };
    } catch (error) {
      reportError(error);
      return { enabled: false, paused: false };
    }
  };

  const actions = (): readonly TrayAction[] => {
    const proactive = proactiveState();
    return [
      {
        id: "open",
        label: "打开 WhiteLily",
        enabled: true,
        invoke: () => run(options.showWindow),
      },
      {
        id: "connect_or_disconnect",
        label: "连接或断开",
        enabled: true,
        invoke: () =>
          run(async () => {
            const snapshot = await options.runtime.status();
            if (isConnected(snapshot)) await options.runtime.stop();
            else await options.runtime.start();
          }),
      },
      {
        id: "toggle_proactive_messages",
        label: proactive.enabled
          ? proactive.paused
            ? "恢复主动消息"
            : "暂停主动消息"
          : "主动消息（暂不可用）",
        enabled: proactive.enabled,
        invoke: () =>
          run(async () => {
            if (!options.proactiveMessages) return;
            await options.proactiveMessages.toggle();
            notify();
          }),
      },
      {
        id: "emergency_stop",
        label: "紧急停止",
        enabled: true,
        invoke: () =>
          run(async () => {
            await options.runtime.emergencyStop();
          }),
      },
      {
        id: "quit",
        label: "退出",
        enabled: true,
        invoke: () => run(options.quit),
      },
    ];
  };

  const notify = (): void => {
    if (destroyed) return;
    try {
      options.onActionsChanged(actions());
    } catch (error) {
      reportError(error);
    }
  };

  const controller: TrayController = {
    get actions() {
      return actions();
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      try {
        options.destroyTray();
      } catch (error) {
        reportError(error);
      }
    },
  };
  notify();
  return controller;
}
