import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  BUILTIN_AVATAR_MODEL_IDS,
  parseAvatarModelRecord,
  type AvatarAppearanceRecord,
  type AvatarModelCatalogState,
  type AvatarRuntimeDescriptor,
} from "../../../../src/avatar/avatarModelSchemas.js";
import { AtomicJsonFile } from "../../../../src/storage/atomicJsonFile.js";
import { resolveAvatarModelPaths, type AvatarModelPaths } from "./avatarModelPaths.js";
import { readVerifiedAvatarResource } from "./verifiedAvatarResourceReader.js";

export type AvatarModelCatalogErrorCode =
  | "AVATAR_CATALOG_INVALID"
  | "AVATAR_CATALOG_LEGACY_MODEL_SKIPPED"
  | "AVATAR_MODEL_DUPLICATE"
  | "AVATAR_MODEL_FILE_INVALID"
  | "AVATAR_DIGEST_MISMATCH"
  | "AVATAR_MODEL_NOT_FOUND";

export interface AvatarModelCatalogDiagnostic {
  readonly code: AvatarModelCatalogErrorCode;
  readonly modelId: string;
}

export class AvatarModelCatalogError extends Error {
  constructor(
    readonly code: AvatarModelCatalogErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "AvatarModelCatalogError";
  }
}

interface AvatarModelCatalogDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly imported: readonly unknown[];
}

interface AvatarModelCatalogOptions {
  readonly dataRoot: string;
  readonly builtinModels: AvatarAppearanceRecord;
  readonly diagnostic?: (diagnostic: AvatarModelCatalogDiagnostic) => void;
}

const catalogQueues = new Map<string, Promise<unknown>>();

export class AvatarModelCatalog {
  readonly #paths: AvatarModelPaths;
  readonly #file: AtomicJsonFile<AvatarModelCatalogDocument>;
  readonly #builtinModel: AvatarAppearanceRecord;
  readonly #diagnostic: (diagnostic: AvatarModelCatalogDiagnostic) => void;
  readonly #reportedLegacyRecordIds = new Set<string>();
  #initialized = false;
  #catalogUnavailable = false;
  #catalogFailureReported = false;

