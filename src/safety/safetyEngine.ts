import type { GameAction, SafetyDecision, Vec3 } from "../domain/types.js";
import { ConfirmationStore } from "./confirmationStore.js";

export interface SafetyContext {
  spawn?: Vec3;
  owner: Vec3;
  estimatedBreakCount?: number;
  estimatedPlaceCount?: number;
  estimatedTravelDistance?: number;
  isPassiveTarget?: boolean;
  protectedTarget?: "player" | "villager" | "pet";
  isValuableItem?: boolean;
}

export interface SafetyLimits {
  spawnProtectionRadius: number;
  breakConfirmationThreshold: number;
  placeConfirmationThreshold: number;
  travelConfirmationDistance: number;
}

const defaultLimits: SafetyLimits = {
  spawnProtectionRadius: 16,
  breakConfirmationThreshold: 32,
  placeConfirmationThreshold: 128,
  travelConfirmationDistance: 256,
};

function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
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

function canonicalMinecraftName(name: string): string {
  return name.toLowerCase().replace(/^minecraft:/, "");
}

export class SafetyEngine {
  constructor(
    private readonly confirmations: ConfirmationStore,
    private readonly limits: SafetyLimits = defaultLimits,
  ) {}

  evaluatePermanent(action: GameAction, context: SafetyContext): SafetyDecision {
    return this.permanentDecision(action, context) ?? { kind: "allow" };
  }

  evaluate(action: GameAction, context: SafetyContext): SafetyDecision {
    const permanent = this.permanentDecision(action, context);
    if (permanent) return permanent;

    const travelDistance =
      action.kind === "move_to"
        ? (context.estimatedTravelDistance ?? horizontalDistance(action.position, context.owner))
        : undefined;
    const reason =
      action.kind === "dig_block" &&
      (context.estimatedBreakCount ?? 0) > this.limits.breakConfirmationThreshold
        ? `Break count ${context.estimatedBreakCount} exceeds ${this.limits.breakConfirmationThreshold}`
        : action.kind === "place_block" &&
            (context.estimatedPlaceCount ?? 0) > this.limits.placeConfirmationThreshold
          ? `Place count ${context.estimatedPlaceCount} exceeds ${this.limits.placeConfirmationThreshold}`
          : action.kind === "move_to" &&
              travelDistance !== undefined &&
              travelDistance > this.limits.travelConfirmationDistance
            ? `Travel distance exceeds ${this.limits.travelConfirmationDistance} blocks`
            : context.isPassiveTarget
              ? "Attacking a passive entity requires confirmation"
              : context.isValuableItem
                ? "Handling a valuable item requires confirmation"
                : null;

    if (!reason) return { kind: "allow" };

    const pending = this.confirmations.create(reason, {
      kind: "game_action",
      action,
    });
    return {
      kind: "confirm",
      reason,
      confirmationId: pending.id,
      expiresAt: pending.expiresAt.toISOString(),
    };
  }

  private permanentDecision(action: GameAction, context: SafetyContext): SafetyDecision | null {
    if (action.kind === "place_block" && canonicalMinecraftName(action.blockName) === "tnt") {
      return { kind: "deny", reason: "TNT is permanently forbidden" };
    }

    if (
      (action.kind === "place_block" || action.kind === "dig_block") &&
      permanentlyDangerousItems.has(canonicalMinecraftName(action.blockName))
    ) {
      return { kind: "deny", reason: "Lava and destructive fire are permanently forbidden" };
    }

    if (
      action.kind === "equip_item" &&
      permanentlyDangerousItems.has(canonicalMinecraftName(action.itemName))
    ) {
      return {
        kind: "deny",
        reason: "TNT, lava, and destructive fire items are permanently forbidden",
      };
    }

    if (
      (action.kind === "place_block" || action.kind === "dig_block") &&
      context.spawn === undefined
    ) {
      return { kind: "deny", reason: "World spawn is unknown; block changes are disabled" };
    }

    if (
      (action.kind === "place_block" || action.kind === "dig_block") &&
      context.spawn !== undefined &&
      horizontalDistance(action.position, context.spawn) <= this.limits.spawnProtectionRadius
    ) {
      return {
        kind: "deny",
        reason: `Spawn protection radius is ${this.limits.spawnProtectionRadius} blocks`,
      };
    }

    if (action.kind === "attack_hostile" && context.protectedTarget) {
      return {
        kind: "deny",
        reason: `Attacking a ${context.protectedTarget} is permanently forbidden`,
      };
    }

    return null;
  }
}
