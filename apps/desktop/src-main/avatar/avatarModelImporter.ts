import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  parseAvatarModelRecord,
  type AvatarBoneMapping,
  type AvatarModelRecord,
} from "../../../../src/avatar/avatarModelSchemas.js";
import { mapAvatarBones } from "./avatarBoneMapper.js";
import type { AvatarModelCatalog } from "./avatarModelCatalog.js";
import {
  AvatarFileValidationError,
  MAX_AVATAR_SOURCE_BYTES,
  parseGlbContainer,
} from "./glbContainer.js";
import { resolveAvatarModelPaths, type AvatarModelPaths } from "./avatarModelPaths.js";

export type AvatarImportErrorCode =
  | "AVATAR_GLB_INVALID"
  | "AVATAR_EXTERNAL_RESOURCE"
  | "AVATAR_REQUIRED_BONE_MISSING"
  | "AVATAR_PREVIEW_FAILED"
  | "AVATAR_DIGEST_MISMATCH"
  | "AVATAR_IMPORT_FAILED";

export class AvatarImportError extends Error {
  constructor(
    readonly code: AvatarImportErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "AvatarImportError";
  }
}

export interface AvatarPreviewRendererPort {
  render(input: {
    readonly modelPath: string;
    readonly outputPath: string;
    readonly mapping: AvatarBoneMapping;
  }): Promise<unknown>;
}

export interface AvatarModelImporterIo {
  lstat(path: string): Promise<Stats>;
  mkdir: typeof mkdir;
  open(path: string, flags: "r"): Promise<FileHandle>;
  readFile: typeof readFile;
  rename(source: string, destination: string): Promise<void>;
  rm: typeof rm;
  writeFile: typeof writeFile;
}

export const nodeAvatarModelImporterIo: AvatarModelImporterIo = {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
};

interface AvatarModelCatalogPort {
  appendImported(record: AvatarModelRecord): Promise<unknown>;
}

