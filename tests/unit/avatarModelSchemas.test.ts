import { describe, expect, it } from "vitest";
import {
  BUILTIN_AVATAR_MODEL_IDS,
  parseAvatarModelCatalogSnapshot,
  parseAvatarModelControlRequest,
  parseAvatarModelRecord,
  parseAvatarRuntimeDescriptor,
} from "../../src/avatar/avatarModelSchemas.js";

const importedId = "user:00000000-0000-4000-8000-000000000001";
const importedSkin = "user/00000000-0000-4000-8000-000000000001/skin.png";

function appearance(overrides: Record<string, unknown> = {}) {
  return {
    id: importedId,
    displayName: "Imported skin",
    origin: "imported",
    worldRenderer: "minecraft-skin",
    skinAsset: importedSkin,
    skinSha256: "a".repeat(64),
    armModel: "wide",
    importedAt: "2026-08-21T00:00:00.000Z",
    validation: { code: "AVATAR_VALID", validatedAt: "2026-08-21T00:00:00.000Z" },
    ...overrides,
  };
}

describe("avatar appearance schemas", () => {
  it("accepts the builtin native skin appearance", () => {
    expect(parseAvatarModelRecord({
      id: "builtin:whitelily",
      displayName: "WhiteLily",
      origin: "builtin",
      worldRenderer: "minecraft-skin",
      skinAsset: "builtin/whitelily/skin/base.png",
      skinSha256: "a".repeat(64),
      armModel: "slim",
      portraitAsset: "builtin/whitelily/portrait.png",
      portraitSha256: "b".repeat(64),
      importedAt: "2026-08-21T00:00:00.000Z",
      validation: { code: "AVATAR_VALID", validatedAt: "2026-08-21T00:00:00.000Z" },
    }).id).toBe("builtin:whitelily");
  });

  it("keeps the sole builtin id frozen", () => {
    expect(BUILTIN_AVATAR_MODEL_IDS).toEqual(["builtin:whitelily"]);
    expect(Object.isFrozen(BUILTIN_AVATAR_MODEL_IDS)).toBe(true);
  });

  it.each([
    "",
    "../escape.png",
    "user/00000000-0000-4000-8000-000000000001/../escape.png",
    "C:\\outside.png",
    "/outside.png",
    "https://host/skin.png",
    "user\\avatar\\skin.png",
    "builtin/other/skin.png",
    "user/other/skin.png",
  ])("rejects an unsafe or incoherent skin asset: %s", (skinAsset) => {
    expect(() => parseAvatarModelRecord(appearance({ skinAsset }))).toThrow(
      "invalid avatar model record",
    );
  });

  it("requires builtin appearances to carry a complete portrait", () => {
    const builtin = {
      ...appearance({
        id: "builtin:whitelily",
        displayName: "WhiteLily",
        origin: "builtin",
        skinAsset: "builtin/whitelily/skin/base.png",
        armModel: "slim",
      }),
    };
    expect(() => parseAvatarModelRecord(builtin)).toThrow("invalid avatar model record");
    expect(() =>
      parseAvatarModelRecord({ ...builtin, portraitAsset: "builtin/whitelily/portrait.png" }),
    ).toThrow("invalid avatar model record");
  });

  it("allows imported appearances without a portrait but rejects half portraits", () => {
    expect(parseAvatarModelRecord(appearance()).id).toBe(importedId);
    expect(() =>
      parseAvatarModelRecord(appearance({ portraitAsset: "user/00000000-0000-4000-8000-000000000001/portrait.png" })),
    ).toThrow("invalid avatar model record");
  });

  it("accepts only the four-field native skin runtime descriptor", () => {
    expect(
      parseAvatarRuntimeDescriptor({
        modelId: "builtin:whitelily",
        origin: "builtin",
        worldRenderer: "minecraft-skin",
        armModel: "slim",
      }),
    ).toEqual({
      modelId: "builtin:whitelily",
      origin: "builtin",
      worldRenderer: "minecraft-skin",
      armModel: "slim",
    });
  });

  it("rejects legacy 3D fields and incoherent runtime descriptors", () => {
    expect(() =>
      parseAvatarRuntimeDescriptor({
        modelId: importedId,
        origin: "builtin",
        worldRenderer: "minecraft-skin",
        armModel: "wide",
      }),
    ).toThrow("invalid avatar runtime descriptor");
    expect(() =>
      parseAvatarRuntimeDescriptor({
        modelId: "builtin:whitelily",
        origin: "builtin",
        worldRenderer: "minecraft-skin",
        armModel: "slim",
        skinAsset: "builtin/whitelily/skin/base.png",
      }),
    ).toThrow("invalid avatar runtime descriptor");
  });

  it("accepts native skin prepare requests without asset paths", () => {
    expect(
      parseAvatarModelControlRequest({
        schemaVersion: 1,
        requestId: "switch-0001",
        operation: "prepare",
        modelId: "builtin:whitelily",
        worldSessionId: "world-0001",
        candidate: {
          modelId: "builtin:whitelily",
          origin: "builtin",
          worldRenderer: "minecraft-skin",
          armModel: "slim",
        },
        issuedAt: "2026-08-21T00:00:00.000Z",
      }).candidate,
    ).not.toHaveProperty("skinAsset");
  });

  it("parses renderer-safe native skin catalog snapshots", () => {
    const parsed = parseAvatarModelCatalogSnapshot({
      revision: 4,
      models: [
        {
          id: "builtin:whitelily",
          displayName: "WhiteLily",
          origin: "builtin",
          worldRenderer: "minecraft-skin",
          armModel: "slim",
          previewDataUrl: "data:image/png;base64,iVBORw0KGgo=",
          portraitDataUrl: "data:image/png;base64,iVBORw0KGgo=",
        },
      ],
      activeModelId: "builtin:whitelily",
    });

    expect(parsed.models[0]).not.toHaveProperty("skinAsset");
    expect(parsed.activeModelId).toBe("builtin:whitelily");
  });
});
