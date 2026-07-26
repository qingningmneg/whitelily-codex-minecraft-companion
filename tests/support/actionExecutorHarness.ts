import { ActionExecutor, type ActionSafety } from "../../src/actions/actionExecutor.js";
import type { SafetyDecision } from "../../src/domain/types.js";
import type { MinecraftPort } from "../../src/minecraft/minecraftPort.js";
import { ConfirmationStore } from "../../src/safety/confirmationStore.js";

export function createActionExecutorHarness(
  minecraft: MinecraftPort,
  decision: SafetyDecision,
  confirmations = new ConfirmationStore(),
): ActionExecutor {
  const safety: ActionSafety = {
    evaluate: () => decision,
    evaluatePermanent: () => decision,
  };
  return new ActionExecutor(minecraft, safety, confirmations, "TestOwner");
}
