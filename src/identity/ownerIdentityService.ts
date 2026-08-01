import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { DEFAULT_CONFIG_TOML } from "../config/defaultConfig.js";
import { appConfigSchema } from "../config/schema.js";
import {
  OwnerIdentityError,
  parseMinecraftJavaUsername,
  publicSnapshot,
  type OwnerIdentityAccess,
  type OwnerIdentitySnapshot,
  type OwnerPresence,
} from "./ownerIdentity.js";

export interface OwnerIdentityFileHandle {
  writeFile(contents: string, options: { encoding: "utf8" }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface OwnerIdentityFileIo {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  open(path: string, flags: "wx", mode: number): Promise<OwnerIdentityFileHandle>;
  link(source: string, destination: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface OwnerIdentityServiceOptions {
  readonly io?: Partial<OwnerIdentityFileIo>;
  readonly createTempToken?: () => string;
}

const defaultFileIo: OwnerIdentityFileIo = {
  mkdir,
  readFile,
  open: async (path, flags, mode) => open(path, flags, mode),
  link,
  rename,
  unlink,
};

function fingerprint(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

const transactionTokenPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

interface RecoveryPaths {
  readonly journalPath: string;
  readonly recoveryPath: string;
  readonly committedPath: string;
  readonly tempPath: string;
}

interface RecoveryJournal {
  readonly schemaVersion: 1;
  readonly targetBasename: string;
  readonly recoveryBasename: string;
  readonly transactionToken: string;
  readonly expectedFingerprint: string;
  readonly nextFingerprint: string;
}

function recoveryJournalPath(configPath: string): string {
  const prefix = join(dirname(configPath), `.${basename(configPath)}.owner-identity`);
  return `${prefix}.transaction.json`;
}

function recoveryPaths(configPath: string, transactionToken: string): RecoveryPaths {
  const prefix = join(dirname(configPath), `.${basename(configPath)}.owner-identity`);
  return {
    journalPath: recoveryJournalPath(configPath),
    recoveryPath: `${prefix}.${transactionToken}.recovery`,
    committedPath: `${prefix}.${transactionToken}.committed.json`,
    tempPath: join(dirname(configPath), `.${basename(configPath)}.${transactionToken}.tmp`),
  };
}

function createTransactionToken(createTempToken: () => string): string {
  const token = createTempToken();
  if (!transactionTokenPattern.test(token)) {
    throw new OwnerIdentityError("OWNER_IDENTITY_WRITE_FAILED");
  }
  return token;
}

function serializeRecoveryJournal(journal: RecoveryJournal): string {
  return `${JSON.stringify(journal)}\n`;
}

function parseRecoveryJournal(raw: string, configPath: string): RecoveryJournal | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const expectedKeys = [
      "expectedFingerprint",
      "nextFingerprint",
      "recoveryBasename",
      "schemaVersion",
      "targetBasename",
      "transactionToken",
    ];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])
    ) {
      return undefined;
    }
    if (
      typeof record.transactionToken !== "string" ||
      !transactionTokenPattern.test(record.transactionToken)
    ) {
      return undefined;
    }
    const paths = recoveryPaths(configPath, record.transactionToken);
    if (
      record.schemaVersion !== 1 ||
      record.targetBasename !== basename(configPath) ||
      record.recoveryBasename !== basename(paths.recoveryPath) ||
      typeof record.expectedFingerprint !== "string" ||
      !sha256Pattern.test(record.expectedFingerprint) ||
      typeof record.nextFingerprint !== "string" ||
      !sha256Pattern.test(record.nextFingerprint)
    ) {
      return undefined;
    }
    return record as unknown as RecoveryJournal;
  } catch {
    return undefined;
  }
}

function isValidConfig(raw: string): boolean {
  try {
    appConfigSchema.parse(parse(raw));
    return true;
  } catch {
    return false;
  }
}

