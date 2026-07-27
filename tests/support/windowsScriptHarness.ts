import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const fixtureMarkerContents = "WhiteLily Windows script fixture v1\n";
const cleanupTimeoutMilliseconds = 12_000;
const processOperationTimeoutMilliseconds = 5_000;

export interface WindowsScriptFixtureOptions {
  existingConfig?: string;
  nodeVersion?: string;
  npmVersion?: string;
  codexStatus?: string;
  codexExitCode?: number;
  codexAvailable?: boolean;
  configValid?: boolean;
  codexDelayMilliseconds?: number;
  dropOwnershipAfterMarker?: boolean;
  pidFile?: string;
  pidPathAsDirectory?: boolean;
  staleStopRequest?: string;
  unrelatedDataFile?: string;
  windowsBuild?: number;
  signal?: AbortSignal;
  operationTimeoutMilliseconds?: number;
  taskkillPathForTest?: string;
  closeSettlementDelayMillisecondsForTest?: number;
  onProcessCloseForTest?: () => void;
}

export interface WindowsScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  createdPaths: string[];
  modifiedPaths: string[];
  deletedPaths: string[];
  invocations: string[];
}

export interface WindowsProcessIdentity {
  pid: number;
  creationDate: string;
  commandLine: string;
}

export interface FixtureCleanupIdentity {
  pid: number;
  creationDate: string;
  entryPath: string;
}

interface FixtureLifecycle {
  cleanupController: AbortController;
  activeOperations: Set<Promise<void>>;
  closed: boolean;
  cleanupPromise?: Promise<void>;
  needsServiceScan: boolean;
  service?: FixtureCleanupIdentity;
}

interface WindowsProcessRequest {
  fixtureRoot?: string;
  label: string;
  file: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMilliseconds: number;
  taskkillPathForTest?: string;
  closeSettlementDelayMillisecondsForTest?: number;
  onProcessCloseForTest?: () => void;
}

interface WindowsProcessOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type FilesystemSnapshot = Map<string, string>;

const fixtureLifecycles = new Map<string, FixtureLifecycle>();

class WindowsFixtureAbortError extends Error {
  override readonly name = "AbortError";

  constructor(message = "Windows script fixture operation was cancelled") {
    super(message);
  }
}

class WindowsFixtureTimeoutError extends Error {
  override readonly name = "TimeoutError";

  constructor(label: string, timeoutMilliseconds: number) {
    super(`${label} timed out after ${timeoutMilliseconds}ms`);
  }
}

function fixtureLifecycle(root: string): FixtureLifecycle {
  const fixtureRoot = resolve(root);
  const current = fixtureLifecycles.get(fixtureRoot);
  if (current !== undefined) return current;
  const created: FixtureLifecycle = {
    cleanupController: new AbortController(),
    activeOperations: new Set(),
    closed: false,
    needsServiceScan: false,
  };
  fixtureLifecycles.set(fixtureRoot, created);
  return created;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function registerFixtureOperation(lifecycle: FixtureLifecycle): () => void {
  if (lifecycle.closed) {
    throw new WindowsFixtureAbortError("Windows script fixture cleanup has already started");
  }
  let resolveOperation!: () => void;
  const operation = new Promise<void>((resolveOperationPromise) => {
    resolveOperation = resolveOperationPromise;
  });
  lifecycle.activeOperations.add(operation);
  return () => {
    lifecycle.activeOperations.delete(operation);
    resolveOperation();
  };
}

function createClosePromise(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolveClose, rejectClose) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      if (spawnError !== undefined) {
        rejectClose(spawnError);
      } else {
        resolveClose(code ?? 1);
      }
    });
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function runTaskkill(pid: number, taskkillPathForTest?: string): Promise<void> {
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  const taskkill = spawn(
    taskkillPathForTest ?? join(windowsRoot, "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"],
    {
      cwd: tmpdir(),
      windowsHide: true,
      stdio: "ignore",
    },
  );
  const close = createClosePromise(taskkill);
  let exitCode: number;
  try {
    exitCode = await withTimeout(
      close,
      processOperationTimeoutMilliseconds,
      `taskkill did not finish for fixture PID ${pid}`,
    );
  } catch (error) {
    const terminationErrors: unknown[] = [error];
    if (taskkill.exitCode === null && taskkill.signalCode === null) {
      try {
        taskkill.kill();
      } catch (killError) {
        terminationErrors.push(killError);
      }
    }
    try {
      await withTimeout(close, 2_000, `taskkill could not be reaped for fixture PID ${pid}`);
    } catch (closeError) {
      terminationErrors.push(closeError);
    }
    if (terminationErrors.length > 1) {
      throw new AggregateError(
        terminationErrors,
        `taskkill could not be terminated cleanly for fixture PID ${pid}`,
      );
    }
    throw error;
  }
  if (exitCode !== 0) {
    throw new Error(`taskkill failed for fixture PID ${pid} with exit code ${exitCode}`);
  }
}

