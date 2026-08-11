import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const COMPONENT_ROOT = "minecraft-components";
const COMPONENT_PREFIX = `${COMPONENT_ROOT}/`;
const EXPECTED_FILE_COUNT = 9;
const MAX_POLICY_BYTES = 8_192;
const MAX_RUNTIME_MANIFEST_BYTES = 131_072;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_VALUES = 16_384;
const FAILURE = "Minecraft component pack verification failed";

function fail() {
  throw new Error(FAILURE);
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isContained(root, path) {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasExactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareOrdinal);
  const expected = [...keys].sort(compareOrdinal);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function parseStrictJson(text) {
  let position = 0;
  let values = 0;
  const whitespace = /[\u0009\u000a\u000d\u0020]/u;

  function skipWhitespace() {
    while (position < text.length && whitespace.test(text[position])) position += 1;
  }

  function parseString() {
    if (text[position] !== '"') fail();
    const start = position;
    position += 1;
    while (position < text.length) {
      const code = text.charCodeAt(position);
      if (code === 0x22) {
        position += 1;
        try {
          return JSON.parse(text.slice(start, position));
        } catch {
          fail();
        }
      }
      if (code < 0x20) fail();
      if (code === 0x5c) {
        position += 1;
        if (position >= text.length) fail();
        const escape = text[position];
        if (escape === "u") {
          const digits = text.slice(position + 1, position + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) fail();
          position += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) fail();
      }
      position += 1;
    }
    fail();
  }

  function parseValue(depth) {
    values += 1;
    if (values > MAX_JSON_VALUES || depth > MAX_JSON_DEPTH) fail();
    skipWhitespace();
    const current = text[position];
    if (current === "{") {
      position += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[position] === "}") {
        position += 1;
        return;
      }
      while (position < text.length) {
        skipWhitespace();
        const key = parseString();
        const keyIdentity = key.toLowerCase();
        if (keys.has(keyIdentity)) fail();
        keys.add(keyIdentity);
        skipWhitespace();
        if (text[position] !== ":") fail();
        position += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[position] === "}") {
          position += 1;
          return;
        }
        if (text[position] !== ",") fail();
        position += 1;
      }
      fail();
    }
    if (current === "[") {
      position += 1;
      skipWhitespace();
      if (text[position] === "]") {
        position += 1;
        return;
      }
      while (position < text.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (text[position] === "]") {
          position += 1;
          return;
        }
        if (text[position] !== ",") fail();
        position += 1;
      }
      fail();
    }
    if (current === '"') {
      parseString();
      return;
    }
    const remaining = text.slice(position);
    const token = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/u.exec(
      remaining,
    )?.[0];
    if (token === undefined) fail();
    position += token.length;
  }

  parseValue(0);
  skipWhitespace();
  if (position !== text.length) fail();
  try {
    return JSON.parse(text);
  } catch {
    fail();
  }
}

async function assertOrdinaryDirectory(path) {
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) fail();
  const canonical = await realpath(path);
  if (!samePath(resolve(path), resolve(canonical))) fail();
  const after = await lstat(path, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after)) fail();
}

function assertNoWindowsReparsePoints(paths) {
  if (process.platform !== "win32") return;
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = resolve(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const encoded = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$raw=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WHITELILY_COMPONENT_PATHS))",
    "$paths=ConvertFrom-Json -InputObject $raw",
    "for($index=0;$index -lt $paths.Count;$index++){$path=[string]$paths[$index];$item=Get-Item -LiteralPath $path -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){exit 12}}",
    '[Console]::Out.Write(\'{"status":"ok"}\')',
  ].join(";");
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      env: { ...process.env, WHITELILY_COMPONENT_PATHS: encoded },
      maxBuffer: 4_096,
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    result.stderr !== "" ||
    result.stdout !== '{"status":"ok"}'
  ) {
    fail();
  }
}

