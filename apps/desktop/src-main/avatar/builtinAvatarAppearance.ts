import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { AvatarAppearanceRecord } from "../../../../src/avatar/avatarModelTypes.js";
import { resolveBuiltinAvatarAppearancePaths } from "./avatarModelPaths.js";

const MAX_BUILTIN_AVATAR_ASSET_BYTES = 2 * 1024 * 1024;
const BUILTIN_ASSET_TIMESTAMP = "2026-08-21T00:00:00.000Z";

export async function loadBuiltinAvatarAppearance(options: {
  readonly resourcesPath: string;
}): Promise<AvatarAppearanceRecord> {
  const paths = resolveBuiltinAvatarAppearancePaths(options.resourcesPath);
  const [skin, portrait] = await Promise.all([
    readBoundedResource(paths.skinPath),
    readBoundedResource(paths.portraitPath),
  ]);
  return Object.freeze({
    id: "builtin:whitelily",
    displayName: "WhiteLily",
    origin: "builtin",
    worldRenderer: "minecraft-skin",
    skinAsset: "builtin/whitelily/skin/base.png",
    skinSha256: sha256(skin),
    armModel: "slim",
    portraitAsset: "builtin/whitelily/portrait.png",
    portraitSha256: sha256(portrait),
    importedAt: BUILTIN_ASSET_TIMESTAMP,
    validation: { code: "AVATAR_VALID" as const, validatedAt: BUILTIN_ASSET_TIMESTAMP },
  });
}

async function readBoundedResource(path: string): Promise<Buffer> {
  const before = await lstat(path);
  assertReadableAsset(before);
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    assertSameFile(before, opened);
    assertReadableAsset(opened);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertSameFile(opened, after);
    if (bytes.length !== after.size) throw new Error("builtin avatar asset changed during read");
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertReadableAsset(stats: Stats): void {
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size <= 0 ||
    stats.size > MAX_BUILTIN_AVATAR_ASSET_BYTES
  ) {
    throw new Error("builtin avatar asset is invalid");
  }
}

function assertSameFile(left: Stats, right: Stats): void {
  if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size) {
    throw new Error("builtin avatar asset changed during read");
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