async function createPrivateFile(
  io: OwnerIdentityFileIo,
  path: string,
  contents: string,
): Promise<void> {
  let handle: OwnerIdentityFileHandle | undefined;
  let created = false;
  try {
    handle = await io.open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write error.
      }
    }
    if (created) {
      try {
        await io.unlink(path);
      } catch {
        // Preserve the original write error.
      }
    }
    throw error;
  }
}

async function renameIfPresent(
  io: OwnerIdentityFileIo,
  source: string,
  destination: string,
): Promise<string | undefined> {
  try {
    await io.rename(source, destination);
    return destination;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function unlinkBestEffort(io: OwnerIdentityFileIo, path: string | undefined): Promise<void> {
  if (path === undefined) return;
  try {
    await io.unlink(path);
  } catch {
    // A deactivated or temporary artifact cannot replace the authoritative config.
  }
}

async function settleRecoveryArtifacts(
  configPath: string,
  io: OwnerIdentityFileIo,
  transactionToken: string,
): Promise<void> {
  const journalPath = recoveryJournalPath(configPath);
  let journalRaw: string;
  try {
    journalRaw = await io.readFile(journalPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  const journal = parseRecoveryJournal(journalRaw, configPath);
  const activeToken = journal?.transactionToken ?? transactionToken;
  const inactiveJournal = await renameIfPresent(
    io,
    journalPath,
    `${journalPath}.${activeToken}.inactive`,
  );
  if (inactiveJournal === undefined) return;
  if (journal !== undefined) {
    const paths = recoveryPaths(configPath, journal.transactionToken);
    await unlinkBestEffort(io, paths.recoveryPath);
    await unlinkBestEffort(io, paths.committedPath);
    await unlinkBestEffort(io, paths.tempPath);
  }
  await unlinkBestEffort(io, inactiveJournal);
}

async function deactivateRecoveryJournal(
  paths: RecoveryPaths,
  io: OwnerIdentityFileIo,
  transactionToken: string,
): Promise<string | undefined> {
  return renameIfPresent(
    io,
    paths.journalPath,
    `${paths.journalPath}.${transactionToken}.inactive`,
  );
}

async function revokeCommitIntent(
  paths: RecoveryPaths,
  io: OwnerIdentityFileIo,
  transactionToken: string,
): Promise<string | undefined> {
  return renameIfPresent(
    io,
    paths.committedPath,
    `${paths.committedPath}.${transactionToken}.revoked`,
  );
}

async function recoverInterruptedConfig(
  configPath: string,
  io: OwnerIdentityFileIo,
  createTempToken: () => string,
): Promise<boolean> {
  const journalPath = recoveryJournalPath(configPath);
  let journalRaw: string;
  try {
    journalRaw = await io.readFile(journalPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  const journal = parseRecoveryJournal(journalRaw, configPath);
  if (journal === undefined) {
    await settleRecoveryArtifacts(configPath, io, createTransactionToken(createTempToken));
    return false;
  }
  const paths = recoveryPaths(configPath, journal.transactionToken);
  let committedRaw: string | undefined;
  try {
    committedRaw = await io.readFile(paths.committedPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  if (committedRaw !== undefined) {
    if (committedRaw !== journalRaw) throw new Error("Invalid owner commit intent");
    let nextRaw: string;
    try {
      nextRaw = await io.readFile(paths.tempPath, "utf8");
    } catch {
      throw new Error("Missing owner commit candidate");
    }
    if (fingerprint(nextRaw) !== journal.nextFingerprint || !isValidConfig(nextRaw)) {
      throw new Error("Invalid owner commit candidate");
    }
    try {
      await io.link(paths.tempPath, configPath);
    } catch (error) {
      if (!isExistingFile(error)) throw error;
    }
    await settleRecoveryArtifacts(configPath, io, journal.transactionToken);
    return true;
  }
  let recoveredRaw: string;
  try {
    recoveredRaw = await io.readFile(paths.recoveryPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    await settleRecoveryArtifacts(configPath, io, journal.transactionToken);
    return false;
  }
  if (fingerprint(recoveredRaw) !== journal.expectedFingerprint || !isValidConfig(recoveredRaw)) {
    await settleRecoveryArtifacts(configPath, io, journal.transactionToken);
    return false;
  }
  try {
    await io.link(paths.recoveryPath, configPath);
  } catch (error) {
    if (!isExistingFile(error)) throw error;
  }
  await settleRecoveryArtifacts(configPath, io, journal.transactionToken);
  return true;
}

export class OwnerIdentityService implements OwnerIdentityAccess {
  readonly #listeners = new Set<(snapshot: OwnerIdentitySnapshot) => void>();
  #updateTail: Promise<void> = Promise.resolve();
  readonly #io: OwnerIdentityFileIo;
  readonly #createTempToken: () => string;
  readonly #configPath: string;
  readonly #botUsername: string;
  #configFingerprint: string;
  #snapshot: OwnerIdentitySnapshot;
  #configError: OwnerIdentityError | undefined;

  private constructor(
    configPath: string,
    botUsername: string,
    io: OwnerIdentityFileIo,
    createTempToken: () => string,
    configFingerprint: string,
    snapshot: OwnerIdentitySnapshot,
    configError?: OwnerIdentityError,
  ) {
    this.#configPath = configPath;
    this.#botUsername = botUsername;
    this.#io = io;
    this.#createTempToken = createTempToken;
    this.#configFingerprint = configFingerprint;
    this.#snapshot = snapshot;
    this.#configError = configError;
  }

  static async open(
    configPath: string,
    options: OwnerIdentityServiceOptions = {},
  ): Promise<OwnerIdentityService> {
    const io = { ...defaultFileIo, ...options.io } as OwnerIdentityFileIo;
    const createTempToken = options.createTempToken ?? randomUUID;
    let raw: string;

    try {
      raw = await io.readFile(configPath, "utf8");
      await settleRecoveryArtifacts(configPath, io, createTransactionToken(createTempToken));
    } catch (error) {
      if (!isMissingFile(error)) throw new OwnerIdentityError("OWNER_IDENTITY_WRITE_FAILED");

      let recovered: boolean;
      try {
        recovered = await recoverInterruptedConfig(configPath, io, createTempToken);
      } catch {
        throw new OwnerIdentityError("OWNER_IDENTITY_WRITE_FAILED");
      }
      if (recovered) {
        try {
          raw = await io.readFile(configPath, "utf8");
        } catch {
          throw new OwnerIdentityError("OWNER_IDENTITY_WRITE_FAILED");
        }
      } else {
        try {
          await io.mkdir(dirname(configPath), { recursive: true });
        } catch {
          throw new OwnerIdentityError("OWNER_IDENTITY_WRITE_FAILED");
        }

        const service = new OwnerIdentityService(
          configPath,
          "WhiteLily",
          io,
          createTempToken,
          fingerprint(DEFAULT_CONFIG_TOML),
          publicSnapshot(0, null, "unknown"),
        );
        await service.#replaceConfig(DEFAULT_CONFIG_TOML);
        return service;
      }
    }

    try {
      const parsed = appConfigSchema.parse(parse(raw));
      const ownerUsername =
        parsed.minecraft.owner_username === "YourMcName"
          ? null
          : parseMinecraftJavaUsername(
              parsed.minecraft.owner_username,
              parsed.minecraft.bot_username,
            );
      return new OwnerIdentityService(
        configPath,
        parsed.minecraft.bot_username,
        io,
        createTempToken,
        fingerprint(raw),
        publicSnapshot(0, ownerUsername, "unknown"),
      );
    } catch {
      return new OwnerIdentityService(
        configPath,
        "WhiteLily",
        io,
        createTempToken,
        fingerprint(raw),
        publicSnapshot(0, null, "unknown"),
        new OwnerIdentityError("OWNER_IDENTITY_CONFIG_INVALID"),
      );
    }
  }

  snapshot(): OwnerIdentitySnapshot {
    this.#assertConfigValid();
    return this.#snapshot;
  }

  update(input: {
    expectedRevision: number;
    ownerUsername: string;
  }): Promise<OwnerIdentitySnapshot> {
    const update = this.#updateTail.then(() => this.#update(input));
    this.#updateTail = update.then(
      () => undefined,
      () => undefined,
    );
    return update;
  }

  async #update(input: {
    expectedRevision: number;
    ownerUsername: string;
  }): Promise<OwnerIdentitySnapshot> {
    const nextOwner = parseMinecraftJavaUsername(input.ownerUsername, this.#botUsername);
    const before = this.snapshot();
    if (input.expectedRevision !== before.revision) {
      throw new OwnerIdentityError("OWNER_IDENTITY_CONFIG_CONFLICT");
    }
    if (before.ownerUsername === nextOwner) return before;

    let raw: string;
    try {
      raw = await this.#io.readFile(this.#configPath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw new OwnerIdentityError("OWNER_IDENTITY_WRITE_FAILED");
      try {
        if (!(await recoverInterruptedConfig(this.#configPath, this.#io, this.#createTempToken))) {
          throw new OwnerIdentityError("OWNER_IDENTITY_CONFIG_CONFLICT");
        }
        raw = await this.#io.readFile(this.#configPath, "utf8");
      } catch (recoveryError) {
        if (recoveryError instanceof OwnerIdentityError) throw recoveryError;
        throw new OwnerIdentityError("OWNER_IDENTITY_WRITE_FAILED");
      }
    }
    if (fingerprint(raw) !== this.#configFingerprint) {
      throw new OwnerIdentityError("OWNER_IDENTITY_CONFIG_CONFLICT");
    }

    let serialized: string;
    try {
      const parsed = appConfigSchema.parse(parse(raw));
      parsed.minecraft.owner_username = nextOwner;
      serialized = `${stringify(parsed).trimEnd()}\n`;
    } catch {
      throw new OwnerIdentityError("OWNER_IDENTITY_CONFIG_INVALID");
    }
    await this.#replaceConfig(serialized, this.#configFingerprint);

    this.#configFingerprint = fingerprint(serialized);
    this.#snapshot = publicSnapshot(before.revision + 1, nextOwner, "unknown");
    this.#publish();
    return this.snapshot();
  }

  setPresence(input: {
    revision: number;
    ownerUsername: string;
    presence: Exclude<OwnerPresence, "unknown">;
  }): void {
    this.#assertConfigValid();
    const before = this.#snapshot;
    if (
      input.revision !== before.revision ||
      input.ownerUsername !== before.ownerUsername ||
      (input.presence !== "online" && input.presence !== "offline") ||
      before.presence === input.presence
    ) {
      return;
    }
    this.#snapshot = publicSnapshot(before.revision, before.ownerUsername, input.presence);
    this.#publish();
  }

  subscribe(listener: (snapshot: OwnerIdentitySnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #assertConfigValid(): void {
    if (this.#configError !== undefined) throw this.#configError;
  }

  #publish(): void {
    for (const listener of this.#listeners) {
      try {
        listener(this.#snapshot);
      } catch {
        // A subscriber cannot roll back an already committed configuration write.
      }
    }
  }

  async #replaceConfig(serialized: string, expectedFingerprint?: string): Promise<void> {
    const token = createTransactionToken(this.#createTempToken);
    const paths = recoveryPaths(this.#configPath, token);
    let created = false;
    let journalActive = false;
    let captured = false;
    let published = false;
    let commitIntentActive = false;
    let failure: unknown;
    const inactiveJournals: string[] = [];
    const revokedCommitIntents: string[] = [];
    try {
      if (expectedFingerprint !== undefined) {
        await settleRecoveryArtifacts(this.#configPath, this.#io, token);
      }
      await createPrivateFile(this.#io, paths.tempPath, serialized);
      created = true;
      if (expectedFingerprint !== undefined) {
        const journal: RecoveryJournal = {
          schemaVersion: 1,
          targetBasename: basename(this.#configPath),
          recoveryBasename: basename(paths.recoveryPath),
          transactionToken: token,
          expectedFingerprint,
          nextFingerprint: fingerprint(serialized),
        };
        await createPrivateFile(this.#io, paths.journalPath, serializeRecoveryJournal(journal));
        journalActive = true;
        try {
          await this.#io.rename(this.#configPath, paths.recoveryPath);
        } catch (error) {
          if (isMissingFile(error)) {
            throw new OwnerIdentityError("OWNER_IDENTITY_CONFIG_CONFLICT");
          }
          throw error;
        }
        captured = true;
        const capturedRaw = await this.#io.readFile(paths.recoveryPath, "utf8");
        if (fingerprint(capturedRaw) !== expectedFingerprint || !isValidConfig(capturedRaw)) {
          throw new OwnerIdentityError("OWNER_IDENTITY_CONFIG_CONFLICT");
        }
        await this.#io.link(paths.journalPath, paths.committedPath);
        commitIntentActive = true;
      }
      try {
        await this.#io.link(paths.tempPath, this.#configPath);
      } catch (error) {
        if (expectedFingerprint !== undefined && isExistingFile(error)) {
          throw new OwnerIdentityError("OWNER_IDENTITY_CONFIG_CONFLICT");
        }
        throw error;
      }
      published = true;
      if (journalActive) {
        const inactiveJournal = await deactivateRecoveryJournal(paths, this.#io, token);
        journalActive = false;
        if (inactiveJournal !== undefined) inactiveJournals.push(inactiveJournal);
      }
    } catch (error) {
      failure =
        published && commitIntentActive && journalActive
          ? new OwnerIdentityError("OWNER_IDENTITY_CONFIG_CONFLICT")
          : error;
    }
    if (captured && !published) {
      if (commitIntentActive) {
        try {
          const revokedCommitIntent = await revokeCommitIntent(paths, this.#io, token);
          commitIntentActive = false;
          if (revokedCommitIntent !== undefined) {
            revokedCommitIntents.push(revokedCommitIntent);
          }
        } catch {
          // Retain the complete intent and candidate when revocation is not durable.
        }
      }
      let configIsAuthoritative = false;
      if (!commitIntentActive) {
        try {
          await this.#io.link(paths.recoveryPath, this.#configPath);
          configIsAuthoritative = true;
        } catch (error) {
          configIsAuthoritative = isExistingFile(error);
        }
        if (configIsAuthoritative && journalActive) {
          try {
            const inactiveJournal = await deactivateRecoveryJournal(paths, this.#io, token);
            journalActive = false;
            if (inactiveJournal !== undefined) inactiveJournals.push(inactiveJournal);
          } catch {
            // Keep the active journal only if it could not be safely deactivated.
          }
        }
        if (configIsAuthoritative && !journalActive) captured = false;
      }
    }
    if (!journalActive) {
      await unlinkBestEffort(this.#io, paths.recoveryPath);
      await unlinkBestEffort(this.#io, paths.committedPath);
      captured = false;
      commitIntentActive = false;
      for (const inactiveJournal of inactiveJournals) {
        await unlinkBestEffort(this.#io, inactiveJournal);
      }
      for (const revokedCommitIntent of revokedCommitIntents) {
        await unlinkBestEffort(this.#io, revokedCommitIntent);
      }
      if (created) await unlinkBestEffort(this.#io, paths.tempPath);
    }
    if (failure !== undefined) {
      if (failure instanceof OwnerIdentityError) throw failure;
      throw new OwnerIdentityError("OWNER_IDENTITY_WRITE_FAILED");
    }
  }
}
