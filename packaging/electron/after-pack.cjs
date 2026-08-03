"use strict";

const { createHash, randomUUID } = require("node:crypto");
const {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} = require("node:fs/promises");
const { dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { extractFile, listPackage } = require("@electron/asar");

const WHITE_LILY_DESKTOP_ASAR_MAPPINGS = [
  { resourceRoot: "desktop/main", asarRoot: "dist/main" },
  { resourceRoot: "desktop/preload", asarRoot: "dist/preload" },
  { resourceRoot: "desktop/renderer", asarRoot: "dist-renderer" },
];

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPortablePath(portablePath, label) {
  if (
    typeof portablePath !== "string" ||
    portablePath.length === 0 ||
    portablePath.includes("\\") ||
    portablePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`WhiteLily ${label} path is invalid`);
  }
  return portablePath;
}

function resolveContained(root, portablePath) {
  assertPortablePath(portablePath, "runtime manifest");
  const path = resolve(root, ...portablePath.split("/"));
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("WhiteLily runtime resource escaped the resources directory");
  }
  return path;
}

function normalizeAsarEntry(entry) {
  const portablePath = entry.replaceAll("\\", "/").replace(/^\/+/u, "");
  return assertPortablePath(portablePath, "ASAR entry");
}

function expectedAsarEntries(filePaths) {
  const entries = new Set(["package.json"]);
  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      entries.add(parts.slice(0, index).join("/"));
    }
    entries.add(filePath);
  }
  return [...entries].sort();
}

function mapDesktopResource(resourcePath, mappings) {
  let mappedPath;
  for (const mapping of mappings) {
    const resourceRoot = assertPortablePath(mapping.resourceRoot, "desktop resource root");
    const asarRoot = assertPortablePath(mapping.asarRoot, "desktop ASAR root");
    if (resourcePath.startsWith(`${resourceRoot}/`)) {
      if (mappedPath !== undefined) {
        throw new Error(`WhiteLily desktop resource mapping is ambiguous: ${resourcePath}`);
      }
      mappedPath = `${asarRoot}/${resourcePath.slice(resourceRoot.length + 1)}`;
    }
  }
  if (resourcePath.startsWith("desktop/") && mappedPath === undefined) {
    throw new Error(`WhiteLily desktop resource has no ASAR mapping: ${resourcePath}`);
  }
  return mappedPath;
}

function verifyAsarPackageIdentity(archivePath, expectedPackage) {
  let packageJson;
  try {
    packageJson = JSON.parse(extractFile(archivePath, "package.json").toString("utf8"));
  } catch {
    throw new Error("WhiteLily app.asar package.json is invalid");
  }
  for (const field of ["name", "productName", "version", "main"]) {
    if (
      typeof expectedPackage[field] !== "string" ||
      packageJson[field] !== expectedPackage[field]
    ) {
      throw new Error(`WhiteLily app.asar package identity mismatch: ${field}`);
    }
  }
}

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
      else throw new Error("WhiteLily runtime resources must not contain links");
    }
  }
  await visit(root);
  return files.sort();
}

async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertContained(root, path, label) {
  const child = relative(resolve(root), resolve(path));
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`WhiteLily ${label} escaped its fixed root`);
  }
}

async function assertNoLinksInExistingPath(root, portablePath, label) {
  const resolvedRoot = resolve(root);
  const rootMetadata = await lstat(resolvedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`WhiteLily ${label} root must be a real directory`);
  }
  const canonicalRoot = await realpath(resolvedRoot);
  let current = resolvedRoot;
  for (const segment of portablePath.split("/")) {
    current = join(current, segment);
    const metadata = await lstatIfExists(current);
    if (metadata === undefined) return;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`WhiteLily ${label} path must not contain links or non-directories`);
    }
    const canonicalCurrent = await realpath(current);
    const canonicalChild = relative(canonicalRoot, canonicalCurrent);
    if (
      canonicalChild === ".." ||
      canonicalChild.startsWith(`..${sep}`) ||
      isAbsolute(canonicalChild)
    ) {
      throw new Error(`WhiteLily ${label} path escaped through a link`);
    }
  }
}

