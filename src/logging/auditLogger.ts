import { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { redactPublicText } from "../memory/redaction.js";
import { sanitizeLogValue } from "./safeLogger.js";

export const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
export const AUDIT_RETAINED_FILES = 5;

const auditKinds = new Set<AuditEvent["kind"]>([
  "connection",
  "task_started",
  "task_stopped",
  "action_allowed",
  "action_denied",
  "budget_exhausted",
  "emergency_stop",
  "settings_changed",
]);
const auditTopLevelKeys = new Set([
  "schemaVersion",
  "timestamp",
  "kind",
  "worldIdHash",
  "taskId",
  "detail",
]);
const taskDetailKeys = [
  "startedAt",
  "expectedActionCategoryCount",
  "maxToolCalls",
  "maxBlockChanges",
  "maxHorizontalTravel",
  "maxDurationMs",
  "maxDangerousOperations",
  "toolCalls",
  "blockChanges",
  "horizontalTravel",
  "dangerousOperations",
] as const;
const auditDetailKeys: Readonly<Record<AuditEvent["kind"], ReadonlySet<string>>> = {
  connection: new Set([
    "status",
    "code",
    "port",
    "connected",
    "counter",
    "ownerUsername",
    "path",
    "address",
    "authUrl",
    "accessToken",
    "email",
    "rawChat",
    "memorySummary",
  ]),
  task_started: new Set(taskDetailKeys),
  task_stopped: new Set([...taskDetailKeys, "reason"]),
  action_allowed: new Set(["action", "category", "reason", "code"]),
  action_denied: new Set(["action", "category", "reason", "code"]),
  budget_exhausted: new Set(["reason", "limit", "used", "code"]),
  emergency_stop: new Set(["reason", "code"]),
  settings_changed: new Set(["healthProbe", "setting", "enabled", "code", "counter"]),
};
const nonnegativeIntegerDetailKeys = new Set([
  "port",
  "counter",
  "expectedActionCategoryCount",
  "maxToolCalls",
  "maxBlockChanges",
  "maxDurationMs",
  "maxDangerousOperations",
  "toolCalls",
  "blockChanges",
  "dangerousOperations",
  "limit",
  "used",
]);
const nonnegativeFiniteNumberDetailKeys = new Set(["maxHorizontalTravel", "horizontalTravel"]);
const booleanDetailKeys = new Set(["connected", "healthProbe", "enabled"]);
const canonicalTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const worldIdHashPattern = /^[a-f0-9]{64}$/u;
const taskIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_AUDIT_DETAIL_STRING_LENGTH = 256;
const AUDIT_TOMBSTONE_SLOTS = 16;
const writeQueues = new Map<string, Promise<unknown>>();

export interface AuditEvent {
  schemaVersion: 1;
  timestamp: string;
  kind:
    | "connection"
    | "task_started"
    | "task_stopped"
    | "action_allowed"
    | "action_denied"
    | "budget_exhausted"
    | "emergency_stop"
    | "settings_changed";
  worldIdHash?: string;
  taskId?: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface AuditLoggerOptions {
  maxBytes?: number;
  retainedFiles?: number;
  appendLine?: (path: string, line: string) => Promise<void>;
  now?: () => Date;
}

export class AuditLogger {
  readonly #maxBytes: number;
  readonly #retainedFiles: number;
  readonly #appendLine: ((path: string, line: string) => Promise<void>) | undefined;
  readonly #now: () => Date;
  #health: "writable" | "failed" = "writable";

  constructor(
    private readonly path: string,
    options: AuditLoggerOptions = {},
  ) {
    this.#maxBytes = positiveInteger(options.maxBytes ?? AUDIT_MAX_BYTES, "maxBytes");
    this.#retainedFiles = positiveInteger(
      options.retainedFiles ?? AUDIT_RETAINED_FILES,
      "retainedFiles",
    );
    this.#appendLine = options.appendLine;
    this.#now = options.now ?? (() => new Date());
  }

  health(): "writable" | "failed" {
    return this.#health;
  }

  async append(event: AuditEvent): Promise<void> {
    try {
      await this.#enqueue(event);
      this.#health = "writable";
    } catch {
      this.#health = "failed";
      throw new Error("audit append failed");
    }
  }

  async probeHealth(): Promise<boolean> {
    try {
      await this.#enqueue({
        schemaVersion: 1,
        timestamp: this.#now().toISOString(),
        kind: "settings_changed",
        detail: { healthProbe: true },
      });
      this.#health = "writable";
      return true;
    } catch {
      this.#health = "failed";
      return false;
    }
  }

  #enqueue(event: AuditEvent): Promise<void> {
    const previous = writeQueues.get(this.path) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const line = `${serializeAuditEvent(event)}\n`;
        const parent = dirname(this.path);
        await mkdir(parent, { recursive: true });
        const parentIdentity = await inspectTrustedDirectory(parent);
        await this.#rotateIfNeeded(Buffer.byteLength(line, "utf8"), parentIdentity);
        if (!(await sameTrustedDirectory(parentIdentity))) {
          throw new Error("audit directory changed before append");
        }
        if (this.#appendLine) {
          await this.#appendLine(this.path, line);
        } else {
          await appendTrustedLine(this.path, line, parentIdentity);
        }
      });
    writeQueues.set(this.path, current);
    return current.finally(() => {
      if (writeQueues.get(this.path) === current) writeQueues.delete(this.path);
    });
  }

  async #rotateIfNeeded(
    nextLineBytes: number,
    parentIdentity: TrustedDirectoryIdentity,
  ): Promise<void> {
    if (nextLineBytes > this.#maxBytes) {
      throw new Error("audit event exceeds maximum file size");
    }
    const currentBytes = await trustedFileSize(this.path, parentIdentity);
    if (currentBytes === 0 || currentBytes + nextLineBytes <= this.#maxBytes) return;
    await rotateManagedAuditFiles(this.path, this.#retainedFiles, parentIdentity);
  }
}

function serializeAuditEvent(event: AuditEvent): string {
  validateAuditEvent(event);
  const sanitized = sanitizeLogValue(event);
  return redactPublicText(JSON.stringify(sanitized));
}

function validateAuditEvent(event: AuditEvent): void {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("invalid audit event");
  }
  const topLevelKeys = Object.keys(event);
  if (
    topLevelKeys.some((key) => !auditTopLevelKeys.has(key)) ||
    event.schemaVersion !== 1 ||
    !auditKinds.has(event.kind) ||
    !isCanonicalTimestamp(event.timestamp) ||
    (event.worldIdHash !== undefined &&
      (typeof event.worldIdHash !== "string" || !worldIdHashPattern.test(event.worldIdHash))) ||
    (event.taskId !== undefined &&
      (typeof event.taskId !== "string" || !taskIdPattern.test(event.taskId))) ||
    !event.detail ||
    typeof event.detail !== "object" ||
    Array.isArray(event.detail)
  ) {
    throw new Error("invalid audit event");
  }
  const allowedKeys = auditDetailKeys[event.kind];
  const detailEntries = Object.entries(event.detail);
  if (detailEntries.length > allowedKeys.size) throw new Error("invalid audit event");
  for (const [key, value] of detailEntries) {
    if (!allowedKeys.has(key) || !isValidAuditDetailValue(key, value)) {
      throw new Error("invalid audit event");
    }
  }
}

