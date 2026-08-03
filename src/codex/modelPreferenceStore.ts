import { join, resolve } from "node:path";
import { z } from "zod";
import type { AtomicJsonFileIo } from "../storage/atomicJsonFile.js";
import { MODEL_ID_PATTERN } from "./modelId.js";
import {
  DocumentStore,
  DocumentStoreError,
  type DocumentEnvelope,
} from "../storage/documentStore.js";

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

export interface RecoverableModelPreferenceUpdate {
  readonly envelope: DocumentEnvelope<PersistedModelPreference>;
  restore(): Promise<DocumentEnvelope<PersistedModelPreference>>;
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

  replaceRecoverably(
    expectedRevision: number,
    value: PersistedModelPreference,
  ): Promise<RecoverableModelPreferenceUpdate> {
    return this.#recoverableUpdate(expectedRevision, () => this.replace(expectedRevision, value));
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

  migrateLegacyOnceRecoverably(
    expectedRevision: number,
    input: LegacyMigrationInput,
  ): Promise<RecoverableModelPreferenceUpdate> {
    return this.#recoverableUpdate(expectedRevision, () =>
      this.migrateLegacyOnce(expectedRevision, input),
    );
  }

  async #recoverableUpdate(
    expectedRevision: number,
    update: () => Promise<DocumentEnvelope<PersistedModelPreference>>,
  ): Promise<RecoverableModelPreferenceUpdate> {
    const before = await this.read();
    if (before.revision !== expectedRevision) {
      throw new DocumentStoreError("DOCUMENT_CONFLICT", "document revision conflict");
    }
    const committed = await update();
    let restored = false;
    return Object.freeze({
      envelope: committed,
      restore: async () => {
        if (restored) {
          throw new DocumentStoreError("DOCUMENT_CONFLICT", "document revision conflict");
        }
        const current = await this.read();
        if (!sameEnvelope(current, committed)) {
          throw new DocumentStoreError("DOCUMENT_CONFLICT", "document revision conflict");
        }
        const recovery = await this.#document.replace(committed.revision, before.value);
        restored = true;
        return recovery;
      },
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

function sameEnvelope(
  left: DocumentEnvelope<PersistedModelPreference>,
  right: DocumentEnvelope<PersistedModelPreference>,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.revision === right.revision &&
    left.updatedAt === right.updatedAt &&
    samePreference(left.value, right.value)
  );
}

function samePreference(left: PersistedModelPreference, right: PersistedModelPreference): boolean {
  return (
    left.legacyMigrationCompleted === right.legacyMigrationCompleted &&
    left.selection.mode === right.selection.mode &&
    (left.selection.mode === "automatic" ||
      (right.selection.mode === "explicit" &&
        left.selection.modelId === right.selection.modelId &&
        left.selection.reasoningEffort === right.selection.reasoningEffort))
  );
}
