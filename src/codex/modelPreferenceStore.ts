import { join, resolve } from "node:path";
import { z } from "zod";
import type { AtomicJsonFileIo } from "../storage/atomicJsonFile.js";
import {
  DocumentStore,
  DocumentStoreError,
  type DocumentEnvelope,
} from "../storage/documentStore.js";

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REASONING_EFFORT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const MODEL_PREFERENCE_SCHEMA_VERSION = 1;
const MODEL_PREFERENCE_FILENAME = "model-preference.json";

export const persistedModelPreferenceSchema = z
  .object({
    selection: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("automatic") }).strict(),
      z
        .object({
          mode: z.literal("explicit"),
          modelId: z.string().regex(MODEL_ID_PATTERN),
          reasoningEffort: z.string().regex(REASONING_EFFORT_PATTERN),
        })
        .strict(),
    ]),
    legacyMigrationCompleted: z.boolean(),
  })
  .strict();

export type PersistedModelPreferenceSelection =
  | Readonly<{ mode: "automatic" }>
  | Readonly<{ mode: "explicit"; modelId: string; reasoningEffort: string }>;

export interface PersistedModelPreference {
  readonly selection: PersistedModelPreferenceSelection;
  readonly legacyMigrationCompleted: boolean;
}

export interface LegacyModelPreferenceCandidate {
  readonly mode: "explicit";
  readonly modelId: string;
  readonly reasoningEffort: string;
}

export interface LegacyMigrationInput {
  readonly ui?: LegacyModelPreferenceCandidate;
  readonly config?: LegacyModelPreferenceCandidate;
  readonly validate: (candidate: LegacyModelPreferenceCandidate) => Promise<boolean>;
}

export interface ModelPreferenceStoreOptions {
  readonly rootDirectory: string;
  readonly clock?: () => Date;
  readonly fileIo?: AtomicJsonFileIo;
}

const legacyCandidateSchema = z
  .object({
    mode: z.literal("explicit"),
    modelId: z.string().regex(MODEL_ID_PATTERN),
    reasoningEffort: z.string().regex(REASONING_EFFORT_PATTERN),
  })
  .strict();

export class ModelPreferenceStore {
  readonly #document: DocumentStore<PersistedModelPreference>;

  constructor(options: ModelPreferenceStoreOptions) {
    const rootDirectory = resolve(options.rootDirectory);
    this.#document = new DocumentStore({
      path: join(rootDirectory, MODEL_PREFERENCE_FILENAME),
      rootDirectory,
      schemaVersion: MODEL_PREFERENCE_SCHEMA_VERSION,
      valueSchema: persistedModelPreferenceSchema,
      defaultValue: () => ({
        selection: { mode: "automatic" },
        legacyMigrationCompleted: false,
      }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
    });
  }

  read(): Promise<DocumentEnvelope<PersistedModelPreference>> {
    return this.#document.read();
  }

  replace(
    expectedRevision: number,
    value: PersistedModelPreference,
  ): Promise<DocumentEnvelope<PersistedModelPreference>> {
    return this.#document.update(expectedRevision, (current) => {
      if (current.legacyMigrationCompleted && !value.legacyMigrationCompleted) {
        throw new DocumentStoreError(
          "DOCUMENT_VALUE_INVALID",
          "legacy model preference migration cannot be reopened",
        );
      }
      return value;
    });
  }

  migrateLegacyOnce(
    expectedRevision: number,
    input: LegacyMigrationInput,
  ): Promise<DocumentEnvelope<PersistedModelPreference>> {
    return this.#document.update(expectedRevision, async (current) => {
      if (current.legacyMigrationCompleted) {
        throw new DocumentStoreError(
          "DOCUMENT_CONFLICT",
          "legacy model preference migration is complete",
        );
      }
      return {
        selection: await this.#firstValidLegacySelection(input),
        legacyMigrationCompleted: true,
      };
    });
  }

  async #firstValidLegacySelection(
    input: LegacyMigrationInput,
  ): Promise<PersistedModelPreferenceSelection> {
    for (const candidate of [input.ui, input.config]) {
      const parsed = legacyCandidateSchema.safeParse(candidate);
      if (!parsed.success) continue;
      try {
        if (await input.validate(parsed.data)) return parsed.data;
      } catch {
        // An unverified legacy selection is not a valid migration candidate.
      }
    }
    return { mode: "automatic" };
  }
}
