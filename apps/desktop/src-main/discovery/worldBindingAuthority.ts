import { execFile as nodeExecFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../../../../src/config/loadConfig.js";
import type { ConfirmedWorldBinding } from "../../../../src/world/worldProfileStore.js";
import type { ConfirmedConnectionProof, LanDetector } from "./lanDetector.js";

const execFile = promisify(nodeExecFile);
const MAX_JAVA_PROCESS_SNAPSHOT_BYTES = 65_536;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface JavaProcessSnapshot {
  readonly pid: number;
  readonly processStartedAt: number;
  readonly executablePath: string;
  readonly commandLine: string;
}

export interface WorldBindingAuthorityOptions {
  configPath: string;
  lanDetector: Pick<LanDetector, "redeemConfirmedProof">;
  readJavaProcessSnapshot?: (pid: number) => Promise<JavaProcessSnapshot>;
  resolveInstancePath?: (snapshot: JavaProcessSnapshot) => Promise<string>;
}

/** Main-process-only authority derivation. Neither path nor owner enters IPC input. */
export class WorldBindingAuthority {
  readonly #configPath: string;
  readonly #lanDetector: Pick<LanDetector, "redeemConfirmedProof">;
  readonly #readJavaProcessSnapshot: (pid: number) => Promise<JavaProcessSnapshot>;
  readonly #resolveInstancePath: (snapshot: JavaProcessSnapshot) => Promise<string>;

  constructor(options: WorldBindingAuthorityOptions) {
    this.#configPath = options.configPath;
    this.#lanDetector = options.lanDetector;
    this.#readJavaProcessSnapshot = options.readJavaProcessSnapshot ?? readJavaProcessSnapshot;
    this.#resolveInstancePath = options.resolveInstancePath ?? resolveJavaGameDirectory;
  }

  async redeem(proof: ConfirmedConnectionProof): Promise<ConfirmedWorldBinding> {
    const session = await this.#lanDetector.redeemConfirmedProof(proof);
    const snapshot = await this.#readJavaProcessSnapshot(session.pid);
    assertExactJavaSession(snapshot, session);
    const [config, canonicalInstancePath] = await Promise.all([
      loadConfig(this.#configPath),
      this.#resolveInstancePath(snapshot),
    ]);
    // A process can exit and its PID be reused while resolving a filesystem path.
    // Re-read the process identity before the derived authority leaves main.
    const revalidated = await this.#readJavaProcessSnapshot(session.pid);
    assertExactJavaSession(revalidated, session);
    if (!sameJavaSnapshot(snapshot, revalidated)) {
      throw new Error("Java process identity changed while resolving the Minecraft instance path");
    }
    return Object.freeze({
      canonicalInstancePath,
      javaSession: {
        pid: session.pid,
        processStartedAt: session.processStartedAt,
        port: session.port,
        version: session.version,
      },
      ownerUsername: config.minecraft.ownerUsername,
      proof: { ...proof },
    });
  }
}

function assertExactJavaSession(
  snapshot: JavaProcessSnapshot,
  session: { pid: number; processStartedAt: number },
): void {
  if (
    snapshot.pid !== session.pid ||
    snapshot.processStartedAt !== session.processStartedAt ||
    !isJavaExecutable(snapshot.executablePath) ||
    snapshot.commandLine.length === 0
  ) {
    throw new Error("redeemed LAN session no longer identifies the same Java process");
  }
}

function sameJavaSnapshot(left: JavaProcessSnapshot, right: JavaProcessSnapshot): boolean {
  return (
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.executablePath === right.executablePath &&
    left.commandLine === right.commandLine
  );
}

function isJavaExecutable(executablePath: string): boolean {
  const filename = basename(executablePath).toLowerCase();
  return filename === "java.exe" || filename === "javaw.exe";
}

async function readJavaProcessSnapshot(pid: number): Promise<JavaProcessSnapshot> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid Java process id");
  const command = [
    "$WhiteLilyUtf8NoBom = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = $WhiteLilyUtf8NoBom",
    "$OutputEncoding = $WhiteLilyUtf8NoBom",
    "$p = Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "'",
    "if ($null -eq $p) { exit 3 }",
    "$started = [DateTimeOffset](Get-Process -Id $p.ProcessId).StartTime.ToUniversalTime()",
    "[pscustomobject]@{pid=$p.ProcessId;processStartedAt=$started.ToUnixTimeMilliseconds();executablePath=$p.ExecutablePath;commandLine=$p.CommandLine}|ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "buffer",
      maxBuffer: MAX_JAVA_PROCESS_SNAPSHOT_BYTES,
      shell: false,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (!Buffer.isBuffer(stdout)) throw new Error("invalid Java process snapshot encoding");
  return parseJavaProcessSnapshotOutput(stdout);
}

export function parseJavaProcessSnapshotOutput(output: Uint8Array): JavaProcessSnapshot {
  if (output.byteLength < 1 || output.byteLength > MAX_JAVA_PROCESS_SNAPSHOT_BYTES) {
    throw new Error("invalid Java process snapshot");
  }
  if (output[0] === 0xef && output[1] === 0xbb && output[2] === 0xbf) {
    throw new Error("invalid Java process snapshot encoding");
  }
  let decoded: string;
  try {
    decoded = strictUtf8Decoder.decode(output);
  } catch {
    throw new Error("invalid Java process snapshot encoding");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("invalid Java process snapshot");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Number.isSafeInteger((parsed as { pid?: unknown }).pid) ||
    !Number.isSafeInteger((parsed as { processStartedAt?: unknown }).processStartedAt) ||
    typeof (parsed as { executablePath?: unknown }).executablePath !== "string" ||
    typeof (parsed as { commandLine?: unknown }).commandLine !== "string"
  ) {
    throw new Error("invalid Java process snapshot");
  }
  return Object.freeze({
    pid: (parsed as { pid: number }).pid,
    processStartedAt: (parsed as { processStartedAt: number }).processStartedAt,
    executablePath: (parsed as { executablePath: string }).executablePath,
    commandLine: (parsed as { commandLine: string }).commandLine,
  });
}

async function resolveJavaGameDirectory(snapshot: JavaProcessSnapshot): Promise<string> {
  const match = /(?:^|\s)--gameDir(?:=|\s+)(?:"([^"]+)"|([^\s]+))/u.exec(snapshot.commandLine);
  const requested = match?.[1] ?? match?.[2];
  if (!requested || requested.includes("\u0000")) {
    throw new Error("Minecraft instance path is unavailable");
  }
  const canonical = await realpath(requested);
  if (!(await stat(canonical)).isDirectory()) throw new Error("Minecraft instance path is invalid");
  return canonical;
}
