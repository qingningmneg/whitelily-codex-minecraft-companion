import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScopedMemoryStore } from "../../src/memory/scopedMemoryStore.js";

async function memoryPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "whitelily-scoped-memory-")), "scoped.json");
}

describe("ScopedMemoryStore", () => {
  it("selects global, world, and layered context with deterministic pinned ordering", async () => {
    const store = new ScopedMemoryStore(await memoryPath(), {
      clock: (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 6, 29, 0, 0, tick++));
      })(),
    });
    const global = await store.add({
      category: "preference",
      summary: "global home preference",
      importance: 5,
      scope: "global",
    });
    const firstWorld = await store.add({
      category: "place",
      summary: "first mine entrance",
      importance: 3,
      scope: "world",
      worldId: "world-a",
    });
    const secondWorld = await store.add({
      category: "project",
      summary: "world a bridge project",
      importance: 4,
      scope: "world",
      worldId: "world-a",
    });
    await store.pin(firstWorld.id, firstWorld.revision, true);
    await store.add({
      category: "experience",
      summary: "world b exploration",
      importance: 5,
      scope: "world",
      worldId: "world-b",
    });

    await expect(store.listForContext({ mode: "global" })).resolves.toEqual([global]);
    await expect(store.listForContext({ mode: "world", worldId: "world-a" })).resolves.toEqual([
      expect.objectContaining({ id: firstWorld.id, pinned: true }),
      secondWorld,
    ]);
    await expect(store.listForContext({ mode: "layered", worldId: "world-a" })).resolves.toEqual([
      expect.objectContaining({ id: firstWorld.id, pinned: true }),
      global,
      secondWorld,
    ]);
  });

  it("supports manual add, edit, delete, pin, and case-insensitive search", async () => {
    const store = new ScopedMemoryStore(await memoryPath());
    const created = await store.add({
      category: "project",
      summary: "Build an oak tower",
      importance: 3,
      scope: "global",
    });
    const edited = await store.update(created.id, created.revision, {
      summary: "Build an oak watchtower",
      importance: 4,
    });
    const pinned = await store.pin(edited.id, edited.revision, true);

    await expect(store.search("WATCH", { mode: "global" })).resolves.toEqual([pinned]);
    await expect(store.forget(pinned.id, pinned.revision)).resolves.toBe(true);
    await expect(store.search("watch", { mode: "global" })).resolves.toEqual([]);
  });

  it("edits scope in both directions and requires a new world ID when entering world scope", async () => {
    const store = new ScopedMemoryStore(await memoryPath());
    const world = await store.add({
      category: "place",
      summary: "world-only base",
      importance: 4,
      scope: "world",
      worldId: "world-a",
    });
    const global = await store.update(world.id, world.revision, { scope: "global" });
    expect(global).toMatchObject({ scope: "global" });
    expect("worldId" in global).toBe(false);

    await expect(store.update(global.id, global.revision, { scope: "world" })).rejects.toThrow(
      "world id is required",
    );
    await expect(
      store.update(global.id, global.revision, { scope: "world", worldId: "world-b" }),
    ).resolves.toMatchObject({ scope: "world", worldId: "world-b" });
  });

  it("rejects a renderer mutation whose observed document revision is stale", async () => {
    const store = new ScopedMemoryStore(await memoryPath());
    const observed = await store.export();
    await store.addAtRevision(observed.revision, {
      category: "project",
      summary: "first renderer write",
      importance: 3,
      scope: "global",
    });

    await expect(
      store.addAtRevision(observed.revision, {
        category: "project",
        summary: "stale renderer write",
        importance: 3,
        scope: "global",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });
    await expect(store.listForContext({ mode: "global" })).resolves.toEqual([
      expect.objectContaining({ summary: "first renderer write" }),
    ]);
  });

  it("preserves sensitive-data validation and rejects pinning automatic memory", async () => {
    const store = new ScopedMemoryStore(await memoryPath());
    await expect(
      store.add({
        category: "preference",
        summary: "token=abcdefghijklmnopqrstuvwxyz.123456",
        importance: 5,
        scope: "global",
      }),
    ).rejects.toThrow("memory contains a credential or sensitive personal datum");

    const automatic = await store.add({
      category: "experience",
      summary: "completed safe exploration",
      importance: 3,
      scope: "global",
      source: "automatic",
    });
    await expect(store.pin(automatic.id, automatic.revision, true)).rejects.toThrow(
      "automatic memory cannot be pinned",
    );
  });

  it("rejects missing world IDs and stale record revisions", async () => {
    const store = new ScopedMemoryStore(await memoryPath());
    await expect(
      store.add({
        category: "place",
        summary: "spawn point",
        importance: 4,
        scope: "world",
      }),
    ).rejects.toThrow("world id is required");
    await expect(store.listForContext({ mode: "world" })).rejects.toThrow("world id is required");

    const created = await store.add({
      category: "promise",
      summary: "bring oak logs next time",
      importance: 4,
      scope: "global",
    });
    await store.update(created.id, created.revision, { importance: 5 });
    await expect(store.forget(created.id, created.revision)).rejects.toThrow(
      "memory revision conflict",
    );
  });

  it("deep-clones every returned record and export", async () => {
    const store = new ScopedMemoryStore(await memoryPath());
    const created = await store.add({
      category: "preference",
      summary: "likes oak wood",
      importance: 4,
      scope: "global",
    });
    created.summary = "mutated caller value";
    const listed = await store.listForContext({ mode: "global" });
    listed[0]!.summary = "mutated list value";
    const exported = await store.export();
    exported.records[0]!.summary = "mutated export value";

    await expect(store.listForContext({ mode: "global" })).resolves.toEqual([
      expect.objectContaining({ summary: "likes oak wood" }),
    ]);
  });
});
