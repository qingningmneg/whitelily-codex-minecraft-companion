import { createHash } from "node:crypto";
import type { AvatarAppearanceRecord } from "../../../../src/avatar/avatarModelTypes.js";
import { resolveBuiltinAvatarAppearancePaths } from "./avatarModelPaths.js";
import {
  readVerifiedAvatarResource,
  type VerifiedAvatarResourceReaderIo,
} from "./verifiedAvatarResourceReader.js";

const MAX_BUILTIN_AVATAR_ASSET_BYTES = 2 * 1024 * 1024;
const BUILTIN_ASSET_TIMESTAMP = "2026-08-21T00:00:00.000Z";

export async function loadBuiltinAvatarAppearance(options: {
  readonly resourcesPath: string;
  readonly resourceReaderIo?: VerifiedAvatarResourceReaderIo;
}): Promise<AvatarAppearanceRecord> {
  resolveBuiltinAvatarAppearancePaths(options.resourcesPath);
  const [skin, portrait] = await Promise.all([
    readVerifiedAvatarResource({
      root: options.resourcesPath,
      relativePath: "avatar/builtin/whitelily/skin/base.png",
      maximumBytes: MAX_BUILTIN_AVATAR_ASSET_BYTES,
      io: options.resourceReaderIo,
    }),
    readVerifiedAvatarResource({
      root: options.resourcesPath,
      relativePath: "avatar/builtin/whitelily/portrait.png",
      maximumBytes: MAX_BUILTIN_AVATAR_ASSET_BYTES,
      io: options.resourceReaderIo,
    }),
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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
