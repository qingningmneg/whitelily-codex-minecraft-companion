// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { OwnerIdentitySnapshot } from "../../../src/identity/ownerIdentity.js";
import type { CompanionProfile } from "../../../src/profile/profileSchema.js";
import type { MinecraftComponentStatus } from "../src-main/minecraftComponents.js";
import {
  createWhiteLilyApi,
  WHITE_LILY_IPC_CHANNELS,
  type PreloadTransport,
} from "./desktopApi.js";

const profile: CompanionProfile = {
  id: "8af32ca8-d1d7-4d87-b684-f6aaf04fb907",
  displayName: "White Lily",
  language: "en",
  tone: "Warm",
  preferredTopics: [],
  avoidedTopics: [],
  persona: "",
  mode: "friend",
  modeSettings: {
    friend: {
      idleMinutes: 120,
      allowProactiveChat: false,
      allowSuggestions: false,
      allowLowRiskMicroActions: false,
    },
    balanced: {
      idleMinutes: 2,
      allowProactiveChat: true,
      allowSuggestions: true,
      allowLowRiskMicroActions: false,
    },
    autonomous: {
      idleMinutes: 1,
      allowProactiveChat: true,
      allowSuggestions: true,
      allowLowRiskMicroActions: true,
    },
  },
  modelPreference: { mode: "automatic" },
};

const ownerSnapshot: OwnerIdentitySnapshot = {
  revision: 7,
  ownerUsername: "NewOwner",
  configured: true,
  presence: "online",
};
const ownerAuthoritySnapshot = { ...ownerSnapshot, childGeneration: 7 };

const avatarSnapshot = {
  revision: 2,
  models: [
    {
      id: "builtin:whitelily-hd",
      displayName: "WhiteLily 高清动漫",
      origin: "builtin",
      format: "builtin-hd",
      previewDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      bodyAnimation: "whitelily-humanoid-v1",
      expressions: "full",
    },
    {
      id: "builtin:whitelily-classic",
      displayName: "WhiteLily 经典",
      origin: "builtin",
      format: "builtin-classic",
      previewDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      bodyAnimation: "whitelily-humanoid-v1",
      expressions: "full",
    },
  ],
  activeModelId: "builtin:whitelily-hd",
} as const;

