import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

const TTL_MS = 30_000;
const MAX_REQUEST_BYTES = 4_096;
const REQUEST_DIRECTORY = ["bridge", "requests"] as const;

export interface BridgeAttemptProof {
  readonly fakeHost: string;
  close(): Promise<void>;
}

export interface BridgeProofIssuer {
  issue(port: number): Promise<BridgeAttemptProof>;
  close(): Promise<void>;
}

interface BridgeRequestDocument {
  schemaVersion: 1;
  username: "WhiteLily";
  port: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

interface PathIdentity {
  readonly operationPath: string;
  readonly canonicalPath: string;
  readonly device: number | bigint;
  readonly inode: number | bigint;
}

interface OwnedRequest extends PathIdentity {
  readonly expiresAt: number;
  closed: boolean;
}

class BridgeProofIssuerError extends Error {
  constructor(
    message:
      | "bridge proof rejected"
      | "bridge proof issuer is closed"
      | "bridge proof port is invalid"
      | "bridge proof root is invalid",
  ) {
    super(message);
    this.name = "BridgeProofIssuerError";
  }
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    normalizePath(left.canonicalPath) === normalizePath(right.canonicalPath)
  );
}

function sameFileIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function hasUnsafeTraversal(path: string): boolean {
  return path.split(/[\\/]+/u).includes("..");
}

function isRegularFile(stats: Stats): boolean {
  return !stats.isSymbolicLink() && stats.isFile();
}

function isDirectory(stats: Stats): boolean {
  return !stats.isSymbolicLink() && stats.isDirectory();
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new BridgeProofIssuerError("bridge proof port is invalid");
  }
}

export function createBridgeProofIssuer(options: {
  dataRoot: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}): BridgeProofIssuer {
  if (!isAbsolute(options.dataRoot) || hasUnsafeTraversal(options.dataRoot)) {
    throw new BridgeProofIssuerError("bridge proof root is invalid");
  }
  return new FileBridgeProofIssuer(
    resolve(options.dataRoot),
    options.now ?? Date.now,
    options.randomBytes ?? nodeRandomBytes,
  );
}

class FileBridgeProofIssuer implements BridgeProofIssuer {
  readonly #dataRoot: string;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #owned = new Map<string, OwnedRequest>();
  #closed = false;

  constructor(dataRoot: string, now: () => number, randomBytes: (size: number) => Buffer) {
    this.#dataRoot = dataRoot;
    this.#now = now;
    this.#randomBytes = randomBytes;
  }

  async issue(port: number): Promise<BridgeAttemptProof> {
    if (this.#closed) throw new BridgeProofIssuerError("bridge proof issuer is closed");
    assertPort(port);

    try {
      const now = this.#now();
      if (!Number.isSafeInteger(now)) throw new BridgeProofIssuerError("bridge proof rejected");
      await this.#cleanExpired(now);
      const requests = await this.#trustedRequestDirectory();
      const bytes = this.#randomBytes(32);
      if (!Buffer.isBuffer(bytes) || bytes.length !== 32)
        throw new BridgeProofIssuerError("bridge proof rejected");
      const nonce = bytes.toString("base64url");
      if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce))
        throw new BridgeProofIssuerError("bridge proof rejected");
      const filename = `${createHash("sha256").update(nonce).digest("hex")}.json`;
      const expiresAt = now + TTL_MS;
      if (!Number.isSafeInteger(expiresAt))
        throw new BridgeProofIssuerError("bridge proof rejected");
      const document: BridgeRequestDocument = {
        schemaVersion: 1,
        username: "WhiteLily",
        port,
        issuedAt: now,
        expiresAt,
        nonce,
      };
      const contents = `${JSON.stringify(document)}\n`;
      if (Buffer.byteLength(contents, "utf8") > MAX_REQUEST_BYTES) {
        throw new BridgeProofIssuerError("bridge proof rejected");
      }
      const owned = await this.#publish(requests, filename, contents, expiresAt);
      if (this.#closed) {
        await this.#closeOwned(owned);
        throw new BridgeProofIssuerError("bridge proof issuer is closed");
      }
      this.#owned.set(owned.operationPath, owned);
      return {
        fakeHost: `127.0.0.1\0WL1\0${nonce}`,
        close: async () => this.#closeOwned(owned),
      };
    } catch (error) {
      if (error instanceof BridgeProofIssuerError) throw error;
      throw new BridgeProofIssuerError("bridge proof rejected");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#owned.values()].map((owned) => this.#closeOwned(owned)));
  }

  async #cleanExpired(now: number): Promise<void> {
    const stale = [...this.#owned.values()].filter(
      (owned) => !owned.closed && owned.expiresAt <= now,
    );
    await Promise.all(stale.map((owned) => this.#closeOwned(owned)));
  }

  async #trustedRequestDirectory(): Promise<PathIdentity> {
    const root = await this.#ensureRoot();
    const bridge = await this.#ensureChildDirectory(root, REQUEST_DIRECTORY[0]);
    return this.#ensureChildDirectory(bridge, REQUEST_DIRECTORY[1]);
  }

