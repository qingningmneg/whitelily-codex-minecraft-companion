import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
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

  it("does not replace the approved document when a managed digest drifts", async () => {
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

    await expect(catalog.publish([record(relativePath, sha256(bytes))])).rejects.toMatchObject({
      code: "AVATAR_DIGEST_MISMATCH",
    });
    expect(await readFile(join(dataRoot, "bridge", "avatar-model", "approved-skins.json"))).toEqual(
      before,
    );
  });
});

function record(skinAsset: string, skinSha256: string): AvatarAppearanceRecord {
  return {
    id: userId,
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
