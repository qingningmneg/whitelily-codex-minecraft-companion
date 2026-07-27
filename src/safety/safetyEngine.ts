import type { GameAction, SafetyDecision, Vec3 } from "../domain/types.js";
import { ConfirmationStore } from "./confirmationStore.js";
import { canonicalMinecraftName, classifyActionRisk } from "./actionRisk.js";
import type { TaskLease } from "./taskBudget.js";

export interface SafetyContext {
  spawn?: Vec3;
  owner: Vec3;
  estimatedBreakCount?: number;
  estimatedPlaceCount?: number;
  estimatedTravelDistance?: number;
  isPassiveTarget?: boolean;
  protectedTarget?: "player" | "villager" | "pet";
  isValuableItem?: boolean;
  taskLease?: TaskLease;
  reservedHorizontalTravel?: number;
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

export class SafetyEngine {
  constructor(
    private readonly confirmations: ConfirmationStore,
    private readonly limits: SafetyLimits = defaultLimits,
    private readonly isTaskLeaseLive: (lease: TaskLease) => boolean = () => false,
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

    if (!context.taskLease || !this.isTaskLeaseLive(context.taskLease)) {
      return {
        kind: "deny",
        reason: "A live task capability is required for confirmation",
      };
    }
    const reservedHorizontalTravel =
      action.kind === "move_to"
        ? (context.reservedHorizontalTravel ?? horizontalDistance(action.position, context.owner))
        : 0;
    const pending = this.confirmations.createGameAction(
      reason,
      action,
      context.taskLease,
      reservedHorizontalTravel,
    );
    return {
      kind: "confirm",
      reason,
      confirmationId: pending.id,
      expiresAt: pending.expiresAt.toISOString(),
    };
  }

  private permanentDecision(action: GameAction, context: SafetyContext): SafetyDecision | null {
    const risk = classifyActionRisk(action, context);
    if (action.kind === "place_block" && canonicalMinecraftName(action.blockName) === "tnt") {
      return { kind: "deny", reason: "TNT is permanently forbidden" };
    }

    if (
      (action.kind === "place_block" || action.kind === "dig_block") &&
      risk.level === "dangerous"
    ) {
      return { kind: "deny", reason: "Lava and destructive fire are permanently forbidden" };
    }

    if (action.kind === "equip_item" && risk.level === "dangerous") {
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

    if (action.kind === "attack_hostile" && risk.level === "dangerous") {
      return {
        kind: "deny",
        reason: `Attacking a ${context.protectedTarget} is permanently forbidden`,
      };
    }

    return null;
  }
}
