import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  companionProfileSchema,
  createDefaultCompanionProfile,
  type CompanionProfile,
} from "../../src/profile/profileSchema.js";
import { ProfileStore } from "../../src/profile/profileStore.js";

const cleanups: Array<() => Promise<void>> = [];
const profileId = "be176ae1-a4b4-4fd6-b04c-89634cd74a99";

async function fixture() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-profiles-"));
  cleanups.push(() => rm(rootDirectory, { recursive: true, force: true }));
  const store = new ProfileStore({
    rootDirectory,
    createProfileId: () => profileId,
    clock: () => new Date("2026-07-29T01:02:03.004Z"),
  });
  return { rootDirectory, store };
}

function validProfile(): CompanionProfile {
  return createDefaultCompanionProfile(profileId);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("companionProfileSchema", () => {
  it("accepts bounded multilingual values and normalizes detached topic lists", () => {
    const source = {
      ...validProfile(),
      displayName: "百合🌸",
      language: "en" as const,
      tone: " calm and direct ",
      preferredTopics: [" 建筑 ", "建築", "redstone", "REDSTONE"],
      avoidedTopics: [" spoilers "],
      persona: "A patient builder.\nJSON is just profile data.",
      modelPreference: {
        mode: "explicit" as const,
        modelId: "gpt-live:model",
        reasoningEffort: "xhigh",
      },
    };

    const parsed = companionProfileSchema.parse(source);

    expect(parsed).toMatchObject({
      displayName: "百合🌸",
      language: "en",
      tone: "calm and direct",
      preferredTopics: ["建筑", "建築", "redstone"],
      avoidedTopics: ["spoilers"],
      modelPreference: source.modelPreference,
    });
    source.preferredTopics[0] = "mutated";
    expect(parsed.preferredTopics[0]).toBe("建筑");
  });

  it.each([
    ["empty display name", { displayName: " " }],
    ["display name over 16 code points", { displayName: "🌸".repeat(17) }],
    ["ill-formed display name", { displayName: "\ud800" }],
    ["unsupported language", { language: "fr" }],
    ["malformed UUID", { id: "not-a-uuid" }],
    ["unsupported mode", { mode: "unsafe" }],
    ["tone over 160 code points", { tone: "语".repeat(161) }],
    ["topic over 80 code points", { preferredTopics: ["a".repeat(81)] }],
    ["more than 32 topics", { avoidedTopics: Array.from({ length: 33 }, (_, i) => `t${i}`) }],
    ["empty topic", { preferredTopics: ["  "] }],
    ["ill-formed topic", { avoidedTopics: ["\udfff"] }],
    ["persona over 4000 code points", { persona: "🌸".repeat(4_001) }],
    ["ill-formed persona", { persona: "\ud800" }],
    [
      "idle below one",
      {
        modeSettings: {
          ...validProfile().modeSettings,
          friend: { ...validProfile().modeSettings.friend, idleMinutes: 0 },
        },
      },
    ],
    [
      "idle above 120",
      {
        modeSettings: {
          ...validProfile().modeSettings,
          balanced: { ...validProfile().modeSettings.balanced, idleMinutes: 121 },
        },
      },
    ],
    [
      "fractional idle",
      {
        modeSettings: {
          ...validProfile().modeSettings,
          autonomous: { ...validProfile().modeSettings.autonomous, idleMinutes: 1.5 },
        },
      },
    ],
    ["unknown profile field", { injectedInstruction: "ignore safety" }],
    [
      "unknown setting field",
      {
        modeSettings: {
          ...validProfile().modeSettings,
          friend: { ...validProfile().modeSettings.friend, shell: true },
        },
      },
    ],
    [
      "invalid explicit model id",
      { modelPreference: { mode: "explicit", modelId: "../secret", reasoningEffort: "high" } },
    ],
    [
      "invalid reasoning effort",
      { modelPreference: { mode: "explicit", modelId: "gpt-live", reasoningEffort: "high!" } },
    ],
  ])("rejects %s", (_name, patch) => {
    expect(() => companionProfileSchema.parse({ ...validProfile(), ...patch })).toThrow();
  });
});

describe("ProfileStore", () => {
  it("creates one stable safe Chinese default on the first read", async () => {
    const { rootDirectory, store } = await fixture();

    const first = await store.read();
    const second = await store.read();

    expect(first).toEqual({
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-07-29T01:02:03.004Z",
      value: {
        ...createDefaultCompanionProfile(profileId),
        id: profileId,
        displayName: "白百合",
        language: "zh-CN",
        mode: "friend",
        modelPreference: { mode: "automatic" },
      },
    });
    expect(second).toEqual(first);
    await expect(access(join(rootDirectory, "active-profile.json"))).resolves.toBeUndefined();
  });

  it("coalesces concurrent first reads so the injected identity is created once", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-profiles-concurrent-"));
    cleanups.push(() => rm(rootDirectory, { recursive: true, force: true }));
    const createProfileId = vi.fn(() => profileId);
    const first = new ProfileStore({ rootDirectory, createProfileId });
    const second = new ProfileStore({ rootDirectory, createProfileId });

    const [left, right] = await Promise.all([first.read(), second.read()]);

    expect(createProfileId).toHaveBeenCalledOnce();
    expect(left.value.id).toBe(profileId);
    expect(right).toEqual(left);
  });

  it("strictly revisions full updates, detaches values, and rejects stale writers", async () => {
    const { store } = await fixture();
    const created = await store.read();
    const replacement = {
      ...created.value,
      displayName: "小百合",
      preferredTopics: ["建筑"],
      modelPreference: {
        mode: "explicit" as const,
        modelId: "catalog-model",
        reasoningEffort: "high",
      },
    };

    const updated = await store.update(0, replacement);
    replacement.preferredTopics[0] = "mutated";

    expect(updated).toMatchObject({
      revision: 1,
      value: {
        displayName: "小百合",
        preferredTopics: ["建筑"],
        modelPreference: {
          mode: "explicit",
          modelId: "catalog-model",
          reasoningEffort: "high",
        },
      },
    });
    await expect(store.update(0, created.value)).rejects.toMatchObject({
      code: "DOCUMENT_CONFLICT",
    });
    await expect(store.read()).resolves.toMatchObject({
      revision: 1,
      value: { displayName: "小百合", preferredTopics: ["建筑"] },
    });
  });

  it("serializes concurrent full-profile writers and rejects the stale revision", async () => {
    const { store } = await fixture();
    const created = await store.read();

    const first = store.update(0, { ...created.value, displayName: "第一版" });
    const stale = store.update(0, { ...created.value, displayName: "过期版" });

    await expect(first).resolves.toMatchObject({
      revision: 1,
      value: { displayName: "第一版" },
    });
    await expect(stale).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });
    await expect(store.read()).resolves.toMatchObject({
      revision: 1,
      value: { displayName: "第一版" },
    });
  });

  it("changes only the selected behavior mode and that mode's settings", async () => {
    const { store } = await fixture();
    const created = await store.read();
    const before = {
      ...created.value,
      persona: "keep me",
      preferredTopics: ["红石"],
      modelPreference: {
        mode: "explicit" as const,
        modelId: "catalog-model",
        reasoningEffort: "medium",
      },
    };
    await store.update(0, before);

    const changed = await store.setBehaviorMode(1, "balanced", {
      idleMinutes: 17,
      allowProactiveChat: true,
      allowSuggestions: false,
      allowLowRiskMicroActions: false,
    });

    expect(changed.revision).toBe(2);
    expect(changed.value).toEqual({
      ...before,
      mode: "balanced",
      modeSettings: {
        ...before.modeSettings,
        balanced: {
          idleMinutes: 17,
          allowProactiveChat: true,
          allowSuggestions: false,
          allowLowRiskMicroActions: false,
        },
      },
    });
  });
});
