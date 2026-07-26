import { ActionExecutor, type ActionSafety } from "../../src/actions/actionExecutor.js";
import type { SafetyDecision } from "../../src/domain/types.js";
import { FakeMinecraftPort } from "../../src/minecraft/fakeMinecraftPort.js";
import type { ToolRegistryDependencies } from "../../src/mcp/toolRegistry.js";
import { TurnToolBudget } from "../../src/mcp/toolBudget.js";
import { ConfirmationStore } from "../../src/safety/confirmationStore.js";
import type { SafetyContext } from "../../src/safety/safetyEngine.js";

export function createToolRegistryHarness(
  options: { begun?: boolean; safety?: ActionSafety } = {},
) {
  const minecraft = new FakeMinecraftPort();
  const budget = new TurnToolBudget();
  let activeLease = options.begun !== false ? budget.begin() : "a".repeat(43);
  const contexts: SafetyContext[] = [];
  const defaultSafety: ActionSafety = {
    evaluate: (_action, context): SafetyDecision => {
      contexts.push(context);
      return { kind: "allow" };
    },
    evaluatePermanent: (): SafetyDecision => ({ kind: "allow" }),
  };
  const executor = new ActionExecutor(
    minecraft,
    options.safety ?? defaultSafety,
    new ConfirmationStore(),
    "TestOwner",
  );
  const safetyContextProvider = async (): Promise<SafetyContext> => ({
    spawn: { x: -100, y: 64, z: -100 },
    owner: { x: 0, y: 64, z: 0 },
  });
  const dependencies: ToolRegistryDependencies = {
    minecraft,
    executor,
    budget,
    safetyContextProvider,
    ownerUsername: "TestOwner",
    latestSnapshot: () => minecraft.world,
  };
  return {
    minecraft,
    budget,
    contexts,
    executor,
    dependencies,
    get turnLease(): string {
      return activeLease;
    },
    beginTurn(): string {
      activeLease = budget.begin();
      return activeLease;
    },
  };
}
