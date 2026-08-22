import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";

const MAX_REPARSE_PROBE_BYTES = 65_536;
const MAX_REPARSE_RESPONSE_BYTES = 8;
const DEFAULT_REPARSE_PROBE_IDLE_MS = 1_000;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const WINDOWS_REPARSE_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class WhiteLilyReparseProbe {
  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ATTRIBUTE_TAG_INFO {
    public uint FileAttributes;
    public uint ReparseTag;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle file,
    int informationClass,
    out FILE_ATTRIBUTE_TAG_INFO information,
    uint size);

  public static bool IsReparsePoint(string path) {
    const uint FILE_SHARE_ALL = 0x00000007;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    using (SafeFileHandle handle = CreateFileW(
      path,
      0,
      FILE_SHARE_ALL,
      IntPtr.Zero,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
      IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      FILE_ATTRIBUTE_TAG_INFO information;
      uint size = (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO));
      if (!GetFileInformationByHandleEx(handle, 9, out information, size)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$encoded = $null
while (($encoded = [Console]::In.ReadLine()) -ne $null) {
  $reply = 'ERR'
  try {
    if ($encoded.Length -lt 1 -or $encoded.Length -gt 65536) { throw 'invalid' }
    $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    $document = $decoded | ConvertFrom-Json
    if ($document.PSObject.Properties.Count -ne 1) { throw 'invalid' }
    $paths = @($document.paths)
    if ($paths.Count -lt 1 -or $paths.Count -gt 256) { throw 'invalid' }
    for ($index = 0; $index -lt $paths.Count; $index += 1) {
      $currentPath = [string]($paths[$index])
      if ([WhiteLilyReparseProbe]::IsReparsePoint($currentPath)) { throw 'invalid' }
    }
    $reply = 'OK'
  } catch {
    $reply = 'ERR'
  }
  [Console]::Out.WriteLine($reply)
  [Console]::Out.Flush()
}
`;

export interface WindowsReparseProbeAuthorityOptions {
  readonly spawnProcess?: typeof spawn;
  readonly idleMs?: number;
}

/** Main-only serialized authority. Its narrow constructor supports real-process lifecycle tests. */
export class WindowsReparseProbeAuthority {
  readonly #spawnProcess: typeof spawn;
  readonly #idleMs: number;
  #runner: WindowsReparseProbeRunner | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: WindowsReparseProbeAuthorityOptions = {}) {
    this.#spawnProcess = options.spawnProcess ?? spawn;
    this.#idleMs = options.idleMs ?? DEFAULT_REPARSE_PROBE_IDLE_MS;
    if (!Number.isSafeInteger(this.#idleMs) || this.#idleMs < 1) throw new Error("invalid");
  }

  async assertPathsAreOrdinary(paths: readonly string[]): Promise<void> {
    if (process.platform !== "win32") throw new Error("Windows reparse boundary unavailable");
    const expanded = new Set<string>();
    for (const path of paths) {
      if (!isAbsolute(path) || path.includes("\u0000")) {
        throw new Error("Windows reparse boundary invalid");
      }
      let current = resolve(path);
      for (;;) {
        expanded.add(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    const encoded = Buffer.from(JSON.stringify({ paths: [...expanded] }), "utf8").toString(
      "base64",
    );
    if (encoded.length < 1 || encoded.length > MAX_REPARSE_PROBE_BYTES) {
      throw new Error("Windows reparse boundary invalid");
    }
    const queued = this.#tail.then(async () => {
      if (this.#runner === undefined || this.#runner.closed) {
        const runner = new WindowsReparseProbeRunner({
          spawnProcess: this.#spawnProcess,
          idleMs: this.#idleMs,
          onClosed: () => {
            if (this.#runner === runner) this.#runner = undefined;
          },
        });
        this.#runner = runner;
      }
      await this.#runner.request(encoded);
    });
    this.#tail = queued.catch(() => undefined);
    try {
      await queued;
    } catch {
      throw new Error("Windows reparse boundary invalid");
    }
  }

  close(): void {
    this.#runner?.close();
    this.#runner = undefined;
  }
}

interface WindowsReparseProbeRunnerOptions {
  readonly spawnProcess: typeof spawn;
  readonly idleMs: number;
  readonly onClosed: () => void;
}

class WindowsReparseProbeRunner {
  readonly #child;
  readonly #idleMs: number;
  readonly #onClosed: () => void;
  #idleTimer: NodeJS.Timeout | undefined;
  #pending:
    | {
        readonly resolve: () => void;
        readonly reject: (error: Error) => void;
        readonly timeout: NodeJS.Timeout;
      }
    | undefined;
  #response = Buffer.alloc(0);
  #closed = false;
  readonly #onProcessExit = () => this.#terminate(new Error("probe parent exited"));

  constructor(options: WindowsReparseProbeRunnerOptions) {
    this.#idleMs = options.idleMs;
    this.#onClosed = options.onClosed;
    this.#child = options.spawnProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_REPARSE_PROBE_SCRIPT],
      { shell: false, stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    this.#child.unref();
    (this.#child.stdin as NodeJS.WritableStream & { unref?: () => void }).unref?.();
    (this.#child.stdout as NodeJS.ReadableStream & { unref?: () => void }).unref?.();
    this.#child.once("error", () => this.#terminate(new Error("probe start failed")));
    this.#child.once("close", () => this.#terminate(new Error("probe exited")));
    this.#child.stdout!.on("data", (chunk: Buffer) => this.#acceptResponse(chunk));
    process.once("exit", this.#onProcessExit);
  }

  get closed(): boolean {
    return this.#closed;
  }

  request(encoded: string): Promise<void> {
    if (
      this.#closed ||
      this.#pending !== undefined ||
      encoded.includes("\r") ||
      encoded.includes("\n")
    ) {
      return Promise.reject(new Error("probe unavailable"));
    }
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    return new Promise<void>((resolveProbe, rejectProbe) => {
      const timeout = setTimeout(() => this.#terminate(new Error("probe timeout")), 5_000);
      this.#pending = { resolve: resolveProbe, reject: rejectProbe, timeout };
      this.#response = Buffer.alloc(0);
      this.#child.stdin!.write(`${encoded}\n`, "utf8", (error?: Error | null) => {
        if (error) this.#terminate(new Error("probe input failed"));
      });
    });
  }

  close(): void {
    this.#terminate(new Error("probe closed"));
  }

  #acceptResponse(chunk: Buffer): void {
    if (this.#closed || this.#pending === undefined) {
      this.#terminate(new Error("unsolicited probe output"));
      return;
    }
    this.#response = Buffer.concat([this.#response, chunk]);
    if (this.#response.byteLength > MAX_REPARSE_RESPONSE_BYTES) {
      this.#terminate(new Error("probe output exceeded limit"));
      return;
    }
    if (!this.#response.includes(0x0a)) return;
    let response: string;
    try {
      response = strictUtf8Decoder.decode(this.#response);
    } catch {
      this.#terminate(new Error("probe output invalid"));
      return;
    }
    if (
      response !== "OK\r\n" &&
      response !== "OK\n" &&
      response !== "ERR\r\n" &&
      response !== "ERR\n"
    ) {
      this.#terminate(new Error("probe output invalid"));
      return;
    }
    const pending = this.#pending;
    this.#pending = undefined;
    this.#response = Buffer.alloc(0);
    clearTimeout(pending.timeout);
    this.#idleTimer = setTimeout(() => this.#terminate(new Error("probe idle")), this.#idleMs);
    this.#idleTimer.unref();
    if (response.startsWith("OK")) pending.resolve();
    else pending.reject(new Error("probe rejected path"));
  }

  #terminate(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    process.removeListener("exit", this.#onProcessExit);
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending !== undefined) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#child.stdin?.destroy();
    this.#child.stdout?.destroy();
    if (this.#child.exitCode === null && !this.#child.killed) this.#child.kill();
    this.#onClosed();
  }
}

const defaultWindowsReparseProbeAuthority = new WindowsReparseProbeAuthority();

/** Main-process-only, handle-bound Windows reparse check for fixed trusted paths and ancestors. */
export async function assertWindowsPathsAreOrdinary(paths: readonly string[]): Promise<void> {
  await defaultWindowsReparseProbeAuthority.assertPathsAreOrdinary(paths);
}
