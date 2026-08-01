[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion
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

function Assert-SemanticVersion {
    param([Parameter(Mandatory = $true)][string]$Value)
    $prereleaseIdentifier = '(?:(?:0|[1-9][0-9]*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))'
    $semanticVersion = "^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-$prereleaseIdentifier(?:\.$prereleaseIdentifier)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
    if ($Value -cnotmatch $semanticVersion) {
        throw 'INVALID_SEMANTIC_VERSION'
    }
}

function Resolve-SevenZip {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)
    if (-not [string]::IsNullOrWhiteSpace($env:ELECTRON_BUILDER_7ZIP_PATH)) {
        $configured = Resolve-FullPath $env:ELECTRON_BUILDER_7ZIP_PATH $RepositoryRoot
        if (-not (Test-Path -LiteralPath $configured -PathType Leaf)) {
            throw 'PINNED_7ZIP_REQUIRED'
        }
        return $configured
    }

    $lines = @(& node -e "require('app-builder-lib/out/toolsets/7zip.js').getPath7za().then(p=>console.log(p)).catch(e=>{console.error(e);process.exit(1)})")
    if ($LASTEXITCODE -ne 0) {
        throw 'PINNED_7ZIP_REQUIRED'
    }
    $resolved = @(
        $lines |
            ForEach-Object { [string]$_ } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            ForEach-Object { Resolve-FullPath $_ $RepositoryRoot } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    )
    if ($resolved.Count -ne 1) {
        throw 'PINNED_7ZIP_REQUIRED'
    }
    return $resolved[0]
}

function Invoke-SevenZipExtract {
    param(
        [Parameter(Mandatory = $true)][string]$SevenZip,
        [Parameter(Mandatory = $true)][string]$Archive,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    & $SevenZip x -bd -y "-o$Destination" $Archive | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'INSTALLER_ARCHIVE_INVALID'
    }
}

