import { mkdtemp, readFile } from "node:fs/promises";
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
});
