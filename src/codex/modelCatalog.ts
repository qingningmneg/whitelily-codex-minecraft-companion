import type { AccountSnapshot } from "./accountService.js";
import type { Model } from "./generated/v2/Model.js";
import type {
  LegacyModelPreferenceCandidate,
  ModelPreferenceStore,
} from "./modelPreferenceStore.js";

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
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
}

export interface ResolvedModelSelection {
  readonly modelId: string;
  readonly reasoningEffort: string;
}

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

export class ModelCatalog {
  readonly #appServer: ModelCatalogAppServerPort;
  readonly #account: ModelCatalogAccountPort;
  readonly #unsubscribeAccount: () => void;
  readonly #invalidationListeners = new Set<() => void>();
  #models: readonly AvailableModel[] = [];
  #automaticSelection: ResolvedModelSelection | undefined;
  #selection: ModelSelection = { mode: "automatic" };
  #accountGeneration = 0;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(
    appServer: ModelCatalogAppServerPort,
    account: ModelCatalogAccountPort,
    _persistence?: ModelCatalogPersistenceDependencies,
  ) {
    this.#appServer = appServer;
    this.#account = account;
    this.#unsubscribeAccount = account.subscribe((snapshot) => {
      this.#accountGeneration += 1;
      if (snapshot.status !== "signed_in") {
        const hadAuthority = this.#models.length > 0 || this.#selection.mode === "explicit";
        this.#models = [];
        this.#automaticSelection = undefined;
        this.#selection = { mode: "automatic" };
        if (hadAuthority) this.#notifyInvalidated();
      }
    });
  }

  listModels(): Promise<ModelCatalogSnapshot> {
    return this.#queue(() => this.#refresh());
  }

  selectModel(input: ModelSelectionInput): Promise<ModelSelection> {
    return this.#queue(async () => {
      await this.#assertSignedIn();
      if (input.mode === "automatic") {
        const changed = this.#selection.mode !== "automatic";
        this.#selection = { mode: "automatic" };
        if (changed) this.#notifyInvalidated();
        return this.#selection;
      }
      const snapshot = await this.#refresh();
      const selected = snapshot.models.find((candidate) => candidate.id === input.modelId);
      if (!selected) throw new Error("Selected model is unavailable");
      if (!selected.supportedReasoningEfforts.includes(input.reasoningEffort)) {
        throw new Error("Selected reasoning effort is unavailable");
      }
      await this.#assertSignedIn();
      const changed =
        this.#selection.mode !== "explicit" ||
        this.#selection.modelId !== selected.id ||
        this.#selection.reasoningEffort !== input.reasoningEffort;
      this.#selection = {
        mode: "explicit",
        modelId: selected.id,
        reasoningEffort: input.reasoningEffort,
        available: true,
      };
      if (changed) this.#notifyInvalidated();
      return this.#selection;
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

  subscribeInvalidation(listener: () => void): () => void {
    this.#invalidationListeners.add(listener);
    return () => this.#invalidationListeners.delete(listener);
  }

  stop(): void {
    this.#unsubscribeAccount();
    this.#models = [];
    this.#automaticSelection = undefined;
    this.#selection = { mode: "automatic" };
    this.#invalidationListeners.clear();
  }

  async #refresh(signal?: AbortSignal): Promise<ModelCatalogSnapshot> {
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
    const previousAutomatic = this.#automaticSelection;
    const normalized = normalizeModels(records);
    this.#models = normalized.models;
    this.#automaticSelection = normalized.automaticSelection;
    const selection = this.#selection;
    let invalidated = false;
    if (selection.mode === "explicit") {
      const selected = this.#models.find((candidate) => candidate.id === selection.modelId);
      if (!selected || !selected.supportedReasoningEfforts.includes(selection.reasoningEffort)) {
        this.#selection = { mode: "automatic" };
        invalidated = true;
      }
    } else if (
      previousAutomatic &&
      !sameResolvedSelection(previousAutomatic, this.#automaticSelection)
    ) {
      invalidated = true;
    }
    if (invalidated) this.#notifyInvalidated();
    return { models: this.#models, selection: this.#selection };
  }

  async #assertSignedIn(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const snapshot = await this.#account.getAccount();
    throwIfAborted(signal);
    if (snapshot.status !== "signed_in" || snapshot.auth !== "chatgpt") {
      this.#models = [];
      this.#automaticSelection = undefined;
      this.#selection = { mode: "automatic" };
      throw new Error("ChatGPT authentication is required");
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

  #notifyInvalidated(): void {
    for (const listener of this.#invalidationListeners) {
      try {
        listener();
      } catch {
        // Runtime authority invalidation observers cannot affect catalog state.
      }
    }
  }
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

interface NormalizedModels {
  readonly models: readonly AvailableModel[];
  readonly automaticSelection: ResolvedModelSelection | undefined;
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