async function readBoundRuntimeManifest(manifestPath, sourceManifestPath) {
  const sourceBytes = await readFile(sourceManifestPath);
  const sourceManifest = JSON.parse(sourceBytes.toString("utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const policySha256 = createHash("sha256").update(sourceBytes).digest("hex");
  if (manifest.policySha256 !== policySha256) {
    throw new Error("WhiteLily runtime manifest is not bound to the reviewed policy");
  }
  const { resources, policySha256: _policy, ...embeddedPolicy } = manifest;
  if (
    sourceManifest.schemaVersion !== 1 ||
    JSON.stringify(embeddedPolicy) !== JSON.stringify(sourceManifest) ||
    !Array.isArray(resources)
  ) {
    throw new Error("WhiteLily runtime manifest policy is invalid");
  }
  return { sourceManifest, resources };
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort(compareOrdinal);
  const reviewedKeys = [...expectedKeys].sort(compareOrdinal);
  return (
    actualKeys.length === reviewedKeys.length &&
    actualKeys.every((key, index) => key === reviewedKeys[index])
  );
}

function assertManagedPortablePath(portablePath) {
  assertPortablePath(portablePath, "managed workspace manifest");
  if (portablePath.startsWith("/") || /^[a-z]:\//iu.test(portablePath)) {
    throw new Error("WhiteLily managed workspace manifest path must be relative");
  }
  return portablePath;
}

async function listManagedWorkspaceEntries(root) {
  const entries = [];
  const canonicalRoot = await realpath(root);
  async function visit(directory, portableDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareOrdinal(left.name, right.name));
    for (const child of children) {
      const portablePath = portableDirectory ? `${portableDirectory}/${child.name}` : child.name;
      assertManagedPortablePath(portablePath);
      const path = resolveContained(root, portablePath);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `WhiteLily managed workspace must not contain a link or reparse point: ${portablePath}`,
        );
      }
      if (metadata.isDirectory()) {
        const canonicalPath = await realpath(path);
        const canonicalChild = relative(canonicalRoot, canonicalPath);
        if (
          canonicalChild === ".." ||
          canonicalChild.startsWith(`..${sep}`) ||
          isAbsolute(canonicalChild)
        ) {
          throw new Error("WhiteLily managed workspace escaped through a reparse point");
        }
        entries.push(`${portablePath}/`);
        await visit(path, portablePath);
      } else if (metadata.isFile()) {
        entries.push(portablePath);
      } else {
        throw new Error(
          `WhiteLily managed workspace contains an unsupported reparse entry: ${portablePath}`,
        );
      }
    }
  }
  await visit(root, "");
  return entries.sort(compareOrdinal);
}

function assertExactManagedEntries(actual, expected, label) {
  const sortedExpected = [...expected].sort(compareOrdinal);
  if (
    actual.length !== sortedExpected.length ||
    actual.some((entry, index) => entry !== sortedExpected[index])
  ) {
    const missing = sortedExpected.find((entry) => !actual.includes(entry));
    if (missing !== undefined) {
      throw new Error(`WhiteLily ${label} is missing: ${missing}`);
    }
    const unexpected = actual.find((entry) => !sortedExpected.includes(entry));
    throw new Error(`WhiteLily ${label} contains an unexpected entry: ${unexpected}`);
  }
}

