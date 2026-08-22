import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAvatarModelComposition } from "./avatarModelComposition.js";

describe("avatar model composition", () => {
  it("publishes the builtin approval, projects a safe list and unregisters runtime events", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-composition-"));
    const unsubscribeRuntime = vi.fn();
    const composition = await createAvatarModelComposition({
      dataRoot,
      resourcesPath: join(process.cwd(), "resources"),
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      choosePortrait: vi.fn(async () => "skip" as const),
      subscribeRuntime: vi.fn(() => unsubscribeRuntime),
    });

    await expect(composition.list()).resolves.toMatchObject({
      activeModelId: "builtin:whitelily",
      models: [{ id: "builtin:whitelily", worldRenderer: "minecraft-skin", armModel: "slim" }],
    });
    expect(
      JSON.parse(
        await readFile(join(dataRoot, "bridge", "avatar-model", "approved-skins.json"), "utf8"),
      ),
    ).toMatchObject({ schemaVersion: 1, skins: [{ id: "builtin:whitelily" }] });

    composition.dispose();
    expect(unsubscribeRuntime).toHaveBeenCalledOnce();
  });

  it("starts with builtin fallback when the active record and approval catalog are unusable", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-composition-fail-closed-"));
    const modelId = "user:00000000-0000-4000-8000-000000000001";
    await mkdir(join(dataRoot, "models"), { recursive: true });
    await writeFile(
      join(dataRoot, "models", "catalog.json"),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        imported: [
          {
            id: modelId,
            displayName: "Missing imported skin",
            origin: "imported",
            worldRenderer: "minecraft-skin",
            skinAsset: "user/00000000-0000-4000-8000-000000000001/skin.png",
            skinSha256: "a".repeat(64),
            armModel: "slim",
            importedAt: "2026-08-21T00:00:00.000Z",
            validation: { code: "AVATAR_VALID", validatedAt: "2026-08-21T00:00:00.000Z" },
          },
        ],
      }),
    );
    await writeFile(
      join(dataRoot, "avatar-model-preferences.json"),
      JSON.stringify({ schemaVersion: 1, revision: 1, activeModelId: modelId }),
    );
    await mkdir(join(dataRoot, "bridge", "avatar-model", "approved-skins.json"), {
      recursive: true,
    });
    const diagnostic = vi.fn();
    const subscribeRuntime = vi.fn(() => vi.fn());

    const composition = await createAvatarModelComposition({
      dataRoot,
      resourcesPath: join(process.cwd(), "resources"),
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      choosePortrait: vi.fn(async () => "skip" as const),
      subscribeRuntime,
      diagnostic,
    });

    await expect(composition.list()).resolves.toMatchObject({
      activeModelId: "builtin:whitelily",
      models: [{ id: "builtin:whitelily" }],
    });
    expect(subscribeRuntime).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith("AVATAR_MODEL_FILE_INVALID", modelId);
    expect(diagnostic).toHaveBeenCalledWith("AVATAR_APPROVED_SKIN_CATALOG_UNAVAILABLE");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(dataRoot);
    composition.dispose();
  });
});
