import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Dirent } from "node:fs";

const MANIFEST_NAME = "workspace-manifest.json";
const TARGET_NAME = "codex-workspace";
const STAGING_PREFIX = ".codex-workspace-staging-";
const BACKUP_PREFIX = ".codex-workspace-backup-";
const CONTENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MANAGED_PAYLOADS = [".codex/config.toml", "AGENTS.md"] as const;
const MAX_MANAGED_FILE_BYTES = 1024 * 1024;

export interface WorkspaceProvisionResult {
  readonly contentVersion: string;
  readonly installed: boolean;
  readonly repaired: boolean;
  readonly targetDirectory: string;
}

export type WorkspaceProvisionErrorCode =
  "WORKSPACE_RESOURCE_INVALID" | "WORKSPACE_DEPLOY_FAILED" | "WORKSPACE_ROLLBACK_FAILED";

export type WorkspaceProvisionDiagnosticCode = "WORKSPACE_BACKUP_CLEANUP_FAILED";

export class WorkspaceProvisionError extends Error {
  constructor(readonly code: WorkspaceProvisionErrorCode) {
    super(code);
    this.name = "WorkspaceProvisionError";
  }
}

export interface WorkspaceProvisionFileOperations {
  readonly copyFile: (source: string, destination: string) => Promise<void>;
  readonly lstat: (path: string) => ReturnType<typeof lstat>;
  readonly mkdir: (path: string, options: { recursive: true }) => Promise<string | undefined>;
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly readdir: (path: string, options: { withFileTypes: true }) => Promise<Dirent<string>[]>;
  readonly realpath: (path: string) => Promise<string>;
  readonly rename: (source: string, destination: string) => Promise<void>;
  readonly rm: (path: string, options: { recursive: true; force: boolean }) => Promise<void>;
}

interface WorkspaceManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface WorkspaceManifest {
  readonly schemaVersion: 1;
  readonly contentVersion: string;
  readonly files: readonly WorkspaceManifestFile[];
}

interface VerifiedResource {
  readonly directory: string;
  readonly manifest: WorkspaceManifest;
  readonly manifestBytes: Buffer;
}

interface RealDirectoryIdentity {
  readonly path: string;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly birthtimeMs: number | bigint;
}

class OwnedTemporaryCleanupError extends Error {}

export interface DesktopCodexWorkspaceResources {
  readonly resourceDirectory: string;
  readonly manifestPath: string;
}

const nodeOperations: WorkspaceProvisionFileOperations = {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
};

export function resolveDesktopCodexWorkspaceResources(options: {
  appPath: string;
  resourcesPath: string;
  development: boolean;
}): DesktopCodexWorkspaceResources {
  const repositoryRoot = resolve(options.appPath, "..", "..");
  const resourceDirectory = options.development
    ? resolve(repositoryRoot, "build", "desktop-development", TARGET_NAME)
    : resolve(options.resourcesPath, TARGET_NAME);
  return {
    resourceDirectory,
    manifestPath: resolve(resourceDirectory, MANIFEST_NAME),
  };
}

export function createWorkspaceVersionEnvironment(
  result: WorkspaceProvisionResult,
): Readonly<{ WHITELILY_WORKSPACE_VERSION: string }> {
  if (!CONTENT_VERSION_PATTERN.test(result.contentVersion)) {
    throw new Error("WhiteLily workspace version is invalid");
  }
  return Object.freeze({ WHITELILY_WORKSPACE_VERSION: result.contentVersion });
}