function Resolve-ContainedResource {
    param(
        [Parameter(Mandatory = $true)][string]$ResourceRoot,
        [Parameter(Mandatory = $true)][string]$PortablePath
    )
    if (
        [string]::IsNullOrWhiteSpace($PortablePath) -or
        $PortablePath.Contains('\') -or
        $PortablePath.StartsWith('/') -or
        @($PortablePath.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0
    ) {
        throw 'INSTALLER_RESOURCE_PATH_INVALID'
    }
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $ResourceRoot ($PortablePath.Replace('/', '\'))))
    $prefix = $ResourceRoot.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'INSTALLER_RESOURCE_PATH_INVALID'
    }
    return $resolved
}

function Get-SigningStatus {
    param([Parameter(Mandatory = $true)][string]$Path)
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) {
        return 'signed'
    }
    if ($signature.Status -eq [System.Management.Automation.SignatureStatus]::NotSigned) {
        return 'unsigned'
    }
    throw "SIGNATURE_STATE_INVALID: $($signature.Status)"
}

function Invoke-ReviewedRuntimeVerifier {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$ResourceRoot,
        [Parameter(Mandatory = $true)][string]$SourceManifestPath
    )
    $verifierPath = Join-Path $RepositoryRoot 'packaging/electron/after-pack.cjs'
    if (-not (Test-Path -LiteralPath $verifierPath -PathType Leaf)) {
        throw 'REVIEWED_RUNTIME_VERIFIER_REQUIRED'
    }
    $verificationScript = @'
const verifier = require(process.argv[1]);
Promise.resolve(verifier.verifyResourceDirectory(process.argv[2], process.argv[3])).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
'@
    $verificationOutput = @(& node -e $verificationScript $verifierPath $ResourceRoot $SourceManifestPath 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "INSTALLER_RUNTIME_VERIFICATION_FAILED: $($verificationOutput -join ' | ')"
    }
}

Assert-SemanticVersion $ExpectedVersion
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedInstaller = Resolve-FullPath $InstallerPath (Get-Location).Path
$expectedName = "WhiteLily-$ExpectedVersion-windows-x64-setup.exe"
if (
    -not (Test-Path -LiteralPath $resolvedInstaller -PathType Leaf) -or
    -not [StringComparer]::Ordinal.Equals([System.IO.Path]::GetFileName($resolvedInstaller), $expectedName)
) {
    throw 'INSTALLER_NAME_OR_PATH_INVALID'
}

$sourceManifestPath = Join-Path $repositoryRoot 'packaging/electron/runtime-manifest.json'
if (-not (Test-Path -LiteralPath $sourceManifestPath -PathType Leaf)) {
    throw 'REVIEWED_RUNTIME_MANIFEST_REQUIRED'
}
$sourceManifestBytes = [System.IO.File]::ReadAllBytes($sourceManifestPath)
$sourceManifest = [System.Text.Encoding]::UTF8.GetString($sourceManifestBytes) | ConvertFrom-Json
if (-not [StringComparer]::Ordinal.Equals([string]$sourceManifest.productVersion, $ExpectedVersion)) {
    throw 'INSTALLER_VERSION_MISMATCH'
}

$buildRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'build'))
$inspectionRoot = Join-Path $buildRoot ('installer-inspection-' + [Guid]::NewGuid().ToString('N'))
$inspectionPrefix = $buildRoot.TrimEnd('\') + '\'
if (-not $inspectionRoot.StartsWith($inspectionPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'UNSAFE_INSPECTION_ROOT'
}
$outerRoot = Join-Path $inspectionRoot 'outer'
$applicationRoot = Join-Path $inspectionRoot 'application'
$sevenZip = Resolve-SevenZip $repositoryRoot

try {
    Invoke-SevenZipExtract $sevenZip $resolvedInstaller $outerRoot
    $applicationArchives = @(
        Get-ChildItem -LiteralPath $outerRoot -Recurse -File -Filter 'app-64.7z'
    )
    $expandedRuntimeManifests = @(
        Get-ChildItem -LiteralPath $outerRoot -Recurse -File -Filter 'runtime-manifest.json'
    )
    if ($applicationArchives.Count -eq 1 -and $expandedRuntimeManifests.Count -eq 0) {
        Invoke-SevenZipExtract $sevenZip $applicationArchives[0].FullName $applicationRoot
    } elseif ($applicationArchives.Count -eq 0 -and $expandedRuntimeManifests.Count -eq 1) {
        $applicationRoot = $outerRoot
    } else {
        $outerEntries = @(
            Get-ChildItem -LiteralPath $outerRoot -Recurse -File |
                ForEach-Object { $_.FullName.Substring($outerRoot.Length).TrimStart('\') }
        )
        throw "INSTALLER_APPLICATION_ARCHIVE_INVALID: $($outerEntries -join ', ')"
    }

    $manifestFiles = @(
        Get-ChildItem -LiteralPath $applicationRoot -Recurse -File -Filter 'runtime-manifest.json'
    )
    if ($manifestFiles.Count -ne 1) {
        throw 'INSTALLER_RUNTIME_MANIFEST_INVALID'
    }
    $resourceRoot = $manifestFiles[0].Directory.FullName
    $runtimeManifest = Get-Content -LiteralPath $manifestFiles[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    $policySha256 = (Get-FileHash -LiteralPath $sourceManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        -not [StringComparer]::Ordinal.Equals([string]$runtimeManifest.policySha256, $policySha256) -or
        -not [StringComparer]::Ordinal.Equals([string]$runtimeManifest.productVersion, $ExpectedVersion) -or
        [int]$runtimeManifest.schemaVersion -ne 1
    ) {
        throw 'INSTALLER_RUNTIME_POLICY_MISMATCH'
    }

    $sourceRequired = @($sourceManifest.allowlist.requiredFiles | ForEach-Object { [string]$_ })
    $runtimeRequired = @($runtimeManifest.allowlist.requiredFiles | ForEach-Object { [string]$_ })
    [Array]::Sort($sourceRequired, [StringComparer]::Ordinal)
    [Array]::Sort($runtimeRequired, [StringComparer]::Ordinal)
    if (-not [System.Linq.Enumerable]::SequenceEqual([string[]]$sourceRequired, [string[]]$runtimeRequired)) {
        throw 'INSTALLER_RUNTIME_POLICY_MISMATCH'
    }

    $declared = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($resource in @($runtimeManifest.resources)) {
        $portablePath = [string]$resource.path
        if (
            -not $declared.Add($portablePath) -or
            [long]$resource.bytes -lt 0 -or
            [string]$resource.sha256 -cnotmatch '^[a-f0-9]{64}$'
        ) {
            throw 'INSTALLER_RESOURCE_MANIFEST_INVALID'
        }
        if (-not $portablePath.StartsWith('desktop/', [StringComparison]::Ordinal)) {
            $resourcePath = Resolve-ContainedResource $resourceRoot $portablePath
            if (-not (Test-Path -LiteralPath $resourcePath -PathType Leaf)) {
                throw "INSTALLER_RESOURCE_MISSING: $portablePath"
            }
            $metadata = Get-Item -LiteralPath $resourcePath
            $actualHash = (Get-FileHash -LiteralPath $resourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
            if (
                $metadata.Length -ne [long]$resource.bytes -or
                -not [StringComparer]::Ordinal.Equals($actualHash, [string]$resource.sha256)
            ) {
                throw "INSTALLER_RESOURCE_HASH_MISMATCH: $portablePath"
            }
        }
    }

    foreach ($required in $sourceRequired) {
        if ($required.StartsWith('desktop/', [StringComparison]::Ordinal)) {
            if (-not $declared.Contains($required)) {
                throw "INSTALLER_RESOURCE_UNDECLARED: $required"
            }
        } else {
            $requiredPath = Resolve-ContainedResource $resourceRoot $required
            if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
                throw "INSTALLER_RESOURCE_MISSING: $required"
            }
            if (-not $declared.Contains($required)) {
                throw "INSTALLER_RESOURCE_UNDECLARED: $required"
            }
        }
    }
    foreach ($afterPack in @($sourceManifest.allowlist.afterPackFiles | ForEach-Object { [string]$_ })) {
        $afterPackPath = Resolve-ContainedResource $resourceRoot $afterPack
        if (-not (Test-Path -LiteralPath $afterPackPath -PathType Leaf)) {
            throw "INSTALLER_RESOURCE_MISSING: $afterPack"
        }
    }

    Invoke-ReviewedRuntimeVerifier `
        -RepositoryRoot $repositoryRoot `
        -ResourceRoot $resourceRoot `
        -SourceManifestPath $sourceManifestPath

    $result = [ordered]@{
        schemaVersion = 1
        productVersion = $ExpectedVersion
        installerName = $expectedName
        sha256 = (Get-FileHash -LiteralPath $resolvedInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
        signingStatus = Get-SigningStatus $resolvedInstaller
        resourcesVerified = $declared.Count
    }
    Write-Output ($result | ConvertTo-Json -Compress)
} finally {
    if (
        (Test-Path -LiteralPath $inspectionRoot) -and
        $inspectionRoot.StartsWith($inspectionPrefix, [StringComparison]::OrdinalIgnoreCase)
    ) {
        Remove-Item -LiteralPath $inspectionRoot -Recurse -Force
    }
}
