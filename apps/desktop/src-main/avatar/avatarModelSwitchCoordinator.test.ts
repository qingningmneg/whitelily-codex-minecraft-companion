import { describe, expect, it, vi } from "vitest";
import type {
  AvatarModelCatalogSnapshot,
  AvatarModelControlRequest,
  AvatarModelControlState,
  AvatarRuntimeDescriptor,
} from "../../../../src/avatar/avatarModelTypes.js";
import type { AvatarModelPreferenceSnapshot } from "./avatarModelPreferences.js";
import {
  AvatarModelSwitchCoordinator,
  type AvatarModelMailboxPort,
} from "./avatarModelSwitchCoordinator.js";

const firstUserId = "user:00000000-0000-4000-8000-000000000001";
const secondUserId = "user:00000000-0000-4000-8000-000000000002";

describe("AvatarModelSwitchCoordinator", () => {
  it("persists only after the matching visible state and finalizes afterward", async () => {
    const harness = createHarness();
    const switching = harness.coordinator.switchTo(firstUserId);

    await harness.mailbox.expectRequest("prepare", firstUserId);
    harness.mailbox.reply("ready");
    await harness.mailbox.expectRequest("commit", firstUserId);
    expect(harness.commitActiveModelId).not.toHaveBeenCalled();
    harness.mailbox.reply("visible");
    await harness.mailbox.expectRequest("finalize", firstUserId);
    expect(harness.commitActiveModelId).toHaveBeenCalledOnce();
    harness.mailbox.reply("committed");

    await expect(switching).resolves.toMatchObject({ activeModelId: firstUserId });
    expect(harness.commitActiveModelId).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 0,
        activeModelId: firstUserId,
      }),
    );
  });

  it("cancels an uncommitted candidate when a newer choice arrives", async () => {
    const harness = createHarness();
    const first = harness.coordinator.switchTo(firstUserId);
    await harness.mailbox.expectRequest("prepare", firstUserId);

    const second = harness.coordinator.switchTo(secondUserId);

    await expect(first).rejects.toMatchObject({ code: "AVATAR_SWITCH_SUPERSEDED" });
    await harness.mailbox.expectRequest("cancel", firstUserId);
    await harness.mailbox.expectRequest("prepare", secondUserId);
    harness.mailbox.reply("ready");
    await harness.mailbox.expectRequest("commit", secondUserId);
    harness.mailbox.reply("visible");
    await harness.mailbox.expectRequest("finalize", secondUserId);
    harness.mailbox.reply("committed");
    await expect(second).resolves.toMatchObject({ activeModelId: secondUserId });
  });

  it("keeps the old selection when Minecraft reports a candidate failure", async () => {
    const harness = createHarness();
    const switching = harness.coordinator.switchTo(firstUserId);
    await harness.mailbox.expectRequest("prepare", firstUserId);

    harness.mailbox.reply("failed", { errorCode: "AVATAR_SHADER_FAILED" });

    await expect(switching).rejects.toMatchObject({ code: "AVATAR_SWITCH_FAILED" });
    expect(harness.commitActiveModelId).not.toHaveBeenCalled();
    expect(harness.preference.activeModelId).toBe("builtin:whitelily");
    await harness.mailbox.expectRequest("cancel", firstUserId);
  });

  it("keeps the previous skin when the first native frame fails", async () => {
    const harness = createHarness();
    const switching = harness.coordinator.switchTo(firstUserId);
    const prepare = await harness.mailbox.expectRequest("prepare", firstUserId);

    if (prepare.operation !== "prepare") throw new Error("expected prepare request");
    expect(prepare.candidate).toEqual({
      modelId: firstUserId,
      origin: "imported",
      worldRenderer: "minecraft-skin",
      armModel: "slim",
    });
    harness.mailbox.reply("ready");
    await harness.mailbox.expectRequest("commit", firstUserId);
    harness.mailbox.reply("failed", { errorCode: "AVATAR_FRAME_FAILED" });

    await expect(switching).rejects.toMatchObject({ code: "AVATAR_SWITCH_FAILED" });
    expect(harness.preference.activeModelId).toBe("builtin:whitelily");
    expect(harness.commitActiveModelId).not.toHaveBeenCalled();
    await harness.mailbox.expectRequest("cancel", firstUserId);
  });

  it("cancels before commit when the world changes after ready", async () => {
    const harness = createHarness();
    const switching = harness.coordinator.switchTo(firstUserId);
    await harness.mailbox.expectRequest("prepare", firstUserId);

    harness.worldSessionId = "world-0002";
    harness.mailbox.reply("ready");

    await expect(switching).rejects.toMatchObject({ code: "AVATAR_WORLD_CHANGED" });
    expect(harness.commitActiveModelId).not.toHaveBeenCalled();
    await harness.mailbox.expectRequest("cancel", firstUserId);
  });

  it("cancels when the validated candidate digest drifts after ready", async () => {
    const harness = createHarness({ digestDrift: true });
    const switching = harness.coordinator.switchTo(firstUserId);
    await harness.mailbox.expectRequest("prepare", firstUserId);

    harness.mailbox.reply("ready");

    await expect(switching).rejects.toMatchObject({ code: "AVATAR_SWITCH_FAILED" });
    expect(harness.commitActiveModelId).not.toHaveBeenCalled();
    await harness.mailbox.expectRequest("cancel", firstUserId);
  });

  it("makes selecting the already committed model idempotent", async () => {
    const harness = createHarness();

    await expect(harness.coordinator.switchTo("builtin:whitelily")).resolves.toMatchObject({
      activeModelId: "builtin:whitelily",
      pendingModelId: undefined,
    });
    expect(harness.mailbox.requests).toEqual([]);
    expect(harness.commitActiveModelId).not.toHaveBeenCalled();
  });

  it("reconciles the persisted model through a fresh world-session negotiation", async () => {
    const harness = createHarness();
    const reconciling = harness.coordinator.reconcilePersistedSelection();

    await harness.mailbox.expectRequest("prepare", "builtin:whitelily");
    harness.mailbox.reply("ready");
    await harness.mailbox.expectRequest("commit", "builtin:whitelily");
    harness.mailbox.reply("visible");
    await harness.mailbox.expectRequest("finalize", "builtin:whitelily");
    harness.mailbox.reply("committed");

    await expect(reconciling).resolves.toBeUndefined();
  });

  it("does not overwrite a newer preference revision after visible commit", async () => {
    const harness = createHarness({ preferenceConflict: true });
    const switching = harness.coordinator.switchTo(firstUserId);
    await harness.mailbox.expectRequest("prepare", firstUserId);
    harness.mailbox.reply("ready");
    await harness.mailbox.expectRequest("commit", firstUserId);
    harness.mailbox.reply("visible");

    await expect(switching).rejects.toMatchObject({ code: "AVATAR_PREFERENCE_CONFLICT" });
    expect(harness.preference.activeModelId).toBe("builtin:whitelily");
    await harness.mailbox.expectRequest("cancel", firstUserId);
  });

  it.each(["projection", "publication"] as const)(
    "rolls back the visible candidate when final %s fails",
    async (failure) => {
      const harness = createHarness({
        finalProjectionFailure: failure === "projection",
        finalPublicationFailure: failure === "publication",
      });
      const switching = harness.coordinator.switchTo(firstUserId);
      await harness.mailbox.expectRequest("prepare", firstUserId);
      harness.mailbox.reply("ready");
      await harness.mailbox.expectRequest("commit", firstUserId);
      harness.mailbox.reply("visible");

      await expect(switching).rejects.toMatchObject({ code: "AVATAR_SWITCH_FAILED" });
      expect(harness.commitActiveModelId).not.toHaveBeenCalled();
      expect(harness.preference.activeModelId).toBe("builtin:whitelily");
      await harness.mailbox.expectRequest("cancel", firstUserId);
      expect(harness.notifications.at(-1)).toMatchObject({
        activeModelId: "builtin:whitelily",
      });
      expect(harness.notifications.at(-1)?.pendingModelId).toBeUndefined();
    },
  );

  it("compensates the persisted preference when finalization fails", async () => {
    const harness = createHarness();
    const switching = harness.coordinator.switchTo(firstUserId);
    await harness.mailbox.expectRequest("prepare", firstUserId);
    harness.mailbox.reply("ready");
    await harness.mailbox.expectRequest("commit", firstUserId);
    harness.mailbox.reply("visible");
    await harness.mailbox.expectRequest("finalize", firstUserId);
    harness.mailbox.reply("failed", { errorCode: "AVATAR_FINALIZE_FAILED" });

    await expect(switching).rejects.toMatchObject({ code: "AVATAR_SWITCH_FAILED" });
    expect(harness.compensateActiveModelId).toHaveBeenCalledWith(
      expect.objectContaining({
        activeModelId: "builtin:whitelily",
        committedRequestId: "switch-request-0001",
      }),
    );
    expect(harness.preference.activeModelId).toBe("builtin:whitelily");
    await harness.mailbox.expectRequest("cancel", firstUserId);
  });

  it("keeps the forward-consistent selection when preference compensation fails", async () => {
    const harness = createHarness({ compensationFailure: true });
    const switching = harness.coordinator.switchTo(firstUserId);
    await harness.mailbox.expectRequest("prepare", firstUserId);
    harness.mailbox.reply("ready");
    await harness.mailbox.expectRequest("commit", firstUserId);
    harness.mailbox.reply("visible");
    await harness.mailbox.expectRequest("finalize", firstUserId);
    harness.mailbox.reply("failed", { errorCode: "AVATAR_FINALIZE_FAILED" });

    await expect(switching).rejects.toMatchObject({
      code: "AVATAR_PREFERENCE_COMPENSATION_FAILED",
    });
    expect(harness.preference.activeModelId).toBe(firstUserId);
    expect(
      harness.mailbox.requests.filter(({ operation }) => operation === "finalize"),
    ).toHaveLength(2);
    expect(harness.mailbox.requests.some(({ operation }) => operation === "cancel")).toBe(false);
    expect(harness.notifications.at(-1)?.activeModelId).toBe(firstUserId);
  });

  it("cancels an in-flight candidate when the bridge disconnects", async () => {
    const harness = createHarness();
    const switching = harness.coordinator.switchTo(firstUserId);
    await harness.mailbox.expectRequest("prepare", firstUserId);

    await harness.coordinator.cancelPending("bridge_disconnected");

    await expect(switching).rejects.toMatchObject({ code: "AVATAR_BRIDGE_DISCONNECTED" });
    await harness.mailbox.expectRequest("cancel", firstUserId);
  });
});

