import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSnapshot } from "../../src/codex/accountService.js";
import type { Model } from "../../src/codex/generated/v2/Model.js";
import { ModelPreferenceStore } from "../../src/codex/modelPreferenceStore.js";
import {
  ModelCatalog,
  type ModelCatalogAccountPort,
  type ModelCatalogAppServerPort,
  type ModelCatalogEvent,
} from "../../src/codex/modelCatalog.js";

const cleanups: Array<() => Promise<void>> = [];

async function preferenceStore(): Promise<ModelPreferenceStore> {
  const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-model-catalog-"));
  cleanups.push(() => rm(rootDirectory, { recursive: true, force: true }));
  return new ModelPreferenceStore({ rootDirectory });
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

function model(
  id: string,
  displayName: string,
  efforts: readonly string[],
  overrides: Partial<Model> = {},
): Model {
  return {
    id: `service-record-${id}`,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName,
    description: "Live service model",
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: `${reasoningEffort} from service`,
    })),
    defaultReasoningEffort: efforts[0] ?? "",
    inputModalities: ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
    ...overrides,
  };
}

function signedInAccount(): ModelCatalogAccountPort & {
  set(snapshot: AccountSnapshot): void;
} {
  let snapshot: AccountSnapshot = { status: "signed_in", auth: "chatgpt" };
  const listeners = new Set<(next: AccountSnapshot) => void>();
  return {
    getAccount: async () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      snapshot = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function gate(): { promise: Promise<void>; release(): void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("ModelCatalog", () => {
  it("preserves live order while safely deduplicating model IDs and efforts", async () => {
    const account = signedInAccount();
    const appServer: ModelCatalogAppServerPort = {
      listModelRecords: vi.fn(async () => [
        model("gpt-live-z", "Exact Z label", ["high", "low", "high"]),
        model("gpt-live-a", "Exact A label", ["medium"]),
        model("gpt-live-z", "Duplicate must not replace first", ["minimal"]),
      ]),
    };
    const catalog = new ModelCatalog(appServer, account);

    await expect(catalog.listModels()).resolves.toEqual({
      models: [
        {
          id: "gpt-live-z",
          displayName: "Exact Z label",
          supportedReasoningEfforts: ["high", "low"],
        },
        {
          id: "gpt-live-a",
          displayName: "Exact A label",
          supportedReasoningEfforts: ["medium"],
        },
      ],
      selection: { mode: "automatic" },
      legacyMigrationCompleted: false,
    });
  });

  it("returns only validated visible service records without inferred names or efforts", async () => {
    const account = signedInAccount();
    const appServer: ModelCatalogAppServerPort = {
      listModelRecords: async () => [
        model("service-model", "Service-provided label", ["xhigh"]),
        model("hidden-model", "Hidden", ["low"], { hidden: true }),
        model("../unsafe", "Unsafe ID", ["low"]),
        model("valid-id", "Bad\u0000Label", ["low"]),
        model("valid-effort", "Valid", ["bad effort"]),
      ],
    };
    const catalog = new ModelCatalog(appServer, account);

    const result = await catalog.listModels();

    expect(result.models).toEqual([
      {
        id: "service-model",
        displayName: "Service-provided label",
        supportedReasoningEfforts: ["xhigh"],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("ChatGPT");
  });

  it("accepts exact public string limits and rejects malformed or over-limit strings", async () => {
    const account = signedInAccount();
    const exactModelId = `m${"a".repeat(127)}`;
    const exactEffort = `e${"b".repeat(63)}`;
    const exactLabel = "😀".repeat(160);
    const catalog = new ModelCatalog(
      {
        listModelRecords: async () => [
          model(exactModelId, exactLabel, [exactEffort]),
          model(`m${"a".repeat(128)}`, "Overlong model", ["low"]),
          model("overlong-effort", "Overlong effort", [`e${"b".repeat(64)}`]),
          model("overlong-label", "x".repeat(161), ["low"]),
          model("malformed-label", "bad\ud800label", ["low"]),
        ],
      },
      account,
    );

    await expect(catalog.listModels()).resolves.toEqual({
      models: [
        {
          id: exactModelId,
          displayName: exactLabel,
          supportedReasoningEfforts: [exactEffort],
        },
      ],
      selection: { mode: "automatic" },
      legacyMigrationCompleted: false,
    });
  });

  it("caps live models and efforts while preserving the first service values", async () => {
    const account = signedInAccount();
    const records = Array.from({ length: 257 }, (_, index) =>
      model(
        `live-${String(index).padStart(3, "0")}`,
        `Live ${index}`,
        index === 0
          ? Array.from({ length: 33 }, (__, effort) => `effort_${String(effort).padStart(2, "0")}`)
          : ["medium"],
      ),
    );
    const catalog = new ModelCatalog({ listModelRecords: async () => records }, account);

    const snapshot = await catalog.listModels();

    expect(snapshot.models).toHaveLength(256);
    expect(snapshot.models[0]).toEqual({
      id: "live-000",
      displayName: "Live 0",
      supportedReasoningEfforts: Array.from(
        { length: 32 },
        (_, effort) => `effort_${String(effort).padStart(2, "0")}`,
      ),
    });
    expect(snapshot.models.at(-1)?.id).toBe("live-255");
  });

  it("emits only selection_changed for an available explicit selection", async () => {
    const account = signedInAccount();
    const store = await preferenceStore();
    const catalog = new ModelCatalog(
      {
        listModelRecords: async () => [model("live-choice", "Live Choice", ["minimal", "medium"])],
      },
      account,
      {
        store,
        legacyConfigCandidate: {
          mode: "explicit",
          modelId: "legacy-config",
          reasoningEffort: "medium",
        },
      },
    );
    const events: ModelCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));

    await expect(
      catalog.selectModel({
        mode: "explicit",
        modelId: "live-choice",
        reasoningEffort: "minimal",
      }),
    ).resolves.toEqual({
      mode: "explicit",
      modelId: "live-choice",
      reasoningEffort: "minimal",
      available: true,
    });
    expect(events).toEqual([
      {
        kind: "selection_changed",
        selection: {
          mode: "explicit",
          modelId: "live-choice",
          reasoningEffort: "minimal",
          available: true,
        },
      },
    ]);
    await expect(store.read()).resolves.toMatchObject({
      revision: 1,
      value: {
        selection: {
          mode: "explicit",
          modelId: "live-choice",
          reasoningEffort: "minimal",
        },
        legacyMigrationCompleted: false,
      },
    });
  });

  it("prepares without side effects and commits exactly once at the captured revision", async () => {
    const account = signedInAccount();
    const store = await preferenceStore();
    const catalog = new ModelCatalog(
      { listModelRecords: async () => [model("live-choice", "Live Choice", ["medium"])] },
      account,
      {
        store,
        legacyConfigCandidate: {
          mode: "explicit",
          modelId: "legacy-config",
          reasoningEffort: "medium",
        },
      },
    );
    const events: ModelCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));

    const prepared = await catalog.prepareSelection({
      mode: "explicit",
      modelId: "live-choice",
      reasoningEffort: "medium",
    });

    expect(prepared).toEqual({
      preferenceRevision: 0,
      requested: {
        mode: "explicit",
        modelId: "live-choice",
        reasoningEffort: "medium",
      },
      resolved: { modelId: "live-choice", reasoningEffort: "medium" },
    });
    await expect(store.read()).resolves.toMatchObject({
      revision: 0,
      value: { selection: { mode: "automatic" } },
    });
    await expect(catalog.listModels()).resolves.toMatchObject({
      selection: { mode: "automatic" },
    });
    expect(events).toEqual([]);

    await expect(catalog.commitSelection(prepared)).resolves.toEqual({
      mode: "explicit",
      modelId: "live-choice",
      reasoningEffort: "medium",
      available: true,
    });
    await expect(store.read()).resolves.toMatchObject({
      revision: 1,
      value: {
        selection: {
          mode: "explicit",
          modelId: "live-choice",
          reasoningEffort: "medium",
        },
      },
    });
    expect(events).toHaveLength(1);

    const duplicate = await catalog.prepareSelection({
      mode: "explicit",
      modelId: "live-choice",
      reasoningEffort: "medium",
    });
    await catalog.commitSelection(duplicate);
    expect(events).toHaveLength(1);
  });

  it("rejects a prepared selection after another writer advances the preference revision", async () => {
    const account = signedInAccount();
    const store = await preferenceStore();
    const catalog = new ModelCatalog(
      { listModelRecords: async () => [model("live-choice", "Live Choice", ["medium"])] },
      account,
      {
        store,
        legacyConfigCandidate: {
          mode: "explicit",
          modelId: "legacy-config",
          reasoningEffort: "medium",
        },
      },
    );
    const prepared = await catalog.prepareSelection({
      mode: "explicit",
      modelId: "live-choice",
      reasoningEffort: "medium",
    });
    await store.replace(0, {
      selection: { mode: "automatic" },
      legacyMigrationCompleted: true,
    });

    await expect(catalog.commitSelection(prepared)).rejects.toMatchObject({
      code: "DOCUMENT_CONFLICT",
    });
    await expect(catalog.listModels()).resolves.toMatchObject({
      selection: { mode: "automatic" },
      legacyMigrationCompleted: true,
    });
  });

  it("migrates the first valid legacy preference once and returns the persisted backend value later", async () => {
    const account = signedInAccount();
    const store = await preferenceStore();
    const catalog = new ModelCatalog(
      {
        listModelRecords: async () => [
          model("legacy-config", "Legacy Config", ["medium"]),
          model("legacy-ui", "Legacy UI", ["high"]),
        ],
      },
      account,
      {
        store,
        legacyConfigCandidate: {
          mode: "explicit",
          modelId: "legacy-config",
          reasoningEffort: "medium",
        },
      },
    );

    await expect(
      catalog.migrateLegacyPreference({
        mode: "explicit",
        modelId: "legacy-ui",
        reasoningEffort: "high",
      }),
    ).resolves.toMatchObject({
      selection: {
        mode: "explicit",
        modelId: "legacy-ui",
        reasoningEffort: "high",
        available: true,
      },
      legacyMigrationCompleted: true,
    });

    await expect(
      catalog.migrateLegacyPreference({
        mode: "explicit",
        modelId: "legacy-config",
        reasoningEffort: "medium",
      }),
    ).resolves.toMatchObject({
      selection: {
        mode: "explicit",
        modelId: "legacy-ui",
        reasoningEffort: "high",
        available: true,
      },
      legacyMigrationCompleted: true,
    });
    await expect(store.read()).resolves.toMatchObject({ revision: 1 });
  });

  it("rejects a model or effort that the current live catalog did not provide", async () => {
    const account = signedInAccount();
    const catalog = new ModelCatalog(
      {
        listModelRecords: async () => [model("live-choice", "Live Choice", ["medium"])],
      },
      account,
    );

    await expect(
      catalog.selectModel({
        mode: "explicit",
        modelId: "invented-model",
        reasoningEffort: "medium",
      }),
    ).rejects.toThrow("Selected model is unavailable");
    await expect(
      catalog.selectModel({
        mode: "explicit",
        modelId: "live-choice",
        reasoningEffort: "invented-effort",
      }),
    ).rejects.toThrow("Selected reasoning effort is unavailable");
  });

  it("emits only model_unavailable when the selected model disappears", async () => {
    const account = signedInAccount();
    let records = [model("temporary", "Temporary", ["low"])];
    const catalog = new ModelCatalog({ listModelRecords: async () => records }, account);
    await catalog.selectModel({
      mode: "explicit",
      modelId: "temporary",
      reasoningEffort: "low",
    });
    const events: ModelCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));

    records = [model("replacement", "Replacement", ["medium"])];

    await expect(catalog.listModels()).resolves.toEqual({
      models: [
        {
          id: "replacement",
          displayName: "Replacement",
          supportedReasoningEfforts: ["medium"],
        },
      ],
      selection: { mode: "automatic" },
      legacyMigrationCompleted: false,
    });
    expect(events).toEqual([{ kind: "selection_invalidated", reason: "model_unavailable" }]);
  });

  it("emits only account_lost when logout removes model authority", async () => {
    const account = signedInAccount();
    const catalog = new ModelCatalog(
      { listModelRecords: async () => [model("live", "Live", ["medium"])] },
      account,
    );
    await catalog.selectModel({ mode: "explicit", modelId: "live", reasoningEffort: "medium" });
    const events: ModelCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));

    account.set({ status: "signed_out" });

    expect(events).toEqual([{ kind: "selection_invalidated", reason: "account_lost" }]);
  });

  it("does not apply a model-unavailable repair that finishes after logout", async () => {
    const account = signedInAccount();
    const store = await preferenceStore();
    let records = [model("temporary", "Temporary", ["low"])];
    const catalog = new ModelCatalog({ listModelRecords: async () => records }, account, {
      store,
      legacyConfigCandidate: {
        mode: "explicit",
        modelId: "legacy-config",
        reasoningEffort: "medium",
      },
    });
    await catalog.selectModel({
      mode: "explicit",
      modelId: "temporary",
      reasoningEffort: "low",
    });
    records = [model("replacement", "Replacement", ["medium"])];
    const replacementEntered = gate();
    const allowReplacement = gate();
    const replace = store.replace.bind(store);
    vi.spyOn(store, "replace").mockImplementation(async (revision, value) => {
      replacementEntered.release();
      await allowReplacement.promise;
      return replace(revision, value);
    });
    const events: ModelCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));

    const listing = catalog.listModels();
    await replacementEntered.promise;
    account.set({ status: "signed_out" });
    allowReplacement.release();

    await expect(listing).rejects.toThrow("ChatGPT authentication is required");
    expect(events).toEqual([{ kind: "selection_invalidated", reason: "account_lost" }]);
  });

  it("does not apply a legacy migration that finishes after logout", async () => {
    const account = signedInAccount();
    const store = await preferenceStore();
    const catalog = new ModelCatalog(
      { listModelRecords: async () => [model("legacy-ui", "Legacy UI", ["high"])] },
      account,
      {
        store,
        legacyConfigCandidate: {
          mode: "explicit",
          modelId: "legacy-config",
          reasoningEffort: "medium",
        },
      },
    );
    await catalog.listModels();
    const migrationEntered = gate();
    const allowMigration = gate();
    const migrateLegacyOnce = store.migrateLegacyOnce.bind(store);
    vi.spyOn(store, "migrateLegacyOnce").mockImplementation(async (revision, input) => {
      migrationEntered.release();
      await allowMigration.promise;
      return migrateLegacyOnce(revision, input);
    });
    const events: ModelCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));

    const migrating = catalog.migrateLegacyPreference({
      mode: "explicit",
      modelId: "legacy-ui",
      reasoningEffort: "high",
    });
    await migrationEntered.promise;
    account.set({ status: "signed_out" });
    allowMigration.release();

    await expect(migrating).rejects.toThrow("ChatGPT authentication is required");
    expect(events).toEqual([{ kind: "selection_invalidated", reason: "account_lost" }]);
  });

  it("does not apply a prepared selection whose persistence finishes after logout", async () => {
    const account = signedInAccount();
    const store = await preferenceStore();
    const catalog = new ModelCatalog(
      { listModelRecords: async () => [model("live", "Live", ["medium"])] },
      account,
      {
        store,
        legacyConfigCandidate: {
          mode: "explicit",
          modelId: "legacy-config",
          reasoningEffort: "medium",
        },
      },
    );
    await catalog.listModels();
    const prepared = await catalog.prepareSelection({
      mode: "explicit",
      modelId: "live",
      reasoningEffort: "medium",
    });
    const replacementEntered = gate();
    const allowReplacement = gate();
    const replace = store.replace.bind(store);
    vi.spyOn(store, "replace").mockImplementation(async (revision, value) => {
      replacementEntered.release();
      await allowReplacement.promise;
      return replace(revision, value);
    });
    const events: ModelCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));

    const committing = catalog.commitSelection(prepared);
    await replacementEntered.promise;
    account.set({ status: "signed_out" });
    allowReplacement.release();

    await expect(committing).rejects.toThrow("ChatGPT authentication is required");
    expect(events).toEqual([{ kind: "selection_invalidated", reason: "account_lost" }]);
  });

  it("supports an explicit return to automatic selection", async () => {
    const account = signedInAccount();
    const catalog = new ModelCatalog(
      { listModelRecords: async () => [model("live", "Live", ["low"])] },
      account,
    );
    await catalog.selectModel({ mode: "explicit", modelId: "live", reasoningEffort: "low" });

    await expect(catalog.selectModel({ mode: "automatic" })).resolves.toEqual({
      mode: "automatic",
    });
  });

  it("fails a catalog race closed when the account logs out", async () => {
    const account = signedInAccount();
    let release!: (records: Model[]) => void;
    const records = new Promise<Model[]>((resolve) => {
      release = resolve;
    });
    const catalog = new ModelCatalog({ listModelRecords: () => records }, account);

    const listing = catalog.listModels();
    account.set({ status: "signed_out" });
    release([model("late", "Late", ["low"])]);

    await expect(listing).rejects.toThrow("ChatGPT authentication is required");
    await expect(
      catalog.selectModel({ mode: "explicit", modelId: "late", reasoningEffort: "low" }),
    ).rejects.toThrow("ChatGPT authentication is required");
  });

  it("does not mutate or invalidate from a cancelled late runtime-selection refresh", async () => {
    const account = signedInAccount();
    let releaseLate!: (records: Model[]) => void;
    const lateRecords = new Promise<Model[]>((resolve) => {
      releaseLate = resolve;
    });
    let call = 0;
    const catalog = new ModelCatalog(
      {
        listModelRecords: async () => {
          call += 1;
          if (call === 1) return [model("selected", "Selected", ["xhigh"])];
          if (call === 2) return lateRecords;
          return [model("selected", "Selected", ["xhigh"])];
        },
      },
      account,
    );
    await catalog.selectModel({
      mode: "explicit",
      modelId: "selected",
      reasoningEffort: "xhigh",
    });
    const events: ModelCatalogEvent[] = [];
    catalog.subscribe((event) => events.push(event));
    const controller = new AbortController();

    const resolving = catalog.resolveRuntimeSelection({ signal: controller.signal });
    await vi.waitFor(() => expect(call).toBe(2));
    controller.abort();
    releaseLate([model("replacement", "Replacement", ["medium"])]);

    await expect(resolving).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual([]);
    await expect(catalog.listModels()).resolves.toMatchObject({
      selection: {
        mode: "explicit",
        modelId: "selected",
        reasoningEffort: "xhigh",
      },
    });
    expect(events).toEqual([]);
  });
});
