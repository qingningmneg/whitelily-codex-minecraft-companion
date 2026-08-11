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

function Get-HmacSha256Hex {
    param(
        [Parameter(Mandatory = $true)][string]$Payload,
        [Parameter(Mandatory = $true)][string]$KeyHex
    )
    $key = [byte[]]::new($KeyHex.Length / 2)
    for ($index = 0; $index -lt $key.Length; $index += 1) {
        $key[$index] = [Convert]::ToByte($KeyHex.Substring($index * 2, 2), 16)
    }
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($key)
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Payload)
        return [BitConverter]::ToString($hmac.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $hmac.Dispose()
        [Array]::Clear($key, 0, $key.Length)
    }
}

function Test-FixedTimeHexEqual {
    param([string]$Left, [string]$Right)
    if ($null -eq $Left -or $null -eq $Right -or $Left.Length -ne $Right.Length) {
        return $false
    }
    $difference = 0
    for ($index = 0; $index -lt $Left.Length; $index += 1) {
        $difference = $difference -bor ([int][char]$Left[$index] -bxor [int][char]$Right[$index])
    }
    return $difference -eq 0
}

function Get-TrustedSandboxEnvelope {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$KeyHex
    )
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { return $null }
    try {
        $envelope = Get-Content -LiteralPath $LiteralPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $payload = [string]$envelope.payload
        $receivedHmac = [string]$envelope.hmacSha256
        if (
            [int]$envelope.transportSchemaVersion -ne 1 -or
            [string]::IsNullOrWhiteSpace($payload) -or
            -not (Test-FixedTimeHexEqual `
                -Left $receivedHmac `
                -Right (Get-HmacSha256Hex -Payload $payload -KeyHex $KeyHex))
        ) {
            return $null
        }
        return [pscustomobject]@{
            Payload = $payload
            Report = $payload | ConvertFrom-Json
        }
    } catch {
        return $null
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

function Test-FileSystemEntryHasAttribute {
    param(
        [Parameter(Mandatory = $true)][System.IO.FileSystemInfo]$Entry,
        [Parameter(Mandatory = $true)][System.IO.FileAttributes]$Attribute
    )
    return ($Entry.Attributes -band $Attribute) -eq $Attribute
}

function Assert-OrdinaryFileEntry {
    param(
        [Parameter(Mandatory = $true)][System.IO.FileSystemInfo]$Entry,
        [Parameter(Mandatory = $true)][string]$SandboxRoot
    )
    if (
        $Entry.PSIsContainer -or
        -not ($Entry -is [System.IO.FileInfo]) -or
        (Test-FileSystemEntryHasAttribute `
            -Entry $Entry `
            -Attribute ([System.IO.FileAttributes]::ReparsePoint))
    ) {
        throw "SANDBOX_MAPPING_CONTAMINATED: non-ordinary or reparse entry '$($Entry.FullName)'; mapped lifecycle artifacts were retained at $SandboxRoot. Inspect the retained directory and remove only verified ordinary files manually."
    }
}

function Remove-EmptyOrdinaryDirectoryWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$SandboxRoot,
        [Parameter(Mandatory = $true)][DateTime]$Deadline
    )
    while (Test-Path -LiteralPath $LiteralPath) {
        $directory = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
        if (
            -not $directory.PSIsContainer -or
            (Test-FileSystemEntryHasAttribute `
                -Entry $directory `
                -Attribute ([System.IO.FileAttributes]::ReparsePoint))
        ) {
            throw "SANDBOX_MAPPING_CONTAMINATED: mapped path '$LiteralPath' is not an ordinary directory; mapped lifecycle artifacts were retained at $SandboxRoot."
        }
        if (@(Get-ChildItem -LiteralPath $LiteralPath -Force -ErrorAction Stop).Count -ne 0) {
            throw "SANDBOX_MAPPING_CONTAMINATED: mapped directory '$LiteralPath' changed during cleanup; mapped lifecycle artifacts were retained at $SandboxRoot."
        }
        try {
            Remove-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
        } catch [System.IO.IOException] {
            if ([DateTime]::UtcNow -ge $Deadline) {
                throw "SANDBOX_CLEANUP_TIMEOUT: empty mapped directory '$LiteralPath' remained busy; close Windows Sandbox manually. Mapped lifecycle artifacts were retained at $SandboxRoot"
            }
            Start-Sleep -Milliseconds 250
        } catch [System.UnauthorizedAccessException] {
            if ([DateTime]::UtcNow -ge $Deadline) {
                throw "SANDBOX_CLEANUP_TIMEOUT: empty mapped directory '$LiteralPath' remained busy; close Windows Sandbox manually. Mapped lifecycle artifacts were retained at $SandboxRoot"
            }
            Start-Sleep -Milliseconds 250
        }
    }
}