function createHarness(
  options: {
    readonly preferenceConflict?: boolean;
    readonly digestDrift?: boolean;
    readonly compensationFailure?: boolean;
    readonly finalProjectionFailure?: boolean;
    readonly finalPublicationFailure?: boolean;
  } = {},
) {
  const mailbox = new FakeMailbox();
  let preference: AvatarModelPreferenceSnapshot = {
    schemaVersion: 1,
    revision: 0,
    activeModelId: "builtin:whitelily",
  };
  let descriptorReads = 0;
  const catalog = {
    resolveRuntimeDescriptor: vi.fn(async (modelId: string) => {
      descriptorReads += 1;
      const value = descriptor(modelId);
      return options.digestDrift && descriptorReads > 1
        ? { ...value, armModel: "wide" as const }
        : value;
    }),
    has: vi.fn(async () => true),
  };
  const commitActiveModelId = vi.fn(async (input: { activeModelId: string }) => {
    if (options.preferenceConflict) {
      const error = Object.assign(new Error("preference conflict"), {
        code: "AVATAR_PREFERENCE_CONFLICT",
      });
      throw error;
    }
    preference = {
      schemaVersion: 1,
      revision: preference.revision + 1,
      activeModelId: input.activeModelId,
      committedRequestId: "switch-request-0001",
    };
    return preference;
  });
  const compensateActiveModelId = vi.fn(
    async (input: { activeModelId: string; committedRequestId: string }) => {
      if (options.compensationFailure) throw new Error("preference compensation failed");
      preference = {
        schemaVersion: 1,
        revision: preference.revision + 1,
        activeModelId: input.activeModelId,
        committedRequestId: input.committedRequestId,
      };
      return preference;
    },
  );
  const preferences = {
    read: vi.fn(async () => preference),
    readActiveModelId: vi.fn(async () => preference.activeModelId),
    commitActiveModelId,
    compensateActiveModelId,
  };
  const notifications: AvatarModelCatalogSnapshot[] = [];
  const state = {
    worldSessionId: "world-0001",
  };
  const coordinator = new AvatarModelSwitchCoordinator({
    catalog,
    preferences,
    mailbox,
    currentWorldSessionId: () => state.worldSessionId,
    projectSnapshot: async (activeModelId, pendingModelId) => {
      if (
        options.finalProjectionFailure &&
        activeModelId === firstUserId &&
        pendingModelId === undefined
      ) {
        throw new Error("final projection failed");
      }
      return snapshot(activeModelId, pendingModelId);
    },
    publishSnapshot: (value) => {
      if (
        options.finalPublicationFailure &&
        value.activeModelId === firstUserId &&
        value.pendingModelId === undefined
      ) {
        throw new Error("final publication failed");
      }
      notifications.push(value);
    },
    createRequestId: () => "switch-request-0001",
    now: () => new Date("2026-08-16T08:00:00.000Z"),
    prepareTimeoutMs: 500,
    commitTimeoutMs: 500,
  });
  return {
    get worldSessionId() {
      return state.worldSessionId;
    },
    set worldSessionId(value: string) {
      state.worldSessionId = value;
    },
    get preference() {
      return preference;
    },
    catalog,
    preferences,
    commitActiveModelId,
    compensateActiveModelId,
    mailbox,
    notifications,
    coordinator,
  };
}