  constructor(options: AvatarModelCatalogOptions) {
    if (!isAbsolute(options.dataRoot)) throw new Error("invalid avatar model catalog root");
    this.#paths = resolveAvatarModelPaths(options.dataRoot);
    const builtin = parseAvatarModelRecord(options.builtinModels);
    if (builtin.id !== BUILTIN_AVATAR_MODEL_IDS[0] || builtin.origin !== "builtin") {
      throw new Error("invalid builtin avatar model catalog");
    }
    this.#builtinModel = Object.freeze(builtin);
    this.#diagnostic = options.diagnostic ?? (() => undefined);
    this.#file = new AtomicJsonFile({
      rootDirectory: resolve(options.dataRoot),
      path: this.#paths.catalogPath,
      validate: validateCatalogDocument,
      recoverFrom: () => false,
    });
  }

  async initialize(): Promise<this> {
    if (this.#initialized) return this;
    await Promise.all([
      mkdir(this.#paths.root, { recursive: true }),
      mkdir(this.#paths.stagingRoot, { recursive: true }),
      mkdir(this.#paths.bridgeRoot, { recursive: true }),
    ]);
    try {
      await this.#file.writeIfAbsent({ schemaVersion: 1, revision: 0, imported: [] });
    } catch (error) {
      this.#markCatalogUnavailable(error);
    }
    this.#initialized = true;
    return this;
  }

  async list(): Promise<AvatarModelCatalogState> {
    await this.initialize();
    if (this.#catalogUnavailable) return this.#builtinOnlyState();
    let document: AvatarModelCatalogDocument;
    try {
      document = await this.#readDocument();
    } catch (error) {
      this.#markCatalogUnavailable(error);
      return this.#builtinOnlyState();
    }
    const imported: AvatarAppearanceRecord[] = [];
    const seenIds = new Set([this.#builtinModel.id]);
    for (const candidate of document.imported) {
      let record: AvatarAppearanceRecord;
      try {
        record = parseAvatarModelRecord(candidate);
      } catch {
        this.#reportLegacyRecord(candidate);
        continue;
      }
      if (record.origin !== "imported" || seenIds.has(record.id)) {
        this.#reportInvalidRecord(record.id);
        continue;
      }
      seenIds.add(record.id);
      try {
        await this.#validateManagedRecord(record);
        imported.push(record);
      } catch (error) {
        const failure = asCatalogError(error);
        this.#diagnostic({ code: failure.code, modelId: record.id });
      }
    }
    return Object.freeze({
      revision: document.revision,
      models: Object.freeze([this.#builtinModel, ...imported]),
    });
  }

  async appendImported(record: AvatarAppearanceRecord): Promise<AvatarModelCatalogState> {
    await this.initialize();
    if (this.#catalogUnavailable) {
      throw new AvatarModelCatalogError(
        "AVATAR_CATALOG_INVALID",
        "avatar model catalog is unavailable",
      );
    }
    const validated = parseAvatarModelRecord(record);
    if (validated.origin !== "imported") {
      throw new AvatarModelCatalogError(
        "AVATAR_MODEL_FILE_INVALID",
        "only imported avatar models can be appended",
      );
    }
    await this.#validateManagedRecord(validated);
    const key = await this.#file.coordinatorKey();
    return serializeCatalogOperation(key, async () => {
      const current = await this.#readDocument();
      if (
        this.#builtinModel.id === validated.id ||
        current.imported.some((candidate) => recordId(candidate) === validated.id)
      ) {
        throw new AvatarModelCatalogError(
          "AVATAR_MODEL_DUPLICATE",
          "avatar model id already exists",
        );
      }
      await this.#file.write({
        schemaVersion: 1,
        revision: current.revision + 1,
        imported: [...current.imported, validated],
      });
      return this.list();
    });
  }

  async has(modelId: string): Promise<boolean> {
    return (await this.list()).models.some(({ id }) => id === modelId);
  }

  async resolveRuntimeDescriptor(modelId: string): Promise<AvatarRuntimeDescriptor> {
    const record = (await this.list()).models.find(({ id }) => id === modelId);
    if (record === undefined) {
      throw new AvatarModelCatalogError("AVATAR_MODEL_NOT_FOUND", "avatar model is unavailable");
    }
    return Object.freeze({
      modelId: record.id,
      origin: record.origin,
      worldRenderer: record.worldRenderer,
      armModel: record.armModel,
    });
  }

  async #readDocument(): Promise<AvatarModelCatalogDocument> {
    try {
      const document = await this.#file.read();
      if (document === undefined) throw new Error("avatar model catalog is missing");
      return document;
    } catch (error) {
      throw new AvatarModelCatalogError(
        "AVATAR_CATALOG_INVALID",
        "avatar model catalog is invalid",
        { cause: error },
      );
    }
  }

  #markCatalogUnavailable(error: unknown): void {
    this.#catalogUnavailable = true;
    if (this.#catalogFailureReported) return;
    this.#catalogFailureReported = true;
    const failure =
      error instanceof AvatarModelCatalogError
        ? error
        : new AvatarModelCatalogError(
            "AVATAR_CATALOG_INVALID",
            "avatar model catalog is invalid",
            { cause: error },
          );
    this.#diagnostic({ code: failure.code, modelId: "catalog" });
  }

  #builtinOnlyState(): AvatarModelCatalogState {
    return Object.freeze({
      revision: 0,
      models: Object.freeze([this.#builtinModel]),
    });
  }

  #reportLegacyRecord(record: unknown): void {
    const modelId = recordId(record) ?? "legacy";
    this.#reportSkippedRecord("AVATAR_CATALOG_LEGACY_MODEL_SKIPPED", modelId);
  }

  #reportInvalidRecord(modelId: string): void {
    this.#reportSkippedRecord("AVATAR_CATALOG_INVALID", diagnosticModelId(modelId));
  }

  #reportSkippedRecord(code: AvatarModelCatalogErrorCode, modelId: string): void {
    if (this.#reportedLegacyRecordIds.has(modelId)) return;
    this.#reportedLegacyRecordIds.add(modelId);
    this.#diagnostic({ code, modelId });
  }

  async #validateManagedRecord(record: AvatarAppearanceRecord): Promise<void> {
    try {
      const skinBytes = await readVerifiedAvatarResource({
        root: this.#paths.root,
        relativePath: record.skinAsset,
        maximumBytes: 2 * 1024 * 1024,
      });
      if (digest(skinBytes) !== record.skinSha256) {
        throw new AvatarModelCatalogError("AVATAR_DIGEST_MISMATCH", "avatar skin digest changed");
      }
      if (record.portraitAsset !== undefined && record.portraitSha256 !== undefined) {
        const portraitBytes = await readVerifiedAvatarResource({
          root: this.#paths.root,
          relativePath: record.portraitAsset,
          maximumBytes: 2 * 1024 * 1024,
        });
        if (digest(portraitBytes) !== record.portraitSha256) {
          throw new AvatarModelCatalogError(
            "AVATAR_DIGEST_MISMATCH",
            "avatar portrait digest changed",
          );
        }
      }
    } catch (error) {
      if (error instanceof AvatarModelCatalogError) throw error;
      throw new AvatarModelCatalogError(
        "AVATAR_MODEL_FILE_INVALID",
        "avatar model managed files are invalid",
        { cause: error },
      );
    }
  }
}

async function serializeCatalogOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = catalogQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  catalogQueues.set(key, current);
  return current.finally(() => {
    if (catalogQueues.get(key) === current) catalogQueues.delete(key);
  });
}

function validateCatalogDocument(value: unknown): AvatarModelCatalogDocument {
  if (
    !isPlainObject(value) ||
    Object.keys(value).sort().join(",") !== "imported,revision,schemaVersion" ||
    Reflect.get(value, "schemaVersion") !== 1 ||
    !Number.isSafeInteger(Reflect.get(value, "revision")) ||
    (Reflect.get(value, "revision") as number) < 0 ||
    !Array.isArray(Reflect.get(value, "imported"))
  ) {
    throw new Error("invalid avatar model catalog document");
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: Reflect.get(value, "revision") as number,
    imported: Object.freeze([...((Reflect.get(value, "imported") as unknown[]))]),
  });
}

function recordId(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = Reflect.get(value, "id");
  return typeof id === "string" && USER_AVATAR_MODEL_ID_PATTERN.test(id) ? id : undefined;
}

const USER_AVATAR_MODEL_ID_PATTERN =
  /^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function diagnosticModelId(value: string): string {
  return USER_AVATAR_MODEL_ID_PATTERN.test(value) ? value : "legacy";
}

function digest(bytes: Buffer): string {
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

function asCatalogError(error: unknown): AvatarModelCatalogError {
  return error instanceof AvatarModelCatalogError
    ? error
    : new AvatarModelCatalogError(
        "AVATAR_MODEL_FILE_INVALID",
        "avatar model managed files are invalid",
        { cause: error },
      );
}
