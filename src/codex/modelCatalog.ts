import type { AccountSnapshot } from "./accountService.js";
import type { Model } from "./generated/v2/Model.js";
import { MODEL_ID_PATTERN } from "./modelId.js";
import type {
  LegacyModelPreferenceCandidate,
  ModelPreferenceStore,
  PersistedModelPreference,
  PersistedModelPreferenceSelection,
  RecoverableModelPreferenceUpdate,
} from "./modelPreferenceStore.js";
import { DocumentStoreError, type DocumentEnvelope } from "../storage/documentStore.js";

const REASONING_EFFORT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const MAX_LIVE_MODELS = 256;
const MAX_REASONING_EFFORTS = 32;
const MAX_DISPLAY_NAME_CODE_POINTS = 160;

export interface AvailableModel {
  id: string;
  displayName: string;
  supportedReasoningEfforts: readonly string[];
}

export type ModelSelection =
  | { mode: "automatic" }
  | {
      mode: "explicit";
      modelId: string;
      reasoningEffort: string;
      available: true;
    };

export type ModelSelectionInput =
  { mode: "automatic" } | { mode: "explicit"; modelId: string; reasoningEffort: string };

export interface ModelCatalogSnapshot {
  models: readonly AvailableModel[];
  selection: ModelSelection;
  legacyMigrationCompleted: boolean;
}

export interface ResolvedModelSelection {
  readonly modelId: string;
  readonly reasoningEffort: string;
}

export interface PreparedModelSelection {
  readonly preferenceRevision: number;
  readonly requested: ModelSelectionInput;
  readonly resolved: ResolvedModelSelection;
}

export type ModelCatalogEvent =
  | { readonly kind: "selection_changed"; readonly selection: ModelSelection }
  | {
      readonly kind: "selection_invalidated";
      readonly reason: "model_unavailable" | "account_lost";
    };

export interface ResolveRuntimeSelectionOptions {
  readonly signal?: AbortSignal;
}

export interface ModelCatalogAppServerPort {
  listModelRecords(): Promise<readonly Model[]>;
}

export interface ModelCatalogAccountPort {
  getAccount(): Promise<AccountSnapshot>;
  subscribe(listener: (snapshot: AccountSnapshot) => void): () => void;
}

export interface ModelCatalogPersistenceDependencies {
  readonly store: ModelPreferenceStore;
  readonly legacyConfigCandidate: LegacyModelPreferenceCandidate;
}

interface NormalizedModels {
  readonly models: readonly AvailableModel[];
  readonly automaticSelection: ResolvedModelSelection | undefined;
}

interface FetchedModels {
  readonly normalized: NormalizedModels;
  readonly accountGeneration: number;
}

