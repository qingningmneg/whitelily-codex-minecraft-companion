import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  parseAvatarModelRecord,
  type AvatarAppearanceRecord,
} from "../../../../src/avatar/avatarModelSchemas.js";
import { AtomicJsonFile } from "../../../../src/storage/atomicJsonFile.js";
import { resolveAvatarModelPaths } from "./avatarModelPaths.js";
import { validateMinecraftSkin } from "./pngImageValidator.js";
import { readVerifiedAvatarResource } from "./verifiedAvatarResourceReader.js";

const MAX_APPROVED_SKIN_BYTES = 8 * 1024 * 1024;

export type AvatarApprovedSkinCatalogErrorCode =
  "AVATAR_MODEL_FILE_INVALID" | "AVATAR_DIGEST_MISMATCH";

export class AvatarApprovedSkinCatalogError extends Error {
  constructor(
    readonly code: AvatarApprovedSkinCatalogErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "AvatarApprovedSkinCatalogError";
  }
}

export interface ApprovedSkinCatalogEntry {
  readonly id: string;
  readonly origin: "builtin" | "imported";
  readonly skinAsset: string;
  readonly skinSha256: string;
  readonly armModel: "slim" | "wide";
}

interface ApprovedSkinCatalogDocument {
  readonly schemaVersion: 1;
  readonly skins: readonly ApprovedSkinCatalogEntry[];
}

export class AvatarApprovedSkinCatalog {
  readonly #modelRoot: string;
  readonly #file: AtomicJsonFile<ApprovedSkinCatalogDocument>;

  constructor(options: { readonly dataRoot: string }) {
    if (!isAbsolute(options.dataRoot)) throw new Error("invalid approved skin catalog root");
    const dataRoot = resolve(options.dataRoot);
    const paths = resolveAvatarModelPaths(dataRoot);
    this.#modelRoot = paths.root;
    this.#file = new AtomicJsonFile({
      rootDirectory: dataRoot,
      path: join(paths.bridgeRoot, "approved-skins.json"),
      validate: validateDocument,
      recoverFromBackup: false,
    });
  }

  async publish(records: readonly AvatarAppearanceRecord[]): Promise<void> {
    const skins: ApprovedSkinCatalogEntry[] = [];
    for (const candidate of records) {
      const record = parseAvatarModelRecord(candidate);
      let bytes: Buffer;
      try {
        bytes = await readVerifiedAvatarResource({
          root: this.#modelRoot,
          relativePath: record.skinAsset,
          maximumBytes: MAX_APPROVED_SKIN_BYTES,
        });
        validateMinecraftSkin(bytes);
      } catch (error) {
        throw new AvatarApprovedSkinCatalogError(
          "AVATAR_MODEL_FILE_INVALID",
          "approved avatar skin is invalid",
          { cause: error },
        );
      }
      const actualDigest = sha256(bytes);
      if (actualDigest !== record.skinSha256) {
        throw new AvatarApprovedSkinCatalogError(
          "AVATAR_DIGEST_MISMATCH",
          "approved avatar skin digest changed",
        );
      }
      skins.push(
        Object.freeze({
          id: record.id,
          origin: record.origin,
          skinAsset: record.skinAsset,
          skinSha256: actualDigest,
          armModel: record.armModel,
        }),
      );
    }
    await this.#file.write({ schemaVersion: 1, skins });
  }
}

function validateDocument(value: unknown): ApprovedSkinCatalogDocument {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "schemaVersion,skins") {
    throw new Error("invalid approved skin catalog");
  }
  if (value.schemaVersion !== 1 || !Array.isArray(value.skins) || value.skins.length > 1_024) {
    throw new Error("invalid approved skin catalog");
  }
  const skins = value.skins.map((candidate) => {
    if (!isPlainObject(candidate)) throw new Error("invalid approved skin entry");
    if (Object.keys(candidate).sort().join(",") !== "armModel,id,origin,skinAsset,skinSha256") {
      throw new Error("invalid approved skin entry");
    }
    const record = parseAvatarModelRecord({
      ...candidate,
      displayName: "Approved skin",
      worldRenderer: "minecraft-skin",
      importedAt: "2026-08-21T00:00:00.000Z",
      validation: { code: "AVATAR_VALID", validatedAt: "2026-08-21T00:00:00.000Z" },
      ...(candidate.origin === "builtin"
        ? {
            portraitAsset: "builtin/whitelily/portrait.png",
            portraitSha256: "0".repeat(64),
          }
        : {}),
    });
    return Object.freeze({
      id: record.id,
      origin: record.origin,
      skinAsset: record.skinAsset,
      skinSha256: record.skinSha256,
      armModel: record.armModel,
    });
  });
  if (new Set(skins.map(({ id }) => id)).size !== skins.length) {
    throw new Error("duplicate approved skin id");
  }
  return Object.freeze({ schemaVersion: 1, skins: Object.freeze(skins) });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