export async function provisionCodexWorkspace(
  options: {
    resourceDirectory: string;
    dataRoot: string;
    diagnostic?: (code: WorkspaceProvisionDiagnosticCode) => void;
  },
  operations: WorkspaceProvisionFileOperations = nodeOperations,
): Promise<WorkspaceProvisionResult> {
  let resource: VerifiedResource;
  let dataRoot: string;
  let dataRootIdentity: RealDirectoryIdentity;
  let targetDirectory: string;
  let existing: boolean;
  let targetIdentity: RealDirectoryIdentity | undefined;
  try {
    resource = await verifyResourceDirectory(options.resourceDirectory, operations);
    dataRootIdentity = await captureRealDirectory(options.dataRoot, operations);
    dataRoot = dataRootIdentity.path;
    targetDirectory = resolveContained(dataRoot, TARGET_NAME);
    await assertSafeExistingTarget(targetDirectory, dataRoot, operations);
    existing = await pathExists(targetDirectory, operations);
    targetIdentity = existing ? await captureRealDirectory(targetDirectory, operations) : undefined;
  } catch {
    throw new WorkspaceProvisionError("WORKSPACE_RESOURCE_INVALID");
  }
  if (existing) {
    try {
      await verifyInstalledWorkspace(targetDirectory, resource, operations);
      return {
        contentVersion: resource.manifest.contentVersion,
        installed: false,
        repaired: false,
        targetDirectory,
      };
    } catch {
      // A real, contained directory with drift is replaceable from attested resources.
    }
  }

  const repaired = existing
    ? (await readManagedContentVersion(targetDirectory, operations)) ===
      resource.manifest.contentVersion
    : false;
  let stagingDirectory: string | undefined;
  let backupDirectory: string | undefined;
  let backupContainer: string | undefined;
  let backupMoved = false;
  let candidatePublished = false;
  try {
    await assertDeploymentBoundary(dataRootIdentity, targetDirectory, targetIdentity, operations);
    stagingDirectory = await createOwnedTemporaryDirectory(
      dataRootIdentity,
      STAGING_PREFIX,
      operations,
    );
    await assertDeploymentBoundary(dataRootIdentity, targetDirectory, targetIdentity, operations);
    await populateStagingDirectory(stagingDirectory, resource, operations);
    await verifyInstalledWorkspace(stagingDirectory, resource, operations);

    if (existing) {
      await assertDeploymentBoundary(dataRootIdentity, targetDirectory, targetIdentity, operations);
      backupContainer = await createOwnedTemporaryDirectory(
        dataRootIdentity,
        BACKUP_PREFIX,
        operations,
      );
      await assertDeploymentBoundary(dataRootIdentity, targetDirectory, targetIdentity, operations);
      backupDirectory = resolveContained(backupContainer, TARGET_NAME);
      await operations.rename(targetDirectory, backupDirectory);
      backupMoved = true;
    }
    await assertDeploymentBoundary(dataRootIdentity, targetDirectory, undefined, operations);
    await operations.rename(stagingDirectory, targetDirectory);
    stagingDirectory = undefined;
    candidatePublished = true;
    await verifyInstalledWorkspace(targetDirectory, resource, operations);
  } catch (error) {
    const rollbackSucceeded = await rollbackDeployment(
      {
        targetDirectory,
        stagingDirectory,
        backupDirectory,
        backupContainer,
        backupMoved,
        candidatePublished,
        targetIdentity,
      },
      operations,
    );
    throw new WorkspaceProvisionError(
      rollbackSucceeded && !(error instanceof OwnedTemporaryCleanupError)
        ? "WORKSPACE_DEPLOY_FAILED"
        : "WORKSPACE_ROLLBACK_FAILED",
    );
  }
  if (backupContainer !== undefined) {
    try {
      await operations.rm(backupContainer, { recursive: true, force: false });
    } catch {
      emitWorkspaceDiagnostic(options.diagnostic, "WORKSPACE_BACKUP_CLEANUP_FAILED");
    }
  }
  return {
    contentVersion: resource.manifest.contentVersion,
    installed: true,
    repaired,
    targetDirectory,
  };
}

function emitWorkspaceDiagnostic(
  diagnostic: ((code: WorkspaceProvisionDiagnosticCode) => void) | undefined,
  code: WorkspaceProvisionDiagnosticCode,
): void {
  try {
    diagnostic?.(code);
  } catch {
    // A diagnostic observer cannot invalidate an already committed workspace.
  }
}

