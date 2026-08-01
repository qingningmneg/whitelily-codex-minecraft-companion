import { ZipArchive } from "archiver";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import {
  createDiagnosticEntries,
  DIAGNOSTIC_OMISSIONS,
  type DiagnosticEntry,
  type DiagnosticPreview,
} from "./diagnosticManifest.js";

export const DIAGNOSTIC_PREVIEW_TTL_MS = 10 * 60 * 1_000;
export const MAX_DIAGNOSTIC_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const exportIdPattern = /^[A-Za-z0-9_-]{16,64}$/u;

export interface DiagnosticExporterOptions {
  dataRoot: string;
  appVersion: string;
  osSummary: Readonly<Record<string, unknown>>;
  dependencyVersions: Readonly<Record<string, unknown>>;
  compatibilityManifest: Readonly<Record<string, unknown>>;
  configSchemaSummary: Readonly<Record<string, unknown>>;
  now?: () => number;
  createExportId?: () => string;
  previewTtlMs?: number;
}

export interface PreparedDiagnosticArchive {
  exportId: string;
  path: string;
  size: number;
  sha256: string;
}

interface ActivePreview {
  exportId: string;
  expiresAt: number;
  entries: readonly DiagnosticEntry[];
}

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
  size?: number;
}

interface PreparedArtifact {
  path: string;
  parent: TrustedKnownDirectoryIdentity;
  file: FileIdentity;
}

export class DiagnosticExporter {
  readonly #dataRoot: string;
  readonly #diagnosticsRoot: string;
  readonly #logsRoot: string;
  readonly #now: () => number;
  readonly #createExportId: () => string;
  readonly #previewTtlMs: number;
  readonly #metadata: Omit<
    DiagnosticExporterOptions,
    "dataRoot" | "now" | "createExportId" | "previewTtlMs"
  >;
  #active: ActivePreview | undefined;
  #preparedArtifact: PreparedArtifact | undefined;

  constructor(options: DiagnosticExporterOptions) {
    this.#dataRoot = resolve(options.dataRoot);
    this.#logsRoot = this.#withinDataRoot("logs");
    this.#diagnosticsRoot = this.#withinDataRoot("diagnostics");
    this.#now = options.now ?? Date.now;
    this.#createExportId =
      options.createExportId ?? (() => `diagnostic_${randomUUID().replaceAll("-", "")}`);
    this.#previewTtlMs = options.previewTtlMs ?? DIAGNOSTIC_PREVIEW_TTL_MS;
    if (!Number.isSafeInteger(this.#previewTtlMs) || this.#previewTtlMs < 1) {
      throw new Error("diagnostic preview TTL is invalid");
    }
    this.#metadata = {
      appVersion: options.appVersion,
      osSummary: options.osSummary,
      dependencyVersions: options.dependencyVersions,
      compatibilityManifest: options.compatibilityManifest,
      configSchemaSummary: options.configSchemaSummary,
    };
  }

