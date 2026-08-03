[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [string]$BaselineInstallerPath,

    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $stream = [System.IO.File]::OpenRead($LiteralPath)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Resolve-FullPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BasePath
    )
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

function ConvertTo-XmlEscapedText {
    param([Parameter(Mandatory = $true)][string]$Value)
    return [System.Security.SecurityElement]::Escape($Value)
}

function Test-SandboxRemoteSessionIdentity {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Current,
        [Parameter(Mandatory = $true)][string]$ConfigurationPath
    )

    if ($null -eq $Expected -or $null -eq $Current) {
        return $false
    }
    if ([uint32]$Expected.ProcessId -ne [uint32]$Current.ProcessId) {
        return $false
    }
    if (
        -not [StringComparer]::OrdinalIgnoreCase.Equals(
            [string]$Expected.Name,
            [string]$Current.Name
        ) -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals(
            [string]$Current.Name,
            'WindowsSandboxRemoteSession.exe'
        )
    ) {
        return $false
    }
    if (-not [object]::Equals($Expected.CreationDate, $Current.CreationDate)) {
        return $false
    }

    $expectedExecutable = [string]$Expected.ExecutablePath
    $currentExecutable = [string]$Current.ExecutablePath
    if (
        [string]::IsNullOrWhiteSpace($expectedExecutable) -or
        [string]::IsNullOrWhiteSpace($currentExecutable) -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals($expectedExecutable, $currentExecutable)
    ) {
        return $false
    }

    $expectedCommandLine = [string]$Expected.CommandLine
    $currentCommandLine = [string]$Current.CommandLine
    if (
        [string]::IsNullOrWhiteSpace($expectedCommandLine) -or
        [string]::IsNullOrWhiteSpace($currentCommandLine) -or
        -not [StringComparer]::Ordinal.Equals($expectedCommandLine, $currentCommandLine) -or
        $currentCommandLine.IndexOf(
            $ConfigurationPath,
            [StringComparison]::OrdinalIgnoreCase
        ) -lt 0
    ) {
        return $false
    }

    return $true
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedInstaller = Resolve-FullPath $InstallerPath (Get-Location).Path
if (-not (Test-Path -LiteralPath $resolvedInstaller -PathType Leaf)) {
    throw 'INSTALLER_NAME_OR_PATH_INVALID'
}
$installerName = [System.IO.Path]::GetFileName($resolvedInstaller)
$prereleaseIdentifier = '(?:(?:0|[1-9][0-9]*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))'
$nameMatch = [regex]::Match(
    $installerName,
    "^WhiteLily-(?<version>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-$prereleaseIdentifier(?:\.$prereleaseIdentifier)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)-windows-x64-setup\.exe$"
)
if (-not $nameMatch.Success) {
    throw 'INSTALLER_NAME_OR_PATH_INVALID'
}
$version = $nameMatch.Groups['version'].Value
$baselineVersion = '0.2.0-beta.1'
$installerDirectory = [System.IO.Path]::GetFullPath((Split-Path -Parent $resolvedInstaller))
$expectedBaselineInstaller = [System.IO.Path]::GetFullPath(
    (Join-Path $installerDirectory "WhiteLily-$baselineVersion-windows-x64-setup.exe")
)
$resolvedBaselineInstaller = if ([string]::IsNullOrWhiteSpace($BaselineInstallerPath)) {
    $expectedBaselineInstaller
} else {
    Resolve-FullPath $BaselineInstallerPath $repositoryRoot
}
if (
    -not [StringComparer]::OrdinalIgnoreCase.Equals(
        $resolvedBaselineInstaller,
        $expectedBaselineInstaller
    ) -or
    -not (Test-Path -LiteralPath $resolvedBaselineInstaller -PathType Leaf)
) {
    throw 'BETA1_BASELINE_INSTALLER_REQUIRED'
}
$baselineInstallerHash = Get-Sha256Hex $resolvedBaselineInstaller
$candidateInstallerHash = Get-Sha256Hex $resolvedInstaller
if (
    [StringComparer]::Ordinal.Equals($version, $baselineVersion) -or
    [StringComparer]::Ordinal.Equals($candidateInstallerHash, $baselineInstallerHash)
) {
    throw 'BETA1_UPGRADE_TARGET_REQUIRED'
}

