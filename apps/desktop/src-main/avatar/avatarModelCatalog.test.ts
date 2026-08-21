import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AvatarAppearanceRecord } from "../../../../src/avatar/avatarModelTypes.js";
import { AvatarModelCatalog } from "./avatarModelCatalog.js";
import { resolveAvatarModelPaths } from "./avatarModelPaths.js";

const cleanups: Array<() => Promise<void>> = [];
const importedId = "user:00000000-0000-4000-8000-000000000001";

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("AvatarModelCatalog", () => {
  it("lists one builtin before imported appearances", async () => {
    const harness = await createHarness();
    const imported = await harness.imported(importedId, "First");

    await harness.catalog.appendImported(imported);

    expect((await harness.catalog.list()).models.map(({ id }) => id)).toEqual([
      "builtin:whitelily",
      imported.id,
    ]);
  });

  it("skips a legacy GLB catalog entry once without hiding the builtin", async () => {
    const harness = await createHarness();
    await harness.catalog.initialize();
    await writeFile(
      harness.paths.catalogPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 4,
        imported: [
          {
            id: importedId,
            displayName: "Old GLB",
            origin: "imported",
            format: "glb",
            resourcePath: "user/00000000-0000-4000-8000-000000000001/model.glb",
          },
        ],
      }),
      "utf8",
    );

    await expect(harness.catalog.list()).resolves.toMatchObject({
      models: [{ id: "builtin:whitelily" }],
    });
    await harness.catalog.list();

    expect(harness.diagnostics).toEqual([
      { code: "AVATAR_CATALOG_LEGACY_MODEL_SKIPPED", modelId: importedId },
    ]);
  });

  it("does not publish a builtin-shaped entry stored in imported records", async () => {
    const harness = await createHarness();
    await harness.catalog.initialize();
    await writeFile(
      harness.paths.catalogPath,
      JSON.stringify({ schemaVersion: 1, revision: 4, imported: [builtinAppearance()] }),
      "utf8",
    );

    await expect(harness.catalog.list()).resolves.toMatchObject({
      models: [{ id: "builtin:whitelily" }],
    });
    expect(harness.diagnostics).toContainEqual({
      code: "AVATAR_CATALOG_INVALID",
      modelId: "legacy",
    });
  });

  it("publishes one imported appearance when the legacy catalog duplicates its id", async () => {
    const harness = await createHarness();
    const imported = await harness.imported(importedId, "First");
    await harness.catalog.initialize();
    await writeFile(
      harness.paths.catalogPath,
      JSON.stringify({ schemaVersion: 1, revision: 4, imported: [imported, imported] }),
      "utf8",
    );

    expect((await harness.catalog.list()).models.map(({ id }) => id)).toEqual([
      "builtin:whitelily",
      importedId,
    ]);
    expect(harness.diagnostics).toContainEqual({
      code: "AVATAR_CATALOG_INVALID",
      modelId: importedId,
    });
  });

  it("uses a fixed diagnostic id for unsafe legacy record ids", async () => {
    const harness = await createHarness();
    await harness.catalog.initialize();
    await writeFile(
      harness.paths.catalogPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 4,
        imported: [{ id: "user:unsafe\\n\u202E", format: "glb" }],
      }),
      "utf8",
    );

    await harness.catalog.list();

    expect(harness.diagnostics).toEqual([
      { code: "AVATAR_CATALOG_LEGACY_MODEL_SKIPPED", modelId: "legacy" },
    ]);
  });

  it("keeps startup usable with the builtin when the catalog document is corrupt", async () => {
    const harness = await createHarness();
    await harness.catalog.initialize();
    await writeFile(harness.paths.catalogPath, "{corrupt", "utf8");

    await expect(harness.catalog.list()).resolves.toMatchObject({
      models: [{ id: "builtin:whitelily" }],
    });
    expect(harness.diagnostics).toContainEqual({
      code: "AVATAR_CATALOG_INVALID",
      modelId: "catalog",
    });
  });

  it("resolves the native skin runtime descriptor", async () => {
    const harness = await createHarness();

    await expect(harness.catalog.resolveRuntimeDescriptor("builtin:whitelily")).resolves.toEqual({
      modelId: "builtin:whitelily",
      origin: "builtin",
      worldRenderer: "minecraft-skin",
      armModel: "slim",
    });
  });
});

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-catalog-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAvatarModelPaths(root);
  const diagnostics: Array<{ code: string; modelId: string }> = [];
  const options = {
    dataRoot: root,
    builtinModels: builtinAppearance(),
    diagnostic: (diagnostic: { code: string; modelId: string }) => diagnostics.push(diagnostic),
  };
  const catalog = new AvatarModelCatalog(options);
  return {
    catalog,
    diagnostics,
    paths,
    imported: async (id: string, displayName: string): Promise<AvatarAppearanceRecord> => {
      const uuid = id.slice("user:".length);
      const skinAsset = `user/${uuid}/skin.png`;
      const skinBytes = Buffer.from(`skin:${id}`, "utf8");
      await mkdir(join(paths.root, "user", uuid), { recursive: true });
      await writeFile(join(paths.root, skinAsset), skinBytes);
      return {
        id,
        displayName,
        origin: "imported",
        worldRenderer: "minecraft-skin",
        skinAsset,
        skinSha256: createHash("sha256").update(skinBytes).digest("hex"),
        armModel: "wide",
        importedAt: "2026-08-21T00:00:00.000Z",
        validation: { code: "AVATAR_VALID", validatedAt: "2026-08-21T00:00:00.000Z" },
      };
    },
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