async function terminateOwnedChildTree(
  child: ChildProcess,
  close: Promise<number>,
  taskkillPathForTest?: string,
): Promise<void> {
  const terminationErrors: unknown[] = [];
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    try {
      await runTaskkill(child.pid, taskkillPathForTest);
    } catch (error) {
      terminationErrors.push(error);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill();
        } catch (killError) {
          terminationErrors.push(killError);
        }
      }
    }
  }
  try {
    await withTimeout(close, 5_000, "fixture process tree did not close after termination");
  } catch (closeError) {
    terminationErrors.push(closeError);
  }
  if (terminationErrors.length === 1) throw terminationErrors[0];
  if (terminationErrors.length > 1) {
    throw new AggregateError(
      terminationErrors,
      "fixture process tree termination did not settle cleanly",
    );
  }
}

async function runWindowsProcess(request: WindowsProcessRequest): Promise<WindowsProcessOutput> {
  if (request.signal?.aborted) throw new WindowsFixtureAbortError();
  const fixtureCaptureParent =
    request.fixtureRoot === undefined
      ? undefined
      : join(resolve(request.fixtureRoot), ".harness-io");
  if (fixtureCaptureParent !== undefined) {
    await mkdir(fixtureCaptureParent, { recursive: true });
  }
  const captureRoot = await mkdtemp(join(fixtureCaptureParent ?? tmpdir(), "whitelily-process-"));
  const stdoutPath = join(captureRoot, "stdout.txt");
  const stderrPath = join(captureRoot, "stderr.txt");
  const stdoutFile = await open(stdoutPath, "w");
  const stderrFile = await open(stderrPath, "w");
  let operationError: unknown;
  let exitCode: number | undefined;
  try {
    const closeDelay = request.closeSettlementDelayMillisecondsForTest ?? 0;
    if (!Number.isSafeInteger(closeDelay) || closeDelay < 0 || closeDelay > 1_000) {
      throw new Error(
        "closeSettlementDelayMillisecondsForTest must be an integer between 0 and 1000",
      );
    }
    const child = spawn(request.file, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      windowsHide: true,
      stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
    });
    let closed = false;
    const rawClose = createClosePromise(child);
    void rawClose.then(
      () => {
        closed = true;
      },
      () => {
        closed = true;
      },
    );
    const close = rawClose.then(async (code) => {
      if (closeDelay > 0) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, closeDelay));
      }
      request.onProcessCloseForTest?.();
      return code;
    });
    let stopRequested = false;
    let rejectStop!: (error: unknown) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStop = reject;
    });
    const requestStop = (error: Error) => {
      if (stopRequested || closed) return;
      stopRequested = true;
      void terminateOwnedChildTree(child, close, request.taskkillPathForTest).then(
        () => rejectStop(error),
        (terminationError: unknown) => {
          rejectStop(
            new AggregateError(
              [error, terminationError],
              "Windows fixture process tree could not be terminated cleanly",
            ),
          );
        },
      );
    };
    const onAbort = () => requestStop(new WindowsFixtureAbortError());
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () => requestStop(new WindowsFixtureTimeoutError(request.label, request.timeoutMilliseconds)),
      request.timeoutMilliseconds,
    );
    if (request.signal?.aborted) onAbort();

    try {
      const normalClose = close.then((code) =>
        stopRequested
          ? new Promise<never>(() => {
              // The termination path owns settlement after cancellation.
            })
          : code,
      );
      exitCode = await Promise.race([normalClose, stopped]);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    operationError = error;
  } finally {
    await Promise.all([stdoutFile.close(), stderrFile.close()]);
  }
  const [stdout, stderr] = await Promise.all([
    readFile(stdoutPath, "utf8"),
    readFile(stderrPath, "utf8"),
  ]);
  if (fixtureCaptureParent === undefined) {
    await rm(captureRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
  if (operationError !== undefined) throw operationError;
  return { exitCode: exitCode ?? 1, stdout, stderr };
}

async function snapshotFilesystem(root: string, current = root): Promise<FilesystemSnapshot> {
  const snapshot = new Map<string, string>();
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (current === root && entry.name === ".harness-io") continue;
    const path = join(current, entry.name);
    const name = relative(root, path).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      snapshot.set(name, "directory");
      for (const [childName, fingerprint] of await snapshotFilesystem(root, path)) {
        snapshot.set(childName, fingerprint);
      }
    } else if (entry.isSymbolicLink()) {
      snapshot.set(name, `symlink:${await readlink(path)}`);
    } else {
      const digest = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      snapshot.set(name, `file:${digest}`);
    }
  }
  return snapshot;
}

