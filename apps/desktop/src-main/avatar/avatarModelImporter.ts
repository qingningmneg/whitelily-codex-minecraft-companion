import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  parseAvatarModelRecord,
  type AvatarAppearanceRecord,
  type AvatarArmModel,
} from "../../../../src/avatar/avatarModelSchemas.js";
import type { AvatarModelCatalog } from "./avatarModelCatalog.js";
import { resolveAvatarModelPaths, type AvatarModelPaths } from "./avatarModelPaths.js";
import {
  createDeterministicSkinPreview,
  PngImageValidationError,
  validateMinecraftSkin,
  validatePortrait,
} from "./pngImageValidator.js";
import { readVerifiedAvatarFile } from "./verifiedAvatarResourceReader.js";

export type AvatarImportErrorCode =
  | "AVATAR_SKIN_INVALID"
  | "AVATAR_PORTRAIT_INVALID"
  | "AVATAR_DIGEST_MISMATCH"
  | "AVATAR_IMPORT_FAILED";

export class AvatarImportError extends Error {
  constructor(
    readonly code: AvatarImportErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "AvatarImportError";
  }
}

export interface AvatarModelImporterIo {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rm: typeof rm;
  writeFile: typeof writeFile;
}

export const nodeAvatarModelImporterIo: AvatarModelImporterIo = {
  mkdir,
  readFile,
  rm,
  writeFile,
};

interface AvatarModelCatalogPort {
  appendImported(record: AvatarAppearanceRecord): Promise<unknown>;
  has?(modelId: string): Promise<boolean>;
}

interface AvatarModelImporterOptions {
  readonly dataRoot: string;
  readonly catalog: AvatarModelCatalogPort | Pick<AvatarModelCatalog, "appendImported">;
  readonly createId?: () => string;
  readonly now?: () => Date;
  readonly io?: AvatarModelImporterIo;
}

