import { describe, expect, it, vi } from "vitest";
import type { AccountSnapshot } from "../../src/codex/accountService.js";
import type { Model } from "../../src/codex/generated/v2/Model.js";
import {
  ModelCatalog,
  type ModelCatalogAccountPort,
  type ModelCatalogAppServerPort,
} from "../../src/codex/modelCatalog.js";

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

  it("selects an available live model and service-provided reasoning effort", async () => {
    const account = signedInAccount();
    const catalog = new ModelCatalog(
      {
        listModelRecords: async () => [model("live-choice", "Live Choice", ["minimal", "medium"])],
      },
      account,
    );

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

  it("falls back deterministically to automatic when the selected model disappears", async () => {
    const account = signedInAccount();
    let records = [model("temporary", "Temporary", ["low"])];
    const catalog = new ModelCatalog({ listModelRecords: async () => records }, account);
    await catalog.selectModel({
      mode: "explicit",
      modelId: "temporary",
      reasoningEffort: "low",
    });

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
    });
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
    const invalidations: string[] = [];
    catalog.subscribeInvalidation(() => invalidations.push("invalidated"));
    const controller = new AbortController();

    const resolving = catalog.resolveRuntimeSelection({ signal: controller.signal });
    await vi.waitFor(() => expect(call).toBe(2));
    controller.abort();
    releaseLate([model("replacement", "Replacement", ["medium"])]);

    await expect(resolving).rejects.toMatchObject({ name: "AbortError" });
    expect(invalidations).toEqual([]);
    await expect(catalog.listModels()).resolves.toMatchObject({
      selection: {
        mode: "explicit",
        modelId: "selected",
        reasoningEffort: "xhigh",
      },
    });
    expect(invalidations).toEqual([]);
  });
});