function isValidAuditDetailValue(key: string, value: unknown): boolean {
  if (value === null) return true;
  if (nonnegativeFiniteNumberDetailKeys.has(key)) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }
  if (nonnegativeIntegerDetailKeys.has(key)) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }
  if (booleanDetailKeys.has(key)) return typeof value === "boolean";
  if (key === "startedAt") return typeof value === "string" && isCanonicalTimestamp(value);
  return (
    typeof value === "string" &&
    value.length <= MAX_AUDIT_DETAIL_STRING_LENGTH &&
    !value.includes("\0")
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !canonicalTimestampPattern.test(value)) return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
  return value;
}

interface TrustedDirectoryIdentity {
  path: string;
  canonicalPath: string;
  dev: number | bigint;
  ino: number | bigint;
}

interface TrustedFileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

interface RotationRecord {
  originalPath: string;
  currentPath: string;
  generation: number;
  identity: TrustedFileIdentity;
}

interface TombstoneRecord {
  path: string;
  slot: number;
  identity: TrustedFileIdentity;
}

async function inspectTrustedDirectory(path: string): Promise<TrustedDirectoryIdentity> {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw new Error("audit directory is not trusted");
  }
  const canonicalPath = await realpath(path);
  if (normalizePath(canonicalPath) !== normalizePath(path)) {
    throw new Error("audit directory is not trusted");
  }
  return { path, canonicalPath, dev: value.dev, ino: value.ino };
}

