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
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class WhiteLilyWindowsCommandLine
{
    private const uint GenericRead = 0x80000000;
    private const uint FileShareRead = 0x00000001;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x00000080;
    private const uint FileAttributeDirectory = 0x00000010;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle file,
        StringBuilder filePath,
        uint filePathLength,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file,
        int informationClass,
        out FileAttributeTagInfo information,
        uint bufferSize);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo
    {
        internal uint FileAttributes;
        internal uint ReparseTag;
    }

    public static string[] Split(string commandLine)
    {
        if (String.IsNullOrWhiteSpace(commandLine)) return null;
        int argumentCount;
        IntPtr arguments = CommandLineToArgvW(commandLine, out argumentCount);
        if (arguments == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            if (argumentCount <= 0 || argumentCount > 4096) return null;
            string[] result = new string[argumentCount];
            for (int index = 0; index < argumentCount; index++)
            {
                IntPtr value = Marshal.ReadIntPtr(arguments, index * IntPtr.Size);
                result[index] = Marshal.PtrToStringUni(value);
            }
            return result;
        }
        finally
        {
            LocalFree(arguments);
        }
    }

    public static int CountTopLevelProperty(string json, string propertyName)
    {
        if (String.IsNullOrEmpty(json) || String.IsNullOrEmpty(propertyName)) return -1;
        int objectDepth = 0;
        int arrayDepth = 0;
        int count = 0;
        char previousSignificant = '\0';
        for (int index = 0; index < json.Length; index++)
        {
            char current = json[index];
            if (current == ' ' || current == '\t' || current == '\r' || current == '\n') continue;
            if (current == '"')
            {
                string value;
                if (!TryReadJsonString(json, ref index, out value)) return -1;
                if (objectDepth == 1 && arrayDepth == 0 &&
                    (previousSignificant == '{' || previousSignificant == ','))
                {
                    int colonIndex = index + 1;
                    while (colonIndex < json.Length &&
                           (json[colonIndex] == ' ' || json[colonIndex] == '\t' ||
                            json[colonIndex] == '\r' || json[colonIndex] == '\n'))
                    {
                        colonIndex++;
                    }
                    if (colonIndex >= json.Length || json[colonIndex] != ':') return -1;
                    if (String.Equals(value, propertyName, StringComparison.OrdinalIgnoreCase)) count++;
                }
                previousSignificant = '"';
                continue;
            }
            if (current == '{') objectDepth++;
            if (current == '}')
            {
                objectDepth--;
                if (objectDepth < 0) return -1;
                if (objectDepth == 0)
                {
                    if (arrayDepth != 0) return -1;
                    for (int trailing = index + 1; trailing < json.Length; trailing++)
                    {
                        char extra = json[trailing];
                        if (extra != ' ' && extra != '\t' && extra != '\r' && extra != '\n') return -1;
                    }
                    return count;
                }
            }
            if (current == '[') arrayDepth++;
            if (current == ']')
            {
                arrayDepth--;
                if (arrayDepth < 0) return -1;
            }
            previousSignificant = current;
        }
        return -1;
    }

    internal static string ReadBoundedUtf8FromHandle(SafeFileHandle file, long maximumBytes)
    {
        if (file == null || file.IsInvalid || file.IsClosed || maximumBytes <= 0) return null;
        FileStream stream = null;
        try
        {
            stream = new FileStream(file, FileAccess.Read, 4096, false);
            if (stream.Length <= 0 || stream.Length > maximumBytes) return null;
            using (StreamReader reader = new StreamReader(
                stream,
                new UTF8Encoding(false, true),
                false,
                4096,
                true))
            {
                string contents = reader.ReadToEnd();
                if (contents.Length > 0 && contents[0] == '\uFEFF')
                {
                    contents = contents.Substring(1);
                }
                return contents;
            }
        }
        catch
        {
            return null;
        }
        finally
        {
            if (stream != null) stream.Dispose();
            else file.Dispose();
        }
    }

    internal static SafeFileHandle OpenVerifiedOrdinaryFile(string path)
    {
        if (String.IsNullOrWhiteSpace(path)) return null;
        IntPtr rawHandle = CreateFile(
            path,
            GenericRead,
            FileShareRead,
            IntPtr.Zero,
            OpenExisting,
            FileAttributeNormal,
            IntPtr.Zero);
        if (rawHandle == InvalidHandleValue) return null;
        SafeFileHandle file = new SafeFileHandle(rawHandle, true);
        try
        {
            FileAttributeTagInfo attributes;
            if (!GetFileInformationByHandleEx(
                    file,
                    9,
                    out attributes,
                    (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo))) ||
                (attributes.FileAttributes & FileAttributeDirectory) != 0 ||
                (attributes.FileAttributes & FileAttributeReparsePoint) != 0 ||
                !HasExpectedFinalPath(file, path))
            {
                file.Dispose();
                return null;
            }
            return file;
        }
        catch
        {
            file.Dispose();
            return null;
        }
    }

    private static bool HasExpectedFinalPath(SafeFileHandle file, string requestedPath)
    {
        string expected = Path.GetFullPath(requestedPath);
        uint capacity = 512;
        while (capacity <= 32768)
        {
            StringBuilder path = new StringBuilder((int)capacity);
            uint length = GetFinalPathNameByHandle(file, path, capacity, 0);
            if (length == 0) return false;
            if (length < capacity)
            {
                string actual = path.ToString();
                const string devicePrefix = @"\\?\";
                if (actual.StartsWith(devicePrefix, StringComparison.Ordinal))
                {
                    actual = actual.Substring(devicePrefix.Length);
                }
                return String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);
            }
            capacity = length + 1;
        }
        return false;
    }

    private static bool TryReadJsonString(string json, ref int index, out string value)
    {
        StringBuilder builder = new StringBuilder();
        for (int cursor = index + 1; cursor < json.Length; cursor++)
        {
            char current = json[cursor];
            if (current == '"')
            {
                index = cursor;
                value = builder.ToString();
                return true;
            }
            if (current < 0x20)
            {
                value = null;
                return false;
            }
            if (current != '\\')
            {
                builder.Append(current);
                continue;
            }
            if (++cursor >= json.Length)
            {
                value = null;
                return false;
            }
            char escaped = json[cursor];
            switch (escaped)
            {
                case '"': builder.Append('"'); break;
                case '\\': builder.Append('\\'); break;
                case '/': builder.Append('/'); break;
                case 'b': builder.Append('\b'); break;
                case 'f': builder.Append('\f'); break;
                case 'n': builder.Append('\n'); break;
                case 'r': builder.Append('\r'); break;
                case 't': builder.Append('\t'); break;
                case 'u':
                    if (cursor + 4 >= json.Length)
                    {
                        value = null;
                        return false;
                    }
                    int codePoint = 0;
                    for (int offset = 1; offset <= 4; offset++)
                    {
                        int digit = HexValue(json[cursor + offset]);
                        if (digit < 0)
                        {
                            value = null;
                            return false;
                        }
                        codePoint = (codePoint << 4) | digit;
                    }
                    builder.Append((char)codePoint);
                    cursor += 4;
                    break;
                default:
                    value = null;
                    return false;
            }
        }
        value = null;
        return false;
    }

    private static int HexValue(char value)
    {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        if (value >= 'A' && value <= 'F') return value - 'A' + 10;
        return -1;
    }
}

