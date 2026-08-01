import { execFile as nodeExecFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { win32 } from "node:path";

export const PCL2_EXECUTABLE_NAME = "Plain Craft Launcher 2.exe";
export const FIXED_PROBE_TIMEOUT_MS = 5_000;
export const FIXED_PROBE_MAX_BUFFER_BYTES = 1_048_576;
export const FIXED_PROBE_MAX_RECORDS = 256;
export const TRUSTED_WINDOWS_SYSTEM_ROOT_ANCHOR = String.raw`\\?\GLOBALROOT\SystemRoot`;
export const WINDOWS_POWERSHELL_RELATIVE_PATH = String.raw`System32\WindowsPowerShell\v1.0\powershell.exe`;
export const TRUSTED_WINDOWS_POWERSHELL_ANCHOR = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;

export type Pcl2CandidateSource = "known_location" | "start_menu" | "running_process";

export interface Pcl2ProbeRecord {
  readonly path: string;
  readonly source: Pcl2CandidateSource;
  readonly running: boolean;
}

export type Pcl2ProbeDiagnosticCode =
  "ACCESS_DENIED" | "INVALID_OUTPUT" | "OUTPUT_LIMIT" | "PROBE_FAILED" | "TIMED_OUT";

export interface FixedPcl2ProbeResult {
  readonly records: readonly Pcl2ProbeRecord[];
  readonly diagnostic: { readonly code: Pcl2ProbeDiagnosticCode } | null;
}

export interface JavaListenerProbeRecord {
  readonly localAddress: string;
  readonly localPort: number;
  readonly pid: number;
  readonly processName: "java.exe" | "javaw.exe";
  readonly processStartedAt: number;
  readonly version: string | null;
}

export interface FixedJavaListenerProbeResult {
  readonly records: readonly JavaListenerProbeRecord[];
  readonly diagnostic: { readonly code: Pcl2ProbeDiagnosticCode } | null;
}

export interface FixedExecFileOptions {
  readonly encoding: "utf8";
  readonly maxBuffer: number;
  readonly shell: false;
  readonly timeout: number;
  readonly windowsHide: true;
}

export interface ExecFileError extends Error {
  readonly code?: string | number;
  readonly killed?: boolean;
}

export type ExecFilePort = (
  file: string,
  args: string[],
  options: FixedExecFileOptions,
  callback: (error: ExecFileError | null, stdout: string, stderr: string) => void,
) => unknown;

export interface TrustedPowerShellResolutionOptions {
  readonly getSystemRoot?: () => string | undefined;
  readonly canonicalize?: (path: string) => Promise<string>;
  readonly statPath?: (path: string) => Promise<TrustedWindowsStat>;
}

export interface TrustedWindowsStat {
  readonly dev: bigint;
  readonly ino: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
}

export const FIXED_UTF8_POWERSHELL_PREAMBLE = String.raw`$WhiteLilyUtf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $WhiteLilyUtf8NoBom
$OutputEncoding = $WhiteLilyUtf8NoBom`;

export const FIXED_PCL2_PROBE_SCRIPT = `${FIXED_UTF8_POWERSHELL_PREAMBLE}
${String.raw`
$ErrorActionPreference = 'Stop'
$records = [System.Collections.Generic.List[object]]::new()
function Add-WhiteLilyPcl2Candidate {
  param(
    [string] $CandidatePath,
    [ValidateSet('known_location', 'start_menu', 'running_process')]
    [string] $Source,
    [bool] $Running
  )
  if ([string]::IsNullOrWhiteSpace($CandidatePath)) { return }
  $records.Add([pscustomobject]@{
    path = $CandidatePath
    source = $Source
    running = $Running
  })
}

$knownPaths = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Plain Craft Launcher 2\Plain Craft Launcher 2.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\PCL2\Plain Craft Launcher 2.exe'),
  (Join-Path $env:APPDATA 'Plain Craft Launcher 2\Plain Craft Launcher 2.exe')
)
foreach ($knownPath in $knownPaths) {
  if (Test-Path -LiteralPath $knownPath -PathType Leaf) {
    Add-WhiteLilyPcl2Candidate -CandidatePath ([IO.Path]::GetFullPath($knownPath)) -Source 'known_location' -Running $false
  }
}

