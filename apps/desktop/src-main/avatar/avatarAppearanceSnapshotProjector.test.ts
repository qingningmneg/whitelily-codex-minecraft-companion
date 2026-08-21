import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AvatarAppearanceRecord } from "../../../../src/avatar/avatarModelTypes.js";
import { AvatarAppearanceSnapshotProjector } from "./avatarAppearanceSnapshotProjector.js";

describe("AvatarAppearanceSnapshotProjector", () => {
  it("returns the skin preview when portrait data URL construction fails", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-projector-"));
    const uuid = "00000000-0000-4000-8000-000000000001";
    const root = join(dataRoot, "models", "user", uuid);
    await mkdir(root, { recursive: true });
    const skin = await readFile(
      join(process.cwd(), "resources/avatar/builtin/whitelily/skin/base.png"),
    );
    await writeFile(join(root, "skin.png"), skin);
    await writeFile(join(root, "preview.png"), skin);
    await writeFile(join(root, "portrait.png"), Buffer.from("broken portrait"));
    const diagnostic = vi.fn();
    const projector = new AvatarAppearanceSnapshotProjector({ dataRoot, diagnostic });
    const appearance = record(uuid, skin, true);

    const snapshot = await projector.project({ revision: 7, models: [appearance] }, appearance.id);

    expect(snapshot.models[0]?.previewDataUrl).toBe(
      `data:image/png;base64,${skin.toString("base64")}`,
    );
    expect(snapshot.models[0]?.portraitDataUrl).toBeUndefined();
    expect(diagnostic).toHaveBeenCalledWith({
      code: "AVATAR_PORTRAIT_UNAVAILABLE",
      modelId: appearance.id,
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(dataRoot);
  });

  it("isolates each broken preview with a built-in placeholder and reports it once", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-projector-placeholder-"));
    const uuid = "00000000-0000-4000-8000-000000000001";
    const root = join(dataRoot, "models", "user", uuid);
    await mkdir(root, { recursive: true });
    const skin = await readFile(
      join(process.cwd(), "resources/avatar/builtin/whitelily/skin/base.png"),
    );
    await writeFile(join(root, "skin.png"), Buffer.from("drift"));
    await writeFile(join(root, "preview.png"), Buffer.from("broken"));
    const diagnostic = vi.fn();
    const projector = new AvatarAppearanceSnapshotProjector({ dataRoot, diagnostic });
    const appearance = record(uuid, skin, false);

    const first = await projector.project({ revision: 1, models: [appearance] }, appearance.id);
    const second = await projector.project({ revision: 1, models: [appearance] }, appearance.id);

    expect(first.models[0]?.previewDataUrl).toMatch(/^data:image\/png;base64,/u);
    expect(second.models[0]?.previewDataUrl).toBe(first.models[0]?.previewDataUrl);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith({
      code: "AVATAR_PREVIEW_UNAVAILABLE",
      modelId: appearance.id,
    });
  });
});

function record(uuid: string, skin: Buffer, portrait: boolean): AvatarAppearanceRecord {
  const id = `user:${uuid}`;
  return {
    id,
    displayName: "Imported skin",
    origin: "imported",
    worldRenderer: "minecraft-skin",
    skinAsset: `user/${uuid}/skin.png`,
    skinSha256: sha256(skin),
    armModel: "slim",
    ...(portrait
      ? {
          portraitAsset: `user/${uuid}/portrait.png`,
          portraitSha256: sha256(Buffer.from("expected")),
        }
      : {}),
    importedAt: "2026-08-21T00:00:00.000Z",
    validation: { code: "AVATAR_VALID", validatedAt: "2026-08-21T00:00:00.000Z" },
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
