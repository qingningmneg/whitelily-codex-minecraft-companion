import { dirname } from "node:path";
import { z } from "zod";
import type { MemoryRecord, MemoryValidationSource, NewMemory } from "./memoryStore.js";
import { MemoryStore } from "./memoryStore.js";
import { compareMemoryOrder } from "./memoryDeduplication.js";
import {
  DocumentStore,
  DocumentStoreError,
  type DocumentEnvelope,
} from "../storage/documentStore.js";

export type MemoryScopeMode = "global" | "world" | "layered";
export type StoredMemoryScope = Exclude<MemoryScopeMode, "layered">;
export type MemorySource = "manual" | "automatic";

export interface MemoryContextScope {
  mode: MemoryScopeMode;
  worldId?: string | undefined;
}

export interface ScopedMemoryRecord extends MemoryRecord {
  scope: StoredMemoryScope;
  worldId?: string | undefined;
  source: MemorySource;
  pinned: boolean;
  revision: number;
  updatedAt: string;
}

export interface ScopedMemoryInput {
  category: MemoryRecord["category"];
  summary: string;
  importance: MemoryRecord["importance"];
  scope: StoredMemoryScope;
  worldId?: string | undefined;
  source?: MemorySource;
}

export interface ScopedMemoryPatch {
  category?: MemoryRecord["category"] | undefined;
  summary?: string | undefined;
  importance?: MemoryRecord["importance"] | undefined;
  scope?: StoredMemoryScope | undefined;
  worldId?: string | undefined;
}

export interface ScopedMemoryDocument {
  records: ScopedMemoryRecord[];
  legacyMigrated: boolean;
}

export interface ScopedMemoryExport {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  records: ScopedMemoryRecord[];
  legacyMigrated: boolean;
}

export interface ScopedMemoryMutation {
  envelope: ScopedMemoryExport;
  record?: ScopedMemoryRecord | undefined;
}

const categorySchema = z.enum(["preference", "place", "project", "promise", "experience"]);
const scopedRecordSchema = z
  .object({
    id: z.number().int().positive().safe(),
    category: categorySchema,
    summary: z.string().min(1).max(160),
    importance: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    createdAt: z.string().datetime({ offset: false }),
    scope: z.enum(["global", "world"]),
    worldId: z.string().min(1).max(128).optional(),
    source: z.enum(["manual", "automatic"]),
    pinned: z.boolean(),
    revision: z.number().int().nonnegative().safe(),
    updatedAt: z.string().datetime({ offset: false }),
  })
  .strict()
  .superRefine((record, context) => {
    if ((record.scope === "world") !== (record.worldId !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "world-scoped records require exactly one world ID",
      });
    }
    if (record.source === "automatic" && record.pinned) {
      context.addIssue({ code: "custom", message: "automatic records cannot be pinned" });
    }
  });
const documentSchema = z
  .object({ records: z.array(scopedRecordSchema), legacyMigrated: z.boolean() })
  .strict();

class MemoryBatchCancelled extends Error {}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertWorldId(
  scope: StoredMemoryScope | MemoryScopeMode,
  worldId: string | undefined,
): void {
  if (
    (scope === "world" || scope === "layered") &&
    (typeof worldId !== "string" || worldId.length === 0)
  ) {
    throw new Error("world id is required");
  }
  if (worldId !== undefined && (typeof worldId !== "string" || worldId.length > 128)) {
    throw new Error("world id is invalid");
  }
}

function sameScope(record: ScopedMemoryRecord, scope: MemoryContextScope): boolean {
  switch (scope.mode) {
    case "global":
      return record.scope === "global";
    case "world":
      return record.scope === "world" && record.worldId === scope.worldId;
    case "layered":
      return (
        record.scope === "global" || (record.scope === "world" && record.worldId === scope.worldId)
      );
  }
}

export class ScopedMemoryStore {
  readonly #documents: DocumentStore<ScopedMemoryDocument>;
  readonly #validator: MemoryStore;
  readonly #clock: () => Date;