$shortcutRoots = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
)
$shortcutShell = New-Object -ComObject WScript.Shell
foreach ($shortcutRoot in $shortcutRoots) {
  if (-not (Test-Path -LiteralPath $shortcutRoot -PathType Container)) { continue }
  foreach ($shortcut in Get-ChildItem -LiteralPath $shortcutRoot -Filter '*.lnk' -File -Recurse) {
    $targetPath = $shortcutShell.CreateShortcut($shortcut.FullName).TargetPath
    if ([IO.Path]::GetFileName($targetPath) -ieq 'Plain Craft Launcher 2.exe') {
      Add-WhiteLilyPcl2Candidate -CandidatePath ([IO.Path]::GetFullPath($targetPath)) -Source 'start_menu' -Running $false
    }
  }
}

foreach ($process in Get-CimInstance Win32_Process -Filter "Name = 'Plain Craft Launcher 2.exe'") {
  if (-not [string]::IsNullOrWhiteSpace($process.ExecutablePath)) {
    Add-WhiteLilyPcl2Candidate -CandidatePath ([IO.Path]::GetFullPath($process.ExecutablePath)) -Source 'running_process' -Running $true
  }
}

$payload = @($records | ForEach-Object { $_ })
ConvertTo-Json -InputObject $payload -Compress -Depth 3
`.trim()}`;

export const FIXED_JAVA_LISTENER_PROBE_SCRIPT = `${FIXED_UTF8_POWERSHELL_PREAMBLE}
${String.raw`
$ErrorActionPreference = 'Stop'
$records = [System.Collections.Generic.List[object]]::new()
$listeners = @(Get-NetTCPConnection -State Listen)
$processes = @{}
foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'java.exe' OR Name = 'javaw.exe'")) {
  $pidValue = [int64]$process.ProcessId
  if ($pidValue -le 0) { continue }
  $processName = [string]$process.Name
  $startedAt = ([DateTimeOffset]$process.CreationDate).ToUnixTimeMilliseconds()
  if ($startedAt -le 0) { continue }
  $safeVersion = $null
  $commandLine = [string]$process.CommandLine
  if ($commandLine -match '(?i)[\\/]versions[\\/]1\.21\.5[\\/]') {
    $safeVersion = '1.21.5'
  }
  $processes[$pidValue] = [pscustomobject]@{
    processName = $processName.ToLowerInvariant()
    processStartedAt = $startedAt
    version = $safeVersion
  }
}
foreach ($listener in $listeners) {
  $pidValue = [int64]$listener.OwningProcess
  $metadata = $processes[$pidValue]
  if ($null -eq $metadata) { continue }
  $records.Add([pscustomobject]@{
    localAddress = [string]$listener.LocalAddress
    localPort = [int]$listener.LocalPort
    pid = $pidValue
    processName = $metadata.processName
    processStartedAt = $metadata.processStartedAt
    version = $metadata.version
  })
}
$payload = @($records | ForEach-Object { $_ })
ConvertTo-Json -InputObject $payload -Compress -Depth 3
`.trim()}`;

