import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AvatarBoneMapping,
  AvatarModelRecord,
} from "../../../../src/avatar/avatarModelTypes.js";
import { AvatarModelCatalog } from "./avatarModelCatalog.js";
import { resolveAvatarModelPaths } from "./avatarModelPaths.js";

const cleanups: Array<() => Promise<void>> = [];
const firstUserId = "user:00000000-0000-4000-8000-000000000001";
const secondUserId = "user:00000000-0000-4000-8000-000000000002";

const boneMapping = {
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
} as const satisfies AvatarBoneMapping;

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("AvatarModelCatalog", () => {
  it("restores two builtins first and imported records in committed order", async () => {
    const harness = await createHarness();
    await harness.catalog.initialize();
    await harness.catalog.appendImported(await harness.imported(firstUserId, "First"));
    await harness.catalog.appendImported(await harness.imported(secondUserId, "Second"));

    const restarted = new AvatarModelCatalog(harness.options);
    await restarted.initialize();

    expect((await restarted.list()).models.map(({ id }) => id)).toEqual([
      "builtin:whitelily-hd",
      "builtin:whitelily-classic",
      firstUserId,
      secondUserId,
    ]);
  });

  it("creates only the reviewed managed, staging, and bridge directories", async () => {
    const harness = await createHarness();
    await harness.catalog.initialize();

    const paths = resolveAvatarModelPaths(harness.root);
    await expect(readFile(paths.catalogPath, "utf8")).resolves.toContain('"schemaVersion": 1');
    expect(paths).toEqual({
      root: join(harness.root, "models"),
      catalogPath: join(harness.root, "models", "catalog.json"),
      preferencesPath: join(harness.root, "avatar-model-preferences.json"),
      stagingRoot: join(harness.root, "models", ".staging"),
      bridgeRoot: join(harness.root, "bridge", "avatar-model"),
    });
  });

  it("rejects duplicate imported ids without changing the durable order", async () => {
    const harness = await createHarness();
    await harness.catalog.initialize();
    const imported = await harness.imported(firstUserId, "First");
    await harness.catalog.appendImported(imported);

    await expect(harness.catalog.appendImported(imported)).rejects.toMatchObject({
      code: "AVATAR_MODEL_DUPLICATE",
    });
    expect((await harness.catalog.list()).models.map(({ id }) => id)).toEqual([
      "builtin:whitelily-hd",
      "builtin:whitelily-classic",
      firstUserId,
    ]);
  });

  it("quarantines a digest-mismatched imported record without blocking startup", async () => {
    const harness = await createHarness();
    await harness.catalog.initialize();
    const imported = await harness.imported(firstUserId, "First");
    await harness.catalog.appendImported(imported);
    await writeFile(join(harness.paths.root, imported.resourcePath), "tampered", "utf8");

    const restarted = new AvatarModelCatalog(harness.options);
    await restarted.initialize();

    expect((await restarted.list()).models.map(({ id }) => id)).toEqual([
      "builtin:whitelily-hd",
      "builtin:whitelily-classic",
    ]);
    expect(harness.diagnostics).toContainEqual({
      code: "AVATAR_DIGEST_MISMATCH",
      modelId: firstUserId,
    });
  });

  it("keeps startup usable with builtins when the catalog document is corrupt", async () => {
    const harness = await createHarness();
    await harness.catalog.initialize();
    await writeFile(harness.paths.catalogPath, "{corrupt", "utf8");

    const restarted = new AvatarModelCatalog(harness.options);
    await restarted.initialize();

    expect((await restarted.list()).models.map(({ id }) => id)).toEqual([
      "builtin:whitelily-hd",
      "builtin:whitelily-classic",
    ]);
    expect(harness.diagnostics).toContainEqual({
      code: "AVATAR_CATALOG_INVALID",
      modelId: "catalog",
    });
    await expect(readFile(harness.paths.catalogPath, "utf8")).resolves.toBe("{corrupt");
  });

  it("resolves a validated runtime descriptor without preview or import metadata", async () => {
    const harness = await createHarness();
    await harness.catalog.initialize();
    await harness.catalog.appendImported(await harness.imported(firstUserId, "First"));

    const descriptor = await harness.catalog.resolveRuntimeDescriptor(firstUserId);

    expect(descriptor).toMatchObject({
      modelId: firstUserId,
      origin: "imported",
      format: "glb",
      resourcePath: `user/${firstUserId.slice("user:".length)}/model.glb`,
    });
    expect(descriptor).not.toHaveProperty("displayName");
    expect(descriptor).not.toHaveProperty("previewPath");
    expect(descriptor).not.toHaveProperty("importedAt");
  });

  it("does not publish an imported entry until its model and preview are both valid", async () => {
    const harness = await createHarness();
    await harness.catalog.initialize();
    const imported = await harness.imported(firstUserId, "First");
    await rm(join(harness.paths.root, imported.previewPath));

    await expect(harness.catalog.appendImported(imported)).rejects.toMatchObject({
      code: "AVATAR_MODEL_FILE_INVALID",
    });
    expect((await harness.catalog.list()).models).toHaveLength(2);
  });
});

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-catalog-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const diagnostics: Array<{ code: string; modelId: string }> = [];
  const paths = resolveAvatarModelPaths(root);
  const options = {
    dataRoot: root,
    builtinModels: builtinModels(),
    diagnostic: (diagnostic: { code: string; modelId: string }) => diagnostics.push(diagnostic),
  };
  const catalog = new AvatarModelCatalog(options);
  return {
    root,
    paths,
    options,
    catalog,
    diagnostics,
    imported: async (id: string, displayName: string): Promise<AvatarModelRecord> => {
      const uuid = id.slice("user:".length);
      const resourcePath = `user/${uuid}/model.glb`;
      const previewPath = `user/${uuid}/preview.png`;
      const bytes = Buffer.from(`glb:${id}`, "utf8");
      await mkdir(join(paths.root, "user", uuid), { recursive: true });
      await writeFile(join(paths.root, resourcePath), bytes);
      await writeFile(join(paths.root, previewPath), Buffer.from("png", "utf8"));
      return {
        id,
        displayName,
        origin: "imported",
        format: "glb",
        resourcePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        importedAt: id === firstUserId ? "2026-08-16T08:00:00.000Z" : "2026-08-16T08:01:00.000Z",
        previewPath,
        previewStatus: "ready",
        boneMapping,
        bodyAnimation: "whitelily-humanoid-v1",
        expressions: "neutral-only",
        validation: {
          code: "AVATAR_VALID",
          validatedAt: "2026-08-16T08:02:00.000Z",
        },
      };
    },
  };
}

function builtinModels(): readonly [AvatarModelRecord, AvatarModelRecord] {
  const common = {
    displayName: "WhiteLily",
    origin: "builtin" as const,
    sha256: "a".repeat(64),
    importedAt: "2026-08-16T00:00:00.000Z",
    previewStatus: "ready" as const,
    boneMapping,
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
