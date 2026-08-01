[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$ReleaseRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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

function Invoke-CheckedNpm {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & npm @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "NPM_COMMAND_FAILED: npm $($Arguments -join ' ')"
    }
}

$prereleaseIdentifier = '(?:(?:0|[1-9][0-9]*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))'
$semanticVersion = "^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-$prereleaseIdentifier(?:\.$prereleaseIdentifier)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
if ($Version -cnotmatch $semanticVersion) {
    throw 'INVALID_SEMANTIC_VERSION'
}

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$expectedReleaseRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'release'))
$resolvedReleaseRoot = if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
    $expectedReleaseRoot
} else {
    Resolve-FullPath $ReleaseRoot $repositoryRoot
}
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($resolvedReleaseRoot, $expectedReleaseRoot)) {
    throw 'UNSAFE_RELEASE_ROOT'
}

$gitRoot = @(& git -C $repositoryRoot rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0 -or $gitRoot.Count -ne 1) {
    throw 'GIT_REPOSITORY_REQUIRED'
}
$resolvedGitRoot = [System.IO.Path]::GetFullPath([string]$gitRoot[0])
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($resolvedGitRoot, $repositoryRoot)) {
    throw 'GIT_REPOSITORY_REQUIRED'
}
$trackedStatus = @(& git -C $repositoryRoot status --porcelain=v1 --untracked-files=no)
if ($LASTEXITCODE -ne 0 -or $trackedStatus.Count -ne 0) {
    throw 'CLEAN_TRACKED_TREE_REQUIRED'
}

$rootPackage = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$desktopPackage = Get-Content -LiteralPath (Join-Path $repositoryRoot 'apps/desktop/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (
    -not [StringComparer]::Ordinal.Equals([string]$rootPackage.version, $Version) -or
    -not [StringComparer]::Ordinal.Equals([string]$desktopPackage.version, $Version)
) {
    throw 'PACKAGE_VERSION_MISMATCH'
}

$installerName = "WhiteLily-$Version-windows-x64-setup.exe"
$builderRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'build/electron-installer'))
$builderInstaller = [System.IO.Path]::GetFullPath((Join-Path $builderRoot $installerName))
$builderPrefix = $builderRoot.TrimEnd('\') + '\'
if (-not $builderInstaller.StartsWith($builderPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'UNSAFE_BUILDER_OUTPUT'
}

Push-Location $repositoryRoot
try {
    Invoke-CheckedNpm @('run', 'desktop:prepare')
    Invoke-CheckedNpm @('run', 'desktop:build')
    Invoke-CheckedNpm @('run', 'desktop:package:builder')
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $builderInstaller -PathType Leaf)) {
    throw 'BUILT_INSTALLER_MISSING'
}
$inspectionOutput = @(
    & (Join-Path $PSScriptRoot 'inspect-installer.ps1') `
        -InstallerPath $builderInstaller `
        -ExpectedVersion $Version
)
if ($LASTEXITCODE -ne 0 -or $inspectionOutput.Count -ne 1) {
    throw 'BUILT_INSTALLER_INSPECTION_FAILED'
}
$inspection = [string]$inspectionOutput[0] | ConvertFrom-Json

New-Item -ItemType Directory -Path $resolvedReleaseRoot -Force | Out-Null
$releaseInstaller = [System.IO.Path]::GetFullPath((Join-Path $resolvedReleaseRoot $installerName))
$releasePrefix = $resolvedReleaseRoot.TrimEnd('\') + '\'
if (-not $releaseInstaller.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'UNSAFE_RELEASE_OUTPUT'
}
Copy-Item -LiteralPath $builderInstaller -Destination $releaseInstaller -Force

$releaseInspectionOutput = @(
    & (Join-Path $PSScriptRoot 'inspect-installer.ps1') `
        -InstallerPath $releaseInstaller `
        -ExpectedVersion $Version
)
if ($LASTEXITCODE -ne 0 -or $releaseInspectionOutput.Count -ne 1) {
    throw 'RELEASE_INSTALLER_INSPECTION_FAILED'
}
$releaseInspection = [string]$releaseInspectionOutput[0] | ConvertFrom-Json
if (
    -not [StringComparer]::Ordinal.Equals([string]$inspection.sha256, [string]$releaseInspection.sha256) -or
    -not [StringComparer]::Ordinal.Equals([string]$inspection.signingStatus, [string]$releaseInspection.signingStatus)
) {
    throw 'RELEASE_INSTALLER_COPY_MISMATCH'
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
$sha256Path = "$releaseInstaller.sha256"
$signingStatusPath = "$releaseInstaller.signing-status.txt"
[System.IO.File]::WriteAllText(
    $sha256Path,
    "$([string]$releaseInspection.sha256)  $installerName`n",
    $utf8
)
[System.IO.File]::WriteAllText(
    $signingStatusPath,
    "$([string]$releaseInspection.signingStatus)`n",
    $utf8
)

Write-Output ($releaseInspection | ConvertTo-Json -Compress)
