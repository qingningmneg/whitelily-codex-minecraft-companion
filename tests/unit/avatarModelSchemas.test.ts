import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_AVATAR_MODEL_IDS,
  parseAvatarModelCatalogSnapshot,
  parseAvatarModelControlRequest,
  parseAvatarModelControlState,
  parseAvatarModelRecord,
  parseAvatarRuntimeDescriptor,
  type AvatarBoneMapping,
  type AvatarModelRecord,
} from "../../src/avatar/avatarModelSchemas.js";

const fixturesRoot = new URL(
  "../../subprojects/whitelily-avatar/protocol/fixtures/",
  import.meta.url,
);

const sha256 = "a".repeat(64);

const boneMapping = {
  head: "Head",
  neck: "Neck",
  chest: "Chest",
  hips: "Hips",
  leftUpperArm: "LeftUpperArm",
  leftLowerArm: "LeftLowerArm",
  leftHand: "LeftHand",
  rightUpperArm: "RightUpperArm",
  rightLowerArm: "RightLowerArm",
  rightHand: "RightHand",
  leftUpperLeg: "LeftUpperLeg",
  leftLowerLeg: "LeftLowerLeg",
  leftFoot: "LeftFoot",
  rightUpperLeg: "RightUpperLeg",
  rightLowerLeg: "RightLowerLeg",
  rightFoot: "RightFoot",
} as const satisfies AvatarBoneMapping;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, fixturesRoot)), "utf8")) as unknown;
}

function record(overrides: Partial<AvatarModelRecord> = {}): AvatarModelRecord {
  return {
    id: "user:00000000-0000-4000-8000-000000000001",
    displayName: "Imported avatar",
    origin: "imported",
    format: "glb",
    resourcePath: "user/00000000-0000-4000-8000-000000000001/model.glb",
    sha256,
    importedAt: "2026-08-16T08:00:00.000Z",
    previewPath: "user/00000000-0000-4000-8000-000000000001/preview.png",
    previewStatus: "ready",
    boneMapping,
    bodyAnimation: "whitelily-humanoid-v1",
    expressions: "neutral-only",
    validation: {
      code: "AVATAR_VALID",
      validatedAt: "2026-08-16T08:00:01.000Z",
    },
    ...overrides,
  };
}

