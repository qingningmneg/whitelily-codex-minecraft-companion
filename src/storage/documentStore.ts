import { resolve } from "node:path";
import type { z } from "zod";
import { AtomicJsonFile, AtomicJsonFileError, type AtomicJsonFileIo } from "./atomicJsonFile.js";
import { createDocumentEnvelopeSchema } from "./schemas.js";

export interface DocumentEnvelope<T> {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  value: T;
}

export type DocumentStoreErrorCode =
  | "DOCUMENT_ALREADY_EXISTS"
  | "DOCUMENT_CONFLICT"
  | "DOCUMENT_INVALID"
  | "DOCUMENT_INVALID_TIMESTAMP"
  | "DOCUMENT_REVISION_OVERFLOW"
  | "DOCUMENT_SCHEMA_UNSUPPORTED"
  | "DOCUMENT_VALUE_INVALID";

export class DocumentStoreError extends Error {
  constructor(
    readonly code: DocumentStoreErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "DocumentStoreError";
  }
}

export interface DocumentStoreOptions<T> {
  path: string;
  rootDirectory: string;
  schemaVersion: number;
  valueSchema: z.ZodType<T>;
  defaultValue(): T;
  clock?: () => Date;
  fileIo?: AtomicJsonFileIo;
  recoverFrom?: (error: AtomicJsonFileError) => boolean;
}

const documentQueues = new Map<string, Promise<unknown>>();

function serializeDocumentOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = documentQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  documentQueues.set(path, current);
  return current.finally(() => {
    if (documentQueues.get(path) === current) documentQueues.delete(path);
  });
}

function unwrapDocumentError(error: unknown): never {
  if (
    error instanceof AtomicJsonFileError &&
    error.code === "ATOMIC_JSON_INVALID" &&
    error.cause instanceof DocumentStoreError
  ) {
    throw error.cause;
  }
  throw error;
}

export class DocumentStore<T> {
  readonly #schemaVersion: number;
  readonly #valueSchema: z.ZodType<T>;
  readonly #defaultValue: () => T;
  readonly #clock: () => Date;
  readonly #file: AtomicJsonFile<DocumentEnvelope<T>>;
  #coordinatorKey: Promise<string> | undefined;

  constructor(options: DocumentStoreOptions<T>) {
    if (!Number.isSafeInteger(options.schemaVersion) || options.schemaVersion < 1) {
      throw new DocumentStoreError("DOCUMENT_INVALID", "document schema version is invalid");
    }
    const path = resolve(options.path);
    this.#schemaVersion = options.schemaVersion;
    this.#valueSchema = options.valueSchema;
    this.#defaultValue = options.defaultValue;
    this.#clock = options.clock ?? (() => new Date());
    this.#file = new AtomicJsonFile({
      path,
      rootDirectory: options.rootDirectory,
      validate: (value) => this.#validateEnvelope(value),
      ...(options.fileIo === undefined ? {} : { io: options.fileIo }),
      recoverFrom:
        options.recoverFrom ??
        ((error) =>
          !(
            error.cause instanceof DocumentStoreError &&
            error.cause.code === "DOCUMENT_SCHEMA_UNSUPPORTED"
          )),
    });
  }

  read(): Promise<DocumentEnvelope<T>> {
    return this.#coordinate(async () => {
      const persisted = await this.#readPersisted();
      return persisted ?? this.#newEnvelope(0, this.#validateValue(this.#defaultValue()));
    });
  }

  create(value?: T): Promise<DocumentEnvelope<T>> {
    return this.#coordinate(async () => {
      if ((await this.#readPersisted()) !== undefined) {
        throw new DocumentStoreError("DOCUMENT_ALREADY_EXISTS", "document already exists");
      }
      const created = this.#newEnvelope(
        0,
        this.#validateValue(value === undefined ? this.#defaultValue() : value),
      );
      return this.#clone(await this.#file.write(created));
    });
  }

  update(
    expectedRevision: number,
    updater: (current: Readonly<T>) => T | Promise<T>,
  ): Promise<DocumentEnvelope<T>> {
    return this.#coordinate(async () => {
      const current =
        (await this.#readPersisted()) ??
        this.#newEnvelope(0, this.#validateValue(this.#defaultValue()));
      this.#assertExpectedRevision(expectedRevision, current.revision);
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new DocumentStoreError(
          "DOCUMENT_REVISION_OVERFLOW",
          "document revision cannot be incremented",
        );
      }
      const value = this.#validateValue(await updater(this.#clone(current.value)));
      return this.#clone(await this.#file.write(this.#newEnvelope(current.revision + 1, value)));
    });
  }

  replace(expectedRevision: number, value: T): Promise<DocumentEnvelope<T>> {
    return this.update(expectedRevision, () => value);
  }

  async #coordinate<V>(operation: () => Promise<V>): Promise<V> {
    const keyPromise =
      this.#coordinatorKey ??
      (this.#coordinatorKey = this.#file.coordinatorKey().catch((error: unknown) => {
        this.#coordinatorKey = undefined;
        throw error;
      }));
    const key = await keyPromise;
    return serializeDocumentOperation(key, operation);
  }

  async #readPersisted(): Promise<DocumentEnvelope<T> | undefined> {
    try {
      const document = await this.#file.read();
      return document === undefined ? undefined : this.#clone(document);
    } catch (error) {
      unwrapDocumentError(error);
    }
  }

  #validateEnvelope(value: unknown): DocumentEnvelope<T> {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "schemaVersion" in value &&
      typeof value.schemaVersion === "number" &&
      Number.isSafeInteger(value.schemaVersion) &&
      value.schemaVersion !== this.#schemaVersion
    ) {
      throw new DocumentStoreError(
        "DOCUMENT_SCHEMA_UNSUPPORTED",
        "document schema version is unsupported",
      );
    }
    const parsed = createDocumentEnvelopeSchema(this.#schemaVersion, this.#valueSchema).safeParse(
      value,
    );
    if (!parsed.success) {
      throw new DocumentStoreError("DOCUMENT_INVALID", "document envelope is invalid", {
        cause: parsed.error,
      });
    }
    return this.#clone(parsed.data);
  }

  #validateValue(value: unknown): T {
    const parsed = this.#valueSchema.safeParse(value);
    if (!parsed.success) {
      throw new DocumentStoreError("DOCUMENT_VALUE_INVALID", "document value is invalid", {
        cause: parsed.error,
      });
    }
    return this.#clone(parsed.data);
  }

  #newEnvelope(revision: number, value: T): DocumentEnvelope<T> {
    return this.#validateEnvelope({
      schemaVersion: this.#schemaVersion,
      revision,
      updatedAt: this.#timestamp(),
      value,
    });
  }

  #timestamp(): string {
    try {
      const timestamp = this.#clock().toISOString();
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp) ||
        new Date(timestamp).toISOString() !== timestamp
      ) {
        throw new Error("timestamp is not canonical UTC");
      }
      return timestamp;
    } catch (error) {
      throw new DocumentStoreError(
        "DOCUMENT_INVALID_TIMESTAMP",
        "document clock returned an invalid timestamp",
        { cause: error },
      );
    }
  }

  #assertExpectedRevision(expected: number, actual: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0 || expected !== actual) {
      throw new DocumentStoreError("DOCUMENT_CONFLICT", "document revision conflict");
    }
  }

  #clone<V>(value: V): V {
    return structuredClone(value);
  }
}