class FakeMailbox implements AvatarModelMailboxPort {
  readonly requests: AvatarModelControlRequest[] = [];
  #waiter:
    | {
        accepted: readonly AvatarModelControlState["phase"][];
        resolve(value: AvatarModelControlState): void;
        reject(reason: unknown): void;
      }
    | undefined;

  async publish(request: AvatarModelControlRequest): Promise<void> {
    this.requests.push(request);
  }

  waitForState(input: {
    readonly accepted: readonly AvatarModelControlState["phase"][];
    readonly signal: AbortSignal;
  }): Promise<AvatarModelControlState> {
    return new Promise((resolve, reject) => {
      this.#waiter = { accepted: input.accepted, resolve, reject };
      const abort = (): void => reject(input.signal.reason ?? new Error("aborted"));
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort, { once: true });
    });
  }

  async expectRequest(
    operation: AvatarModelControlRequest["operation"],
    modelId: string,
  ): Promise<AvatarModelControlRequest> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const request = this.requests.find(
        (candidate) => candidate.operation === operation && candidate.modelId === modelId,
      );
      if (request !== undefined) return request;
      await Promise.resolve();
    }
    throw new Error(`missing ${operation} request for ${modelId}`);
  }

  reply(
    phase: AvatarModelControlState["phase"],
    overrides: Partial<AvatarModelControlState> = {},
  ): void {
    const waiter = this.#waiter;
    const request = [...this.requests]
      .reverse()
      .find((candidate) => candidate.operation === "prepare" || candidate.operation === "commit");
    if (waiter === undefined || request === undefined || !waiter.accepted.includes(phase)) {
      throw new Error(`no waiter accepts ${phase}`);
    }
    this.#waiter = undefined;
    waiter.resolve({
      schemaVersion: 1,
      requestId: request.requestId,
      phase,
      activeModelId: phase === "committed" ? request.modelId : "builtin:whitelily",
      candidateModelId: request.modelId,
      worldSessionId: request.worldSessionId,
      ...(phase === "failed" ? { errorCode: "AVATAR_SHADER_FAILED" } : {}),
      updatedAt: "2026-08-16T08:00:01.000Z",
      ...overrides,
    });
  }
}

function descriptor(modelId: string): AvatarRuntimeDescriptor {
  const builtin = modelId.startsWith("builtin:");
  return {
    modelId,
    origin: builtin ? "builtin" : "imported",
    worldRenderer: "minecraft-skin",
    armModel: "slim",
  };
}

function snapshot(activeModelId: string, pendingModelId?: string): AvatarModelCatalogSnapshot {
  const previewDataUrl = "data:image/png;base64,iVBORw0KGgo=";
  return {
    revision: 0,
    models: [
      {
        id: "builtin:whitelily",
        displayName: "WhiteLily",
        origin: "builtin",
        worldRenderer: "minecraft-skin",
        armModel: "slim",
        previewDataUrl,
      },
      {
        id: firstUserId,
        displayName: "Imported one",
        origin: "imported",
        worldRenderer: "minecraft-skin",
        armModel: "slim",
        previewDataUrl,
      },
      {
        id: secondUserId,
        displayName: "Imported two",
        origin: "imported",
        worldRenderer: "minecraft-skin",
        armModel: "slim",
        previewDataUrl,
      },
    ],
    activeModelId,
    ...(pendingModelId === undefined ? {} : { pendingModelId }),
  };
}
