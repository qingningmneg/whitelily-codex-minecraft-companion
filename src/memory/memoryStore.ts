import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { containsSensitiveData } from "./redaction.js";

export interface MemoryRecord {
  id: number;
  category: "preference" | "place" | "project" | "promise" | "experience";
  summary: string;
  importance: 1 | 2 | 3 | 4 | 5;
  createdAt: string;
}

type NewMemory = Omit<MemoryRecord, "id" | "createdAt">;

export interface MemoryValidationSource {
  ownerText?: string;
  modelText?: string;
}

const maximumSummaryLength = 160;
const categories = new Set<MemoryRecord["category"]>([
  "preference",
  "place",
  "project",
  "promise",
  "experience",
]);
const writeQueues = new Map<string, Promise<unknown>>();
const rawChatOrReasoning =
  /^\s*(?:(?:player|user|assistant|玩家|用户|白百合|模型)\s*(?:said|says|说)?\s*[:：]|(?:模型|model)\s*(?:推理|思考|reasoning|analysis)\s*[:：])/i;

function normalizeForOverlap(value: string): string {
  return Array.from(value.normalize("NFKC").toLocaleLowerCase())
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("");
}

function ngrams(value: string, width: number): Set<string> {
  const characters = Array.from(value);
  const result = new Set<string>();
  for (let index = 0; index <= characters.length - width; index += 1) {
    result.add(characters.slice(index, index + width).join(""));
  }
  return result;
}

function hasHighOverlap(candidate: string, source: string): boolean {
  const normalizedCandidate = normalizeForOverlap(candidate);
  const normalizedSource = normalizeForOverlap(source);
  if (normalizedCandidate.length === 0 || normalizedSource.length === 0) return false;
  if (normalizedCandidate === normalizedSource) return true;
  if (
    Math.min(normalizedCandidate.length, normalizedSource.length) >= 8 &&
    (normalizedCandidate.includes(normalizedSource) ||
      normalizedSource.includes(normalizedCandidate))
  )
    return true;
  if (normalizedCandidate.length < 16 || normalizedSource.length < 16) return false;
  const candidateNgrams = ngrams(normalizedCandidate, 3);
  const sourceNgrams = ngrams(normalizedSource, 3);
  let common = 0;
  for (const gram of candidateNgrams) {
    if (sourceNgrams.has(gram)) common += 1;
  }
  const smaller = Math.min(candidateNgrams.size, sourceNgrams.size);
  return smaller > 0 && common / smaller >= 0.85;
}

function overlapsUntrustedSource(summary: string, source: MemoryValidationSource): boolean {
  return [source.ownerText, source.modelText].some(
    (text) => typeof text === "string" && hasHighOverlap(summary, text),
  );
}

function serializeByPath<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  writeQueues.set(path, current);
  return current.finally(() => {
    if (writeQueues.get(path) === current) writeQueues.delete(path);
  });
}

function isValidRecord(value: unknown): value is MemoryRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 5 ||
    !Object.keys(record).every((key) =>
      ["id", "category", "summary", "importance", "createdAt"].includes(key),
    )
  ) {
    return false;
  }
  return (
    typeof record.id === "number" &&
    Number.isSafeInteger(record.id) &&
    record.id > 0 &&
    typeof record.category === "string" &&
    categories.has(record.category as MemoryRecord["category"]) &&
    typeof record.summary === "string" &&
    record.summary.trim().length > 0 &&
    record.summary.length <= maximumSummaryLength &&
    typeof record.importance === "number" &&
    Number.isInteger(record.importance) &&
    record.importance >= 1 &&
    record.importance <= 5 &&
    typeof record.createdAt === "string" &&
    !Number.isNaN(Date.parse(record.createdAt))
  );
}

export class MemoryStore {
  constructor(
    private readonly path: string,
    private readonly dependencies: { beforeRename?: (path: string) => Promise<void> } = {},
  ) {}

  private get nextIdPath(): string {
    return `${this.path}.next-id`;
  }