function Remove-InstallerSandboxTreeNoFollow {
    param(
        [Parameter(Mandatory = $true)][string]$SandboxRoot,
        [Parameter(Mandatory = $true)][string]$ReportRoot,
        [Parameter(Mandatory = $true)][string]$ConfigurationPath
    )
    $sandboxDirectory = Get-Item -LiteralPath $SandboxRoot -Force -ErrorAction Stop
    $reportDirectory = Get-Item -LiteralPath $ReportRoot -Force -ErrorAction Stop
    foreach ($directory in @($sandboxDirectory, $reportDirectory)) {
        if (
            -not $directory.PSIsContainer -or
            (Test-FileSystemEntryHasAttribute `
                -Entry $directory `
                -Attribute ([System.IO.FileAttributes]::ReparsePoint))
        ) {
            throw "SANDBOX_MAPPING_CONTAMINATED: mapped directory '$($directory.FullName)' is not an ordinary directory; mapped lifecycle artifacts were retained at $SandboxRoot. Inspect the retained directory and remove it manually without following reparse points."
        }
    }

    $allowedReportFiles = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    @(
        'guest-lifecycle.ps1',
        'sandbox-result.json',
        'bootstrap-secret.txt',
        'bootstrap-error.txt',
        'shutdown-guard.lock'
    ) | ForEach-Object { [void]$allowedReportFiles.Add($_) }
    $allowedSandboxFiles = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    [void]$allowedSandboxFiles.Add([System.IO.Path]::GetFileName($ConfigurationPath))

    $sandboxEntries = @(Get-ChildItem -LiteralPath $SandboxRoot -Force -ErrorAction Stop)
    foreach ($entry in $sandboxEntries) {
        if ([StringComparer]::OrdinalIgnoreCase.Equals($entry.FullName, $ReportRoot)) {
            if (
                -not $entry.PSIsContainer -or
                (Test-FileSystemEntryHasAttribute `
                    -Entry $entry `
                    -Attribute ([System.IO.FileAttributes]::ReparsePoint))
            ) {
                throw "SANDBOX_MAPPING_CONTAMINATED: report path is not an ordinary directory; mapped lifecycle artifacts were retained at $SandboxRoot."
            }
            continue
        }
        Assert-OrdinaryFileEntry -Entry $entry -SandboxRoot $SandboxRoot
        if (-not $allowedSandboxFiles.Contains($entry.Name)) {
            throw "SANDBOX_MAPPING_CONTAMINATED: unexpected top-level entry '$($entry.FullName)'; mapped lifecycle artifacts were retained at $SandboxRoot. Inspect the retained directory and remove only verified ordinary files manually."
        }
    }

    $reportEntries = @(Get-ChildItem -LiteralPath $ReportRoot -Force -ErrorAction Stop)
    foreach ($entry in $reportEntries) {
        Assert-OrdinaryFileEntry -Entry $entry -SandboxRoot $SandboxRoot
        if (-not $allowedReportFiles.Contains($entry.Name)) {
            throw "SANDBOX_MAPPING_CONTAMINATED: unexpected report entry '$($entry.FullName)'; mapped lifecycle artifacts were retained at $SandboxRoot. Inspect the retained directory and remove only verified ordinary files manually."
        }
    }

    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(30)
    foreach ($name in $allowedReportFiles) {
        $path = Join-Path $ReportRoot $name
        while (Test-Path -LiteralPath $path) {
            try {
                $entry = Get-Item -LiteralPath $path -Force -ErrorAction Stop
                Assert-OrdinaryFileEntry -Entry $entry -SandboxRoot $SandboxRoot
                Remove-Item -LiteralPath $path -Force -ErrorAction Stop
            } catch [System.IO.IOException] {
                if ([DateTime]::UtcNow -ge $cleanupDeadline) { throw }
                Start-Sleep -Milliseconds 250
            } catch [System.UnauthorizedAccessException] {
                if ([DateTime]::UtcNow -ge $cleanupDeadline) { throw }
                Start-Sleep -Milliseconds 250
            }
        }
    }
    if (@(Get-ChildItem -LiteralPath $ReportRoot -Force -ErrorAction Stop).Count -ne 0) {
        throw "SANDBOX_MAPPING_CONTAMINATED: report directory changed during cleanup; mapped lifecycle artifacts were retained at $SandboxRoot."
    }
    Remove-EmptyOrdinaryDirectoryWithRetry `
        -LiteralPath $ReportRoot `
        -SandboxRoot $SandboxRoot `
        -Deadline $cleanupDeadline

    foreach ($name in $allowedSandboxFiles) {
        $path = Join-Path $SandboxRoot $name
        if (Test-Path -LiteralPath $path) {
            $entry = Get-Item -LiteralPath $path -Force -ErrorAction Stop
            Assert-OrdinaryFileEntry -Entry $entry -SandboxRoot $SandboxRoot
            Remove-Item -LiteralPath $path -Force -ErrorAction Stop
        }
    }
    if (@(Get-ChildItem -LiteralPath $SandboxRoot -Force -ErrorAction Stop).Count -ne 0) {
        throw "SANDBOX_MAPPING_CONTAMINATED: sandbox directory changed during cleanup; mapped lifecycle artifacts were retained at $SandboxRoot."
    }
    Remove-EmptyOrdinaryDirectoryWithRetry `
        -LiteralPath $SandboxRoot `
        -SandboxRoot $SandboxRoot `
        -Deadline $cleanupDeadline
}

function Wait-ShutdownGuardRelease {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][string]$SandboxRoot,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ($true) {
        if (Test-Path -LiteralPath $LiteralPath) {
            $entry = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
            Assert-OrdinaryFileEntry -Entry $entry -SandboxRoot $SandboxRoot
            try {
                $stream = [System.IO.File]::Open(
                    $LiteralPath,
                    [System.IO.FileMode]::Open,
                    [System.IO.FileAccess]::ReadWrite,
                    [System.IO.FileShare]::None
                )
                $stream.Dispose()
                return
            } catch [System.IO.IOException] {
            } catch [System.UnauthorizedAccessException] {
            }
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "SANDBOX_SHUTDOWN_GUARD_TIMEOUT: the trusted guest controller still owns the mapped shutdown guard; close the Windows Sandbox window manually. Mapped lifecycle artifacts were retained at $SandboxRoot"
        }
        Start-Sleep -Milliseconds 250
    }
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
$publicBaselineContractPath = Join-Path $repositoryRoot 'packaging\electron\public-installer-baselines.json'
if (-not (Test-Path -LiteralPath $publicBaselineContractPath -PathType Leaf)) {
    throw 'PUBLIC_BASELINE_CONTRACT_REQUIRED'
}
try {
    $publicBaselineContract = Get-Content -LiteralPath $publicBaselineContractPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    throw 'PUBLIC_BASELINE_CONTRACT_INVALID'
}
$publicBaselineEntries = @($publicBaselineContract.baselines | Where-Object {
    [string]$_.version -eq $baselineVersion
})
if (
    [int]$publicBaselineContract.schemaVersion -ne 1 -or
    $publicBaselineEntries.Count -ne 1 -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$publicBaselineEntries[0].releaseTag,
        'v0.2.0-beta.1'
    ) -or
    -not [StringComparer]::Ordinal.Equals(
        [string]$publicBaselineEntries[0].assetName,
        "WhiteLily-$baselineVersion-windows-x64-setup.exe"
    ) -or
    [int64]$publicBaselineEntries[0].bytes -le 0 -or
    [string]$publicBaselineEntries[0].sha256 -cnotmatch '^[0-9a-f]{64}$'
) {
    throw 'PUBLIC_BASELINE_CONTRACT_INVALID'
}
$publicBaseline = $publicBaselineEntries[0]
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
if (
    (Get-Item -LiteralPath $resolvedBaselineInstaller).Length -ne [int64]$publicBaseline.bytes -or
    -not [StringComparer]::Ordinal.Equals($baselineInstallerHash, [string]$publicBaseline.sha256)
) {
    throw 'BETA1_PUBLIC_BASELINE_REQUIRED'
}
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
$shutdownGuardPath = Join-Path $reportRoot 'shutdown-guard.lock'
$sandboxConfigurationPath = Join-Path $sandboxRoot 'WhiteLily-installer-lifecycle.wsb'
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
$reportKeyBytes = [byte[]]::new(32)
$reportKeyGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $reportKeyGenerator.GetBytes($reportKeyBytes)
    $reportKeyHex = [BitConverter]::ToString($reportKeyBytes).Replace('-', '').ToLowerInvariant()
} finally {
    $reportKeyGenerator.Dispose()
    [Array]::Clear($reportKeyBytes, 0, $reportKeyBytes.Length)
}
$bootstrapSecretPath = Join-Path $reportRoot 'bootstrap-secret.txt'
[System.IO.File]::WriteAllText(
    $bootstrapSecretPath,
    $reportKeyHex + "`n",
    [System.Text.UTF8Encoding]::new($false)
)

