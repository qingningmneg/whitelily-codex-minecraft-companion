import { createHash } from "node:crypto";
import { lstat, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve, win32 } from "node:path";

const exportIdPattern = /^[A-Za-z0-9_-]{16,64}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const MAX_DIAGNOSTIC_ARCHIVE_BYTES = 4 * 1024 * 1024;

export interface DiagnosticSaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface DiagnosticArchivePreparation {
  exportId: string;
  size: number;
  sha256: string;
}

export interface SaveDiagnosticArchiveOptions {
  dataRoot: string;
  exportId: string;
  chooseDestination(): Promise<DiagnosticSaveDialogResult>;
  prepareArchive(exportId: string): Promise<DiagnosticArchivePreparation>;
}

export async function saveDiagnosticArchive(
  options: SaveDiagnosticArchiveOptions,
): Promise<{ status: "cancelled" | "saved" }> {
  if (!exportIdPattern.test(options.exportId)) {
    throw new Error("invalid diagnostic export id");
  }
  const selection = await options.chooseDestination();
  assertDialogResult(selection);
  if (selection.canceled) return Object.freeze({ status: "cancelled" });
  if (!selection.filePath) throw new Error("choose a safe ZIP file");
  const destination = validateSafeWindowsZipPath(selection.filePath);
  const destinationParentBefore = await assertTrustedParents(destination);
  await assertTargetDoesNotExist(destination);

  const source = resolve(options.dataRoot, "diagnostics", `${options.exportId}.zip`);
  assertExactArchiveSource(options.dataRoot, source, options.exportId);
  let sourceHandle: FileHandle | undefined;
  let destinationHandle: FileHandle | undefined;
  let sourceCleanup:
    | {
        parent: TrustedDirectoryIdentity;
        file: Awaited<ReturnType<FileHandle["stat"]>>;
      }
    | undefined;
  try {
    const prepared = await options.prepareArchive(options.exportId);
    if (
      prepared.exportId !== options.exportId ||
      !Number.isSafeInteger(prepared.size) ||
      prepared.size < 0 ||
      prepared.size > MAX_DIAGNOSTIC_ARCHIVE_BYTES ||
      !sha256Pattern.test(prepared.sha256)
    ) {
      throw new Error("diagnostic archive preparation is invalid");
    }
    const sourceParentBefore = await assertTrustedParents(source);
    const sourceBefore = await lstat(source);
    if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink()) {
      throw new Error("diagnostic archive is not a trusted regular file");
    }
    const canonicalSource = await realpath(source);
    if (normalizeIdentityPath(canonicalSource) !== normalizeIdentityPath(source)) {
      throw new Error("diagnostic archive is not a trusted regular file");
    }
    sourceHandle = await open(source, "r");
    const openedSource = await sourceHandle.stat();
    if (
      !openedSource.isFile() ||
      sourceBefore.dev !== openedSource.dev ||
      sourceBefore.ino !== openedSource.ino ||
      openedSource.size !== prepared.size
    ) {
      throw new Error("diagnostic archive is not a trusted regular file");
    }
    sourceCleanup = { parent: sourceParentBefore, file: openedSource };
    const sourceBytes = await readFileHandle(sourceHandle, prepared.size);
    if (createHash("sha256").update(sourceBytes).digest("hex") !== prepared.sha256) {
      throw new Error("diagnostic archive content attestation failed");
    }
    await assertUnchangedFile(source, openedSource, prepared.size);

    const destinationParentPreOpen = await inspectTrustedDirectory(destinationParentBefore.path);
    if (!sameDirectoryIdentity(destinationParentBefore, destinationParentPreOpen)) {
      throw new Error("diagnostic export destination changed before open");
    }
    destinationHandle = await open(destination, "wx", 0o600);
    const openedDestination = await destinationHandle.stat();
    if (!openedDestination.isFile()) {
      throw new Error("diagnostic export destination is not a regular file");
    }
    const selectedDestination = await lstat(destination);
    if (
      !selectedDestination.isFile() ||
      selectedDestination.isSymbolicLink() ||
      selectedDestination.dev !== openedDestination.dev ||
      selectedDestination.ino !== openedDestination.ino
    ) {
      throw new Error("diagnostic export destination changed before write");
    }
    const destinationParentOpened = await inspectTrustedDirectory(destinationParentBefore.path);
    if (!sameDirectoryIdentity(destinationParentBefore, destinationParentOpened)) {
      throw new Error("diagnostic export destination changed before write");
    }
    const copied = await writeFileHandle(destinationHandle, sourceBytes);
    if (copied !== prepared.size) throw new Error("diagnostic archive changed during export");
    await destinationHandle.sync();
    await assertUnchangedFile(destination, openedDestination, prepared.size);
    const destinationParentAfter = await inspectTrustedDirectory(destinationParentBefore.path);
    if (!sameDirectoryIdentity(destinationParentBefore, destinationParentAfter)) {
      throw new Error("diagnostic export destination changed during export");
    }
    await assertUnchangedFile(source, openedSource, prepared.size);
    return Object.freeze({ status: "saved" });
  } catch (error) {
    if (isAlreadyExists(error)) throw new Error("diagnostic export destination already exists");
    throw error;
  } finally {
    await sourceHandle?.close().catch(() => undefined);
    await destinationHandle?.close().catch(() => undefined);
    if (sourceCleanup) {
      await removeUnchangedTrustedFile(source, sourceCleanup.parent, sourceCleanup.file).catch(
        () => undefined,
      );
    }
  }
}