export class ModelCatalog {
  readonly #appServer: ModelCatalogAppServerPort;
  readonly #account: ModelCatalogAccountPort;
  readonly #persistence: ModelCatalogPersistenceDependencies | undefined;
  readonly #unsubscribeAccount: () => void;
  readonly #listeners = new Set<(event: ModelCatalogEvent) => void>();
  #models: readonly AvailableModel[] = [];
  #automaticSelection: ResolvedModelSelection | undefined;
  #selection: ModelSelection = { mode: "automatic" };
  #legacyMigrationCompleted = false;
  #volatilePreferenceRevision = 0;
  #accountGeneration = 0;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(
    appServer: ModelCatalogAppServerPort,
    account: ModelCatalogAccountPort,
    persistence?: ModelCatalogPersistenceDependencies,
  ) {
    this.#appServer = appServer;
    this.#account = account;
    this.#persistence = persistence;
    this.#unsubscribeAccount = account.subscribe((snapshot) => {
      this.#accountGeneration += 1;
      if (snapshot.status !== "signed_in") {
        const hadAuthority = this.#models.length > 0 || this.#selection.mode === "explicit";
        this.#models = [];
        this.#automaticSelection = undefined;
        this.#selection = { mode: "automatic" };
        if (hadAuthority) {
          this.#notify({ kind: "selection_invalidated", reason: "account_lost" });
        }
      }
    });
  }

  listModels(): Promise<ModelCatalogSnapshot> {
    return this.#queue(() => this.#refresh());
  }

  selectModel(input: ModelSelectionInput): Promise<ModelSelection> {
    return this.#queue(async () => this.#commitPrepared(await this.#prepare(input)));
  }

  prepareSelection(input: ModelSelectionInput): Promise<PreparedModelSelection> {
    return this.#queue(() => this.#prepare(input));
  }

  commitSelection(prepared: PreparedModelSelection): Promise<ModelSelection> {
    return this.#queue(() => this.#commitPrepared(prepared));
  }

  migrateLegacyPreference(candidate: ModelSelectionInput | null): Promise<ModelCatalogSnapshot> {
    return this.#queue(async () => {
      const { normalized, accountGeneration: generation } = await this.#fetchModels();
      let preference = await this.#readPreference();
      let pendingMigrationUpdate: RecoverableModelPreferenceUpdate | undefined;
      await this.#assertCurrentAccount(generation);
      if (!preference.value.legacyMigrationCompleted) {
        if (this.#persistence) {
          try {
            const migrated = await this.#persistence.store.migrateLegacyOnceRecoverably(
              preference.revision,
              {
                ...(candidate?.mode === "explicit" ? { ui: candidate } : {}),
                config: this.#persistence.legacyConfigCandidate,
                validate: async (legacyCandidate) =>
                  resolveExplicitSelection(normalized.models, legacyCandidate) !== undefined,
              },
            );
            await this.#verifyDurableUpdate(generation, migrated);
            preference = migrated.envelope;
            pendingMigrationUpdate = migrated;
          } catch (error) {
            if (!(error instanceof DocumentStoreError) || error.code !== "DOCUMENT_CONFLICT") {
              throw error;
            }
            preference = await this.#persistence.store.read();
            await this.#assertCurrentAccount(generation);
            if (!preference.value.legacyMigrationCompleted) throw error;
          }
        } else {
          const migrated =
            candidate?.mode === "explicit" &&
            resolveExplicitSelection(normalized.models, candidate) !== undefined
              ? candidate
              : ({ mode: "automatic" } as const);
          this.#volatilePreferenceRevision += 1;
          preference = this.#volatilePreference(migrated, true);
        }
      }
      return this.#applyRefresh(
        normalized,
        preference,
        true,
        generation,
        undefined,
        pendingMigrationUpdate,
      );
    });
  }

  resolveRuntimeSelection(
    options: ResolveRuntimeSelectionOptions = {},
  ): Promise<ResolvedModelSelection> {
    return this.#queue(async () => {
      const snapshot = await this.#refresh(options.signal);
      if (snapshot.selection.mode === "explicit") {
        return Object.freeze({
          modelId: snapshot.selection.modelId,
          reasoningEffort: snapshot.selection.reasoningEffort,
        });
      }
      if (!this.#automaticSelection) {
        throw new Error("Automatic model selection is unavailable");
      }
      return this.#automaticSelection;
    }, options.signal);
  }

  subscribe(listener: (event: ModelCatalogEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  stop(): void {
    this.#unsubscribeAccount();
    this.#models = [];
    this.#automaticSelection = undefined;
    this.#selection = { mode: "automatic" };
    this.#listeners.clear();
  }

  async #refresh(signal?: AbortSignal): Promise<ModelCatalogSnapshot> {
    const { normalized, accountGeneration: generation } = await this.#fetchModels(signal);
    const preference = await this.#readPreference();
    await this.#assertCurrentAccount(generation, signal);
    return this.#applyRefresh(normalized, preference, true, generation, signal);
  }

  async #fetchModels(signal?: AbortSignal): Promise<FetchedModels> {
    throwIfAborted(signal);
    await this.#assertSignedIn(signal);
    const generation = this.#accountGeneration;
    const records = await this.#appServer.listModelRecords().catch(() => {
      throw new Error("Model catalog is unavailable");
    });
    throwIfAborted(signal);
    if (generation !== this.#accountGeneration) {
      throw new Error("ChatGPT authentication is required");
    }
    await this.#assertSignedIn(signal);
    throwIfAborted(signal);
    return {
      normalized: normalizeModels(records),
      accountGeneration: generation,
    };
  }

  async #prepare(input: ModelSelectionInput): Promise<PreparedModelSelection> {
    const { normalized, accountGeneration: generation } = await this.#fetchModels();
    const preference = await this.#readPreference();
    await this.#assertCurrentAccount(generation);
    return Object.freeze({
      preferenceRevision: preference.revision,
      requested: Object.freeze({ ...input }),
      resolved: resolveSelectionInput(normalized, input),
    });
  }

  async #commitPrepared(prepared: PreparedModelSelection): Promise<ModelSelection> {
    const generation = this.#accountGeneration;
    await this.#assertSignedIn();
    const current = await this.#readPreference();
    if (generation !== this.#accountGeneration) {
      throw new Error("ChatGPT authentication is required");
    }
    const persistedSelection = persistedSelectionFromInput(prepared.requested);
    let committed: DocumentEnvelope<PersistedModelPreference>;
    if (this.#persistence) {
      const update = await this.#persistence.store.replaceRecoverably(prepared.preferenceRevision, {
        selection: persistedSelection,
        legacyMigrationCompleted: current.value.legacyMigrationCompleted,
      });
      await this.#verifyDurableUpdate(generation, update);
      committed = update.envelope;
    } else {
      if (prepared.preferenceRevision !== this.#volatilePreferenceRevision) {
        throw new DocumentStoreError("DOCUMENT_CONFLICT", "document revision conflict");
      }
      this.#volatilePreferenceRevision += 1;
      committed = this.#volatilePreference(
        persistedSelection,
        current.value.legacyMigrationCompleted,
      );
      await this.#assertCurrentAccount(generation);
    }
    const selection = publicSelection(prepared.requested);
    const changed = !samePersistedSelection(current.value.selection, persistedSelection);
    this.#selection = selection;
    this.#legacyMigrationCompleted = committed.value.legacyMigrationCompleted;
    if (prepared.requested.mode === "automatic") {
      this.#automaticSelection = prepared.resolved;
    }
    if (changed) this.#notify({ kind: "selection_changed", selection });
    return selection;
  }

  async #applyRefresh(
    normalized: NormalizedModels,
    initialPreference: DocumentEnvelope<PersistedModelPreference>,
    notifyInvalidation: boolean,
    generation: number,
    signal?: AbortSignal,
    pendingUpdate?: RecoverableModelPreferenceUpdate,
  ): Promise<ModelCatalogSnapshot> {
    if (pendingUpdate) {
      await this.#verifyDurableUpdate(generation, pendingUpdate, signal);
    } else {
      await this.#assertCurrentAccount(generation, signal);
    }
    const previousAutomatic = this.#automaticSelection;
    const previousSelection = this.#selection;
    let preference = initialPreference;
    let selection = publicSelectionFromPersisted(preference.value.selection, normalized.models);
    let unavailable = false;
    if (selection === undefined) {
      unavailable = true;
      if (this.#persistence) {
        const repaired = await this.#persistence.store.replaceRecoverably(preference.revision, {
          selection: { mode: "automatic" },
          legacyMigrationCompleted: preference.value.legacyMigrationCompleted,
        });
        await this.#verifyDurableUpdate(generation, repaired, signal);
        preference = repaired.envelope;
      } else {
        this.#volatilePreferenceRevision += 1;
        preference = this.#volatilePreference(
          { mode: "automatic" },
          preference.value.legacyMigrationCompleted,
        );
      }
      selection = { mode: "automatic" };
    }
    this.#models = normalized.models;
    this.#automaticSelection = normalized.automaticSelection;
    this.#selection = selection;
    this.#legacyMigrationCompleted = preference.value.legacyMigrationCompleted;
    const automaticChanged =
      previousSelection.mode === "automatic" &&
      previousAutomatic !== undefined &&
      !sameResolvedSelection(previousAutomatic, normalized.automaticSelection);
    if (notifyInvalidation && (unavailable || automaticChanged)) {
      this.#notify({ kind: "selection_invalidated", reason: "model_unavailable" });
    }
    return {
      models: this.#models,
      selection: this.#selection,
      legacyMigrationCompleted: this.#legacyMigrationCompleted,
    };
  }

  #readPreference(): Promise<DocumentEnvelope<PersistedModelPreference>> {
    if (this.#persistence) return this.#persistence.store.read();
    return Promise.resolve(
      this.#volatilePreference(
        persistedSelectionFromPublic(this.#selection),
        this.#legacyMigrationCompleted,
      ),
    );
  }

  #volatilePreference(
    selection: PersistedModelPreferenceSelection,
    legacyMigrationCompleted: boolean,
  ): DocumentEnvelope<PersistedModelPreference> {
    return {
      schemaVersion: 1,
      revision: this.#volatilePreferenceRevision,
      updatedAt: new Date(0).toISOString(),
      value: { selection, legacyMigrationCompleted },
    };
  }

  async #assertSignedIn(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const snapshot = await this.#account.getAccount();
    throwIfAborted(signal);
    if (snapshot.status !== "signed_in" || snapshot.auth !== "chatgpt") {
      throw new Error("ChatGPT authentication is required");
    }
  }

  async #assertCurrentAccount(generation: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (generation !== this.#accountGeneration) {
      throw new Error("ChatGPT authentication is required");
    }
    await this.#assertSignedIn(signal);
    if (generation !== this.#accountGeneration) {
      throw new Error("ChatGPT authentication is required");
    }
  }

  async #verifyDurableUpdate(
    generation: number,
    update: RecoverableModelPreferenceUpdate,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.#assertCurrentAccount(generation, signal);
    } catch (error) {
      await update.restore();
      throw error;
    }
  }

  #queue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const queued = this.#operationTail
      .catch(() => undefined)
      .then(() => {
        throwIfAborted(signal);
        return operation();
      });
    this.#operationTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  #notify(event: ModelCatalogEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Runtime authority observers cannot affect catalog state.
      }
    }
  }
}

