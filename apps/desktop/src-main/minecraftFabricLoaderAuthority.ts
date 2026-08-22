import type { BigIntStats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { readFabricMetadata } from "./minecraftComponentManifest.js";

const MAX_LOADER_BYTES = 4 * 1024 * 1024;
const MAX_CLASSPATH_ENTRIES = 4_096;
const FABRIC_CLIENT_CLASS = "net.fabricmc.loader.impl.launch.knot.KnotClient";
const FABRIC_LOADER_FILE_PATTERN = /^fabric-loader-([0-9]+\.[0-9]+\.[0-9]+)\.jar$/u;

export interface FabricLoaderIdentity {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly version: string;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}

export async function verifyFabricLoader(commandLine: string): Promise<FabricLoaderIdentity> {
  const argv = parseWindowsCommandLine(commandLine);
  if (argv.filter((argument) => argument === FABRIC_CLIENT_CLASS).length !== 1) {
    throw new Error("invalid");
  }
  const classpaths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "-cp" && argv[index] !== "-classpath") continue;
    const classpath = argv[index + 1];
    if (!classpath) throw new Error("invalid");
    classpaths.push(classpath);
    index += 1;
  }
  if (classpaths.length !== 1) throw new Error("invalid");
  const entries = classpaths[0]!.split(";");
  if (entries.length < 1 || entries.length > MAX_CLASSPATH_ENTRIES) throw new Error("invalid");
  const loaderEntries = entries.filter((entry) => FABRIC_LOADER_FILE_PATTERN.test(basename(entry)));
  if (loaderEntries.length !== 1) throw new Error("invalid");
  const path = loaderEntries[0]!;
  if (!isAbsolute(path)) throw new Error("invalid");
  return verifyFabricLoaderFromPath(path);
}

export async function assertFabricLoaderIdentity(expected: FabricLoaderIdentity): Promise<void> {
  const actual = await verifyFabricLoaderFromPath(expected.path);
  if (actual.version !== expected.version || !sameIdentity(actual.identity, expected.identity)) {
    throw new Error("invalid");
  }
}

async function verifyFabricLoaderFromPath(path: string): Promise<FabricLoaderIdentity> {
  const fileNameMatch = FABRIC_LOADER_FILE_PATTERN.exec(basename(path));
  if (!fileNameMatch) throw new Error("invalid");
  const before = await ordinaryFile(path, MAX_LOADER_BYTES);
  const bytes = await readFile(path);
  const after = await ordinaryFile(path, MAX_LOADER_BYTES);
  if (!sameIdentity(before.identity, after.identity) || bytes.byteLength !== before.size) {
    throw new Error("invalid");
  }
  const metadata = readFabricMetadata(bytes);
  if (
    metadata.id !== "fabricloader" ||
    metadata.version !== fileNameMatch[1] ||
    !isAtLeastVersion(metadata.version, [0, 16, 14])
  ) {
    throw new Error("invalid");
  }
  return Object.freeze({
    path: resolve(path),
    identity: before.identity,
    version: metadata.version,
  });
}

function isAtLeastVersion(version: string, minimum: readonly [number, number, number]): boolean {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/u.exec(version);
  if (!match) return false;
  const actual = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (actual.some((part) => !Number.isSafeInteger(part))) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index]! !== minimum[index]) return actual[index]! > minimum[index]!;
  }
  return true;
}

function parseWindowsCommandLine(commandLine: string): readonly string[] {
  if (commandLine.length < 1 || commandLine.includes("\u0000")) throw new Error("invalid");
  const argv: string[] = [];
  let index = 0;
  while (index < commandLine.length) {
    while (index < commandLine.length && /\s/u.test(commandLine[index]!)) index += 1;
    if (index >= commandLine.length) break;
    let value = "";
    let quoted = false;
    while (index < commandLine.length) {
      const character = commandLine[index]!;
      if (!quoted && /\s/u.test(character)) break;
      if (character === "\\") {
        let slashCount = 0;
        while (commandLine[index + slashCount] === "\\") slashCount += 1;
        if (commandLine[index + slashCount] === '"') {
          value += "\\".repeat(Math.floor(slashCount / 2));
          if (slashCount % 2 === 1) value += '"';
          else quoted = !quoted;
          index += slashCount + 1;
          continue;
        }
        value += "\\".repeat(slashCount);
        index += slashCount;
        continue;
      }
      if (character === '"') {
        quoted = !quoted;
        index += 1;
        continue;
      }
      value += character;
      index += 1;
    }
    if (quoted) throw new Error("invalid");
    argv.push(value);
  }
  return Object.freeze(argv);
}

async function ordinaryFile(
  path: string,
  maximumBytes: number,
): Promise<{ identity: FileIdentity; size: number }> {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size < 1n ||
    metadata.size > BigInt(maximumBytes) ||
    !samePath(resolve(await realpath(path)), resolve(path))
  ) {
    throw new Error("invalid");
  }
  return { identity: fileIdentity(metadata), size: Number(metadata.size) };
}

function fileIdentity(metadata: BigIntStats): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino, birthtimeNs: metadata.birthtimeNs };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
