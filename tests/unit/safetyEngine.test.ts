import { describe, expect, it } from "vitest";
import { ConfirmationStore } from "../../src/safety/confirmationStore.js";
import { SafetyEngine } from "../../src/safety/safetyEngine.js";

const origin = { x: 0, y: 64, z: 0 };
const outsideSpawn = { x: 20, y: 64, z: 0 };
const taskLease = { id: "task-lease-a", startedAt: 1_000 };

function createSafety() {
  const confirmations = new ConfirmationStore(() => new Date("2026-07-25T00:00:00Z"));
  return { confirmations, engine: new SafetyEngine(confirmations, undefined, () => true) };
}

describe("SafetyEngine", () => {
  it.each([
    { kind: "till_soil" as const, position: outsideSpawn },
    { kind: "plant_crop" as const, position: outsideSpawn, seedName: "wheat_seeds" as const },
  ])("permanently denies $kind without wheat farming permission", (action) => {
    const { engine } = createSafety();

    expect(engine.evaluate(action, { spawn: origin, owner: outsideSpawn })).toEqual({
      kind: "deny",
      reason: "Wheat farming permission is required",
    });
    expect(
      engine.evaluate(action, {
        spawn: origin,
        owner: outsideSpawn,
        wheatFarmingAllowed: true,
      }),
    ).toEqual({ kind: "allow" });
  });

  it.each([
    { kind: "till_soil" as const, position: outsideSpawn },
    { kind: "plant_crop" as const, position: outsideSpawn, seedName: "wheat_seeds" as const },
    { kind: "harvest_crop" as const, position: outsideSpawn, cropName: "wheat" as const },
  ])("treats $kind as a protected block change", (action) => {
    const { engine } = createSafety();
    const permission = { wheatFarmingAllowed: true };

    expect(engine.evaluate(action, { owner: outsideSpawn, ...permission })).toEqual({
      kind: "deny",
      reason: "World spawn is unknown; block changes are disabled",
    });
    expect(
      engine.evaluate(
        { ...action, position: { x: 16, y: 64, z: 0 } },
        { spawn: origin, owner: outsideSpawn, ...permission },
      ),
    ).toEqual({ kind: "deny", reason: "Spawn protection radius is 16 blocks" });
  });

  it("permanently denies TNT without creating a confirmation", () => {
    const { confirmations, engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "place_block", blockName: "TnT", position: outsideSpawn },
        { spawn: origin, owner: outsideSpawn, estimatedPlaceCount: 129 },
      ),
    ).toEqual({ kind: "deny", reason: "TNT is permanently forbidden" });
    expect(confirmations.get(1)).toBeUndefined();
  });

  it.each(["lava", "lava_bucket", "fire", "flint_and_steel"])(
    "permanently denies destructive block %s regardless of case",
    (blockName) => {
      const { engine } = createSafety();

      expect(
        engine.evaluate(
          { kind: "dig_block", blockName: blockName.toUpperCase(), position: outsideSpawn },
          { spawn: origin, owner: outsideSpawn },
        ),
      ).toEqual({ kind: "deny", reason: "Lava and destructive fire are permanently forbidden" });
    },
  );

  it("denies an edit exactly on the 16-block spawn-radius boundary", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "dig_block", blockName: "stone", position: { x: 16, y: 64, z: 0 } },
        { spawn: origin, owner: outsideSpawn },
      ),
    ).toEqual({ kind: "deny", reason: "Spawn protection radius is 16 blocks" });
  });

  it("allows an ordinary edit immediately outside the spawn-radius boundary", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "dig_block", blockName: "stone", position: { x: 16.01, y: 64, z: 0 } },
        { spawn: origin, owner: outsideSpawn },
      ),
    ).toEqual({ kind: "allow" });
  });

  it.each([
    { kind: "dig_block" as const, blockName: "stone", position: outsideSpawn },
    { kind: "place_block" as const, blockName: "stone", position: outsideSpawn },
  ])(
    "fails closed for block-changing action $kind while authoritative spawn is unknown",
    (action) => {
      const { engine } = createSafety();

      expect(engine.evaluate(action, { owner: outsideSpawn })).toEqual({
        kind: "deny",
        reason: "World spawn is unknown; block changes are disabled",
      });
    },
  );

  it.each(["player", "villager", "pet"] as const)(
    "permanently denies attacks against protected %s targets",
    (protectedTarget) => {
      const { confirmations, engine } = createSafety();

      expect(
        engine.evaluate(
          { kind: "attack_hostile", entityId: 7 },
          {
            spawn: origin,
            owner: outsideSpawn,
            protectedTarget,
            isPassiveTarget: true,
          },
        ),
      ).toEqual({
        kind: "deny",
        reason: `Attacking a ${protectedTarget} is permanently forbidden`,
      });
      expect(confirmations.get(1)).toBeUndefined();
    },
  );

  it("allows a break count at its confirmation threshold", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "dig_block", blockName: "stone", position: outsideSpawn },
        { spawn: origin, owner: outsideSpawn, estimatedBreakCount: 32 },
      ),
    ).toEqual({ kind: "allow" });
  });

  it("requires confirmation above the break threshold", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "dig_block", blockName: "stone", position: outsideSpawn },
        { spawn: origin, owner: outsideSpawn, estimatedBreakCount: 33, taskLease },
      ),
    ).toMatchObject({ kind: "confirm", reason: "Break count 33 exceeds 32", confirmationId: 1 });
  });

  it("does not create a confirmation when a threshold action lacks a live task capability", () => {
    const { confirmations, engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "dig_block", blockName: "stone", position: outsideSpawn },
        { spawn: origin, owner: outsideSpawn, estimatedBreakCount: 33 },
      ),
    ).toEqual({
      kind: "deny",
      reason: "A live task capability is required for confirmation",
    });
    expect(confirmations.get(1)).toBeUndefined();
  });

  it("does not apply accumulated dig estimates to unrelated actions", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "say", message: "ordinary status update" },
        { spawn: origin, owner: outsideSpawn, estimatedBreakCount: 33 },
      ),
    ).toEqual({ kind: "allow" });
  });

  it("allows a place count at its confirmation threshold", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "place_block", blockName: "stone", position: outsideSpawn },
        { spawn: origin, owner: outsideSpawn, estimatedPlaceCount: 128 },
      ),
    ).toEqual({ kind: "allow" });
  });

  it("requires confirmation above the place threshold", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "place_block", blockName: "stone", position: outsideSpawn },
        { spawn: origin, owner: outsideSpawn, estimatedPlaceCount: 129, taskLease },
      ),
    ).toMatchObject({ kind: "confirm", reason: "Place count 129 exceeds 128", confirmationId: 1 });
  });

  it("does not apply a place total to an unrelated chat action", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "say", message: "ordinary status update" },
        { spawn: origin, owner: outsideSpawn, estimatedPlaceCount: 129 },
      ),
    ).toEqual({ kind: "allow" });
  });

  it("allows movement at the travel threshold", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "move_to", position: { x: 256, y: 64, z: 0 } },
        { spawn: origin, owner: origin, taskLease, reservedHorizontalTravel: 256.01 },
      ),
    ).toEqual({ kind: "allow" });
  });

  it("requires confirmation for movement beyond the travel threshold", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "move_to", position: { x: 256.01, y: 64, z: 0 } },
        { spawn: origin, owner: origin, taskLease, reservedHorizontalTravel: 256.01 },
      ),
    ).toMatchObject({
      kind: "confirm",
      reason: "Travel distance exceeds 256 blocks",
      confirmationId: 1,
    });
  });

  it("uses cumulative trusted travel only for movement confirmation", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "move_to", position: { x: 1, y: 64, z: 0 } },
        {
          spawn: origin,
          owner: origin,
          estimatedTravelDistance: 256.01,
          taskLease,
          reservedHorizontalTravel: 1,
        },
      ),
    ).toMatchObject({ kind: "confirm", reason: "Travel distance exceeds 256 blocks" });
  });

  it("requires confirmation before attacking a passive target", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "attack_hostile", entityId: 7 },
        { spawn: origin, owner: outsideSpawn, isPassiveTarget: true, taskLease },
      ),
    ).toMatchObject({
      kind: "confirm",
      reason: "Attacking a passive entity requires confirmation",
      confirmationId: 1,
    });
  });

  it("requires confirmation before equipping a valuable item", () => {
    const { engine } = createSafety();

    expect(
      engine.evaluate(
        { kind: "equip_item", itemName: "diamond_sword", destination: "hand" },
        { spawn: origin, owner: outsideSpawn, isValuableItem: true, taskLease },
      ),
    ).toMatchObject({
      kind: "confirm",
      reason: "Handling a valuable item requires confirmation",
      confirmationId: 1,
    });
  });

  it.each(["tnt", "lava_bucket", "flint_and_steel", "fire_charge"])(
    "permanently denies equipping dangerous item %s",
    (itemName) => {
      const { confirmations, engine } = createSafety();

      expect(
        engine.evaluate(
          { kind: "equip_item", itemName, destination: "hand" },
          { spawn: origin, owner: outsideSpawn },
        ),
      ).toEqual({
        kind: "deny",
        reason: "TNT, lava, and destructive fire items are permanently forbidden",
      });
      expect(confirmations.get(1)).toBeUndefined();
    },
  );
});