async function copyIfPresent(source: string, target: string): Promise<void> {
  if (!(await exists(source))) return;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

function batchLine(value: string): string {
  return value.replaceAll("%", "%%").replaceAll("\r", "").replaceAll("\n", " ");
}

function normalizeCommandPath(path: string): string {
  return resolve(path).replaceAll("\\", "/").toLocaleLowerCase();
}

async function commandPathAliases(path: string): Promise<Set<string>> {
  const aliases = new Set([normalizeCommandPath(path)]);
  try {
    aliases.add(normalizeCommandPath(await realpath(path)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return aliases;
}

function powerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function validatedCodexDelay(options: WindowsScriptFixtureOptions): number {
  const delay = options.codexDelayMilliseconds ?? 0;
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 30_000) {
    throw new Error("codexDelayMilliseconds must be an integer between 0 and 30000");
  }
  return delay;
}

async function prepareFixture(
  root: string,
  scriptName: "setup.ps1" | "start.ps1" | "stop.ps1" | "doctor.ps1",
  options: WindowsScriptFixtureOptions,
): Promise<{ shimDirectory: string; invocationLog: string }> {
  const repository = process.cwd();
  const shimDirectory = join(root, "command-shims");
  const invocationLog = join(root, "command-invocations.log");
  const codexDelay = validatedCodexDelay(options);
  const codexDelayScript = join(shimDirectory, "codex-delay.ps1");
  await mkdir(shimDirectory, { recursive: true });
  await writeFile(invocationLog, "", "utf8");
  await writeFile(join(root, ".whitelily-test-fixture"), fixtureMarkerContents, "utf8");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "dist", "src"), { recursive: true });
  await writeFile(
    join(root, "dist", "src", "index.js"),
    scriptName === "start.ps1"
      ? [
          'import { existsSync } from "node:fs";',
          'import { join } from "node:path";',
          'if (process.argv.includes("--check-config")) {',
          '  if (process.env.WHITELILY_TEST_CONFIG_VALID === "0") process.exit(1);',
          "  process.exit(0);",
          "}",
          'const marker = join(process.env.WHITELILY_TEST_APP_ROOT, "data", "stop.request");',
          "function waitForStop() {",
          "  if (existsSync(marker)) process.exit(0);",
          "  setTimeout(waitForStop, 25);",
          "}",
          "waitForStop();",
          "",
        ].join("\n")
      : "// fixture\n",
    "utf8",
  );
  await copyFile(join(repository, "config.example.toml"), join(root, "config.example.toml"));
  await copyFile(join(repository, "package.json"), join(root, "package.json"));
  for (const script of ["setup.ps1", "start.ps1", "stop.ps1", "doctor.ps1"]) {
    await copyIfPresent(join(repository, "scripts", script), join(root, "scripts", script));
  }
  if (options.existingConfig !== undefined) {
    await writeFile(join(root, "config.toml"), options.existingConfig, "utf8");
  }
  if (options.pidPathAsDirectory) {
    await mkdir(join(root, "data", "whitelily.pid"), { recursive: true });
  } else if (options.pidFile !== undefined) {
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "whitelily.pid"), options.pidFile, "utf8");
  }
  if (options.staleStopRequest !== undefined || options.unrelatedDataFile !== undefined) {
    await mkdir(join(root, "data"), { recursive: true });
  }
  if (options.staleStopRequest !== undefined) {
    await writeFile(join(root, "data", "stop.request"), options.staleStopRequest, "utf8");
  }
  if (options.unrelatedDataFile !== undefined) {
    await writeFile(join(root, "data", "keep.txt"), options.unrelatedDataFile, "utf8");
  }

  const nodeVersion = batchLine(options.nodeVersion ?? "v24.1.0");
  const npmVersion = batchLine(options.npmVersion ?? "11.2.0");
  const nodeCommandShim = join(shimDirectory, "node.cmd");
  if (scriptName === "start.ps1") {
    await rm(nodeCommandShim, { force: true });
  } else {
    await writeFile(
      nodeCommandShim,
      [
        "@echo off",
        "setlocal",
        `if "%~1"=="--version" (echo ${nodeVersion}& exit /b 0)`,
        '>>"%WHITELILY_TEST_INVOCATION_LOG%" echo node %*',
        'if "%~2"=="--check-config" (',
        '  if "%WHITELILY_TEST_CONFIG_VALID%"=="0" (echo Configuration invalid 1>&2& exit /b 1)',
        "  echo Configuration OK",
        "  exit /b 0",
        ")",
        "exit /b 0",
        "",
      ].join("\r\n"),
      "utf8",
    );
  }
  await writeFile(
    join(shimDirectory, "npm.cmd"),
    [
      "@echo off",
      "setlocal",
      `if "%~1"=="--version" (echo ${npmVersion}& exit /b 0)`,
      '>>"%WHITELILY_TEST_INVOCATION_LOG%" echo npm %*',
      "exit /b 0",
      "",
    ].join("\r\n"),
    "utf8",
  );
  await writeFile(
    join(shimDirectory, "npm.ps1"),
    [
      "if ($args[0] -eq '--version') {",
      `  Write-Output '${npmVersion.replaceAll("'", "''")}'`,
      "  exit 0",
      "}",
      "Add-Content -LiteralPath $env:WHITELILY_TEST_INVOCATION_LOG -Value ('npm ' + ($args -join ' '))",
      "exit 0",
      "",
    ].join("\r\n"),
    "utf8",
  );
  if (options.codexAvailable !== false) {
    await writeFile(
      codexDelayScript,
      [
        "param([Parameter(Mandatory = $true)][int]$Milliseconds)",
        "Start-Sleep -Milliseconds $Milliseconds",
        "",
      ].join("\r\n"),
      "utf8",
    );
    await writeFile(
      join(shimDirectory, "codex.cmd"),
      [
        "@echo off",
        "setlocal",
        '>>"%WHITELILY_TEST_INVOCATION_LOG%" echo codex %*',
        'if not "%WHITELILY_TEST_CODEX_EXIT%"=="0" exit /b %WHITELILY_TEST_CODEX_EXIT%',
        ...(codexDelay > 0
          ? [
              `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${batchLine(codexDelayScript)}" ${codexDelay}`,
              "if errorlevel 1 exit /b %errorlevel%",
            ]
          : ["rem no Codex delay requested"]),
        "echo %WHITELILY_TEST_CODEX_STATUS%",
        "exit /b 0",
        "",
      ].join("\r\n"),
      "utf8",
    );
    await writeFile(
      join(shimDirectory, "codex.ps1"),
      [
        "Add-Content -LiteralPath $env:WHITELILY_TEST_INVOCATION_LOG -Value ('codex ' + ($args -join ' '))",
        "if ([int]$env:WHITELILY_TEST_CODEX_EXIT -ne 0) { exit [int]$env:WHITELILY_TEST_CODEX_EXIT }",
        ...(codexDelay > 0
          ? [
              `& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${powerShellLiteral(codexDelayScript)}' ${codexDelay}`,
              "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
            ]
          : ["# no Codex delay requested"]),
        "Write-Output $env:WHITELILY_TEST_CODEX_STATUS",
        "exit 0",
        "",
      ].join("\r\n"),
      "utf8",
    );
  }
  return { shimDirectory, invocationLog };
}

