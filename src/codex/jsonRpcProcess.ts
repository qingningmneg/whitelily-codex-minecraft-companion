import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { resolve } from "node:path";

export type JsonRpcMessage =
  | { id: number; method: string; params: unknown }
  | { id: number; result: unknown }
  | { id: number; error: unknown }
  | { method: string; params: unknown };

export interface JsonRpcLineTransport {
  writeLine(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (error?: Error) => void): () => void;
  close(): void | Promise<void>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexSpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
}

export interface LoginStatusResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CodexChildSpawner = (spec: CodexSpawnSpec) => ChildProcessWithoutNullStreams;

export interface TerminableCodexChild {
  pid?: number | undefined;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  removeListener?(event: "error", listener: (error: Error) => void): unknown;
}

export interface ProcessTreeTerminationOptions {
  platform: NodeJS.Platform;
  spawnKiller?: (
    command: "taskkill.exe",
    args: readonly string[],
    options: { shell: false; stdio: "ignore"; windowsHide: true },
  ) => TerminableCodexChild;
  killerTimeoutMs?: number;
  targetExitTimeoutMs?: number;
}

export type CodexProcessTerminator = (child: TerminableCodexChild) => Promise<void>;

export interface CodexAppServerTransportOptions {
  spawnProcess?: CodexChildSpawner;
  terminateProcessTree?: CodexProcessTerminator;
  maxBufferedLineBytes?: number;
}

export interface JsonRpcProcessOptions {
  requestTimeoutMs?: number;
}

function cleanCodexEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = new Set(["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]);
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !blocked.has(key.toUpperCase())),
  );
}

function ensureSafeCmdExecutable(executable: string): void {
  if (/[\r\n"&|<>^%!]/.test(executable)) {
    throw new Error("invalid local Codex executable path");
  }
}

function codexCommandSpec(
  platform: NodeJS.Platform,
  executable: string,
  commandArgs: string[],
  environment: NodeJS.ProcessEnv,
): CodexSpawnSpec {
  const env = cleanCodexEnvironment(environment);
  if (platform !== "win32") {
    return { command: executable, args: commandArgs, env, windowsHide: false };
  }

  ensureSafeCmdExecutable(executable);
  const command = `""${executable}" ${commandArgs.join(" ")}"`;
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", command],
    env,
    windowsHide: true,
  };
}

export function createCodexAppServerSpawnSpec(
  platform: NodeJS.Platform,
  executable: string,
  environment: NodeJS.ProcessEnv,
): CodexSpawnSpec {
  return codexCommandSpec(
    platform,
    executable,
    ["app-server", "--listen", "stdio://"],
    environment,
  );
}

function defaultCodexExecutable(): string {
  return resolve(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
}

function spawnFromSpec(spec: CodexSpawnSpec): ChildProcessWithoutNullStreams {
  const options: SpawnOptionsWithoutStdio = {
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: spec.windowsHide,
  };
  return spawn(spec.command, spec.args, options);
}

function hasExited(child: TerminableCodexChild): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export function terminateCodexProcessTree(
  child: TerminableCodexChild,
  options: ProcessTreeTerminationOptions,
): Promise<void> {
  if (hasExited(child)) return Promise.resolve();

  return new Promise<void>((resolveResult, rejectResult) => {
    const targetExitTimeoutMs = options.targetExitTimeoutMs ?? 2_000;
    const killerTimeoutMs = options.killerTimeoutMs ?? 2_000;
    let settled = false;
    let killer: TerminableCodexChild | undefined;
    let killerTimer: NodeJS.Timeout | undefined;
    const onTargetClose = () => finish();
    const onTargetError = (error: Error) => finish(error);
    const onKillerClose = (code: number | null) => {
      clearTimeout(killerTimer);
      killerTimer = undefined;
      if (code !== 0 && !hasExited(child)) {
        finish(new Error("taskkill failed"));
      } else if (code !== 0) {
        finish();
      }
    };
    const onKillerError = (error: Error) => finish(error);
    const targetTimer = setTimeout(
      () => finish(new Error("Codex process did not exit after termination")),
      targetExitTimeoutMs,
    );
    const cleanup = () => {
      clearTimeout(targetTimer);
      clearTimeout(killerTimer);
      child.removeListener?.("close", onTargetClose);
      child.removeListener?.("error", onTargetError);
      killer?.removeListener?.("close", onKillerClose);
      killer?.removeListener?.("error", onKillerError);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectResult(error);
      else resolveResult();
    };

    child.once("close", onTargetClose);
    child.once("error", onTargetError);
    if (options.platform !== "win32") {
      try {
        if (!child.kill()) {
          finish(new Error("failed to terminate Codex process"));
        }
      } catch (error) {
        finish(asError(error, "failed to terminate Codex process"));
      }
      return;
    }
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) {
      finish(new Error("invalid Codex process id"));
      return;
    }

    const command = "taskkill.exe" as const;
    const args = ["/PID", String(child.pid), "/T", "/F"];
    const killerOptions = {
      shell: false as const,
      stdio: "ignore" as const,
      windowsHide: true as const,
    };
    const spawnKiller =
      options.spawnKiller ??
      ((taskkillCommand, taskkillArgs, taskkillOptions) =>
        spawn(taskkillCommand, taskkillArgs, taskkillOptions) as TerminableCodexChild);
    try {
      killer = spawnKiller(command, args, killerOptions);
    } catch (error) {
      finish(new Error(`failed to start taskkill: ${asError(error, "unknown error").message}`));
      return;
    }

    killer.once("error", onKillerError);
    killer.once("close", onKillerClose);
    killerTimer = setTimeout(() => {
      try {
        killer?.kill();
      } catch {
        // The timeout is the observable failure; a killer that cannot be killed is still cleaned up.
      }
      finish(new Error("taskkill timed out"));
    }, killerTimeoutMs);
  });
}

