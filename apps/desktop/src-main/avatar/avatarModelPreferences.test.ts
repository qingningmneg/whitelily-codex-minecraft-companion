import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AvatarAppearanceRecord } from "../../../../src/avatar/avatarModelTypes.js";
import { AvatarModelCatalog } from "./avatarModelCatalog.js";
import { resolveAvatarModelPaths } from "./avatarModelPaths.js";
import { AvatarModelPreferences } from "./avatarModelPreferences.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("AvatarModelPreferences", () => {
  it("defaults to the native builtin", async () => {
    const harness = await createHarness();

    await expect(harness.preferences.read(harness.catalog)).resolves.toMatchObject({
      schemaVersion: 1,
      revision: 0,
      activeModelId: "builtin:whitelily",
    });
  });

  it.each(["builtin:whitelily-hd", "builtin:whitelily-classic"])(
    "migrates %s to the native builtin and persists it",
    async (legacyId) => {
      const harness = await createHarness();
      await writeFile(
        harness.paths.preferencesPath,
        JSON.stringify({ schemaVersion: 1, revision: 4, activeModelId: legacyId }),
        "utf8",
      );

      await expect(harness.preferences.read(harness.catalog)).resolves.toMatchObject({
        revision: 4,
        activeModelId: "builtin:whitelily",
      });
      await expect(readFile(harness.paths.preferencesPath, "utf8")).resolves.toContain(
        '"activeModelId": "builtin:whitelily"',
      );
    },
  );

  it("returns the builtin when a saved imported id is unavailable", async () => {
    const harness = await createHarness();
    await writeFile(
      harness.paths.preferencesPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        activeModelId: "user:00000000-0000-4000-8000-000000000001",
      }),
      "utf8",
    );

    await expect(harness.preferences.readActiveModelId(harness.catalog)).resolves.toBe(
      "builtin:whitelily",
    );
  });
});

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-preferences-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const catalog = new AvatarModelCatalog({ dataRoot: root, builtinModels: builtinAppearance() });
  return {
    root,
    catalog,
    paths: resolveAvatarModelPaths(root),
    preferences: new AvatarModelPreferences({ dataRoot: root }),
  };
}

function builtinAppearance(): AvatarAppearanceRecord {
  return {
    id: "builtin:whitelily",
    displayName: "WhiteLily",
    origin: "builtin",
    worldRenderer: "minecraft-skin",
    skinAsset: "builtin/whitelily/skin/base.png",
    skinSha256: "a".repeat(64),
    armModel: "slim",
    portraitAsset: "builtin/whitelily/portrait.png",
    portraitSha256: "b".repeat(64),
    importedAt: "2026-08-21T00:00:00.000Z",
    validation: { code: "AVATAR_VALID", validatedAt: "2026-08-21T00:00:00.000Z" },
  };
}
