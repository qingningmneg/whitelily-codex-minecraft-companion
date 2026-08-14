import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";

export type JsonRpcRequestId = string | number;

export type JsonRpcServerRequest = {
  id: JsonRpcRequestId;
  method: string;
  params: unknown;
};

export type JsonRpcRequestHandler = (request: JsonRpcServerRequest) => Promise<unknown>;

export type JsonRpcMessage =
  | JsonRpcServerRequest
  | { id: JsonRpcRequestId; result: unknown }
  | { id: JsonRpcRequestId; error: unknown }
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

export interface CodexLaunchConfig {
  executablePath: string;
  codexHome: string;
}

export type CodexResourceLayout = "development" | "packaged";

export interface CodexResourceVerification {
  layout: CodexResourceLayout;
  manifestPath: string;
}

interface ReviewedRuntimeManifest {
  schemaVersion: 1;
  paths: { codexExecutable: string };
  allowlist: {
    exactFiles: Array<{
      source: string;
      target: string | null;
      bytes: number;
      sha256: string;
    }>;
    executableFiles: string[];
  };
  policySha256?: string;
  resources?: Array<{ path: string; bytes: number; sha256: string }>;
}

const verifiedCodexLaunchConfigs = new WeakSet<CodexLaunchConfig>();

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

export interface JsonRpcRequestOptions {
  timeoutMs?: number;
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

function controlledCodexEnvironment(
  platform: NodeJS.Platform,
  config: CodexLaunchConfig,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!verifiedCodexLaunchConfigs.has(config)) {
    throw new Error("Codex launch configuration was not verified");
  }
  const pathApi = platform === "win32" ? win32 : posix;
  if (!pathApi.isAbsolute(config.executablePath)) {
    throw new Error("Codex executable path must be absolute");
  }
  if (!pathApi.isAbsolute(config.codexHome) || /[\u0000\r\n]/u.test(config.codexHome)) {
    throw new Error("Codex home must be an absolute trusted path");
  }
  const env = cleanCodexEnvironment(environment);
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH" || key.toUpperCase() === "CODEX_HOME") delete env[key];
  }
  const binDirectory = pathApi.dirname(config.executablePath);
  const vendorDirectory = pathApi.dirname(binDirectory);
  env.PATH = [
    binDirectory,
    pathApi.join(vendorDirectory, "codex-path"),
    pathApi.join(vendorDirectory, "codex-resources"),
  ].join(pathApi.delimiter);
  env.CODEX_HOME = pathApi.normalize(config.codexHome);
  return env;
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
  if (!executable.toLowerCase().endsWith(".cmd")) {
    return {
      command: executable,
      args: commandArgs,
      env,
      windowsHide: true,
    };
  }
  const command = `""${executable}" ${commandArgs.join(" ")}"`;
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", command],
    env,
    windowsHide: true,
  };
}

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

export function createCodexAppServerSpawnSpec(
  platform: NodeJS.Platform,
  launch: string | CodexLaunchConfig,
  environment: NodeJS.ProcessEnv,
): CodexSpawnSpec {
  const executable = typeof launch === "string" ? launch : launch.executablePath;
  const controlledEnvironment =
    typeof launch === "string"
      ? environment
      : controlledCodexEnvironment(platform, launch, environment);
  return codexCommandSpec(
    platform,
    executable,
    [...httpProviderArgs, "app-server", "--listen", "stdio://"],
    controlledEnvironment,
  );
}

