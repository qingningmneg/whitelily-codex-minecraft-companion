[CmdletBinding()]
param(
    [string]$BundlePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'build'))
$expectedBundle = [System.IO.Path]::GetFullPath((Join-Path $buildRoot 'electron-bundle'))
$resolvedBundle = if ([string]::IsNullOrWhiteSpace($BundlePath)) {
    $expectedBundle
} else {
    [System.IO.Path]::GetFullPath($BundlePath, $repositoryRoot)
}
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($resolvedBundle, $expectedBundle)) {
    throw 'Electron bundle target must be the exact repository build/electron-bundle directory'
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

$sourceManifestPath = Join-Path $repositoryRoot 'packaging/electron/runtime-manifest.json'
$sourceManifest = Get-Content -LiteralPath $sourceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$policySha256 = Get-Sha256Hex $sourceManifestPath
$rootPackage = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$desktopPackage = Get-Content -LiteralPath (Join-Path $repositoryRoot 'apps/desktop/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$verifiedProductVersion = & node (Join-Path $PSScriptRoot 'verify-product-versions.mjs') $repositoryRoot
if ($LASTEXITCODE -ne 0) {
    throw "product version verification failed with exit code $LASTEXITCODE"
}
$lockVersionsJson = & node -e @'
const lock = require('./package-lock.json');
process.stdout.write(JSON.stringify({
  codex: lock.packages['node_modules/@openai/codex']?.version,
  nativeCodex: lock.packages['node_modules/@openai/codex-win32-x64']?.version
}));
'@
if ($LASTEXITCODE -ne 0) {
    throw "package-lock version inspection failed with exit code $LASTEXITCODE"
}
$lockVersions = $lockVersionsJson | ConvertFrom-Json

function Assert-ExactValue {
    param(
        [Parameter(Mandatory = $true)]$Actual,
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not [StringComparer]::Ordinal.Equals([string]$Actual, [string]$Expected)) {
        throw "$Label version mismatch: expected $Expected, received $Actual"
    }
}

Assert-ExactValue $verifiedProductVersion $sourceManifest.productVersion 'verified product'
Assert-ExactValue $desktopPackage.devDependencies.electron $sourceManifest.versions.electron 'Electron'
Assert-ExactValue $desktopPackage.devDependencies.'electron-builder' $sourceManifest.versions.electronBuilder 'electron-builder'
Assert-ExactValue $rootPackage.dependencies.'@openai/codex' $sourceManifest.versions.codex 'Codex'
Assert-ExactValue $lockVersions.codex $sourceManifest.versions.codex 'locked Codex'
Assert-ExactValue $lockVersions.nativeCodex $sourceManifest.versions.codexNative 'locked native Codex'

$codexPackageRoot = Join-Path $repositoryRoot 'node_modules/@openai/codex'
$codexNativeRoot = Join-Path $repositoryRoot 'node_modules/@openai/codex-win32-x64'
$installedCodex = Get-Content -LiteralPath (Join-Path $codexPackageRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$installedNativeCodex = Get-Content -LiteralPath (Join-Path $codexNativeRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-ExactValue $installedCodex.version $sourceManifest.versions.codex 'installed Codex'
Assert-ExactValue $installedNativeCodex.version $sourceManifest.versions.codexNative 'installed native Codex'

function Invoke-CheckedNpm {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    & npm @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Get-RelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )
    $baseUri = [Uri]([System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar)
    $targetUri = [Uri][System.IO.Path]::GetFullPath($TargetPath)
    return [Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
}

function Assert-ReviewedFile {
    param(
        [Parameter(Mandatory = $true)]$Entry
    )
    $path = Join-Path $repositoryRoot ([string]$Entry.source)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "reviewed source dependency is missing: $($Entry.source)"
    }
    $file = Get-Item -LiteralPath $path
    $hash = Get-Sha256Hex $path
    if ($file.Length -ne [long]$Entry.bytes -or -not [StringComparer]::Ordinal.Equals($hash, [string]$Entry.sha256)) {
        throw "reviewed source dependency hash mismatch: $($Entry.source)"
    }
}

foreach ($entry in $sourceManifest.allowlist.exactFiles) {
    Assert-ReviewedFile $entry
}

Invoke-CheckedNpm @('run', 'build')
Invoke-CheckedNpm @('run', 'build:desktop-child')
Invoke-CheckedNpm @('run', 'build', '--workspace', '@whitelily/desktop')

$packagedMainPath = Join-Path $repositoryRoot 'apps/desktop/dist/main/main.js'
& node (Join-Path $PSScriptRoot 'verify-electron-main-imports.mjs') $packagedMainPath
if ($LASTEXITCODE -ne 0) {
    throw "packaged Electron main import verification failed with exit code $LASTEXITCODE"
}

New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
$staging = Join-Path $buildRoot ('.electron-bundle-staging-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null

function Copy-AllowlistedDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [string[]]$AllowedExtensions,
        [string[]]$ForbiddenExtensions = @()
    )
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "required source directory is missing: $Source"
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $Source -Recurse -File -Force) {
        $extension = $entry.Extension.ToLowerInvariant()
        if ($ForbiddenExtensions -contains $extension) {
            continue
        }
        if ($null -ne $AllowedExtensions -and $AllowedExtensions.Count -gt 0 -and $AllowedExtensions -notcontains $extension) {
            continue
        }
        $relativePath = Get-RelativePath $Source $entry.FullName
        $destinationPath = Join-Path $Destination $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
        Copy-Item -LiteralPath $entry.FullName -Destination $destinationPath -Force
    }
}

try {
    $managedWorkspaceRoot = Join-Path $staging ([string]$sourceManifest.managedWorkspace.root)
    New-Item -ItemType Directory -Path $managedWorkspaceRoot | Out-Null
    & node `
        (Join-Path $PSScriptRoot 'build-codex-workspace.mjs') `
        (Join-Path $repositoryRoot 'codex-workspace') `
        $managedWorkspaceRoot
    if ($LASTEXITCODE -ne 0) {
        throw "managed Codex workspace build failed with exit code $LASTEXITCODE"
    }

    $coreRoot = Join-Path $staging 'core'
    foreach ($rule in $sourceManifest.allowlist.generatedRoots) {
        Copy-AllowlistedDirectory `
            (Join-Path $repositoryRoot ([string]$rule.source)) `
            (Join-Path $staging ([string]$rule.target)) `
            @($rule.extensions)
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $coreRoot 'childMain.js'),
        "import { runDesktopChild } from './desktop/childMain.js';`nawait runDesktopChild(process.argv.slice(2));`n",
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::WriteAllText(
        (Join-Path $coreRoot 'package.json'),
        "{`n  `"type`": `"module`"`n}`n",
        [System.Text.UTF8Encoding]::new($false)
    )

    $productionPackagePaths = @(& npm ls --omit=dev --all --parseable)
    if ($LASTEXITCODE -ne 0) {
        throw "npm ls --omit=dev failed with exit code $LASTEXITCODE"
    }
    $sourceNodeModules = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'node_modules'))
    $destinationNodeModules = Join-Path $coreRoot 'node_modules'
    $excludedPackages = @($sourceManifest.allowlist.productionDependencies.excludedPackages)
    $forbiddenExtensions = @($sourceManifest.allowlist.productionDependencies.forbiddenExtensions)
    foreach ($packagePath in $productionPackagePaths | Sort-Object -Unique) {
        if ([string]::IsNullOrWhiteSpace($packagePath)) { continue }
        $resolvedPackage = [System.IO.Path]::GetFullPath($packagePath)
        if (-not $resolvedPackage.StartsWith($sourceNodeModules + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $relativePackage = Get-RelativePath $sourceNodeModules $resolvedPackage
        $portablePackage = $relativePackage.Replace('\', '/')
        if ($excludedPackages -contains $portablePackage) {
            continue
        }
        $destinationPackage = Join-Path $destinationNodeModules $relativePackage
        New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPackage) -Force | Out-Null
        if (-not (Test-Path -LiteralPath $destinationPackage)) {
            Copy-AllowlistedDirectory $resolvedPackage $destinationPackage $null $forbiddenExtensions
        }
    }

    foreach ($entry in $sourceManifest.allowlist.exactFiles) {
        if ($null -eq $entry.target) { continue }
        $destinationPath = Join-Path $staging ([string]$entry.target)
        New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repositoryRoot ([string]$entry.source)) -Destination $destinationPath -Force
    }

    $licensesRoot = Join-Path $staging $sourceManifest.paths.licenses
    $codexNotice = @"
OpenAI Codex CLI $($sourceManifest.versions.codex)
Copyright OpenAI
Licensed under the Apache License, Version 2.0.
Package metadata and upstream notices are preserved under codex/package and codex/native.
"@
    [System.IO.File]::WriteAllText(
        (Join-Path $licensesRoot 'OpenAI-Codex-NOTICE.txt'),
        $codexNotice.Trim() + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )

    [string[]]$actualExecutables = @(
        Get-ChildItem -LiteralPath $staging -Recurse -File |
            Where-Object { $_.Extension -match '^\.(?:com|exe|msi)$' } |
            ForEach-Object { (Get-RelativePath $staging $_.FullName).Replace('\', '/') }
    )
    [Array]::Sort($actualExecutables, [StringComparer]::Ordinal)
    [string[]]$reviewedExecutables = @($sourceManifest.allowlist.executableFiles)
    [Array]::Sort($reviewedExecutables, [StringComparer]::Ordinal)
    if (-not [System.Linq.Enumerable]::SequenceEqual([string[]]$actualExecutables, [string[]]$reviewedExecutables)) {
        throw 'prepared Electron resources contain a missing or unreviewed executable'
    }
    foreach ($required in $sourceManifest.allowlist.requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $staging ([string]$required)) -PathType Leaf)) {
            throw "required reviewed Electron resource is missing: $required"
        }
    }

    [string[]]$resourceFiles = @(
        Get-ChildItem -LiteralPath $staging -Recurse -File |
            ForEach-Object { $_.FullName }
    )
    [Array]::Sort($resourceFiles, [StringComparer]::Ordinal)
    $resources = @(
        $resourceFiles |
            ForEach-Object {
                $resource = Get-Item -LiteralPath $_
                [ordered]@{
                    path = (Get-RelativePath $staging $resource.FullName).Replace('\', '/')
                    bytes = $resource.Length
                    sha256 = Get-Sha256Hex $resource.FullName
                }
            }
    )
    $bundleManifest = [ordered]@{
        schemaVersion = $sourceManifest.schemaVersion
        productVersion = $sourceManifest.productVersion
        target = $sourceManifest.target
        versions = $sourceManifest.versions
        paths = $sourceManifest.paths
        managedWorkspace = $sourceManifest.managedWorkspace
        allowlist = $sourceManifest.allowlist
        policySha256 = $policySha256
        resources = $resources
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $staging 'runtime-manifest.json'),
        ($bundleManifest | ConvertTo-Json -Depth 8) + "`n",
        [System.Text.UTF8Encoding]::new($false)
    )

    $backup = $expectedBundle + '.previous'
    if (Test-Path -LiteralPath $backup) {
        Remove-Item -LiteralPath $backup -Recurse -Force
    }
    if (Test-Path -LiteralPath $expectedBundle) {
        Move-Item -LiteralPath $expectedBundle -Destination $backup
    }
    try {
        Move-Item -LiteralPath $staging -Destination $expectedBundle
        if (Test-Path -LiteralPath $backup) {
            Remove-Item -LiteralPath $backup -Recurse -Force
        }
    } catch {
        if (-not (Test-Path -LiteralPath $expectedBundle) -and (Test-Path -LiteralPath $backup)) {
            Move-Item -LiteralPath $backup -Destination $expectedBundle
        }
        throw
    }
} finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}

Write-Output "Prepared deterministic Electron resources at $expectedBundle"
