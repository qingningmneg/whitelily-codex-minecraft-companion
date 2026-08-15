import { join, resolve } from "node:path";
import { z } from "zod";
import type { AtomicJsonFileIo } from "../storage/atomicJsonFile.js";
import {
  DocumentStore,
  DocumentStoreError,
  type DocumentEnvelope,
} from "../storage/documentStore.js";

const FARMING_PREFERENCE_SCHEMA_VERSION = 1;
export const FARMING_PREFERENCE_FILENAME = "farming-preference.json";

export const farmingPreferenceSchema = z
  .object({
    status: z.enum(["unknown", "allowed", "denied"]),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type FarmingPreferenceStatus = z.infer<typeof farmingPreferenceSchema>["status"];
export type FarmingPreference = z.infer<typeof farmingPreferenceSchema>;

export interface FarmingPreferenceStoreOptions {
  readonly rootDirectory: string;
  readonly clock?: () => Date;
  readonly fileIo?: AtomicJsonFileIo;
}

export class FarmingPreferenceStore {
  readonly #clock: () => Date;
  readonly #document: DocumentStore<FarmingPreference>;

  constructor(options: FarmingPreferenceStoreOptions) {
    const rootDirectory = resolve(options.rootDirectory);
    this.#clock = options.clock ?? (() => new Date());
    this.#document = new DocumentStore({
      path: join(rootDirectory, FARMING_PREFERENCE_FILENAME),
      rootDirectory,
      schemaVersion: FARMING_PREFERENCE_SCHEMA_VERSION,
      valueSchema: farmingPreferenceSchema,
      defaultValue: () => ({ status: "unknown", updatedAt: this.#timestamp() }),
      clock: this.#clock,
      recoverFromBackup: false,
      ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
    });
  }

  read(): Promise<DocumentEnvelope<FarmingPreference>> {
    return this.#document.read();
  }

  setAllowed(expectedRevision: number): Promise<DocumentEnvelope<FarmingPreference>> {
    return this.#setStatus(expectedRevision, "allowed");
  }

  setDenied(expectedRevision: number): Promise<DocumentEnvelope<FarmingPreference>> {
    return this.#setStatus(expectedRevision, "denied");
  }

  #setStatus(
    expectedRevision: number,
    status: Exclude<FarmingPreferenceStatus, "unknown">,
  ): Promise<DocumentEnvelope<FarmingPreference>> {
    return this.#document.update(expectedRevision, () => ({
      status,
      updatedAt: this.#timestamp(),
    }));
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
}
