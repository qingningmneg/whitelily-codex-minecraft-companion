[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

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

$installerDirectory = [System.IO.Path]::GetFullPath((Split-Path -Parent $resolvedInstaller))
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
    [Parameter(Mandatory = $true)][string]$InstallerSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$resultPath = 'C:\WhiteLilyReport\sandbox-result.json'
$result = [ordered]@{
    schemaVersion = 1
    installerSha256 = $InstallerSha256
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
function Get-Uninstaller {
    param([Parameter(Mandatory = $true)][string]$ProgramRoot)
    $matches = @(Get-ChildItem -LiteralPath $ProgramRoot -File -Filter 'Uninstall*.exe')
    if ($matches.Count -ne 1) { throw 'installed uninstaller was not found' }
    return $matches[0].FullName
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
    $actualHash = Get-Sha256Hex $installer
    if (-not [StringComparer]::Ordinal.Equals($actualHash, $InstallerSha256)) {
        throw 'mapped installer hash mismatch'
    }
    $result.stages.Add('hash_verified')

    $programRoot = Join-Path $env:LOCALAPPDATA 'Programs\WhiteLily'
    $dataRoot = Join-Path $env:LOCALAPPDATA 'WhiteLily'
    $application = Join-Path $programRoot 'WhiteLily.exe'
    Invoke-Process $installer @('/S')
    if (-not (Test-Path -LiteralPath $application -PathType Leaf)) {
        throw 'WhiteLily application was not installed'
    }
    $result.stages.Add('installed')

    $applicationProcess = Start-Process -FilePath $application -ArgumentList @('--installer-smoke') -PassThru
    Start-Sleep -Seconds 5
    if ($applicationProcess.HasExited -and $applicationProcess.ExitCode -ne 0) {
        throw "installer smoke launch failed with exit code $($applicationProcess.ExitCode)"
    }
    if (-not $applicationProcess.HasExited) {
        Stop-Process -Id $applicationProcess.Id -Force
        $applicationProcess.WaitForExit()
    }
    $result.stages.Add('launched_without_system_tooling')

    New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
    $marker = Join-Path $dataRoot 'installer-lifecycle-marker.txt'
    [System.IO.File]::WriteAllText($marker, 'preserve', [System.Text.UTF8Encoding]::new($false))
    $uninstaller = Get-Uninstaller $programRoot
    Invoke-Process $uninstaller @('/S')
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw 'silent Keep Data uninstall removed the data marker'
    }
    $result.stages.Add('keep_data')

    Invoke-Process $installer @('/S')
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw 'reinstall did not preserve the data marker'
    }
    $result.stages.Add('reinstalled')

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
    $uninstaller = Get-Uninstaller $programRoot
    $deleteProcess = Start-Process -FilePath $uninstaller -PassThru
    $uiProcessId = $null
    $welcomeDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        foreach ($candidateId in @(Get-UninstallerUiProcessIds -LauncherPid $deleteProcess.Id -ProgramRoot $programRoot)) {
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
    if (Test-Path -LiteralPath $dataRoot) {
        throw 'explicit Delete Data uninstall preserved the data root'
    }
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
    " -InstallerName `"$installerName`" -InstallerSha256 `"$installerHash`""
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

    $deadline = [DateTime]::UtcNow.AddMinutes(15)
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
        'hash_verified',
        'installed',
        'launched_without_system_tooling',
        'keep_data',
        'reinstalled',
        'delete_data'
    )
    $actualStages = @($report.stages | ForEach-Object { [string]$_ })
    if (
        [int]$report.schemaVersion -ne 1 -or
        -not [StringComparer]::Ordinal.Equals([string]$report.installerSha256, $installerHash) -or
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
}

if ($null -ne $lifecycleError) {
    if ($null -ne $cleanupError) {
        Write-Warning "SANDBOX_CLEANUP_FAILED: $($cleanupError.Exception.Message)"
    }
    throw $lifecycleError
}
if ($null -ne $cleanupError) {
    throw $cleanupError
}
Write-Output $lifecycleOutput