public sealed class WhiteLilyVersionEvidence : IDisposable
{
    private SafeFileHandle versionJar;
    private SafeFileHandle metadata;
    private readonly long maximumMetadataBytes;
    private bool metadataRead;
    private bool disposed;

    private WhiteLilyVersionEvidence(
        SafeFileHandle versionJar,
        SafeFileHandle metadata,
        long maximumMetadataBytes)
    {
        this.versionJar = versionJar;
        this.metadata = metadata;
        this.maximumMetadataBytes = maximumMetadataBytes;
    }

    public static WhiteLilyVersionEvidence Open(
        string versionJarPath,
        string metadataPath,
        long maximumMetadataBytes)
    {
        if (maximumMetadataBytes <= 0) return null;
        SafeFileHandle versionJar = WhiteLilyWindowsCommandLine.OpenVerifiedOrdinaryFile(versionJarPath);
        if (versionJar == null) return null;
        SafeFileHandle metadata = WhiteLilyWindowsCommandLine.OpenVerifiedOrdinaryFile(metadataPath);
        if (metadata == null)
        {
            versionJar.Dispose();
            return null;
        }
        return new WhiteLilyVersionEvidence(versionJar, metadata, maximumMetadataBytes);
    }

    public string ReadMetadataUtf8()
    {
        if (disposed || metadataRead) return null;
        metadataRead = true;
        return WhiteLilyWindowsCommandLine.ReadBoundedUtf8FromHandle(
            metadata,
            maximumMetadataBytes);
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        if (metadata != null) metadata.Dispose();
        if (versionJar != null) versionJar.Dispose();
    }
}
'@