  constructor(path: string, options: { clock?: () => Date } = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#validator = new MemoryStore(path);
    this.#documents = new DocumentStore({
      path,
      rootDirectory: dirname(path),
      schemaVersion: 1,
      valueSchema: documentSchema,
      defaultValue: () => ({ records: [], legacyMigrated: false }),
      clock: this.#clock,
    });
  }

  private timestamp(): string {
    return this.#clock().toISOString();
  }

  private toExport(envelope: DocumentEnvelope<ScopedMemoryDocument>): ScopedMemoryExport {
    return {
      schemaVersion: 1,
      revision: envelope.revision,
      updatedAt: envelope.updatedAt,
      records: clone(envelope.value.records),
      legacyMigrated: envelope.value.legacyMigrated,
    };
  }

  private validate(
    input: ScopedMemoryInput | ScopedMemoryPatch,
    source: MemoryValidationSource = {},
  ): void {
    const scope = input.scope;
    if (scope !== undefined && scope !== "global" && scope !== "world") {
      throw new Error("memory record is invalid");
    }
    if (scope !== undefined) assertWorldId(scope, input.worldId);
    if ("summary" in input || "category" in input || "importance" in input) {
      if (
        input.category !== undefined &&
        input.summary !== undefined &&
        input.importance !== undefined
      ) {
        this.#validator.validateCandidate(
          { category: input.category, summary: input.summary, importance: input.importance },
          source,
        );
      }
    }
  }

  async add(
    input: ScopedMemoryInput,
    source: MemoryValidationSource = {},
  ): Promise<ScopedMemoryRecord> {
    const before = await this.#documents.read();
    return (await this.addAtRevision(before.revision, input, source)).record!;
  }

  async addAtRevision(
    expectedDocumentRevision: number,
    input: ScopedMemoryInput,
    source: MemoryValidationSource = {},
  ): Promise<ScopedMemoryMutation> {
    this.validate(input, source);
    const createdAt = this.timestamp();
    const sourceKind = input.source ?? "manual";
    let created: ScopedMemoryRecord | undefined;
    const envelope = await this.#documents.update(expectedDocumentRevision, (current) => {
      this.validate(input, source);
      const id = current.records.reduce((largest, record) => Math.max(largest, record.id), 0) + 1;
      created = {
        id,
        category: input.category,
        summary: input.summary,
        importance: input.importance,
        createdAt,
        updatedAt: createdAt,
        scope: input.scope,
        ...(input.scope === "world" ? { worldId: input.worldId } : {}),
        source: sourceKind,
        pinned: false,
        revision: 0,
      };
      return { ...current, records: [...current.records, created!] };
    });
    return { envelope: this.toExport(envelope), record: clone(created!) };
  }

  validateCandidate(input: NewMemory, source: MemoryValidationSource = {}): void {
    this.#validator.validateCandidate(input, source);
  }

  /** Compatibility path for model-proposed memories; automatic records always start global and unpinned. */
  async addBatch(
    inputs: NewMemory[],
    canCommit: () => boolean,
    source: MemoryValidationSource = {},
  ): Promise<ScopedMemoryRecord[]> {
    for (const input of inputs) this.validateCandidate(input, source);
    if (!canCommit()) return [];
    const before = await this.#documents.read();
    const createdAt = this.timestamp();
    let created: ScopedMemoryRecord[] = [];
    try {
      await this.#documents.update(before.revision, (current) => {
        if (!canCommit()) throw new MemoryBatchCancelled();
        let id = current.records.reduce((largest, record) => Math.max(largest, record.id), 0) + 1;
        created = inputs.map((input) => ({
          id: id++,
          ...input,
          createdAt,
          updatedAt: createdAt,
          scope: "global" as const,
          source: "automatic" as const,
          pinned: false,
          revision: 0,
        }));
        for (const record of created) this.#validator.validateCandidate(record, source);
        if (!canCommit()) throw new MemoryBatchCancelled();
        return { ...current, records: [...current.records, ...created] };
      });
      return clone(created);
    } catch (error) {
      if (error instanceof MemoryBatchCancelled) return [];
      throw error;
    }
  }

  async update(
    id: number,
    expectedRevision: number,
    patch: ScopedMemoryPatch,
    source: MemoryValidationSource = {},
  ): Promise<ScopedMemoryRecord> {
    const before = await this.#documents.read();
    return (await this.updateAtRevision(before.revision, id, expectedRevision, patch, source))
      .record!;
  }

  async updateAtRevision(
    expectedDocumentRevision: number,
    id: number,
    expectedRevision: number,
    patch: ScopedMemoryPatch,
    source: MemoryValidationSource = {},
  ): Promise<ScopedMemoryMutation> {
    let updated: ScopedMemoryRecord | undefined;
    const envelope = await this.#documents.update(expectedDocumentRevision, (current) => {
      const index = current.records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error("memory not found");
      const existing = current.records[index]!;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== existing.revision) {
        throw new DocumentStoreError("DOCUMENT_CONFLICT", "memory revision conflict");
      }
      const scope = patch.scope ?? existing.scope;
      const worldId = patch.scope === "global" ? undefined : (patch.worldId ?? existing.worldId);
      const { worldId: _previousWorldId, ...withoutWorldId } = existing;
      const candidate: ScopedMemoryRecord = {
        ...withoutWorldId,
        ...(patch.category === undefined ? {} : { category: patch.category }),
        ...(patch.summary === undefined ? {} : { summary: patch.summary }),
        ...(patch.importance === undefined ? {} : { importance: patch.importance }),
        scope,
        ...(worldId === undefined ? {} : { worldId }),
      };
      this.validate(candidate, source);
      this.#validator.validateCandidate(candidate, source);
      updated = { ...candidate, updatedAt: this.timestamp(), revision: existing.revision + 1 };
      const records = [...current.records];
      records[index] = updated;
      return { ...current, records };
    });
    return { envelope: this.toExport(envelope), record: clone(updated!) };
  }

  async forget(id: number, expectedRevision?: number): Promise<boolean> {
    const before = await this.#documents.read();
    return (
      (await this.forgetAtRevision(before.revision, id, expectedRevision)).record !== undefined
    );
  }

  async forgetAtRevision(
    expectedDocumentRevision: number,
    id: number,
    expectedRevision?: number,
  ): Promise<ScopedMemoryMutation> {
    let forgotten = false;
    let removed: ScopedMemoryRecord | undefined;
    const envelope = await this.#documents.update(expectedDocumentRevision, (current) => {
      const record = current.records.find((item) => item.id === id);
      if (!record) return current;
      if (
        expectedRevision !== undefined &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision !== record.revision)
      ) {
        throw new DocumentStoreError("DOCUMENT_CONFLICT", "memory revision conflict");
      }
      forgotten = true;
      removed = record;
      return { ...current, records: current.records.filter((item) => item.id !== id) };
    });
    return {
      envelope: this.toExport(envelope),
      ...(forgotten && removed !== undefined ? { record: clone(removed) } : {}),
    };
  }

  async pin(id: number, expectedRevision: number, pinned: boolean): Promise<ScopedMemoryRecord> {
    const before = await this.#documents.read();
    return (await this.pinAtRevision(before.revision, id, expectedRevision, pinned)).record!;
  }

  async pinAtRevision(
    expectedDocumentRevision: number,
    id: number,
    expectedRevision: number,
    pinned: boolean,
  ): Promise<ScopedMemoryMutation> {
    let updated: ScopedMemoryRecord | undefined;
    const envelope = await this.#documents.update(expectedDocumentRevision, (current) => {
      const index = current.records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error("memory not found");
      const existing = current.records[index]!;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== existing.revision) {
        throw new DocumentStoreError("DOCUMENT_CONFLICT", "memory revision conflict");
      }
      if (pinned && existing.source === "automatic")
        throw new Error("automatic memory cannot be pinned");
      updated = {
        ...existing,
        pinned,
        revision: existing.revision + 1,
        updatedAt: this.timestamp(),
      };
      const records = [...current.records];
      records[index] = updated;
      return { ...current, records };
    });
    return { envelope: this.toExport(envelope), record: clone(updated!) };
  }

  async search(
    query: string,
    scope: MemoryContextScope = { mode: "global" },
  ): Promise<ScopedMemoryRecord[]> {
    const needle = query.toLocaleLowerCase();
    return (await this.listForContext(scope)).filter((record) =>
      record.summary.toLocaleLowerCase().includes(needle),
    );
  }

  async searchExport(
    query: string,
    scope: MemoryContextScope = { mode: "global" },
  ): Promise<ScopedMemoryExport> {
    assertWorldId(scope.mode, scope.worldId);
    const needle = query.toLocaleLowerCase();
    const current = await this.#documents.read();
    return {
      ...this.toExport(current),
      records: current.value.records
        .filter((record) => sameScope(record, scope))
        .filter((record) => record.summary.toLocaleLowerCase().includes(needle))
        .sort(compareMemoryOrder)
        .map(clone),
    };
  }

  async listForContext(scope: MemoryContextScope): Promise<ScopedMemoryRecord[]> {
    assertWorldId(scope.mode, scope.worldId);
    const current = await this.#documents.read();
    return current.value.records
      .filter((record) => sameScope(record, scope))
      .sort(compareMemoryOrder)
      .map(clone);
  }

  list(): Promise<ScopedMemoryRecord[]> {
    return this.listForContext({ mode: "global" });
  }

  async clear(): Promise<void> {
    const before = await this.#documents.read();
    await this.#documents.update(before.revision, (current) => ({ ...current, records: [] }));
  }

  async export(): Promise<ScopedMemoryExport> {
    const current = await this.#documents.read();
    return this.toExport(current);
  }

  async replaceForMigration(
    expectedDocumentRevision: number,
    records: ScopedMemoryRecord[],
    legacyMigrated?: boolean,
  ): Promise<ScopedMemoryExport> {
    for (const record of records) {
      this.validate(record);
      this.#validator.validateCandidate(record);
    }
    const envelope = await this.#documents.update(expectedDocumentRevision, (current) => ({
      records: clone(records),
      legacyMigrated: legacyMigrated ?? current.legacyMigrated,
    }));
    return this.toExport(envelope);
  }
}
