[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion
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

if (-not ('WhiteLily.Installer.WinTrustVerifier' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace WhiteLily.Installer
{
    public sealed class WinTrustResult
    {
        public int Status { get; private set; }
        public int LastError { get; private set; }

        public WinTrustResult(int status, int lastError)
        {
            Status = status;
            LastError = lastError;
        }
    }

    public static class WinTrustVerifier
    {
        public const int TRUST_E_NOSIGNATURE = unchecked((int)0x800B0100);
        public const int TRUST_E_SUBJECT_FORM_UNKNOWN = unchecked((int)0x800B0003);
        public const int TRUST_E_PROVIDER_UNKNOWN = unchecked((int)0x800B0001);

        private const uint WtdUiNone = 2;
        private const uint WtdRevokeNone = 0;
        private const uint WtdChoiceFile = 1;
        private const uint WtdStateActionVerify = 1;
        private const uint WtdStateActionClose = 2;
        private const uint WtdCacheOnlyUrlRetrieval = 0x1000;
        private const uint WtdUiContextInstall = 1;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WinTrustFileInfo
        {
            public uint cbStruct;

            [MarshalAs(UnmanagedType.LPWStr)]
            public string pcwszFilePath;

            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WinTrustData
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pFile;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            public IntPtr pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
            public IntPtr pSignatureSettings;
        }

        [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = true)]
        private static extern int WinVerifyTrust(
            IntPtr hwnd,
            [In] ref Guid actionId,
            [In, Out] ref WinTrustData trustData);

        public static WinTrustResult Verify(string path)
        {
            if (String.IsNullOrWhiteSpace(path))
            {
                throw new ArgumentException("A file path is required.", "path");
            }

            WinTrustFileInfo fileInfo = new WinTrustFileInfo
            {
                cbStruct = (uint)Marshal.SizeOf(typeof(WinTrustFileInfo)),
                pcwszFilePath = path,
                hFile = IntPtr.Zero,
                pgKnownSubject = IntPtr.Zero
            };
            IntPtr fileInfoPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WinTrustFileInfo)));
            try
            {
                Marshal.StructureToPtr(fileInfo, fileInfoPointer, false);
                WinTrustData trustData = new WinTrustData
                {
                    cbStruct = (uint)Marshal.SizeOf(typeof(WinTrustData)),
                    pPolicyCallbackData = IntPtr.Zero,
                    pSIPClientData = IntPtr.Zero,
                    dwUIChoice = WtdUiNone,
                    fdwRevocationChecks = WtdRevokeNone,
                    dwUnionChoice = WtdChoiceFile,
                    pFile = fileInfoPointer,
                    dwStateAction = WtdStateActionVerify,
                    hWVTStateData = IntPtr.Zero,
                    pwszURLReference = IntPtr.Zero,
                    dwProvFlags = WtdCacheOnlyUrlRetrieval,
                    dwUIContext = WtdUiContextInstall,
                    pSignatureSettings = IntPtr.Zero
                };
                Guid actionId = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
                int status = WinVerifyTrust(new IntPtr(-1), ref actionId, ref trustData);
                int lastError = Marshal.GetLastWin32Error();
                trustData.dwStateAction = WtdStateActionClose;
                WinVerifyTrust(new IntPtr(-1), ref actionId, ref trustData);
                return new WinTrustResult(status, lastError);
            }
            finally
            {
                Marshal.DestroyStructure(fileInfoPointer, typeof(WinTrustFileInfo));
                Marshal.FreeHGlobal(fileInfoPointer);
            }
        }
    }
}
'@
}