function publicSelection(input: ModelSelectionInput): ModelSelection {
  return input.mode === "automatic" ? { mode: "automatic" } : { ...input, available: true };
}

function persistedSelectionFromInput(
  input: ModelSelectionInput,
): PersistedModelPreferenceSelection {
  return input.mode === "automatic" ? { mode: "automatic" } : { ...input };
}

function persistedSelectionFromPublic(
  selection: ModelSelection,
): PersistedModelPreferenceSelection {
  return selection.mode === "automatic"
    ? { mode: "automatic" }
    : {
        mode: "explicit",
        modelId: selection.modelId,
        reasoningEffort: selection.reasoningEffort,
      };
}

function publicSelectionFromPersisted(
  selection: PersistedModelPreferenceSelection,
  models: readonly AvailableModel[],
): ModelSelection | undefined {
  if (selection.mode === "automatic") return { mode: "automatic" };
  return resolveExplicitSelection(models, selection) === undefined
    ? undefined
    : { ...selection, available: true };
}

function resolveExplicitSelection(
  models: readonly AvailableModel[],
  input: LegacyModelPreferenceCandidate,
): ResolvedModelSelection | undefined {
  const selected = models.find((candidate) => candidate.id === input.modelId);
  if (!selected || !selected.supportedReasoningEfforts.includes(input.reasoningEffort)) {
    return undefined;
  }
  return Object.freeze({ modelId: selected.id, reasoningEffort: input.reasoningEffort });
}

