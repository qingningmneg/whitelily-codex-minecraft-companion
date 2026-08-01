import type { CompanionMode } from "../domain/types.js";
import type { BehaviorModeSettings } from "./profileSchema.js";

export type UnsolicitedActivity =
  | "proactive_chat"
  | "suggestion"
  | "low_risk_micro_action"
  | "world_mutation"
  | "high_risk_action"
  | "large_project";

export interface BehaviorPolicyInput {
  readonly mode: CompanionMode;
  readonly activity: UnsolicitedActivity;
  readonly settings: BehaviorModeSettings;
  readonly ownerOnline: boolean;
  readonly hasActiveTask: boolean;
  readonly compatibilityVerified: boolean;
  readonly safetyPresetAllows: boolean;
}

export function isUnsolicitedActivityAllowed(input: BehaviorPolicyInput): boolean {
  if (input.mode === "friend") return false;
  if (input.activity === "high_risk_action" || input.activity === "large_project") {
    return false;
  }

  if (input.mode === "balanced") {
    if (input.activity === "proactive_chat") return input.settings.allowProactiveChat;
    if (input.activity === "suggestion") return input.settings.allowSuggestions;
    return false;
  }

  if (input.activity !== "low_risk_micro_action") return false;
  return (
    input.settings.allowLowRiskMicroActions &&
    input.ownerOnline &&
    !input.hasActiveTask &&
    input.compatibilityVerified &&
    input.safetyPresetAllows
  );
}
