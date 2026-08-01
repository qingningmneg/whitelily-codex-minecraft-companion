import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryMigration } from "../../src/memory/memoryMigration.js";
import { summariesDeduplicate } from "../../src/memory/memoryDeduplication.js";
import { MemoryStore } from "../../src/memory/memoryStore.js";
import { ScopedMemoryStore } from "../../src/memory/scopedMemoryStore.js";

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "whitelily-memory-migration-"));
}

describe("MemoryMigration", () => {
  it.each([
    [
      "the player prefers building oak bridges near spawn",
      "the player prefers building oak bridges close to spawn",
      true,
    ],
    [
      "the player prefers building oak bridges near spawn",
      "the player prefers exploring desert temples at night",
      false,
    ],
  ])("uses a 0.85 trigram-overlap boundary for long summaries", (left, right, expected) => {
    expect(summariesDeduplicate(left, right)).toBe(expected);
  });

  it("normalizes locale-sensitive Latin I without consulting host locale rules", () => {
    const localeLower = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(() => {
      throw new Error("host locale consulted");
    });
    try {
      expect(summariesDeduplicate("ISTANBUL BUILD PROJECT", "istanbul build project")).toBe(true);
    } finally {
      localeLower.mockRestore();
    }
  });

  it("previews an immutable deterministic deduplicated snapshot without changing the source", async () => {
    const root = await directory();
    const source = new ScopedMemoryStore(join(root, "source.json"));
    const target = new ScopedMemoryStore(join(root, "target.json"));
    const first = await source.add({
      category: "project",
      summary: "Build the Oak Bridge!",
      importance: 3,
      scope: "global",
    });
    await source.add({
      category: "project",
      summary: "build the oak bridge",
      importance: 5,
      scope: "global",
    });
    await source.pin(first.id, first.revision, true);
    const migration = new MemoryMigration(source, target);
    const before = await source.export();
    const preview = await migration.preview({
      id: "world-a-import",
      scope: "world",
      worldId: "world-a",
    });

    expect(preview.id).toBe("world-a-import");
    expect(preview.sourceRevision).toBe(before.revision);
    expect(preview.deduplicatedCount).toBe(1);
    expect(preview.movedCount).toBe(1);
    expect(preview.records).toEqual([
      expect.objectContaining({ id: first.id, pinned: true, scope: "world", worldId: "world-a" }),
    ]);
    preview.records[0]!.summary = "caller mutation";
    await expect(source.export()).resolves.toEqual(before);
  });

  it("commits a preview, retains its snapshot, and rolls target state back exactly", async () => {
    const root = await directory();
    const source = new ScopedMemoryStore(join(root, "source.json"));
    const target = new ScopedMemoryStore(join(root, "target.json"));
    await source.add({
      category: "experience",
      summary: "explored a safe cave",
      importance: 3,
      scope: "global",
    });
    const original = await target.export();
    const migration = new MemoryMigration(source, target);
    const preview = await migration.preview({ id: "copy-global", scope: "global" });

    await migration.commit(preview);
    await expect(target.listForContext({ mode: "global" })).resolves.toHaveLength(1);
    await migration.rollback("copy-global");
    await expect(target.export()).resolves.toMatchObject({
      records: original.records,
      legacyMigrated: original.legacyMigrated,
    });
  });

  it("restores target with a higher revision after a post-write acknowledgement failure", async () => {
    const root = await directory();
    const source = new ScopedMemoryStore(join(root, "source.json"));
    const target = new ScopedMemoryStore(join(root, "target.json"));
    await source.add({
      category: "experience",
      summary: "safe cave result",
      importance: 3,
      scope: "global",
    });
    const original = await target.export();
    const migration = new MemoryMigration(source, target, {
      afterTargetWrite: async () => {
        throw new Error("injected acknowledgement failure");
      },
    });
    const preview = await migration.preview({ id: "fails-atomically", scope: "global" });

    await expect(migration.commit(preview)).rejects.toThrow("injected acknowledgement failure");
    await expect(target.export()).resolves.toMatchObject({
      records: original.records,
      legacyMigrated: original.legacyMigrated,
      revision: 2,
    });
    await expect(migration.rollback("fails-atomically")).rejects.toThrow(
      "migration snapshot is unavailable",
    );
  });

  it("does not restore a target after a competitor replaces the post-write revision", async () => {
    const root = await directory();
    const source = new ScopedMemoryStore(join(root, "source.json"));
    const target = new ScopedMemoryStore(join(root, "target.json"));
    await source.add({
      category: "experience",
      summary: "safe cave result",
      importance: 3,
      scope: "global",
    });
    const migration = new MemoryMigration(source, target, {
      afterTargetWrite: async (committed) => {
        const migrated = (await target.export()).records[0]!;
        await target.replaceForMigration(committed.revision, [
          { ...migrated, summary: "competitor winner" },
        ]);
        throw new Error("injected write failure");
      },
    });
    const preview = await migration.preview({ id: "competitor-wins", scope: "global" });

    await expect(migration.commit(preview)).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });
    await expect(target.export()).resolves.toMatchObject({
      records: [expect.objectContaining({ summary: "competitor winner" })],
      revision: 2,
    });
    await expect(migration.rollback("competitor-wins")).rejects.toThrow(
      "migration snapshot is unavailable",
    );
  });

  it("preserves a concurrent target winner when migration CAS is stale", async () => {
    const root = await directory();
    const source = new ScopedMemoryStore(join(root, "source.json"));
    const target = new ScopedMemoryStore(join(root, "target.json"));
    await source.add({
      category: "project",
      summary: "migration source",
      importance: 3,
      scope: "global",
    });
    const migration = new MemoryMigration(source, target, {
      beforeCommit: async () => {
        await target.add({
          category: "project",
          summary: "concurrent winner",
          importance: 5,
          scope: "global",
        });
      },
    });
    const preview = await migration.preview({ id: "conflict-safe", scope: "global" });

    await expect(migration.commit(preview)).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });
    await expect(target.listForContext({ mode: "global" })).resolves.toEqual([
      expect.objectContaining({ summary: "concurrent winner" }),
    ]);
  });

  it("rejects duplicate migration IDs and repeated rollback", async () => {
    const root = await directory();
    const source = new ScopedMemoryStore(join(root, "source.json"));
    const target = new ScopedMemoryStore(join(root, "target.json"));
    await source.add({
      category: "project",
      summary: "single migration",
      importance: 3,
      scope: "global",
    });
    const migration = new MemoryMigration(source, target);
    const preview = await migration.preview({ id: "single-use", scope: "global" });
    await migration.commit(preview);

    await expect(migration.commit(preview)).rejects.toThrow("migration id is already committed");
    await migration.rollback("single-use");
    await expect(migration.rollback("single-use")).rejects.toThrow(
      "migration has already rolled back",
    );
  });

  it("imports legacy memory once while preserving legacy identifiers", async () => {
    const root = await directory();
    const legacy = new MemoryStore(join(root, "legacy.json"));
    const first = await legacy.add({ category: "place", summary: "spawn point", importance: 4 });
    const second = await legacy.add({ category: "project", summary: "oak tower", importance: 3 });
    const scoped = new ScopedMemoryStore(join(root, "scoped.json"));
    const migration = new MemoryMigration(undefined, scoped, { legacy });

    await expect(migration.migrateLegacyOnce()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, summary: "spawn point" }),
        expect.objectContaining({ id: second.id, summary: "oak tower" }),
      ]),
    );
    await expect(migration.migrateLegacyOnce()).resolves.toEqual([]);
    await expect(scoped.listForContext({ mode: "global" })).resolves.toHaveLength(2);
  });

  it("makes concurrent legacy migration callers successful no-ops after one import", async () => {
    const root = await directory();
    const legacy = new MemoryStore(join(root, "legacy.json"));
    const saved = await legacy.add({ category: "place", summary: "shared spawn", importance: 4 });
    const scoped = new ScopedMemoryStore(join(root, "scoped.json"));
    const migration = new MemoryMigration(undefined, scoped, { legacy });

    const [first, second] = await Promise.all([
      migration.migrateLegacyOnce(),
      migration.migrateLegacyOnce(),
    ]);

    expect([first, second].flat()).toEqual([expect.objectContaining({ id: saved.id })]);
    await expect(scoped.export()).resolves.toMatchObject({
      legacyMigrated: true,
      records: [expect.objectContaining({ id: saved.id, summary: "shared spawn" })],
    });
  });
});