$componentVerifierSourcePath = Join-Path $PSScriptRoot 'minecraft-component-resource-verifier.ps1'
$componentPolicyPath = Join-Path $repositoryRoot 'packaging\electron\minecraft-component-pack.json'
if (
    -not (Test-Path -LiteralPath $componentVerifierSourcePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $componentPolicyPath -PathType Leaf)
) {
    throw 'REVIEWED_MINECRAFT_COMPONENT_POLICY_REQUIRED'
}
$componentVerifierSource = [System.IO.File]::ReadAllText($componentVerifierSourcePath)
$componentPolicyBase64 = [Convert]::ToBase64String(
    [System.IO.File]::ReadAllBytes($componentPolicyPath)
)

$guestScript = @'
[CmdletBinding()]
param(
    [ValidateSet('Bootstrap', 'Controller', 'Candidate')]
    [string]$Mode = 'Bootstrap',
    [Parameter(Mandatory = $true)][string]$InstallerName,
    [Parameter(Mandatory = $true)][string]$InstallerSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][string]$BaselineInstallerName,
    [Parameter(Mandatory = $true)][string]$BaselineInstallerSha256,
    [Parameter(Mandatory = $true)][string]$BaselineVersion,
    [Parameter(Mandatory = $true)][string]$CandidateUsername,
    [string]$CandidatePassword,
    [string]$ExpectedCandidateSid,
    [string]$CandidateOperation,
    [string]$CandidateTarget
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$trustedControlRoot = 'C:\ProgramData\WhiteLilyLifecycle'
$resultPath = Join-Path $trustedControlRoot 'sandbox-result.json'
$brokerRequestPath = Join-Path $trustedControlRoot 'candidate-request.json'
$brokerResponsePath = Join-Path $trustedControlRoot 'candidate-response.json'
$brokerStopPath = Join-Path $trustedControlRoot 'candidate-broker.stop'
$reportSecretPath = Join-Path $trustedControlRoot 'report-secret.txt'
$mappedResultPath = 'C:\WhiteLilyReport\sandbox-result.json'
$mappedShutdownGuardPath = 'C:\WhiteLilyReport\shutdown-guard.lock'
$result = [ordered]@{
    schemaVersion = 2
    controllerSid = $null
    candidateSid = $null
    candidateReportWriteDenied = $false
    installerSha256 = $InstallerSha256
    controllerObservedInstallerSha256 = $null
    expectedVersion = $ExpectedVersion
    baselineInstallerSha256 = $BaselineInstallerSha256
    controllerObservedBaselineInstallerSha256 = $null
    installedVersion = $null
    managedWorkspaceResources = 0
    minecraftComponentResources = 0
    componentPreferencesFresh = $false
    componentPreferencesUpgradePreserved = $false
    componentPreferencesKeepPreserved = $false
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
function Get-ReportHmacSha256Hex {
    param(
        [Parameter(Mandatory = $true)][string]$Payload,
        [Parameter(Mandatory = $true)][string]$KeyHex
    )
    $key = [byte[]]::new($KeyHex.Length / 2)
    for ($index = 0; $index -lt $key.Length; $index += 1) {
        $key[$index] = [Convert]::ToByte($KeyHex.Substring($index * 2, 2), 16)
    }
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($key)
    try {
        return [BitConverter]::ToString(
            $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Payload))
        ).Replace('-', '').ToLowerInvariant()
    } finally {
        $hmac.Dispose()
        [Array]::Clear($key, 0, $key.Length)
    }
}
function Publish-AuthenticatedLifecycleResult {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Value)
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $payload = $Value | ConvertTo-Json -Depth 5 -Compress
    [System.IO.File]::WriteAllText($resultPath, $payload + "`n", $utf8)
    $reportKeyHex = (Get-Content -LiteralPath $reportSecretPath -Raw -Encoding UTF8).Trim()
    $envelope = [ordered]@{
        transportSchemaVersion = 1
        payload = $payload
        hmacSha256 = Get-ReportHmacSha256Hex -Payload $payload -KeyHex $reportKeyHex
    }
    Write-AtomicJson -LiteralPath $mappedResultPath -Value $envelope
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
    param(
        [string[]]$RegistryRoots = @(
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
        )
    )
    $entries = [Collections.Generic.List[object]]::new()
    foreach ($registryRoot in $RegistryRoots) {
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
        [Parameter(Mandatory = $true)][string]$ProgramRoot,
        [string[]]$RegistryRoots = @(
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
        )
    )
    $entries = @(Get-WhiteLilyProductEntries -RegistryRoots $RegistryRoots)
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
    param(
        [string[]]$RegistryRoots = @(
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
        )
    )
    $entries = @(Get-WhiteLilyProductEntries -RegistryRoots $RegistryRoots)
    if ($entries.Count -ne 0) {
        throw "WhiteLily product/uninstall entry remained after uninstall: $($entries.Count)"
    }
}
function Assert-WhiteLilyRemovalState {
    param(
        [Parameter(Mandatory = $true)][string]$ProgramRoot,
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][int]$ProductEntryCount,
        [Parameter(Mandatory = $true)][bool]$KeepData,
        [int]$TimeoutMilliseconds = 30000
    )
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        $programRootExists = Test-Path -LiteralPath $ProgramRoot
        $applicationExists = Test-Path -LiteralPath (Join-Path $ProgramRoot 'WhiteLily.exe')
        $uninstallerExists = @(
            Get-ChildItem -LiteralPath $ProgramRoot -File -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue
        ).Count -ne 0
        $dataRootExists = Test-Path -LiteralPath $DataRoot
        $dataStateMatches = if ($KeepData) { $dataRootExists } else { -not $dataRootExists }
        if (
            -not $programRootExists -and
            -not $applicationExists -and
            -not $uninstallerExists -and
            $ProductEntryCount -eq 0 -and
            $dataStateMatches
        ) {
            return
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)

    if ($programRootExists -or $applicationExists -or $uninstallerExists) {
        throw 'WhiteLily program artifacts remained after uninstall'
    }
    if ($ProductEntryCount -ne 0) {
        throw "WhiteLily product/uninstall entry remained after uninstall: $ProductEntryCount"
    }
    if ($KeepData -and -not $dataRootExists) {
        throw 'Keep Data uninstall removed the WhiteLily data root'
    }
    if (-not $KeepData -and $dataRootExists) {
        throw 'Delete Data uninstall preserved the WhiteLily data root'
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
__WHITELILY_REVIEWED_COMPONENT_VERIFIER__
$reviewedMinecraftComponentPolicy = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String('__WHITELILY_REVIEWED_COMPONENT_POLICY__')
) | ConvertFrom-Json
$reviewedMinecraftComponentFiles = @($reviewedMinecraftComponentPolicy.files)
function Assert-ExactComponentPreferences {
    param(
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedJson
    )

    $preferencesPath = Join-Path $DataRoot 'config\minecraft-components.json'
    $entry = Get-Item -LiteralPath $preferencesPath -Force
    if (
        -not ($entry -is [System.IO.FileInfo]) -or
        $entry.PSIsContainer -or
        (Test-FileSystemEntryHasAttribute `
            -Entry $entry `
            -Attribute ([System.IO.FileAttributes]::ReparsePoint))
    ) {
        throw 'component preferences are not an ordinary file'
    }
    [byte[]]$actual = [System.IO.File]::ReadAllBytes($preferencesPath)
    [byte[]]$expected = [System.Text.Encoding]::UTF8.GetBytes($ExpectedJson)
    if (-not [System.Linq.Enumerable]::SequenceEqual([byte[]]$actual, [byte[]]$expected)) {
        throw 'component preferences bytes changed'
    }
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
function Get-CurrentPrincipalSid {
    return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}
function Get-CandidateSid {
    $account = [Security.Principal.NTAccount]::new("$env:COMPUTERNAME\$CandidateUsername")
    return $account.Translate([Security.Principal.SecurityIdentifier]).Value
}
function Get-CandidateProfileRoot {
    param([Parameter(Mandatory = $true)][string]$Sid)
    $profile = Get-CimInstance Win32_UserProfile -Filter "SID = '$Sid'" -ErrorAction SilentlyContinue
    if ($null -ne $profile -and -not [string]::IsNullOrWhiteSpace([string]$profile.LocalPath)) {
        return [string]$profile.LocalPath
    }
    return Join-Path 'C:\Users' $CandidateUsername
}
function Write-AtomicJson {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)]$Value
    )
    $temporaryPath = $LiteralPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [System.IO.File]::WriteAllText(
            $temporaryPath,
            ($Value | ConvertTo-Json -Depth 5 -Compress) + "`n",
            [System.Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporaryPath -Destination $LiteralPath -Force
    } finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}