async function verifyResourceDirectory(
  resourceDirectory: string,
  operations: WorkspaceProvisionFileOperations,
): Promise<VerifiedResource> {
  const directory = await requireRealDirectory(resourceDirectory, operations);
  const manifestPath = resolveContained(directory, MANIFEST_NAME);
  const manifestMetadata = await operations.lstat(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) throw new Error("invalid");
  const manifestCanonical = resolve(await operations.realpath(manifestPath));
  if (!samePath(manifestCanonical, manifestPath)) throw new Error("invalid");
  const manifestBytes = await operations.readFile(manifestPath);
  if (manifestBytes.byteLength === 0 || manifestBytes.byteLength > MAX_MANAGED_FILE_BYTES) {
    throw new Error("invalid");
  }
  const manifest = parseManifest(manifestBytes);
  await assertExactWorkspaceEntries(directory, manifest, operations);
  await verifyPayloads(directory, manifest, operations);
  return { directory, manifest, manifestBytes };
}

async function verifyInstalledWorkspace(
  directory: string,
  resource: VerifiedResource,
  operations: WorkspaceProvisionFileOperations,
): Promise<void> {
  await requireRealDirectory(directory, operations);
  await assertExactWorkspaceEntries(directory, resource.manifest, operations);
  const manifestPath = resolveContained(directory, MANIFEST_NAME);
  const manifestMetadata = await operations.lstat(manifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) throw new Error("invalid");
  const installedManifest = await operations.readFile(manifestPath);
  if (!installedManifest.equals(resource.manifestBytes)) throw new Error("invalid");
  await verifyPayloads(directory, resource.manifest, operations);
}

async function populateStagingDirectory(
  stagingDirectory: string,
  resource: VerifiedResource,
  operations: WorkspaceProvisionFileOperations,
): Promise<void> {
  for (const entry of resource.manifest.files) {
    const source = resolveContained(resource.directory, entry.path);
    const destination = resolveContained(stagingDirectory, entry.path);
    await operations.mkdir(dirname(destination), { recursive: true });
    await operations.copyFile(source, destination);
  }
  await operations.copyFile(
    resolveContained(resource.directory, MANIFEST_NAME),
    resolveContained(stagingDirectory, MANIFEST_NAME),
  );
}

async function createOwnedTemporaryDirectory(
  dataRoot: RealDirectoryIdentity,
  prefix: string,
  operations: WorkspaceProvisionFileOperations,
): Promise<string> {
  await assertSameRealDirectory(dataRoot, operations);
  let created: string | undefined;
  try {
    created = resolve(await operations.mkdtemp(resolveContained(dataRoot.path, prefix)));
    const child = relative(dataRoot.path, created);
    if (child.includes(sep) || !child.startsWith(prefix) || child === prefix || isAbsolute(child)) {
      throw new Error("invalid");
    }
    await requireRealDirectory(created, operations);
    await assertSameRealDirectory(dataRoot, operations);
    return created;
  } catch (error) {
    if (created !== undefined) {
      try {
        await operations.rm(created, { recursive: true, force: true });
      } catch {
        throw new OwnedTemporaryCleanupError();
      }
    }
    throw error;
  }
}

async function assertDeploymentBoundary(
  dataRoot: RealDirectoryIdentity,
  targetDirectory: string,
  targetIdentity: RealDirectoryIdentity | undefined,
  operations: WorkspaceProvisionFileOperations,
): Promise<void> {
  await assertSameRealDirectory(dataRoot, operations);
  const exists = await pathExists(targetDirectory, operations);
  if (targetIdentity === undefined) {
    if (exists) throw new Error("invalid");
    return;
  }
  if (!exists) throw new Error("invalid");
  await assertSafeExistingTarget(targetDirectory, dataRoot.path, operations);
  await assertSameRealDirectory(targetIdentity, operations);
}