  private async readAll(): Promise<MemoryRecord[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!Array.isArray(parsed) || !parsed.every(isValidRecord)) {
      throw new Error("memory record is invalid");
    }
    const ids = new Set<number>();
    for (const record of parsed) {
      if (ids.has(record.id)) throw new Error("memory record is invalid");
      ids.add(record.id);
    }
    return parsed;
  }

  private async readNextId(records: MemoryRecord[]): Promise<number> {
    const nextAfterExisting =
      records.reduce((largest, record) => Math.max(largest, record.id), 0) + 1;
    if (!Number.isSafeInteger(nextAfterExisting)) throw new Error("memory next-id is unsafe");
    try {
      const contents = await readFile(this.nextIdPath, "utf8");
      if (!/^[1-9]\d*\r?\n?$/.test(contents)) throw new Error("memory next-id file is invalid");
      const stored = Number(contents.trim());
      if (!Number.isSafeInteger(stored) || stored < 1) {
        throw new Error("memory next-id file is invalid");
      }
      return Math.max(stored, nextAfterExisting);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return nextAfterExisting;
      throw error;
    }
  }

  private async writeAtomically(
    path: string,
    contents: string,
    canCommit: () => boolean = () => true,
  ): Promise<boolean> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, contents, "utf8");
      if (!canCommit()) {
        await rm(tempPath, { force: true });
        return false;
      }
      await this.dependencies.beforeRename?.(path);
      if (!canCommit()) {
        await rm(tempPath, { force: true });
        return false;
      }
      await rename(tempPath, path);
      return true;
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async writeAll(
    records: MemoryRecord[],
    canCommit: () => boolean = () => true,
  ): Promise<boolean> {
    return this.writeAtomically(this.path, `${JSON.stringify(records, null, 2)}\n`, canCommit);
  }

  /** Validates a model-proposed memory without writing it. */
  validateCandidate(input: NewMemory, source: MemoryValidationSource = {}): void {
    if (
      !categories.has(input.category) ||
      !Number.isInteger(input.importance) ||
      input.importance < 1 ||
      input.importance > 5 ||
      typeof input.summary !== "string" ||
      input.summary.trim().length === 0
    ) {
      throw new Error("memory record is invalid");
    }
    if (containsSensitiveData(input.summary)) {
      throw new Error("memory contains a credential or sensitive personal datum");
    }
    if (input.summary.length > maximumSummaryLength || rawChatOrReasoning.test(input.summary)) {
      throw new Error("memory must be a concise structured summary");
    }
    if (overlapsUntrustedSource(input.summary, source)) {
      throw new Error("memory overlaps current untrusted source text");
    }
  }

  async add(input: NewMemory, source: MemoryValidationSource = {}): Promise<MemoryRecord> {
    const validationSource = { ...source };
    this.validateCandidate(input, validationSource);
    return serializeByPath(this.path, async () => {
      this.validateCandidate(input, validationSource);
      const records = await this.readAll();
      const id = await this.readNextId(records);
      const record: MemoryRecord = {
        id,
        category: input.category,
        summary: input.summary,
        importance: input.importance,
        createdAt: new Date().toISOString(),
      };
      await this.writeAtomically(this.nextIdPath, `${id + 1}\n`);
      await this.writeAll([...records, record]);
      return { ...record };
    });
  }

  /** Validates every candidate before a single atomic write. */
  addBatch(
    inputs: NewMemory[],
    canCommit: () => boolean,
    source: MemoryValidationSource = {},
  ): Promise<MemoryRecord[]> {
    const validationSource = { ...source };
    for (const input of inputs) this.validateCandidate(input, validationSource);
    return serializeByPath(this.path, async () => {
      if (!canCommit()) return [];
      const records = await this.readAll();
      const firstId = await this.readNextId(records);
      if (!canCommit()) return [];
      for (const input of inputs) this.validateCandidate(input, validationSource);
      const created = inputs.map((input, index) => ({
        id: firstId + index,
        category: input.category,
        summary: input.summary,
        importance: input.importance,
        createdAt: new Date().toISOString(),
      }));
      if (!canCommit()) return [];
      await this.writeAtomically(this.nextIdPath, `${firstId + created.length}\n`, canCommit);
      if (!canCommit()) return [];
      return (await this.writeAll([...records, ...created], canCommit))
        ? created.map((record) => ({ ...record }))
        : [];
    });
  }

  async list(): Promise<MemoryRecord[]> {
    return (await this.readAll()).map((record) => ({ ...record }));
  }

  async search(query: string): Promise<MemoryRecord[]> {
    const needle = query.toLocaleLowerCase();
    return (await this.readAll())
      .filter((record) => record.summary.toLocaleLowerCase().includes(needle))
      .map((record) => ({ ...record }));
  }

  async forget(id: number): Promise<boolean> {
    return serializeByPath(this.path, async () => {
      const records = await this.readAll();
      const next = records.filter((record) => record.id !== id);
      if (next.length === records.length) return false;
      await this.writeAll(next);
      return true;
    });
  }

  clear(): Promise<void> {
    return serializeByPath(this.path, async () => {
      await this.writeAll([]);
    });
  }
}