export function createBundledCodexLaunchConfig(
  resourceDirectory: string,
  dataRoot: string,
  platform: NodeJS.Platform = process.platform,
  verification: CodexResourceVerification = {
    layout: "packaged",
    manifestPath: join(resourceDirectory, "runtime-manifest.json"),
  },
): CodexLaunchConfig {
  if (
    !isAbsolute(resourceDirectory) ||
    !isAbsolute(dataRoot) ||
    !isAbsolute(verification.manifestPath)
  ) {
    throw new Error("WhiteLily Codex resource and data roots must be absolute");
  }
  const canonicalResources = realpathSync.native(resourceDirectory);
  const canonicalManifest = realpathSync.native(verification.manifestPath);
  const expectedManifest =
    verification.layout === "packaged"
      ? resolve(canonicalResources, "runtime-manifest.json")
      : resolve(
          canonicalResources,
          "..",
          "..",
          "..",
          "packaging",
          "electron",
          "runtime-manifest.json",
        );
  if (canonicalManifest !== realpathSync.native(expectedManifest)) {
    throw new Error("WhiteLily Codex manifest is not bound to its resource root");
  }
  const manifest = JSON.parse(readFileSync(canonicalManifest, "utf8")) as ReviewedRuntimeManifest;
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.allowlist ||
    !Array.isArray(manifest.allowlist.exactFiles) ||
    !Array.isArray(manifest.allowlist.executableFiles)
  ) {
    throw new Error("WhiteLily reviewed Codex manifest is invalid");
  }
  const nativePrefix =
    verification.layout === "packaged" ? "codex/native/" : "node_modules/@openai/codex-win32-x64/";
  const nativeRoot =
    verification.layout === "packaged"
      ? realpathSync.native(resolve(canonicalResources, "codex", "native"))
      : canonicalResources;
  const nativeEntries = manifest.allowlist.exactFiles.filter((entry) => {
    const portable = verification.layout === "packaged" ? entry.target : entry.source;
    return portable?.startsWith(nativePrefix) === true;
  });
  if (
    verification.layout === "packaged" &&
    (!/^[a-f0-9]{64}$/u.test(manifest.policySha256 ?? "") || !Array.isArray(manifest.resources))
  ) {
    throw new Error("WhiteLily packaged Codex manifest binding is invalid");
  }
  const resolveEntry = (entry: (typeof nativeEntries)[number]): string => {
    const portable = verification.layout === "packaged" ? entry.target : entry.source;
    if (portable === null) throw new Error("WhiteLily Codex manifest target is invalid");
    const relativePath = portable.slice(nativePrefix.length);
    const path = resolve(nativeRoot, ...relativePath.split("/"));
    const canonical = realpathSync.native(path);
    const child = relative(nativeRoot, canonical);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error("WhiteLily Codex resource escaped its verified root");
    }
    const metadata = statSync(canonical);
    const hash = createHash("sha256").update(readFileSync(canonical)).digest("hex");
    if (!metadata.isFile() || metadata.size !== entry.bytes || hash !== entry.sha256) {
      throw new Error(`WhiteLily Codex resource hash mismatch: ${portable}`);
    }
    if (verification.layout === "packaged") {
      const packaged = manifest.resources?.find((resource) => resource.path === portable);
      if (!packaged || packaged.bytes !== entry.bytes || packaged.sha256 !== entry.sha256) {
        throw new Error(`WhiteLily packaged Codex resource is not manifest-bound: ${portable}`);
      }
    }
    return canonical;
  };
  const verifiedFiles = new Map(
    nativeEntries.map((entry) => [
      verification.layout === "packaged" ? entry.target : entry.source,
      resolveEntry(entry),
    ]),
  );
  const executablePortable =
    verification.layout === "packaged"
      ? manifest.paths.codexExecutable
      : `node_modules/@openai/codex-win32-x64/${manifest.paths.codexExecutable.replace(
          "codex/native/",
          "",
        )}`;
  const executablePath = verifiedFiles.get(executablePortable);
  if (!executablePath) throw new Error("WhiteLily Codex executable is absent from the manifest");
  const executableRoot = resolve(nativeRoot, "vendor");
  const actualExecutables: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:com|exe|msi)$/iu.test(entry.name)) {
        actualExecutables.push(relative(nativeRoot, path).split(sep).join("/"));
      } else if (!entry.isFile()) {
        throw new Error("WhiteLily Codex resources must not contain links");
      }
    }
  };
  visit(executableRoot);
  const expectedExecutables = manifest.allowlist.executableFiles
    .map((path) => path.replace("codex/native/", ""))
    .sort();
  if (actualExecutables.sort().join("\n") !== expectedExecutables.join("\n")) {
    throw new Error("WhiteLily Codex executable allowlist mismatch");
  }
  mkdirSync(dataRoot, { recursive: true });
  const canonicalDataRoot = realpathSync.native(dataRoot);
  const codexHomeCandidate = join(canonicalDataRoot, "codex");
  mkdirSync(codexHomeCandidate, { recursive: true });
  const codexHome = realpathSync.native(codexHomeCandidate);
  if (dirname(codexHome) !== canonicalDataRoot) {
    throw new Error("WhiteLily Codex home escaped the data root");
  }
  const config = Object.freeze({
    executablePath,
    codexHome,
  });
  verifiedCodexLaunchConfigs.add(config);
  return config;
}

function resolveDevelopmentCodexVerification(): {
  resourceDirectory: string;
  verification: CodexResourceVerification;
} {
  const localRequire = createRequire(import.meta.url);
  const resourceDirectory = dirname(localRequire.resolve("@openai/codex-win32-x64/package.json"));
  return {
    resourceDirectory,
    verification: {
      layout: "development",
      manifestPath: resolve(
        resourceDirectory,
        "..",
        "..",
        "..",
        "packaging",
        "electron",
        "runtime-manifest.json",
      ),
    },
  };
}