  async preview(): Promise<DiagnosticPreview> {
    await this.#releaseRetained();
    const exportId = this.#createExportId();
    if (!exportIdPattern.test(exportId)) throw new Error("diagnostic export id is invalid");
    const logsIdentity = await inspectTrustedKnownDirectory(this.#dataRoot, this.#logsRoot);
    const entries = createDiagnosticEntries({
      ...this.#metadata,
      appLog: logsIdentity
        ? await readKnownRegularFile(
            join(this.#logsRoot, "companion.log"),
            MAX_LOG_BYTES,
            logsIdentity,
          )
        : "",
      auditLog: logsIdentity
        ? await readKnownRegularFile(
            join(this.#logsRoot, "audit.jsonl"),
            MAX_LOG_BYTES,
            logsIdentity,
          )
        : "",
    });
    this.#active = {
      exportId,
      expiresAt: this.#now() + this.#previewTtlMs,
      entries,
    };
    return Object.freeze({
      exportId,
      files: entries.map((entry) =>
        Object.freeze({
          logicalName: entry.logicalName,
          size: entry.content.byteLength,
          redactions: entry.redactions,
        }),
      ),
      omitted: [...DIAGNOSTIC_OMISSIONS],
    });
  }

  async createArchive(exportId: string): Promise<PreparedDiagnosticArchive> {
    if (!exportIdPattern.test(exportId)) throw new Error("diagnostic preview is unavailable");
    const active = this.#active;
    if (!active || active.exportId !== exportId) {
      throw new Error("diagnostic preview is unavailable");
    }
    if (this.#now() > active.expiresAt) {
      await this.#releaseRetained();
      throw new Error("diagnostic preview expired");
    }
    if (this.#preparedArtifact) {
      throw new Error("diagnostic archive is already prepared");
    }
    await mkdir(this.#diagnosticsRoot, { recursive: true });
    const diagnosticsIdentity = await inspectTrustedKnownDirectory(
      this.#dataRoot,
      this.#diagnosticsRoot,
    );
    if (!diagnosticsIdentity) {
      throw new Error("diagnostic directory is not trusted");
    }
    const path = join(this.#diagnosticsRoot, `${exportId}.zip`);
    assertWithin(this.#diagnosticsRoot, path);
    let createdFile: FileIdentity | undefined;
    try {
      const attestation = await writeArchive(path, active.entries, diagnosticsIdentity);
      createdFile = attestation.file;
      const value = await lstat(path);
      if (
        !(await isTrustedKnownDirectory(this.#dataRoot, this.#diagnosticsRoot)) ||
        !value.isFile() ||
        value.isSymbolicLink() ||
        value.dev !== attestation.file.dev ||
        value.ino !== attestation.file.ino
      ) {
        throw new Error("diagnostic archive is invalid");
      }
      if (value.size !== attestation.size || value.size > MAX_DIAGNOSTIC_ARCHIVE_BYTES) {
        throw new Error("diagnostic archive is too large");
      }
      this.#active = undefined;
      this.#preparedArtifact = {
        path,
        parent: diagnosticsIdentity,
        file: { ...attestation.file, size: value.size },
      };
      return Object.freeze({
        exportId,
        path,
        size: attestation.size,
        sha256: attestation.sha256,
      });
    } catch (error) {
      if (createdFile) await removeCreatedArchive(path, createdFile);
      throw error;
    }
  }

  async release(exportId: string): Promise<void> {
    if (!exportIdPattern.test(exportId)) return;
    if (
      this.#active?.exportId === exportId ||
      this.#preparedArtifact?.path.endsWith(`${exportId}.zip`)
    ) {
      await this.#releaseRetained();
    }
  }

  retainedArtifactCount(): Promise<number> {
    return Promise.resolve(this.#preparedArtifact === undefined ? 0 : 1);
  }

  dispose(): Promise<void> {
    return this.#releaseRetained();
  }

  async #releaseRetained(): Promise<void> {
    const artifact = this.#preparedArtifact;
    this.#active = undefined;
    this.#preparedArtifact = undefined;
    if (artifact) await removeTrustedArchive(artifact);
  }

  #withinDataRoot(child: string): string {
    const value = resolve(this.#dataRoot, child);
    assertWithin(this.#dataRoot, value);
    return value;
  }
}

async function isTrustedKnownDirectory(root: string, candidate: string): Promise<boolean> {
  return (await inspectTrustedKnownDirectory(root, candidate)) !== undefined;
}

interface TrustedKnownDirectoryIdentity {
  root: string;
  path: string;
  rootDev: number | bigint;
  rootIno: number | bigint;
  dev: number | bigint;
  ino: number | bigint;
}

async function inspectTrustedKnownDirectory(
  root: string,
  candidate: string,
): Promise<TrustedKnownDirectoryIdentity | undefined> {
  try {
    const [rootStat, candidateStat] = await Promise.all([lstat(root), lstat(candidate)]);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !candidateStat.isDirectory() ||
      candidateStat.isSymbolicLink()
    ) {
      return undefined;
    }
    const [canonicalRoot, canonicalCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
    if (
      normalizePath(canonicalRoot) !== normalizePath(root) ||
      normalizePath(canonicalCandidate) !== normalizePath(candidate)
    ) {
      return undefined;
    }
    return {
      root,
      path: candidate,
      rootDev: rootStat.dev,
      rootIno: rootStat.ino,
      dev: candidateStat.dev,
      ino: candidateStat.ino,
    };
  } catch {
    return undefined;
  }
}

function sameTrustedKnownDirectory(
  expected: TrustedKnownDirectoryIdentity,
  actual: TrustedKnownDirectoryIdentity | undefined,
): boolean {
  return (
    actual !== undefined &&
    normalizePath(actual.root) === normalizePath(expected.root) &&
    normalizePath(actual.path) === normalizePath(expected.path) &&
    actual.rootDev === expected.rootDev &&
    actual.rootIno === expected.rootIno &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino
  );
}

function normalizePath(value: string): string {
  return resolve(value).toLocaleLowerCase("en-US");
}

async function readKnownRegularFile(
  path: string,
  maxBytes: number,
  expectedParent: TrustedKnownDirectoryIdentity,
): Promise<string> {
  if (
    !sameTrustedKnownDirectory(
      expectedParent,
      await inspectTrustedKnownDirectory(expectedParent.root, expectedParent.path),
    )
  ) {
    return "";
  }
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return "";
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) return "";
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return "";
    if (
      !sameTrustedKnownDirectory(
        expectedParent,
        await inspectTrustedKnownDirectory(expectedParent.root, expectedParent.path),
      )
    ) {
      return "";
    }
    const length = Math.min(opened.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const after = await lstat(path);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      return "";
    }
    if (
      !sameTrustedKnownDirectory(
        expectedParent,
        await inspectTrustedKnownDirectory(expectedParent.root, expectedParent.path),
      )
    ) {
      return "";
    }
    const value = buffer.subarray(0, bytesRead).toString("utf8");
    return opened.size > maxBytes ? `${value}\n{"truncated":true}\n` : value;
  } finally {
    await handle.close();
  }
}

async function removeTrustedArchive(artifact: PreparedArtifact): Promise<void> {
  assertWithin(artifact.parent.path, artifact.path);
  if (
    !sameTrustedKnownDirectory(
      artifact.parent,
      await inspectTrustedKnownDirectory(artifact.parent.root, artifact.parent.path),
    )
  ) {
    return;
  }
  try {
    const value = await lstat(artifact.path);
    if (
      !value.isFile() ||
      value.isSymbolicLink() ||
      value.dev !== artifact.file.dev ||
      value.ino !== artifact.file.ino ||
      (artifact.file.size !== undefined && value.size !== artifact.file.size)
    ) {
      return;
    }
    const canonicalPath = await realpath(artifact.path);
    if (normalizePath(canonicalPath) !== normalizePath(artifact.path)) return;
    await removeCreatedArchive(artifact.path, artifact.file);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function writeArchive(
  path: string,
  entries: readonly DiagnosticEntry[],
  expectedParent: TrustedKnownDirectoryIdentity,
): Promise<{ size: number; sha256: string; file: FileIdentity }> {
  const handle = await open(path, "wx", 0o600);
  let streamOwnsHandle = false;
  let handleClosed = false;
  let createdFile: FileIdentity | undefined;
  try {
    const opened = await handle.stat();
    createdFile = { dev: opened.dev, ino: opened.ino };
    const selected = await lstat(path);
    if (
      !opened.isFile() ||
      !selected.isFile() ||
      selected.isSymbolicLink() ||
      opened.dev !== selected.dev ||
      opened.ino !== selected.ino ||
      !sameTrustedKnownDirectory(
        expectedParent,
        await inspectTrustedKnownDirectory(expectedParent.root, expectedParent.path),
      )
    ) {
      throw new Error("diagnostic archive destination is not trusted");
    }
    const output = handle.createWriteStream({ autoClose: true });
    streamOwnsHandle = true;
    return {
      ...(await streamArchive(output, entries, MAX_DIAGNOSTIC_ARCHIVE_BYTES)),
      file: createdFile,
    };
  } catch (error) {
    if (!streamOwnsHandle) {
      await handle.close().catch(() => undefined);
      handleClosed = true;
    }
    if (createdFile) await removeCreatedArchive(path, createdFile);
    throw error;
  } finally {
    if (!streamOwnsHandle && !handleClosed) await handle.close();
  }
}

function streamArchive(
  output: ReturnType<Awaited<ReturnType<typeof open>>["createWriteStream"]>,
  entries: readonly DiagnosticEntry[],
  maxBytes: number,
): Promise<{ size: number; sha256: string }> {
  return new Promise((resolvePromise, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const hash = createHash("sha256");
    let bytes = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (bytes + chunk.byteLength > maxBytes) {
          callback(new Error("diagnostic archive exceeds maximum size"));
          return;
        }
        bytes += chunk.byteLength;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    let settled = false;
    let failure: Error | undefined;
    const fail = (error: Error): void => {
      if (settled || failure) return;
      failure = error;
      archive.abort();
      bounded.destroy();
      output.destroy(error);
    };
    output.once("close", () => {
      if (settled) return;
      settled = true;
      if (failure) {
        reject(failure);
        return;
      }
      resolvePromise({ size: output.bytesWritten, sha256: hash.digest("hex") });
    });
    output.once("error", fail);
    archive.once("error", fail);
    bounded.once("error", fail);
    archive.pipe(bounded).pipe(output);
    for (const entry of entries) {
      archive.append(entry.content, {
        name: entry.logicalName,
        date: new Date(0),
        mode: 0o600,
      });
    }
    void archive.finalize().catch(fail);
  });
}

async function removeCreatedArchive(path: string, expected: FileIdentity): Promise<void> {
  const quarantine = `${path}.cleanup-${randomUUID()}`;
  try {
    const current = await lstat(path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      (expected.size !== undefined && current.size !== expected.size)
    ) {
      return;
    }
    await rename(path, quarantine);
    const moved = await lstat(quarantine);
    if (
      !moved.isFile() ||
      moved.isSymbolicLink() ||
      moved.dev !== expected.dev ||
      moved.ino !== expected.ino ||
      (expected.size !== undefined && moved.size !== expected.size)
    ) {
      try {
        await lstat(path);
      } catch (error) {
        if (isNotFound(error)) await rename(quarantine, path);
      }
      return;
    }
    await rm(quarantine, { force: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function assertWithin(root: string, value: string): void {
  const child = relative(root, value);
  if (
    child === "" ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    relative(root, value) === ""
  ) {
    if (child !== "") throw new Error("diagnostic path escaped data root");
  }
  if (child.startsWith(`..${sep}`) || child === "..") {
    throw new Error("diagnostic path escaped data root");
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
