import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { AvatarAppearanceRecord } from "../../../../src/avatar/avatarModelTypes.js";
import { AvatarApprovedSkinCatalog } from "./avatarApprovedSkinCatalog.js";

const userId = "user:00000000-0000-4000-8000-000000000001";

describe("AvatarApprovedSkinCatalog", () => {
  it("atomically publishes only approved relative paths and actual SHA-256 values", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-approved-skins-"));
    const relativePath = "user/00000000-0000-4000-8000-000000000001/skin.png";
    const bytes = await readFile(
      join(process.cwd(), "resources/avatar/builtin/whitelily/skin/base.png"),
    );
    await mkdir(join(dataRoot, "models", "user", "00000000-0000-4000-8000-000000000001"), {
      recursive: true,
    });
    await writeFile(join(dataRoot, "models", relativePath), bytes);
    const catalog = new AvatarApprovedSkinCatalog({ dataRoot });

    await catalog.publish([record(relativePath, sha256(bytes))]);

    const document = JSON.parse(
      await readFile(join(dataRoot, "bridge", "avatar-model", "approved-skins.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(document).toEqual({
      schemaVersion: 1,
      skins: [
        {
          id: userId,
          origin: "imported",
          skinAsset: relativePath,
          skinSha256: sha256(bytes),
          armModel: "slim",
        },
      ],
    });
    expect(JSON.stringify(document)).not.toContain(dataRoot);
  });

  it("keeps the last-known-good approved document when no refreshed skin is usable", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-approved-drift-"));
    const relativePath = "user/00000000-0000-4000-8000-000000000001/skin.png";
    const managed = join(dataRoot, "models", relativePath);
    await mkdir(join(managed, ".."), { recursive: true });
    const bytes = await readFile(
      join(process.cwd(), "resources/avatar/builtin/whitelily/skin/base.png"),
    );
    await writeFile(managed, bytes);
    const catalog = new AvatarApprovedSkinCatalog({ dataRoot });
    await catalog.publish([record(relativePath, sha256(bytes))]);
    const before = await readFile(join(dataRoot, "bridge", "avatar-model", "approved-skins.json"));
    await writeFile(
      managed,
      await readFile(
        join(
          process.cwd(),
          "../../subprojects/whitelily-avatar/mod-fabric/src/main/resources/assets/whitelily_avatar/textures/skin/leather.png",
        ),
      ),
    );

    await expect(catalog.publish([record(relativePath, sha256(bytes))])).resolves.toBeUndefined();
    expect(await readFile(join(dataRoot, "bridge", "avatar-model", "approved-skins.json"))).toEqual(
      before,
    );
  });

  it("publishes valid skins while diagnosing an invalid inactive record without paths", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-approved-isolation-"));
    const validPath = "user/00000000-0000-4000-8000-000000000001/skin.png";
    const missingPath = "user/00000000-0000-4000-8000-000000000002/skin.png";
    const bytes = await readFile(
      join(process.cwd(), "resources/avatar/builtin/whitelily/skin/base.png"),
    );
    await mkdir(join(dataRoot, "models", validPath, ".."), { recursive: true });
    await writeFile(join(dataRoot, "models", validPath), bytes);
    const diagnostic = vi.fn();
    const catalog = new AvatarApprovedSkinCatalog({ dataRoot, diagnostic });

    await catalog.publish([
      record(validPath, sha256(bytes)),
      record(missingPath, sha256(bytes), secondUserId),
    ]);

    const document = JSON.parse(
      await readFile(join(dataRoot, "bridge", "avatar-model", "approved-skins.json"), "utf8"),
    ) as { skins: Array<{ id: string }> };
    expect(document.skins.map(({ id }) => id)).toEqual([userId]);
    expect(diagnostic).toHaveBeenCalledWith({
      code: "AVATAR_MODEL_FILE_INVALID",
      modelId: secondUserId,
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(dataRoot);
  });
});

const secondUserId = "user:00000000-0000-4000-8000-000000000002";

function record(
  skinAsset: string,
  skinSha256: string,
  id: string = userId,
): AvatarAppearanceRecord {
  return {
    id,
    displayName: "Imported skin",
    origin: "imported",
    worldRenderer: "minecraft-skin",
    skinAsset,
    skinSha256,
    armModel: "slim",
    importedAt: "2026-08-21T00:00:00.000Z",
    validation: { code: "AVATAR_VALID", validatedAt: "2026-08-21T00:00:00.000Z" },
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
