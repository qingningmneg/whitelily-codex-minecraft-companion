[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodeExecutable,
    [Parameter(Mandatory = $true)][string]$VerifierPath,
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [ValidateRange(100, 60000)][int]$TimeoutMilliseconds = 15000,
    [ValidateRange(64, 4096)][int]$MaximumOutputBytes = 256
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

try {
    if (-not ('WhiteLily.Packaging.BoundedChild' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace WhiteLily.Packaging
{
    public sealed class BoundedChildResult
    {
        public int ExitCode { get; set; }
        public byte[] StandardOutput { get; set; }
        public byte[] StandardError { get; set; }
    }

    public static class BoundedChild
    {
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        private const uint HANDLE_FLAG_INHERIT = 0x00000001;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const int JobObjectBasicAccountingInformation = 1;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
        private const uint STARTF_USESTDHANDLES = 0x00000100;
        private const uint WAIT_OBJECT_0 = 0;
        private const uint WAIT_TIMEOUT = 258;
        private const uint GENERIC_READ = 0x80000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint OPEN_EXISTING = 3;

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public int bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
            uint informationLength,
            IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CreatePipe(
            out IntPtr readPipe,
            out IntPtr writePipe,
            ref SECURITY_ATTRIBUTES pipeAttributes,
            int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            ref SECURITY_ATTRIBUTES securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList,
            int attributeCount,
            int flags,
            ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList,
            uint flags,
            IntPtr attribute,
            IntPtr value,
            IntPtr size,
            IntPtr previousValue,
            IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFOEX startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetProcessId(IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private static string Quote(string value)
        {
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
                return value;
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    slashes++;
                    continue;
                }
                if (character == '"')
                {
                    result.Append('\\', slashes * 2 + 1);
                    result.Append('"');
                    slashes = 0;
                    continue;
                }
                result.Append('\\', slashes);
                slashes = 0;
                result.Append(character);
            }
            result.Append('\\', slashes * 2);
            result.Append('"');
            return result.ToString();
        }

        private static async Task<byte[]> ReadBounded(Stream stream, int maximumBytes)
        {
            byte[] buffer = new byte[512];
            using (MemoryStream output = new MemoryStream())
            {
                while (true)
                {
                    int count = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                    if (count == 0) return output.ToArray();
                    if (output.Length + count > maximumBytes)
                        throw new InvalidDataException("bounded child output exceeded limit");
                    output.Write(buffer, 0, count);
                }
            }
        }

        private static int RemainingMilliseconds(Stopwatch elapsed, int timeoutMilliseconds)
        {
            long remaining = timeoutMilliseconds - elapsed.ElapsedMilliseconds;
            if (remaining <= 0) return 0;
            return remaining > Int32.MaxValue ? Int32.MaxValue : (int)remaining;
        }

        private static uint ActiveProcesses(IntPtr job)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting =
                new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
            if (!QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                ref accounting,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                IntPtr.Zero))
                throw new InvalidDataException("bounded child job query failed");
            return accounting.ActiveProcesses;
        }

        private static void Close(ref IntPtr handle)
        {
            if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return;
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }

        public static BoundedChildResult Run(
            string executable,
            string[] arguments,
            string workingDirectory,
            int timeoutMilliseconds,
            int maximumOutputBytes)
        {
            Stopwatch elapsed = Stopwatch.StartNew();
            IntPtr job = IntPtr.Zero;
            IntPtr stdoutRead = IntPtr.Zero;
            IntPtr stdoutWrite = IntPtr.Zero;
            IntPtr stderrRead = IntPtr.Zero;
            IntPtr stderrWrite = IntPtr.Zero;
            IntPtr stdinRead = IntPtr.Zero;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr handleList = IntPtr.Zero;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            bool processCreated = false;
            bool assigned = false;
            FileStream stdoutStream = null;
            FileStream stderrStream = null;
            try
            {
                SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES
                {
                    nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
                    lpSecurityDescriptor = IntPtr.Zero,
                    bInheritHandle = 1
                };
                if (!CreatePipe(out stdoutRead, out stdoutWrite, ref attributes, 0) ||
                    !SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0) ||
                    !CreatePipe(out stderrRead, out stderrWrite, ref attributes, 0) ||
                    !SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0))
                    throw new InvalidDataException("bounded child pipe setup failed");
                stdinRead = CreateFile(
                    "NUL",
                    GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    ref attributes,
                    OPEN_EXISTING,
                    0,
                    IntPtr.Zero);
                if (stdinRead == new IntPtr(-1))
                    throw new InvalidDataException("bounded child stdin setup failed");

                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw new InvalidDataException("bounded child job setup failed");
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                    new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if (!SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    ref limits,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                    throw new InvalidDataException("bounded child job policy failed");

                IntPtr attributeBytes = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
                if (attributeBytes == IntPtr.Zero)
                    throw new InvalidDataException("bounded child handle list size failed");
                attributeList = Marshal.AllocHGlobal(attributeBytes);
                if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes))
                    throw new InvalidDataException("bounded child handle list failed");
                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, stdinRead);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, stdoutWrite);
                Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, stderrWrite);
                if (!UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
                    handleList,
                    new IntPtr(IntPtr.Size * 3),
                    IntPtr.Zero,
                    IntPtr.Zero))
                    throw new InvalidDataException("bounded child handle list update failed");

                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = stdinRead;
                startup.StartupInfo.hStdOutput = stdoutWrite;
                startup.StartupInfo.hStdError = stderrWrite;
                startup.lpAttributeList = attributeList;
                StringBuilder command = new StringBuilder(Quote(executable));
                foreach (string argument in arguments)
                    command.Append(' ').Append(Quote(argument));
                if (!CreateProcess(
                    executable,
                    command,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                    IntPtr.Zero,
                    workingDirectory,
                    ref startup,
                    out process))
                    throw new InvalidDataException("bounded child creation failed");
                processCreated = true;
                if (GetProcessId(process.hProcess) == 0)
                    throw new InvalidDataException("bounded child process identity failed");
                if (!AssignProcessToJobObject(job, process.hProcess))
                    throw new InvalidDataException("bounded child job assignment failed");
                assigned = true;

                stdoutStream = new FileStream(
                    new SafeFileHandle(stdoutRead, true), FileAccess.Read, 512, false);
                stdoutRead = IntPtr.Zero;
                stderrStream = new FileStream(
                    new SafeFileHandle(stderrRead, true), FileAccess.Read, 512, false);
                stderrRead = IntPtr.Zero;
                Task<byte[]> stdout = ReadBounded(stdoutStream, maximumOutputBytes);
                Task<byte[]> stderr = ReadBounded(stderrStream, maximumOutputBytes);
                if (ResumeThread(process.hThread) == UInt32.MaxValue)
                    throw new InvalidDataException("bounded child resume failed");
                Close(ref process.hThread);
                Close(ref stdinRead);
                Close(ref stdoutWrite);
                Close(ref stderrWrite);

                bool failed = false;
                string failure = "";
                bool rootExited = false;
                while (!rootExited)
                {
                    if (stdout.IsFaulted || stderr.IsFaulted)
                    {
                        failed = true;
                        failure = "pipe-fault";
                        break;
                    }
                    int remaining = RemainingMilliseconds(elapsed, timeoutMilliseconds);
                    if (remaining == 0)
                    {
                        failed = true;
                        failure = "root-deadline";
                        break;
                    }
                    uint wait = WaitForSingleObject(process.hProcess, (uint)Math.Min(remaining, 10));
                    if (wait == WAIT_OBJECT_0) rootExited = true;
                    else if (wait != WAIT_TIMEOUT)
                    {
                        failed = true;
                        failure = "root-wait";
                        break;
                    }
                }
                uint exitCode = 1;
                if (rootExited && !GetExitCodeProcess(process.hProcess, out exitCode))
                {
                    failed = true;
                    failure = "exit-code";
                }
                uint active = ActiveProcesses(job);
                while (rootExited && active != 0 && !failed)
                {
                    int remaining = RemainingMilliseconds(elapsed, timeoutMilliseconds);
                    if (remaining == 0)
                    {
                        failed = true;
                        failure = "tree-deadline";
                        break;
                    }
                    System.Threading.Thread.Sleep(Math.Min(remaining, 2));
                    active = ActiveProcesses(job);
                }
                if (failed || !rootExited || active != 0)
                    TerminateJobObject(job, 1);
                while (ActiveProcesses(job) != 0)
                {
                    int remaining = RemainingMilliseconds(elapsed, timeoutMilliseconds);
                    if (remaining == 0)
                    {
                        failed = true;
                        failure = "job-deadline";
                        break;
                    }
                    System.Threading.Thread.Sleep(Math.Min(remaining, 5));
                }
                int drainRemaining = RemainingMilliseconds(elapsed, timeoutMilliseconds);
                bool drained = false;
                if (drainRemaining > 0)
                {
                    try { drained = Task.WaitAll(new Task[] { stdout, stderr }, drainRemaining); }
                    catch { failed = true; failure = "drain-fault"; drained = true; }
                }
                if (!drained || stdout.IsFaulted || stderr.IsFaulted)
                {
                    failed = true;
                    failure = "drain-incomplete";
                }
                if (failed)
                    throw new InvalidDataException("bounded child failed: " + failure);
                return new BoundedChildResult
                {
                    ExitCode = unchecked((int)exitCode),
                    StandardOutput = stdout.Result,
                    StandardError = stderr.Result
                };
            }
            finally
            {
                if (assigned && job != IntPtr.Zero) TerminateJobObject(job, 1);
                else if (processCreated && process.hProcess != IntPtr.Zero)
                    TerminateProcess(process.hProcess, 1);
                if (attributeList != IntPtr.Zero) DeleteProcThreadAttributeList(attributeList);
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
                if (stdoutStream != null) stdoutStream.Dispose();
                if (stderrStream != null) stderrStream.Dispose();
                Close(ref stdinRead);
                Close(ref stdoutRead);
                Close(ref stdoutWrite);
                Close(ref stderrRead);
                Close(ref stderrWrite);
                Close(ref process.hThread);
                Close(ref process.hProcess);
                Close(ref job);
            }
        }
    }
}
'@
    }

    $result = [WhiteLily.Packaging.BoundedChild]::Run(
        $NodeExecutable,
        [string[]]@($VerifierPath, $RepositoryRoot, $ManifestPath),
        $RepositoryRoot,
        $TimeoutMilliseconds,
        $MaximumOutputBytes
    )
    [byte[]]$expected = [System.Text.UTF8Encoding]::new($false).GetBytes(
        "{`"status`":`"ok`",`"files`":7}`n"
    )
    if (
        $result.ExitCode -ne 0 -or
        $result.StandardError.Length -ne 0 -or
        -not [System.Linq.Enumerable]::SequenceEqual(
            [byte[]]$result.StandardOutput,
            [byte[]]$expected
        )
    ) {
        throw 'invalid verifier protocol'
    }
    Write-Output '{"status":"ok","files":7}'
} catch {
    [Console]::Error.WriteLine('MINECRAFT_COMPONENT_VERIFIER_FAILED')
    exit 1
}