describe("Task 5 preload API", () => {
  it("exposes a path-free avatar model API over dedicated channels", async () => {
    const subscriptions = new Map<string, (value: unknown) => void>();
    const invoke = vi.fn(async (channel: string) => {
      if (channel === WHITE_LILY_IPC_CHANNELS.importAvatarModel) {
        return { status: "success", value: { status: "cancelled" } };
      }
      return { status: "success", value: structuredClone(avatarSnapshot) };
    });
    const api = createWhiteLilyApi({
      invoke,
      subscribe: (channel, listener) => {
        subscriptions.set(channel, listener);
        return () => subscriptions.delete(channel);
      },
    } as PreloadTransport);

    await expect(api.listAvatarModels()).resolves.toEqual(avatarSnapshot);
    await expect(api.importAvatarModel()).resolves.toEqual({ status: "cancelled" });
    await expect(api.switchAvatarModel("builtin:whitelily-classic")).resolves.toEqual(
      avatarSnapshot,
    );
    expect(invoke.mock.calls).toEqual([
      [WHITE_LILY_IPC_CHANNELS.listAvatarModels],
      [WHITE_LILY_IPC_CHANNELS.importAvatarModel],
      [WHITE_LILY_IPC_CHANNELS.switchAvatarModel, "builtin:whitelily-classic"],
    ]);

    await expect(
      (api.importAvatarModel as (...args: unknown[]) => Promise<unknown>)(
        String.raw`C:\secret.glb`,
      ),
    ).rejects.toThrow("invalid avatar import input");
    await expect(api.switchAvatarModel(String.raw`C:\secret.glb`)).rejects.toThrow(
      "invalid avatar model selection",
    );
    expect(invoke).toHaveBeenCalledTimes(3);

    const listener = vi.fn();
    const unsubscribe = api.subscribeAvatarModels(listener);
    subscriptions.get(WHITE_LILY_IPC_CHANNELS.avatarModelsEvent)?.(structuredClone(avatarSnapshot));
    expect(listener).toHaveBeenCalledWith(avatarSnapshot);
    unsubscribe();
    unsubscribe();
    expect(subscriptions.has(WHITE_LILY_IPC_CHANNELS.avatarModelsEvent)).toBe(false);
  });

  it("rebuilds only allowlisted avatar error codes from the IPC transport", async () => {
    const api = createWhiteLilyApi({
      invoke: vi.fn(async () => ({ status: "error", code: "AVATAR_GLB_INVALID" })),
      subscribe: vi.fn(),
    });

    const failure = await api.importAvatarModel().catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "AVATAR_GLB_INVALID" });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(String.raw`C:\Users\Other\avatar.glb`);
  });

  it("drops malformed avatar catalog events at the preload boundary", () => {
    let emit: ((value: unknown) => void) | undefined;
    const api = createWhiteLilyApi({
      invoke: vi.fn(),
      subscribe: (_channel, listener) => {
        emit = listener;
        return () => undefined;
      },
    } as PreloadTransport);
    const listener = vi.fn();
    api.subscribeAvatarModels(listener);

    emit?.({ activeModelId: 9 });
    emit?.({ ...avatarSnapshot, sourcePath: String.raw`C:\secret.glb` });

    expect(listener).not.toHaveBeenCalled();
  });

  it("exposes a frozen zero-argument application quit operation", async () => {
    const invoke = vi.fn(async () => undefined);
    const api = createWhiteLilyApi({ invoke, subscribe: vi.fn() });

    await expect(api.quitApplication()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(WHITE_LILY_IPC_CHANNELS.quitApplication);
    expect(Object.isFrozen(api)).toBe(true);
    await expect(
      (api.quitApplication as (...args: unknown[]) => Promise<void>)("force"),
    ).rejects.toThrow("invalid");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("exposes only bounded opaque component operations and parses every result", async () => {
    const status: MinecraftComponentStatus = {
      state: "ready",
      bridgeInstalled: true,
      bridgeActive: true,
      avatarInstalled: true,
      restartRequired: false,
    };
    const invoke = vi.fn(async () => structuredClone(status));
    const api = createWhiteLilyApi({ invoke, subscribe: vi.fn() });

    await expect(api.getMinecraftComponentStatus("lan_candidate_1234")).resolves.toEqual(status);
    await expect(
      api.installMinecraftComponents("lan_candidate_1234", ["bridge", "avatar"]),
    ).resolves.toEqual(status);
    await expect(
      api.removeMinecraftComponents("lan_candidate_1234", ["avatar", "bridge"]),
    ).resolves.toEqual(status);
    expect(invoke.mock.calls).toEqual([
      [WHITE_LILY_IPC_CHANNELS.getMinecraftComponentStatus, "lan_candidate_1234"],
      [
        WHITE_LILY_IPC_CHANNELS.installMinecraftComponents,
        "lan_candidate_1234",
        ["bridge", "avatar"],
      ],
      [
        WHITE_LILY_IPC_CHANNELS.removeMinecraftComponents,
        "lan_candidate_1234",
        ["avatar", "bridge"],
      ],
    ]);

    for (const candidateId of ["", "short", "x".repeat(65), String.raw`C:\Private\mods`]) {
      await expect(api.getMinecraftComponentStatus(candidateId)).rejects.toThrow("invalid");
    }
    let selectionGetterCalls = 0;
    const accessorSelection: unknown[] = [];
    Object.defineProperty(accessorSelection, "0", {
      enumerable: true,
      get: () => {
        selectionGetterCalls += 1;
        return "bridge";
      },
    });
    for (const selection of [
      ["bridge", "bridge"],
      ["bridge", "avatar", "bridge"],
      ["fabric-api"],
      [{ path: String.raw`C:\Private\mods` }],
      accessorSelection,
      Object.setPrototypeOf(["bridge"], null),
    ]) {
      await expect(
        api.installMinecraftComponents("lan_candidate_1234", selection as never),
      ).rejects.toThrow("invalid");
    }
    await expect(
      (
        api.installMinecraftComponents as unknown as (
          ...args: readonly unknown[]
        ) => Promise<unknown>
      )("lan_candidate_1234", ["bridge"], { manifest: "forged" }),
    ).rejects.toThrow("invalid");
    expect(selectionGetterCalls).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed component results without exposing their extra authority", async () => {
    const valid = {
      state: "ready",
      bridgeInstalled: true,
      bridgeActive: true,
      avatarInstalled: true,
      restartRequired: false,
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ...valid, path: String.raw`C:\Private\mods` })
      .mockResolvedValueOnce({ ...valid, state: "download_from_url" })
      .mockResolvedValueOnce({ ...valid, restartRequired: true });
    const api = createWhiteLilyApi({ invoke, subscribe: vi.fn() });

    await expect(api.getMinecraftComponentStatus("lan_candidate_1234")).rejects.toThrow(
      "invalid Minecraft component status",
    );
    await expect(api.installMinecraftComponents("lan_candidate_1234", ["bridge"])).rejects.toThrow(
      "invalid Minecraft component status",
    );
    await expect(api.removeMinecraftComponents("lan_candidate_1234", ["avatar"])).rejects.toThrow(
      "invalid Minecraft component status",
    );
  });

  it("stops only the current task over one fixed zero-argument channel", async () => {
    const stoppedTaskSnapshot = {
      revision: 9,
      lifecycle: "running",
      minecraft: { state: "connected", sessionId: null },
      codex: { state: "ready", model: "gpt-5.6" },
      actions: {
        state: "ready",
        workspaceVersion: "workspace-1",
        mcpListening: true,
        discoveredToolCount: 15,
      },
      actionQueue: { goal: null, items: [] },
      task: null,
      lastError: null,
    } as const;
    const invoke = vi.fn(async () => stoppedTaskSnapshot);
    const api = createWhiteLilyApi({
      invoke,
      subscribe: () => () => undefined,
    } as PreloadTransport);

    await expect(api.stopTask()).resolves.toEqual(stoppedTaskSnapshot);
    expect(invoke).toHaveBeenCalledWith("whitelily:stop-task");
    await expect(
      (api.stopTask as (...args: readonly unknown[]) => Promise<unknown>)({ prompt: "secret" }),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("reads and revision-checks owner identity over fixed bounded channels", async () => {
    const updated = { ...ownerAuthoritySnapshot, revision: 8 };
    const invoke = vi.fn(async (channel: string) =>
      channel === WHITE_LILY_IPC_CHANNELS.readOwnerIdentity ? ownerAuthoritySnapshot : updated,
    );
    const api = createWhiteLilyApi({
      invoke,
      subscribe: () => () => undefined,
    } as PreloadTransport);

    await expect(api.readOwnerIdentity()).resolves.toEqual(ownerAuthoritySnapshot);
    await expect(
      api.updateOwnerIdentity({ expectedRevision: 7, ownerUsername: "NewOwner" }),
    ).resolves.toEqual(updated);
    expect(invoke.mock.calls).toEqual([
      [WHITE_LILY_IPC_CHANNELS.readOwnerIdentity],
      [
        WHITE_LILY_IPC_CHANNELS.updateOwnerIdentity,
        { expectedRevision: 7, ownerUsername: "NewOwner" },
      ],
    ]);
  });

  it("rejects malformed owner identity inputs without invoking accessors or IPC", async () => {
    const invoke = vi.fn(async () => ownerAuthoritySnapshot);
    const api = createWhiteLilyApi({
      invoke,
      subscribe: () => () => undefined,
    } as PreloadTransport);
    let getterCalls = 0;
    const accessorInput = Object.defineProperties(
      {},
      {
        expectedRevision: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return 7;
          },
        },
        ownerUsername: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return "NewOwner";
          },
        },
      },
    );
    const exoticInput = Object.assign(Object.create({ inherited: true }), {
      expectedRevision: 7,
      ownerUsername: "NewOwner",
    });

    for (const input of [
      { expectedRevision: -1, ownerUsername: "NewOwner" },
      { expectedRevision: 7.5, ownerUsername: "NewOwner" },
      { expectedRevision: 7, ownerUsername: "../../../config.toml" },
      { expectedRevision: 7, ownerUsername: "WhiteLily" },
      { expectedRevision: 7, ownerUsername: "ab" },
      { expectedRevision: 7, ownerUsername: "NewOwner", path: String.raw`C:\config.toml` },
      { expectedRevision: 7, ownerUsername: "NewOwner", toml: "owner = 'Mallory'" },
      { expectedRevision: 7, ownerUsername: "NewOwner", token: "secret" },
      accessorInput,
      exoticInput,
    ]) {
      await expect(api.updateOwnerIdentity(input as never)).rejects.toThrow("invalid");
    }
    await expect(
      (
        api.updateOwnerIdentity as unknown as (
          ...args: readonly unknown[]
        ) => Promise<OwnerIdentitySnapshot>
      )({ expectedRevision: 7, ownerUsername: "NewOwner" }, { token: "secret" }),
    ).rejects.toThrow("invalid");
    await expect(
      (api.readOwnerIdentity as unknown as (input: unknown) => Promise<OwnerIdentitySnapshot>)({
        path: String.raw`C:\config.toml`,
      }),
    ).rejects.toThrow("invalid");
    expect(getterCalls).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("parses every owner result and dedicated event before renderer delivery", async () => {
    const subscriptions = new Map<string, (value: unknown) => void>();
    let resultGetterCalls = 0;
    const accessorResult = Object.defineProperties(
      {},
      {
        revision: {
          enumerable: true,
          get: () => {
            resultGetterCalls += 1;
            return 8;
          },
        },
        ownerUsername: { enumerable: true, value: "NewOwner" },
        configured: { enumerable: true, value: true },
        presence: { enumerable: true, value: "online" },
        childGeneration: { enumerable: true, value: 7 },
      },
    );
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ...ownerAuthoritySnapshot, token: "secret" })
      .mockResolvedValueOnce({
        ...ownerAuthoritySnapshot,
        revision: 8,
        path: String.raw`C:\config.toml`,
      })
      .mockResolvedValueOnce({ ...ownerAuthoritySnapshot, ownerUsername: "WhiteLily" })
      .mockResolvedValueOnce(accessorResult);
    const api = createWhiteLilyApi({
      invoke,
      subscribe: (channel, listener) => {
        subscriptions.set(channel, listener);
        return () => subscriptions.delete(channel);
      },
    } as PreloadTransport);
    const runtimeListener = vi.fn();
    const ownerListener = vi.fn();
    api.subscribeRuntime(runtimeListener);
    const unsubscribeOwner = api.subscribeOwnerIdentity(ownerListener);

    await expect(api.readOwnerIdentity()).rejects.toThrow("invalid");
    await expect(
      api.updateOwnerIdentity({ expectedRevision: 7, ownerUsername: "NewOwner" }),
    ).rejects.toThrow("invalid");
    await expect(api.readOwnerIdentity()).rejects.toThrow("invalid");
    await expect(api.readOwnerIdentity()).rejects.toThrow("invalid");
    expect(resultGetterCalls).toBe(0);

    subscriptions.get(WHITE_LILY_IPC_CHANNELS.runtimeEvent)?.({
      kind: "owner_identity",
      owner: ownerSnapshot,
    });
    expect(runtimeListener).not.toHaveBeenCalled();

    const ownerEvent = subscriptions.get(WHITE_LILY_IPC_CHANNELS.ownerIdentityEvent);
    ownerEvent?.(ownerAuthoritySnapshot);
    expect(ownerListener).toHaveBeenCalledWith(ownerAuthoritySnapshot);

    let getterCalls = 0;
    const accessorSnapshot = Object.defineProperty({}, "revision", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 8;
      },
    });
    for (const malformed of [
      { ...ownerAuthoritySnapshot, path: String.raw`C:\config.toml` },
      { ...ownerAuthoritySnapshot, toml: "owner = 'Mallory'" },
      { ...ownerAuthoritySnapshot, token: "secret" },
      { ...ownerAuthoritySnapshot, extra: true },
      { ...ownerAuthoritySnapshot, configured: false },
      { ...ownerAuthoritySnapshot, ownerUsername: "WhiteLily" },
      { ...ownerSnapshot },
      { ...ownerAuthoritySnapshot, childGeneration: 0 },
      { ...ownerAuthoritySnapshot, childGeneration: 7.5 },
      accessorSnapshot,
      Object.assign(Object.create({ inherited: true }), ownerAuthoritySnapshot),
    ]) {
      ownerEvent?.(malformed);
    }
    expect(ownerListener).toHaveBeenCalledTimes(1);
    expect(getterCalls).toBe(0);

    unsubscribeOwner();
    unsubscribeOwner();
    expect(subscriptions.has(WHITE_LILY_IPC_CHANNELS.ownerIdentityEvent)).toBe(false);
    expect(subscriptions.has(WHITE_LILY_IPC_CHANNELS.runtimeEvent)).toBe(true);
    expect(() =>
      (api.subscribeOwnerIdentity as unknown as (...args: readonly unknown[]) => () => void)(
        ownerListener,
        { token: "secret" },
      ),
    ).toThrow("invalid");
  });

  it("round-trips opaque memory migration capabilities without renderer world identity", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        migrationId: "migration_opaque_1234",
        sourceRevision: 7,
        targetScope: "world",
        deduplicatedCount: 1,
        movedCount: 2,
      })
      .mockResolvedValueOnce({
        migrationId: "migration_opaque_1234",
        status: "committed",
      })
      .mockResolvedValueOnce({
        migrationId: "migration_opaque_1234",
        status: "rolled_back",
      });
    const api = createWhiteLilyApi({ invoke, subscribe: vi.fn() });

    await expect(api.previewMemoryMigration("world")).resolves.toMatchObject({
      migrationId: "migration_opaque_1234",
      targetScope: "world",
    });
    await api.commitMemoryMigration({
      migrationId: "migration_opaque_1234",
      sourceRevision: 7,
    });
    await api.rollbackMemoryMigration("migration_opaque_1234");

    expect(invoke.mock.calls).toEqual([
      [WHITE_LILY_IPC_CHANNELS.previewMemoryMigration, "world"],
      [
        WHITE_LILY_IPC_CHANNELS.commitMemoryMigration,
        { migrationId: "migration_opaque_1234", sourceRevision: 7 },
      ],
      [WHITE_LILY_IPC_CHANNELS.rollbackMemoryMigration, "migration_opaque_1234"],
    ]);
  });
  it("parses document mutations and forwards only last-observed revisions", async () => {
    const profileEnvelope = {
      schemaVersion: 1,
      revision: 7,
      updatedAt: "2026-07-29T00:00:00.000Z",
      value: profile,
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === WHITE_LILY_IPC_CHANNELS.readProfile) return profileEnvelope;
      return { envelope: profileEnvelope, liveStatus: "applied" };
    });
    const api = createWhiteLilyApi({
      invoke,
      subscribe: () => () => undefined,
    } as PreloadTransport);

    await expect(api.readProfile()).resolves.toEqual(profileEnvelope);
    await api.updateProfile({ expectedRevision: 7, profile });
    expect(invoke).toHaveBeenLastCalledWith(WHITE_LILY_IPC_CHANNELS.updateProfile, {
      expectedRevision: 7,
      profile,
    });
    await expect(
      api.updateProfile({ expectedRevision: 7, profile: { ...profile, unknown: true } } as never),
    ).rejects.toThrow("invalid");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("never forwards a renderer path or serialized memory value to safe export", async () => {
    const invoke = vi.fn(async () => ({ status: "saved" }));
    const api = createWhiteLilyApi({
      invoke,
      subscribe: () => () => undefined,
    } as PreloadTransport);

    await (api.exportMemories as unknown as (path: string) => Promise<unknown>)(
      String.raw`C:\private\arbitrary.json`,
    );
    expect(invoke).toHaveBeenCalledWith(WHITE_LILY_IPC_CHANNELS.exportMemories);
  });

  it("forwards stored world scope without accepting a renderer-supplied world ID", async () => {
    const timestamp = "2026-07-29T00:00:00.000Z";
    const record = {
      id: 1,
      category: "project" as const,
      summary: "World tower",
      importance: 3 as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      scope: "world" as const,
      worldId: "12345678-1234-4234-8234-123456789abc",
      source: "manual" as const,
      pinned: false,
      revision: 0,
    };
    const invoke = vi.fn(async () => ({
      envelope: {
        schemaVersion: 1,
        revision: 1,
        updatedAt: timestamp,
        records: [record],
        legacyMigrated: true,
      },
      record,
    }));
    const api = createWhiteLilyApi({
      invoke,
      subscribe: () => () => undefined,
    } as PreloadTransport);

    await api.addMemory({
      expectedRevision: 0,
      memory: {
        category: "project",
        summary: "World tower",
        importance: 3,
        scope: "world",
      },
    });
    await api.updateMemory({
      id: 1,
      expectedRevision: 1,
      recordRevision: 0,
      patch: { scope: "global" },
    });
    expect(invoke.mock.calls).toEqual([
      [
        WHITE_LILY_IPC_CHANNELS.addMemory,
        {
          expectedRevision: 0,
          memory: {
            category: "project",
            summary: "World tower",
            importance: 3,
            scope: "world",
          },
        },
      ],
      [
        WHITE_LILY_IPC_CHANNELS.updateMemory,
        {
          id: 1,
          expectedRevision: 1,
          recordRevision: 0,
          patch: { scope: "global" },
        },
      ],
    ]);
    await expect(
      api.addMemory({
        expectedRevision: 1,
        memory: {
          category: "project",
          summary: "forged",
          importance: 3,
          scope: "world",
          worldId: "renderer-forged-world",
        },
      } as never),
    ).rejects.toThrow("invalid");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("accepts only booleans for dedicated startup and close-to-tray setters", async () => {
    const invoke = vi.fn(async (channel: string, input?: unknown) => {
      if (channel === WHITE_LILY_IPC_CHANNELS.setCloseToTraySetting) {
        const setting = input as { expectedRevision: number; enabled: boolean };
        return { revision: setting.expectedRevision + 1, enabled: setting.enabled };
      }
      return { enabled: input, available: true };
    });
    const api = createWhiteLilyApi({
      invoke,
      subscribe: () => () => undefined,
    } as PreloadTransport);

    await api.setStartupSetting(true);
    await api.setCloseToTraySetting({ expectedRevision: 4, enabled: false });
    expect(invoke.mock.calls).toEqual([
      [WHITE_LILY_IPC_CHANNELS.setStartupSetting, true],
      [WHITE_LILY_IPC_CHANNELS.setCloseToTraySetting, { expectedRevision: 4, enabled: false }],
    ]);
    await expect(api.setStartupSetting({ path: "evil.exe" } as never)).rejects.toThrow("invalid");
    await expect(api.setCloseToTraySetting("yes" as never)).rejects.toThrow("invalid");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