async function verifyManagedWorkspace(resourcesDirectory, policy, resources) {
  if (policy === undefined) return;
  const reviewedPayloads = [".codex/config.toml", "AGENTS.md"];
  if (
    !hasExactKeys(policy, ["root", "manifest", "payloads", "mcpUrl"]) ||
    policy.root !== "codex-workspace" ||
    policy.manifest !== "codex-workspace/workspace-manifest.json" ||
    policy.mcpUrl !== "http://127.0.0.1:32123/mcp" ||
    !Array.isArray(policy.payloads) ||
    policy.payloads.length !== reviewedPayloads.length ||
    policy.payloads.some((path, index) => path !== reviewedPayloads[index])
  ) {
    throw new Error("WhiteLily reviewed managed workspace policy is invalid");
  }

  const workspaceRoot = resolveContained(resourcesDirectory, policy.root);
  const rootMetadata = await lstat(workspaceRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("WhiteLily managed workspace root must be a real directory");
  }
  const canonicalResources = await realpath(resourcesDirectory);
  const canonicalWorkspace = await realpath(workspaceRoot);
  const canonicalChild = relative(canonicalResources, canonicalWorkspace);
  if (
    canonicalChild === ".." ||
    canonicalChild.startsWith(`..${sep}`) ||
    isAbsolute(canonicalChild)
  ) {
    throw new Error("WhiteLily managed workspace escaped through a link or reparse point");
  }

  const expectedWorkspaceEntries = [".codex/", ...reviewedPayloads, "workspace-manifest.json"];
  assertExactManagedEntries(
    await listManagedWorkspaceEntries(workspaceRoot),
    expectedWorkspaceEntries,
    "managed workspace",
  );

  const expectedOuterPaths = [
    "codex-workspace/.codex/config.toml",
    "codex-workspace/AGENTS.md",
    "codex-workspace/workspace-manifest.json",
  ];
  const outerPaths = resources
    .map((resource) => resource.path)
    .filter((path) => typeof path === "string" && path.startsWith("codex-workspace/"))
    .sort(compareOrdinal);
  assertExactManagedEntries(outerPaths, expectedOuterPaths, "outer workspace manifest");

  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(resolveContained(workspaceRoot, "workspace-manifest.json"), "utf8"),
    );
  } catch {
    throw new Error("WhiteLily managed workspace manifest is invalid JSON");
  }
  if (
    !hasExactKeys(manifest, ["schemaVersion", "contentVersion", "files"]) ||
    manifest.schemaVersion !== 1 ||
    manifest.contentVersion !== "1" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== reviewedPayloads.length
  ) {
    throw new Error("WhiteLily managed workspace manifest is invalid");
  }

  for (const [index, entry] of manifest.files.entries()) {
    if (
      !hasExactKeys(entry, ["path", "bytes", "sha256"]) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error("WhiteLily managed workspace manifest entry is invalid");
    }
    assertManagedPortablePath(entry.path);
    if (entry.path !== reviewedPayloads[index]) {
      throw new Error("WhiteLily managed workspace manifest payload order is invalid");
    }
    const payloadPath = resolveContained(workspaceRoot, entry.path);
    const metadata = await lstat(payloadPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== entry.bytes) {
      throw new Error(`WhiteLily managed workspace payload size mismatch: ${entry.path}`);
    }
    if ((await sha256(payloadPath)) !== entry.sha256) {
      throw new Error(`WhiteLily managed workspace payload hash mismatch: ${entry.path}`);
    }
  }

  const expectedConfig = `[mcp_servers.minecraft]\nurl = "${policy.mcpUrl}"\n`;
  const configBytes = await readFile(resolveContained(workspaceRoot, ".codex/config.toml"));
  if (!configBytes.equals(Buffer.from(expectedConfig, "utf8"))) {
    throw new Error("WhiteLily managed workspace Minecraft MCP URL must be exact loopback");
  }
  const agentsBytes = await readFile(resolveContained(workspaceRoot, "AGENTS.md"));
  if (
    agentsBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ||
    !agentsBytes.toString("utf8").includes("白百合")
  ) {
    throw new Error("WhiteLily managed workspace AGENTS.md must be UTF-8 without BOM");
  }
}