function Get-SigningStatus {
    param([Parameter(Mandatory = $true)][string]$Path)
    $verification = [WhiteLily.Installer.WinTrustVerifier]::Verify($Path)
    if ($verification.Status -eq 0) {
        return 'signed'
    }
    if (
        $verification.Status -eq [WhiteLily.Installer.WinTrustVerifier]::TRUST_E_NOSIGNATURE -and
        $verification.LastError -in @(
            [WhiteLily.Installer.WinTrustVerifier]::TRUST_E_NOSIGNATURE,
            [WhiteLily.Installer.WinTrustVerifier]::TRUST_E_SUBJECT_FORM_UNKNOWN,
            [WhiteLily.Installer.WinTrustVerifier]::TRUST_E_PROVIDER_UNKNOWN
        )
    ) {
        return 'unsigned'
    }
    throw "SIGNATURE_STATE_INVALID: status=$($verification.Status), lastError=$($verification.LastError)"
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
    $policySha256 = Get-Sha256Hex $sourceManifestPath
    if (
        -not [StringComparer]::Ordinal.Equals([string]$runtimeManifest.productVersion, $ExpectedVersion) -or
        [int]$runtimeManifest.schemaVersion -ne 1
    ) {
        throw 'INSTALLER_RUNTIME_POLICY_MISMATCH'
    }

    $sourceRequired = @($sourceManifest.allowlist.requiredFiles | ForEach-Object { [string]$_ })
    $runtimeRequired = @($runtimeManifest.allowlist.requiredFiles | ForEach-Object { [string]$_ })
    [Array]::Sort($sourceRequired, [StringComparer]::Ordinal)
    [Array]::Sort($runtimeRequired, [StringComparer]::Ordinal)

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
            $actualHash = Get-Sha256Hex $resourcePath
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

    $expectedManagedWorkspaceResources = @(
        'codex-workspace/.codex/config.toml',
        'codex-workspace/AGENTS.md',
        'codex-workspace/workspace-manifest.json'
    )
    $managedWorkspaceResources = @(
        $runtimeManifest.resources |
            Where-Object {
                ([string]$_.path).StartsWith(
                    'codex-workspace/',
                    [StringComparison]::Ordinal
                )
            }
    )
    $actualManagedWorkspaceResources = @(
        $managedWorkspaceResources |
            ForEach-Object { [string]$_.path }
    )
    [Array]::Sort($expectedManagedWorkspaceResources, [StringComparer]::Ordinal)
    [Array]::Sort($actualManagedWorkspaceResources, [StringComparer]::Ordinal)
    if (
        -not [System.Linq.Enumerable]::SequenceEqual(
            [string[]]$actualManagedWorkspaceResources,
            [string[]]$expectedManagedWorkspaceResources
        )
    ) {
        throw 'INSTALLER_MANAGED_WORKSPACE_RESOURCES_INVALID'
    }

    $minecraftComponents = [string]$sourceManifest.paths.minecraftComponents
    if (-not [StringComparer]::Ordinal.Equals($minecraftComponents, 'minecraft-components')) {
        throw 'INSTALLER_MINECRAFT_COMPONENT_RESOURCES_INVALID'
    }
    $minecraftComponentPrefix = $minecraftComponents + '/'
    [string[]]$sourceMinecraftComponentFiles = @(
        $sourceManifest.allowlist.exactFiles |
            Where-Object {
                $null -ne $_.target -and
                ([string]$_.target).StartsWith($minecraftComponentPrefix, [StringComparison]::Ordinal)
            } |
            ForEach-Object { [string]$_.target }
    )
    [string[]]$requiredMinecraftComponentFiles = @(
        $sourceRequired |
            Where-Object { $_.StartsWith($minecraftComponentPrefix, [StringComparison]::Ordinal) }
    )
    $minecraftComponentResources = @(
        $runtimeManifest.resources |
            Where-Object {
                ([string]$_.path).StartsWith($minecraftComponentPrefix, [StringComparison]::Ordinal)
            }
    )
    [string[]]$runtimeMinecraftComponentFiles = @(
        $minecraftComponentResources |
            ForEach-Object { [string]$_.path }
    )
    $componentExecutableFiles = @(
        $sourceManifest.allowlist.executableFiles |
            Where-Object {
                ([string]$_).StartsWith($minecraftComponentPrefix, [StringComparison]::Ordinal)
            }
    )
    $componentScriptFiles = @(
        $sourceManifest.allowlist.scriptFiles |
            Where-Object {
                ([string]$_).StartsWith($minecraftComponentPrefix, [StringComparison]::Ordinal)
            }
    )
    [Array]::Sort($sourceMinecraftComponentFiles, [StringComparer]::Ordinal)
    [Array]::Sort($requiredMinecraftComponentFiles, [StringComparer]::Ordinal)
    [Array]::Sort($runtimeMinecraftComponentFiles, [StringComparer]::Ordinal)
    if (
        $minecraftComponentResources.Count -ne 7 -or
        $sourceMinecraftComponentFiles.Count -ne 7 -or
        $requiredMinecraftComponentFiles.Count -ne 7 -or
        $componentExecutableFiles.Count -ne 0 -or
        $componentScriptFiles.Count -ne 0 -or
        -not [System.Linq.Enumerable]::SequenceEqual(
            [string[]]$sourceMinecraftComponentFiles,
            [string[]]$requiredMinecraftComponentFiles
        ) -or
        -not [System.Linq.Enumerable]::SequenceEqual(
            [string[]]$sourceMinecraftComponentFiles,
            [string[]]$runtimeMinecraftComponentFiles
        )
    ) {
        throw 'INSTALLER_MINECRAFT_COMPONENT_RESOURCES_INVALID'
    }

    $workspaceRoot = Resolve-ContainedResource $resourceRoot 'codex-workspace'
    $workspaceManifestPath = Resolve-ContainedResource `
        $resourceRoot `
        'codex-workspace/workspace-manifest.json'
    $workspaceManifest = Get-Content `
        -LiteralPath $workspaceManifestPath `
        -Raw `
        -Encoding UTF8 |
        ConvertFrom-Json
    $expectedManagedPayloads = @('.codex/config.toml', 'AGENTS.md')
    $managedPayloads = @($workspaceManifest.files)
    if (
        [int]$workspaceManifest.schemaVersion -ne 1 -or
        -not [StringComparer]::Ordinal.Equals([string]$workspaceManifest.contentVersion, '1') -or
        $managedPayloads.Count -ne $expectedManagedPayloads.Count
    ) {
        throw 'INSTALLER_MANAGED_WORKSPACE_MANIFEST_INVALID'
    }
    for ($index = 0; $index -lt $expectedManagedPayloads.Count; $index += 1) {
        $payload = $managedPayloads[$index]
        $payloadPath = [string]$payload.path
        if (
            -not [StringComparer]::Ordinal.Equals($payloadPath, $expectedManagedPayloads[$index]) -or
            [long]$payload.bytes -lt 0 -or
            [string]$payload.sha256 -cnotmatch '^[a-f0-9]{64}$'
        ) {
            throw 'INSTALLER_MANAGED_WORKSPACE_MANIFEST_INVALID'
        }
        $installedPayloadPath = Resolve-ContainedResource $workspaceRoot $payloadPath
        $installedPayload = Get-Item -LiteralPath $installedPayloadPath
        $installedPayloadHash = Get-Sha256Hex $installedPayloadPath
        $outerPath = "codex-workspace/$payloadPath"
        $outerMatches = @(
            $managedWorkspaceResources |
                Where-Object {
                    [StringComparer]::Ordinal.Equals([string]$_.path, $outerPath)
                }
        )
        if (
            $installedPayload.Length -ne [long]$payload.bytes -or
            -not [StringComparer]::Ordinal.Equals(
                $installedPayloadHash,
                [string]$payload.sha256
            ) -or
            $outerMatches.Count -ne 1 -or
            [long]$outerMatches[0].bytes -ne [long]$payload.bytes -or
            -not [StringComparer]::Ordinal.Equals(
                [string]$outerMatches[0].sha256,
                [string]$payload.sha256
            )
        ) {
            throw "INSTALLER_MANAGED_WORKSPACE_HASH_MISMATCH: $payloadPath"
        }
    }
    foreach ($afterPack in @($sourceManifest.allowlist.afterPackFiles | ForEach-Object { [string]$_ })) {
        $afterPackPath = Resolve-ContainedResource $resourceRoot $afterPack
        if (-not (Test-Path -LiteralPath $afterPackPath -PathType Leaf)) {
            throw "INSTALLER_RESOURCE_MISSING: $afterPack"
        }
    }
    if (
        -not [System.Linq.Enumerable]::SequenceEqual(
            [string[]]$sourceRequired,
            [string[]]$runtimeRequired
        ) -or
        -not [StringComparer]::Ordinal.Equals([string]$runtimeManifest.policySha256, $policySha256)
    ) {
        throw 'INSTALLER_RUNTIME_POLICY_MISMATCH'
    }

    Invoke-ReviewedRuntimeVerifier `
        -RepositoryRoot $repositoryRoot `
        -ResourceRoot $resourceRoot `
        -SourceManifestPath $sourceManifestPath

    $result = [ordered]@{
        schemaVersion = 1
        productVersion = $ExpectedVersion
        installerName = $expectedName
        sha256 = Get-Sha256Hex $resolvedInstaller
        signingStatus = Get-SigningStatus $resolvedInstaller
        resourcesVerified = $declared.Count
        managedWorkspaceResourcesVerified = $managedWorkspaceResources.Count
        managedWorkspacePayloadsVerified = $managedPayloads.Count
        minecraftComponentResourcesVerified = $minecraftComponentResources.Count
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
