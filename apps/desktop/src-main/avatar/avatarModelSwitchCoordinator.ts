import {
  parseAvatarModelId,
  type AvatarModelCatalogSnapshot,
  type AvatarModelControlRequest,
  type AvatarModelControlState,
  type AvatarRuntimeDescriptor,
} from "../../../../src/avatar/avatarModelSchemas.js";
import type { AvatarModelPreferenceSnapshot } from "./avatarModelPreferences.js";

export interface AvatarModelMailboxPort {
  publish(request: AvatarModelControlRequest): Promise<void>;
  waitForState(input: {
    readonly requestId: string;
    readonly accepted: readonly AvatarModelControlState["phase"][];
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<AvatarModelControlState>;
}

interface AvatarModelCatalogPort {
  has(modelId: string): Promise<boolean>;
  resolveRuntimeDescriptor(modelId: string): Promise<AvatarRuntimeDescriptor>;
}

interface AvatarModelPreferencesPort {
  read(catalog: AvatarModelCatalogPort): Promise<AvatarModelPreferenceSnapshot>;
  readActiveModelId(catalog: AvatarModelCatalogPort): Promise<string>;
  commitActiveModelId(input: {
    readonly catalog: AvatarModelCatalogPort;
    readonly expectedRevision: number;
    readonly activeModelId: string;
    readonly committedRequestId: string;
  }): Promise<AvatarModelPreferenceSnapshot>;
  compensateActiveModelId(input: {
    readonly catalog: AvatarModelCatalogPort;
    readonly expectedRevision: number;
    readonly activeModelId: string;
    readonly committedRequestId: string;
  }): Promise<AvatarModelPreferenceSnapshot>;
}

export type AvatarModelSwitchErrorCode =
  | "AVATAR_SWITCH_SUPERSEDED"
  | "AVATAR_SWITCH_FAILED"
  | "AVATAR_WORLD_CHANGED"
  | "AVATAR_BRIDGE_DISCONNECTED"
  | "AVATAR_PREFERENCE_CONFLICT"
  | "AVATAR_PREFERENCE_COMPENSATION_FAILED"
  | "AVATAR_SWITCH_RECOVERY_PENDING";

export class AvatarModelSwitchError extends Error {
  constructor(
    readonly code: AvatarModelSwitchErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "AvatarModelSwitchError";
  }
}

interface AvatarModelSwitchCoordinatorOptions {
  readonly catalog: AvatarModelCatalogPort;
  readonly preferences: AvatarModelPreferencesPort;
  readonly mailbox: AvatarModelMailboxPort;
  readonly currentWorldSessionId: () => string | undefined;
  readonly projectSnapshot: (
    activeModelId: string,
    pendingModelId?: string,
  ) => Promise<AvatarModelCatalogSnapshot>;
  readonly publishSnapshot: (snapshot: AvatarModelCatalogSnapshot) => void;
  readonly createRequestId: () => string;
  readonly now: () => Date;
  readonly prepareTimeoutMs?: number;
  readonly commitTimeoutMs?: number;
}

interface PendingSwitch {
  readonly modelId: string;
  readonly requestId: string;
  readonly controller: AbortController;
  worldSessionId?: string;
  oldActiveModelId?: string;
  persistedPreference?: AvatarModelPreferenceSnapshot;
  preparePublished: boolean;
  completion: Promise<AvatarModelCatalogSnapshot>;
}

interface RecoveryBarrier {
  readonly request: AvatarModelControlRequest;
  readonly terminalPhase: "cancelled" | "committed";
  readonly expectedActiveModelId: string;
}

const RECOVERY_MAX_ATTEMPTS = 2;

export class AvatarModelSwitchCoordinator {
  readonly #catalog: AvatarModelCatalogPort;
  readonly #preferences: AvatarModelPreferencesPort;
  readonly #mailbox: AvatarModelMailboxPort;
  readonly #currentWorldSessionId: () => string | undefined;
  readonly #projectSnapshot: AvatarModelSwitchCoordinatorOptions["projectSnapshot"];
  readonly #publishSnapshot: AvatarModelSwitchCoordinatorOptions["publishSnapshot"];
  readonly #createRequestId: () => string;
  readonly #now: () => Date;
  readonly #prepareTimeoutMs: number;
  readonly #commitTimeoutMs: number;
  #pending: PendingSwitch | undefined;
  #recovery: RecoveryBarrier | undefined;
  #lastPublishedSnapshot: string | undefined;

  constructor(options: AvatarModelSwitchCoordinatorOptions) {
    this.#catalog = options.catalog;
    this.#preferences = options.preferences;
    this.#mailbox = options.mailbox;
    this.#currentWorldSessionId = options.currentWorldSessionId;
    this.#projectSnapshot = options.projectSnapshot;
    this.#publishSnapshot = options.publishSnapshot;
    this.#createRequestId = options.createRequestId;
    this.#now = options.now;
    this.#prepareTimeoutMs = options.prepareTimeoutMs ?? 15_000;
    this.#commitTimeoutMs = options.commitTimeoutMs ?? 5_000;
  }

  switchTo(modelId: string): Promise<AvatarModelCatalogSnapshot> {
    const parsedModelId = parseAvatarModelId(modelId);
    return this.#start(parsedModelId, false, true);
  }

  async cancelPending(
    reason: "desktop_closing" | "bridge_disconnected" | "world_changed",
  ): Promise<void> {
    const pending = this.#pending;
    if (pending === undefined) return;
    const code =
      reason === "bridge_disconnected"
        ? "AVATAR_BRIDGE_DISCONNECTED"
        : reason === "world_changed"
          ? "AVATAR_WORLD_CHANGED"
          : "AVATAR_SWITCH_FAILED";
    pending.controller.abort(
      new AvatarModelSwitchError(code, `avatar model switch cancelled: ${reason}`),
    );
    await pending.completion.catch(() => undefined);
  }

  async reconcilePersistedSelection(): Promise<void> {
    const preference = await this.#preferences.read(this.#catalog);
    await this.#start(preference.activeModelId, true, false);
  }

  #start(
    modelId: string,
    forceNegotiation: boolean,
    persistSelection: boolean,
  ): Promise<AvatarModelCatalogSnapshot> {
    const predecessor = this.#pending;
    predecessor?.controller.abort(
      new AvatarModelSwitchError(
        "AVATAR_SWITCH_SUPERSEDED",
        "avatar model switch was superseded by a newer choice",
      ),
    );
    const transaction: PendingSwitch = {
      modelId,
      requestId: this.#createRequestId(),
      controller: new AbortController(),
      preparePublished: false,
      completion: Promise.resolve(undefined as never),
    };
    const barrier = predecessor?.completion.catch(() => undefined) ?? Promise.resolve();
    transaction.completion = barrier
      .then(() => this.#execute(transaction, forceNegotiation, persistSelection))
      .finally(() => {
        if (this.#pending === transaction) this.#pending = undefined;
      });
    this.#pending = transaction;
    return transaction.completion;
  }

  async #execute(
    transaction: PendingSwitch,
    forceNegotiation: boolean,
    persistSelection: boolean,
  ): Promise<AvatarModelCatalogSnapshot> {
    try {
      await this.#settleRecoveryBarrier(transaction.controller.signal);
      this.#throwIfAborted(transaction);
      const preference = await this.#preferences.read(this.#catalog);
      transaction.oldActiveModelId = preference.activeModelId;
      this.#throwIfAborted(transaction);
      if (!forceNegotiation && preference.activeModelId === transaction.modelId) {
        const snapshot = await this.#projectSnapshot(preference.activeModelId);
        return { ...snapshot, pendingModelId: undefined };
      }

      const candidate = await this.#catalog.resolveRuntimeDescriptor(transaction.modelId);
      this.#throwIfAborted(transaction);
      const worldSessionId = this.#currentWorldSessionId();
      if (worldSessionId === undefined) {
        throw new AvatarModelSwitchError(
          "AVATAR_BRIDGE_DISCONNECTED",
          "Minecraft avatar bridge is not connected",
        );
      }
      transaction.worldSessionId = worldSessionId;
      await this.#publishProjected(preference.activeModelId, transaction.modelId);

      await this.#mailbox.publish(this.#prepareRequest(transaction, worldSessionId, candidate));
      transaction.preparePublished = true;
      const ready = await this.#mailbox.waitForState({
        requestId: transaction.requestId,
        accepted: ["ready", "failed", "cancelled"],
        signal: transaction.controller.signal,
        timeoutMs: this.#prepareTimeoutMs,
      });
      this.#assertMatchingState(ready, transaction, worldSessionId);
      if (ready.phase !== "ready") throw this.#stateFailure(ready);
      this.#assertWorldUnchanged(worldSessionId);
      this.#throwIfAborted(transaction);
      const revalidatedCandidate = await this.#catalog.resolveRuntimeDescriptor(
        transaction.modelId,
      );
      if (JSON.stringify(revalidatedCandidate) !== JSON.stringify(candidate)) {
        throw new AvatarModelSwitchError(
          "AVATAR_SWITCH_FAILED",
          "avatar model candidate changed while Minecraft was preparing it",
        );
      }
      this.#throwIfAborted(transaction);

      await this.#mailbox.publish(this.#controlRequest("commit", transaction, worldSessionId));
      const visible = await this.#mailbox.waitForState({
        requestId: transaction.requestId,
        accepted: ["visible", "failed", "cancelled"],
        signal: transaction.controller.signal,
        timeoutMs: this.#commitTimeoutMs,
      });
      this.#assertMatchingState(visible, transaction, worldSessionId);
      if (visible.phase !== "visible") throw this.#stateFailure(visible);
      this.#assertWorldUnchanged(worldSessionId);
      this.#throwIfAborted(transaction);

      const snapshot = await this.#projectSnapshot(transaction.modelId);
      this.#publishProjectedValue(snapshot);
      if (persistSelection) {
        try {
          transaction.persistedPreference = await this.#preferences.commitActiveModelId({
            catalog: this.#catalog,
            expectedRevision: preference.revision,
            activeModelId: transaction.modelId,
            committedRequestId: transaction.requestId,
          });
        } catch (error) {
          if ((error as { readonly code?: unknown }).code === "AVATAR_PREFERENCE_CONFLICT") {
            throw new AvatarModelSwitchError(
              "AVATAR_PREFERENCE_CONFLICT",
              "avatar model preference changed during switching",
              { cause: error },
            );
          }
          throw error;
        }
      }
      await this.#mailbox.publish(this.#controlRequest("finalize", transaction, worldSessionId));
      const committed = await this.#mailbox.waitForState({
        requestId: transaction.requestId,
        accepted: ["committed", "failed", "cancelled"],
        signal: transaction.controller.signal,
        timeoutMs: this.#commitTimeoutMs,
      });
      this.#assertMatchingState(committed, transaction, worldSessionId);
      if (committed.phase !== "committed" || committed.activeModelId !== transaction.modelId) {
        throw this.#stateFailure(committed);
      }
      this.#assertWorldUnchanged(worldSessionId);
      this.#throwIfAborted(transaction);
      return snapshot;
    } catch (error) {
      await this.#rollback(transaction);
      throw this.#normalizeError(error, transaction);
    }
  }

  async #rollback(transaction: PendingSwitch): Promise<void> {
    if (
      transaction.persistedPreference !== undefined &&
      transaction.oldActiveModelId !== undefined
    ) {
      try {
        await this.#preferences.compensateActiveModelId({
          catalog: this.#catalog,
          expectedRevision: transaction.persistedPreference.revision,
          activeModelId: transaction.oldActiveModelId,
          committedRequestId: transaction.requestId,
        });
      } catch (error) {
        if (transaction.worldSessionId !== undefined) {
          this.#recovery = {
            request: this.#controlRequest("finalize", transaction, transaction.worldSessionId),
            terminalPhase: "committed",
            expectedActiveModelId: transaction.modelId,
          };
          await this.#settleRecoveryBarrier(new AbortController().signal);
        }
        throw new AvatarModelSwitchError(
          "AVATAR_PREFERENCE_COMPENSATION_FAILED",
          "avatar model preference compensation failed",
          { cause: error },
        );
      }
    }
    if (transaction.preparePublished && transaction.worldSessionId !== undefined) {
      this.#recovery = {
        request: this.#controlRequest("cancel", transaction, transaction.worldSessionId),
        terminalPhase: "cancelled",
        expectedActiveModelId: transaction.oldActiveModelId ?? transaction.modelId,
      };
      await this.#settleRecoveryBarrier(new AbortController().signal);
    }
    if (this.#pending === transaction && transaction.oldActiveModelId !== undefined) {
      await this.#publishProjected(transaction.oldActiveModelId).catch(() => undefined);
    }
  }

  async #settleRecoveryBarrier(signal: AbortSignal): Promise<void> {
    const recovery = this.#recovery;
    if (recovery === undefined) return;
    let lastFailure: unknown;
    for (let attempt = 0; attempt < RECOVERY_MAX_ATTEMPTS; attempt += 1) {
      if (signal.aborted) throw signal.reason;
      try {
        await this.#mailbox.publish(recovery.request);
        const state = await this.#mailbox.waitForState({
          requestId: recovery.request.requestId,
          accepted: [recovery.terminalPhase],
          signal,
          timeoutMs: this.#commitTimeoutMs,
        });
        this.#assertRecoveryState(state, recovery);
        if (this.#recovery === recovery) this.#recovery = undefined;
        return;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        lastFailure = error;
      }
    }
    throw new AvatarModelSwitchError(
      "AVATAR_SWITCH_RECOVERY_PENDING",
      "previous avatar model recovery is still awaiting Minecraft acknowledgement",
      { cause: lastFailure },
    );
  }

  #assertRecoveryState(state: AvatarModelControlState, recovery: RecoveryBarrier): void {
    const request = recovery.request;
    if (
      state.requestId !== request.requestId ||
      state.worldSessionId !== request.worldSessionId ||
      state.phase !== recovery.terminalPhase ||
      state.activeModelId !== recovery.expectedActiveModelId ||
      (state.candidateModelId !== undefined && state.candidateModelId !== request.modelId)
    ) {
      throw new AvatarModelSwitchError(
        "AVATAR_SWITCH_RECOVERY_PENDING",
        "Minecraft returned a non-matching avatar recovery acknowledgement",
      );
    }
  }

  #prepareRequest(
    transaction: PendingSwitch,
    worldSessionId: string,
    candidate: AvatarRuntimeDescriptor,
  ): AvatarModelControlRequest {
    return {
      schemaVersion: 1,
      requestId: transaction.requestId,
      operation: "prepare",
      modelId: transaction.modelId,
      worldSessionId,
      candidate,
      issuedAt: this.#now().toISOString(),
    };
  }

  #controlRequest(
    operation: "commit" | "finalize" | "cancel",
    transaction: PendingSwitch,
    worldSessionId: string,
  ): AvatarModelControlRequest {
    return {
      schemaVersion: 1,
      requestId: transaction.requestId,
      operation,
      modelId: transaction.modelId,
      worldSessionId,
      issuedAt: this.#now().toISOString(),
    };
  }

  #assertMatchingState(
    state: AvatarModelControlState,
    transaction: PendingSwitch,
    worldSessionId: string,
  ): void {
    if (state.requestId !== transaction.requestId || state.worldSessionId !== worldSessionId) {
      throw new AvatarModelSwitchError(
        "AVATAR_WORLD_CHANGED",
        "avatar state came from another world",
      );
    }
    if (state.candidateModelId !== undefined && state.candidateModelId !== transaction.modelId) {
      throw new AvatarModelSwitchError(
        "AVATAR_SWITCH_FAILED",
        "avatar state named another candidate",
      );
    }
  }

  #assertWorldUnchanged(worldSessionId: string): void {
    const current = this.#currentWorldSessionId();
    if (current === undefined) {
      throw new AvatarModelSwitchError(
        "AVATAR_BRIDGE_DISCONNECTED",
        "Minecraft avatar bridge disconnected while switching",
      );
    }
    if (current !== worldSessionId) {
      throw new AvatarModelSwitchError(
        "AVATAR_WORLD_CHANGED",
        "Minecraft world changed while switching avatar models",
      );
    }
  }

  #stateFailure(state: AvatarModelControlState): AvatarModelSwitchError {
    return new AvatarModelSwitchError(
      "AVATAR_SWITCH_FAILED",
      `Minecraft rejected avatar model switch${state.errorCode ? `: ${state.errorCode}` : ""}`,
    );
  }

  #throwIfAborted(transaction: PendingSwitch): void {
    if (!transaction.controller.signal.aborted) return;
    const reason = transaction.controller.signal.reason;
    throw reason instanceof AvatarModelSwitchError
      ? reason
      : new AvatarModelSwitchError("AVATAR_SWITCH_FAILED", "avatar model switch aborted", {
          cause: reason,
        });
  }

  #normalizeError(error: unknown, transaction: PendingSwitch): AvatarModelSwitchError {
    if (transaction.controller.signal.aborted) {
      const reason = transaction.controller.signal.reason;
      if (reason instanceof AvatarModelSwitchError) return reason;
    }
    if (error instanceof AvatarModelSwitchError) return error;
    if ((error as { readonly code?: unknown }).code === "AVATAR_PREFERENCE_CONFLICT") {
      return new AvatarModelSwitchError(
        "AVATAR_PREFERENCE_CONFLICT",
        "avatar model preference changed during switching",
        { cause: error },
      );
    }
    return new AvatarModelSwitchError("AVATAR_SWITCH_FAILED", "avatar model switch failed", {
      cause: error,
    });
  }

  async #publishProjected(activeModelId: string, pendingModelId?: string): Promise<void> {
    this.#publishProjectedValue(await this.#projectSnapshot(activeModelId, pendingModelId));
  }

  #publishProjectedValue(snapshot: AvatarModelCatalogSnapshot): void {
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.#lastPublishedSnapshot) return;
    this.#lastPublishedSnapshot = serialized;
    this.#publishSnapshot(snapshot);
  }
}
