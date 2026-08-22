import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PAYLOAD_PATHS = [".codex/config.toml", "AGENTS.md"].sort(compareOrdinal);
const EXPECTED_ENTRIES = [".codex/", ...PAYLOAD_PATHS].sort(compareOrdinal);

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertPortablePath(portablePath) {
  if (
    typeof portablePath !== "string" ||
    portablePath.length === 0 ||
    portablePath.includes("\\") ||
    portablePath.startsWith("/") ||
    /^[a-z]:\//iu.test(portablePath) ||
    portablePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`managed workspace path is invalid: ${portablePath}`);
  }
  return portablePath;
}

function resolveContained(root, portablePath) {
  assertPortablePath(portablePath);
  const path = resolve(root, ...portablePath.split("/"));
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`managed workspace path escaped its root: ${portablePath}`);
  }
  return path;
}

async function assertRealDirectory(path, label) {
  const resolved = resolve(path);
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  const canonical = await realpath(resolved);
  if (!samePath(resolve(canonical), resolved)) {
    throw new Error(`${label} must not resolve through a link or reparse point`);
  }
  return resolved;
}

async function listExactEntries(root, label) {
  const entries = [];
  const visit = async (directory, portableDirectory) => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareOrdinal(left.name, right.name));
    for (const child of children) {
      const portablePath = portableDirectory ? `${portableDirectory}/${child.name}` : child.name;
      assertPortablePath(portablePath);
      const path = resolveContained(root, portablePath);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`${label} must not contain a link or reparse point: ${portablePath}`);
      }
      if (metadata.isDirectory()) {
        const canonical = await realpath(path);
        const canonicalChild = relative(root, canonical);
        if (
          canonicalChild === ".." ||
          canonicalChild.startsWith(`..${sep}`) ||
          isAbsolute(canonicalChild)
        ) {
          throw new Error(`${label} escaped through a link or reparse point: ${portablePath}`);
        }
        entries.push(`${portablePath}/`);
        await visit(path, portablePath);
      } else if (metadata.isFile()) {
        entries.push(portablePath);
      } else {
        throw new Error(`${label} contains an unsupported reparse entry: ${portablePath}`);
      }
    }
  };
  await visit(root, "");
  return entries.sort(compareOrdinal);
}

function assertExactEntries(actual, expected, label) {
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    const missing = expected.find((entry) => !actual.includes(entry));
    if (missing !== undefined) throw new Error(`${label} is missing required payload: ${missing}`);
    const unexpected = actual.find((entry) => !expected.includes(entry));
    throw new Error(`${label} contains an unexpected entry: ${unexpected ?? "unknown"}`);
  }
}

async function buildManagedWorkspace(sourceRootArgument, stagingRootArgument) {
  if (typeof sourceRootArgument !== "string" || typeof stagingRootArgument !== "string") {
    throw new Error("usage: build-codex-workspace.mjs <source-root> <staging-root>");
  }
  const sourceRoot = await assertRealDirectory(sourceRootArgument, "workspace source root");
  const stagingRoot = await assertRealDirectory(stagingRootArgument, "workspace staging root");
  if (samePath(sourceRoot, stagingRoot)) {
    throw new Error("workspace source and staging roots must be different directories");
  }

  assertExactEntries(
    await listExactEntries(sourceRoot, "workspace source"),
    EXPECTED_ENTRIES,
    "workspace source",
  );
  assertExactEntries(
    await listExactEntries(stagingRoot, "workspace staging"),
    [],
    "workspace staging",
  );

  const sourceBytes = new Map();
  for (const portablePath of PAYLOAD_PATHS) {
    const sourcePath = resolveContained(sourceRoot, portablePath);
    const metadata = await lstat(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`workspace source payload must be a real file: ${portablePath}`);
    }
    sourceBytes.set(portablePath, await readFile(sourcePath));
  }

  for (const portablePath of PAYLOAD_PATHS) {
    const destinationPath = resolveContained(stagingRoot, portablePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, sourceBytes.get(portablePath), { flag: "wx" });
  }

  const files = await Promise.all(
    PAYLOAD_PATHS.map(async (portablePath) => {
      const bytes = await readFile(resolveContained(stagingRoot, portablePath));
      return {
        path: portablePath,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  await writeFile(
    resolveContained(stagingRoot, "workspace-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, contentVersion: "1", files }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  assertExactEntries(
    await listExactEntries(stagingRoot, "workspace staging"),
    [...EXPECTED_ENTRIES, "workspace-manifest.json"].sort(compareOrdinal),
    "workspace staging",
  );
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath !== undefined && samePath(invokedPath, fileURLToPath(import.meta.url))) {
  try {
    await buildManagedWorkspace(process.argv[2], process.argv[3]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "workspace build failed"}\n`);
    process.exitCode = 1;
  }
}

export { buildManagedWorkspace };
