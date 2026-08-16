import { describe, expect, it } from "vitest";
import { createGlbFixture } from "./__fixtures__/createGlbFixture.js";
import { mapAvatarBones } from "./avatarBoneMapper.js";
import { parseGlbContainer } from "./glbContainer.js";

describe("mapAvatarBones", () => {
  it("maps a generic humanoid deterministically and keeps a natural neutral face", () => {
    const result = mapAvatarBones(parseGlbContainer(createGlbFixture()));

    expect(result.mapping).toMatchObject({
      hips: "Hips",
      chest: "Chest",
      head: "Head",
      leftHand: "LeftHand",
      rightFoot: "RightFoot",
    });
    expect(new Set(Object.values(result.mapping)).size).toBe(16);
    expect(result.expressions).toBe("neutral-only");
  });

  it.each(["vrm0", "vrm1"] as const)(
    "uses declared %s humanoid bones and expressions",
    (format) => {
      const result = mapAvatarBones(parseGlbContainer(createGlbFixture({ format })));

      expect(result.mapping.hips).toBe("Hips");
      expect(result.mapping.rightHand).toBe("RightHand");
      expect(result.expressions).toBe("full");
    },
  );

  it.each([
    ["missing required hips", { omitBone: "hips" }],
    [
      "a duplicated VRM semantic node",
      { format: "vrm1", duplicateBone: { semantic: "rightHand", target: "leftHand" } },
    ],
    ["duplicated required node names", { format: "vrm1", duplicateNodeNames: true }],
    ["a broken humanoid hierarchy", { breakHierarchy: true }],
    ["collapsed left and right sides", { collapseSides: true }],
  ] as const)("rejects %s", (_name, options) => {
    expect(() => mapAvatarBones(parseGlbContainer(createGlbFixture(options)))).toThrow(
      expect.objectContaining({ code: "AVATAR_REQUIRED_BONE_MISSING" }),
    );
  });

  it("requires both expression metadata and morph targets before enabling expressions", () => {
    const result = mapAvatarBones(
      parseGlbContainer(createGlbFixture({ format: "vrm1", includeExpressions: false })),
    );

    expect(result.expressions).toBe("neutral-only");
  });
});