export function spawnCodexAppServerTransport(
  executable = defaultCodexExecutable(),
  options: CodexAppServerTransportOptions = {},
): JsonRpcLineTransport {
  const child = (options.spawnProcess ?? spawnFromSpec)(
    createCodexAppServerSpawnSpec(process.platform, executable, process.env),
  );
  const maxBufferedLineBytes = options.maxBufferedLineBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxBufferedLineBytes) || maxBufferedLineBytes < 1) {
    throw new Error("invalid app-server line limit");
  }
  const lineListeners = new Set<(line: string) => void>();
  const exitListeners = new Set<(error?: Error) => void>();
  let buffer: Buffer = Buffer.alloc(0);
  let exited = false;
  let terminationPromise: Promise<void> | undefined;
  const emitExit = (error?: Error) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener(error);
  };
  const terminate = (): Promise<void> => {
    const terminateProcess =
      options.terminateProcessTree ??
      ((target: TerminableCodexChild) =>
        terminateCodexProcessTree(target, { platform: process.platform }));
    terminationPromise ??= Promise.resolve().then(() => terminateProcess(child));
    return terminationPromise;
  };
  const failTransport = (error: Error): void => {
    buffer = Buffer.alloc(0);
    emitExit(error);
    void terminate().catch(() => undefined);
  };

  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer | string) => {
    if (exited) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline < 0 ? bytes.length : newline;
      const segment = bytes.subarray(offset, end);
      if (buffer.length + segment.length > maxBufferedLineBytes) {
        failTransport(new Error("Codex app-server stdout line exceeded the byte limit"));
        return;
      }
      const lineBytes =
        buffer.length === 0
          ? segment
          : Buffer.concat([buffer, segment], buffer.length + segment.length);
      if (newline < 0) {
        buffer = lineBytes;
        return;
      }
      const line = lineBytes.toString("utf8").replace(/\r$/, "");
      buffer = Buffer.alloc(0);
      for (const listener of lineListeners) listener(line);
      offset = newline + 1;
    }
  });
  child.once("error", (error) => emitExit(error));
  child.once("close", (code) =>
    emitExit(new Error(`Codex app server exited (${code ?? "unknown"})`)),
  );

  return {
    writeLine: (line) => {
      child.stdin.write(`${line}\n`);
    },
    onLine: (listener) => {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    close: async () => {
      await terminate();
    },
  };
}

export function runCodexLoginStatus(
  executable = defaultCodexExecutable(),
  timeoutMs = 10_000,
  spawnProcess: CodexChildSpawner = spawnFromSpec,
  signal?: AbortSignal,
  terminateProcessTree: CodexProcessTerminator = (child) =>
    terminateCodexProcessTree(child, { platform: process.platform }),
): Promise<LoginStatusResult> {
  return new Promise((resolveResult, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(
        codexCommandSpec(process.platform, executable, ["login", "status"], process.env),
      );
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let terminating = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const terminateThenReject = (reason: Error) => {
      if (settled || terminating) return;
      terminating = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void terminateProcessTree(child).then(
        () => finish(() => reject(reason)),
        (error: unknown) =>
          finish(() =>
            reject(
              new Error(
                `${reason.message}: ${asError(error, "process termination failed").message}`,
              ),
            ),
          ),
      );
    };
    const timer = setTimeout(
      () => terminateThenReject(new Error("login status timed out")),
      timeoutMs,
    );
    const abort = () => terminateThenReject(new Error("login status cancelled"));
    const onError = (error: Error) => {
      if (!terminating) finish(() => reject(error));
    };
    const onClose = (code: number | null) => {
      if (terminating) return;
      finish(() =>
        resolveResult({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? 1,
        }),
      );
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", onError);
    child.once("close", onClose);
  });
}

export class JsonRpcProcess {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: JsonRpcMessage) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private readonly unsubscribeLine: () => void;
  private readonly unsubscribeExit: () => void;
  private nextId = 1;
  private stopped = false;
  private closePromise: Promise<void> | undefined;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly transport: JsonRpcLineTransport,
    options: JsonRpcProcessOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1) {
      throw new Error("invalid JSON-RPC request timeout");
    }
    this.unsubscribeLine = transport.onLine((line) => this.handleLine(line));
    this.unsubscribeExit = transport.onExit((error) => this.handleExit(error));
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Codex app server is stopped"));
    const id = this.nextId++;
    return new Promise<T>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.failAndClose(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      try {
        this.transport.writeLine(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.stopped) return;
    this.transport.writeLine(JSON.stringify({ method, params }));
  }

  onNotification(listener: (notification: JsonRpcMessage) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.stopped) return Promise.resolve();
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.handleExit(new Error("Codex app server stopped"));
    this.unsubscribeLine();
    this.unsubscribeExit();
    await this.transport.close();
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if ("id" in message && typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if ("error" in message) {
        pending.reject(new Error("Codex app-server request failed"));
      } else if ("result" in message) {
        pending.resolve(message.result);
      }
      return;
    }
    if ("method" in message && typeof message.method === "string") {
      for (const listener of this.notificationListeners) listener(message);
    }
  }

  private rejectPending(error?: Error): void {
    const reason = error ?? new Error("Codex app server exited");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }

  private failAndClose(error: Error): void {
    if (this.stopped) return;
    this.handleExit(error);
    this.unsubscribeLine();
    this.unsubscribeExit();
    const closing = Promise.resolve().then(() => this.transport.close());
    this.closePromise = closing;
    void closing.catch(() => undefined);
  }

  private handleExit(error?: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    const reason = error ?? new Error("Codex app server exited");
    this.rejectPending(reason);
    for (const listener of this.exitListeners) listener(reason);
  }
}
