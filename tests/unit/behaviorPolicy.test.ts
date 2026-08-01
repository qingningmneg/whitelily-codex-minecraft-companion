import { describe, expect, it } from "vitest";
import {
  isUnsolicitedActivityAllowed,
  type BehaviorPolicyInput,
  type UnsolicitedActivity,
} from "../../src/profile/behaviorPolicy.js";
import { createDefaultCompanionProfile } from "../../src/profile/profileSchema.js";

const profileId = "be176ae1-a4b4-4fd6-b04c-89634cd74a99";

function input(
  mode: BehaviorPolicyInput["mode"],
  activity: UnsolicitedActivity,
  overrides: Partial<BehaviorPolicyInput> = {},
): BehaviorPolicyInput {
  const profile = createDefaultCompanionProfile(profileId);
  return {
    mode,
    activity,
    settings: profile.modeSettings[mode],
    ownerOnline: true,
    hasActiveTask: false,
    compatibilityVerified: true,
    safetyPresetAllows: true,
    ...overrides,
  };
}

describe("isUnsolicitedActivityAllowed", () => {
  it.each<UnsolicitedActivity>([
    "proactive_chat",
    "suggestion",
    "low_risk_micro_action",
    "world_mutation",
    "high_risk_action",
    "large_project",
  ])("denies every unsolicited %s activity in friend mode", (activity) => {
    expect(isUnsolicitedActivityAllowed(input("friend", activity))).toBe(false);
  });

  it("allows only configured chat and suggestions in balanced mode", () => {
    expect(isUnsolicitedActivityAllowed(input("balanced", "proactive_chat"))).toBe(true);
    expect(isUnsolicitedActivityAllowed(input("balanced", "suggestion"))).toBe(true);
    expect(isUnsolicitedActivityAllowed(input("balanced", "low_risk_micro_action"))).toBe(false);
    expect(isUnsolicitedActivityAllowed(input("balanced", "world_mutation"))).toBe(false);
    expect(isUnsolicitedActivityAllowed(input("balanced", "high_risk_action"))).toBe(false);
    expect(isUnsolicitedActivityAllowed(input("balanced", "large_project"))).toBe(false);
  });

  it.each([
    ["owner offline", { ownerOnline: false }],
    ["active task", { hasActiveTask: true }],
    ["compatibility unknown", { compatibilityVerified: false }],
    ["safety preset unknown", { safetyPresetAllows: false }],
  ] as const)("denies autonomous micro-actions when %s", (_name, evidence) => {
    expect(
      isUnsolicitedActivityAllowed(input("autonomous", "low_risk_micro_action", evidence)),
    ).toBe(false);
  });

  it("allows an autonomous low-risk micro-action only with every positive proof", () => {
    expect(isUnsolicitedActivityAllowed(input("autonomous", "low_risk_micro_action"))).toBe(true);
  });

  it.each<UnsolicitedActivity>([
    "proactive_chat",
    "suggestion",
    "world_mutation",
    "high_risk_action",
    "large_project",
  ])("denies autonomous %s even with every positive proof", (activity) => {
    expect(isUnsolicitedActivityAllowed(input("autonomous", activity))).toBe(false);
  });

  it("treats profile settings only as restrictions on hard policy", () => {
    expect(
      isUnsolicitedActivityAllowed(
        input("balanced", "proactive_chat", {
          settings: {
            ...createDefaultCompanionProfile(profileId).modeSettings.balanced,
            allowProactiveChat: false,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isUnsolicitedActivityAllowed(
        input("friend", "low_risk_micro_action", {
          settings: {
            idleMinutes: 1,
            allowProactiveChat: true,
            allowSuggestions: true,
            allowLowRiskMicroActions: true,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isUnsolicitedActivityAllowed(
        input("balanced", "world_mutation", {
          settings: {
            idleMinutes: 1,
            allowProactiveChat: true,
            allowSuggestions: true,
            allowLowRiskMicroActions: true,
          },
        }),
      ),
    ).toBe(false);
  });
});