async function readVerifiedFile(path, options) {
  const { maximumBytes, exactBytes, beforePathRecheck = async () => {} } = options;
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size < 1n ||
    before.size > BigInt(maximumBytes) ||
    (exactBytes !== undefined && before.size !== BigInt(exactBytes))
  ) {
    fail();
  }
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened)) fail();
    const bytes = await handle.readFile();
    if (
      bytes.length !== Number(opened.size) ||
      bytes.length > maximumBytes ||
      (exactBytes !== undefined && bytes.length !== exactBytes)
    ) {
      fail();
    }
    await beforePathRecheck(path);
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      afterPath.nlink !== 1n ||
      !sameIdentity(opened, afterHandle) ||
      !sameIdentity(afterHandle, afterPath) ||
      afterHandle.size !== BigInt(bytes.length)
    ) {
      fail();
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readStrictJson(path, maximumBytes, beforePathRecheck) {
  const bytes = await readVerifiedFile(path, { maximumBytes, beforePathRecheck });
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail();
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail();
  }
  return parseStrictJson(text);
}

function validateRuntimeShape(manifest) {
  if (
    !hasExactKeys(manifest, [
      "schemaVersion",
      "productVersion",
      "target",
      "versions",
      "paths",
      "managedWorkspace",
      "allowlist",
    ]) ||
    manifest.schemaVersion !== 1 ||
    !isNonemptyString(manifest.productVersion) ||
    !hasExactKeys(manifest.target, ["platform", "arch"]) ||
    manifest.target.platform !== "win32" ||
    manifest.target.arch !== "x64" ||
    !hasExactKeys(manifest.versions, ["electron", "electronBuilder", "codex", "codexNative"]) ||
    !Object.values(manifest.versions).every(isNonemptyString) ||
    !hasExactKeys(manifest.paths, [
      "childEntry",
      "codexPackage",
      "codexNativePackage",
      "codexExecutable",
      "licenses",
      "minecraftComponents",
    ]) ||
    !Object.values(manifest.paths).every(isNonemptyString) ||
    manifest.paths.minecraftComponents !== COMPONENT_ROOT ||
    !hasExactKeys(manifest.managedWorkspace, ["root", "manifest", "payloads", "mcpUrl"]) ||
    !isNonemptyString(manifest.managedWorkspace.root) ||
    !isNonemptyString(manifest.managedWorkspace.manifest) ||
    !isStringArray(manifest.managedWorkspace.payloads) ||
    !isNonemptyString(manifest.managedWorkspace.mcpUrl) ||
    !hasExactKeys(manifest.allowlist, [
      "generatedRoots",
      "productionDependencies",
      "exactFiles",
      "generatedFiles",
      "requiredFiles",
      "executableFiles",
      "scriptFiles",
      "afterPackFiles",
    ]) ||
    !Array.isArray(manifest.allowlist.generatedRoots) ||
    manifest.allowlist.generatedRoots.some(
      (entry) =>
        !hasExactKeys(entry, ["source", "target", "extensions"]) ||
        !isNonemptyString(entry.source) ||
        !isNonemptyString(entry.target) ||
        !isStringArray(entry.extensions),
    ) ||
    !hasExactKeys(manifest.allowlist.productionDependencies, [
      "sourceRoot",
      "targetRoot",
      "graph",
      "excludedPackages",
      "forbiddenExtensions",
    ]) ||
    !isNonemptyString(manifest.allowlist.productionDependencies.sourceRoot) ||
    !isNonemptyString(manifest.allowlist.productionDependencies.targetRoot) ||
    !isNonemptyString(manifest.allowlist.productionDependencies.graph) ||
    !isStringArray(manifest.allowlist.productionDependencies.excludedPackages) ||
    !isStringArray(manifest.allowlist.productionDependencies.forbiddenExtensions) ||
    !Array.isArray(manifest.allowlist.exactFiles) ||
    manifest.allowlist.exactFiles.some(
      (entry) =>
        !hasExactKeys(entry, ["source", "target", "bytes", "sha256"]) ||
        !isNonemptyString(entry.source) ||
        (entry.target !== null && !isNonemptyString(entry.target)) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes <= 0 ||
        typeof entry.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(entry.sha256),
    ) ||
    !isStringArray(manifest.allowlist.generatedFiles) ||
    !isStringArray(manifest.allowlist.requiredFiles) ||
    !isStringArray(manifest.allowlist.executableFiles) ||
    !isStringArray(manifest.allowlist.scriptFiles) ||
    !isStringArray(manifest.allowlist.afterPackFiles)
  ) {
    fail();
  }
}