function systemFixturePath(shimDirectory: string): string {
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  return [
    shimDirectory,
    dirname(process.execPath),
    join(windowsRoot, "System32", "WindowsPowerShell", "v1.0"),
    join(windowsRoot, "System32"),
    windowsRoot,
  ].join(";");
}

export async function runWindowsScriptFixture(
  root: string,
  scriptName: "setup.ps1" | "start.ps1" | "stop.ps1" | "doctor.ps1",
  args: readonly string[],
  options: WindowsScriptFixtureOptions = {},
): Promise<WindowsScriptResult> {
  const fixtureRoot = resolve(root);
  const lifecycle = fixtureLifecycle(fixtureRoot);
  const finishOperation = registerFixtureOperation(lifecycle);
  const operationSignal =
    options.signal === undefined
      ? lifecycle.cleanupController.signal
      : AbortSignal.any([options.signal, lifecycle.cleanupController.signal]);
  try {
    const { shimDirectory, invocationLog } = await prepareFixture(fixtureRoot, scriptName, options);
    const before = await snapshotFilesystem(fixtureRoot);
    const env = {
      ...process.env,
      PATH: systemFixturePath(shimDirectory),
      WHITELILY_TEST_APP_ROOT: fixtureRoot,
      WHITELILY_TEST_INVOCATION_LOG: invocationLog,
      WHITELILY_TEST_CODEX_STATUS: options.codexStatus ?? "Logged in using ChatGPT",
      WHITELILY_TEST_CODEX_EXIT: String(options.codexExitCode ?? 0),
      WHITELILY_TEST_CONFIG_VALID: options.configValid === false ? "0" : "1",
      WHITELILY_TEST_DROP_OWNERSHIP_AFTER_MARKER: options.dropOwnershipAfterMarker ? "1" : "0",
      WHITELILY_TEST_WINDOWS_BUILD:
        options.windowsBuild === undefined ? "" : String(options.windowsBuild),
    };
    const scriptPath = join(fixtureRoot, "scripts", scriptName);
    if (scriptName === "start.ps1") lifecycle.needsServiceScan = true;
    const { exitCode, stdout, stderr } = await runWindowsProcess({
      fixtureRoot,
      label: `${scriptName} fixture runner`,
      file: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      cwd: fixtureRoot,
      env,
      signal: operationSignal,
      timeoutMilliseconds: options.operationTimeoutMilliseconds ?? 12_000,
      ...(options.taskkillPathForTest === undefined
        ? {}
        : { taskkillPathForTest: options.taskkillPathForTest }),
      ...(options.closeSettlementDelayMillisecondsForTest === undefined
        ? {}
        : {
            closeSettlementDelayMillisecondsForTest:
              options.closeSettlementDelayMillisecondsForTest,
          }),
      ...(options.onProcessCloseForTest === undefined
        ? {}
        : { onProcessCloseForTest: options.onProcessCloseForTest }),
    });
    const after = await snapshotFilesystem(fixtureRoot);
    const invocations = (await exists(invocationLog))
      ? (await readFile(invocationLog, "utf8"))
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
    if (scriptName === "start.ps1" && exitCode === 0) {
      const pidText = await readFile(join(fixtureRoot, "data", "whitelily.pid"), "utf8");
      if (/^[1-9]\d*\r?\n?$/.test(pidText)) {
        const pid = Number(pidText.trim());
        const entryPath = join(fixtureRoot, "dist", "src", "index.js");
        const identity = await waitForExpectedProcessIdentity(
          pid,
          entryPath,
          "started fixture service",
        );
        lifecycle.service = {
          pid,
          creationDate: identity.creationDate,
          entryPath,
        };
      }
    }
    if (scriptName === "stop.ps1" && exitCode === 0) {
      delete lifecycle.service;
      lifecycle.needsServiceScan = false;
    }
    const beforePaths = new Set(before.keys());
    const afterPaths = new Set(after.keys());
    return {
      exitCode,
      stdout,
      stderr,
      createdPaths: [...afterPaths].filter((path) => !beforePaths.has(path)).sort(),
      modifiedPaths: [...afterPaths]
        .filter((path) => before.has(path) && before.get(path) !== after.get(path))
        .sort(),
      deletedPaths: [...beforePaths].filter((path) => !afterPaths.has(path)).sort(),
      invocations,
    };
  } catch (error) {
    if (scriptName === "start.ps1" || scriptName === "stop.ps1") {
      lifecycle.needsServiceScan = true;
    }
    throw error;
  } finally {
    finishOperation();
  }
}

