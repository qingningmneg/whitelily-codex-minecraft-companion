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

    await expect(switching).rejects.toMatchObject({ code: "AVATAR_SWITCH_FAILED" });
    expect((await app.list()).activeModelId).toBe("builtin:whitelily");
    await app.restart();
    expect((await app.list()).activeModelId).toBe("builtin:whitelily");
  });
});

function launchHarness(options: { activeModelId: string }) {
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
  let coordinator = createCoordinator();
  function createCoordinator() {
    return new AvatarModelSwitchCoordinator({
      catalog,
      preferences,
      mailbox,
      currentWorldSessionId: () => "world-0001",
      projectSnapshot: project,
      publishSnapshot: () => undefined,
      createRequestId: () => `request-${mailbox.requestCount + 1}`,
      now: () => new Date("2026-08-21T00:00:00.000Z"),
    });
  }
  return {
    switchTo: (modelId: string) => coordinator.switchTo(modelId),
    list: () => project(preference.activeModelId),
    expectRequest: (operation: AvatarModelControlRequest["operation"]) =>
      mailbox.expectRequest(operation),
    fabricReply: (phase: AvatarModelControlState["phase"], errorCode?: string) =>
      mailbox.reply(phase, errorCode),
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
  readonly requests: AvatarModelControlRequest[] = [];
  readonly waiters: Array<(state: AvatarModelControlState) => void> = [];
  get requestCount() {
    return this.requests.length;
  }
  async publish(request: AvatarModelControlRequest) {
    this.requests.push(request);
  }
  async waitForState() {
    return new Promise<AvatarModelControlState>((resolve) => this.waiters.push(resolve));
  }
  async expectRequest(operation: AvatarModelControlRequest["operation"]) {
    for (
      let attempt = 0;
      attempt < 100 && this.requests.at(-1)?.operation !== operation;
      attempt += 1
    ) {
      await Promise.resolve();
    }
    expect(this.requests.at(-1)?.operation).toBe(operation);
    return this.requests.at(-1)!;
  }
  reply(phase: AvatarModelControlState["phase"], errorCode?: string) {
    const request = this.requests.at(-1)!;
    this.waiters.shift()?.({
      schemaVersion: 1,
      requestId: request.requestId,
      phase,
      activeModelId: phase === "committed" ? request.modelId : "builtin:whitelily",
      candidateModelId: request.modelId,
      worldSessionId: request.worldSessionId,
      ...(errorCode === undefined ? {} : { errorCode }),
      updatedAt: "2026-08-21T00:00:01.000Z",
    });
  }
}
