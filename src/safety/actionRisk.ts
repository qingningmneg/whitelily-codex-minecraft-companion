import type { GameAction } from "../domain/types.js";
import type { SafetyContext } from "./safetyEngine.js";

export interface ActionRisk {
  level: "low" | "standard" | "dangerous";
  dangerousOperations: 0 | 1;
  reason?: string;
}

const permanentlyDangerousItems = new Set([
  "tnt",
  "lava",
  "lava_bucket",
  "flowing_lava",
  "fire",
  "soul_fire",
  "flint_and_steel",
  "fire_charge",
]);

export function canonicalMinecraftName(name: string): string {
  return name.toLowerCase().replace(/^minecraft:/, "");
}

function isDangerousItemAction(action: GameAction): boolean {
  const itemName =
    action.kind === "place_block" || action.kind === "dig_block"
      ? action.blockName
      : action.kind === "equip_item"
        ? action.itemName
        : undefined;
  return itemName !== undefined && permanentlyDangerousItems.has(canonicalMinecraftName(itemName));
}

export function classifyActionRisk(action: GameAction, context: SafetyContext): ActionRisk {
  if (
    action.kind === "till_soil" ||
    isDangerousItemAction(action) ||
    (action.kind === "attack_hostile" && context.protectedTarget !== undefined)
  ) {
    return {
      level: "dangerous",
      dangerousOperations: 1,
      reason: "action requires explicit world high-risk authorization",
    };
  }
  return { level: "standard", dangerousOperations: 0 };
}
