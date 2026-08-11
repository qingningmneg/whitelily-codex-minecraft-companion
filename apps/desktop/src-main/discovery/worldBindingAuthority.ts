import { execFile as nodeExecFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../../../../src/config/loadConfig.js";
import type { ConfirmedWorldBinding } from "../../../../src/world/worldProfileStore.js";
import type { ConfirmedConnectionProof, LanDetector } from "./lanDetector.js";
import type { LanObservation } from "./lanCandidateStore.js";
import { assertWindowsPathsAreOrdinary } from "./windowsReparseProbe.js";

export { assertWindowsPathsAreOrdinary } from "./windowsReparseProbe.js";

const execFile = promisify(nodeExecFile);
const MAX_JAVA_PROCESS_SNAPSHOT_BYTES = 1_048_576;
const JAVA_PROCESS_SNAPSHOT_TIMEOUT_MS = 10_000;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface JavaProcessSnapshot {
  readonly pid: number;
  readonly processStartedAt: number;
  readonly executablePath: string;
  readonly commandLine: string;
}

export type JavaProcessSnapshotExecFile = (
  file: string,
  args: readonly string[],
  options: {
    readonly encoding: "buffer";
    readonly maxBuffer: number;
    readonly shell: false;
    readonly timeout: number;
    readonly windowsHide: true;
  },
) => Promise<{ readonly stdout: Buffer }>;

export interface WorldBindingAuthorityOptions {
  configPath: string;
  lanDetector: Pick<LanDetector, "redeemConfirmedProof">;
  readJavaProcessSnapshot?: (pid: number) => Promise<JavaProcessSnapshot>;
  resolveInstancePath?: (snapshot: JavaProcessSnapshot) => Promise<string>;
  /** Main-process-only child-boundary port; production composition uses the fixed default. */
  snapshotExecFile?: JavaProcessSnapshotExecFile;
}

export interface ResolvedJavaInstance {
  readonly canonicalInstancePath: string;
  readonly javaSession: Readonly<LanObservation>;
  readonly snapshot: Readonly<JavaProcessSnapshot>;
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
    const snapshotExecFile: JavaProcessSnapshotExecFile = options.snapshotExecFile ?? execFile;
    this.#readJavaProcessSnapshot =
      options.readJavaProcessSnapshot ?? ((pid) => readJavaProcessSnapshot(pid, snapshotExecFile));
    this.#resolveInstancePath = options.resolveInstancePath ?? resolveJavaGameDirectory;
  }

  async redeem(proof: ConfirmedConnectionProof): Promise<ConfirmedWorldBinding> {
    const session = await this.#lanDetector.redeemConfirmedProof(proof);
    const [config, instance] = await Promise.all([
      loadConfig(this.#configPath),
      this.resolveJavaInstance(session),
    ]);
    return Object.freeze({
      canonicalInstancePath: instance.canonicalInstancePath,
      javaSession: instance.javaSession,
      ownerUsername: config.minecraft.ownerUsername,
      proof: { ...proof },
    });
  }

  /** Main-process-only Java identity and canonical game-directory derivation. */
  async resolveJavaInstance(observation: LanObservation): Promise<ResolvedJavaInstance> {
    const snapshot = await this.#readJavaProcessSnapshot(observation.pid);
    assertExactJavaSession(snapshot, observation);
    const canonicalInstancePath = await this.#resolveInstancePath(snapshot);
    // A process can exit and its PID be reused while resolving a filesystem path.
    // Re-read the complete process identity before derived authority leaves main.
    const revalidated = await this.#readJavaProcessSnapshot(observation.pid);
    assertExactJavaSession(revalidated, observation);
    if (!sameJavaSnapshot(snapshot, revalidated)) {
      throw new Error("Java process identity changed while resolving the Minecraft instance path");
    }
    return Object.freeze({
      canonicalInstancePath,
      javaSession: Object.freeze({ ...observation }),
      snapshot: Object.freeze({ ...snapshot }),
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

async function readJavaProcessSnapshot(
  pid: number,
  snapshotExecFile: JavaProcessSnapshotExecFile = execFile,
): Promise<JavaProcessSnapshot> {
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
  let stdout: Buffer;
  try {
    ({ stdout } = await snapshotExecFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        encoding: "buffer",
        maxBuffer: MAX_JAVA_PROCESS_SNAPSHOT_BYTES,
        shell: false,
        timeout: JAVA_PROCESS_SNAPSHOT_TIMEOUT_MS,
        windowsHide: true,
      },
    ));
  } catch {
    throw new Error("Java process snapshot unavailable");
  }
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
  const matches = [
    ...snapshot.commandLine.matchAll(/(?:^|\s)--gameDir(?:=|\s+)(?:"([^"]+)"|([^\s]+))(?=\s|$)/gu),
  ];
  const requested = matches[0]?.[1] ?? matches[0]?.[2];
  if (
    matches.length !== 1 ||
    !requested ||
    requested.includes("\u0000") ||
    !isAbsolute(requested)
  ) {
    throw new Error("Minecraft instance path is unavailable");
  }
  const resolved = resolve(requested);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Minecraft instance path is invalid");
  }
  await assertWindowsPathsAreOrdinary([resolved]);
  const canonical = await realpath(requested);
  if (!samePath(resolve(canonical), resolved)) {
    throw new Error("Minecraft instance path is invalid");
  }
  await assertWindowsPathsAreOrdinary([resolved]);
  return resolve(canonical);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
