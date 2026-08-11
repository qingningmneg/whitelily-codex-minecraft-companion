if (-not ('WhiteLily.Installer.ComponentFileVerifier' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace WhiteLily.Installer
{
    public static class ComponentFileVerifier
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out BY_HANDLE_FILE_INFORMATION information);

        private static BY_HANDLE_FILE_INFORMATION Inspect(SafeFileHandle handle)
        {
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
                throw new InvalidDataException("component identity unavailable");
            return information;
        }

        private static bool SameIdentity(
            BY_HANDLE_FILE_INFORMATION left,
            BY_HANDLE_FILE_INFORMATION right)
        {
            return left.VolumeSerialNumber == right.VolumeSerialNumber &&
                left.FileIndexHigh == right.FileIndexHigh &&
                left.FileIndexLow == right.FileIndexLow;
        }

        public static bool Verify(string path, long expectedBytes, string expectedSha256)
        {
            FileAttributes pathAttributes = File.GetAttributes(path);
            if ((pathAttributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                return false;
            using (FileStream stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                65536,
                FileOptions.SequentialScan))
            {
                BY_HANDLE_FILE_INFORMATION before = Inspect(stream.SafeFileHandle);
                if (before.NumberOfLinks != 1 || stream.Length != expectedBytes) return false;
                byte[] digest;
                using (SHA256 sha256 = SHA256.Create()) digest = sha256.ComputeHash(stream);
                string actual = BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
                if (!StringComparer.Ordinal.Equals(actual, expectedSha256)) return false;
                BY_HANDLE_FILE_INFORMATION after = Inspect(stream.SafeFileHandle);
                if (after.NumberOfLinks != 1 || !SameIdentity(before, after)) return false;
                using (FileStream pathCheck = new FileStream(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read,
                    1,
                    FileOptions.SequentialScan))
                {
                    BY_HANDLE_FILE_INFORMATION current = Inspect(pathCheck.SafeFileHandle);
                    return current.NumberOfLinks == 1 && SameIdentity(after, current);
                }
            }
        }
    }
}
'@
}

function Test-WhiteLilyMinecraftComponentReparse {
    param([Parameter(Mandatory = $true)][System.IO.FileSystemInfo]$Entry)
    return ($Entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
}

function Test-WhiteLilyExactObjectKeys {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected
    )
    if ($null -eq $Value -or $Value -isnot [psobject]) { return $false }
    [string[]]$actual = @($Value.PSObject.Properties.Name)
    [Array]::Sort($actual, [StringComparer]::Ordinal)
    [string[]]$reviewed = @($Expected)
    [Array]::Sort($reviewed, [StringComparer]::Ordinal)
    return [System.Linq.Enumerable]::SequenceEqual([string[]]$actual, [string[]]$reviewed)
}

