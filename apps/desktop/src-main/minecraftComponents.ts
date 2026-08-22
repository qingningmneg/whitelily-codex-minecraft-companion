import { createHash } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { type BigIntStats } from "node:fs";
import { link, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { LanDetector } from "./discovery/lanDetector.js";
import type { LanObservation } from "./discovery/lanCandidateStore.js";
import type {
  ResolvedJavaInstance,
  WorldBindingAuthority,
} from "./discovery/worldBindingAuthority.js";
import { assertWindowsPathsAreOrdinary } from "./discovery/worldBindingAuthority.js";
import {
  readFabricMetadata,
  validateMinecraftComponentManifest,
  type MinecraftComponentArtifact,
  type MinecraftComponentArtifactVersion,
  type MinecraftComponentId,
  type MinecraftComponentResourceManifest,
} from "./minecraftComponentManifest.js";
import {
  assertFabricLoaderIdentity,
  verifyFabricLoader,
  type FabricLoaderIdentity,
} from "./minecraftFabricLoaderAuthority.js";

export type {
  MinecraftComponentArtifact,
  MinecraftComponentArtifactVersion,
  MinecraftComponentId,
  MinecraftComponentResourceManifest,
} from "./minecraftComponentManifest.js";
export type MinecraftComponentState =
  | "bridge_not_installed"
  | "bridge_restart_required"
  | "bridge_not_active"
  | "bridge_version_unsupported"
  | "bridge_file_conflict"
  | "avatar_not_installed"
  | "avatar_restart_required"
  | "ready";

export interface MinecraftComponentStatus {
  readonly state: MinecraftComponentState;
  readonly bridgeInstalled: boolean;
  readonly bridgeActive: boolean;
  readonly avatarInstalled: boolean;
  readonly restartRequired: boolean;
}

export interface MinecraftComponentManager {
  status(candidateId: string): Promise<MinecraftComponentStatus>;
  install(
    candidateId: string,
    selection: readonly MinecraftComponentId[],
  ): Promise<MinecraftComponentStatus>;
  remove(
    candidateId: string,
    selection: readonly MinecraftComponentId[],
  ): Promise<MinecraftComponentStatus>;
}

export interface MinecraftComponentManagerOptions {
  readonly lanDetector: Pick<LanDetector, "inspectCandidate">;
  readonly worldBindingAuthority: Pick<WorldBindingAuthority, "resolveJavaInstance">;
  readonly resourceDirectory: string;
  readonly presenceDirectory: string;
  readonly manifest: MinecraftComponentResourceManifest;
  readonly waitForJavaSessionExit?: (session: Readonly<LanObservation>) => Promise<void>;
}

const MAX_PRESENCE_BYTES = 4_096;
const MAX_PROCESS_WAIT_OUTPUT_BYTES = 4_096;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}\.jar$/u;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const execFile = promisify(nodeExecFile);

type ComponentFailureCode =
  | "MINECRAFT_COMPONENT_AUTHORITY_INVALID"
  | "MINECRAFT_COMPONENT_MANIFEST_INVALID"
  | "MINECRAFT_COMPONENT_OPERATION_FAILED";

class ComponentFailure extends Error {
  constructor(readonly code: ComponentFailureCode) {
    super(code);
    this.name = "MinecraftComponentError";
  }
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}

interface DirectoryIdentity extends FileIdentity {
  readonly path: string;
}

interface ExistingInspection {
  readonly kind: "exact" | "unknown";
  readonly path: string;
  readonly pathName: string;
  readonly identity: FileIdentity;
  readonly mtimeMs: number;
  readonly sha256?: string;
}

interface MissingInspection {
  readonly kind: "missing";
  readonly path: string;
}

type PathInspection = ExistingInspection | MissingInspection;

interface ArtifactInventory {
  readonly artifact: MinecraftComponentArtifact;
  readonly state: "current" | "prior" | "missing" | "conflict";
  readonly selected?: ExistingInspection;
}

interface Inventory {
  readonly artifacts: readonly ArtifactInventory[];
  readonly fingerprint: string;
  readonly drifted: boolean;
}

interface AuthorizedInstance {
  readonly instance: ResolvedJavaInstance;
  readonly gameDirectory: DirectoryIdentity;
  readonly modsDirectory: DirectoryIdentity;
  readonly resourceDirectory: DirectoryIdentity;
  readonly inventory: Inventory;
  readonly supported: boolean;
}

