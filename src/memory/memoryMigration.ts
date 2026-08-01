import type { MemoryStore } from "./memoryStore.js";
import { DocumentStoreError } from "../storage/documentStore.js";
import { deduplicateMemories } from "./memoryDeduplication.js";
import {
  type ScopedMemoryExport,
  type ScopedMemoryRecord,
  type StoredMemoryScope,
  ScopedMemoryStore,
} from "./scopedMemoryStore.js";

export interface MemoryMigrationPreviewRequest {
  id: string;
  scope: StoredMemoryScope;
  worldId?: string | undefined;
}

export interface MemoryMigrationPreview {
  id: string;
  sourceRevision: number;
  deduplicatedCount: number;
  movedCount: number;
  records: ScopedMemoryRecord[];
}

interface SuccessfulMigration {
  targetBefore: ScopedMemoryExport;
  targetAfterRevision: number;
  rolledBack: boolean;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertTargetScope(request: MemoryMigrationPreviewRequest): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(request.id)) throw new Error("migration id is invalid");
  if (
    request.scope === "world" &&
    (typeof request.worldId !== "string" || request.worldId.length === 0)
  ) {
    throw new Error("world id is required");
  }
}

export class MemoryMigration {
  readonly #successful = new Map<string, SuccessfulMigration>();

  constructor(
    private readonly source: ScopedMemoryStore | undefined,
    private readonly target: ScopedMemoryStore,
    private readonly options: {
      legacy?: MemoryStore;
      beforeCommit?: () => Promise<void>;
      afterTargetWrite?: (target: ScopedMemoryExport) => Promise<void>;
    } = {},
  ) {}

  async preview(request: MemoryMigrationPreviewRequest): Promise<MemoryMigrationPreview> {
    if (!this.source) throw new Error("migration source is unavailable");
    assertTargetScope(request);
    const source = await this.source.export();
    const deduplicated = deduplicateMemories(source.records);
    const movedCount = deduplicated.filter(
      (record) =>
        record.scope !== request.scope ||
        (request.scope === "world" && record.worldId !== request.worldId),
    ).length;
    const records = deduplicated.map((record) => ({
      ...record,
      scope: request.scope,
      ...(request.scope === "world" ? { worldId: request.worldId } : {}),
      ...(request.scope === "global" ? { worldId: undefined } : {}),
    }));
    return clone({
      id: request.id,
      sourceRevision: source.revision,
      deduplicatedCount: source.records.length - records.length,
      movedCount,
      records,
    });
  }

  async commit(preview: MemoryMigrationPreview): Promise<void> {
    if (!this.source) throw new Error("migration source is unavailable");
    if (this.#successful.has(preview.id)) throw new Error("migration id is already committed");
    const source = await this.source.export();
    if (source.revision !== preview.sourceRevision)
      throw new DocumentStoreError("DOCUMENT_CONFLICT", "migration source revision conflict");
    const targetBefore = await this.target.export();
    await this.options.beforeCommit?.();
    const targetAfter = await this.target.replaceForMigration(
      targetBefore.revision,
      clone(preview.records),
    );
    try {
      await this.options.afterTargetWrite?.(clone(targetAfter));
    } catch (error) {
      await this.#restoreAfterPostWriteFailure(targetBefore, targetAfter);
      throw error;
    }
    this.#successful.set(preview.id, {
      targetBefore: clone(targetBefore),
      targetAfterRevision: targetAfter.revision,
      rolledBack: false,
    });
  }

  async rollback(id: string): Promise<void> {
    const successful = this.#successful.get(id);
    if (!successful) throw new Error("migration snapshot is unavailable");
    if (successful.rolledBack) throw new Error("migration has already rolled back");
    const target = await this.target.export();
    if (target.revision !== successful.targetAfterRevision) {
      throw new DocumentStoreError("DOCUMENT_CONFLICT", "migration target revision conflict");
    }
    await this.target.replaceForMigration(
      successful.targetAfterRevision,
      successful.targetBefore.records,
      successful.targetBefore.legacyMigrated,
    );
    successful.rolledBack = true;
  }

  release(id: string): void {
    this.#successful.delete(id);
  }

  async #restoreAfterPostWriteFailure(
    targetBefore: ScopedMemoryExport,
    targetAfter: ScopedMemoryExport,
  ): Promise<void> {
    const current = await this.target.export();
    if (current.revision !== targetAfter.revision) {
      throw new DocumentStoreError("DOCUMENT_CONFLICT", "migration target revision conflict");
    }
    await this.target.replaceForMigration(
      targetAfter.revision,
      targetBefore.records,
      targetBefore.legacyMigrated,
    );
  }

  async migrateLegacyOnce(): Promise<ScopedMemoryRecord[]> {
    if (!this.options.legacy) throw new Error("legacy memory source is unavailable");
    const target = await this.target.export();
    if (target.legacyMigrated) return [];
    const legacy = await this.options.legacy.list();
    const records: ScopedMemoryRecord[] = legacy.map((record) => ({
      ...record,
      scope: "global",
      source: "automatic",
      pinned: false,
      revision: 0,
      updatedAt: record.createdAt,
    }));
    try {
      await this.target.replaceForMigration(target.revision, records, true);
      return clone(records);
    } catch (error) {
      if (!(error instanceof DocumentStoreError) || error.code !== "DOCUMENT_CONFLICT") throw error;
      const latest = await this.target.export();
      if (latest.legacyMigrated) return [];
      throw error;
    }
  }
}