function Assert-ReviewedMinecraftComponentResources {
    param(
        [Parameter(Mandatory = $true)][string]$ProgramRoot,
        [Parameter(Mandatory = $true)][object[]]$ReviewedFiles
    )

    if ($ReviewedFiles.Count -ne 9) { throw 'installed Minecraft component policy is invalid' }
    $reviewedByName = [Collections.Generic.Dictionary[string, object]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    foreach ($reviewed in $ReviewedFiles) {
        $name = [string]$reviewed.name
        if (
            -not (Test-WhiteLilyExactObjectKeys `
                -Value $reviewed `
                -Expected @('name', 'bytes', 'sha256')) -or
            [string]::IsNullOrWhiteSpace($name) -or
            -not [StringComparer]::Ordinal.Equals([IO.Path]::GetFileName($name), $name) -or
            $name.Contains('/') -or
            $name.Contains('\') -or
            [long]$reviewed.bytes -le 0 -or
            [string]$reviewed.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
            $reviewedByName.ContainsKey($name)
        ) {
            throw 'installed Minecraft component policy is invalid'
        }
        $reviewedByName.Add($name, $reviewed)
    }

    $resourceRoot = Join-Path $ProgramRoot 'resources'
    $runtimeManifestPath = Join-Path $resourceRoot 'runtime-manifest.json'
    $runtimeManifest = Get-Content -LiteralPath $runtimeManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $componentDirectory = [string]$runtimeManifest.paths.minecraftComponents
    if (-not [StringComparer]::Ordinal.Equals($componentDirectory, 'minecraft-components')) {
        throw 'installed Minecraft component directory is invalid'
    }
    $componentPrefix = $componentDirectory + '/'
    $sourceFiles = @(
        $runtimeManifest.allowlist.exactFiles |
            Where-Object { ([string]$_.target).StartsWith($componentPrefix, [StringComparison]::Ordinal) }
    )
    $resources = @(
        $runtimeManifest.resources |
            Where-Object { ([string]$_.path).StartsWith($componentPrefix, [StringComparison]::Ordinal) }
    )
    $required = @(
        $runtimeManifest.allowlist.requiredFiles |
            Where-Object { ([string]$_).StartsWith($componentPrefix, [StringComparison]::Ordinal) }
    )
    $executables = @(
        $runtimeManifest.allowlist.executableFiles |
            Where-Object { ([string]$_).StartsWith($componentPrefix, [StringComparison]::Ordinal) }
    )
    $scripts = @(
        $runtimeManifest.allowlist.scriptFiles |
            Where-Object { ([string]$_).StartsWith($componentPrefix, [StringComparison]::Ordinal) }
    )
    if (
        $sourceFiles.Count -ne 9 -or
        $resources.Count -ne 9 -or
        $required.Count -ne 9 -or
        $executables.Count -ne 0 -or
        $scripts.Count -ne 0
    ) {
        throw 'installed Minecraft component resource policy is invalid'
    }

    $sourceNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($source in $sourceFiles) {
        if (
            -not (Test-WhiteLilyExactObjectKeys `
                -Value $source `
                -Expected @('source', 'target', 'bytes', 'sha256'))
        ) {
            throw 'installed Minecraft component source descriptor is invalid'
        }
        $portablePath = [string]$source.target
        $name = $portablePath.Substring($componentPrefix.Length)
        $reviewed = $null
        if (
            -not $reviewedByName.TryGetValue($name, [ref]$reviewed) -or
            -not [StringComparer]::Ordinal.Equals([string]$reviewed.name, $name) -or
            -not [StringComparer]::Ordinal.Equals($portablePath, $componentPrefix + $name) -or
            -not [StringComparer]::Ordinal.Equals([string]$source.source, 'build/' + $portablePath) -or
            [long]$source.bytes -ne [long]$reviewed.bytes -or
            -not [StringComparer]::Ordinal.Equals([string]$source.sha256, [string]$reviewed.sha256) -or
            -not $sourceNames.Add($name)
        ) {
            throw 'installed Minecraft component source pin mismatch'
        }
    }

    $resourceNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($resource in $resources) {
        if (-not (Test-WhiteLilyExactObjectKeys -Value $resource -Expected @('path', 'bytes', 'sha256'))) {
            throw 'installed Minecraft component descriptor is invalid'
        }
        $portablePath = [string]$resource.path
        $name = $portablePath.Substring($componentPrefix.Length)
        $reviewed = $null
        if (
            -not $reviewedByName.TryGetValue($name, [ref]$reviewed) -or
            -not [StringComparer]::Ordinal.Equals([string]$reviewed.name, $name) -or
            -not [StringComparer]::Ordinal.Equals($portablePath, $componentPrefix + $name) -or
            [long]$resource.bytes -ne [long]$reviewed.bytes -or
            -not [StringComparer]::Ordinal.Equals([string]$resource.sha256, [string]$reviewed.sha256) -or
            -not $resourceNames.Add($name) -or
            -not $sourceNames.Contains($name) -or
            -not ($required -ccontains $portablePath)
        ) {
            throw 'installed Minecraft component descriptor pin mismatch'
        }
    }

    $componentRoot = Join-Path $resourceRoot $componentDirectory
    $componentRootEntry = Get-Item -LiteralPath $componentRoot -Force
    if (-not $componentRootEntry.PSIsContainer -or (Test-WhiteLilyMinecraftComponentReparse $componentRootEntry)) {
        throw 'installed Minecraft component root is not an ordinary directory'
    }
    $actual = @(Get-ChildItem -LiteralPath $componentRoot -Force)
    if ($actual.Count -ne 9) { throw 'installed Minecraft component file set is not exact' }
    foreach ($entry in $actual) {
        $reviewed = $null
        if (
            $entry.PSIsContainer -or
            -not ($entry -is [System.IO.FileInfo]) -or
            (Test-WhiteLilyMinecraftComponentReparse $entry) -or
            -not $reviewedByName.TryGetValue($entry.Name, [ref]$reviewed) -or
            -not [StringComparer]::Ordinal.Equals([string]$reviewed.name, $entry.Name) -or
            -not [WhiteLily.Installer.ComponentFileVerifier]::Verify(
                $entry.FullName,
                [long]$reviewed.bytes,
                [string]$reviewed.sha256
            )
        ) {
            throw 'installed Minecraft component file mismatch'
        }
    }
    return 9
}