const MAX_IMPORTED_PNG_BYTES = 8 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class AvatarModelImporter {
  readonly #paths: AvatarModelPaths;
  readonly #catalog: AvatarModelCatalogPort;
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #io: AvatarModelImporterIo;

  constructor(options: AvatarModelImporterOptions) {
    if (!isAbsolute(options.dataRoot)) throw new Error("invalid avatar importer data root");
    this.#paths = resolveAvatarModelPaths(resolve(options.dataRoot));
    this.#catalog = options.catalog;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#io = options.io ?? nodeAvatarModelImporterIo;
  }

  async importSkin(input: {
    readonly skinSourcePath: string;
    readonly portraitSourcePath?: string;
    readonly displayName: string;
    readonly armModel: AvatarArmModel;
  }): Promise<AvatarAppearanceRecord> {
    validateInput(input);
    const uuid = this.#createId();
    if (!UUID_PATTERN.test(uuid)) {
      throw new AvatarImportError("AVATAR_IMPORT_FAILED", "avatar import id is invalid");
    }
    const modelId = `user:${uuid}`;
    const stagingDirectory = join(this.#paths.stagingRoot, uuid);
    const managedDirectory = join(this.#paths.userRoot, uuid);
    let stagingOwned = false;
    let managedOwned = false;

    try {
      const skinSource = await readVerifiedAvatarFile({
        path: input.skinSourcePath,
        maximumBytes: MAX_IMPORTED_PNG_BYTES,
      });
      const skin = validateMinecraftSkin(skinSource);
      const portraitSource =
        input.portraitSourcePath === undefined
          ? undefined
          : await readVerifiedAvatarFile({
              path: input.portraitSourcePath,
              maximumBytes: MAX_IMPORTED_PNG_BYTES,
            });
      if (portraitSource !== undefined) validatePortrait(portraitSource);
      const skinDigest = digest(skinSource);
      const portraitDigest = portraitSource === undefined ? undefined : digest(portraitSource);
      const preview =
        portraitSource === undefined ? createDeterministicSkinPreview(skin) : undefined;

      await Promise.all([
        this.#io.mkdir(this.#paths.stagingRoot, { recursive: true }),
        this.#io.mkdir(this.#paths.userRoot, { recursive: true }),
      ]);
      await this.#io.mkdir(stagingDirectory);
      stagingOwned = true;
      const stagingSkinPath = join(stagingDirectory, "skin.png");
      await this.#io.writeFile(stagingSkinPath, skinSource, { flag: "wx" });
      if (portraitSource !== undefined) {
        await this.#io.writeFile(join(stagingDirectory, "portrait.png"), portraitSource, {
          flag: "wx",
        });
      } else {
        await this.#io.writeFile(join(stagingDirectory, "preview.png"), preview!, { flag: "wx" });
      }

      const timestamp = canonicalTimestamp(this.#now());
      const record = parseAvatarModelRecord({
        id: modelId,
        displayName: sanitizeDisplayName(input.displayName),
        origin: "imported",
        worldRenderer: "minecraft-skin",
        skinAsset: `user/${uuid}/skin.png`,
        skinSha256: skinDigest,
        armModel: input.armModel,
        ...(portraitDigest === undefined
          ? {}
          : {
              portraitAsset: `user/${uuid}/portrait.png`,
              portraitSha256: portraitDigest,
            }),
        importedAt: timestamp,
        validation: { code: "AVATAR_VALID", validatedAt: timestamp },
      });
      await verifyStagedFiles(this.#io, {
        skinPath: stagingSkinPath,
        skinDigest,
        portraitPath:
          portraitDigest === undefined ? undefined : join(stagingDirectory, "portrait.png"),
        portraitDigest,
        previewPath: preview === undefined ? undefined : join(stagingDirectory, "preview.png"),
        previewDigest: preview === undefined ? undefined : digest(preview),
      });

      await this.#io.mkdir(managedDirectory);
      managedOwned = true;
      await writeManagedFiles(this.#io, managedDirectory, skinSource, portraitSource, preview);
      await verifyStagedFiles(this.#io, {
        skinPath: join(managedDirectory, "skin.png"),
        skinDigest,
        portraitPath:
          portraitDigest === undefined ? undefined : join(managedDirectory, "portrait.png"),
        portraitDigest,
        previewPath: preview === undefined ? undefined : join(managedDirectory, "preview.png"),
        previewDigest: preview === undefined ? undefined : digest(preview),
      });
      await cleanupOwnedDirectory(this.#io, stagingDirectory);
      stagingOwned = false;
      try {
        await this.#catalog.appendImported(record);
      } catch (error) {
        const outcome = await this.#catalogCommitOutcome(record.id);
        if (outcome === "committed") {
          managedOwned = false;
          return record;
        }
        if (outcome === "unknown") {
          managedOwned = false;
        }
        throw error;
      }
      managedOwned = false;
      return record;
    } catch (error) {
      if (managedOwned) await cleanupOwnedDirectory(this.#io, managedDirectory);
      else if (stagingOwned) await cleanupOwnedDirectory(this.#io, stagingDirectory);
      throw wrapImportError(error);
    }
  }

  async #catalogCommitOutcome(modelId: string): Promise<"committed" | "uncommitted" | "unknown"> {
    if (this.#catalog.has === undefined) return "unknown";
    try {
      return (await this.#catalog.has(modelId)) ? "committed" : "uncommitted";
    } catch {
      return "unknown";
    }
  }
}

async function writeManagedFiles(
  io: AvatarModelImporterIo,
  directory: string,
  skin: Buffer,
  portrait: Buffer | undefined,
  preview: Buffer | undefined,
): Promise<void> {
  await io.writeFile(join(directory, "skin.png"), skin, { flag: "wx" });
  if (portrait !== undefined) {
    await io.writeFile(join(directory, "portrait.png"), portrait, { flag: "wx" });
  } else if (preview !== undefined) {
    await io.writeFile(join(directory, "preview.png"), preview, { flag: "wx" });
  } else {
    throw new AvatarImportError("AVATAR_IMPORT_FAILED", "avatar preview is unavailable");
  }
}

async function verifyStagedFiles(
  io: AvatarModelImporterIo,
  input: {
    readonly skinPath: string;
    readonly skinDigest: string;
    readonly portraitPath?: string;
    readonly portraitDigest?: string;
    readonly previewPath?: string;
    readonly previewDigest?: string;
  },
): Promise<void> {
  await verifyStagedDigest(io, input.skinPath, input.skinDigest);
  if (input.portraitPath !== undefined && input.portraitDigest !== undefined) {
    await verifyStagedDigest(io, input.portraitPath, input.portraitDigest);
  }
  if (input.previewPath !== undefined && input.previewDigest !== undefined) {
    await verifyStagedDigest(io, input.previewPath, input.previewDigest);
  }
}

async function verifyStagedDigest(
  io: AvatarModelImporterIo,
  path: string,
  expectedDigest: string,
): Promise<void> {
  const bytes = await io.readFile(path);
  if (digest(bytes) !== expectedDigest) {
    throw new AvatarImportError("AVATAR_DIGEST_MISMATCH", "staged avatar digest is invalid");
  }
}

async function cleanupOwnedDirectory(io: AvatarModelImporterIo, path: string): Promise<void> {
  try {
    await io.rm(path, { recursive: true, force: true });
  } catch {
    // Cleanup failures cannot replace the stable error delivered to the caller.
  }
}

function validateInput(input: {
  readonly skinSourcePath: string;
  readonly portraitSourcePath?: string;
  readonly armModel: AvatarArmModel;
}): void {
  if (
    !isAbsolute(input.skinSourcePath) ||
    (input.portraitSourcePath !== undefined && !isAbsolute(input.portraitSourcePath)) ||
    (input.armModel !== "slim" && input.armModel !== "wide")
  ) {
    throw new AvatarImportError("AVATAR_IMPORT_FAILED", "avatar import input is invalid");
  }
}

function sanitizeDisplayName(value: string): string {
  const sanitized = Array.from(
    value
      .toWellFormed()
      .replaceAll(/[\u0000-\u001f\u007f]/gu, "")
      .trim(),
  )
    .slice(0, 80)
    .join("");
  return sanitized.length > 0 ? sanitized : "导入皮肤";
}

function canonicalTimestamp(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AvatarImportError("AVATAR_IMPORT_FAILED", "avatar import timestamp is invalid");
  }
  return value.toISOString();
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function wrapImportError(error: unknown): AvatarImportError {
  if (error instanceof AvatarImportError) return error;
  if (error instanceof PngImageValidationError) {
    return new AvatarImportError(error.code, error.message, { cause: error });
  }
  return new AvatarImportError("AVATAR_IMPORT_FAILED", "avatar import failed", { cause: error });
}
