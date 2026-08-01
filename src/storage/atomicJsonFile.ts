import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type AtomicJsonFileErrorCode =
  "ATOMIC_JSON_PATH" | "ATOMIC_JSON_INVALID" | "ATOMIC_JSON_RECOVERY_FAILED";

export class AtomicJsonFileError extends Error {
  constructor(
    readonly code: AtomicJsonFileErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "AtomicJsonFileError";
  }
}

export interface AtomicJsonReadable {
  read(): Promise<string>;
  stat(): Promise<Stats>;
  close(): Promise<void>;
}

export interface AtomicJsonWritable {
  write(contents: string): Promise<void>;
  flush(): Promise<void>;
  stat(): Promise<Stats>;
  close(): Promise<void>;
}

export interface AtomicJsonFileIo {
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  openRead(path: string): Promise<AtomicJsonReadable>;
  open(path: string, flags: "wx"): Promise<AtomicJsonWritable>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string): Promise<void>;
}

function wrapReadableHandle(handle: FileHandle): AtomicJsonReadable {
  return {
    read: () => handle.readFile({ encoding: "utf8" }),
    stat: () => handle.stat(),
    close: () => handle.close(),
  };
}

function wrapWritableHandle(handle: FileHandle): AtomicJsonWritable {
  return {
    write: async (contents) => {
      await handle.writeFile(contents, { encoding: "utf8" });
    },
    flush: async () => {
      await handle.sync();
    },
    stat: () => handle.stat(),
    close: () => handle.close(),
  };
}

export const nodeAtomicJsonFileIo: AtomicJsonFileIo = {
  lstat,
  realpath,
  mkdir: async (path) => {
    await mkdir(path);
  },
  openRead: async (path) => wrapReadableHandle(await open(path, "r")),
  open: async (path, flags) => wrapWritableHandle(await open(path, flags, 0o600)),
  rename,
  rm: async (path) => {
    await rm(path, { force: true });
  },
};

export type AtomicJsonBoundaryContext =
  | { operation: "open-read"; path: string }
  | { operation: "open-temp"; path: string }
  | { operation: "rename"; source: string; destination: string };

export interface AtomicJsonFileOptions<T> {
  path: string;
  rootDirectory: string;
  validate(value: unknown): T;
  io?: AtomicJsonFileIo;
  randomId?: () => string;
  recoverFrom?: (error: AtomicJsonFileError) => boolean;
  beforeBoundary?: (context: AtomicJsonBoundaryContext) => void | Promise<void>;
}

interface AtomicJsonRead<T> {
  found: boolean;
  value?: T;
}

interface PathIdentity {
  canonicalPath: string;
  device: number | bigint;
  inode: number | bigint;
}

interface TrustedDirectory extends PathIdentity {
  exists: true;
}

interface MissingDirectory {
  canonicalPath: string;
  exists: false;
}

type DirectoryResolution = TrustedDirectory | MissingDirectory;

interface TrustedFile extends PathIdentity {
  parent: TrustedDirectory;
}

interface PreparedTemp extends TrustedFile {}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child.length > 0 && !child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child);
}

function normalizePathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    normalizePathIdentity(left.canonicalPath) === normalizePathIdentity(right.canonicalPath)
  );
}

export class AtomicJsonFile<T> {
  readonly #rootDirectory: string;
  readonly #path: string;
  readonly #backupPath: string;
  readonly #directory: string;
  readonly #validate: (value: unknown) => T;
  readonly #io: AtomicJsonFileIo;
  readonly #randomId: () => string;
  readonly #recoverFrom: (error: AtomicJsonFileError) => boolean;
  readonly #beforeBoundary: (context: AtomicJsonBoundaryContext) => Promise<void>;