async function rollbackDeployment(
  deployment: {
    targetDirectory: string;
    stagingDirectory: string | undefined;
    backupDirectory: string | undefined;
    backupContainer: string | undefined;
    backupMoved: boolean;
    candidatePublished: boolean;
    targetIdentity: RealDirectoryIdentity | undefined;
  },
  operations: WorkspaceProvisionFileOperations,
): Promise<boolean> {
  let succeeded = true;
  if (deployment.candidatePublished) {
    try {
      await operations.rm(deployment.targetDirectory, { recursive: true, force: true });
    } catch {
      succeeded = false;
    }
  }
  if (deployment.backupMoved && deployment.backupDirectory !== undefined) {
    try {
      if (await pathExists(deployment.targetDirectory, operations)) {
        succeeded = false;
      } else {
        await operations.rename(deployment.backupDirectory, deployment.targetDirectory);
        if (deployment.targetIdentity === undefined) throw new Error("invalid");
        await assertSameRealDirectory(deployment.targetIdentity, operations);
      }
    } catch {
      succeeded = false;
    }
  }
  if (deployment.stagingDirectory !== undefined) {
    try {
      await operations.rm(deployment.stagingDirectory, { recursive: true, force: true });
    } catch {
      succeeded = false;
    }
  }
  if (deployment.backupContainer !== undefined) {
    const backupStillPresent =
      deployment.backupMoved &&
      deployment.backupDirectory !== undefined &&
      (await pathExists(deployment.backupDirectory, operations).catch(() => true));
    if (!backupStillPresent) {
      try {
        await operations.rm(deployment.backupContainer, { recursive: true, force: true });
      } catch {
        succeeded = false;
      }
    }
  }
  return succeeded;
}

async function assertSafeExistingTarget(
  targetDirectory: string,
  dataRoot: string,
  operations: WorkspaceProvisionFileOperations,
): Promise<void> {
  if (!(await pathExists(targetDirectory, operations))) return;
  const metadata = await operations.lstat(targetDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("invalid");
  const canonical = resolve(await operations.realpath(targetDirectory));
  if (!samePath(canonical, targetDirectory)) throw new Error("invalid");
  const child = relative(dataRoot, canonical);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("invalid");
  }
  await assertTreeContainsNoLinks(targetDirectory, operations);
}

async function assertTreeContainsNoLinks(
  root: string,
  operations: WorkspaceProvisionFileOperations,
): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const children = await operations.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const path = resolve(directory, child.name);
      const metadata = await operations.lstat(path);
      if (metadata.isSymbolicLink()) throw new Error("invalid");
      if (metadata.isDirectory()) {
        const canonical = resolve(await operations.realpath(path));
        const relativePath = relative(root, canonical);
        if (
          relativePath === ".." ||
          relativePath.startsWith(`..${sep}`) ||
          isAbsolute(relativePath)
        ) {
          throw new Error("invalid");
        }
        await visit(path);
      } else if (!metadata.isFile()) {
        throw new Error("invalid");
      }
    }
  };
  await visit(root);
}

async function assertExactWorkspaceEntries(
  root: string,
  manifest: WorkspaceManifest,
  operations: WorkspaceProvisionFileOperations,
): Promise<void> {
  const actual: string[] = [];
  const visit = async (directory: string, portableDirectory: string): Promise<void> => {
    const children = await operations.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const portablePath = portableDirectory ? `${portableDirectory}/${child.name}` : child.name;
      assertPortablePath(portablePath);
      const path = resolveContained(root, portablePath);
      const metadata = await operations.lstat(path);
      if (metadata.isSymbolicLink()) throw new Error("invalid");
      if (metadata.isDirectory()) {
        const canonical = resolve(await operations.realpath(path));
        const relativePath = relative(root, canonical);
        if (
          relativePath === ".." ||
          relativePath.startsWith(`..${sep}`) ||
          isAbsolute(relativePath)
        ) {
          throw new Error("invalid");
        }
        actual.push(`${portablePath}/`);
        await visit(path, portablePath);
      } else if (metadata.isFile()) {
        actual.push(portablePath);
      } else {
        throw new Error("invalid");
      }
    }
  };
  await visit(root, "");
  const expected = [
    ...new Set(manifest.files.flatMap((entry) => parentEntries(entry.path))),
    ...manifest.files.map((entry) => entry.path),
    MANIFEST_NAME,
  ].sort(compareOrdinal);
  actual.sort(compareOrdinal);
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error("invalid");
  }
}

