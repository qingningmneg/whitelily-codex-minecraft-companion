import { describe, expect, it } from "vitest";
import type {
  AvatarModelCatalogSnapshot,
  AvatarModelControlRequest,
  AvatarModelControlState,
} from "../../../../src/avatar/avatarModelTypes.js";
import {
  AvatarModelSwitchCoordinator,
  type AvatarModelMailboxPort,
} from "./avatarModelSwitchCoordinator.js";

describe("native skin appearance flow", () => {
  it("keeps the previous skin across restart when the first native frame fails", async () => {
    const app = launchHarness({ activeModelId: "builtin:whitelily" });
    const imported = "user:00000000-0000-4000-8000-000000000001";
    const switching = app.switchTo(imported);
    await app.expectRequest("prepare");
    app.fabricReply("ready");
    await app.expectRequest("commit");
    app.fabricReply("failed", "AVATAR_FRAME_FAILED");

    await app.expectRequest("cancel");
    app.fabricReply("cancelled");
    await expect(switching).rejects.toMatchObject({ code: "AVATAR_SWITCH_FAILED" });
    expect((await app.list()).activeModelId).toBe("builtin:whitelily");
    await app.restart();
    expect((await app.list()).activeModelId).toBe("builtin:whitelily");
  });

  it("restores the previous selection across restart when persistence fails after visibility", async () => {
    const app = launchHarness({ activeModelId: "builtin:whitelily", preferenceFailure: true });
    const imported = "user:00000000-0000-4000-8000-000000000001";
    const switching = app.switchTo(imported);
    await app.expectRequest("prepare");
    app.fabricReply("ready");
    await app.expectRequest("commit");
    app.fabricReply("visible");

    await app.expectRequest("cancel");
    app.fabricReply("cancelled");
    await expect(switching).rejects.toMatchObject({ code: "AVATAR_SWITCH_FAILED" });
    expect((await app.list()).activeModelId).toBe("builtin:whitelily");
    await app.restart();
    expect((await app.list()).activeModelId).toBe("builtin:whitelily");
  });

  it("keeps Fabric and desktop old across a world boundary after a lost cancel ACK", async () => {
    const app = launchHarness({
      activeModelId: "builtin:whitelily",
      preferenceFailure: true,
      recoveryTimeoutMs: 20,
    });
    const imported = "user:00000000-0000-4000-8000-000000000001";
    const switching = app.switchTo(imported);
    await app.expectRequest("prepare");
    app.fabricReply("ready");
    await app.expectRequest("commit");
    app.fabricReply("visible");
    await app.expectRequest("cancel");

    app.fabricConsumeRecoveryWithoutAck();
    await expect(switching).rejects.toMatchObject({
      code: "AVATAR_SWITCH_RECOVERY_PENDING",
    });
    app.worldBoundary();

    expect(app.fabricActiveModelId).toBe("builtin:whitelily");
    expect((await app.list()).activeModelId).toBe("builtin:whitelily");
  });

  it("keeps Fabric and desktop new across a world boundary after a lost finalize ACK", async () => {
    const app = launchHarness({
      activeModelId: "builtin:whitelily",
      compensationFailure: true,
      recoveryTimeoutMs: 20,
    });
    const imported = "user:00000000-0000-4000-8000-000000000001";
    const switching = app.switchTo(imported);
    await app.expectRequest("prepare");
    app.fabricReply("ready");
    await app.expectRequest("commit");
    app.fabricReply("visible");
    await app.expectRequest("finalize");
    app.fabricReply("failed", "AVATAR_FINALIZE_FAILED");
    await app.expectRequest("finalize");

    app.fabricConsumeRecoveryWithoutAck();
    await expect(switching).rejects.toMatchObject({
      code: "AVATAR_SWITCH_RECOVERY_PENDING",
    });
    app.worldBoundary();

    expect(app.fabricActiveModelId).toBe(imported);
    expect((await app.list()).activeModelId).toBe(imported);
  });
});

function launchHarness(options: {
  activeModelId: string;
  preferenceFailure?: boolean;
  compensationFailure?: boolean;
  recoveryTimeoutMs?: number;
}) {
  let preference = { schemaVersion: 1 as const, revision: 0, activeModelId: options.activeModelId };
  const mailbox = new HarnessMailbox();
  const catalog = {
    has: async () => true,
    resolveRuntimeDescriptor: async (modelId: string) => ({
      modelId,
      origin: modelId.startsWith("user:") ? ("imported" as const) : ("builtin" as const),
      worldRenderer: "minecraft-skin" as const,
      armModel: "slim" as const,
    }),
  };
  const preferences = {
    read: async () => ({ ...preference }),
    readActiveModelId: async () => preference.activeModelId,
    commitActiveModelId: async (input: { activeModelId: string; committedRequestId: string }) => {
      if (options.preferenceFailure) throw new Error("preference write failed");
      preference = {
        schemaVersion: 1,
        revision: preference.revision + 1,
        activeModelId: input.activeModelId,
      };
      return { ...preference, committedRequestId: input.committedRequestId };
    },
    compensateActiveModelId: async (input: {
      activeModelId: string;
      committedRequestId: string;
    }) => {
      if (options.compensationFailure) throw new Error("preference compensation failed");
      preference = {
        schemaVersion: 1,
        revision: preference.revision + 1,
        activeModelId: input.activeModelId,
      };
      return { ...preference, committedRequestId: input.committedRequestId };
    },
  };
  const project = async (
    activeModelId: string,
    pendingModelId?: string,
  ): Promise<AvatarModelCatalogSnapshot> => ({
    revision: preference.revision,
    activeModelId,
    ...(pendingModelId === undefined ? {} : { pendingModelId }),
    models: [
      item("builtin:whitelily", "builtin"),
      item("user:00000000-0000-4000-8000-000000000001", "imported"),
    ],
  });
  let requestSequence = 0;
  let coordinator = createCoordinator();
  function createCoordinator() {
    return new AvatarModelSwitchCoordinator({
      catalog,
      preferences,
      mailbox,
      currentWorldSessionId: () => "world-0001",
      projectSnapshot: project,
      publishSnapshot: () => undefined,
      createRequestId: () => `request-${++requestSequence}`,
      now: () => new Date("2026-08-21T00:00:00.000Z"),
      commitTimeoutMs: options.recoveryTimeoutMs ?? 500,
    });
  }
  return {
    switchTo: (modelId: string) => coordinator.switchTo(modelId),
    list: () => project(preference.activeModelId),
    expectRequest: (operation: AvatarModelControlRequest["operation"]) =>
      mailbox.expectRequest(operation),
    fabricReply: (phase: AvatarModelControlState["phase"], errorCode?: string) =>
      mailbox.reply(phase, errorCode),
    fabricConsumeRecoveryWithoutAck: () => mailbox.consumeRecoveryWithoutAck(),
    worldBoundary: () => mailbox.worldBoundary(),
    get fabricActiveModelId() {
      return mailbox.fabricActiveModelId;
    },
    restart: async () => {
      coordinator = createCoordinator();
    },
  };
}

