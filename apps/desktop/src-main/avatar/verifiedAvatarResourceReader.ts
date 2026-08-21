import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export interface VerifiedAvatarResourceHandle {
  stat(options: { readonly bigint: true }): Promise<BigIntStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export interface VerifiedAvatarResourceReaderIo {
  lstat(path: string, options: { readonly bigint: true }): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: string | number): Promise<VerifiedAvatarResourceHandle>;
}

const nodeVerifiedAvatarResourceReaderIo: VerifiedAvatarResourceReaderIo = {
  lstat: (path, options) => lstat(path, options),
  realpath,
  open: (path, flags) => open(path, flags) as Promise<FileHandle>,
};

export async function readVerifiedAvatarResource(input: {
  readonly root: string;
  readonly relativePath: string;
  readonly maximumBytes: number;
  readonly io?: VerifiedAvatarResourceReaderIo;
}): Promise<Buffer> {
  if (
    !isAbsolute(input.root) ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes <= 0
  ) {
    throw new Error("avatar resource root is invalid");
  }
  const io = input.io ?? nodeVerifiedAvatarResourceReaderIo;
  const root = resolve(input.root);
  const parts = parseRelativePath(input.relativePath);
  await verifyDirectory(io, root);
  let candidate = root;
  for (const [index, part] of parts.entries()) {
    candidate = join(candidate, part);
    const stats = await verifyPathComponent(io, candidate);
    if (index < parts.length - 1) {
      if (!stats.isDirectory()) throw new Error("avatar resource path component is unsafe");
    } else if (!stats.isFile() || stats.size <= 0n || stats.size > BigInt(input.maximumBytes)) {
      throw new Error("avatar resource file is invalid");
    }
  }
  return readBoundedFile(io, candidate, input.maximumBytes);
}

export async function readVerifiedAvatarFile(input: {
  readonly path: string;
  readonly maximumBytes: number;
  readonly io?: VerifiedAvatarResourceReaderIo;
}): Promise<Buffer> {
  if (
    !isSafeAbsoluteSourcePath(input.path) ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes <= 0
  ) {
    throw new Error("avatar resource source is invalid");
  }
  const io = input.io ?? nodeVerifiedAvatarResourceReaderIo;
  const path = resolve(input.path);
  const initial = await snapshotSource(io, path, input.maximumBytes);
  return readBoundedFile(io, path, input.maximumBytes, {
    before: initial.stats,
    after: async () => {
      let final: Awaited<ReturnType<typeof snapshotSource>>;
      try {
        final = await snapshotSource(io, path, input.maximumBytes);
      } catch {
        throw new Error("avatar resource source changed during read");
      }
      if (
        normalizePath(final.canonical) !== normalizePath(initial.canonical) ||
        !sameSnapshot(initial.stats, final.stats) ||
        !sameDirectorySnapshots(initial.ancestors, final.ancestors)
      ) {
        throw new Error("avatar resource source changed during read");
      }
    },
  });
}

function parseRelativePath(path: string): readonly string[] {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\")) {
    throw new Error("avatar resource path is invalid");
  }
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("avatar resource path is invalid");
  }
  return parts;
}

async function verifyDirectory(io: VerifiedAvatarResourceReaderIo, path: string): Promise<void> {
  const stats = await verifyPathComponent(io, path);
  if (!stats.isDirectory()) throw new Error("avatar resource root is invalid");
}

async function verifyPathComponent(
  io: VerifiedAvatarResourceReaderIo,
  path: string,
): Promise<BigIntStats> {
  const stats = await io.lstat(path, { bigint: true });
  const canonical = await io.realpath(path);
  if (stats.isSymbolicLink() || normalizePath(canonical) !== normalizePath(resolve(path))) {
    throw new Error("avatar resource path component is unsafe");
  }
  return stats;
}