export function createMinecraftComponentManager(
  options: MinecraftComponentManagerOptions,
): MinecraftComponentManager {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new ComponentFailure("MINECRAFT_COMPONENT_AUTHORITY_INVALID");
  }
  let manifest: MinecraftComponentResourceManifest;
  try {
    manifest = validateMinecraftComponentManifest(options.manifest);
  } catch {
    throw new ComponentFailure("MINECRAFT_COMPONENT_MANIFEST_INVALID");
  }
  return new MainMinecraftComponentManager({ ...options, manifest });
}

class MainMinecraftComponentManager implements MinecraftComponentManager {
  readonly #lanDetector: Pick<LanDetector, "inspectCandidate">;
  readonly #worldBindingAuthority: Pick<WorldBindingAuthority, "resolveJavaInstance">;
  readonly #resourceDirectory: string;
  readonly #presenceDirectory: string;
  readonly #manifest: MinecraftComponentResourceManifest;
  readonly #waitForJavaSessionExit: (session: Readonly<LanObservation>) => Promise<void>;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: MinecraftComponentManagerOptions) {
    this.#lanDetector = options.lanDetector;
    this.#worldBindingAuthority = options.worldBindingAuthority;
    this.#resourceDirectory = resolve(options.resourceDirectory);
    this.#presenceDirectory = resolve(options.presenceDirectory);
    this.#manifest = options.manifest;
    this.#waitForJavaSessionExit = options.waitForJavaSessionExit ?? waitForJavaSessionExit;
  }

  status(candidateId: string): Promise<MinecraftComponentStatus> {
    return this.#serialize(async () => this.#status(candidateId));
  }

  install(
    candidateId: string,
    selection: readonly MinecraftComponentId[],
  ): Promise<MinecraftComponentStatus> {
    return this.#serialize(async () => {
      const selected = validateSelection(selection);
      if (selected.has("avatar")) selected.add("bridge");
      const authorized = await this.#authorize(candidateId);
      if (!authorized.supported || authorized.inventory.drifted) {
        return this.#toStatus(authorized);
      }
      if (authorized.inventory.artifacts.some(({ state }) => state === "conflict")) {
        return this.#toStatus(authorized);
      }
      const dependencySafeOrder = [...authorized.inventory.artifacts].sort(
        (left, right) => installRank(left.artifact) - installRank(right.artifact),
      );
      const waitsForExit = dependencySafeOrder.some(
        (item) => selected.has(item.artifact.component) && item.state === "prior",
      );
      try {
        if (waitsForExit) {
          await this.#waitForJavaSessionExit(authorized.instance.javaSession);
          await this.#assertAuthorizedInventoryUnchanged(authorized);
        }
        for (const item of dependencySafeOrder) {
          if (!selected.has(item.artifact.component) || item.state === "current") continue;
          await this.#publishArtifact(authorized, item);
        }
      } catch (error) {
        if (error instanceof ComponentFailure) throw error;
        throw new ComponentFailure("MINECRAFT_COMPONENT_OPERATION_FAILED");
      }
      if (waitsForExit) {
        const avatarInstalled = authorized.inventory.artifacts
          .filter(({ artifact }) => artifact.component === "avatar")
          .every(({ state }) => state === "current");
        return status("bridge_restart_required", true, false, avatarInstalled, true);
      }
      return this.#status(candidateId);
    });
  }

  remove(
    candidateId: string,
    selection: readonly MinecraftComponentId[],
  ): Promise<MinecraftComponentStatus> {
    return this.#serialize(async () => {
      const selected = validateSelection(selection);
      if (selected.has("bridge")) selected.add("avatar");
      const authorized = await this.#authorize(candidateId);
      if (!authorized.supported || authorized.inventory.drifted) {
        return this.#toStatus(authorized);
      }
      if (authorized.inventory.artifacts.some(({ state }) => state === "conflict")) {
        return this.#toStatus(authorized);
      }
      try {
        const dependencyFirst = [...authorized.inventory.artifacts].sort(
          (left, right) => removeRank(left.artifact) - removeRank(right.artifact),
        );
        for (const item of dependencyFirst) {
          if (!selected.has(item.artifact.component) || item.selected === undefined) {
            continue;
          }
          await this.#removeExactArtifact(authorized, item);
        }
      } catch (error) {
        if (error instanceof ComponentFailure) throw error;
        throw new ComponentFailure("MINECRAFT_COMPONENT_OPERATION_FAILED");
      }
      return this.#status(candidateId);
    });
  }

  async #status(candidateId: string): Promise<MinecraftComponentStatus> {
    return this.#toStatus(await this.#authorize(candidateId));
  }

  async #authorize(candidateId: string): Promise<AuthorizedInstance> {
    let before: Readonly<LanObservation>;
    let instance: ResolvedJavaInstance;
    let loader: FabricLoaderIdentity;
    try {
      before = await this.#lanDetector.inspectCandidate(candidateId);
      instance = await this.#worldBindingAuthority.resolveJavaInstance(before);
      loader = await verifyFabricLoader(instance.snapshot.commandLine);
    } catch {
      throw new ComponentFailure("MINECRAFT_COMPONENT_AUTHORITY_INVALID");
    }
    const supported = before.version === this.#manifest.minecraftVersion;
    if (!supported) {
      let after: Readonly<LanObservation>;
      try {
        await assertWindowsPathsAreOrdinary([loader.path]);
        after = await this.#lanDetector.inspectCandidate(candidateId);
      } catch {
        throw new ComponentFailure("MINECRAFT_COMPONENT_AUTHORITY_INVALID");
      }
      if (!sameObservation(before, after)) {
        throw new ComponentFailure("MINECRAFT_COMPONENT_AUTHORITY_INVALID");
      }
      await assertFabricLoaderIdentity(loader);
      const unavailable = await unavailableAuthorizedInstance(instance);
      return unavailable;
    }

    let gameDirectory: DirectoryIdentity;
    let modsDirectory: DirectoryIdentity;
    let resourceDirectory: DirectoryIdentity;
    let firstInventory: Inventory;
    try {
      const modsPath = join(instance.canonicalInstancePath, "mods");
      const resourcePaths = this.#manifest.artifacts.map((artifact) =>
        containedFile(this.#resourceDirectory, artifact.fileName),
      );
      await assertWindowsPathsAreOrdinary([
        instance.canonicalInstancePath,
        modsPath,
        this.#resourceDirectory,
        loader.path,
        ...resourcePaths,
        ...(await existingArtifactPaths(modsPath, this.#manifest)),
      ]);
      gameDirectory = await captureDirectory(instance.canonicalInstancePath);
      if (relative(gameDirectory.path, modsPath) !== "mods") throw new Error("invalid");
      modsDirectory = await captureDirectory(modsPath);
      resourceDirectory = await this.#verifyResources();
      firstInventory = await scanInventory(modsDirectory.path, this.#manifest);
    } catch (error) {
      if (error instanceof ComponentFailure) throw error;
      throw new ComponentFailure("MINECRAFT_COMPONENT_AUTHORITY_INVALID");
    }

    let after: Readonly<LanObservation>;
    try {
      after = await this.#lanDetector.inspectCandidate(candidateId);
      if (!sameObservation(before, after)) throw new Error("invalid");
      await assertFabricLoaderIdentity(loader);
      await assertDirectoryIdentity(gameDirectory);
      await assertDirectoryIdentity(modsDirectory);
      await assertDirectoryIdentity(resourceDirectory);
      await assertWindowsPathsAreOrdinary([
        gameDirectory.path,
        modsDirectory.path,
        resourceDirectory.path,
        loader.path,
        ...this.#manifest.artifacts.map((artifact) =>
          containedFile(resourceDirectory.path, artifact.fileName),
        ),
        ...(await existingArtifactPaths(modsDirectory.path, this.#manifest)),
      ]);
      const secondInventory = await scanInventory(modsDirectory.path, this.#manifest);
      return {
        instance,
        gameDirectory,
        modsDirectory,
        resourceDirectory,
        inventory: {
          ...secondInventory,
          drifted: firstInventory.fingerprint !== secondInventory.fingerprint,
        },
        supported: true,
      };
    } catch (error) {
      if (error instanceof ComponentFailure) throw error;
      throw new ComponentFailure("MINECRAFT_COMPONENT_AUTHORITY_INVALID");
    }
  }

  async #verifyResources(): Promise<DirectoryIdentity> {
    try {
      const directory = await captureDirectory(this.#resourceDirectory);
      for (const artifact of this.#manifest.artifacts) {
        const inspected = await inspectArtifactPath(
          containedFile(directory.path, artifact.fileName),
          artifact,
        );
        if (inspected.kind !== "exact") throw new Error("invalid");
      }
      await assertDirectoryIdentity(directory);
      return directory;
    } catch {
      throw new ComponentFailure("MINECRAFT_COMPONENT_MANIFEST_INVALID");
    }
  }

  async #assertAuthorizedInventoryUnchanged(authorized: AuthorizedInstance): Promise<void> {
    await assertWindowsPathsAreOrdinary([
      authorized.gameDirectory.path,
      authorized.modsDirectory.path,
      authorized.resourceDirectory.path,
      ...(await existingArtifactPaths(authorized.modsDirectory.path, this.#manifest)),
    ]);
    await assertDirectoryIdentity(authorized.gameDirectory);
    await assertDirectoryIdentity(authorized.modsDirectory);
    await assertDirectoryIdentity(authorized.resourceDirectory);
    const inventory = await scanInventory(authorized.modsDirectory.path, this.#manifest);
    if (inventory.fingerprint !== authorized.inventory.fingerprint) throw new Error("invalid");
  }

  async #publishArtifact(authorized: AuthorizedInstance, item: ArtifactInventory): Promise<void> {
    const artifact = item.artifact;
    const mods = authorized.modsDirectory;
    const targetPath = containedFile(mods.path, artifact.fileName);
    const temporaryPath = containedFile(mods.path, `${artifact.fileName}.whitelily-installing`);
    const prior = item.state === "prior" ? item.selected : undefined;
    const backupPath =
      prior === undefined
        ? undefined
        : containedFile(mods.path, `${prior.pathName}.whitelily-disabled`);
    let temporaryIdentity: FileIdentity | undefined;
    let priorMoved = false;
    let published = false;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await assertWindowsPathsAreOrdinary([
        authorized.gameDirectory.path,
        mods.path,
        authorized.resourceDirectory.path,
        containedFile(this.#resourceDirectory, artifact.fileName),
        ...(prior === undefined ? [] : [prior.path]),
      ]);
      await assertDirectoryIdentity(authorized.gameDirectory);
      await assertDirectoryIdentity(mods);
      await requireMissing(temporaryPath);
      await requireMissing(targetPath);
      if (backupPath !== undefined) await requireMissing(backupPath);
      if (prior !== undefined) await assertExactInspection(prior, artifact.prior);

      const source = await readExactArtifact(
        containedFile(this.#resourceDirectory, artifact.fileName),
        artifact,
      );
      await assertDirectoryIdentity(authorized.resourceDirectory);
      handle = await open(temporaryPath, "wx", 0o600);
      const openedTemporary = await handle.stat({ bigint: true });
      if (
        !openedTemporary.isFile() ||
        openedTemporary.nlink !== 1n ||
        openedTemporary.size !== 0n
      ) {
        throw new Error("invalid");
      }
      temporaryIdentity = fileIdentity(openedTemporary);
      await handle.writeFile(source);
      await handle.sync();
      await handle.close();
      handle = undefined;
      const temporary = await inspectArtifactPath(temporaryPath, artifact);
      if (temporary.kind !== "exact" || !sameIdentity(temporary.identity, temporaryIdentity)) {
        throw new Error("invalid");
      }
      await assertDirectoryIdentity(mods);

      if (prior !== undefined && backupPath !== undefined) {
        await requireMissing(backupPath);
        await assertExactInspection(prior, artifact.prior);
        await moveFileNoReplace(prior.path, backupPath, prior.identity);
        priorMoved = true;
        await assertIdentityAtPath(backupPath, prior.identity);
        await requireMissing(prior.path);
      }

      await assertDirectoryIdentity(authorized.gameDirectory);
      await assertDirectoryIdentity(mods);
      await assertWindowsPathsAreOrdinary([
        authorized.gameDirectory.path,
        mods.path,
        temporaryPath,
        ...(priorMoved && backupPath !== undefined ? [backupPath] : []),
      ]);
      await requireMissing(targetPath);
      await assertIdentityAtPath(temporaryPath, temporaryIdentity);
      await moveFileNoReplace(temporaryPath, targetPath, temporaryIdentity);
      published = true;
      await assertIdentityAtPath(targetPath, temporaryIdentity);
      const installed = await inspectArtifactPath(targetPath, artifact);
      if (installed.kind !== "exact" || !sameIdentity(installed.identity, temporaryIdentity)) {
        throw new Error("invalid");
      }
      await assertDirectoryIdentity(mods);

      if (prior !== undefined && backupPath !== undefined) {
        await assertIdentityAtPath(backupPath, prior.identity);
        await unlink(backupPath);
        priorMoved = false;
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      const rollback = await rollbackArtifact({
        targetPath,
        temporaryPath,
        temporaryIdentity,
        published,
        prior,
        backupPath,
        priorMoved,
      });
      if (!rollback) throw new ComponentFailure("MINECRAFT_COMPONENT_OPERATION_FAILED");
      throw error;
    }
  }

  async #removeExactArtifact(
    authorized: AuthorizedInstance,
    item: ArtifactInventory,
  ): Promise<void> {
    const selected = item.selected;
    if (selected === undefined) return;
    await assertDirectoryIdentity(authorized.gameDirectory);
    await assertDirectoryIdentity(authorized.modsDirectory);
    await assertExactInspection(selected, [item.artifact, ...item.artifact.prior]);
    await unlink(selected.path);
    await requireMissing(selected.path);
    await assertDirectoryIdentity(authorized.modsDirectory);
  }

  async #toStatus(authorized: AuthorizedInstance): Promise<MinecraftComponentStatus> {
    if (!authorized.supported) {
      return status("bridge_version_unsupported", false, false, false, false);
    }
    const bridge = authorized.inventory.artifacts.find(
      ({ artifact }) => artifact.modId === "whitelily_bridge",
    );
    const avatars = authorized.inventory.artifacts.filter(
      ({ artifact }) => artifact.component === "avatar",
    );
    if (
      authorized.inventory.drifted ||
      bridge === undefined ||
      authorized.inventory.artifacts.some(({ state }) => state === "conflict")
    ) {
      return status("bridge_file_conflict", false, false, false, false);
    }
    const bridgeInstalled = bridge.state === "current" || bridge.state === "prior";
    if (bridge.state === "prior") {
      return status("bridge_version_unsupported", true, false, false, false);
    }
    if (bridge.state === "missing" || bridge.selected === undefined) {
      return status("bridge_not_installed", false, false, false, false);
    }
    if (bridge.selected.mtimeMs > authorized.instance.javaSession.processStartedAt) {
      return status("bridge_restart_required", true, false, false, true);
    }
    const bridgeActive = await this.#hasCurrentPresence(authorized.instance, bridge.artifact);
    if (!bridgeActive) {
      return status("bridge_not_active", true, false, false, false);
    }
    const avatarInstalled = avatars.length > 0 && avatars.every(({ state }) => state === "current");
    if (!avatarInstalled) {
      return status("avatar_not_installed", true, true, false, false);
    }
    if (
      avatars.some(
        ({ selected }) =>
          selected !== undefined &&
          selected.mtimeMs > authorized.instance.javaSession.processStartedAt,
      )
    ) {
      return status("avatar_restart_required", true, true, true, true);
    }
    return status("ready", true, true, true, false);
  }

  async #hasCurrentPresence(
    instance: ResolvedJavaInstance,
    bridge: MinecraftComponentArtifact,
  ): Promise<boolean> {
    try {
      await assertWindowsPathsAreOrdinary([this.#presenceDirectory]);
      const directory = await captureDirectory(this.#presenceDirectory);
      const path = containedPresenceFile(directory.path, instance.javaSession.pid);
      const before = await ordinaryFile(path, MAX_PRESENCE_BYTES);
      await assertWindowsPathsAreOrdinary([directory.path, path]);
      const bytes = await readFile(path);
      const after = await ordinaryFile(path, MAX_PRESENCE_BYTES);
      await assertDirectoryIdentity(directory);
      if (!sameIdentity(before.identity, after.identity) || bytes.byteLength !== before.size) {
        return false;
      }
      let decoded: string;
      try {
        decoded = strictUtf8Decoder.decode(bytes);
      } catch {
        return false;
      }
      if (decoded.startsWith("\ufeff")) return false;
      const value: unknown = JSON.parse(decoded);
      if (
        !isRecord(value) ||
        !hasExactKeys(value, [
          "schemaVersion",
          "pid",
          "processStartEpochMs",
          "minecraftVersion",
          "bridgeVersion",
          "writtenAt",
        ]) ||
        value.schemaVersion !== 1 ||
        value.pid !== instance.javaSession.pid ||
        value.processStartEpochMs !== instance.javaSession.processStartedAt ||
        value.minecraftVersion !== this.#manifest.minecraftVersion ||
        value.bridgeVersion !== bridge.version ||
        !Number.isSafeInteger(value.writtenAt) ||
        (value.writtenAt as number) < instance.javaSession.processStartedAt
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#operationTail.then(operation);
    this.#operationTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}

async function unavailableAuthorizedInstance(
  instance: ResolvedJavaInstance,
): Promise<AuthorizedInstance> {
  const unavailable: DirectoryIdentity = { path: "", dev: 0n, ino: 0n, birthtimeNs: 0n };
  return {
    instance,
    gameDirectory: unavailable,
    modsDirectory: unavailable,
    resourceDirectory: unavailable,
    inventory: { artifacts: [], fingerprint: "", drifted: false },
    supported: false,
  };
}

function status(
  state: MinecraftComponentState,
  bridgeInstalled: boolean,
  bridgeActive: boolean,
  avatarInstalled: boolean,
  restartRequired: boolean,
): MinecraftComponentStatus {
  return Object.freeze({
    state,
    bridgeInstalled,
    bridgeActive,
    avatarInstalled,
    restartRequired,
  });
}

function validateSelection(selection: readonly MinecraftComponentId[]): Set<MinecraftComponentId> {
  if (!Array.isArray(selection) || selection.length > 2) {
    throw new ComponentFailure("MINECRAFT_COMPONENT_OPERATION_FAILED");
  }
  const selected = new Set<MinecraftComponentId>();
  for (const component of selection) {
    if ((component !== "bridge" && component !== "avatar") || selected.has(component)) {
      throw new ComponentFailure("MINECRAFT_COMPONENT_OPERATION_FAILED");
    }
    selected.add(component);
  }
  return selected;
}

function installRank(artifact: MinecraftComponentArtifact): number {
  if (artifact.component === "bridge") return 0;
  return artifact.modId === "whitelily_avatar" ? 2 : 1;
}

function removeRank(artifact: MinecraftComponentArtifact): number {
  if (artifact.modId === "whitelily_avatar") return 0;
  return artifact.component === "avatar" ? 1 : 2;
}

async function waitForJavaSessionExit(session: Readonly<LanObservation>): Promise<void> {
  if (
    !Number.isSafeInteger(session.pid) ||
    session.pid < 1 ||
    !Number.isSafeInteger(session.processStartedAt) ||
    session.processStartedAt < 1
  ) {
    throw new Error("invalid Java session");
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$pidValue = [int]${session.pid}`,
    `$expectedStart = [int64]${session.processStartedAt}`,
    "$process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue",
    "if ($null -eq $process) { exit 0 }",
    "$actualStart = ([DateTimeOffset]$process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()",
    "if ($actualStart -ne $expectedStart) { exit 0 }",
    "$process.WaitForExit()",
  ].join("; ");
  await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "buffer",
    maxBuffer: MAX_PROCESS_WAIT_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
  });
}

async function scanInventory(
  modsDirectory: string,
  manifest: MinecraftComponentResourceManifest,
): Promise<Inventory> {
  const artifacts: ArtifactInventory[] = [];
  const fingerprints: string[] = [];
  for (const artifact of manifest.artifacts) {
    const versions = [artifact, ...artifact.prior];
    const inspected: PathInspection[] = [];
    for (const version of versions) {
      const item = await inspectArtifactPath(
        containedFile(modsDirectory, version.fileName),
        version,
      );
      inspected.push(item);
      fingerprints.push(`${version.fileName}:${inspectionFingerprint(item)}`);
    }
    const existing = inspected.filter(
      (item): item is ExistingInspection => item.kind !== "missing",
    );
    if (existing.length > 1 || existing.some(({ kind }) => kind === "unknown")) {
      artifacts.push({ artifact, state: "conflict" });
      continue;
    }
    const selected = existing[0];
    if (selected === undefined) {
      artifacts.push({ artifact, state: "missing" });
    } else {
      artifacts.push({
        artifact,
        state:
          selected.path === containedFile(modsDirectory, artifact.fileName) ? "current" : "prior",
        selected,
      });
    }
  }
  return {
    artifacts: Object.freeze(artifacts),
    fingerprint: fingerprints.join("|"),
    drifted: false,
  };
}

async function existingArtifactPaths(
  modsDirectory: string,
  manifest: MinecraftComponentResourceManifest,
): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const artifact of manifest.artifacts) {
    for (const version of [artifact, ...artifact.prior]) {
      const path = containedFile(modsDirectory, version.fileName);
      try {
        await lstat(path);
        paths.push(path);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
  }
  return paths;
}

async function inspectArtifactPath(
  path: string,
  expected: MinecraftComponentArtifactVersion,
): Promise<PathInspection> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing", path };
    throw error;
  }
  const identity = fileIdentity(metadata);
  const unknown = (): ExistingInspection => ({
    kind: "unknown",
    path,
    pathName: expected.fileName,
    identity,
    mtimeMs: Number(metadata.mtimeNs / 1_000_000n),
  });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size !== BigInt(expected.bytes)
  ) {
    return unknown();
  }
  const canonical = resolve(await realpath(path));
  if (!samePath(canonical, resolve(path))) return unknown();
  const bytes = await readFile(path);
  const after = await lstat(path, { bigint: true });
  if (!sameIdentity(identity, fileIdentity(after)) || bytes.byteLength !== expected.bytes) {
    return unknown();
  }
  const hash = sha256(bytes);
  if (hash !== expected.sha256) return { ...unknown(), sha256: hash };
  try {
    const fabric = readFabricMetadata(bytes);
    if (fabric.id !== expected.modId || fabric.version !== expected.version) return unknown();
  } catch {
    return unknown();
  }
  return {
    kind: "exact",
    path,
    pathName: expected.fileName,
    identity,
    mtimeMs: Number(metadata.mtimeNs / 1_000_000n),
    sha256: hash,
  };
}

async function readExactArtifact(
  path: string,
  expected: MinecraftComponentArtifactVersion,
): Promise<Buffer> {
  const inspected = await inspectArtifactPath(path, expected);
  if (inspected.kind !== "exact") throw new Error("invalid");
  const bytes = await readFile(path);
  await assertIdentityAtPath(path, inspected.identity);
  if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
    throw new Error("invalid");
  }
  return bytes;
}

async function assertExactInspection(
  expected: ExistingInspection,
  versions: readonly MinecraftComponentArtifactVersion[],
): Promise<void> {
  const version = versions.find(
    ({ fileName }) => containedFile(resolve(expected.path, ".."), fileName) === expected.path,
  );
  if (version === undefined) throw new Error("invalid");
  const actual = await inspectArtifactPath(expected.path, version);
  if (actual.kind !== "exact" || !sameIdentity(actual.identity, expected.identity)) {
    throw new Error("invalid");
  }
}

async function rollbackArtifact(options: {
  targetPath: string;
  temporaryPath: string;
  temporaryIdentity: FileIdentity | undefined;
  published: boolean;
  prior: ExistingInspection | undefined;
  backupPath: string | undefined;
  priorMoved: boolean;
}): Promise<boolean> {
  let succeeded = true;
  if (options.published && options.temporaryIdentity !== undefined) {
    succeeded =
      (await unlinkIfIdentity(options.targetPath, options.temporaryIdentity)) && succeeded;
  }
  if (options.priorMoved && options.prior !== undefined && options.backupPath !== undefined) {
    try {
      await requireMissing(options.prior.path);
      await assertIdentityAtPath(options.backupPath, options.prior.identity);
      await moveFileNoReplace(options.backupPath, options.prior.path, options.prior.identity);
      await assertIdentityAtPath(options.prior.path, options.prior.identity);
    } catch {
      succeeded = false;
    }
  }
  if (options.temporaryIdentity !== undefined) {
    succeeded =
      (await unlinkIfIdentity(options.temporaryPath, options.temporaryIdentity)) && succeeded;
  }
  return succeeded;
}

async function unlinkIfIdentity(path: string, identity: FileIdentity): Promise<boolean> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (!sameIdentity(fileIdentity(metadata), identity)) return false;
    await unlink(path);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT";
  }
}

async function moveFileNoReplace(
  sourcePath: string,
  destinationPath: string,
  identity: FileIdentity,
): Promise<void> {
  await assertIdentityAtPath(sourcePath, identity);
  await link(sourcePath, destinationPath);
  try {
    await assertLinkedIdentityAtPath(sourcePath, identity);
    await assertLinkedIdentityAtPath(destinationPath, identity);
    await unlink(sourcePath);
  } catch (error) {
    if (
      (await hasLinkedIdentityAtPath(sourcePath, identity)) &&
      (await hasLinkedIdentityAtPath(destinationPath, identity))
    ) {
      await unlinkIfIdentity(destinationPath, identity);
    }
    if (
      (await isMissingPath(sourcePath)) &&
      (await hasSingleIdentityAtPath(destinationPath, identity))
    ) {
      return;
    }
    throw error;
  }
}

async function hasLinkedIdentityAtPath(path: string, expected: FileIdentity): Promise<boolean> {
  try {
    const metadata = await lstat(path, { bigint: true });
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.nlink === 2n &&
      sameIdentity(fileIdentity(metadata), expected)
    );
  } catch {
    return false;
  }
}

async function hasSingleIdentityAtPath(path: string, expected: FileIdentity): Promise<boolean> {
  try {
    const metadata = await lstat(path, { bigint: true });
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.nlink === 1n &&
      sameIdentity(fileIdentity(metadata), expected)
    );
  } catch {
    return false;
  }
}

async function isMissingPath(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT";
  }
}

async function assertLinkedIdentityAtPath(path: string, expected: FileIdentity): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 2n ||
    !sameIdentity(fileIdentity(metadata), expected) ||
    !samePath(resolve(await realpath(path)), resolve(path))
  ) {
    throw new Error("invalid");
  }
}

async function captureDirectory(path: string): Promise<DirectoryIdentity> {
  if (!isAbsolute(path)) throw new Error("invalid");
  const resolved = resolve(path);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("invalid");
  const canonical = resolve(await realpath(resolved));
  if (!samePath(canonical, resolved)) throw new Error("invalid");
  return { path: resolved, ...fileIdentity(metadata) };
}

async function assertDirectoryIdentity(expected: DirectoryIdentity): Promise<void> {
  const actual = await captureDirectory(expected.path);
  if (!sameIdentity(actual, expected)) throw new Error("invalid");
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

async function assertIdentityAtPath(path: string, expected: FileIdentity): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    !sameIdentity(fileIdentity(metadata), expected) ||
    !samePath(resolve(await realpath(path)), resolve(path))
  ) {
    throw new Error("invalid");
  }
}

async function requireMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("invalid");
}

function containedFile(directory: string, fileName: string): string {
  if (
    !FILE_NAME_PATTERN.test(fileName) &&
    !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,191}\.jar\.whitelily-(?:installing|disabled)$/u.test(fileName)
  ) {
    throw new Error("invalid");
  }
  const path = resolve(directory, fileName);
  const child = relative(directory, path);
  if (child !== fileName || child.includes(sep) || isAbsolute(child)) throw new Error("invalid");
  return path;
}

function containedPresenceFile(directory: string, pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid");
  const fileName = `${pid}.json`;
  const path = resolve(directory, fileName);
  const child = relative(directory, path);
  if (child !== fileName || child.includes(sep) || isAbsolute(child)) throw new Error("invalid");
  return path;
}

function sameObservation(left: LanObservation, right: LanObservation): boolean {
  return (
    left.pid === right.pid &&
    left.processStartedAt === right.processStartedAt &&
    left.port === right.port &&
    left.version === right.version
  );
}

function inspectionFingerprint(value: PathInspection): string {
  if (value.kind === "missing") return "missing";
  return `${value.kind}:${value.identity.dev}:${value.identity.ino}:${value.identity.birthtimeNs}:${value.sha256 ?? "-"}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
