import type { RuntimeSnapshot } from "../../../src/runtime/runtimeEvents.js";

export type DesktopConnectionLifecycle =
  | "idle"
  | "detecting"
  | "awaiting_confirmation"
  | "connecting"
  | "connected"
  | "stopping"
  | "failed";

export interface DesktopConnectionProjectionInput {
  readonly runtime: RuntimeSnapshot;
  readonly detecting?: boolean;
  readonly hasCandidates?: boolean;
}

export function projectDesktopConnectionLifecycle(
  input: DesktopConnectionProjectionInput,
): DesktopConnectionLifecycle {
  if (input.runtime.lifecycle === "failed") return "failed";
  if (input.runtime.lifecycle === "stopping") return "stopping";
  if (input.runtime.lifecycle === "running" && input.runtime.minecraft.state === "connected") {
    return "connected";
  }
  if (input.runtime.lifecycle === "starting" || input.runtime.minecraft.state === "connecting") {
    return "connecting";
  }
  if (input.hasCandidates) return "awaiting_confirmation";
  if (input.detecting) return "detecting";
  return "idle";
}