async function readBoundedFile(
  io: VerifiedAvatarResourceReaderIo,
  path: string,
  maximumBytes: number,
  expected?: { readonly before: BigIntStats; readonly after: () => Promise<void> },
): Promise<Buffer> {
  const before = await io.lstat(path, { bigint: true });
  if (expected !== undefined && !sameSnapshot(expected.before, before)) {
    throw new Error("avatar resource source changed during read");
  }
  requireRegularFile(before, maximumBytes);
  const handle = await io.open(path, readOnlyNoFollowFlags());
  try {
    const opened = await handle.stat({ bigint: true });
    assertStable(before, opened);
    requireRegularFile(opened, maximumBytes);
    const size = Number(opened.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (result.bytesRead <= 0) throw new Error("avatar resource changed during read");
      offset += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) {
      throw new Error("avatar resource changed during read");
    }
    const after = await handle.stat({ bigint: true });
    assertStable(opened, after);
    await expected?.after();
    return bytes;
  } finally {
    await handle.close();
  }
}

async function snapshotSource(
  io: VerifiedAvatarResourceReaderIo,
  path: string,
  maximumBytes: number,
): Promise<{
  readonly stats: BigIntStats;
  readonly canonical: string;
  readonly ancestors: readonly SourceDirectorySnapshot[];
}> {
  const ancestors = await snapshotSourceAncestors(io, path);
  const stats = await io.lstat(path, { bigint: true });
  requireRegularFile(stats, maximumBytes);
  const canonical = await io.realpath(path);
  if (stats.isSymbolicLink() || normalizePath(canonical) !== normalizePath(path)) {
    throw new Error("avatar resource source is unsafe");
  }
  return { stats, canonical, ancestors };
}

interface SourceDirectorySnapshot {
  readonly operationPath: string;
  readonly canonicalPath: string;
  readonly stats: BigIntStats;
}

async function snapshotSourceAncestors(
  io: VerifiedAvatarResourceReaderIo,
  path: string,
): Promise<readonly SourceDirectorySnapshot[]> {
  const directory = dirname(path);
  const volumeRoot = parse(directory).root;
  const parts = relative(volumeRoot, directory).split(sep).filter(Boolean);
  const snapshots: SourceDirectorySnapshot[] = [];
  let current = volumeRoot;
  for (const part of parts) {
    current = join(current, part);
    const stats = await io.lstat(current, { bigint: true });
    const canonicalPath = await io.realpath(current);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      normalizePath(canonicalPath) !== normalizePath(current)
    ) {
      throw new Error("avatar resource source is unsafe");
    }
    snapshots.push({ operationPath: current, canonicalPath, stats });
  }
  return snapshots;
}

function isSafeAbsoluteSourcePath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.includes("\u0000") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)
  ) {
    return false;
  }
  return path
    .split(/[\\/]/u)
    .every((part, index) => index === 0 || (part !== "." && part !== ".."));
}

function readOnlyNoFollowFlags(): string | number {
  return process.platform !== "win32" && constants.O_NOFOLLOW !== undefined
    ? constants.O_RDONLY | constants.O_NOFOLLOW
    : "r";
}

function requireRegularFile(stats: BigIntStats, maximumBytes: number): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size <= 0n ||
    stats.size > BigInt(maximumBytes)
  ) {
    throw new Error("avatar resource file is invalid");
  }
}

function assertStable(left: BigIntStats, right: BigIntStats): void {
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.size !== right.size ||
    left.mtimeNs !== right.mtimeNs ||
    left.ctimeNs !== right.ctimeNs
  ) {
    throw new Error("avatar resource changed during read");
  }
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameDirectorySnapshots(
  left: readonly SourceDirectorySnapshot[],
  right: readonly SourceDirectorySnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (snapshot, index) =>
        normalizePath(snapshot.operationPath) === normalizePath(right[index]!.operationPath) &&
        normalizePath(snapshot.canonicalPath) === normalizePath(right[index]!.canonicalPath) &&
        sameSnapshot(snapshot.stats, right[index]!.stats),
    )
  );
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}
