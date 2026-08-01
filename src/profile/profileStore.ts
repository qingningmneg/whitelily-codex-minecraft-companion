import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { AtomicJsonFileIo } from "../storage/atomicJsonFile.js";
import {
  DocumentStore,
  DocumentStoreError,
  type DocumentEnvelope,
} from "../storage/documentStore.js";
import type { CompanionMode } from "../domain/types.js";
import {
  behaviorModeSettingsSchema,
  companionProfileSchema,
  createDefaultCompanionProfile,
  withBehaviorMode,
  type BehaviorModeSettings,
  type CompanionProfile,
} from "./profileSchema.js";

const PROFILE_SCHEMA_VERSION = 1;
const ACTIVE_PROFILE_FILENAME = "active-profile.json";

export interface ProfileStoreOptions {
  rootDirectory: string;
  createProfileId?: () => string;
  clock?: () => Date;
  fileIo?: AtomicJsonFileIo;
}

export class ProfileStore {
  readonly #document: DocumentStore<CompanionProfile>;

  constructor(options: ProfileStoreOptions) {
    const rootDirectory = resolve(options.rootDirectory);
    const createProfileId = options.createProfileId ?? randomUUID;
    this.#document = new DocumentStore({
      path: join(rootDirectory, ACTIVE_PROFILE_FILENAME),
      rootDirectory,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      valueSchema: companionProfileSchema,
      defaultValue: () => createDefaultCompanionProfile(createProfileId()),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
    });
  }

  async read(): Promise<DocumentEnvelope<CompanionProfile>> {
    try {
      return await this.#document.create();
    } catch (error) {
      if (error instanceof DocumentStoreError && error.code === "DOCUMENT_ALREADY_EXISTS") {
        return this.#document.read();
      }
      throw error;
    }
  }

  update(
    expectedRevision: number,
    profile: CompanionProfile,
  ): Promise<DocumentEnvelope<CompanionProfile>> {
    return this.#document.replace(expectedRevision, profile);
  }

  setBehaviorMode(
    expectedRevision: number,
    mode: CompanionMode,
    settings: BehaviorModeSettings,
  ): Promise<DocumentEnvelope<CompanionProfile>> {
    const safeSettings = behaviorModeSettingsSchema.parse(settings);
    return this.#document.update(expectedRevision, (current) =>
      withBehaviorMode(current as CompanionProfile, mode, safeSettings),
    );
  }
}