  constructor(options: AtomicJsonFileOptions<T>) {
    const rootDirectory = resolve(options.rootDirectory);
    const path = resolve(options.path);
    if (!isWithin(rootDirectory, path)) {
      throw new AtomicJsonFileError(
        "ATOMIC_JSON_PATH",
        "atomic JSON target must stay within its verified root",
      );
    }
    const directory = dirname(path);
    if (!isWithin(rootDirectory, directory) && directory !== rootDirectory) {
      throw new AtomicJsonFileError(
        "ATOMIC_JSON_PATH",
        "atomic JSON parent must stay within its verified root",
      );
    }
    this.#rootDirectory = rootDirectory;
    this.#path = path;
    this.#backupPath = `${path}.backup`;
    this.#directory = directory;
    this.#validate = options.validate;
    this.#io = options.io ?? nodeAtomicJsonFileIo;
    this.#randomId = options.randomId ?? randomUUID;
    this.#recoverFrom = options.recoverFrom ?? (() => true);
    this.#beforeBoundary = async (context) => {
      await options.beforeBoundary?.(context);
    };
  }

  async coordinatorKey(): Promise<string> {
    const directory = await this.#resolveDirectory(this.#directory, false);
    const canonicalDocumentPath = join(directory.canonicalPath, basename(this.#path));
    if (directory.exists) {
      const existing = await this.#resolveFile(this.#path, true);
      if (existing !== undefined) {
        return normalizePathIdentity(existing.canonicalPath);
      }
    }
    return normalizePathIdentity(canonicalDocumentPath);
  }

  async read(): Promise<T | undefined> {
    let primaryMissing = false;
    let primaryError: unknown;
    try {
      const primary = await this.#readPath(this.#path);
      if (primary.found) return this.#clone(primary.value as T);
      primaryMissing = true;
    } catch (error) {
      if (
        !(error instanceof AtomicJsonFileError) ||
        error.code !== "ATOMIC_JSON_INVALID" ||
        !this.#recoverFrom(error)
      ) {
        throw error;
      }
      primaryError = error;
    }

    let backup: T;
    try {
      const recovered = await this.#readPath(this.#backupPath);
      if (!recovered.found) {
        if (primaryMissing) return undefined;
        throw primaryError;
      }
      backup = recovered.value as T;
    } catch (backupError) {
      if (primaryError instanceof AtomicJsonFileError) throw primaryError;
      if (backupError instanceof AtomicJsonFileError) throw backupError;
      throw backupError;
    }

    try {
      await this.#publish(this.#serialize(backup), this.#path);
    } catch (error) {
      throw new AtomicJsonFileError(
        "ATOMIC_JSON_RECOVERY_FAILED",
        "validated atomic JSON backup could not be recovered",
        { cause: error },
      );
    }
    return this.#clone(backup);
  }

  async write(value: T): Promise<T> {
    const normalized = this.#normalize(value);
    const directory = await this.#trustedDirectory(true);
    let targetTemp: PreparedTemp | undefined;
    let backupTemp: PreparedTemp | undefined;
    try {
      targetTemp = await this.#prepareTemp(this.#serialize(normalized), directory);
      const current = await this.#readPrimary();
      if (current !== undefined) {
        backupTemp = await this.#prepareTemp(this.#serialize(current), directory);
        await this.#renameTemp(backupTemp, this.#backupPath, directory);
        backupTemp = undefined;
      }
      await this.#renameTemp(targetTemp, this.#path, directory);
      targetTemp = undefined;
      return this.#clone(normalized);
    } finally {
      await Promise.allSettled(
        [targetTemp, backupTemp]
          .filter((temp): temp is PreparedTemp => temp !== undefined)
          .map((temp) => this.#removeTemp(temp)),
      );
    }
  }

  async #readPrimary(): Promise<T | undefined> {
    const primary = await this.#readPath(this.#path);
    return primary.found ? (primary.value as T) : undefined;
  }

  async #publish(contents: string, destination: string): Promise<void> {
    const directory = await this.#trustedDirectory(true);
    let temp: PreparedTemp | undefined;
    try {
      temp = await this.#prepareTemp(contents, directory);
      await this.#renameTemp(temp, destination, directory);
      temp = undefined;
    } finally {
      if (temp !== undefined) await this.#removeTemp(temp).catch(() => undefined);
    }
  }

  async #prepareTemp(contents: string, directory: TrustedDirectory): Promise<PreparedTemp> {
    const randomId = this.#randomId();
    if (!/^[A-Za-z0-9-]{1,128}$/u.test(randomId)) {
      throw new AtomicJsonFileError("ATOMIC_JSON_PATH", "atomic JSON random id is invalid");
    }
    const tempPath = resolve(directory.canonicalPath, `.${basename(this.#path)}.${randomId}.tmp`);
    if (
      normalizePathIdentity(dirname(tempPath)) !== normalizePathIdentity(directory.canonicalPath)
    ) {
      throw new AtomicJsonFileError("ATOMIC_JSON_PATH", "atomic JSON temp path escaped");
    }
    await this.#beforeBoundary({ operation: "open-temp", path: tempPath });
    // Node exposes no reliable O_NOFOLLOW equivalent on Windows. Recheck the
    // path identities immediately around each syscall and fail closed on drift.
    const recheckedDirectory = await this.#trustedDirectory(false);
    this.#assertSameIdentity(directory, recheckedDirectory, "atomic JSON parent changed");

    let handle: AtomicJsonWritable | undefined;
    let handleStat: Stats | undefined;
    let opened: TrustedFile | undefined;
    let failure: unknown;
    try {
      handle = await this.#io.open(tempPath, "wx");
      handleStat = await handle.stat();
      this.#assertRegularStat(handleStat, "atomic JSON temp handle is not a regular file");
      opened = await this.#requireFile(tempPath);
      this.#assertHandleIdentity(handleStat, opened, "atomic JSON temp changed during open");
      this.#assertSameIdentity(
        directory,
        opened.parent,
        "atomic JSON parent changed during temp open",
      );
      await handle.write(contents);
      await handle.flush();
    } catch (error) {
      failure = error;
    } finally {
      if (handle !== undefined) {
        if (handleStat === undefined) {
          try {
            const cleanupStat = await handle.stat();
            this.#assertRegularStat(cleanupStat, "atomic JSON temp handle is not a regular file");
            handleStat = cleanupStat;
          } catch {
            // Without handle identity, pathname cleanup could delete an unrelated replacement.
          }
        }
        try {
          await handle.close();
        } catch (error) {
          failure ??= error;
        }
      }
    }
    if (failure !== undefined || opened === undefined) {
      if (opened !== undefined) {
        await this.#removeTemp(opened).catch(() => undefined);
      } else if (handleStat !== undefined) {
        await this.#removeCreatedTemp(tempPath, handleStat, directory).catch(() => undefined);
      }
      throw failure ?? this.#pathError("atomic JSON temp could not be verified");
    }
    try {
      const closed = await this.#requireFile(tempPath);
      this.#assertSameIdentity(opened, closed, "atomic JSON temp changed before publish");
      this.#assertSameIdentity(
        directory,
        closed.parent,
        "atomic JSON parent changed before publish",
      );
      return closed;
    } catch (error) {
      await this.#removeTemp(opened).catch(() => undefined);
      throw error;
    }
  }

  async #renameTemp(
    temp: PreparedTemp,
    destination: string,
    directory: TrustedDirectory,
  ): Promise<void> {
    await this.#beforeBoundary({
      operation: "rename",
      source: temp.canonicalPath,
      destination,
    });
    const source = await this.#requireFile(temp.canonicalPath);
    this.#assertSameIdentity(temp, source, "atomic JSON temp changed at publish");
    this.#assertSameIdentity(directory, source.parent, "atomic JSON parent changed at publish");
    const destinationParent = await this.#trustedDirectory(false);
    this.#assertSameIdentity(
      directory,
      destinationParent,
      "atomic JSON destination parent changed at publish",
    );
    const existingDestination = await this.#resolveFile(destination, true);
    if (existingDestination !== undefined) {
      this.#assertSameIdentity(
        directory,
        existingDestination.parent,
        "atomic JSON destination parent changed at publish",
      );
    }
    const trustedDestination = join(directory.canonicalPath, basename(destination));
    await this.#io.rename(source.canonicalPath, trustedDestination);
    const published = await this.#requireFile(trustedDestination);
    this.#assertSameIdentity(directory, published.parent, "atomic JSON publish escaped its parent");
    this.#assertFileIdentity(temp, published, "atomic JSON published file changed after rename");
  }

  async #removeCreatedTemp(
    tempPath: string,
    handleStat: Stats,
    directory: TrustedDirectory,
  ): Promise<void> {
    let current: TrustedFile | undefined;
    try {
      current = await this.#resolveFile(tempPath, true);
    } catch {
      return;
    }
    if (
      current === undefined ||
      !this.#hasHandleIdentity(handleStat, current) ||
      !sameIdentity(directory, current.parent)
    ) {
      return;
    }
    await this.#io.rm(current.canonicalPath);
  }

  async #removeTemp(temp: TrustedFile): Promise<void> {
    let current: TrustedFile | undefined;
    try {
      current = await this.#resolveFile(temp.canonicalPath, true);
    } catch {
      return;
    }
    if (current === undefined || !sameIdentity(temp, current)) return;
    await this.#io.rm(current.canonicalPath);
  }

  async #readPath(path: string): Promise<AtomicJsonRead<T>> {
    const initial = await this.#resolveFile(path, true);
    if (initial === undefined) return { found: false };
    await this.#beforeBoundary({ operation: "open-read", path: initial.canonicalPath });
    const rechecked = await this.#requireFile(path);
    this.#assertSameIdentity(initial, rechecked, "atomic JSON document changed before read");

    let handle: AtomicJsonReadable | undefined;
    let contents: string;
    try {
      handle = await this.#io.openRead(rechecked.canonicalPath);
      const handleStat = await handle.stat();
      this.#assertRegularStat(handleStat, "atomic JSON read handle is not a regular file");
      const opened = await this.#requireFile(path);
      this.#assertHandleIdentity(handleStat, opened, "atomic JSON document changed during open");
      this.#assertSameIdentity(
        rechecked.parent,
        opened.parent,
        "atomic JSON parent changed during read",
      );
      contents = await handle.read();
      const finalStat = await handle.stat();
      this.#assertHandleIdentity(finalStat, opened, "atomic JSON document changed during read");
    } finally {
      await handle?.close();
    }
    return { found: true, value: this.#parse(contents) };
  }

  async #resolveFile(path: string, allowMissing: boolean): Promise<TrustedFile | undefined> {
    const parent = await this.#resolveDirectory(dirname(path), false);
    if (!parent.exists) {
      if (allowMissing) return undefined;
      throw this.#pathError("atomic JSON verified parent does not exist");
    }
    const candidate = join(parent.canonicalPath, basename(path));
    let stats: Stats;
    try {
      stats = await this.#io.lstat(candidate);
    } catch (error) {
      if (allowMissing && isMissing(error)) return undefined;
      throw error;
    }
    this.#assertRegularStat(stats, "atomic JSON document is not a regular file");
    const canonicalPath = await this.#io.realpath(candidate);
    if (normalizePathIdentity(candidate) !== normalizePathIdentity(canonicalPath)) {
      throw this.#pathError("atomic JSON document uses a reparse alias");
    }
    const recheckedParent = await this.#trustedDirectory(false);
    this.#assertSameIdentity(parent, recheckedParent, "atomic JSON parent changed");
    return this.#identity(canonicalPath, stats, parent);
  }

  async #requireFile(path: string): Promise<TrustedFile> {
    const file = await this.#resolveFile(path, false);
    if (file === undefined) {
      throw this.#pathError("atomic JSON verified file does not exist");
    }
    return file;
  }

  async #trustedDirectory(create: boolean): Promise<TrustedDirectory> {
    const directory = await this.#resolveDirectory(this.#directory, create);
    if (!directory.exists) {
      throw this.#pathError("atomic JSON verified parent does not exist");
    }
    const root = await this.#resolveDirectory(this.#rootDirectory, false);
    if (!root.exists) {
      throw this.#pathError("atomic JSON verified root does not exist");
    }
    if (
      normalizePathIdentity(directory.canonicalPath) !==
        normalizePathIdentity(root.canonicalPath) &&
      !isWithin(root.canonicalPath, directory.canonicalPath)
    ) {
      throw this.#pathError("atomic JSON parent escaped its verified root");
    }
    return directory;
  }

  async #resolveDirectory(path: string, create: boolean): Promise<DirectoryResolution> {
    const absolute = resolve(path);
    const volumeRoot = parse(absolute).root;
    const parts = relative(volumeRoot, absolute).split(sep).filter(Boolean);
    const rootParts = relative(volumeRoot, this.#rootDirectory).split(sep).filter(Boolean);
    let currentPath = volumeRoot;
    let current = await this.#inspectExistingDirectory(currentPath);

    for (let index = 0; index < parts.length; index += 1) {
      const candidate = join(current.canonicalPath, parts[index]!);
      let stats: Stats;
      try {
        stats = await this.#io.lstat(candidate);
      } catch (error) {
        if (!isMissing(error)) throw error;
        if (!create) {
          return {
            exists: false,
            canonicalPath: join(current.canonicalPath, ...parts.slice(index)),
          };
        }
        const parentBeforeCreate = await this.#inspectExistingDirectory(current.canonicalPath);
        this.#assertSameIdentity(current, parentBeforeCreate, "atomic JSON parent changed");
        try {
          await this.#io.mkdir(candidate);
        } catch (mkdirError) {
          if (!isAlreadyExists(mkdirError)) throw mkdirError;
        }
        stats = await this.#io.lstat(candidate);
      }
      const canonicalPath = await this.#io.realpath(candidate);
      const isAncestorAboveVerifiedRoot = index < rootParts.length - 1;
      let identityStats = stats;
      if (
        isAncestorAboveVerifiedRoot &&
        (stats.isSymbolicLink() ||
          normalizePathIdentity(candidate) !== normalizePathIdentity(canonicalPath))
      ) {
        identityStats = await this.#io.lstat(canonicalPath);
        this.#assertDirectoryStat(
          identityStats,
          "atomic JSON ancestor alias does not resolve to a safe directory",
        );
      } else {
        this.#assertDirectoryStat(stats, "atomic JSON path component is not a safe directory");
      }
      if (
        !isAncestorAboveVerifiedRoot &&
        normalizePathIdentity(candidate) !== normalizePathIdentity(canonicalPath)
      ) {
        throw this.#pathError("atomic JSON path component uses a reparse alias");
      }
      const parentAfterLookup = await this.#inspectExistingDirectory(current.canonicalPath);
      this.#assertSameIdentity(current, parentAfterLookup, "atomic JSON parent changed");
      currentPath = canonicalPath;
      current = { ...this.#identity(currentPath, identityStats), exists: true };
    }
    return { ...current, exists: true };
  }

  async #inspectExistingDirectory(path: string): Promise<TrustedDirectory> {
    const stats = await this.#io.lstat(path);
    this.#assertDirectoryStat(stats, "atomic JSON path component is not a safe directory");
    const canonicalPath = await this.#io.realpath(path);
    if (normalizePathIdentity(path) !== normalizePathIdentity(canonicalPath)) {
      throw this.#pathError("atomic JSON path component uses a reparse alias");
    }
    return { ...this.#identity(canonicalPath, stats), exists: true };
  }

  #identity(canonicalPath: string, stats: Stats, parent?: TrustedDirectory): TrustedFile;
  #identity(canonicalPath: string, stats: Stats): PathIdentity;
  #identity(
    canonicalPath: string,
    stats: Stats,
    parent?: TrustedDirectory,
  ): PathIdentity | TrustedFile {
    const identity: PathIdentity = {
      canonicalPath,
      device: stats.dev,
      inode: stats.ino,
    };
    return parent === undefined ? identity : { ...identity, parent };
  }

  #assertRegularStat(stats: Stats, message: string): void {
    if (stats.isSymbolicLink() || !stats.isFile()) throw this.#pathError(message);
  }

  #assertDirectoryStat(stats: Stats, message: string): void {
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw this.#pathError(message);
  }

  #assertHandleIdentity(stats: Stats, file: TrustedFile, message: string): void {
    if (!this.#hasHandleIdentity(stats, file)) throw this.#pathError(message);
  }

  #hasHandleIdentity(stats: Stats, file: TrustedFile): boolean {
    return (
      !stats.isSymbolicLink() &&
      stats.isFile() &&
      stats.dev === file.device &&
      stats.ino === file.inode
    );
  }

  #assertFileIdentity(left: TrustedFile, right: TrustedFile, message: string): void {
    if (left.device !== right.device || left.inode !== right.inode) {
      throw this.#pathError(message);
    }
  }

  #assertSameIdentity(left: PathIdentity, right: PathIdentity, message: string): void {
    if (!sameIdentity(left, right)) throw this.#pathError(message);
  }

  #pathError(message: string, cause?: unknown): AtomicJsonFileError {
    return new AtomicJsonFileError("ATOMIC_JSON_PATH", message, { ...(cause ? { cause } : {}) });
  }

  #parse(contents: string): T {
    try {
      return this.#normalize(JSON.parse(contents) as unknown);
    } catch (error) {
      throw new AtomicJsonFileError("ATOMIC_JSON_INVALID", "atomic JSON document is invalid", {
        cause: error,
      });
    }
  }

  #normalize(value: unknown): T {
    return this.#validate(structuredClone(value));
  }

  #serialize(value: T): string {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) {
      throw new AtomicJsonFileError("ATOMIC_JSON_INVALID", "atomic JSON value is not serializable");
    }
    this.#parse(serialized);
    return `${serialized}\n`;
  }

  #clone(value: T): T {
    return structuredClone(value);
  }
}