async function verifyResourceDirectory(resourcesDirectory, sourceManifestPath) {
  const manifestPath = resolve(resourcesDirectory, "runtime-manifest.json");
  const { sourceManifest, resources } = await readBoundRuntimeManifest(
    manifestPath,
    sourceManifestPath,
  );

  const allowlist = sourceManifest.allowlist;
  if (
    !allowlist ||
    !Array.isArray(allowlist.requiredFiles) ||
    !Array.isArray(allowlist.executableFiles) ||
    !Array.isArray(allowlist.scriptFiles) ||
    !Array.isArray(allowlist.afterPackFiles)
  ) {
    throw new Error("WhiteLily reviewed resource allowlist is invalid");
  }
  const desktopAsar = {
    packageJson: {
      name: "@whitelily/desktop",
      productName: "WhiteLily",
      version: sourceManifest.productVersion,
      main: "dist/main/main.js",
    },
    mappings: WHITE_LILY_DESKTOP_ASAR_MAPPINGS,
  };

  const declared = new Set();
  const looseDeclared = new Map();
  const asarDeclared = new Map();
  const asarResourcePaths = new Map();
  for (const resource of resources) {
    if (
      typeof resource.path !== "string" ||
      !Number.isSafeInteger(resource.bytes) ||
      resource.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(resource.sha256) ||
      declared.has(resource.path)
    ) {
      throw new Error("WhiteLily runtime manifest resource is invalid");
    }
    assertPortablePath(resource.path, "runtime manifest");
    declared.add(resource.path);
    const asarPath = mapDesktopResource(resource.path, desktopAsar.mappings);
    if (asarPath === undefined) {
      looseDeclared.set(resource.path, resource);
    } else {
      if (asarDeclared.has(asarPath)) {
        throw new Error(`WhiteLily desktop ASAR mapping is duplicated: ${asarPath}`);
      }
      asarDeclared.set(asarPath, resource);
      asarResourcePaths.set(asarPath, resource.path);
    }
  }

  await verifyManagedWorkspace(resourcesDirectory, sourceManifest.managedWorkspace, resources);

  for (const [resourcePath, resource] of looseDeclared) {
    const path = resolveContained(resourcesDirectory, resourcePath);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== resource.bytes) {
      throw new Error(`WhiteLily runtime resource size mismatch: ${resourcePath}`);
    }
    if ((await sha256(path)) !== resource.sha256) {
      throw new Error(`WhiteLily runtime resource hash mismatch: ${resourcePath}`);
    }
  }

  const archivePath = resolveContained(resourcesDirectory, "app.asar");
  let actualAsarEntries;
  try {
    const archiveMetadata = await stat(archivePath);
    if (!archiveMetadata.isFile()) {
      throw new Error("not a file");
    }
    actualAsarEntries = listPackage(archivePath).map(normalizeAsarEntry);
  } catch {
    throw new Error("WhiteLily app.asar is missing or invalid");
  }
  if (new Set(actualAsarEntries).size !== actualAsarEntries.length) {
    throw new Error("WhiteLily app.asar contains duplicate entries");
  }
  const expectedArchiveEntries = expectedAsarEntries(asarDeclared.keys());
  const actualArchiveEntrySet = new Set(actualAsarEntries);
  const expectedArchiveEntrySet = new Set(expectedArchiveEntries);
  for (const entry of expectedArchiveEntries) {
    if (!actualArchiveEntrySet.has(entry)) {
      throw new Error(`WhiteLily app.asar entry is missing: ${entry}`);
    }
  }
  for (const entry of actualAsarEntries) {
    if (!expectedArchiveEntrySet.has(entry)) {
      throw new Error(`WhiteLily app.asar contains an unexpected entry: ${entry}`);
    }
  }
  verifyAsarPackageIdentity(archivePath, desktopAsar.packageJson);
  for (const [asarPath, resource] of asarDeclared) {
    let bytes;
    try {
      bytes = extractFile(archivePath, asarPath.split("/").join(sep));
    } catch {
      throw new Error(`WhiteLily app.asar entry is missing: ${asarPath}`);
    }
    if (bytes.length !== resource.bytes) {
      throw new Error(`WhiteLily runtime resource size mismatch: ${resource.path}`);
    }
    if (sha256Bytes(bytes) !== resource.sha256) {
      throw new Error(`WhiteLily runtime resource hash mismatch: ${resource.path}`);
    }
  }

  const requiredFiles = allowlist.requiredFiles.map((entry) =>
    typeof entry === "string" ? entry : entry.path,
  );
  const actual = await listFiles(resourcesDirectory);
  const afterPack = new Set(allowlist.afterPackFiles);
  const allowedActual = new Set([...looseDeclared.keys(), ...afterPack, "runtime-manifest.json"]);
  for (const path of actual) {
    if (!allowedActual.has(path)) {
      throw new Error(`WhiteLily runtime contains unexpected allowlist resource: ${path}`);
    }
  }
  for (const path of requiredFiles) {
    const mappedAsarPath = [...asarResourcePaths].find(
      ([, resourcePath]) => resourcePath === path,
    )?.[0];
    if (
      !declared.has(path) ||
      (mappedAsarPath === undefined
        ? !actual.includes(path)
        : !actualArchiveEntrySet.has(mappedAsarPath))
    ) {
      throw new Error(`WhiteLily required runtime resource is missing: ${path}`);
    }
  }
  for (const path of afterPack) {
    if (!actual.includes(path)) {
      throw new Error(`WhiteLily after-pack resource is missing: ${path}`);
    }
  }

  const executableFiles = new Set(allowlist.executableFiles);
  const scriptFiles = new Set(allowlist.scriptFiles);
  for (const path of actual) {
    if (/\.(?:com|exe|msi)$/iu.test(path) && !executableFiles.has(path)) {
      throw new Error(`WhiteLily executable is absent from the allowlist: ${path}`);
    }
    if (/\.(?:bat|cmd|ps1|psm1|vbs)$/iu.test(path) && !scriptFiles.has(path)) {
      throw new Error(`WhiteLily script is absent from the allowlist: ${path}`);
    }
  }
  for (const [asarPath, resourcePath] of asarResourcePaths) {
    if (/\.(?:com|exe|msi)$/iu.test(asarPath) && !executableFiles.has(resourcePath)) {
      throw new Error(`WhiteLily executable is absent from the allowlist: ${resourcePath}`);
    }
    if (/\.(?:bat|cmd|ps1|psm1|vbs)$/iu.test(asarPath) && !scriptFiles.has(resourcePath)) {
      throw new Error(`WhiteLily script is absent from the allowlist: ${resourcePath}`);
    }
  }
}

