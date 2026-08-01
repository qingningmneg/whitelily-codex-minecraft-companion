import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, parse, resolve, win32 } from "node:path";

export interface SafeExportResult {
  status: "cancelled" | "saved";
}

export interface SafeExportDialogResult {
  canceled: boolean;
  filePath?: string;
}

type OpenFile = (path: string, flags: string, mode?: number) => Promise<FileHandle>;

export interface SafeExportOptions {
  chooseDestination(): Promise<SafeExportDialogResult>;
  serialized: string;
  openFile?: OpenFile;
  realpathPath?: (path: string) => Promise<string>;
}

export async function exportSerializedJson(options: SafeExportOptions): Promise<SafeExportResult> {
  if (typeof options.serialized !== "string") throw new Error("export value must be serialized");
  assertSingleJsonValue(options.serialized);
  const selection = await options.chooseDestination();
  if (
    !selection ||
    typeof selection !== "object" ||
    typeof selection.canceled !== "boolean" ||
    (selection.filePath !== undefined && typeof selection.filePath !== "string")
  ) {
    throw new Error("invalid save dialog result");
  }
  if (selection.canceled) return Object.freeze({ status: "cancelled" });
  const destination = selection.filePath;
  if (!destination) throw new Error("choose a safe JSON file");
  validateSafeWindowsExportPath(destination);

  const realpathPath = options.realpathPath ?? realpath;
  const parentBefore = await assertExistingParentsAreDirectories(destination, realpathPath);
  await assertTargetDoesNotExist(destination);

  const openFile = options.openFile ?? open;
  let handle: FileHandle | undefined;
  try {
    handle = await openFile(destination, "wx", 0o600);
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("export destination is not a regular file");
    await handle.writeFile(options.serialized, { encoding: "utf8" });
    await handle.sync();
    const selected = await lstat(destination);
    if (
      !selected.isFile() ||
      selected.isSymbolicLink() ||
      selected.dev !== opened.dev ||
      selected.ino !== opened.ino
    ) {
      throw new Error("export destination changed during export");
    }
    let parentAfter: TrustedDirectoryIdentity;
    try {
      parentAfter = await inspectTrustedDirectory(parentBefore.path, realpathPath);
    } catch {
      throw new Error("export destination changed during export");
    }
    if (!sameDirectoryIdentity(parentBefore, parentAfter)) {
      throw new Error("export destination changed during export");
    }
    return Object.freeze({ status: "saved" });
  } catch (error) {
    if (isAlreadyExists(error)) throw new Error("export destination already exists");
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertSingleJsonValue(serialized: string): void {
  try {
    JSON.parse(serialized);
  } catch {
    throw new Error("export value must be one JSON value");
  }
}

export function validateSafeWindowsExportPath(path: string): string {
  if (
    path.includes("\0") ||
    !/^[A-Za-z]:\\[^/]*$/u.test(path) ||
    win32.normalize(path) !== path ||
    win32.extname(path).toLocaleLowerCase("en-US") !== ".json"
  ) {
    throw new Error("choose a safe JSON file");
  }
  const components = path.slice(3).split("\\");
  if (components.length === 0 || components.some(isReservedWindowsComponent)) {
    throw new Error("choose a safe JSON file");
  }
  return path;
}

function isReservedWindowsComponent(component: string): boolean {
  if (component.length === 0 || component.includes(":") || /[ .]$/u.test(component)) return true;
  const stem = (component.split(".", 1)[0] ?? "").replace(/[ .]+$/u, "").toLocaleUpperCase("en-US");
  return /^(?:CON|PRN|AUX|NUL|CLOCK\$)$/u.test(stem) || /^(?:COM[1-9]|LPT[1-9])$/u.test(stem);
}

async function assertTargetDoesNotExist(destination: string): Promise<void> {
  try {
    const target = await lstat(destination);
    if (target.isSymbolicLink()) throw new Error("export destination is a symbolic link");
    if (target.isDirectory()) throw new Error("export destination is a directory");
    throw new Error("export destination already exists");
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

async function assertExistingParentsAreDirectories(
  destination: string,
  realpathPath: (path: string) => Promise<string>,
): Promise<TrustedDirectoryIdentity> {
  let parent = resolve(dirname(destination));
  const root = parse(parent).root;
  let destinationParent: TrustedDirectoryIdentity | undefined;
  for (;;) {
    const inspected = await inspectTrustedDirectory(parent, realpathPath);
    destinationParent ??= inspected;
    if (parent === root) return destinationParent;
    const next = dirname(parent);
    if (next === parent) return destinationParent;
    parent = next;
  }
}

async function inspectTrustedDirectory(
  path: string,
  realpathPath: (path: string) => Promise<string>,
): Promise<TrustedDirectoryIdentity> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("export parent is not a trusted directory");
  }
  const canonicalPath = await realpathPath(path);
  if (normalizeIdentityPath(canonicalPath) !== normalizeIdentityPath(path)) {
    throw new Error("export parent is not a trusted directory");
  }
  return { path, canonicalPath, dev: stats.dev, ino: stats.ino };
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
