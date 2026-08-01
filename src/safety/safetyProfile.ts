import { HARD_TASK_LIMITS, effectiveTaskLimits, type TaskLimits } from "./taskBudget.js";
import { safetyPresetSchema, type SafetyPreset } from "./safetyPreset.js";

export { safetyPresetSchema } from "./safetyPreset.js";
export type { SafetyPreset } from "./safetyPreset.js";

export interface EffectiveSafetyProfile {
  preset: SafetyPreset;
  taskLimits: TaskLimits;
}

export interface RuntimeSafetyConfiguration {
  readonly requestedPreset?: SafetyPreset;
  readonly compatibilityVerified: boolean;
}

const conservativeLimits: Readonly<TaskLimits> = Object.freeze({
  maxToolCalls: 16,
  maxBlockChanges: 0,
  maxHorizontalTravel: 128,
  maxDurationMs: 120_000,
  maxDangerousOperations: 0,
});

/**
 * Compatibility is the authority boundary: an unknown or unverified version
 * cannot obtain a less restrictive preset, regardless of renderer input.
 */
export function effectiveSafetyProfile(
  requestedPreset: SafetyPreset | undefined,
  compatibilityVerified: boolean,
  requestedLimits: Partial<TaskLimits> = {},
): EffectiveSafetyProfile {
  const preset: SafetyPreset =
    compatibilityVerified && requestedPreset === "standard" ? "standard" : "conservative";
  const requested = preset === "conservative" ? conservativeLimits : requestedLimits;
  const limits = effectiveTaskLimits(requested);
  return {
    preset,
    taskLimits: {
      ...limits,
      maxDangerousOperations: 0,
      maxToolCalls: Math.min(limits.maxToolCalls, HARD_TASK_LIMITS.maxToolCalls),
      maxBlockChanges: Math.min(limits.maxBlockChanges, HARD_TASK_LIMITS.maxBlockChanges),
      maxHorizontalTravel: Math.min(
        limits.maxHorizontalTravel,
        HARD_TASK_LIMITS.maxHorizontalTravel,
      ),
      maxDurationMs: Math.min(limits.maxDurationMs, HARD_TASK_LIMITS.maxDurationMs),
    },
  };
}

export function isAutonomousSafetyAllowed(
  requestedPreset: SafetyPreset | undefined,
  compatibilityVerified: boolean,
): boolean {
  return effectiveSafetyProfile(requestedPreset, compatibilityVerified).preset === "standard";
}
