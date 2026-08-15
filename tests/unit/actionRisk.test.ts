import { describe, expect, it } from "vitest";
import { classifyActionRisk } from "../../src/safety/actionRisk.js";

describe("classifyActionRisk", () => {
  it.each(["tnt", "minecraft:lava_bucket", "fire", "flint_and_steel"])(
    "classifies %s as dangerous",
    (blockName) => {
      expect(
        classifyActionRisk(
          { kind: "place_block", position: { x: 1, y: 64, z: 1 }, blockName },
          { owner: { x: 0, y: 64, z: 0 } },
        ),
      ).toMatchObject({ level: "dangerous", dangerousOperations: 1 });
    },
  );

  it("classifies a protected target attack as dangerous", () => {
    expect(
      classifyActionRisk(
        { kind: "attack_hostile", entityId: 7 },
        { owner: { x: 0, y: 64, z: 0 }, protectedTarget: "pet" },
      ),
    ).toMatchObject({ level: "dangerous", dangerousOperations: 1 });
  });

  it("counts tilling soil as a dangerous world operation", () => {
    expect(
      classifyActionRisk(
        { kind: "till_soil", position: { x: 1, y: 64, z: 1 } },
        { owner: { x: 0, y: 64, z: 0 }, wheatFarmingAllowed: true },
      ),
    ).toMatchObject({ level: "dangerous", dangerousOperations: 1 });
  });
});
