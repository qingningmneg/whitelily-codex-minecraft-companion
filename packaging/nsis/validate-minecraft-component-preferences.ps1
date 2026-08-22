[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

try {
    Set-Location -LiteralPath $PSHOME
    [Environment]::CurrentDirectory = $PSHOME
    if (-not ('WhiteLily.Installer.PreferenceFileAuthority' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace WhiteLily.Installer
{
    public sealed class PreferencePublicationResult
    {
        public bool Published { get; set; }
        public int ErrorCode { get; set; }
    }

    public sealed class OwnedPreferenceTemp : IDisposable
    {
        private const uint DELETE = 0x00010000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint CREATE_NEW = 1;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;

        private readonly SafeFileHandle handle;
        private readonly FileStream stream;
        private readonly byte[] expected;
        private bool deleteRequested;
        private bool disposed;

        public string Path { get; private set; }

        private OwnedPreferenceTemp(
            string path,
            SafeFileHandle ownedHandle,
            FileStream ownedStream,
            byte[] expectedBytes)
        {
            Path = path;
            handle = ownedHandle;
            stream = ownedStream;
            expected = expectedBytes;
        }

        public static OwnedPreferenceTemp Create(string directory, byte[] expectedBytes)
        {
            if (expectedBytes == null || expectedBytes.Length == 0 || expectedBytes.Length > 4096)
                throw new InvalidDataException("invalid preference");
            string exactDirectory = System.IO.Path.GetFullPath(directory);
            for (int attempt = 0; attempt < 32; attempt++)
            {
                byte[] random = new byte[16];
                using (RandomNumberGenerator generator = RandomNumberGenerator.Create())
                    generator.GetBytes(random);
                string name = ".minecraft-components." +
                    BitConverter.ToString(random).Replace("-", "").ToLowerInvariant() + ".tmp";
                string path = System.IO.Path.Combine(exactDirectory, name);
                SafeFileHandle ownedHandle = PreferenceFileAuthority.CreateFileHandle(
                    path,
                    GENERIC_READ | GENERIC_WRITE | DELETE,
                    FILE_SHARE_READ,
                    CREATE_NEW);
                if (ownedHandle.IsInvalid)
                {
                    int error = Marshal.GetLastWin32Error();
                    ownedHandle.Dispose();
                    if (error == 80 || error == 183) continue;
                    throw new IOException("preference temp create failed");
                }
                FileStream ownedStream = null;
                OwnedPreferenceTemp owned = null;
                try
                {
                    ownedStream = new FileStream(ownedHandle, FileAccess.ReadWrite, 4096, false);
                    owned = new OwnedPreferenceTemp(path, ownedHandle, ownedStream, expectedBytes);
                    owned.WriteAndValidate();
                    return owned;
                }
                catch (Exception operationFailure)
                {
                    Exception cleanupFailure = null;
                    if (owned != null)
                    {
                        try { owned.DeleteOwned(); } catch (Exception error) { cleanupFailure = error; }
                        owned.Dispose();
                    }
                    else
                    {
                        try { PreferenceFileAuthority.DeleteHandle(ownedHandle); }
                        catch (Exception error) { cleanupFailure = error; }
                        if (ownedStream != null) ownedStream.Dispose();
                        else ownedHandle.Dispose();
                    }
                    if (cleanupFailure != null)
                        throw new IOException("preference temp cleanup failed", cleanupFailure);
                    throw operationFailure;
                }
            }
            throw new IOException("preference temp collision limit reached");
        }

        private void WriteAndValidate()
        {
            PreferenceFileAuthority.RequireHandle(Path, handle, 1, 0);
            stream.Position = 0;
            stream.SetLength(0);
            stream.Write(expected, 0, expected.Length);
            stream.Flush(true);
            RevalidateBeforePublish();
        }

        public void RevalidateBeforePublish()
        {
            RequireUsable();
            PreferenceFileAuthority.RequireHandle(Path, handle, 1, expected.Length);
            stream.Position = 0;
            byte[] actual = PreferenceFileAuthority.ReadExact(stream, expected.Length);
            if (!PreferenceFileAuthority.BytesEqual(actual, expected))
                throw new InvalidDataException("invalid preference");
            PreferenceFileAuthority.RequireHandle(Path, handle, 1, expected.Length);
        }

        public PreferencePublicationResult Publish(string target)
        {
            RequireUsable();
            bool published = PreferenceFileAuthority.CreateHardLink(target, Path, IntPtr.Zero);
            int error = published ? 0 : Marshal.GetLastWin32Error();
            return new PreferencePublicationResult { Published = published, ErrorCode = error };
        }

        public void DeleteOwned()
        {
            RequireUsable();
            if (deleteRequested) return;
            PreferenceFileAuthority.DeleteHandle(handle);
            deleteRequested = true;
        }

        private void RequireUsable()
        {
            if (disposed || handle.IsInvalid || handle.IsClosed)
                throw new ObjectDisposedException("preference temp");
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            stream.Dispose();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct FILE_DISPOSITION_INFO
    {
        [MarshalAs(UnmanagedType.Bool)]
        public bool DeleteFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BY_HANDLE_FILE_INFORMATION
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

    public static class PreferenceFileAuthority
    {
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint GENERIC_READ = 0x80000000;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint INVALID_FILE_ATTRIBUTES = 0xffffffff;
        private const int FileDispositionInfo = 4;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern SafeFileHandle CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool CreateHardLink(
            string fileName,
            string existingFileName,
            IntPtr securityAttributes);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle handle,
            out BY_HANDLE_FILE_INFORMATION information);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandle(
            SafeFileHandle handle,
            StringBuilder path,
            uint pathLength,
            uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFileAttributes(string fileName);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool SetFileInformationByHandle(
            SafeFileHandle handle,
            int informationClass,
            ref FILE_DISPOSITION_INFO information,
            uint informationLength);

        internal static void DeleteHandle(SafeFileHandle handle)
        {
            FILE_DISPOSITION_INFO disposition = new FILE_DISPOSITION_INFO { DeleteFile = true };
            if (!SetFileInformationByHandle(
                handle,
                FileDispositionInfo,
                ref disposition,
                (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO))))
                throw new IOException("preference temp cleanup failed");
        }

        internal static SafeFileHandle CreateFileHandle(
            string path,
            uint access,
            uint share,
            uint disposition)
        {
            return CreateFile(
                path,
                access,
                share,
                IntPtr.Zero,
                disposition,
                FILE_ATTRIBUTE_NORMAL,
                IntPtr.Zero);
        }

        private static BY_HANDLE_FILE_INFORMATION Information(SafeFileHandle handle)
        {
            BY_HANDLE_FILE_INFORMATION information;
            if (!GetFileInformationByHandle(handle, out information))
                throw new IOException("preference identity failed");
            return information;
        }

        private static ulong Size(BY_HANDLE_FILE_INFORMATION information)
        {
            return ((ulong)information.FileSizeHigh << 32) | information.FileSizeLow;
        }

        private static bool SameIdentity(
            BY_HANDLE_FILE_INFORMATION left,
            BY_HANDLE_FILE_INFORMATION right)
        {
            return left.VolumeSerialNumber == right.VolumeSerialNumber &&
                left.FileIndexHigh == right.FileIndexHigh &&
                left.FileIndexLow == right.FileIndexLow;
        }

        private static string FinalPath(SafeFileHandle handle)
        {
            StringBuilder buffer = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0 || length >= buffer.Capacity)
                throw new IOException("preference final path failed");
            string value = buffer.ToString();
            if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
                value = @"\\" + value.Substring(8);
            else if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
                value = value.Substring(4);
            return System.IO.Path.GetFullPath(value);
        }

        private static void RequirePathAttributes(string path)
        {
            uint attributes = GetFileAttributes(path);
            if (attributes == INVALID_FILE_ATTRIBUTES ||
                (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
                throw new InvalidDataException("invalid preference");
        }

        internal static void RequireHandle(
            string requestedPath,
            SafeFileHandle handle,
            uint requiredLinks,
            int requiredBytes)
        {
            RequirePathAttributes(requestedPath);
            BY_HANDLE_FILE_INFORMATION information = Information(handle);
            if ((information.FileAttributes &
                    (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0)
                throw new InvalidDataException("invalid preference attributes");
            if (information.NumberOfLinks != requiredLinks)
                throw new InvalidDataException("invalid preference links");
            if (Size(information) != (ulong)requiredBytes)
                throw new InvalidDataException("invalid preference size");
            if (!StringComparer.OrdinalIgnoreCase.Equals(
                    System.IO.Path.GetFullPath(requestedPath),
                    FinalPath(handle)))
                throw new InvalidDataException("invalid preference final path");
        }

        internal static void RequirePathMatchesHandle(
            string path,
            SafeFileHandle expectedHandle,
            uint requiredLinks,
            int requiredBytes)
        {
            BY_HANDLE_FILE_INFORMATION expected = Information(expectedHandle);
            using (SafeFileHandle current = CreateFileHandle(
                path,
                GENERIC_READ,
                FILE_SHARE_READ,
                OPEN_EXISTING))
            {
                if (current.IsInvalid) throw new InvalidDataException("invalid preference");
                BY_HANDLE_FILE_INFORMATION actual = Information(current);
                if (!SameIdentity(expected, actual))
                    throw new InvalidDataException("invalid preference");
                RequireHandle(path, current, requiredLinks, requiredBytes);
            }
        }

        public static byte[] ReadOrdinarySingleLinkFile(string path, int maximumBytes)
        {
            string exactPath = System.IO.Path.GetFullPath(path);
            RequirePathAttributes(exactPath);
            using (SafeFileHandle handle = CreateFileHandle(
                exactPath,
                GENERIC_READ,
                FILE_SHARE_READ, // WHITELILY_TEST_EXISTING_SHARE
                OPEN_EXISTING))
            {
                if (handle.IsInvalid) throw new InvalidDataException("invalid preference");
                // WHITELILY_TEST_AFTER_EXISTING_OPEN
                BY_HANDLE_FILE_INFORMATION before = Information(handle);
                ulong length = Size(before);
                if (length == 0 || length > (ulong)maximumBytes || length > Int32.MaxValue)
                    throw new InvalidDataException("invalid preference");
                RequireHandle(exactPath, handle, 1, (int)length);
                byte[] bytes;
                using (FileStream stream = new FileStream(handle, FileAccess.Read, 4096, false))
                {
                    bytes = ReadExact(stream, (int)length);
                    BY_HANDLE_FILE_INFORMATION after = Information(handle);
                    if (!SameIdentity(before, after))
                        throw new InvalidDataException("invalid preference");
                    RequireHandle(exactPath, handle, 1, (int)length);
                    RequirePathMatchesHandle(exactPath, handle, 1, (int)length);
                }
                return bytes;
            }
        }

        internal static byte[] ReadExact(Stream stream, int length)
        {
            byte[] bytes = new byte[length];
            int offset = 0;
            while (offset < bytes.Length)
            {
                int count = stream.Read(bytes, offset, bytes.Length - offset);
                if (count <= 0) throw new EndOfStreamException();
                offset += count;
            }
            if (stream.ReadByte() != -1) throw new InvalidDataException("invalid preference");
            return bytes;
        }

        internal static bool BytesEqual(byte[] left, byte[] right)
        {
            if (left.Length != right.Length) return false;
            int difference = 0;
            for (int index = 0; index < left.Length; index++)
                difference |= left[index] ^ right[index];
            return difference == 0;
        }
    }
}
'@
    }

    function Skip-JsonWhitespace {
        param([Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)][ref]$Index)
        while ($Index.Value -lt $Text.Length) {
            $code = [int][char]$Text[$Index.Value]
            if ($code -notin @(0x20, 0x09, 0x0a, 0x0d)) { return }
            $Index.Value += 1
        }
    }

    function Read-JsonString {
        param([Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)][ref]$Index)
        if ($Index.Value -ge $Text.Length -or $Text[$Index.Value] -ne '"') { throw 'invalid preference' }
        $Index.Value += 1
        $builder = [Text.StringBuilder]::new()
        while ($Index.Value -lt $Text.Length) {
            $character = $Text[$Index.Value]
            $Index.Value += 1
            if ($character -eq '"') { return $builder.ToString() }
            if ([int][char]$character -lt 0x20) { throw 'invalid preference' }
            if ($character -ne '\') {
                [void]$builder.Append($character)
                continue
            }
            if ($Index.Value -ge $Text.Length) { throw 'invalid preference' }
            $escape = $Text[$Index.Value]
            $Index.Value += 1
            switch ($escape) {
                '"' { [void]$builder.Append('"') }
                '\' { [void]$builder.Append('\') }
                '/' { [void]$builder.Append('/') }
                'b' { [void]$builder.Append([char]0x08) }
                'f' { [void]$builder.Append([char]0x0c) }
                'n' { [void]$builder.Append([char]0x0a) }
                'r' { [void]$builder.Append([char]0x0d) }
                't' { [void]$builder.Append([char]0x09) }
                'u' {
                    if ($Index.Value + 4 -gt $Text.Length) { throw 'invalid preference' }
                    $hex = $Text.Substring($Index.Value, 4)
                    if ($hex -cnotmatch '^[0-9a-fA-F]{4}$') { throw 'invalid preference' }
                    [void]$builder.Append([char][Convert]::ToInt32($hex, 16))
                    $Index.Value += 4
                }
                default { throw 'invalid preference' }
            }
        }
        throw 'invalid preference'
    }

    function Read-JsonBoolean {
        param([Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)][ref]$Index)
        if ($Text.Substring($Index.Value).StartsWith('true', [StringComparison]::Ordinal)) {
            $Index.Value += 4
            return $true
        }
        if ($Text.Substring($Index.Value).StartsWith('false', [StringComparison]::Ordinal)) {
            $Index.Value += 5
            return $false
        }
        throw 'invalid preference'
    }

    function Read-JsonSchemaVersion {
        param([Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)][ref]$Index)
        $match = [Text.RegularExpressions.Regex]::Match(
            $Text.Substring($Index.Value),
            '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?',
            [Text.RegularExpressions.RegexOptions]::CultureInvariant
        )
        if (-not $match.Success) { throw 'invalid preference' }
        $number = [double]::Parse($match.Value, [Globalization.CultureInfo]::InvariantCulture)
        if ([double]::IsInfinity($number) -or [double]::IsNaN($number) -or $number -ne 1) {
            throw 'invalid preference'
        }
        $Index.Value += $match.Length
    }

    function Test-MinecraftComponentPreferenceBytes {
        param([Parameter(Mandatory = $true)][byte[]]$Bytes)
        if ($Bytes.Length -le 0 -or $Bytes.Length -gt 4096) { throw 'invalid preference' }
        if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xef -and $Bytes[1] -eq 0xbb -and $Bytes[2] -eq 0xbf) {
            throw 'invalid preference'
        }
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
        $index = 0
        Skip-JsonWhitespace -Text $text -Index ([ref]$index)
        if ($index -ge $text.Length -or $text[$index] -ne '{') { throw 'invalid preference' }
        $index += 1
        $keys = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $afterComma = $false
        while ($true) {
            Skip-JsonWhitespace -Text $text -Index ([ref]$index)
            if ($index -lt $text.Length -and $text[$index] -eq '}') {
                if ($afterComma) { throw 'invalid preference' }
                $index += 1
                break
            }
            $key = Read-JsonString -Text $text -Index ([ref]$index)
            if (-not $keys.Add($key)) { throw 'invalid preference' }
            Skip-JsonWhitespace -Text $text -Index ([ref]$index)
            if ($index -ge $text.Length -or $text[$index] -ne ':') { throw 'invalid preference' }
            $index += 1
            Skip-JsonWhitespace -Text $text -Index ([ref]$index)
            switch -CaseSensitive ($key) {
                'schemaVersion' { Read-JsonSchemaVersion -Text $text -Index ([ref]$index) }
                'bridgeEnabled' { [void](Read-JsonBoolean -Text $text -Index ([ref]$index)) }
                'avatarEnabled' { [void](Read-JsonBoolean -Text $text -Index ([ref]$index)) }
                default { throw 'invalid preference' }
            }
            [void]$seen.Add($key)
            $afterComma = $false
            Skip-JsonWhitespace -Text $text -Index ([ref]$index)
            if ($index -lt $text.Length -and $text[$index] -eq ',') {
                $index += 1
                $afterComma = $true
                continue
            }
            if ($index -lt $text.Length -and $text[$index] -eq '}') {
                $index += 1
                break
            }
            throw 'invalid preference'
        }
        Skip-JsonWhitespace -Text $text -Index ([ref]$index)
        if (
            $index -ne $text.Length -or
            $seen.Count -ne 3 -or
            -not $seen.Contains('schemaVersion') -or
            -not $seen.Contains('bridgeEnabled') -or
            -not $seen.Contains('avatarEnabled')
        ) {
            throw 'invalid preference'
        }
    }

    $target = [Environment]::GetEnvironmentVariable('WHITELILY_COMPONENT_PREFERENCES_PATH')
    if ([string]::IsNullOrWhiteSpace($target) -or -not [IO.Path]::IsPathRooted($target)) {
        throw 'invalid preference'
    }
    $operation = [Environment]::GetEnvironmentVariable('WHITELILY_COMPONENT_PREFERENCES_OPERATION')
    if ([string]::IsNullOrEmpty($operation) -or $operation -ceq 'validate') {
        [byte[]]$bytes = [WhiteLily.Installer.PreferenceFileAuthority]::ReadOrdinarySingleLinkFile(
            $target,
            4096
        )
        Test-MinecraftComponentPreferenceBytes -Bytes $bytes
        exit 0
    }
    if ($operation -cne 'publish') { throw 'invalid preference' }
    $bridge = [Environment]::GetEnvironmentVariable('WHITELILY_COMPONENT_BRIDGE_ENABLED')
    $avatar = [Environment]::GetEnvironmentVariable('WHITELILY_COMPONENT_AVATAR_ENABLED')
    if ($bridge -cnotin @('true', 'false') -or $avatar -cnotin @('true', 'false')) {
        throw 'invalid preference'
    }
    $text = '{"schemaVersion":1,"bridgeEnabled":' + $bridge + ',"avatarEnabled":' + $avatar + '}'
    [byte[]]$expected = [Text.UTF8Encoding]::new($false, $true).GetBytes($text)
    Test-MinecraftComponentPreferenceBytes -Bytes $expected
    $owned = $null
    $operationFailure = $null
    $cleanupFailure = $null
    $publishedOrWon = $false
    try {
        $owned = [WhiteLily.Installer.OwnedPreferenceTemp]::Create(
            [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($target)),
            $expected
        )
        # WHITELILY_TEST_BEFORE_PUBLISH
        $owned.RevalidateBeforePublish()
        $publication = $owned.Publish($target)
        # WHITELILY_TEST_AFTER_PUBLISH
        if (-not $publication.Published) {
            if ($publication.ErrorCode -notin @(80, 183)) { throw 'preference publication failed' }
            [byte[]]$winner = [WhiteLily.Installer.PreferenceFileAuthority]::ReadOrdinarySingleLinkFile(
                $target,
                4096
            )
            Test-MinecraftComponentPreferenceBytes -Bytes $winner
            # WHITELILY_TEST_BEFORE_WINNER_CLEANUP
        }
        # WHITELILY_TEST_BEFORE_OWNED_CLEANUP
        $owned.DeleteOwned()
        $publishedOrWon = $true
    } catch {
        $operationFailure = $_
        if ($null -ne $owned) {
            try { $owned.DeleteOwned() } catch { $cleanupFailure = $_ }
        }
    } finally {
        if ($null -ne $owned) { $owned.Dispose() }
    }
    if ($null -ne $cleanupFailure -or $null -ne $operationFailure -or -not $publishedOrWon) {
        throw 'preference publication failed'
    }
    [byte[]]$finalBytes = [WhiteLily.Installer.PreferenceFileAuthority]::ReadOrdinarySingleLinkFile(
        $target,
        4096
    )
    Test-MinecraftComponentPreferenceBytes -Bytes $finalBytes
    exit 0
} catch {
    exit 1
}