export async function startOwnedFixtureProcess(
  root: string,
  behavior: "graceful" | "stubborn" | "graceful-replace-pid",
  replacementPid?: number,
  options: {
    expectedIdentityPathForTest?: string;
    onSpawnedPidForTest?: (pid: number) => void;
  } = {},
): Promise<ChildProcess> {
  const fixtureRoot = resolve(root);
  const marker = join(fixtureRoot, "data", "stop.request").replaceAll("'", "''");
  const pidPath = join(fixtureRoot, "data", "whitelily.pid").replaceAll("'", "''");
  const ownedEntry = join(fixtureRoot, "dist", "src", "index.js").replaceAll("'", "''");
  let body: string;
  if (behavior === "stubborn") {
    body = "while ($true) { Start-Sleep -Milliseconds 100 }";
  } else {
    const replacement =
      behavior === "graceful-replace-pid"
        ? `[System.IO.File]::WriteAllText('${pidPath}', '${replacementPid ?? 0}')`
        : "";
    body = `while (-not (Test-Path -LiteralPath '${marker}')) { Start-Sleep -Milliseconds 25 }; ${replacement}`;
  }
  const command = `$ownedEntry = '${ownedEntry}'; ${body}`;
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
    windowsHide: true,
    stdio: "ignore",
  });
  const close = createClosePromise(child);
  void close.catch(() => undefined);
  await new Promise<void>((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
  if (child.pid === undefined) throw new Error("owned fixture process did not expose a PID");
  options.onSpawnedPidForTest?.(child.pid);
  try {
    await waitForExpectedProcessIdentity(
      child.pid,
      options.expectedIdentityPathForTest ?? join(fixtureRoot, "dist", "src", "index.js"),
      "owned fixture process",
    );
  } catch (error) {
    try {
      await terminateOwnedChildTree(child, close);
    } catch (terminationError) {
      throw new AggregateError(
        [error, terminationError],
        "owned fixture process identity failed and cleanup did not settle",
      );
    }
    throw error;
  }
  return child;
}

async function runIdentityQuery(
  script: string,
  timeoutMilliseconds = processOperationTimeoutMilliseconds,
  label = "Windows process identity query",
): Promise<{ exitCode: number; stdout: string }> {
  const result = await runWindowsProcess({
    label,
    file: "powershell.exe",
    args: ["-NoProfile", "-Command", script],
    cwd: tmpdir(),
    timeoutMilliseconds,
  });
  return { exitCode: result.exitCode, stdout: result.stdout };
}

export async function queryWindowsProcessIdentity(
  pid: number,
): Promise<WindowsProcessIdentity | undefined> {
  return queryWindowsProcessIdentityWithTimeout(pid, processOperationTimeoutMilliseconds);
}

async function queryWindowsProcessIdentityWithTimeout(
  pid: number,
  timeoutMilliseconds: number,
): Promise<WindowsProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid process identity PID");
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
    "if ($null -eq $process) { exit 3 }",
    `$result = [pscustomobject]@{ pid = ${pid}; creationDate = ([datetime]$process.CreationDate).ToUniversalTime().Ticks.ToString(); commandLine = [string]$process.CommandLine }`,
    "$result | ConvertTo-Json -Compress",
  ].join("; ");
  const result = await runIdentityQuery(
    script,
    timeoutMilliseconds,
    `Windows process identity query for PID ${pid}`,
  );
  if (result.exitCode === 3) return undefined;
  if (result.exitCode !== 0) throw new Error("Windows process identity query failed");
  if (result.stdout.trim() === "") throw new Error("Windows process identity query was empty");
  return JSON.parse(result.stdout.trim()) as WindowsProcessIdentity;
}

