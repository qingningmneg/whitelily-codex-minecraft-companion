import { join } from "node:path";
import { z } from "zod";
import {
  DocumentStore,
  DocumentStoreError,
  type DocumentEnvelope,
} from "../../../src/storage/documentStore.js";

export interface DesktopPreferenceValue {
  closeToTray: boolean;
}

const desktopPreferenceSchema = z.object({ closeToTray: z.boolean() }).strict();

export class DesktopPreferences {
  readonly #store: DocumentStore<DesktopPreferenceValue>;

  constructor(options: { rootDirectory: string }) {
    this.#store = new DocumentStore({
      path: join(options.rootDirectory, "desktop-preferences.json"),
      rootDirectory: options.rootDirectory,
      schemaVersion: 1,
      valueSchema: desktopPreferenceSchema,
      defaultValue: () => ({ closeToTray: true }),
      recoverFrom: () => false,
    });
  }

  async read(): Promise<DocumentEnvelope<DesktopPreferenceValue>> {
    try {
      return await this.#store.read();
    } catch (error) {
      if (error instanceof DocumentStoreError) throw error;
      throw new DocumentStoreError("DOCUMENT_INVALID", "desktop preferences are invalid", {
        cause: error,
      });
    }
  }

  setCloseToTray(
    expectedRevision: number,
    closeToTray: boolean,
  ): Promise<DocumentEnvelope<DesktopPreferenceValue>> {
    return this.#store.replace(expectedRevision, { closeToTray });
  }
}
