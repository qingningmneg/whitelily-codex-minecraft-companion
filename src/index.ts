import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { WhiteLilyApp } from "./app.js";
import { loadConfig } from "./config/loadConfig.js";
import { RuntimeFacade } from "./runtime/runtimeFacade.js";
import type { RuntimeEvent } from "./runtime/runtimeEvents.js";
import type { TaskStopReason } from "./safety/taskBudget.js";

export const APP_NAME = "whitelily-codex-minecraft-companion";
export const APP_VERSION = "0.1.0";

type SignalName = "SIGINT" | "SIGTERM";
type PollHandle = ReturnType<typeof setInterval> | number;

export interface CliRuntime {
  start(): Promise<void>;
  stop(reason: TaskStopReason): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}

export interface CliDependencies {
  cwd?: string;
  createRuntime?: (configPath: string) => Promise<CliRuntime>;
  createApp?: (configPath: string) => Promise<WhiteLilyApp>;
  writeStdout?: (message: string) => void;
  writeStderr?: (message: string) => void;
  setExitCode?: (code: number) => void;
  onSignal?: (signal: SignalName, listener: () => void) => void;
  offSignal?: (signal: SignalName, listener: () => void) => void;
  setPoll?: (listener: () => void, milliseconds: number) => PollHandle;
  clearPoll?: (handle: PollHandle) => void;
  markerExists?: (path: string) => Promise<boolean>;
  deleteMarker?: (path: string) => Promise<void>;
}

export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && metaUrl === pathToFileURL(resolve(argv1)).href;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then(({ access }) => access(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function deleteExactMarker(path: string): Promise<void> {
  try {
    await import("node:fs/promises").then(({ unlink }) => unlink(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<void> {
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const writeStdout = dependencies.writeStdout ?? ((message) => console.log(message));
  const writeStderr = dependencies.writeStderr ?? ((message) => console.error(message));
  const setExitCode =
    dependencies.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  if (args[0] === "--check-config") {
    const path = args[1];
    if (!path) {
      writeStderr("Configuration invalid");
      setExitCode(1);
      return;
    }
    try {
      await loadConfig(resolve(cwd, path));
      writeStdout("Configuration OK");
    } catch {
      writeStderr("Configuration invalid");
      setExitCode(1);
    }
    return;
  }

  const create =
    dependencies.createRuntime ??
    (dependencies.createApp
      ? async (path: string): Promise<CliRuntime> =>
          new RuntimeFacade({ lifecycle: await dependencies.createApp!(path) })
      : async (path: string): Promise<CliRuntime> => {
          const { createRuntimeFacade } = await import("./app.js");
          return createRuntimeFacade(path);
        });
  const configPath = resolve(cwd, args[0] ?? "config.toml");
  let runtime: CliRuntime;
  let startFailureReported = false;
  let stopFailureReported = false;
  const reportRuntimeEvent = (event: RuntimeEvent): void => {
    if (event.kind !== "error") return;
    if (event.error.code === "RUNTIME_START_FAILED") {
      if (startFailureReported) return;
      startFailureReported = true;
      writeStderr("WhiteLily failed to start");
      setExitCode(1);
      return;
    }
    if (event.error.code === "RUNTIME_STOP_FAILED") {
      if (stopFailureReported) return;
      stopFailureReported = true;
      writeStderr("WhiteLily failed to stop");
      setExitCode(1);
      return;
    }
    writeStderr("WhiteLily runtime error");
    setExitCode(1);
  };
  let unsubscribeRuntime: () => void = () => undefined;
  try {
    runtime = await create(configPath);
    unsubscribeRuntime = runtime.subscribe(reportRuntimeEvent);
  } catch {
    writeStderr("WhiteLily failed to start");
    setExitCode(1);
    return;
  }

  const markerPath = resolve(cwd, "data", "stop.request");
  const onSignal = dependencies.onSignal ?? ((signal, listener) => process.on(signal, listener));
  const offSignal = dependencies.offSignal ?? ((signal, listener) => process.off(signal, listener));
  const setPoll =
    dependencies.setPoll ?? ((listener, milliseconds) => setInterval(listener, milliseconds));
  const clearPoll = dependencies.clearPoll ?? ((handle) => clearInterval(handle));
  const markerExists = dependencies.markerExists ?? pathExists;
  const deleteMarker = dependencies.deleteMarker ?? deleteExactMarker;
  let poll: PollHandle | undefined;
  let controlsAttached = false;
  let shutdownPromise: Promise<void> | undefined;
  let markerObserved = false;
  let markerChecking = false;
  let controlsGeneration = 0;

  const detachControls = (): void => {
    if (!controlsAttached) return;
    controlsAttached = false;
    controlsGeneration += 1;
    if (poll !== undefined) {
      clearPoll(poll);
      poll = undefined;
    }
    offSignal("SIGINT", signalListener);
    offSignal("SIGTERM", signalListener);
  };
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      detachControls();
      try {
        await runtime.stop("process_exit");
      } finally {
        unsubscribeRuntime();
      }
    })();
    return shutdownPromise;
  };
  const reportShutdownFailure = (): void => {
    if (stopFailureReported) return;
    stopFailureReported = true;
    writeStderr("WhiteLily failed to stop");
    setExitCode(1);
  };
  const signalListener = (): void => {
    void shutdown().catch(reportShutdownFailure);
  };
  const pollMarker = (): void => {
    if (!controlsAttached || markerObserved || markerChecking) return;
    const generation = controlsGeneration;
    const isCurrent = (): boolean => controlsAttached && controlsGeneration === generation;
    markerChecking = true;
    void (async () => {
      let exists: boolean;
      try {
        exists = await markerExists(markerPath);
      } catch {
        if (isCurrent()) reportShutdownFailure();
        return;
      }
      if (!isCurrent() || markerObserved || !exists) return;
      markerObserved = true;
      detachControls();
      let markerError: unknown;
      try {
        await deleteMarker(markerPath);
      } catch (error) {
        markerError = error;
      }
      try {
        await shutdown();
      } catch {
        reportShutdownFailure();
        return;
      }
      if (markerError !== undefined) reportShutdownFailure();
    })()
      .catch(() => {
        if (isCurrent()) reportShutdownFailure();
      })
      .finally(() => {
        markerChecking = false;
      });
  };

  controlsAttached = true;
  controlsGeneration += 1;
  onSignal("SIGINT", signalListener);
  onSignal("SIGTERM", signalListener);
  poll = setPoll(pollMarker, 500);

  try {
    await runtime.start();
  } catch {
    await shutdown().catch(() => undefined);
    if (!startFailureReported) {
      startFailureReported = true;
      writeStderr("WhiteLily failed to start");
      setExitCode(1);
    }
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await runCli(process.argv.slice(2));
}