async function waitForExpectedProcessIdentity(
  pid: number,
  expectedCommandPath: string,
  label: string,
  timeoutMilliseconds = processOperationTimeoutMilliseconds,
): Promise<WindowsProcessIdentity> {
  const expectedAliases = await commandPathAliases(expectedCommandPath);
  const deadline = performance.now() + timeoutMilliseconds;
  let lastIdentity: WindowsProcessIdentity | undefined;
  while (true) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 1_000) break;
    lastIdentity = await queryWindowsProcessIdentityWithTimeout(
      pid,
      Math.min(processOperationTimeoutMilliseconds, remaining - 250),
    );
    if (lastIdentity !== undefined) {
      const commandLine = lastIdentity.commandLine.replaceAll("\\", "/").toLocaleLowerCase();
      if ([...expectedAliases].some((expected) => commandLine.includes(expected))) {
        return lastIdentity;
      }
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  const observation =
    lastIdentity === undefined
      ? "the process was not observable"
      : "its command line did not identify the fixture entry";
  throw new Error(`${label} identity could not be established: ${observation}`);
}

async function findFixturePidsByCommandFragment(
  commandFragment: string,
  timeoutMilliseconds: number,
  label: string,
): Promise<number[]> {
  const expected = commandFragment.replaceAll("'", "''").replaceAll("\\", "/").toLocaleLowerCase();
  const script = [
    `$expected = '${expected}'`,
    "$ids = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {",
    "  if ($_.ProcessId -eq $PID) { return $false }",
    "  $command = ([string]$_.CommandLine).Replace('\\', '/').ToLowerInvariant()",
    "  $command.Contains($expected)",
    "} | ForEach-Object { [int]$_.ProcessId })",
    "ConvertTo-Json -InputObject $ids -Compress",
  ].join("; ");
  const result = await runIdentityQuery(script, timeoutMilliseconds, label);
  if (result.exitCode !== 0) throw new Error(`${label} failed`);
  const parsed = JSON.parse(result.stdout.trim() || "[]") as number | number[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function findFixtureServicePids(
  root: string,
  timeoutMilliseconds = processOperationTimeoutMilliseconds,
): Promise<number[]> {
  const entryPath = join(resolve(root), "dist", "src", "index.js")
    .replaceAll("\\", "/")
    .toLocaleLowerCase();
  return findFixturePidsByCommandFragment(entryPath, timeoutMilliseconds, "fixture service query");
}

export async function findFixtureCodexDelayPids(
  root: string,
  timeoutMilliseconds = processOperationTimeoutMilliseconds,
): Promise<number[]> {
  return findFixturePidsByCommandFragment(
    normalizeCommandPath(join(root, "command-shims", "codex-delay.ps1")),
    timeoutMilliseconds,
    "fixture delayed Codex process query",
  );
}

export function registerFixtureCleanupIdentityForTest(
  root: string,
  identity: FixtureCleanupIdentity,
): void {
  fixtureLifecycle(root).service = { ...identity };
}

export function clearFixtureCleanupIdentityForTest(root: string): void {
  const lifecycle = fixtureLifecycles.get(resolve(root));
  if (lifecycle !== undefined) delete lifecycle.service;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit(
  child: ChildProcess,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("fixture process did not exit")),
      timeoutMilliseconds,
    );
    child.once("close", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

export function killFixtureProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  child.kill();
}

async function terminateVerifiedProcessTree(
  registered: FixtureCleanupIdentity,
  timeoutMilliseconds = processOperationTimeoutMilliseconds,
): Promise<void> {
  if (!Number.isSafeInteger(registered.pid) || registered.pid <= 0) {
    throw new Error("invalid fixture service PID");
  }
  if (!/^\d+$/.test(registered.creationDate)) {
    throw new Error("invalid fixture service creation identity");
  }
  const expectedEntryPath = powerShellLiteral(normalizeCommandPath(registered.entryPath));
  const windowsRoot = powerShellLiteral(process.env.SystemRoot ?? "C:\\Windows");
  const waitMilliseconds = Math.max(1, Math.floor(timeoutMilliseconds - 500));
  const script = [
    `$expectedTicks = '${registered.creationDate}'`,
    `$expectedPath = '${expectedEntryPath}'`,
    `$taskkillPath = '${windowsRoot}\\System32\\taskkill.exe'`,
    "$ownedProcess = $null",
    "$resultCode = 0",
    "try {",
    "  try {",
    `    $ownedProcess = [System.Diagnostics.Process]::GetProcessById(${registered.pid})`,
    "    $null = $ownedProcess.Handle",
    "  } catch [System.ArgumentException] {",
    "    $resultCode = 3",
    "  } catch [System.InvalidOperationException] {",
    "    $resultCode = 3",
    "  }",
    "  if ($resultCode -eq 0) {",
    `    $current = Get-CimInstance Win32_Process -Filter "ProcessId = ${registered.pid}" -ErrorAction Stop`,
    "    if ($null -eq $current) {",
    "      $ownedProcess.Refresh()",
    "      if ($ownedProcess.HasExited) { $resultCode = 3 } else { $resultCode = 5 }",
    "    } else {",
    "      $currentTicks = ([datetime]$current.CreationDate).ToUniversalTime().Ticks.ToString()",
    "      $currentCommand = ([string]$current.CommandLine).Replace('\\', '/').ToLowerInvariant()",
    "      if ($currentTicks -ne $expectedTicks -or -not $currentCommand.Contains($expectedPath)) {",
    "        $resultCode = 4",
    "      } else {",
    `        & $taskkillPath /PID ${registered.pid} /T /F *> $null`,
    "        $taskkillCode = $LASTEXITCODE",
    "        $ownedProcess.Refresh()",
    "        if ($taskkillCode -ne 0 -and -not $ownedProcess.HasExited) {",
    "          $resultCode = 6",
    `        } elseif (-not $ownedProcess.WaitForExit(${waitMilliseconds})) {`,
    "          $resultCode = 7",
    "        }",
    "      }",
    "    }",
    "  }",
    "} catch {",
    "  $resultCode = 8",
    "} finally {",
    "  if ($null -ne $ownedProcess) { $ownedProcess.Dispose() }",
    "}",
    "exit $resultCode",
  ].join("\n");
  const result = await runIdentityQuery(
    script,
    timeoutMilliseconds,
    `verified fixture process-tree termination for PID ${registered.pid}`,
  );
  if (result.exitCode === 0 || result.exitCode === 3) return;
  if (result.exitCode === 4) {
    throw new Error("fixture service identity changed; refusing process termination");
  }
  throw new Error(
    `verified fixture process-tree termination failed for PID ${registered.pid} with exit code ${result.exitCode}`,
  );
}

function remainingCleanupMilliseconds(
  deadline: number,
  activity: string,
  cap = Number.POSITIVE_INFINITY,
): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) {
    throw new Error(`Windows fixture cleanup timed out while ${activity}`);
  }
  return Math.max(1, Math.min(remaining, cap));
}