  async #ensureRoot(): Promise<PathIdentity> {
    try {
      await lstat(this.#dataRoot);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(this.#dataRoot, { recursive: true });
    }
    return this.#inspectDirectory(this.#dataRoot, undefined);
  }

  async #ensureChildDirectory(parent: PathIdentity, childName: string): Promise<PathIdentity> {
    const candidate = join(parent.operationPath, childName);
    const expectedCanonical = join(parent.canonicalPath, childName);
    const parentBefore = await this.#inspectDirectory(parent.operationPath, undefined);
    if (!sameIdentity(parent, parentBefore))
      throw new BridgeProofIssuerError("bridge proof rejected");
    try {
      await lstat(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await mkdir(candidate);
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) throw mkdirError;
      }
    }
    const child = await this.#inspectDirectory(candidate, expectedCanonical);
    const parentAfter = await this.#inspectDirectory(parent.operationPath, undefined);
    if (!sameIdentity(parent, parentAfter))
      throw new BridgeProofIssuerError("bridge proof rejected");
    return child;
  }

  async #inspectDirectory(
    path: string,
    expectedCanonical: string | undefined,
  ): Promise<PathIdentity> {
    const stats = await lstat(path);
    if (!isDirectory(stats)) throw new BridgeProofIssuerError("bridge proof rejected");
    const canonicalPath = await realpath(path);
    if (
      expectedCanonical !== undefined &&
      normalizePath(canonicalPath) !== normalizePath(expectedCanonical)
    ) {
      throw new BridgeProofIssuerError("bridge proof rejected");
    }
    return { operationPath: path, canonicalPath, device: stats.dev, inode: stats.ino };
  }

  async #inspectFile(path: string, parent: PathIdentity): Promise<PathIdentity> {
    const stats = await lstat(path);
    if (!isRegularFile(stats)) throw new BridgeProofIssuerError("bridge proof rejected");
    const canonicalPath = await realpath(path);
    const expectedCanonical = join(parent.canonicalPath, basename(path));
    if (normalizePath(canonicalPath) !== normalizePath(expectedCanonical)) {
      throw new BridgeProofIssuerError("bridge proof rejected");
    }
    const recheckedParent = await this.#inspectDirectory(parent.operationPath, undefined);
    if (!sameIdentity(parent, recheckedParent))
      throw new BridgeProofIssuerError("bridge proof rejected");
    return { operationPath: path, canonicalPath, device: stats.dev, inode: stats.ino };
  }

  async #publish(
    requests: PathIdentity,
    filename: string,
    contents: string,
    expiresAt: number,
  ): Promise<OwnedRequest> {
    const target = join(requests.operationPath, filename);
    const temp = join(requests.operationPath, `.${filename}.tmp`);
    let handle: FileHandle | undefined;
    let opened: PathIdentity | undefined;
    try {
      await this.#assertMissing(target);
      await this.#assertDirectoryUnchanged(requests);
      try {
        handle = await open(temp, "wx", 0o600);
        const handleStats = await handle.stat();
        if (!isRegularFile(handleStats)) throw new BridgeProofIssuerError("bridge proof rejected");
        opened = await this.#inspectFile(temp, requests);
        if (opened.device !== handleStats.dev || opened.inode !== handleStats.ino) {
          throw new BridgeProofIssuerError("bridge proof rejected");
        }
        await this.#assertDirectoryUnchanged(requests);
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle?.close();
      }
      if (opened === undefined) throw new BridgeProofIssuerError("bridge proof rejected");
      const closedTemp = await this.#inspectFile(temp, requests);
      if (!sameIdentity(opened, closedTemp))
        throw new BridgeProofIssuerError("bridge proof rejected");
      await this.#assertDirectoryUnchanged(requests);
      await this.#assertMissing(target);
      await rename(temp, target);
      const published = await this.#inspectFile(target, requests);
      if (!sameFileIdentity(opened, published))
        throw new BridgeProofIssuerError("bridge proof rejected");
      return { ...published, expiresAt, closed: false };
    } catch (error) {
      if (opened !== undefined) await this.#removeExact(opened, requests).catch(() => undefined);
      throw error;
    }
  }

  async #assertMissing(path: string): Promise<void> {
    try {
      await lstat(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    throw new BridgeProofIssuerError("bridge proof rejected");
  }

  async #assertDirectoryUnchanged(directory: PathIdentity): Promise<void> {
    const current = await this.#inspectDirectory(directory.operationPath, undefined);
    if (!sameIdentity(directory, current))
      throw new BridgeProofIssuerError("bridge proof rejected");
  }

  async #closeOwned(owned: OwnedRequest): Promise<void> {
    if (owned.closed) return;
    owned.closed = true;
    this.#owned.delete(owned.operationPath);
    try {
      await this.#removeExact(owned, await this.#trustedRequestDirectory());
    } catch (error) {
      if (error instanceof BridgeProofIssuerError) throw error;
      throw new BridgeProofIssuerError("bridge proof rejected");
    }
  }

  async #removeExact(file: PathIdentity, parent: PathIdentity): Promise<void> {
    let current: PathIdentity;
    try {
      current = await this.#inspectFile(file.operationPath, parent);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (!sameIdentity(file, current)) return;
    await rm(file.operationPath, { force: false });
  }
}