interface AvatarModelImporterOptions {
  readonly dataRoot: string;
  readonly catalog: AvatarModelCatalogPort | Pick<AvatarModelCatalog, "appendImported">;
  readonly previewRenderer: AvatarPreviewRendererPort;
  readonly createId?: () => string;
  readonly now?: () => Date;
  readonly io?: AvatarModelImporterIo;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class AvatarModelImporter {
  readonly #paths: AvatarModelPaths;
  readonly #catalog: AvatarModelCatalogPort;
  readonly #previewRenderer: AvatarPreviewRendererPort;
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #io: AvatarModelImporterIo;

  constructor(options: AvatarModelImporterOptions) {
    if (!isAbsolute(options.dataRoot)) throw new Error("invalid avatar importer data root");
    this.#paths = resolveAvatarModelPaths(resolve(options.dataRoot));
    this.#catalog = options.catalog;
    this.#previewRenderer = options.previewRenderer;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#io = options.io ?? nodeAvatarModelImporterIo;
  }

  async importFile(input: {
    readonly sourcePath: string;
    readonly displayName: string;
  }): Promise<AvatarModelRecord> {
    if (!isAbsolute(input.sourcePath)) {
      throw new AvatarImportError("AVATAR_IMPORT_FAILED", "avatar source path is invalid");
    }
    const uuid = this.#createId();
    if (!UUID_PATTERN.test(uuid)) {
      throw new AvatarImportError("AVATAR_IMPORT_FAILED", "avatar import id is invalid");
    }
    const modelId = `user:${uuid}`;
    const stagingDirectory = join(this.#paths.stagingRoot, uuid);
    const userRoot = join(this.#paths.root, "user");
    const managedDirectory = join(userRoot, uuid);
    let stagingOwned = false;
    let managedOwned = false;

    try {
      await Promise.all([
        this.#io.mkdir(this.#paths.stagingRoot, { recursive: true }),
        this.#io.mkdir(userRoot, { recursive: true }),
      ]);
      await this.#io.mkdir(stagingDirectory);
      stagingOwned = true;

      const sourceBytes = await readBoundedSource(this.#io, resolve(input.sourcePath));
      const parsed = parseGlbContainer(sourceBytes);
      const capabilities = mapAvatarBones(parsed);
      const digest = createHash("sha256").update(sourceBytes).digest("hex");
      const fileName = parsed.format === "vrm" ? "model.vrm" : "model.glb";
      const stagingModelPath = join(stagingDirectory, fileName);
      const stagingPreviewPath = join(stagingDirectory, "preview.png");
      await this.#io.writeFile(stagingModelPath, sourceBytes, { flag: "wx" });

      try {
        await this.#previewRenderer.render({
          modelPath: stagingModelPath,
          outputPath: stagingPreviewPath,
          mapping: capabilities.mapping,
        });
      } catch (error) {
        throw new AvatarImportError("AVATAR_PREVIEW_FAILED", "avatar preview generation failed", {
          cause: error,
        });
      }

      const timestamp = canonicalTimestamp(this.#now());
      const resourcePath = `user/${uuid}/${fileName}`;
      const record = parseAvatarModelRecord({
        id: modelId,
        displayName: sanitizeDisplayName(input.displayName),
        origin: "imported",
        format: parsed.format,
        resourcePath,
        sha256: digest,
        importedAt: timestamp,
        previewPath: `user/${uuid}/preview.png`,
        previewStatus: "ready",
        boneMapping: capabilities.mapping,
        bodyAnimation: "whitelily-humanoid-v1",
        expressions: capabilities.expressions,
        validation: { code: "AVATAR_VALID", validatedAt: timestamp },
      });
      await this.#io.writeFile(
        join(stagingDirectory, "record.json"),
        `${JSON.stringify(record, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await verifyStagedFiles(this.#io, stagingModelPath, stagingPreviewPath, digest);

      await this.#io.rename(stagingDirectory, managedDirectory);
      stagingOwned = false;
      managedOwned = true;
      await this.#catalog.appendImported(record);
      managedOwned = false;
      return record;
    } catch (error) {
      if (managedOwned) {
        await cleanupOwnedDirectory(this.#io, managedDirectory);
      } else if (stagingOwned) {
        await cleanupOwnedDirectory(this.#io, stagingDirectory);
      }
      throw wrapImportError(error);
    }
  }
}

async function readBoundedSource(io: AvatarModelImporterIo, path: string): Promise<Buffer> {
  const before = await io.lstat(path);
  requireStableRegularFile(before);
  const handle = await io.open(path, "r");
  try {
    const opened = await handle.stat();
    requireSameFile(before, opened);
    requireStableRegularFile(opened);
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    requireSameFile(opened, after);
    if (offset !== bytes.length) {
      throw new AvatarImportError("AVATAR_IMPORT_FAILED", "avatar source changed during import");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function requireStableRegularFile(stats: Stats): void {
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size <= 0 ||
    stats.size > MAX_AVATAR_SOURCE_BYTES
  ) {
    throw new AvatarImportError("AVATAR_IMPORT_FAILED", "avatar source file is invalid");
  }
}

function requireSameFile(left: Stats, right: Stats): void {
  if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size) {
    throw new AvatarImportError("AVATAR_IMPORT_FAILED", "avatar source changed during import");
  }
}

async function verifyStagedFiles(
  io: AvatarModelImporterIo,
  modelPath: string,
  previewPath: string,
  expectedDigest: string,
): Promise<void> {
  const modelBytes = await io.readFile(modelPath);
  if (createHash("sha256").update(modelBytes).digest("hex") !== expectedDigest) {
    throw new AvatarImportError("AVATAR_DIGEST_MISMATCH", "staged avatar digest is invalid");
  }
  const previewBytes = await io.readFile(previewPath);
  if (previewBytes.byteLength === 0 || previewBytes.byteLength > 2 * 1024 * 1024) {
    throw new AvatarImportError("AVATAR_PREVIEW_FAILED", "staged avatar preview is invalid");
  }
}

async function cleanupOwnedDirectory(io: AvatarModelImporterIo, path: string): Promise<void> {
  try {
    await io.rm(path, { recursive: true, force: true });
  } catch {
    // Cleanup failure must not replace the stable import error returned to the caller.
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
  return sanitized.length > 0 ? sanitized : "导入模型";
}

function canonicalTimestamp(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AvatarImportError("AVATAR_IMPORT_FAILED", "avatar import timestamp is invalid");
  }
  return value.toISOString();
}

function wrapImportError(error: unknown): AvatarImportError {
  if (error instanceof AvatarImportError) return error;
  if (error instanceof AvatarFileValidationError) {
    return new AvatarImportError(error.code, error.message, { cause: error });
  }
  return new AvatarImportError("AVATAR_IMPORT_FAILED", "avatar import failed", { cause: error });
}