function Test-WhiteLilySafeDrivePath {
  param([string] $PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue) -or $PathValue.Length -gt 1024) { return $false }
  if ($PathValue -notmatch '\A[A-Za-z]:[\\/]' -or $PathValue -match '[\x00-\x1f\x7f]') { return $false }
  if ($PathValue.StartsWith('\\') -or $PathValue.StartsWith('\\?\')) { return $false }
  try {
    $fullPath = [IO.Path]::GetFullPath($PathValue)
    return $fullPath -eq $PathValue -or $fullPath -eq $PathValue.Replace('/', '\')
  } catch {
    return $false
  }
}

function Test-WhiteLilySafeInstanceId {
  param([string] $InstanceId)
  if (
    [string]::IsNullOrWhiteSpace($InstanceId) -or
    $InstanceId.Length -gt 128 -or
    $InstanceId -eq '.' -or
    $InstanceId -eq '..' -or
    $InstanceId.EndsWith('.') -or
    $InstanceId.EndsWith(' ') -or
    $InstanceId -match '[<>:"/\\|?*\x00-\x1f\x7f]'
  ) {
    return $false
  }
  try {
    if ([IO.Path]::GetFileName($InstanceId) -cne $InstanceId) { return $false }
  } catch {
    return $false
  }
  $baseName = $InstanceId.Split('.')[0]
  if ($baseName -match '\A(?i:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])\z') { return $false }
  for ($index = 0; $index -lt $InstanceId.Length; $index += 1) {
    $character = $InstanceId[$index]
    if ([char]::IsHighSurrogate($character)) {
      if ($index + 1 -ge $InstanceId.Length -or -not [char]::IsLowSurrogate($InstanceId[$index + 1])) {
        return $false
      }
      $index += 1
    } elseif ([char]::IsLowSurrogate($character)) {
      return $false
    }
  }
  return $true
}

function Get-WhiteLilyMinecraftVersion {
  param([string] $CommandLine)
  if ([string]::IsNullOrWhiteSpace($CommandLine) -or $CommandLine.Length -gt 131072) { return $null }
  try {
    $tokens = [WhiteLilyWindowsCommandLine]::Split($CommandLine)
  } catch {
    return $null
  }
  if ($null -eq $tokens -or $tokens.Count -eq 0) { return $null }

  $versionIndexes = [System.Collections.Generic.List[int]]::new()
  $classPathIndexes = [System.Collections.Generic.List[int]]::new()
  for ($index = 0; $index -lt $tokens.Count; $index += 1) {
    if ($tokens[$index] -ceq '--version') { $versionIndexes.Add($index) }
    if ($tokens[$index] -ceq '-cp' -or $tokens[$index] -ceq '-classpath' -or $tokens[$index] -ceq '--class-path') {
      $classPathIndexes.Add($index)
    }
  }

  if ($versionIndexes.Count -ne 1 -or $classPathIndexes.Count -ne 1) { return $null }
  $versionIndex = $versionIndexes[0]
  $classPathIndex = $classPathIndexes[0]
  if ($versionIndex + 1 -ge $tokens.Count -or $classPathIndex + 1 -ge $tokens.Count) { return $null }
  $instanceId = [string]$tokens[$versionIndex + 1]
  if (-not (Test-WhiteLilySafeInstanceId -InstanceId $instanceId)) { return $null }

  $matchingVersionJars = [System.Collections.Generic.List[string]]::new()
  $expectedSuffix = "\versions\$instanceId\$instanceId.jar"
  foreach ($entry in ([string]$tokens[$classPathIndex + 1]).Split([IO.Path]::PathSeparator)) {
    if (-not (Test-WhiteLilySafeDrivePath -PathValue $entry)) { continue }
    $fullEntry = [IO.Path]::GetFullPath($entry).Replace('/', '\')
    if ($fullEntry.EndsWith($expectedSuffix, [StringComparison]::OrdinalIgnoreCase)) {
      $matchingVersionJars.Add($fullEntry)
    }
  }
  if ($matchingVersionJars.Count -ne 1) { return $null }

  $versionJarPath = $matchingVersionJars[0]
  $metadataPath = [IO.Path]::ChangeExtension($versionJarPath, '.json')
  $versionEvidence = [WhiteLilyVersionEvidence]::Open($versionJarPath, $metadataPath, 1048576)
  if ($null -eq $versionEvidence) { return $null }
  try {
    $metadataJson = $versionEvidence.ReadMetadataUtf8()
    if ($null -eq $metadataJson) { return $null }
    if (
      [WhiteLilyWindowsCommandLine]::CountTopLevelProperty($metadataJson, 'id') -ne 1 -or
      [WhiteLilyWindowsCommandLine]::CountTopLevelProperty($metadataJson, 'clientVersion') -gt 1
    ) {
      return $null
    }
    $metadata = $metadataJson | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  } finally {
    $versionEvidence.Dispose()
  }
  if ($null -eq $metadata -or $metadata -is [Array]) { return $null }
  $metadataPropertyNames = @($metadata.PSObject.Properties | ForEach-Object { $_.Name })
  $idPropertyCount = @($metadataPropertyNames | Where-Object { $_ -ceq 'id' }).Count
  $clientVersionPropertyCount = @($metadataPropertyNames | Where-Object { $_ -ceq 'clientVersion' }).Count
  if (
    $idPropertyCount -ne 1 -or
    $clientVersionPropertyCount -gt 1 -or
    -not ($metadata.id -is [string]) -or
    $metadata.id -cne $instanceId
  ) {
    return $null
  }
  if ($clientVersionPropertyCount -eq 1) {
    if (-not ($metadata.clientVersion -is [string]) -or $metadata.clientVersion -cne '1.21.5') {
      return $null
    }
  } elseif ($instanceId -cne '1.21.5') {
    return $null
  }
  return '1.21.5'
}

$records = [System.Collections.Generic.List[object]]::new()
$listeners = @(Get-NetTCPConnection -State Listen)
$processes = @{}
foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'java.exe' OR Name = 'javaw.exe'")) {
  $pidValue = [int64]$process.ProcessId
  if ($pidValue -le 0) { continue }
  $processName = [string]$process.Name
  $startedAt = ([DateTimeOffset]$process.CreationDate).ToUnixTimeMilliseconds()
  if ($startedAt -le 0) { continue }
  $commandLine = [string]$process.CommandLine
  $safeVersion = Get-WhiteLilyMinecraftVersion -CommandLine $commandLine
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