describe("avatar model schemas", () => {
  it("parses the reviewed prepare, ready, and committed cross-language fixtures", () => {
    const request = parseAvatarModelControlRequest(fixture("prepare-request.json"));
    const ready = parseAvatarModelControlState(fixture("ready-state.json"));
    const committed = parseAvatarModelControlState(fixture("committed-state.json"));

    expect(request).toMatchObject({
      requestId: "switch-0001",
      operation: "prepare",
      modelId: "builtin:whitelily-hd",
      candidate: {
        origin: "builtin",
        resourcePath: "builtin/whitelily-hd/high.glb",
      },
    });
    expect(ready).toMatchObject({
      requestId: "switch-0001",
      phase: "ready",
      activeModelId: "builtin:whitelily-classic",
      candidateModelId: "builtin:whitelily-hd",
    });
    expect(committed).toMatchObject({
      requestId: "switch-0001",
      phase: "committed",
      activeModelId: "builtin:whitelily-hd",
      candidateModelId: "builtin:whitelily-hd",
    });
  });

  it("keeps the two builtins in the fixed product order", () => {
    expect(BUILTIN_AVATAR_MODEL_IDS).toEqual(["builtin:whitelily-hd", "builtin:whitelily-classic"]);
    expect(Object.isFrozen(BUILTIN_AVATAR_MODEL_IDS)).toBe(true);
  });

  it.each([
    "",
    "../escape.glb",
    "models/../escape.glb",
    "C:\\outside.glb",
    "/outside.glb",
    "https://host/model.glb",
    "user\\avatar\\model.glb",
  ])("rejects an unsafe managed resource path: %s", (resourcePath) => {
    expect(() => parseAvatarModelRecord(record({ resourcePath }))).toThrow(
      "invalid avatar model record",
    );
  });

  it("rejects duplicate semantic bone mappings", () => {
    expect(() =>
      parseAvatarModelRecord(record({ boneMapping: { ...boneMapping, neck: boneMapping.head } })),
    ).toThrow("invalid avatar model record");
  });

  it.each([
    record({ id: "builtin:whitelily-hd", origin: "imported", format: "glb" }),
    record({ id: "user:00000000-0000-4000-8000-000000000001", origin: "builtin" }),
    record({ origin: "builtin", format: "builtin-classic" }),
  ])("rejects records whose id, origin, and format disagree", (value) => {
    expect(() => parseAvatarModelRecord(value)).toThrow("invalid avatar model record");
  });

  it("requires prepare candidates to match the outer model id", () => {
    const request = fixture("prepare-request.json") as Record<string, unknown>;
    const candidate = request.candidate as Record<string, unknown>;
    expect(() =>
      parseAvatarModelControlRequest({
        ...request,
        candidate: { ...candidate, modelId: "builtin:whitelily-classic" },
      }),
    ).toThrow("invalid avatar model control request");
  });

  it("rejects a committed state that names a different active model", () => {
    const state = fixture("committed-state.json") as Record<string, unknown>;
    expect(() =>
      parseAvatarModelControlState({
        ...state,
        activeModelId: "builtin:whitelily-classic",
      }),
    ).toThrow("invalid avatar model control state");
  });

  it("requires a stable error code only for failed states", () => {
    const ready = fixture("ready-state.json") as Record<string, unknown>;
    expect(() =>
      parseAvatarModelControlState({ ...ready, errorCode: "AVATAR_MESH_LOAD_FAILED" }),
    ).toThrow("invalid avatar model control state");

    expect(
      parseAvatarModelControlState({
        ...ready,
        phase: "failed",
        errorCode: "AVATAR_MESH_LOAD_FAILED",
      }),
    ).toMatchObject({ phase: "failed", errorCode: "AVATAR_MESH_LOAD_FAILED" });
  });

  it("rejects unknown fields at every public protocol boundary", () => {
    expect(() => parseAvatarModelRecord({ ...record(), unexpected: true })).toThrow();
    expect(() =>
      parseAvatarModelControlRequest({
        ...(fixture("prepare-request.json") as object),
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      parseAvatarModelControlState({
        ...(fixture("ready-state.json") as object),
        unexpected: true,
      }),
    ).toThrow();
  });

  it("parses renderer-safe catalog snapshots without managed paths", () => {
    const parsed = parseAvatarModelCatalogSnapshot({
      revision: 4,
      models: [
        {
          id: "builtin:whitelily-hd",
          displayName: "WhiteLily 高清动漫 3D",
          origin: "builtin",
          format: "builtin-hd",
          previewDataUrl: "data:image/png;base64,iVBORw0KGgo=",
          bodyAnimation: "whitelily-humanoid-v1",
          expressions: "full",
        },
        {
          id: "builtin:whitelily-classic",
          displayName: "WhiteLily 经典 Minecraft",
          origin: "builtin",
          format: "builtin-classic",
          previewDataUrl: "data:image/png;base64,iVBORw0KGgo=",
          bodyAnimation: "whitelily-humanoid-v1",
          expressions: "full",
        },
      ],
      activeModelId: "builtin:whitelily-hd",
      pendingModelId: "builtin:whitelily-classic",
    });

    expect(parsed.models[0]).not.toHaveProperty("resourcePath");
    expect(parsed.activeModelId).toBe("builtin:whitelily-hd");
  });

  it("rejects runtime descriptors that could expose an imported model as builtin", () => {
    expect(() =>
      parseAvatarRuntimeDescriptor({
        modelId: "user:00000000-0000-4000-8000-000000000001",
        origin: "builtin",
        format: "glb",
        resourcePath: "user/00000000-0000-4000-8000-000000000001/model.glb",
        sha256,
        boneMapping,
        bodyAnimation: "whitelily-humanoid-v1",
        expressions: "neutral-only",
      }),
    ).toThrow("invalid avatar runtime descriptor");
  });
});