function validatePolicy(policy) {
  if (
    !hasExactKeys(policy, ["schemaVersion", "files"]) ||
    policy.schemaVersion !== 1 ||
    !Array.isArray(policy.files) ||
    policy.files.length !== EXPECTED_FILE_COUNT
  ) {
    fail();
  }
  const expected = new Map();
  for (const entry of policy.files) {
    if (
      !hasExactKeys(entry, ["name", "bytes", "sha256"]) ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      entry.name.includes("/") ||
      entry.name.includes("\\") ||
      basename(entry.name) !== entry.name ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      fail();
    }
    const key = entry.name.toLowerCase();
    if (expected.has(key)) fail();
    expected.set(key, entry);
  }
  return expected;
}

export async function verifyMinecraftComponentPack(repositoryRoot, manifestPath, options = {}) {
  const root = resolve(repositoryRoot);
  const reviewedManifestPath = resolve(root, "packaging", "electron", "runtime-manifest.json");
  const policyPath = resolve(root, "packaging", "electron", "minecraft-component-pack.json");
  if (resolve(manifestPath) !== reviewedManifestPath) fail();

  const buildRoot = resolve(root, "build");
  const componentRoot = resolve(buildRoot, COMPONENT_ROOT);
  const packagingRoot = resolve(root, "packaging");
  const electronRoot = resolve(packagingRoot, "electron");
  const directories = [root, buildRoot, componentRoot, packagingRoot, electronRoot];
  for (const directory of directories) await assertOrdinaryDirectory(directory);

  const policy = await readStrictJson(policyPath, MAX_POLICY_BYTES, options.beforePathRecheck);
  const expectedByKey = validatePolicy(policy);
  const manifest = await readStrictJson(
    reviewedManifestPath,
    MAX_RUNTIME_MANIFEST_BYTES,
    options.beforePathRecheck,
  );
  validateRuntimeShape(manifest);

  const componentEntries = manifest.allowlist.exactFiles.filter(
    (entry) => typeof entry.target === "string" && entry.target.startsWith(COMPONENT_PREFIX),
  );
  if (componentEntries.length !== EXPECTED_FILE_COUNT) fail();
  const manifestByKey = new Map();
  for (const entry of componentEntries) {
    const name = entry.target.slice(COMPONENT_PREFIX.length);
    const expected = expectedByKey.get(name.toLowerCase());
    const sourcePath = resolve(root, ...String(entry.source).split("/"));
    if (
      expected === undefined ||
      expected.name !== name ||
      entry.source !== `build/${entry.target}` ||
      dirname(sourcePath) !== componentRoot ||
      !isContained(root, sourcePath) ||
      entry.bytes !== expected.bytes ||
      entry.sha256 !== expected.sha256 ||
      manifestByKey.has(name.toLowerCase())
    ) {
      fail();
    }
    manifestByKey.set(name.toLowerCase(), { expected, sourcePath });
  }
  if (manifestByKey.size !== expectedByKey.size) fail();

  const actual = await readdir(componentRoot, { withFileTypes: true });
  if (actual.length !== EXPECTED_FILE_COUNT) fail();
  const allPaths = [...directories, policyPath, reviewedManifestPath];
  for (const directoryEntry of actual) {
    const record = manifestByKey.get(directoryEntry.name.toLowerCase());
    if (
      record === undefined ||
      record.expected.name !== directoryEntry.name ||
      !directoryEntry.isFile()
    ) {
      fail();
    }
    allPaths.push(record.sourcePath);
  }
  assertNoWindowsReparsePoints(allPaths);

  for (const { expected, sourcePath } of manifestByKey.values()) {
    const bytes = await readVerifiedFile(sourcePath, {
      maximumBytes: expected.bytes,
      exactBytes: expected.bytes,
      beforePathRecheck: options.beforePathRecheck,
    });
    if (sha256(bytes) !== expected.sha256) fail();
  }
  for (const directory of directories) await assertOrdinaryDirectory(directory);
  assertNoWindowsReparsePoints(allPaths);
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const [repositoryRoot, manifestPath] = process.argv.slice(2);
  if (repositoryRoot === undefined || manifestPath === undefined || process.argv.length !== 4) {
    console.error(FAILURE);
    process.exitCode = 1;
  } else {
    try {
      await verifyMinecraftComponentPack(repositoryRoot, manifestPath);
      process.stdout.write(`${JSON.stringify({ status: "ok", files: EXPECTED_FILE_COUNT })}\n`);
    } catch {
      console.error(FAILURE);
      process.exitCode = 1;
    }
  }
}