async function materializePreparedNodeModulesAndVerify(
  context,
  preparedBundleRoot,
  sourceManifestPath = resolve(__dirname, "runtime-manifest.json"),
) {
  if (!context || typeof context.appOutDir !== "string" || !isAbsolute(context.appOutDir)) {
    throw new Error("WhiteLily after-pack output root is invalid");
  }
  if (typeof preparedBundleRoot !== "string" || !isAbsolute(preparedBundleRoot)) {
    throw new Error("WhiteLily prepared bundle root is invalid");
  }

  const resolvedPreparedRoot = resolve(preparedBundleRoot);
  const preparedManifestPath = resolveContained(resolvedPreparedRoot, "runtime-manifest.json");
  const preparedManifestMetadata = await lstat(preparedManifestPath);
  const sourceManifestMetadata = await lstat(sourceManifestPath);
  if (
    !preparedManifestMetadata.isFile() ||
    preparedManifestMetadata.isSymbolicLink() ||
    !sourceManifestMetadata.isFile() ||
    sourceManifestMetadata.isSymbolicLink()
  ) {
    throw new Error("WhiteLily prepared manifest must be a real file");
  }
  const { resources } = await readBoundRuntimeManifest(preparedManifestPath, sourceManifestPath);

  const dependencyPrefix = "core/node_modules/";
  const declaredDependencies = new Map();
  for (const resource of resources) {
    if (
      typeof resource.path !== "string" ||
      !Number.isSafeInteger(resource.bytes) ||
      resource.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(resource.sha256)
    ) {
      throw new Error("WhiteLily prepared runtime manifest resource is invalid");
    }
    assertPortablePath(resource.path, "prepared runtime manifest");
    if (!resource.path.startsWith(dependencyPrefix)) continue;
    const dependencyPath = resource.path.slice(dependencyPrefix.length);
    assertPortablePath(dependencyPath, "prepared dependency");
    if (declaredDependencies.has(dependencyPath)) {
      throw new Error(`WhiteLily prepared dependency is duplicated: ${dependencyPath}`);
    }
    declaredDependencies.set(dependencyPath, resource);
  }
  if (declaredDependencies.size === 0) {
    throw new Error("WhiteLily prepared node_modules manifest is empty");
  }

  await assertNoLinksInExistingPath(
    resolvedPreparedRoot,
    "core/node_modules",
    "prepared node_modules",
  );
  const preparedNodeModules = resolveContained(resolvedPreparedRoot, "core/node_modules");
  const actualPreparedDependencies = await listFiles(preparedNodeModules);
  const actualPreparedSet = new Set(actualPreparedDependencies);
  for (const dependencyPath of declaredDependencies.keys()) {
    if (!actualPreparedSet.has(dependencyPath)) {
      throw new Error(`WhiteLily prepared dependency is missing: ${dependencyPath}`);
    }
  }
  for (const dependencyPath of actualPreparedDependencies) {
    if (!declaredDependencies.has(dependencyPath)) {
      throw new Error(`WhiteLily prepared dependency is unexpected: ${dependencyPath}`);
    }
  }
  for (const [dependencyPath, resource] of declaredDependencies) {
    const sourcePath = resolveContained(preparedNodeModules, dependencyPath);
    const metadata = await lstat(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== resource.bytes) {
      throw new Error(`WhiteLily prepared dependency size mismatch: ${dependencyPath}`);
    }
    if ((await sha256(sourcePath)) !== resource.sha256) {
      throw new Error(`WhiteLily prepared dependency hash mismatch: ${dependencyPath}`);
    }
  }

  const appOutDir = resolve(context.appOutDir);
  const resourcesDirectory = resolve(appOutDir, "resources");
  const targetParent = resolve(resourcesDirectory, "core");
  const targetNodeModules = resolve(targetParent, "node_modules");
  assertContained(appOutDir, targetNodeModules, "target node_modules");
  await assertNoLinksInExistingPath(
    appOutDir,
    "resources/core/node_modules",
    "target node_modules",
  );
  await mkdir(targetParent, { recursive: true });
  await assertNoLinksInExistingPath(appOutDir, "resources/core", "target node_modules");

  const targetMetadata = await lstatIfExists(targetNodeModules);
  if (targetMetadata !== undefined) {
    if (!targetMetadata.isDirectory() || targetMetadata.isSymbolicLink()) {
      throw new Error("WhiteLily target node_modules must not be a link");
    }
    if ((await readdir(targetNodeModules)).length !== 0) {
      throw new Error("WhiteLily target node_modules is unexpectedly non-empty");
    }
  }

  const stagingNodeModules = resolve(
    targetParent,
    `.whitelily-node_modules-staging-${randomUUID()}`,
  );
  assertContained(targetParent, stagingNodeModules, "node_modules staging directory");
  await mkdir(stagingNodeModules);
  let stagingExists = true;
  try {
    for (const dependencyPath of actualPreparedDependencies) {
      const sourcePath = resolveContained(preparedNodeModules, dependencyPath);
      const destinationPath = resolveContained(stagingNodeModules, dependencyPath);
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    }
    if (targetMetadata !== undefined) {
      await rmdir(targetNodeModules);
    }
    await rename(stagingNodeModules, targetNodeModules);
    stagingExists = false;
  } finally {
    if (stagingExists) {
      await rm(stagingNodeModules, { recursive: true, force: true });
    }
  }

  await verifyResourceDirectory(resourcesDirectory, sourceManifestPath);
}

async function verifyWhiteLilyRuntime(context) {
  await verifyResourceDirectory(
    resolve(context.appOutDir, "resources"),
    resolve(__dirname, "runtime-manifest.json"),
  );
}

module.exports = verifyWhiteLilyRuntime;
module.exports.verifyResourceDirectory = verifyResourceDirectory;
module.exports.materializePreparedNodeModulesAndVerify = materializePreparedNodeModulesAndVerify;