function resolveSelectionInput(
  normalized: NormalizedModels,
  input: ModelSelectionInput,
): ResolvedModelSelection {
  if (input.mode === "automatic") {
    if (!normalized.automaticSelection) throw new Error("Automatic model selection is unavailable");
    return normalized.automaticSelection;
  }
  const selected = normalized.models.find((candidate) => candidate.id === input.modelId);
  if (!selected) throw new Error("Selected model is unavailable");
  if (!selected.supportedReasoningEfforts.includes(input.reasoningEffort)) {
    throw new Error("Selected reasoning effort is unavailable");
  }
  return Object.freeze({ modelId: selected.id, reasoningEffort: input.reasoningEffort });
}

function samePersistedSelection(
  left: PersistedModelPreferenceSelection,
  right: PersistedModelPreferenceSelection,
): boolean {
  return (
    left.mode === right.mode &&
    (left.mode === "automatic" ||
      (right.mode === "explicit" &&
        left.modelId === right.modelId &&
        left.reasoningEffort === right.reasoningEffort))
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Model catalog operation was cancelled");
  error.name = "AbortError";
  throw error;
}

function sameResolvedSelection(
  left: ResolvedModelSelection,
  right: ResolvedModelSelection | undefined,
): boolean {
  return (
    right !== undefined &&
    left.modelId === right.modelId &&
    left.reasoningEffort === right.reasoningEffort
  );
}

function normalizeModels(records: readonly Model[]): NormalizedModels {
  const models: AvailableModel[] = [];
  const automaticCandidates: Array<ResolvedModelSelection & { readonly isDefault: boolean }> = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (models.length >= MAX_LIVE_MODELS) break;
    if (
      record.hidden ||
      !MODEL_ID_PATTERN.test(record.model) ||
      seen.has(record.model) ||
      !validDisplayName(record.displayName)
    ) {
      continue;
    }
    const supportedReasoningEfforts: string[] = [];
    const seenEfforts = new Set<string>();
    for (const option of record.supportedReasoningEfforts) {
      if (supportedReasoningEfforts.length >= MAX_REASONING_EFFORTS) break;
      const effort = option.reasoningEffort;
      if (!REASONING_EFFORT_PATTERN.test(effort) || seenEfforts.has(effort)) continue;
      seenEfforts.add(effort);
      supportedReasoningEfforts.push(effort);
    }
    if (supportedReasoningEfforts.length === 0) continue;
    seen.add(record.model);
    models.push({
      id: record.model,
      displayName: record.displayName,
      supportedReasoningEfforts,
    });
    if (supportedReasoningEfforts.includes(record.defaultReasoningEffort)) {
      automaticCandidates.push({
        modelId: record.model,
        reasoningEffort: record.defaultReasoningEffort,
        isDefault: record.isDefault,
      });
    }
  }
  const automatic =
    automaticCandidates.find((candidate) => candidate.isDefault) ?? automaticCandidates[0];
  return {
    models,
    automaticSelection: automatic
      ? Object.freeze({
          modelId: automatic.modelId,
          reasoningEffort: automatic.reasoningEffort,
        })
      : undefined,
  };
}

function validDisplayName(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.toWellFormed() &&
    Array.from(value).length <= MAX_DISPLAY_NAME_CODE_POINTS &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
