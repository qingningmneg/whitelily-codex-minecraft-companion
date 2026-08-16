import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AvatarModelRecord } from "../../../../src/avatar/avatarModelTypes.js";
import { AvatarModelCatalog } from "./avatarModelCatalog.js";
import { resolveAvatarModelPaths } from "./avatarModelPaths.js";
import { AvatarModelPreferences } from "./avatarModelPreferences.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("AvatarModelPreferences", () => {
  it("defaults to builtin HD and persists only committed stable ids", async () => {
    const harness = await createHarness();
    await expect(harness.preferences.read(harness.catalog)).resolves.toEqual({
      schemaVersion: 1,
      revision: 0,
      activeModelId: "builtin:whitelily-hd",
    });

    await expect(
      harness.preferences.commitActiveModelId({
        catalog: harness.catalog,
        expectedRevision: 0,
        activeModelId: "builtin:whitelily-classic",
        committedRequestId: "switch-0001",
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      revision: 1,
      activeModelId: "builtin:whitelily-classic",
      committedRequestId: "switch-0001",
    });

    const restarted = new AvatarModelPreferences({ dataRoot: harness.root });
    await expect(restarted.read(harness.catalog)).resolves.toMatchObject({
      revision: 1,
      activeModelId: "builtin:whitelily-classic",
    });
  });

  it("rejects a stale writer and preserves the committed winner", async () => {
    const harness = await createHarness();
    await harness.preferences.commitActiveModelId({
      catalog: harness.catalog,
      expectedRevision: 0,
      activeModelId: "builtin:whitelily-classic",
      committedRequestId: "switch-winner",
    });

    await expect(
      harness.preferences.commitActiveModelId({
        catalog: harness.catalog,
        expectedRevision: 0,
        activeModelId: "builtin:whitelily-hd",
        committedRequestId: "switch-stale",
      }),
    ).rejects.toMatchObject({ code: "AVATAR_PREFERENCE_CONFLICT" });
    await expect(harness.preferences.read(harness.catalog)).resolves.toMatchObject({
      revision: 1,
      activeModelId: "builtin:whitelily-classic",
      committedRequestId: "switch-winner",
    });
  });

  it("makes a repeated committed request idempotent", async () => {
    const harness = await createHarness();
    const input = {
      catalog: harness.catalog,
      expectedRevision: 0,
      activeModelId: "builtin:whitelily-classic",
      committedRequestId: "switch-0001",
    } as const;
    const first = await harness.preferences.commitActiveModelId(input);

    await expect(harness.preferences.commitActiveModelId(input)).resolves.toEqual(first);
    expect(JSON.parse(await readFile(harness.paths.preferencesPath, "utf8"))).toEqual(first);
  });

  it("returns builtin HD when a saved imported id is no longer in the catalog", async () => {
    const harness = await createHarness();
    await writeFile(
      harness.paths.preferencesPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          revision: 3,
          activeModelId: "user:00000000-0000-4000-8000-000000000001",
          committedRequestId: "switch-old",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    await expect(harness.preferences.readActiveModelId(harness.catalog)).resolves.toBe(
      "builtin:whitelily-hd",
    );
    expect(JSON.parse(await readFile(harness.paths.preferencesPath, "utf8"))).toMatchObject({
      revision: 3,
      activeModelId: "user:00000000-0000-4000-8000-000000000001",
    });
  });

  it("refuses to commit a model that is absent from the validated catalog", async () => {
    const harness = await createHarness();
    await expect(
      harness.preferences.commitActiveModelId({
        catalog: harness.catalog,
        expectedRevision: 0,
        activeModelId: "user:00000000-0000-4000-8000-000000000001",
        committedRequestId: "switch-missing",
      }),
    ).rejects.toMatchObject({ code: "AVATAR_MODEL_NOT_FOUND" });
  });

  it("never silently overwrites a corrupt preference document", async () => {
    const harness = await createHarness();
    await writeFile(harness.paths.preferencesPath, "{corrupt", "utf8");

    await expect(harness.preferences.read(harness.catalog)).rejects.toMatchObject({
      code: "AVATAR_PREFERENCE_INVALID",
    });
    await expect(readFile(harness.paths.preferencesPath, "utf8")).resolves.toBe("{corrupt");
  });
});

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-preferences-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const catalog = new AvatarModelCatalog({ dataRoot: root, builtinModels: builtinModels() });
  await catalog.initialize();
  return {
    root,
    paths: resolveAvatarModelPaths(root),
    catalog,
    preferences: new AvatarModelPreferences({ dataRoot: root }),
  };
}

function builtinModels(): readonly [AvatarModelRecord, AvatarModelRecord] {
  const common = {
    displayName: "WhiteLily",
    origin: "builtin" as const,
    sha256: "a".repeat(64),
    importedAt: "2026-08-16T00:00:00.000Z",
    previewStatus: "ready" as const,
    boneMapping: {
      head: "Head",
      neck: "Neck",
      chest: "Chest",
      hips: "Hips",
      leftUpperArm: "LeftUpperArm",
      leftLowerArm: "LeftLowerArm",
      leftHand: "LeftHand",
      rightUpperArm: "RightUpperArm",
      rightLowerArm: "RightLowerArm",
      rightHand: "RightHand",
      leftUpperLeg: "LeftUpperLeg",
      leftLowerLeg: "LeftLowerLeg",
      leftFoot: "LeftFoot",
      rightUpperLeg: "RightUpperLeg",
      rightLowerLeg: "RightLowerLeg",
      rightFoot: "RightFoot",
    },
    bodyAnimation: "whitelily-humanoid-v1" as const,
    expressions: "full" as const,
    validation: {
      code: "AVATAR_VALID" as const,
      validatedAt: "2026-08-16T00:00:00.000Z",
    },
  };
  return [
    {
      ...common,
      id: "builtin:whitelily-hd",
      format: "builtin-hd",
      resourcePath: "builtin/whitelily-hd/high.glb",
      previewPath: "builtin/whitelily-hd/turnaround.png",
    },
    {
      ...common,
      id: "builtin:whitelily-classic",
      format: "builtin-classic",
      resourcePath: "builtin/whitelily-classic/whitelily.geo.json",
      previewPath: "builtin/whitelily-classic/preview.png",
    },
  ];
}
