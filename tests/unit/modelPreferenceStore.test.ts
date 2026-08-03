import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelPreferenceStore } from "../../src/codex/modelPreferenceStore.js";

const cleanups: Array<() => Promise<void>> = [];

async function fixture() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-model-preference-"));
  cleanups.push(() => rm(rootDirectory, { recursive: true, force: true }));
  return {
    rootDirectory,
    store: new ModelPreferenceStore({
      rootDirectory,
      clock: () => new Date("2026-08-03T01:02:03.004Z"),
    }),
  };
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("ModelPreferenceStore", () => {
  it("returns the automatic unmigrated default on the first read", async () => {
    const { store } = await fixture();

    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-08-03T01:02:03.004Z",
      value: { selection: { mode: "automatic" }, legacyMigrationCompleted: false },
    });
  });

  it("prefers a valid legacy UI selection over the legacy config selection", async () => {
    const { store } = await fixture();
    const first = await store.read();

    const migrated = await store.migrateLegacyOnce(first.revision, {
      ui: { mode: "explicit", modelId: "gpt-5.5", reasoningEffort: "low" },
      config: { mode: "explicit", modelId: "gpt-5.4", reasoningEffort: "medium" },
      validate: async (candidate) => candidate.modelId === "gpt-5.5",
    });

    expect(migrated).toMatchObject({
      revision: 1,
      value: {
        selection: { mode: "explicit", modelId: "gpt-5.5", reasoningEffort: "low" },
        legacyMigrationCompleted: true,
      },
    });
  });

  it("falls back from an invalid legacy UI selection to a valid legacy config selection", async () => {
    const { store } = await fixture();
    const first = await store.read();

    const migrated = await store.migrateLegacyOnce(first.revision, {
      ui: { mode: "explicit", modelId: "gpt-5.5", reasoningEffort: "low" },
      config: { mode: "explicit", modelId: "gpt-5.4", reasoningEffort: "medium" },
      validate: async (candidate) => candidate.modelId === "gpt-5.4",
    });

    expect(migrated.value.selection).toEqual({
      mode: "explicit",
      modelId: "gpt-5.4",
      reasoningEffort: "medium",
    });
  });

  it("uses automatic selection when neither legacy candidate is valid", async () => {
    const { store } = await fixture();
    const first = await store.read();

    const migrated = await store.migrateLegacyOnce(first.revision, {
      ui: { mode: "explicit", modelId: "gpt-5.5", reasoningEffort: "low" },
      config: { mode: "explicit", modelId: "gpt-5.4", reasoningEffort: "medium" },
      validate: async () => false,
    });

    expect(migrated.value).toEqual({
      selection: { mode: "automatic" },
      legacyMigrationCompleted: true,
    });
  });

  it("runs legacy migration once, rejects stale revisions, and persists across store instances", async () => {
    const { rootDirectory, store } = await fixture();
    const first = await store.read();
    const migrated = await store.migrateLegacyOnce(first.revision, {
      ui: { mode: "explicit", modelId: "gpt-5.5", reasoningEffort: "low" },
      validate: async () => true,
    });

    await expect(
      store.migrateLegacyOnce(migrated.revision, {
        config: { mode: "explicit", modelId: "gpt-5.4", reasoningEffort: "medium" },
        validate: async () => true,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });
    await expect(
      store.replace(first.revision, {
        selection: { mode: "automatic" },
        legacyMigrationCompleted: true,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });

    const rebuilt = new ModelPreferenceStore({ rootDirectory });
    await expect(rebuilt.read()).resolves.toMatchObject({
      revision: 1,
      value: {
        selection: { mode: "explicit", modelId: "gpt-5.5", reasoningEffort: "low" },
        legacyMigrationCompleted: true,
      },
    });
  });
});