export function resolveDefaultCodexExecutable(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "win32" && arch === "x64") {
    const localRequire = createRequire(import.meta.url);
    const packageRoot = dirname(localRequire.resolve("@openai/codex-win32-x64/package.json"));
    return resolve(packageRoot, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  }
  return resolve(
    process.cwd(),
    "node_modules",
    ".bin",
    platform === "win32" ? "codex.cmd" : "codex",
  );
}

export function resolveDefaultCodexLaunchConfig(
  dataRoot?: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CodexLaunchConfig {
  const pathApi = platform === "win32" ? win32 : posix;
  const resolvedDataRoot =
    dataRoot ??
    process.env.WHITELILY_DATA_ROOT ??
    (platform === "win32" && process.env.LOCALAPPDATA
      ? pathApi.join(process.env.LOCALAPPDATA, "WhiteLily")
      : resolve(process.cwd(), "data"));
  if (platform === "win32" && arch === "x64") {
    const configuredRoot = process.env.WHITELILY_CODEX_RESOURCE_ROOT;
    const configuredManifest = process.env.WHITELILY_CODEX_MANIFEST;
    const configuredLayout = process.env.WHITELILY_CODEX_LAYOUT;
    if (configuredRoot || configuredManifest || configuredLayout) {
      if (
        !configuredRoot ||
        !configuredManifest ||
        (configuredLayout !== "packaged" && configuredLayout !== "development")
      ) {
        throw new Error("WhiteLily Codex resource environment is incomplete");
      }
      return createBundledCodexLaunchConfig(configuredRoot, resolvedDataRoot, platform, {
        layout: configuredLayout,
        manifestPath: configuredManifest,
      });
    }
    const development = resolveDevelopmentCodexVerification();
    return createBundledCodexLaunchConfig(
      development.resourceDirectory,
      resolvedDataRoot,
      platform,
      development.verification,
    );
  }
  return {
    executablePath: resolveDefaultCodexExecutable(platform, arch),
    codexHome: pathApi.join(pathApi.resolve(resolvedDataRoot), "codex"),
  };
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
  launch: string | CodexLaunchConfig = resolveDefaultCodexLaunchConfig(),
  options: CodexAppServerTransportOptions = {},
): JsonRpcLineTransport {
  const child = (options.spawnProcess ?? spawnFromSpec)(
    createCodexAppServerSpawnSpec(process.platform, launch, process.env),
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
  launch: string | CodexLaunchConfig = resolveDefaultCodexLaunchConfig(),
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
        codexCommandSpec(
          process.platform,
          typeof launch === "string" ? launch : launch.executablePath,
          ["login", "status"],
          typeof launch === "string"
            ? process.env
            : controlledCodexEnvironment(process.platform, launch, process.env),
        ),
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
  private requestHandler: JsonRpcRequestHandler | undefined;

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

  request<T>(method: string, params: unknown, options: JsonRpcRequestOptions = {}): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Codex app server is stopped"));
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new Error("invalid JSON-RPC request timeout"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.failAndClose(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
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

  onRequest(handler: JsonRpcRequestHandler): () => void {
    if (this.requestHandler) throw new Error("Codex app-server request handler is already set");
    this.requestHandler = handler;
    return () => {
      if (this.requestHandler === handler) this.requestHandler = undefined;
    };
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = Promise.resolve().then(() =>
      this.stopped ? this.transport.close() : this.closeInternal(),
    );
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
    if (
      "id" in message &&
      (typeof message.id === "string" || typeof message.id === "number") &&
      "method" in message &&
      typeof message.method === "string"
    ) {
      void this.answerServerRequest(message).catch(() => undefined);
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

  private async answerServerRequest(request: JsonRpcServerRequest): Promise<void> {
    const handler = this.requestHandler;
    let response:
      { id: JsonRpcRequestId; result: unknown } | { id: JsonRpcRequestId; error: unknown };
    if (!handler) {
      response = {
        id: request.id,
        error: { code: -32_601, message: "Method not found" },
      };
    } else {
      try {
        response = { id: request.id, result: await handler(request) };
      } catch {
        response = {
          id: request.id,
          error: { code: -32_603, message: "Internal error" },
        };
      }
    }
    if (this.stopped) return;
    try {
      this.transport.writeLine(JSON.stringify(response));
    } catch (error) {
      this.failAndClose(asError(error, "failed to write Codex app-server response"));
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
    const closing = Promise.resolve().then(() => this.transport.close());
    this.closePromise = closing;
    this.handleExit(error);
    this.unsubscribeLine();
    this.unsubscribeExit();
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