function fixedPowerShellArgs(script: string): readonly string[] {
  return Object.freeze([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
}

const FIXED_POWERSHELL_ARGS = fixedPowerShellArgs(FIXED_PCL2_PROBE_SCRIPT);

export async function resolveTrustedWindowsPowerShell(
  options: TrustedPowerShellResolutionOptions = {},
): Promise<string | null> {
  const systemRoot = options.getSystemRoot ? options.getSystemRoot() : process.env.SystemRoot;
  const canonicalize = options.canonicalize ?? ((path: string) => realpath(path));
  const statPath =
    options.statPath ??
    ((path: string) => stat(path, { bigint: true }) as unknown as Promise<TrustedWindowsStat>);
  if (!systemRoot || !isSafeDriveAbsolutePath(systemRoot)) return null;
  try {
    const canonicalSystemRoot = win32.normalize(await canonicalize(systemRoot));
    if (!isSafeDriveAbsolutePath(canonicalSystemRoot)) return null;
    const [anchorRootStat, candidateRootStat] = await Promise.all([
      statPath(TRUSTED_WINDOWS_SYSTEM_ROOT_ANCHOR),
      statPath(canonicalSystemRoot),
    ]);
    if (
      !anchorRootStat.isDirectory() ||
      !candidateRootStat.isDirectory() ||
      !sameNonzeroWindowsIdentity(anchorRootStat, candidateRootStat)
    ) {
      return null;
    }

    const expectedPowerShell = win32.join(canonicalSystemRoot, WINDOWS_POWERSHELL_RELATIVE_PATH);
    const canonicalPowerShell = win32.normalize(await canonicalize(expectedPowerShell));
    if (
      !isSafeDriveAbsolutePath(canonicalPowerShell) ||
      !sameDrivePath(canonicalPowerShell, expectedPowerShell)
    ) {
      return null;
    }
    const [anchorPowerShellStat, candidatePowerShellStat] = await Promise.all([
      statPath(TRUSTED_WINDOWS_POWERSHELL_ANCHOR),
      statPath(canonicalPowerShell),
    ]);
    if (
      !anchorPowerShellStat.isFile() ||
      !candidatePowerShellStat.isFile() ||
      !sameNonzeroWindowsIdentity(anchorPowerShellStat, candidatePowerShellStat)
    ) {
      return null;
    }
    return canonicalPowerShell;
  } catch {
    return null;
  }
}

export function runFixedPcl2Probe(
  options: {
    readonly execFile?: ExecFilePort;
    readonly resolvePowerShellPath?: () => Promise<string | null>;
  } = {},
): Promise<FixedPcl2ProbeResult> {
  const execFile = options.execFile ?? (nodeExecFile as unknown as ExecFilePort);
  const resolvePowerShellPath = options.resolvePowerShellPath ?? resolveTrustedWindowsPowerShell;
  return resolvePowerShellPath().then((powershellPath) => {
    if (!powershellPath || !isResolvedPowerShellPath(powershellPath)) {
      return {
        records: [],
        diagnostic: { code: "PROBE_FAILED" },
      } satisfies FixedPcl2ProbeResult;
    }
    return new Promise<FixedPcl2ProbeResult>((resolve) => {
      const handleResult = (error: ExecFileError | null, stdout: string, stderr: string): void => {
        if (error) {
          resolve({
            records: [],
            diagnostic: { code: classifyProbeError(error, stderr) },
          });
          return;
        }
        if (
          Buffer.byteLength(stdout, "utf8") > FIXED_PROBE_MAX_BUFFER_BYTES ||
          Buffer.byteLength(stderr, "utf8") > FIXED_PROBE_MAX_BUFFER_BYTES
        ) {
          resolve({ records: [], diagnostic: { code: "OUTPUT_LIMIT" } });
          return;
        }
        const records = parseProbeRecords(stdout);
        resolve(
          records
            ? { records, diagnostic: null }
            : { records: [], diagnostic: { code: "INVALID_OUTPUT" } },
        );
      };
      try {
        execFile(
          powershellPath,
          [...FIXED_POWERSHELL_ARGS],
          {
            encoding: "utf8",
            maxBuffer: FIXED_PROBE_MAX_BUFFER_BYTES,
            shell: false,
            timeout: FIXED_PROBE_TIMEOUT_MS,
            windowsHide: true,
          },
          handleResult,
        );
      } catch {
        resolve({ records: [], diagnostic: { code: "PROBE_FAILED" } });
      }
    });
  });
}

export function runFixedJavaListenerProbe(
  options: {
    readonly execFile?: ExecFilePort;
    readonly resolvePowerShellPath?: () => Promise<string | null>;
  } = {},
): Promise<FixedJavaListenerProbeResult> {
  const execFile = options.execFile ?? (nodeExecFile as unknown as ExecFilePort);
  const resolvePowerShellPath = options.resolvePowerShellPath ?? resolveTrustedWindowsPowerShell;
  return resolvePowerShellPath().then((powershellPath) => {
    if (!powershellPath || !isResolvedPowerShellPath(powershellPath)) {
      return {
        records: [],
        diagnostic: { code: "PROBE_FAILED" },
      } satisfies FixedJavaListenerProbeResult;
    }
    return new Promise<FixedJavaListenerProbeResult>((resolve) => {
      const handleResult = (error: ExecFileError | null, stdout: string, stderr: string): void => {
        if (error) {
          resolve({
            records: [],
            diagnostic: { code: classifyProbeError(error, stderr) },
          });
          return;
        }
        if (
          Buffer.byteLength(stdout, "utf8") > FIXED_PROBE_MAX_BUFFER_BYTES ||
          Buffer.byteLength(stderr, "utf8") > FIXED_PROBE_MAX_BUFFER_BYTES
        ) {
          resolve({ records: [], diagnostic: { code: "OUTPUT_LIMIT" } });
          return;
        }
        const records = parseJavaListenerRecords(stdout);
        resolve(
          records
            ? { records, diagnostic: null }
            : { records: [], diagnostic: { code: "INVALID_OUTPUT" } },
        );
      };
      try {
        execFile(
          powershellPath,
          [...fixedPowerShellArgs(FIXED_JAVA_LISTENER_PROBE_SCRIPT)],
          {
            encoding: "utf8",
            maxBuffer: FIXED_PROBE_MAX_BUFFER_BYTES,
            shell: false,
            timeout: FIXED_PROBE_TIMEOUT_MS,
            windowsHide: true,
          },
          handleResult,
        );
      } catch {
        resolve({ records: [], diagnostic: { code: "PROBE_FAILED" } });
      }
    });
  });
}

function isSafeDriveAbsolutePath(value: string): boolean {
  return (
    /^[A-Za-z]:\\/u.test(value) &&
    win32.isAbsolute(value) &&
    !value.startsWith(String.raw`\\`) &&
    value.isWellFormed() &&
    [...value].length <= 1_024 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function sameDrivePath(value: string, expected: string): boolean {
  return (
    isSafeDriveAbsolutePath(value) &&
    isSafeDriveAbsolutePath(expected) &&
    win32.normalize(value).toLocaleLowerCase("en-US") ===
      win32.normalize(expected).toLocaleLowerCase("en-US")
  );
}

function sameNonzeroWindowsIdentity(
  left: Pick<TrustedWindowsStat, "dev" | "ino">,
  right: Pick<TrustedWindowsStat, "dev" | "ino">,
): boolean {
  return (
    left.dev !== 0n &&
    left.ino !== 0n &&
    right.dev !== 0n &&
    right.ino !== 0n &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function isResolvedPowerShellPath(value: string): boolean {
  if (!isSafeDriveAbsolutePath(value)) return false;
  const normalized = win32.normalize(value).toLocaleLowerCase("en-US");
  return normalized.endsWith(`\\${WINDOWS_POWERSHELL_RELATIVE_PATH}`.toLocaleLowerCase("en-US"));
}

function classifyProbeError(error: ExecFileError, stderr: string): Pcl2ProbeDiagnosticCode {
  const code = typeof error.code === "string" ? error.code.toUpperCase() : "";
  if (code === "EACCES" || code === "EPERM") return "ACCESS_DENIED";
  if (
    /access\s+is\s+denied|unauthorizedaccessexception|拒绝访问|存取被拒/i.test(
      `${error.message}\n${stderr}`,
    )
  ) {
    return "ACCESS_DENIED";
  }
  if (/maxbuffer/i.test(error.message)) return "OUTPUT_LIMIT";
  if (code === "ETIMEDOUT" || error.killed) {
    return "TIMED_OUT";
  }
  return "PROBE_FAILED";
}

function parseProbeRecords(stdout: string): readonly Pcl2ProbeRecord[] | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim() || "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length > FIXED_PROBE_MAX_RECORDS) return null;
  const records: Pcl2ProbeRecord[] = [];
  for (const item of value) {
    if (!isProbeRecord(item)) return null;
    records.push(Object.freeze(item));
  }
  return Object.freeze(records);
}

function isProbeRecord(value: unknown): value is Pcl2ProbeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "path,running,source" ||
    typeof record.path !== "string" ||
    typeof record.running !== "boolean" ||
    !isCandidateSource(record.source)
  ) {
    return false;
  }
  if (
    record.path.length === 0 ||
    [...record.path].length > 1_024 ||
    !record.path.isWellFormed() ||
    /[\u0000-\u001f\u007f]/u.test(record.path) ||
    !/^[A-Za-z]:\\/u.test(record.path) ||
    !win32.isAbsolute(record.path)
  ) {
    return false;
  }
  return true;
}

function isCandidateSource(value: unknown): value is Pcl2CandidateSource {
  return value === "known_location" || value === "start_menu" || value === "running_process";
}

function parseJavaListenerRecords(stdout: string): readonly JavaListenerProbeRecord[] | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim() || "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length > FIXED_PROBE_MAX_RECORDS) return null;
  const records: JavaListenerProbeRecord[] = [];
  for (const item of value) {
    if (!isJavaListenerProbeRecord(item)) return null;
    records.push(Object.freeze(item));
  }
  return Object.freeze(records);
}

function isJavaListenerProbeRecord(value: unknown): value is JavaListenerProbeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "localAddress,localPort,pid,processName,processStartedAt,version" ||
    typeof record.localAddress !== "string" ||
    !record.localAddress.isWellFormed() ||
    record.localAddress.length === 0 ||
    [...record.localAddress].length > 64 ||
    /[\u0000-\u001f\u007f]/u.test(record.localAddress) ||
    !Number.isSafeInteger(record.localPort) ||
    (record.localPort as number) < 1 ||
    (record.localPort as number) > 65_535 ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) < 1 ||
    !Number.isSafeInteger(record.processStartedAt) ||
    (record.processStartedAt as number) < 1 ||
    !(record.processName === "java.exe" || record.processName === "javaw.exe") ||
    !(record.version === null || record.version === "1.21.5")
  ) {
    return false;
  }
  return true;
}