function Get-CandidateProcessArguments {
    param(
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)][string]$CandidateSid,
        [string]$Target
    )
    $arguments = '-NoProfile -ExecutionPolicy Bypass' +
        ' -File "C:\WhiteLilyReport\guest-lifecycle.ps1"' +
        ' -Mode Candidate' +
        " -InstallerName `"$InstallerName`" -InstallerSha256 `"$InstallerSha256`"" +
        " -ExpectedVersion `"$ExpectedVersion`"" +
        " -BaselineInstallerName `"$BaselineInstallerName`"" +
        " -BaselineInstallerSha256 `"$BaselineInstallerSha256`"" +
        " -BaselineVersion `"$BaselineVersion`"" +
        " -CandidateUsername `"$CandidateUsername`"" +
        " -ExpectedCandidateSid `"$CandidateSid`"" +
        " -CandidateOperation `"$Operation`""
    if (-not [string]::IsNullOrWhiteSpace($Target)) {
        $arguments += " -CandidateTarget `"$Target`""
    }
    return $arguments
}
function Invoke-CandidateBroker {
    param(
        [Parameter(Mandatory = $true)]$CandidateCredential,
        [Parameter(Mandatory = $true)][string]$CandidateSid
    )
    $brokerSid = Get-CurrentPrincipalSid
    if ([StringComparer]::Ordinal.Equals($brokerSid, 'S-1-5-18')) {
        throw 'candidate broker must not run as SYSTEM'
    }
    $lastRequestId = $null
    while (-not (Test-Path -LiteralPath $brokerStopPath -PathType Leaf)) {
        if (-not (Test-Path -LiteralPath $brokerRequestPath -PathType Leaf)) {
            Start-Sleep -Milliseconds 100
            continue
        }
        $request = $null
        $requestId = $null
        try {
            $request = Get-Content -LiteralPath $brokerRequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $requestId = [string]$request.requestId
            if (
                [string]::IsNullOrWhiteSpace($requestId) -or
                [StringComparer]::Ordinal.Equals($requestId, [string]$lastRequestId)
            ) {
                Start-Sleep -Milliseconds 100
                continue
            }
            if (-not [StringComparer]::Ordinal.Equals([string]$request.controllerSid, 'S-1-5-18')) {
                throw 'candidate request was not issued by SYSTEM'
            }
            $arguments = Get-CandidateProcessArguments `
                -Operation ([string]$request.operation) `
                -CandidateSid $CandidateSid `
                -Target ([string]$request.target)
            $process = Start-Process `
                -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
                -ArgumentList $arguments `
                -Credential $CandidateCredential `
                -LoadUserProfile `
                -WorkingDirectory "$env:SystemRoot\Temp" `
                -WindowStyle Hidden `
                -Wait `
                -PassThru
            $response = [ordered]@{
                requestId = $requestId
                brokerSid = $brokerSid
                exitCode = [int]$process.ExitCode
                error = $null
            }
        } catch {
            $response = [ordered]@{
                requestId = $requestId
                brokerSid = $brokerSid
                exitCode = $null
                error = $_.Exception.Message
            }
        }
        Write-AtomicJson -LiteralPath $brokerResponsePath -Value $response
        $lastRequestId = $requestId
    }
}
function Invoke-CandidateProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Operation,
        [string]$Target,
        [int]$ExpectedExitCode = 0
    )
    $requestId = [Guid]::NewGuid().ToString('N')
    Remove-Item -LiteralPath $brokerResponsePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $brokerRequestPath -Force -ErrorAction SilentlyContinue
    $request = [ordered]@{
        requestId = $requestId
        controllerSid = Get-CurrentPrincipalSid
        operation = $Operation
        target = $Target
    }
    try {
        Write-AtomicJson -LiteralPath $brokerRequestPath -Value $request
        $deadline = [DateTime]::UtcNow.AddMinutes(5)
        while (-not (Test-Path -LiteralPath $brokerResponsePath -PathType Leaf)) {
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "candidate operation $Operation broker response timed out"
            }
            Start-Sleep -Milliseconds 100
        }
        $response = Get-Content -LiteralPath $brokerResponsePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not [StringComparer]::Ordinal.Equals([string]$response.requestId, $requestId)) {
            throw "candidate operation $Operation received a mismatched broker response"
        }
        if (
            [string]::IsNullOrWhiteSpace([string]$response.brokerSid) -or
            [StringComparer]::Ordinal.Equals([string]$response.brokerSid, 'S-1-5-18') -or
            [StringComparer]::Ordinal.Equals([string]$response.brokerSid, $script:CandidateSid)
        ) {
            throw "candidate operation $Operation received an invalid broker identity"
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$response.error)) {
            throw "candidate operation $Operation broker failed: $([string]$response.error)"
        }
        if ([int]$response.exitCode -ne $ExpectedExitCode) {
            throw "candidate operation $Operation failed with exit code $([int]$response.exitCode)"
        }
    } finally {
        Remove-Item -LiteralPath $brokerRequestPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $brokerResponsePath -Force -ErrorAction SilentlyContinue
    }
}
function Enter-CandidateRegistryHive {
    $sidRoot = "Registry::HKEY_USERS\$script:CandidateSid"
    if (Test-Path -LiteralPath $sidRoot -PathType Container) {
        return [pscustomobject]@{ Root = $sidRoot; Mounted = $false; MountName = $null }
    }
    $profileRoot = Get-CandidateProfileRoot -Sid $script:CandidateSid
    $hivePath = Join-Path $profileRoot 'NTUSER.DAT'
    if (-not (Test-Path -LiteralPath $hivePath -PathType Leaf)) {
        throw 'candidate user registry hive is missing'
    }
    $mountName = 'WhiteLilyLifecycleHive'
    $mountRoot = "Registry::HKEY_USERS\$mountName"
    if (Test-Path -LiteralPath $mountRoot) {
        & "$env:SystemRoot\System32\reg.exe" unload "HKU\$mountName" | Out-Null
    }
    & "$env:SystemRoot\System32\reg.exe" load "HKU\$mountName" $hivePath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'candidate user registry hive could not be loaded' }
    return [pscustomobject]@{ Root = $mountRoot; Mounted = $true; MountName = $mountName }
}
function Exit-CandidateRegistryHive {
    param([Parameter(Mandatory = $true)]$Hive)
    if (-not $Hive.Mounted) { return }
    $unloadDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $unloadDeadline) {
        [GC]::Collect()
        [GC]::WaitForPendingFinalizers()
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & "$env:SystemRoot\System32\reg.exe" `
                unload `
                "HKU\$($Hive.MountName)" 2>$null | Out-Null
            $unloadExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($unloadExitCode -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    throw 'candidate user registry hive remained mounted after bounded unload'
}
function Get-CandidateRegistryRoots {
    param([Parameter(Mandatory = $true)]$Hive)
    return @(
        "$($Hive.Root)\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        "$($Hive.Root)\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
    )
}
function Assert-CandidateProductEntry {
    param([Parameter(Mandatory = $true)][string]$Version, [Parameter(Mandatory = $true)][string]$ProgramRoot)
    $hive = Enter-CandidateRegistryHive
    try {
        Assert-WhiteLilyProductEntry `
            -ExpectedVersion $Version `
            -ProgramRoot $ProgramRoot `
            -RegistryRoots (Get-CandidateRegistryRoots $hive)
    } finally {
        Exit-CandidateRegistryHive $hive
    }
}
function Get-CandidateProductEntryCount {
    $hive = Enter-CandidateRegistryHive
    try {
        return @(Get-WhiteLilyProductEntries -RegistryRoots (Get-CandidateRegistryRoots $hive)).Count
    } finally {
        Exit-CandidateRegistryHive $hive
    }
}
function Assert-CandidateRemoval {
    param(
        [Parameter(Mandatory = $true)][string]$ProgramRoot,
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][bool]$KeepData
    )
    Start-Sleep -Milliseconds 500
    Assert-WhiteLilyRemovalState `
        -ProgramRoot $ProgramRoot `
        -DataRoot $DataRoot `
        -ProductEntryCount (Get-CandidateProductEntryCount) `
        -KeepData $KeepData
}
function Stop-CandidateProcesses {
    $expectedUser = "$env:COMPUTERNAME\$CandidateUsername"
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $owned = @(
            Get-Process -IncludeUserName -ErrorAction SilentlyContinue |
                Where-Object {
                    [StringComparer]::OrdinalIgnoreCase.Equals([string]$_.UserName, $expectedUser)
                }
        )
        foreach ($process in $owned) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        if ($owned.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'candidate user processes remained after bounded cleanup'
}

if ($Mode -eq 'Bootstrap') {
    try {
        if ([string]::IsNullOrWhiteSpace($CandidatePassword)) {
            throw 'candidate password is required for bootstrap'
        }
        $reportKeyHex = (
            Get-Content -LiteralPath 'C:\WhiteLilyReport\bootstrap-secret.txt' -Raw -Encoding UTF8
        ).Trim()
        if ($reportKeyHex -notmatch '^[0-9a-f]{64}$') {
            throw 'host lifecycle report key is invalid'
        }
        New-Item -ItemType Directory -Path $trustedControlRoot -Force | Out-Null
        & "$env:SystemRoot\System32\icacls.exe" $trustedControlRoot `
            '/inheritance:r' `
            '/grant:r' `
            '*S-1-5-18:(OI)(CI)F' `
            '*S-1-5-32-544:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'could not protect local lifecycle control directory' }
        [System.IO.File]::WriteAllText(
            $reportSecretPath,
            $reportKeyHex + "`n",
            [System.Text.UTF8Encoding]::new($false)
        )
        Remove-Item -LiteralPath 'C:\WhiteLilyReport\bootstrap-secret.txt' -Force
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $candidateCreationOutput = @(
                & "$env:SystemRoot\System32\net.exe" `
                    user `
                    $CandidateUsername `
                    $CandidatePassword `
                    /add `
                    /expires:never `
                    /passwordchg:no 2>&1
            )
            $candidateCreationExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($candidateCreationExitCode -ne 0) {
            throw "candidate user creation failed with exit code $candidateCreationExitCode`: $($candidateCreationOutput -join ' | ')"
        }
        $candidateSid = Get-CandidateSid
        $administrators = @(Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop)
        if (@($administrators | Where-Object { $_.SID.Value -eq $candidateSid }).Count -ne 0) {
            throw 'candidate user unexpectedly belongs to Administrators'
        }
        $securePassword = ConvertTo-SecureString $CandidatePassword -AsPlainText -Force
        $candidateCredential = [Management.Automation.PSCredential]::new(
            "$env:COMPUTERNAME\$CandidateUsername",
            $securePassword
        )
        $controllerArguments = '-NoProfile -ExecutionPolicy Bypass -File "C:\WhiteLilyReport\guest-lifecycle.ps1"' +
            ' -Mode Controller' +
            " -InstallerName `"$InstallerName`" -InstallerSha256 `"$InstallerSha256`"" +
            " -ExpectedVersion `"$ExpectedVersion`"" +
            " -BaselineInstallerName `"$BaselineInstallerName`"" +
            " -BaselineInstallerSha256 `"$BaselineInstallerSha256`"" +
            " -BaselineVersion `"$BaselineVersion`"" +
            " -CandidateUsername `"$CandidateUsername`""
        $action = New-ScheduledTaskAction `
            -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
            -Argument $controllerArguments
        $principal = New-ScheduledTaskPrincipal `
            -UserId 'SYSTEM' `
            -LogonType ServiceAccount `
            -RunLevel Highest
        $trigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(1))
        Register-ScheduledTask `
            -TaskName 'WhiteLilyInstallerLifecycle' `
            -Action $action `
            -Principal $principal `
            -Trigger $trigger `
            -Force | Out-Null
        Start-ScheduledTask -TaskName 'WhiteLilyInstallerLifecycle'
        Invoke-CandidateBroker `
            -CandidateCredential $candidateCredential `
            -CandidateSid $candidateSid
    } catch {
        [System.IO.File]::WriteAllText(
            'C:\WhiteLilyReport\bootstrap-error.txt',
            $_.Exception.ToString(),
            [System.Text.UTF8Encoding]::new($false)
        )
        Start-Process `
            -FilePath "$env:SystemRoot\System32\shutdown.exe" `
            -ArgumentList @('/s', '/t', '0') `
            -WindowStyle Hidden
        exit 1
    }
    exit 0
}
try {
    if ($Mode -eq 'Controller') {
        $result.controllerSid = Get-CurrentPrincipalSid
        if (-not [StringComparer]::Ordinal.Equals([string]$result.controllerSid, 'S-1-5-18')) {
            throw 'trusted lifecycle controller is not running as SYSTEM'
        }
        $script:CandidateSid = Get-CandidateSid
        $result.candidateSid = $script:CandidateSid
        $result.stages.Add('controller_identity_verified')
    }
    if ($Mode -eq 'Candidate') {
        if (
            [string]::IsNullOrWhiteSpace($ExpectedCandidateSid) -or
            -not [StringComparer]::Ordinal.Equals(
                (Get-CurrentPrincipalSid),
                $ExpectedCandidateSid
            )
        ) {
            throw 'candidate process principal mismatch'
        }
    }
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
    if ($Mode -eq 'Controller') {
        $result.controllerObservedInstallerSha256 = $actualHash
        $result.controllerObservedBaselineInstallerSha256 = $actualBaselineHash
    }
    $result.stages.Add('hashes_verified')

    $profileRoot = if ($Mode -eq 'Controller') {
        Get-CandidateProfileRoot -Sid $script:CandidateSid
    } else {
        [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    }
    $localAppDataRoot = Join-Path $profileRoot 'AppData\Local'
    $programRoot = Join-Path $localAppDataRoot 'Programs\WhiteLily'
    $dataRoot = Join-Path $localAppDataRoot 'WhiteLily'
    $application = Join-Path $programRoot 'WhiteLily.exe'
    $freshPreferencesJson = '{"schemaVersion":1,"bridgeEnabled":true,"avatarEnabled":true}'
    $preservedPreferencesJson = '{"schemaVersion":1,"bridgeEnabled":false,"avatarEnabled":false}'

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

    if ($Mode -eq 'Candidate') {
        switch ($CandidateOperation) {
            'forge_report' {
                try {
                    [System.IO.File]::WriteAllText(
                        $resultPath,
                        '{"forged":true}',
                        [System.Text.UTF8Encoding]::new($false)
                    )
                    exit 91
                } catch [System.UnauthorizedAccessException] {
                    exit 73
                }
            }
            'install' {
                Invoke-Process $CandidateTarget @('/S')
                exit 0
            }
            'smoke' {
                Invoke-WhiteLilySmoke $CandidateTarget
                exit 0
            }
            'uninstall_keep' {
                Invoke-Process $CandidateTarget @('/S')
                exit 0
            }
            'uninstall_delete' {
                Invoke-DeleteDataUninstall -ProgramRoot $programRoot -DataRoot $dataRoot
                exit 0
            }
            default { throw "unsupported candidate operation: $CandidateOperation" }
        }
    }

    Invoke-CandidateProcess -Operation 'forge_report' -ExpectedExitCode 73
    if (Test-Path -LiteralPath $resultPath) {
        throw 'candidate user forged the trusted lifecycle report'
    }
    $result.candidateReportWriteDenied = $true
    $result.stages.Add('candidate_write_denied')

    $profileRoot = Get-CandidateProfileRoot -Sid $script:CandidateSid
    $localAppDataRoot = Join-Path $profileRoot 'AppData\Local'
    $programRoot = Join-Path $localAppDataRoot 'Programs\WhiteLily'
    $dataRoot = Join-Path $localAppDataRoot 'WhiteLily'
    $application = Join-Path $programRoot 'WhiteLily.exe'

    Invoke-CandidateProcess -Operation 'install' -Target $installer
    if (-not (Test-Path -LiteralPath $application -PathType Leaf)) {
        throw 'WhiteLily application was not installed'
    }
    Assert-CandidateProductEntry -Version $ExpectedVersion -ProgramRoot $programRoot
    $result.minecraftComponentResources = Assert-ReviewedMinecraftComponentResources `
        -ProgramRoot $programRoot `
        -ReviewedFiles $reviewedMinecraftComponentFiles
    Assert-ExactComponentPreferences `
        -DataRoot $dataRoot `
        -ExpectedJson $freshPreferencesJson
    $result.componentPreferencesFresh = $true
    $result.stages.Add('clean_installed')
    Invoke-CandidateProcess -Operation 'smoke' -Target $application
    $result.managedWorkspaceResources = Assert-ManagedWorkspace `
        -ProgramRoot $programRoot `
        -DataRoot $dataRoot
    $result.stages.Add('clean_workspace_verified')

    Invoke-CandidateProcess -Operation 'uninstall_delete'
    Assert-CandidateRemoval -ProgramRoot $programRoot -DataRoot $dataRoot -KeepData $false
    $result.stages.Add('clean_delete_data')

    Invoke-CandidateProcess -Operation 'install' -Target $baselineInstaller
    Assert-CandidateProductEntry -Version $BaselineVersion -ProgramRoot $programRoot
    $result.stages.Add('beta1_installed')

    New-Item -ItemType Directory -Path (Join-Path $dataRoot 'codex-workspace\.codex') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $dataRoot 'config') -Force | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $dataRoot 'config\minecraft-components.json'),
        $preservedPreferencesJson,
        [System.Text.UTF8Encoding]::new($false)
    )
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

    Invoke-CandidateProcess -Operation 'install' -Target $installer
    Assert-CandidateProductEntry -Version $ExpectedVersion -ProgramRoot $programRoot
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw 'beta.1 data marker was removed during upgrade'
    }
    Assert-ExactComponentPreferences `
        -DataRoot $dataRoot `
        -ExpectedJson $preservedPreferencesJson
    $result.componentPreferencesUpgradePreserved = $true
    $result.minecraftComponentResources = Assert-ReviewedMinecraftComponentResources `
        -ProgramRoot $programRoot `
        -ReviewedFiles $reviewedMinecraftComponentFiles
    $result.stages.Add('beta1_upgraded')
    Invoke-CandidateProcess -Operation 'smoke' -Target $application
    $result.managedWorkspaceResources = Assert-ManagedWorkspace `
        -ProgramRoot $programRoot `
        -DataRoot $dataRoot
    if (Test-Path -LiteralPath (Join-Path $dataRoot 'codex-workspace\obsolete.txt')) {
        throw 'beta.1 workspace drift was not repaired'
    }
    $result.stages.Add('workspace_repaired')

    $uninstaller = Get-Uninstaller $programRoot
    Invoke-CandidateProcess -Operation 'uninstall_keep' -Target $uninstaller
    Assert-CandidateRemoval -ProgramRoot $programRoot -DataRoot $dataRoot -KeepData $true
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw 'silent Keep Data uninstall removed the beta.1 data marker'
    }
    Assert-ExactComponentPreferences `
        -DataRoot $dataRoot `
        -ExpectedJson $preservedPreferencesJson
    $result.stages.Add('keep_data')

    Invoke-CandidateProcess -Operation 'install' -Target $installer
    Assert-CandidateProductEntry -Version $ExpectedVersion -ProgramRoot $programRoot
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw 'reinstall did not preserve the beta.1 data marker'
    }
    Assert-ExactComponentPreferences `
        -DataRoot $dataRoot `
        -ExpectedJson $preservedPreferencesJson
    $result.componentPreferencesKeepPreserved = $true
    $result.minecraftComponentResources = Assert-ReviewedMinecraftComponentResources `
        -ProgramRoot $programRoot `
        -ReviewedFiles $reviewedMinecraftComponentFiles
    Invoke-CandidateProcess -Operation 'smoke' -Target $application
    $result.managedWorkspaceResources = Assert-ManagedWorkspace `
        -ProgramRoot $programRoot `
        -DataRoot $dataRoot
    $result.installedVersion = $ExpectedVersion
    $result.stages.Add('reinstalled')

    Invoke-CandidateProcess -Operation 'uninstall_delete'
    Assert-CandidateRemoval -ProgramRoot $programRoot -DataRoot $dataRoot -KeepData $false
    $result.stages.Add('delete_data')
    $result.success = $true
} catch {
    $result.error = $_.Exception.Message
    if ($Mode -eq 'Candidate') { exit 92 }
} finally {
    if ($Mode -eq 'Controller') {
        try {
            Stop-CandidateProcesses
            & "$env:SystemRoot\System32\net.exe" user $CandidateUsername /delete | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'could not remove disposable candidate user' }
            $result.stages.Add('candidate_principal_removed')
        } catch {
            $result.success = $false
            if ([string]::IsNullOrWhiteSpace([string]$result.error)) {
                $result.error = $_.Exception.Message
            }
        }
        Unregister-ScheduledTask `
            -TaskName 'WhiteLilyInstallerLifecycle' `
            -Confirm:$false `
            -ErrorAction SilentlyContinue
        [System.IO.File]::WriteAllText(
            $brokerStopPath,
            "stop`n",
            [System.Text.UTF8Encoding]::new($false)
        )
        & "$env:SystemRoot\System32\icacls.exe" $trustedControlRoot `
            '/inheritance:r' `
            '/grant:r' `
            '*S-1-5-18:(OI)(CI)F' `
            '*S-1-5-32-544:(OI)(CI)F' | Out-Null
        $shutdownGuard = [System.IO.File]::Open(
            $mappedShutdownGuardPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        try {
            Publish-AuthenticatedLifecycleResult -Value $result
            try {
                $shutdownProcess = Start-Process `
                    -FilePath "$env:SystemRoot\System32\shutdown.exe" `
                    -ArgumentList @('/s', '/t', '0') `
                    -WindowStyle Hidden `
                    -Wait `
                    -PassThru
                if ($shutdownProcess.ExitCode -ne 0) {
                    throw "shutdown.exe exited with code $($shutdownProcess.ExitCode)"
                }
            } catch {
                $result.success = $false
                $shutdownError = "guest shutdown command failed: $($_.Exception.Message)"
                if ([string]::IsNullOrWhiteSpace([string]$result.error)) {
                    $result.error = $shutdownError
                } else {
                    $result.error = "$([string]$result.error); $shutdownError"
                }
                Publish-AuthenticatedLifecycleResult -Value $result
            }
            while ($true) {
                Start-Sleep -Seconds 1
            }
        } finally {
            $shutdownGuard.Dispose()
        }
    }
}
'@
$guestScript = $guestScript.Replace(
    '__WHITELILY_REVIEWED_COMPONENT_VERIFIER__',
    $componentVerifierSource
).Replace(
    '__WHITELILY_REVIEWED_COMPONENT_POLICY__',
    $componentPolicyBase64
)
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($guestScriptPath, $guestScript, $utf8)

$candidateUsername = 'WhiteLilyCandidate'
$candidatePassword = 'WL!' + [Guid]::NewGuid().ToString('N').Substring(0, 11)
$guestCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\WhiteLilyReport\guest-lifecycle.ps1"' +
    ' -Mode Bootstrap' +
    " -InstallerName `"$installerName`" -InstallerSha256 `"$installerHash`"" +
    " -ExpectedVersion `"$version`"" +
    " -BaselineInstallerName `"$([System.IO.Path]::GetFileName($resolvedBaselineInstaller))`"" +
    " -BaselineInstallerSha256 `"$baselineInstallerHash`"" +
    " -BaselineVersion `"$baselineVersion`"" +
    " -CandidateUsername `"$candidateUsername`" -CandidatePassword `"$candidatePassword`""
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
$allowSandboxCleanup = $false
try {
    try {
        $sandboxProcess = Start-Process `
            -FilePath $sandboxExecutable `
            -ArgumentList @($sandboxConfigurationPath) `
            -PassThru
    } catch {
        throw 'WINDOWS_SANDBOX_REQUIRED'
    }

    $sandboxTimeoutSeconds = 1200
    if (
        -not [string]::IsNullOrWhiteSpace($env:WHITELILY_SANDBOX_TIMEOUT_SECONDS) -and
        -not [int]::TryParse(
            $env:WHITELILY_SANDBOX_TIMEOUT_SECONDS,
            [ref]$sandboxTimeoutSeconds
        )
    ) {
        throw 'INVALID_SANDBOX_TIMEOUT'
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($sandboxTimeoutSeconds)
    $bootstrapErrorPath = Join-Path $reportRoot 'bootstrap-error.txt'
    $trustedEnvelope = $null
    while ($null -eq $trustedEnvelope) {
        $trustedEnvelope = Get-TrustedSandboxEnvelope `
            -LiteralPath $sandboxResultPath `
            -KeyHex $reportKeyHex
        if ($null -ne $trustedEnvelope) { break }
        if ([DateTime]::UtcNow -ge $deadline) {
            if ($sandboxProcess.HasExited) {
                throw "SANDBOX_LIFECYCLE_REPORT_MISSING: close the Windows Sandbox window manually; mapped lifecycle artifacts were retained at $sandboxRoot"
            }
            throw "SANDBOX_LIFECYCLE_TIMEOUT: close the exact Windows Sandbox window manually; mapped lifecycle artifacts were retained at $sandboxRoot"
        }
        if ($sandboxProcess.HasExited -and $sandboxProcess.ExitCode -ne 0) {
            throw "SANDBOX_LIFECYCLE_PROCESS_FAILED: $($sandboxProcess.ExitCode)"
        }
        if (Test-Path -LiteralPath $bootstrapErrorPath -PathType Leaf) {
            $bootstrapError = Get-Content -LiteralPath $bootstrapErrorPath -Raw -Encoding UTF8
            throw "SANDBOX_LIFECYCLE_BOOTSTRAP_FAILED: $bootstrapError"
        }
        Start-Sleep -Seconds 2
    }
    $shutdownGuardTimeoutSeconds = 120
    if (
        -not [string]::IsNullOrWhiteSpace($env:WHITELILY_SHUTDOWN_GUARD_TIMEOUT_SECONDS) -and
        (
            -not [int]::TryParse(
                $env:WHITELILY_SHUTDOWN_GUARD_TIMEOUT_SECONDS,
                [ref]$shutdownGuardTimeoutSeconds
            ) -or
            $shutdownGuardTimeoutSeconds -lt 1
        )
    ) {
        throw 'INVALID_SHUTDOWN_GUARD_TIMEOUT'
    }
    Wait-ShutdownGuardRelease `
        -LiteralPath $shutdownGuardPath `
        -SandboxRoot $sandboxRoot `
        -TimeoutSeconds $shutdownGuardTimeoutSeconds
    $trustedEnvelope = Get-TrustedSandboxEnvelope `
        -LiteralPath $sandboxResultPath `
        -KeyHex $reportKeyHex
    if ($null -eq $trustedEnvelope) {
        throw "SANDBOX_LIFECYCLE_UNTRUSTED_REPORT: mapped lifecycle artifacts were retained at $sandboxRoot"
    }
    $sandboxProcessDeadline = [DateTime]::UtcNow.AddMinutes(2)
    while (-not $sandboxProcess.HasExited) {
        if ([DateTime]::UtcNow -ge $sandboxProcessDeadline) {
            throw "SANDBOX_PROCESS_TIMEOUT: close the exact Windows Sandbox process manually; mapped lifecycle artifacts were retained at $sandboxRoot"
        }
        Start-Sleep -Milliseconds 250
    }
    if ($sandboxProcess.ExitCode -ne 0) {
        throw "SANDBOX_LIFECYCLE_PROCESS_FAILED: $($sandboxProcess.ExitCode)"
    }
    $allowSandboxCleanup = $true

    $report = $trustedEnvelope.Report
    if (
        [int]$report.schemaVersion -ne 2 -or
        -not [StringComparer]::Ordinal.Equals([string]$report.controllerSid, 'S-1-5-18') -or
        -not ([string]$report.candidateSid).StartsWith('S-1-5-21-', [StringComparison]::Ordinal) -or
        -not [StringComparer]::Ordinal.Equals([string]$report.installerSha256, $installerHash) -or
        -not [StringComparer]::Ordinal.Equals(
            [string]$report.controllerObservedInstallerSha256,
            $installerHash
        ) -or
        -not [StringComparer]::Ordinal.Equals([string]$report.expectedVersion, $version) -or
        -not [StringComparer]::Ordinal.Equals(
            [string]$report.baselineInstallerSha256,
            $baselineInstallerHash
        ) -or
        -not [StringComparer]::Ordinal.Equals(
            [string]$report.controllerObservedBaselineInstallerSha256,
            $baselineInstallerHash
        )
    ) {
        throw 'SANDBOX_LIFECYCLE_UNTRUSTED_REPORT'
    }
    [System.IO.File]::WriteAllText(
        $resolvedReport,
        $trustedEnvelope.Payload + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )

    $expectedStages = @(
        'controller_identity_verified',
        'isolated_path',
        'hashes_verified',
        'candidate_write_denied',
        'clean_installed',
        'clean_workspace_verified',
        'clean_delete_data',
        'beta1_installed',
        'beta1_data_root_prepared',
        'beta1_upgraded',
        'workspace_repaired',
        'keep_data',
        'reinstalled',
        'delete_data',
        'candidate_principal_removed'
    )
    $actualStages = @($report.stages | ForEach-Object { [string]$_ })
    if (
        $report.candidateReportWriteDenied -ne $true -or
        -not [StringComparer]::Ordinal.Equals([string]$report.installedVersion, $version) -or
        [int]$report.managedWorkspaceResources -ne 3 -or
        [int]$report.minecraftComponentResources -ne 9 -or
        $report.componentPreferencesFresh -ne $true -or
        $report.componentPreferencesUpgradePreserved -ne $true -or
        $report.componentPreferencesKeepPreserved -ne $true -or
        $report.success -ne $true -or
        -not [System.Linq.Enumerable]::SequenceEqual([string[]]$actualStages, [string[]]$expectedStages)
    ) {
        throw "SANDBOX_LIFECYCLE_FAILED: $([string]$report.error)"
    }
    $lifecycleOutput = $report | ConvertTo-Json -Compress
} catch {
    $lifecycleError = $_
} finally {
    try {
        if (
            $allowSandboxCleanup -and
            (Test-Path -LiteralPath $sandboxRoot) -and
            $sandboxRoot.StartsWith($sandboxPrefix, [StringComparison]::OrdinalIgnoreCase)
        ) {
            Remove-InstallerSandboxTreeNoFollow `
                -SandboxRoot $sandboxRoot `
                -ReportRoot $reportRoot `
                -ConfigurationPath $sandboxConfigurationPath
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