$inspectionOutput = @(
    & (Join-Path $PSScriptRoot 'inspect-installer.ps1') `
        -InstallerPath $resolvedInstaller `
        -ExpectedVersion $version
)
if ($LASTEXITCODE -ne 0 -or $inspectionOutput.Count -ne 1) {
    throw 'INSTALLER_INSPECTION_FAILED'
}
$inspection = [string]$inspectionOutput[0] | ConvertFrom-Json
$installerHash = [string]$inspection.sha256
if (-not [StringComparer]::Ordinal.Equals($installerHash, $candidateInstallerHash)) {
    throw 'INSTALLER_HASH_CHANGED_DURING_INSPECTION'
}

if ($env:WHITELILY_FORCE_SANDBOX_UNAVAILABLE -eq '1') {
    throw 'WINDOWS_SANDBOX_REQUIRED'
}
$windowsDirectory = if ([string]::IsNullOrWhiteSpace($env:WINDIR)) {
    $env:SystemRoot
} else {
    $env:WINDIR
}
$sandboxExecutable = if ([string]::IsNullOrWhiteSpace($windowsDirectory)) {
    $null
} else {
    Join-Path $windowsDirectory 'System32/WindowsSandbox.exe'
}
if (
    [string]::IsNullOrWhiteSpace($sandboxExecutable) -or
    -not (Test-Path -LiteralPath $sandboxExecutable -PathType Leaf)
) {
    throw 'WINDOWS_SANDBOX_REQUIRED'
}

$expectedReport = [System.IO.Path]::GetFullPath(
    (Join-Path $installerDirectory "WhiteLily-$version-windows-x64-installer-lifecycle.json")
)
$resolvedReport = if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $expectedReport
} else {
    Resolve-FullPath $ReportPath $repositoryRoot
}
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($resolvedReport, $expectedReport)) {
    throw 'UNSAFE_LIFECYCLE_REPORT_PATH'
}

$buildRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'build'))
$sandboxRoot = Join-Path $buildRoot ('installer-sandbox-' + [Guid]::NewGuid().ToString('N'))
$sandboxPrefix = $buildRoot.TrimEnd('\') + '\'
if (-not $sandboxRoot.StartsWith($sandboxPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'UNSAFE_SANDBOX_ROOT'
}
$reportRoot = Join-Path $sandboxRoot 'report'
$guestScriptPath = Join-Path $reportRoot 'guest-lifecycle.ps1'
$sandboxResultPath = Join-Path $reportRoot 'sandbox-result.json'
$sandboxConfigurationPath = Join-Path $sandboxRoot 'WhiteLily-installer-lifecycle.wsb'
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null

$guestScript = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerName,
    [Parameter(Mandatory = $true)][string]$InstallerSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][string]$BaselineInstallerName,
    [Parameter(Mandatory = $true)][string]$BaselineInstallerSha256,
    [Parameter(Mandatory = $true)][string]$BaselineVersion
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$resultPath = 'C:\WhiteLilyReport\sandbox-result.json'
$result = [ordered]@{
    schemaVersion = 1
    installerSha256 = $InstallerSha256
    expectedVersion = $ExpectedVersion
    baselineInstallerSha256 = $BaselineInstallerSha256
    installedVersion = $null
    managedWorkspaceResources = 0
    success = $false
    stages = [Collections.Generic.List[string]]::new()
    error = $null
}
function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $stream = [System.IO.File]::OpenRead($LiteralPath)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}
function Invoke-Process {
    param([Parameter(Mandatory = $true)][string]$Path, [string[]]$Arguments = @())
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "process failed with exit code $($process.ExitCode): $Path"
    }
}
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WhiteLilySmokeWindows {
    public delegate bool EnumWindowsProc(IntPtr window, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr window);

    public static string[] Titles(uint expectedProcessId) {
        var titles = new List<string>();
        EnumWindows((window, state) => {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId != expectedProcessId || !IsWindowVisible(window)) return true;
            var length = GetWindowTextLength(window);
            if (length <= 0) return true;
            var title = new StringBuilder(length + 1);
            GetWindowText(window, title, title.Capacity);
            if (title.Length > 0) titles.Add(title.ToString());
            return true;
        }, IntPtr.Zero);
        return titles.ToArray();
    }
}
"@
function Wait-WhiteLilyMainWindow {
    param(
        [Parameter(Mandatory = $true)]$Process,
        [int]$TimeoutMilliseconds = 30000
    )
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $stableWhiteLilyObservations = 0
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) {
            throw "installer smoke application exited before opening its main window: $($Process.ExitCode)"
        }
        $hasWhiteLilyWindow = $false
        foreach ($title in @([WhiteLilySmokeWindows]::Titles([uint32]$Process.Id))) {
            if ([StringComparer]::OrdinalIgnoreCase.Equals($title, 'Error')) {
                throw 'installer smoke application displayed an error window'
            }
            if ([StringComparer]::Ordinal.Equals($title, 'WhiteLily')) {
                $hasWhiteLilyWindow = $true
            }
        }
        if ($hasWhiteLilyWindow) {
            $stableWhiteLilyObservations += 1
            if ($stableWhiteLilyObservations -ge 2) { return }
        } else {
            $stableWhiteLilyObservations = 0
        }
        if ($Process.WaitForExit(250)) {
            throw "installer smoke application exited before opening its main window: $($Process.ExitCode)"
        }
    }
    throw 'installer smoke application did not open the WhiteLily main window'
}
function Get-Uninstaller {
    param([Parameter(Mandatory = $true)][string]$ProgramRoot)
    $matches = @(Get-ChildItem -LiteralPath $ProgramRoot -File -Filter 'Uninstall*.exe')
    if ($matches.Count -ne 1) { throw 'installed uninstaller was not found' }
    return $matches[0].FullName
}
function Get-WhiteLilyProductEntries {
    $entries = [Collections.Generic.List[object]]::new()
    $registryRoots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($registryRoot in $registryRoots) {
        if (-not (Test-Path -LiteralPath $registryRoot -PathType Container)) { continue }
        foreach ($key in @(Get-ChildItem -LiteralPath $registryRoot -ErrorAction Stop)) {
            $entry = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
            $displayName = $entry.PSObject.Properties['DisplayName']
            if (
                $null -ne $displayName -and
                (
                    [StringComparer]::Ordinal.Equals([string]$displayName.Value, 'WhiteLily') -or
                    ([string]$displayName.Value).StartsWith(
                        'WhiteLily ',
                        [StringComparison]::Ordinal
                    )
                )
            ) {
                $entries.Add($entry)
            }
        }
    }
    return $entries.ToArray()
}
function Assert-WhiteLilyProductEntry {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$ProgramRoot
    )
    $entries = @(Get-WhiteLilyProductEntries)
    if ($entries.Count -ne 1) {
        throw "expected exactly one WhiteLily product/uninstall entry, found $($entries.Count)"
    }
    $entry = $entries[0]
    $displayName = $entry.PSObject.Properties['DisplayName']
    $expectedDisplayName = "WhiteLily $ExpectedVersion"
    if (
        $null -eq $displayName -or
        -not [StringComparer]::Ordinal.Equals(
            [string]$displayName.Value,
            $expectedDisplayName
        )
    ) {
        throw 'installed WhiteLily display name mismatch'
    }
    $displayVersion = $entry.PSObject.Properties['DisplayVersion']
    $receivedVersion = if ($null -eq $displayVersion) {
        ''
    } else {
        [string]$displayVersion.Value
    }
    if (-not [StringComparer]::Ordinal.Equals($receivedVersion, $ExpectedVersion)) {
        throw "installed WhiteLily version mismatch: $receivedVersion"
    }
    $uninstallProperty = $entry.PSObject.Properties['UninstallString']
    $uninstallString = if ($null -eq $uninstallProperty) {
        ''
    } else {
        [string]$uninstallProperty.Value
    }
    if (
        [string]::IsNullOrWhiteSpace($uninstallString) -or
        $uninstallString.IndexOf($ProgramRoot, [StringComparison]::OrdinalIgnoreCase) -lt 0
    ) {
        throw 'WhiteLily uninstall entry is not bound to the fixed program root'
    }
    if (
        @(Get-ChildItem -LiteralPath $ProgramRoot -File -Filter 'WhiteLily.exe').Count -ne 1 -or
        @(Get-ChildItem -LiteralPath $ProgramRoot -File -Filter 'Uninstall*.exe').Count -ne 1
    ) {
        throw 'WhiteLily product files are not unique'
    }
}
function Assert-NoWhiteLilyProductEntry {
    $entries = @(Get-WhiteLilyProductEntries)
    if ($entries.Count -ne 0) {
        throw "WhiteLily product/uninstall entry remained after uninstall: $($entries.Count)"
    }
}
function Get-PortableWorkspaceFiles {
    param([Parameter(Mandatory = $true)][string]$Root)
    $prefix = $Root.TrimEnd('\') + '\'
    [string[]]$files = @(
        Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
            ForEach-Object { $_.FullName.Substring($prefix.Length).Replace('\', '/') }
    )
    [Array]::Sort($files, [StringComparer]::Ordinal)
    return $files
}
function Assert-ManagedWorkspace {
    param(
        [Parameter(Mandatory = $true)][string]$ProgramRoot,
        [Parameter(Mandatory = $true)][string]$DataRoot
    )
    $resourceRoot = Join-Path $ProgramRoot 'resources\codex-workspace'
    $targetRoot = Join-Path $DataRoot 'codex-workspace'
    [string[]]$expectedFiles = @(
        '.codex/config.toml',
        'AGENTS.md',
        'workspace-manifest.json'
    )
    [Array]::Sort($expectedFiles, [StringComparer]::Ordinal)
    foreach ($root in @($resourceRoot, $targetRoot)) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            throw "managed workspace root is missing: $root"
        }
        $actualFiles = @(Get-PortableWorkspaceFiles $root)
        if (-not [System.Linq.Enumerable]::SequenceEqual([string[]]$actualFiles, $expectedFiles)) {
            throw "managed workspace file set is not exact: $root"
        }
    }
    $resourceManifestPath = Join-Path $resourceRoot 'workspace-manifest.json'
    $targetManifestPath = Join-Path $targetRoot 'workspace-manifest.json'
    $resourceManifest = Get-Content -LiteralPath $resourceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $targetManifest = Get-Content -LiteralPath $targetManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (
        [int]$resourceManifest.schemaVersion -ne 1 -or
        [int]$targetManifest.schemaVersion -ne 1 -or
        -not [StringComparer]::Ordinal.Equals(
            [string]$resourceManifest.contentVersion,
            [string]$targetManifest.contentVersion
        ) -or
        @($resourceManifest.files).Count -ne 2 -or
        @($targetManifest.files).Count -ne 2 -or
        -not [StringComparer]::Ordinal.Equals(
            (Get-Sha256Hex $resourceManifestPath),
            (Get-Sha256Hex $targetManifestPath)
        )
    ) {
        throw 'managed workspace manifests do not match'
    }
    $expectedPayloads = @('.codex/config.toml', 'AGENTS.md')
    for ($index = 0; $index -lt $expectedPayloads.Count; $index += 1) {
        $resourceEntry = @($resourceManifest.files)[$index]
        $targetEntry = @($targetManifest.files)[$index]
        $portablePath = $expectedPayloads[$index]
        if (
            -not [StringComparer]::Ordinal.Equals([string]$resourceEntry.path, $portablePath) -or
            -not [StringComparer]::Ordinal.Equals([string]$targetEntry.path, $portablePath) -or
            [long]$resourceEntry.bytes -ne [long]$targetEntry.bytes -or
            -not [StringComparer]::Ordinal.Equals(
                [string]$resourceEntry.sha256,
                [string]$targetEntry.sha256
            )
        ) {
            throw "managed workspace inner manifest mismatch: $portablePath"
        }
        $resourcePath = Join-Path $resourceRoot $portablePath.Replace('/', '\')
        $targetPath = Join-Path $targetRoot $portablePath.Replace('/', '\')
        $resourceFile = Get-Item -LiteralPath $resourcePath
        $targetFile = Get-Item -LiteralPath $targetPath
        $expectedHash = [string]$resourceEntry.sha256
        if (
            $resourceFile.Length -ne [long]$resourceEntry.bytes -or
            $targetFile.Length -ne [long]$resourceEntry.bytes -or
            -not [StringComparer]::Ordinal.Equals((Get-Sha256Hex $resourcePath), $expectedHash) -or
            -not [StringComparer]::Ordinal.Equals((Get-Sha256Hex $targetPath), $expectedHash)
        ) {
            throw "managed workspace inner/outer hash mismatch: $portablePath"
        }
    }
    return $expectedFiles.Count
}
function Invoke-WhiteLilySmoke {
    param([Parameter(Mandatory = $true)][string]$Application)
    $applicationProcess = Start-Process -FilePath $Application -ArgumentList @('--installer-smoke') -PassThru
    Wait-WhiteLilyMainWindow $applicationProcess
    if (-not $applicationProcess.HasExited) {
        $applicationProcess.Kill()
        $applicationProcess.WaitForExit()
    }
}
function Get-UninstallerUiProcessIds {
    param(
        [Parameter(Mandatory = $true)][int]$LauncherPid,
        [Parameter(Mandatory = $true)][string]$ProgramRoot
    )
    $ids = [Collections.Generic.List[int]]::new()
    $ids.Add($LauncherPid)
    $nsisMarker = '_?=' + $ProgramRoot.TrimEnd('\') + '\'
    $delegatedProcesses = @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                [int]$_.ParentProcessId -eq $LauncherPid -or
                (
                    -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
                    ([string]$_.CommandLine).IndexOf(
                        $nsisMarker,
                        [StringComparison]::OrdinalIgnoreCase
                    ) -ge 0
                )
            }
    )
    foreach ($delegatedProcess in $delegatedProcesses) {
        $processId = [int]$delegatedProcess.ProcessId
        if (-not $ids.Contains($processId)) {
            $ids.Add($processId)
        }
    }
    return $ids.ToArray()
}
try {
    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
    $env:Path = $env:PATH
    foreach ($command in @('node', 'npm', 'git', 'codex')) {
        if ($null -ne (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "forbidden system command remained on PATH: $command"
        }
    }
    $result.stages.Add('isolated_path')

    $installer = Join-Path 'C:\WhiteLilyInstaller' $InstallerName
    $baselineInstaller = Join-Path 'C:\WhiteLilyInstaller' $BaselineInstallerName
    $actualHash = Get-Sha256Hex $installer
    $actualBaselineHash = Get-Sha256Hex $baselineInstaller
    if (
        -not [StringComparer]::Ordinal.Equals($actualHash, $InstallerSha256) -or
        -not [StringComparer]::Ordinal.Equals($actualBaselineHash, $BaselineInstallerSha256)
    ) {
        throw 'mapped installer hash mismatch'
    }
    $result.stages.Add('hashes_verified')

    $programRoot = Join-Path $env:LOCALAPPDATA 'Programs\WhiteLily'
    $dataRoot = Join-Path $env:LOCALAPPDATA 'WhiteLily'
    $application = Join-Path $programRoot 'WhiteLily.exe'

    Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WhiteLilyInstallerUi {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder value, int max);
    [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    const uint BM_CLICK = 0x00F5;
    static IntPtr Top(uint pid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hwnd, _) => {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner == pid) { found = hwnd; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static bool ClickId(uint pid, int id) {
        IntPtr top = Top(pid);
        if (top == IntPtr.Zero) return false;
        IntPtr child = GetDlgItem(top, id);
        if (child == IntPtr.Zero) return false;
        SendMessage(child, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
        return true;
    }
    public static bool ClickContaining(uint pid, string needle) {
        IntPtr top = Top(pid);
        if (top == IntPtr.Zero) return false;
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(top, (hwnd, _) => {
            var text = new StringBuilder(512);
            GetWindowText(hwnd, text, text.Capacity);
            if (text.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
                found = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) return false;
        SendMessage(found, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
        return true;
    }
    }
"@
    function Complete-UninstallerUi {
        param(
            [Parameter(Mandatory = $true)][int]$UiProcessId,
            [int]$TimeoutMilliseconds = 120000
        )
        $process = Get-Process -Id $UiProcessId -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            throw 'interactive Delete Data uninstall process was unavailable'
        }
        $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($process.HasExited) {
                return [int]$process.ExitCode
            }
            [void][WhiteLilyInstallerUi]::ClickId([uint32]$UiProcessId, 1)
            if ($process.WaitForExit(250)) {
                return [int]$process.ExitCode
            }
            $process.Refresh()
        }
        if (-not $process.HasExited) {
            Stop-Process -Id $UiProcessId -Force -ErrorAction SilentlyContinue
        }
        throw 'interactive Delete Data uninstall timed out'
    }
    function Invoke-DeleteDataUninstall {
        param(
            [Parameter(Mandatory = $true)][string]$ProgramRoot,
            [Parameter(Mandatory = $true)][string]$DataRoot
        )
        $uninstaller = Get-Uninstaller $ProgramRoot
        $deleteProcess = Start-Process -FilePath $uninstaller -PassThru
        $uiProcessId = $null
        $welcomeDeadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            foreach ($candidateId in @(Get-UninstallerUiProcessIds -LauncherPid $deleteProcess.Id -ProgramRoot $ProgramRoot)) {
                if ([WhiteLilyInstallerUi]::ClickId([uint32]$candidateId, 1)) {
                    $uiProcessId = [int]$candidateId
                    break
                }
            }
            if ($null -ne $uiProcessId) { break }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $welcomeDeadline)
        if ($null -eq $uiProcessId) {
            throw 'could not advance the interactive uninstaller welcome page'
        }

        $choiceDeadline = [DateTime]::UtcNow.AddSeconds(30)
        $choiceSelected = $false
        do {
            $choiceSelected = [WhiteLilyInstallerUi]::ClickContaining(
                [uint32]$uiProcessId,
                'Delete WhiteLily data'
            )
            if ($choiceSelected) { break }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $choiceDeadline)
        if (-not $choiceSelected) {
            throw 'could not explicitly select Delete Data'
        }

        $deleteExitCode = Complete-UninstallerUi -UiProcessId $uiProcessId
        if ($deleteExitCode -ne 0) {
            throw "interactive Delete Data uninstall failed with exit code $deleteExitCode"
        }
        if (Test-Path -LiteralPath $DataRoot) {
            throw 'explicit Delete Data uninstall preserved the data root'
        }
        Assert-NoWhiteLilyProductEntry
    }

    Invoke-Process $installer @('/S')
    if (-not (Test-Path -LiteralPath $application -PathType Leaf)) {
        throw 'WhiteLily application was not installed'
    }
    Assert-WhiteLilyProductEntry -ExpectedVersion $ExpectedVersion -ProgramRoot $programRoot
    $result.stages.Add('clean_installed')
    Invoke-WhiteLilySmoke $application
    $result.managedWorkspaceResources = Assert-ManagedWorkspace `
        -ProgramRoot $programRoot `
        -DataRoot $dataRoot
    $result.stages.Add('clean_workspace_verified')

    Invoke-DeleteDataUninstall -ProgramRoot $programRoot -DataRoot $dataRoot
    $result.stages.Add('clean_delete_data')

    Invoke-Process $baselineInstaller @('/S')
    Assert-WhiteLilyProductEntry -ExpectedVersion $BaselineVersion -ProgramRoot $programRoot
    $result.stages.Add('beta1_installed')

    New-Item -ItemType Directory -Path (Join-Path $dataRoot 'codex-workspace\.codex') -Force | Out-Null
    $marker = Join-Path $dataRoot 'installer-lifecycle-beta1-marker.txt'
    [System.IO.File]::WriteAllText($marker, 'preserve-beta1-data', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText(
        (Join-Path $dataRoot 'codex-workspace\.codex\config.toml'),
        "stale = true`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $dataRoot 'codex-workspace\AGENTS.md'),
        "stale beta.1 workspace`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $dataRoot 'codex-workspace\workspace-manifest.json'),
        "{}`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $dataRoot 'codex-workspace\obsolete.txt'),
        "remove during repair`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    $result.stages.Add('beta1_data_root_prepared')

    Invoke-Process $installer @('/S')
    Assert-WhiteLilyProductEntry -ExpectedVersion $ExpectedVersion -ProgramRoot $programRoot
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw 'beta.1 data marker was removed during upgrade'
    }
    $result.stages.Add('beta1_upgraded')
    Invoke-WhiteLilySmoke $application
    $result.managedWorkspaceResources = Assert-ManagedWorkspace `
        -ProgramRoot $programRoot `
        -DataRoot $dataRoot
    if (Test-Path -LiteralPath (Join-Path $dataRoot 'codex-workspace\obsolete.txt')) {
        throw 'beta.1 workspace drift was not repaired'
    }
    $result.stages.Add('workspace_repaired')

    $uninstaller = Get-Uninstaller $programRoot
    Invoke-Process $uninstaller @('/S')
    Assert-NoWhiteLilyProductEntry
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw 'silent Keep Data uninstall removed the beta.1 data marker'
    }
    $result.stages.Add('keep_data')

    Invoke-Process $installer @('/S')
    Assert-WhiteLilyProductEntry -ExpectedVersion $ExpectedVersion -ProgramRoot $programRoot
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw 'reinstall did not preserve the beta.1 data marker'
    }
    Invoke-WhiteLilySmoke $application
    $result.managedWorkspaceResources = Assert-ManagedWorkspace `
        -ProgramRoot $programRoot `
        -DataRoot $dataRoot
    $result.installedVersion = $ExpectedVersion
    $result.stages.Add('reinstalled')

    Invoke-DeleteDataUninstall -ProgramRoot $programRoot -DataRoot $dataRoot
    $result.stages.Add('delete_data')
    $result.success = $true
} catch {
    $result.error = $_.Exception.Message
} finally {
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText(
        $resultPath,
        ($result | ConvertTo-Json -Depth 5 -Compress) + "`n",
        $utf8
    )
    Start-Process -FilePath "$env:SystemRoot\System32\shutdown.exe" -ArgumentList @('/s', '/t', '0') -WindowStyle Hidden
}
'@
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($guestScriptPath, $guestScript, $utf8)

$guestCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\WhiteLilyReport\guest-lifecycle.ps1"' +
    " -InstallerName `"$installerName`" -InstallerSha256 `"$installerHash`"" +
    " -ExpectedVersion `"$version`"" +
    " -BaselineInstallerName `"$([System.IO.Path]::GetFileName($resolvedBaselineInstaller))`"" +
    " -BaselineInstallerSha256 `"$baselineInstallerHash`"" +
    " -BaselineVersion `"$baselineVersion`""
$configuration = @"
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$(ConvertTo-XmlEscapedText $installerDirectory)</HostFolder>
      <SandboxFolder>C:\WhiteLilyInstaller</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$(ConvertTo-XmlEscapedText $reportRoot)</HostFolder>
      <SandboxFolder>C:\WhiteLilyReport</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <LogonCommand>
    <Command>$(ConvertTo-XmlEscapedText $guestCommand)</Command>
  </LogonCommand>
</Configuration>
"@
[System.IO.File]::WriteAllText($sandboxConfigurationPath, $configuration, $utf8)

$sandboxProcess = $null
$lifecycleError = $null
$cleanupError = $null
$lifecycleOutput = $null
try {
    try {
        $sandboxProcess = Start-Process `
            -FilePath $sandboxExecutable `
            -ArgumentList @($sandboxConfigurationPath) `
            -PassThru
    } catch {
        throw 'WINDOWS_SANDBOX_REQUIRED'
    }

    $deadline = [DateTime]::UtcNow.AddMinutes(20)
    while (-not (Test-Path -LiteralPath $sandboxResultPath -PathType Leaf)) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw 'SANDBOX_LIFECYCLE_TIMEOUT'
        }
        if ($sandboxProcess.HasExited -and $sandboxProcess.ExitCode -ne 0) {
            throw 'SANDBOX_LIFECYCLE_REPORT_MISSING'
        }
        Start-Sleep -Seconds 2
    }

    $report = Get-Content -LiteralPath $sandboxResultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedStages = @(
        'isolated_path',
        'hashes_verified',
        'clean_installed',
        'clean_workspace_verified',
        'clean_delete_data',
        'beta1_installed',
        'beta1_data_root_prepared',
        'beta1_upgraded',
        'workspace_repaired',
        'keep_data',
        'reinstalled',
        'delete_data'
    )
    $actualStages = @($report.stages | ForEach-Object { [string]$_ })
    if (
        [int]$report.schemaVersion -ne 1 -or
        -not [StringComparer]::Ordinal.Equals([string]$report.installerSha256, $installerHash) -or
        -not [StringComparer]::Ordinal.Equals([string]$report.expectedVersion, $version) -or
        -not [StringComparer]::Ordinal.Equals(
            [string]$report.baselineInstallerSha256,
            $baselineInstallerHash
        ) -or
        -not [StringComparer]::Ordinal.Equals([string]$report.installedVersion, $version) -or
        [int]$report.managedWorkspaceResources -ne 3 -or
        $report.success -ne $true -or
        -not [System.Linq.Enumerable]::SequenceEqual([string[]]$actualStages, [string[]]$expectedStages)
    ) {
        throw "SANDBOX_LIFECYCLE_FAILED: $([string]$report.error)"
    }
    Copy-Item -LiteralPath $sandboxResultPath -Destination $resolvedReport -Force
    $lifecycleOutput = $report | ConvertTo-Json -Compress
} catch {
    $lifecycleError = $_
} finally {
    try {
        if ($null -ne $sandboxProcess -and -not $sandboxProcess.HasExited) {
            try {
                $sandboxProcess.Kill()
                $sandboxProcess.WaitForExit()
            } catch {
                # The launcher may exit between HasExited and Kill.
            }
        }
        $boundRemoteSessions = @(
            Get-CimInstance Win32_Process `
                -Filter "Name = 'WindowsSandboxRemoteSession.exe'" `
                -ErrorAction SilentlyContinue |
                Where-Object {
                    -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
                    ([string]$_.CommandLine).IndexOf(
                        $sandboxConfigurationPath,
                        [StringComparison]::OrdinalIgnoreCase
                    ) -ge 0
                }
        )
        foreach ($expectedRemoteSession in $boundRemoteSessions) {
            $remoteProcess = $null
            try {
                $remoteProcess = Get-Process -Id $expectedRemoteSession.ProcessId -ErrorAction Stop
                # Opening Handle binds this object to the current OS process before identity is revalidated.
                $remoteProcess.Handle | Out-Null
                $currentRemoteSession = Get-CimInstance Win32_Process `
                    -Filter "ProcessId = $($expectedRemoteSession.ProcessId)" `
                    -ErrorAction Stop
                if (
                    Test-SandboxRemoteSessionIdentity `
                        -Expected $expectedRemoteSession `
                        -Current $currentRemoteSession `
                        -ConfigurationPath $sandboxConfigurationPath
                ) {
                    $remoteProcess.Kill()
                    $remoteProcess.WaitForExit()
                }
            } catch {
                # A session may exit while the lifecycle report is being processed.
            } finally {
                if ($null -ne $remoteProcess) {
                    $remoteProcess.Dispose()
                }
            }
        }
        if (
            (Test-Path -LiteralPath $sandboxRoot) -and
            $sandboxRoot.StartsWith($sandboxPrefix, [StringComparison]::OrdinalIgnoreCase)
        ) {
            $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(30)
            while (Test-Path -LiteralPath $sandboxRoot) {
                try {
                    Remove-Item -LiteralPath $sandboxRoot -Recurse -Force
                } catch [System.IO.IOException] {
                    if ([DateTime]::UtcNow -ge $cleanupDeadline) {
                        $cleanupError = $_
                        break
                    }
                    Start-Sleep -Seconds 1
                } catch [System.UnauthorizedAccessException] {
                    if ([DateTime]::UtcNow -ge $cleanupDeadline) {
                        $cleanupError = $_
                        break
                    }
                    Start-Sleep -Seconds 1
                }
            }
        }
    } catch {
        $cleanupError = $_
    }
}

if ($null -ne $lifecycleError) {
    if ($null -ne $cleanupError) {
        Write-Warning `
            "SANDBOX_CLEANUP_FAILED: $($cleanupError.Exception.Message)" `
            -WarningAction Continue
    }
    throw $lifecycleError
}
if ($null -ne $cleanupError) {
    throw $cleanupError
}
Write-Output $lifecycleOutput