function item(id: string, origin: "builtin" | "imported") {
  return {
    id,
    displayName: id,
    origin,
    worldRenderer: "minecraft-skin" as const,
    armModel: "slim" as const,
    previewDataUrl: "data:image/png;base64,AA==",
  };
}

class HarnessMailbox implements AvatarModelMailboxPort {
  slot: AvatarModelControlRequest | undefined;
  #stateSlot: AvatarModelControlState | undefined;
  #waiter:
    | {
        requestId: string;
        accepted: readonly AvatarModelControlState["phase"][];
        resolve(state: AvatarModelControlState): void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;
  #fabricActiveModelId = "builtin:whitelily";
  #checkpoint:
    | { readonly previousModelId: string; readonly candidateModelId: string; finalized: boolean }
    | undefined;

  get fabricActiveModelId() {
    return this.#fabricActiveModelId;
  }

  async publish(request: AvatarModelControlRequest) {
    this.slot = request;
  }

  async waitForState(input: {
    readonly requestId: string;
    readonly accepted: readonly AvatarModelControlState["phase"][];
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }) {
    const current = this.#stateSlot;
    if (
      current !== undefined &&
      current.requestId === input.requestId &&
      input.accepted.includes(current.phase)
    ) {
      return current;
    }
    return new Promise<AvatarModelControlState>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.#waiter?.timeout === timeout) this.#waiter = undefined;
        reject(Object.assign(new Error("mailbox timeout"), { code: "AVATAR_MAILBOX_TIMEOUT" }));
      }, input.timeoutMs);
      this.#waiter = {
        requestId: input.requestId,
        accepted: input.accepted,
        resolve,
        timeout,
      };
      const abort = () => {
        clearTimeout(timeout);
        reject(input.signal.reason ?? new Error("aborted"));
      };
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort, { once: true });
    });
  }

  async expectRequest(operation: AvatarModelControlRequest["operation"]) {
    for (let attempt = 0; attempt < 100 && this.slot?.operation !== operation; attempt += 1) {
      await Promise.resolve();
    }
    expect(this.slot?.operation).toBe(operation);
    return this.slot!;
  }

  reply(phase: AvatarModelControlState["phase"], errorCode?: string) {
    const request = this.slot!;
    if (phase === "visible") {
      this.#checkpoint = {
        previousModelId: this.#fabricActiveModelId,
        candidateModelId: request.modelId,
        finalized: false,
      };
      this.#fabricActiveModelId = request.modelId;
    } else if (phase === "committed") {
      this.#fabricActiveModelId = request.modelId;
      if (this.#checkpoint !== undefined) this.#checkpoint.finalized = true;
    } else if (phase === "cancelled") {
      this.#rollbackCheckpoint();
    } else if (phase === "failed" && request.operation === "commit") {
      this.#rollbackCheckpoint();
    }
    const state: AvatarModelControlState = {
      schemaVersion: 1,
      requestId: request.requestId,
      phase,
      activeModelId: phase === "committed" ? request.modelId : "builtin:whitelily",
      candidateModelId: request.modelId,
      worldSessionId: request.worldSessionId,
      ...(errorCode === undefined ? {} : { errorCode }),
      updatedAt: "2026-08-21T00:00:01.000Z",
    };
    this.#stateSlot = state;
    const waiter = this.#waiter;
    if (
      waiter !== undefined &&
      waiter.requestId === state.requestId &&
      waiter.accepted.includes(state.phase)
    ) {
      this.#waiter = undefined;
      clearTimeout(waiter.timeout);
      waiter.resolve(state);
    }
  }

  consumeRecoveryWithoutAck() {
    const request = this.slot;
    if (request?.operation === "cancel") {
      this.#rollbackCheckpoint();
      return;
    }
    if (request?.operation === "finalize") {
      this.#fabricActiveModelId = request.modelId;
      if (this.#checkpoint !== undefined) this.#checkpoint.finalized = true;
      return;
    }
    throw new Error("single mailbox slot does not contain a recovery operation");
  }

  worldBoundary() {
    if (this.#checkpoint !== undefined && !this.#checkpoint.finalized) {
      this.#fabricActiveModelId = this.#checkpoint.previousModelId;
    }
    this.#checkpoint = undefined;
  }

  #rollbackCheckpoint() {
    if (this.#checkpoint !== undefined) {
      this.#fabricActiveModelId = this.#checkpoint.previousModelId;
    }
    this.#checkpoint = undefined;
  }
}