async function sameTrustedDirectory(expected: TrustedDirectoryIdentity): Promise<boolean> {
  try {
    const actual = await inspectTrustedDirectory(expected.path);
    return (
      actual.dev === expected.dev &&
      actual.ino === expected.ino &&
      normalizePath(actual.canonicalPath) === normalizePath(expected.canonicalPath)
    );
  } catch {
    return false;
  }
}

async function trustedFileSize(
  path: string,
  parentIdentity: TrustedDirectoryIdentity,
): Promise<number> {
  try {
    const value = await inspectTrustedFile(path, parentIdentity);
    return value.size;
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
}

async function appendTrustedLine(
  path: string,
  line: string,
  parentIdentity: TrustedDirectoryIdentity,
): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    const opened = await handle.stat();
    const selected = await inspectTrustedFile(path, parentIdentity);
    if (
      !opened.isFile() ||
      opened.dev !== selected.dev ||
      opened.ino !== selected.ino ||
      !(await sameTrustedDirectory(parentIdentity))
    ) {
      throw new Error("audit path is not trusted");
    }
    await handle.writeFile(line, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function inspectTrustedFile(path: string, parentIdentity: TrustedDirectoryIdentity) {
  if (!(await sameTrustedDirectory(parentIdentity))) {
    throw new Error("audit directory changed");
  }
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink()) {
    throw new Error("audit path is not a trusted regular file");
  }
  const canonicalPath = await realpath(path);
  if (normalizePath(canonicalPath) !== normalizePath(path)) {
    throw new Error("audit path is not a trusted regular file");
  }
  return value;
}

async function rotateManagedAuditFiles(
  path: string,
  retainedFiles: number,
  parentIdentity: TrustedDirectoryIdentity,
): Promise<void> {
  const records = await listManagedAuditFiles(path, parentIdentity);
  const tombstones = await listAuditTombstones(path, parentIdentity);
  const discarded = records
    .filter((candidate) => candidate.generation + 1 >= retainedFiles)
    .sort((left, right) => left.generation - right.generation);
  const requiredTombstones = Math.max(0, discarded.length - 1);
  if (tombstones.length + requiredTombstones > AUDIT_TOMBSTONE_SLOTS) {
    throw new Error("audit tombstone capacity exhausted");
  }
  const transactionId = randomUUID().replaceAll("-", "");
  try {
    let stageSequence = 0;
    for (const record of [...records].sort((left, right) => right.generation - left.generation)) {
      const stagingPath = `${path}.rotate-${transactionId}-${stageSequence}`;
      stageSequence += 1;
      await renameExpectedFile(record.currentPath, stagingPath, record.identity, parentIdentity);
      record.currentPath = stagingPath;
    }
  } catch (error) {
    await rollbackRotation(records, parentIdentity);
    throw error;
  }

  try {
    const retained = records
      .filter((candidate) => candidate.generation + 1 < retainedFiles)
      .sort((left, right) => right.generation - left.generation);
    for (const record of retained) {
      const destination = `${path}.${record.generation + 1}`;
      await renameExpectedFile(record.currentPath, destination, record.identity, parentIdentity);
      record.currentPath = destination;
    }
    const recycled = discarded[0];
    const usedSlots = new Set(tombstones.map((candidate) => candidate.slot));
    let nextSlot = 0;
    for (const record of discarded.slice(1)) {
      while (usedSlots.has(nextSlot)) nextSlot += 1;
      const destination = `${path}.tombstone.${nextSlot}`;
      await renameExpectedFile(record.currentPath, destination, record.identity, parentIdentity);
      record.currentPath = destination;
      usedSlots.add(nextSlot);
    }
    if (recycled) {
      await renameExpectedFile(recycled.currentPath, path, recycled.identity, parentIdentity);
      recycled.currentPath = path;
    }
  } catch (error) {
    await rollbackRotation(records, parentIdentity);
    throw error;
  }

  for (const record of discarded) {
    await zeroizeExpectedFile(record.currentPath, record.identity, parentIdentity);
  }
  for (const tombstone of tombstones) {
    await zeroizeExpectedFile(tombstone.path, tombstone.identity, parentIdentity);
  }
}

async function listManagedAuditFiles(
  path: string,
  parentIdentity: TrustedDirectoryIdentity,
): Promise<RotationRecord[]> {
  const parent = dirname(path);
  const activeName = basename(path);
  const suffixPattern = new RegExp(`^${escapeRegExp(activeName)}\\.(\\d+)$`, "u");
  const records: RotationRecord[] = [];
  for (const name of await readdir(parent)) {
    const generation =
      name === activeName
        ? 0
        : (() => {
            const match = suffixPattern.exec(name);
            if (!match) return undefined;
            const suffix = match[1]!;
            const parsed = Number.parseInt(suffix, 10);
            return /^[1-9]\d*$/u.test(suffix) &&
              Number.isSafeInteger(parsed) &&
              String(parsed) === suffix
              ? parsed
              : Number.MAX_SAFE_INTEGER;
          })();
    if (generation === undefined) continue;
    const filePath = resolve(parent, name);
    const value = await inspectTrustedFile(filePath, parentIdentity);
    records.push({
      originalPath: filePath,
      currentPath: filePath,
      generation,
      identity: { dev: value.dev, ino: value.ino },
    });
  }
  return records;
}

async function listAuditTombstones(
  path: string,
  parentIdentity: TrustedDirectoryIdentity,
): Promise<TombstoneRecord[]> {
  const parent = dirname(path);
  const activeName = basename(path);
  const tombstonePattern = new RegExp(`^${escapeRegExp(activeName)}\\.tombstone\\.(\\d+)$`, "u");
  const tombstones: TombstoneRecord[] = [];
  for (const name of await readdir(parent)) {
    const match = tombstonePattern.exec(name);
    if (!match) continue;
    const slot = Number.parseInt(match[1]!, 10);
    if (
      !Number.isSafeInteger(slot) ||
      slot < 0 ||
      slot >= AUDIT_TOMBSTONE_SLOTS ||
      String(slot) !== match[1]
    ) {
      continue;
    }
    const tombstonePath = resolve(parent, name);
    const value = await inspectTrustedFile(tombstonePath, parentIdentity);
    tombstones.push({
      path: tombstonePath,
      slot,
      identity: { dev: value.dev, ino: value.ino },
    });
  }
  return tombstones;
}

async function renameExpectedFile(
  from: string,
  to: string,
  expected: TrustedFileIdentity,
  parentIdentity: TrustedDirectoryIdentity,
): Promise<void> {
  const before = await inspectTrustedFile(from, parentIdentity);
  if (!sameFileIdentity(before, expected)) throw new Error("audit file identity changed");
  try {
    await lstat(to);
    throw new Error("audit rotation target already exists");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (!(await sameTrustedDirectory(parentIdentity))) {
    throw new Error("audit directory changed before rotation");
  }
  await rename(from, to);
  try {
    const moved = await inspectTrustedFile(to, parentIdentity);
    if (sameFileIdentity(moved, expected)) return;
  } catch {
    // The operation may have crossed a parent replacement. Restore below.
  }
  try {
    await lstat(from);
  } catch (error) {
    if (isNotFound(error)) {
      await rename(to, from);
    }
  }
  throw new Error("audit file identity changed during rotation");
}

async function zeroizeExpectedFile(
  path: string,
  expected: TrustedFileIdentity,
  parentIdentity: TrustedDirectoryIdentity,
): Promise<void> {
  const handle = await open(path, "r+");
  try {
    const opened = await handle.stat();
    const selected = await inspectTrustedFile(path, parentIdentity);
    if (
      !opened.isFile() ||
      !sameFileIdentity(opened, expected) ||
      !sameFileIdentity(selected, expected) ||
      !(await sameTrustedDirectory(parentIdentity))
    ) {
      throw new Error("audit disposition identity changed");
    }
    await handle.truncate(0);
    await handle.sync();
    const zeroized = await handle.stat();
    if (!sameFileIdentity(zeroized, expected) || zeroized.size !== 0) {
      throw new Error("audit disposition failed");
    }
  } finally {
    await handle.close();
  }
}

async function rollbackRotation(
  records: readonly RotationRecord[],
  parentIdentity: TrustedDirectoryIdentity,
): Promise<void> {
  for (const record of [...records].sort((left, right) => left.generation - right.generation)) {
    if (record.currentPath === "" || record.currentPath === record.originalPath) continue;
    try {
      await renameExpectedFile(
        record.currentPath,
        record.originalPath,
        record.identity,
        parentIdentity,
      );
      record.currentPath = record.originalPath;
    } catch {
      // A replacement at the original path is preserved; recovery stays fail-closed.
    }
  }
}

function sameFileIdentity(
  value: { dev: number | bigint; ino: number | bigint },
  expected: TrustedFileIdentity,
): boolean {
  return value.dev === expected.dev && value.ino === expected.ino;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizePath(path: string): string {
  return resolve(path).toLocaleLowerCase("en-US");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
