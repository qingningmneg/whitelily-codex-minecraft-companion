import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBuiltinAvatarAppearance } from "./builtinAvatarAppearance.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("loadBuiltinAvatarAppearance", () => {
  it("derives the native skin and full-turnaround digests from packaged bytes", async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), "whitelily-avatar-resources-"));
    cleanups.push(() => rm(resourcesPath, { recursive: true, force: true }));
    const root = join(resourcesPath, "avatar", "builtin", "whitelily");
    const skin = Buffer.from("reviewed 64x64 skin", "utf8");
    const portrait = Buffer.from("full turnaround canvas", "utf8");
    await mkdir(join(root, "skin"), { recursive: true });
    await writeFile(join(root, "skin", "base.png"), skin);
    await writeFile(join(root, "portrait.png"), portrait);

    await expect(loadBuiltinAvatarAppearance({ resourcesPath })).resolves.toMatchObject({
      id: "builtin:whitelily",
      origin: "builtin",
      worldRenderer: "minecraft-skin",
      skinAsset: "builtin/whitelily/skin/base.png",
      skinSha256: createHash("sha256").update(skin).digest("hex"),
      armModel: "slim",
      portraitAsset: "builtin/whitelily/portrait.png",
      portraitSha256: createHash("sha256").update(portrait).digest("hex"),
    });
  });
});
