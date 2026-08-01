import { describe, expect, it } from "vitest";
import { ConfirmationStore } from "../../src/safety/confirmationStore.js";
import { SafetyEngine } from "../../src/safety/safetyEngine.js";
import {
  effectiveSafetyProfile,
  isAutonomousSafetyAllowed,
  type SafetyPreset,
} from "../../src/safety/safetyProfile.js";

const spawn = { x: 0, y: 64, z: 0 };
const outside = { x: 20, y: 64, z: 0 };

describe("safety profiles", () => {
  it("defaults unverified compatibility to conservative and clamps every requested budget", () => {
    const effective = effectiveSafetyProfile(undefined, false, {
      maxToolCalls: 999,
      maxBlockChanges: 999,
      maxHorizontalTravel: 9999,
      maxDurationMs: 9999999,
      maxDangerousOperations: 99,
    });

    expect(effective.preset).toBe("conservative");
    expect(effective.taskLimits).toEqual({
      maxToolCalls: 16,
      maxBlockChanges: 0,
      maxHorizontalTravel: 128,
      maxDurationMs: 120_000,
      maxDangerousOperations: 0,
    });
  });

  it("never lets standard exceed immutable hard task limits", () => {
    const effective = effectiveSafetyProfile("standard", true, { maxToolCalls: Infinity });

    expect(effective.taskLimits.maxToolCalls).toBe(64);
    expect(effective.taskLimits.maxDangerousOperations).toBe(0);
  });

  it("allows autonomous work only for a compatibility-verified standard preset", () => {
    expect(isAutonomousSafetyAllowed("conservative", true)).toBe(false);
    expect(isAutonomousSafetyAllowed("standard", false)).toBe(false);
    expect(isAutonomousSafetyAllowed("standard", true)).toBe(true);
  });

  it("keeps permanent TNT, lava, destructive fire, spawn, and protected-target denials", () => {
    const engine = new SafetyEngine(new ConfirmationStore());
    const context = { spawn, owner: outside, protectedTarget: "player" as const };

    expect(
      engine.evaluate({ kind: "place_block", blockName: "tnt", position: outside }, context),
    ).toMatchObject({ kind: "deny" });
    expect(
      engine.evaluate({ kind: "place_block", blockName: "lava", position: outside }, context),
    ).toMatchObject({ kind: "deny" });
    expect(
      engine.evaluate({ kind: "place_block", blockName: "fire", position: outside }, context),
    ).toMatchObject({ kind: "deny" });
    expect(
      engine.evaluate({ kind: "dig_block", blockName: "stone", position: spawn }, context),
    ).toMatchObject({ kind: "deny" });
    expect(engine.evaluate({ kind: "attack_hostile", entityId: 7 }, context)).toMatchObject({
      kind: "deny",
    });
  });

  it("does not grant limits by switching companion modes", () => {
    const presets: SafetyPreset[] = ["conservative", "standard"];
    expect(
      presets.map((preset) => effectiveSafetyProfile(preset, true).taskLimits.maxBlockChanges),
    ).toEqual([0, 256]);
  });
});