async function verifyPayloads(
  root: string,
  manifest: WorkspaceManifest,
  operations: WorkspaceProvisionFileOperations,
): Promise<void> {
  for (const entry of manifest.files) {
    const path = resolveContained(root, entry.path);
    const metadata = await operations.lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("invalid");
    const canonical = resolve(await operations.realpath(path));
    if (!samePath(canonical, path)) throw new Error("invalid");
    const bytes = await operations.readFile(path);
    if (
      bytes.byteLength !== entry.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    ) {
      throw new Error("invalid");
    }
  }
}

function parseManifest(bytes: Buffer): WorkspaceManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("invalid");
  }
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "contentVersion", "files"])) {
    throw new Error("invalid");
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.contentVersion !== "string" ||
    !CONTENT_VERSION_PATTERN.test(value.contentVersion) ||
    !Array.isArray(value.files) ||
    value.files.length !== MANAGED_PAYLOADS.length
  ) {
    throw new Error("invalid");
  }
  const files = value.files.map((file) => parseManifestFile(file));
  if (files.some((file, index) => file.path !== MANAGED_PAYLOADS[index])) {
    throw new Error("invalid");
  }
  return { schemaVersion: 1, contentVersion: value.contentVersion, files };
}

function parseManifestFile(value: unknown): WorkspaceManifestFile {
  if (!isRecord(value) || !hasExactKeys(value, ["path", "bytes", "sha256"])) {
    throw new Error("invalid");
  }
  assertPortablePath(value.path);
  if (
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > MAX_MANAGED_FILE_BYTES ||
    typeof value.sha256 !== "string" ||
    !HASH_PATTERN.test(value.sha256)
  ) {
    throw new Error("invalid");
  }
  return { path: value.path, bytes: value.bytes, sha256: value.sha256 };
}

async function readManagedContentVersion(
  targetDirectory: string,
  operations: WorkspaceProvisionFileOperations,
): Promise<string | undefined> {
  try {
    return parseManifest(
      await operations.readFile(resolveContained(targetDirectory, MANIFEST_NAME)),
    ).contentVersion;
  } catch {
    return undefined;
  }
}

async function requireRealDirectory(
  path: string,
  operations: WorkspaceProvisionFileOperations,
): Promise<string> {
  const resolved = resolve(path);
  const metadata = await operations.lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("invalid");
  const canonical = resolve(await operations.realpath(resolved));
  if (!samePath(canonical, resolved)) throw new Error("invalid");
  return resolved;
}

async function captureRealDirectory(
  path: string,
  operations: WorkspaceProvisionFileOperations,
): Promise<RealDirectoryIdentity> {
  const resolved = await requireRealDirectory(path, operations);
  const metadata = await operations.lstat(resolved);
  return {
    path: resolved,
    dev: metadata.dev,
    ino: metadata.ino,
    birthtimeMs: metadata.birthtimeMs,
  };
}

async function assertSameRealDirectory(
  expected: RealDirectoryIdentity,
  operations: WorkspaceProvisionFileOperations,
): Promise<void> {
  const actual = await captureRealDirectory(expected.path, operations);
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.birthtimeMs !== expected.birthtimeMs
  ) {
    throw new Error("invalid");
  }
}

async function pathExists(
  path: string,
  operations: WorkspaceProvisionFileOperations,
): Promise<boolean> {
  try {
    await operations.lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function resolveContained(root: string, portablePath: string): string {
  assertPortablePath(portablePath, true);
  const path = resolve(root, ...portablePath.split("/"));
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("invalid");
  }
  return path;
}

function assertPortablePath(value: unknown, allowPrefix = false): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-z]:\//iu.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    (!allowPrefix && value.endsWith("/"))
  ) {
    throw new Error("invalid");
  }
}

function parentEntries(portablePath: string): string[] {
  const parts = portablePath.split("/");
  const entries: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    entries.push(`${parts.slice(0, index).join("/")}/`);
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareOrdinal);
  const sortedExpected = [...expected].sort(compareOrdinal);
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