export function validateSafeWindowsZipPath(path: string): string {
  if (
    path.includes("\0") ||
    !/^[A-Za-z]:\\[^/]*$/u.test(path) ||
    win32.normalize(path) !== path ||
    win32.extname(path).toLocaleLowerCase("en-US") !== ".zip"
  ) {
    throw new Error("choose a safe ZIP file");
  }
  const components = path.slice(3).split("\\");
  if (components.length === 0 || components.some(isReservedWindowsComponent)) {
    throw new Error("choose a safe ZIP file");
  }
  return path;
}

function assertDialogResult(value: unknown): asserts value is DiagnosticSaveDialogResult {
  if (
    !value ||
    typeof value !== "object" ||
    typeof Reflect.get(value, "canceled") !== "boolean" ||
    (Reflect.get(value, "filePath") !== undefined &&
      typeof Reflect.get(value, "filePath") !== "string")
  ) {
    throw new Error("invalid save dialog result");
  }
}

function assertExactArchiveSource(dataRoot: string, source: string, exportId: string): void {
  const expected = resolve(dataRoot, "diagnostics", `${exportId}.zip`);
  if (source !== expected) throw new Error("diagnostic archive source is invalid");
  const diagnosticsRoot = resolve(dataRoot, "diagnostics");
  if (dirname(source) !== diagnosticsRoot || dirname(diagnosticsRoot) !== resolve(dataRoot)) {
    throw new Error("diagnostic archive source is invalid");
  }
}

async function readFileHandle(source: FileHandle, expectedBytes: number): Promise<Buffer> {
  const value = Buffer.alloc(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const { bytesRead } = await source.read(value, offset, expectedBytes - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== expectedBytes) throw new Error("diagnostic archive changed during export");
  return value;
}

async function writeFileHandle(destination: FileHandle, value: Buffer): Promise<number> {
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < value.byteLength) {
    const wanted = Math.min(buffer.byteLength, value.byteLength - offset);
    value.copy(buffer, 0, offset, offset + wanted);
    let written = 0;
    while (written < wanted) {
      const result = await destination.write(buffer, written, wanted - written, offset + written);
      if (result.bytesWritten === 0) throw new Error("diagnostic archive copy stalled");
      written += result.bytesWritten;
    }
    offset += wanted;
  }
  return offset;
}

async function assertUnchangedFile(
  path: string,
  opened: Awaited<ReturnType<FileHandle["stat"]>>,
  expectedSize: number,
): Promise<void> {
  const selected = await lstat(path);
  if (
    !selected.isFile() ||
    selected.isSymbolicLink() ||
    selected.dev !== opened.dev ||
    selected.ino !== opened.ino ||
    selected.size !== expectedSize
  ) {
    throw new Error("diagnostic archive changed during export");
  }
}

async function removeUnchangedTrustedFile(
  path: string,
  parentBefore: TrustedDirectoryIdentity,
  opened: Awaited<ReturnType<FileHandle["stat"]>>,
): Promise<void> {
  const parentAfter = await inspectTrustedDirectory(parentBefore.path);
  if (!sameDirectoryIdentity(parentBefore, parentAfter)) return;
  const selected = await lstat(path);
  if (
    !selected.isFile() ||
    selected.isSymbolicLink() ||
    selected.dev !== opened.dev ||
    selected.ino !== opened.ino
  ) {
    return;
  }
  await rm(path, { force: true });
}

async function assertTargetDoesNotExist(destination: string): Promise<void> {
  try {
    await lstat(destination);
    throw new Error("diagnostic export destination already exists");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

interface TrustedDirectoryIdentity {
  path: string;
  canonicalPath: string;
  dev: number | bigint;
  ino: number | bigint;
}

async function assertTrustedParents(path: string): Promise<TrustedDirectoryIdentity> {
  let parent = resolve(dirname(path));
  const root = parse(parent).root;
  let immediate: TrustedDirectoryIdentity | undefined;
  for (;;) {
    const inspected = await inspectTrustedDirectory(parent);
    immediate ??= inspected;
    if (parent === root) return immediate;
    const next = dirname(parent);
    if (next === parent) return immediate;
    parent = next;
  }
}

async function inspectTrustedDirectory(path: string): Promise<TrustedDirectoryIdentity> {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw new Error("diagnostic path parent is not a trusted directory");
  }
  const canonicalPath = await realpath(path);
  if (normalizeIdentityPath(canonicalPath) !== normalizeIdentityPath(path)) {
    throw new Error("diagnostic path parent is not a trusted directory");
  }
  return { path, canonicalPath, dev: value.dev, ino: value.ino };
}

function sameDirectoryIdentity(
  left: TrustedDirectoryIdentity,
  right: TrustedDirectoryIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    normalizeIdentityPath(left.canonicalPath) === normalizeIdentityPath(right.canonicalPath)
  );
}

function normalizeIdentityPath(path: string): string {
  return win32.normalize(path).toLocaleLowerCase("en-US");
}

function isReservedWindowsComponent(component: string): boolean {
  if (component.length === 0 || component.includes(":") || /[ .]$/u.test(component)) return true;
  const stem = (component.split(".", 1)[0] ?? "").replace(/[ .]+$/u, "").toLocaleUpperCase("en-US");
  return /^(?:CON|PRN|AUX|NUL|CLOCK\$)$/u.test(stem) || /^(?:COM[1-9]|LPT[1-9])$/u.test(stem);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}