async function cleanupWindowsFixtureInternal(
  fixtureRoot: string,
  lifecycle: FixtureLifecycle,
): Promise<void> {
  const deadline = performance.now() + cleanupTimeoutMilliseconds;
  lifecycle.closed = true;
  lifecycle.cleanupController.abort(new WindowsFixtureAbortError());
  while (lifecycle.activeOperations.size > 0) {
    const activeOperations = [...lifecycle.activeOperations];
    await withTimeout(
      Promise.all(activeOperations),
      remainingCleanupMilliseconds(deadline, "waiting for active operations"),
      "Windows fixture cleanup timed out while waiting for active operations",
    );
  }

  const registeredService = lifecycle.service;
  const shouldScanServices = registeredService !== undefined || lifecycle.needsServiceScan;
  if (registeredService !== undefined) {
    await terminateVerifiedProcessTree(
      registeredService,
      remainingCleanupMilliseconds(
        deadline,
        "terminating the registered service",
        processOperationTimeoutMilliseconds,
      ),
    );
    delete lifecycle.service;
  }

  if (shouldScanServices) {
    const entryPath = join(fixtureRoot, "dist", "src", "index.js");
    const servicePids = await findFixtureServicePids(
      fixtureRoot,
      remainingCleanupMilliseconds(
        deadline,
        "scanning fixture services",
        processOperationTimeoutMilliseconds,
      ),
    );
    for (const pid of servicePids) {
      const identity = await queryWindowsProcessIdentityWithTimeout(
        pid,
        remainingCleanupMilliseconds(
          deadline,
          `querying fixture service PID ${pid}`,
          processOperationTimeoutMilliseconds,
        ),
      );
      if (identity === undefined) continue;
      await terminateVerifiedProcessTree(
        {
          pid,
          creationDate: identity.creationDate,
          entryPath,
        },
        remainingCleanupMilliseconds(
          deadline,
          `terminating fixture service PID ${pid}`,
          processOperationTimeoutMilliseconds,
        ),
      );
    }

    let remainingServicePids = await findFixtureServicePids(
      fixtureRoot,
      remainingCleanupMilliseconds(
        deadline,
        "checking fixture service convergence",
        processOperationTimeoutMilliseconds,
      ),
    );
    while (remainingServicePids.length > 0) {
      remainingCleanupMilliseconds(deadline, "waiting for fixture service convergence");
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
      remainingServicePids = await findFixtureServicePids(
        fixtureRoot,
        remainingCleanupMilliseconds(
          deadline,
          "checking fixture service convergence",
          processOperationTimeoutMilliseconds,
        ),
      );
    }
    lifecycle.needsServiceScan = false;
  }
  remainingCleanupMilliseconds(deadline, "starting fixture directory removal");
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

export async function cleanupWindowsFixture(root: string): Promise<void> {
  let fixtureRoot: string;
  try {
    fixtureRoot = await realpath(resolve(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fixtureRoot = resolve(root);
  }
  const temporaryRoot = await realpath(resolve(tmpdir()));
  if (
    !fixtureRoot.startsWith(`${temporaryRoot}${sep}`) ||
    !basename(fixtureRoot).startsWith("whitelily-windows-script-")
  ) {
    throw new Error("refusing to remove an unvalidated Windows script fixture");
  }
  const lifecycle = fixtureLifecycle(fixtureRoot);
  if (lifecycle.cleanupPromise !== undefined) return lifecycle.cleanupPromise;
  let cleanup!: Promise<void>;
  cleanup = cleanupWindowsFixtureInternal(fixtureRoot, lifecycle).then(
    () => {
      if (fixtureLifecycles.get(fixtureRoot) === lifecycle) {
        fixtureLifecycles.delete(fixtureRoot);
      }
    },
    (error: unknown) => {
      if (
        fixtureLifecycles.get(fixtureRoot) === lifecycle &&
        lifecycle.cleanupPromise === cleanup
      ) {
        delete lifecycle.cleanupPromise;
      }
      throw error;
    },
  );
  lifecycle.cleanupPromise = cleanup;
  return cleanup;
}
