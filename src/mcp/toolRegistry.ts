import * as z from "zod/v4";
import type { ActionExecutor, ActionResult } from "../actions/actionExecutor.js";
import type { GameAction, Vec3, WorldSnapshot } from "../domain/types.js";
import type { MinecraftPort } from "../minecraft/minecraftPort.js";
import { classifyActionRisk } from "../safety/actionRisk.js";
import type { SafetyContext } from "../safety/safetyEngine.js";
import { TurnToolBudget, type ToolActionKind, type TrustedToolConsumption } from "./toolBudget.js";

export const MINECRAFT_TOOL_NAMES = Object.freeze([
  "minecraft_get_state",
  "minecraft_find_block",
  "minecraft_say",
  "minecraft_move_to",
  "minecraft_follow_owner",
  "minecraft_look_at",
  "minecraft_jump",
  "minecraft_dig_block",
  "minecraft_place_block",
  "minecraft_craft_item",
  "minecraft_smelt_item",
  "minecraft_collect_dropped",
  "minecraft_equip_item",
  "minecraft_attack_hostile",
  "minecraft_wait",
] as const);

export type MinecraftToolName = (typeof MINECRAFT_TOOL_NAMES)[number];

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface ToolDefinition<TInput> {
  description: string;
  schema: z.ZodType<TInput>;
  execute(input: TInput): Promise<ToolResult>;
}

export interface ToolRegistryDependencies {
  minecraft: MinecraftPort;
  executor: ActionExecutor;
  budget: TurnToolBudget;
  safetyContextProvider: () => Promise<SafetyContext>;
  ownerUsername: () => string;
  latestSnapshot?: () => WorldSnapshot | undefined;
  observeSnapshot?: (snapshot: WorldSnapshot) => void;
}

export interface TrustedSnapshotStore {
  publish(snapshot: WorldSnapshot): void;
  latest(): WorldSnapshot | undefined;
}

export function createTrustedSnapshotStore(): TrustedSnapshotStore {
  let latestSnapshot: WorldSnapshot | undefined;
  return {
    publish(snapshot): void {
      latestSnapshot = structuredClone(snapshot);
    },
    latest(): WorldSnapshot | undefined {
      return latestSnapshot === undefined ? undefined : structuredClone(latestSnapshot);
    },
  };
}

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_.:-]+$/);
const coordinate = z.number().finite();
const positionShape = { x: coordinate, y: coordinate, z: coordinate };
const turnLease = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "turn lease must be a 32-byte base64url token");
const leaseShape = { turnLease };
const positionSchema = z.object({ ...positionShape, ...leaseShape }).strict();
const emptySchema = z.object(leaseShape).strict();
const entityId = z.number().int().positive().safe();
const count = z.number().int().min(1).max(64);

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "operation failed";
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240) || "operation failed";
}

function toToolResult(result: ActionResult): ToolResult {
  switch (result.status) {
    case "denied":
      return { text: stringify({ status: result.status, reason: result.reason }), isError: true };
    case "confirmation_required":
      return {
        text: stringify({
          status: result.status,
          confirmationId: result.confirmationId,
          reason: result.reason,
        }),
        isError: true,
      };
    case "cancelled":
      return { text: stringify({ status: result.status }), isError: true };
    case "confirmation_invalid":
    case "failed":
      return { text: stringify({ status: result.status, reason: result.reason }), isError: true };
    default:
      return { text: stringify({ status: result.status }) };
  }
}

function errorResult(message: string): ToolResult {
  return { text: stringify({ error: message }), isError: true };
}

function hasDroppedItem(snapshot: WorldSnapshot | undefined, entityId: number): boolean {
  return (
    snapshot?.nearbyEntities?.some((entity) => entity.id === entityId && entity.kind === "item") ??
    false
  );
}

function actionContext(
  base: SafetyContext,
  action: GameAction,
  budget: TurnToolBudget,
): SafetyContext {
  const {
    estimatedBreakCount: _estimatedBreakCount,
    estimatedPlaceCount: _estimatedPlaceCount,
    estimatedTravelDistance: _estimatedTravelDistance,
    ...stable
  } = base;
  const totals = budget.snapshot();
  if (action.kind === "dig_block")
    return { ...stable, estimatedBreakCount: totals.attemptedDigCount };
  if (action.kind === "place_block")
    return { ...stable, estimatedPlaceCount: totals.attemptedPlaceCount };
  if (action.kind === "move_to") {
    return { ...stable, estimatedTravelDistance: totals.cumulativeHorizontalTravel };
  }
  return stable;
}

function trustedTravel(start: Vec3, destination: Vec3): number {
  return Math.hypot(destination.x - start.x, destination.z - start.z);
}

function isTrustedPosition(position: unknown): position is Vec3 {
  if (typeof position !== "object" || position === null || Array.isArray(position)) return false;
  const candidate = position as Record<string, unknown>;
  return (
    Number.isFinite(candidate.x) && Number.isFinite(candidate.y) && Number.isFinite(candidate.z)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTrustedWorldSnapshot(snapshot: unknown): snapshot is WorldSnapshot {
  if (!isRecord(snapshot)) return false;
  if (!isTrustedPosition(snapshot.botPosition)) return false;
  if (snapshot.ownerPosition !== undefined && !isTrustedPosition(snapshot.ownerPosition))
    return false;
  if (snapshot.worldSpawn !== undefined && !isTrustedPosition(snapshot.worldSpawn)) return false;
  if (snapshot.botYaw !== undefined && !Number.isFinite(snapshot.botYaw)) return false;
  if (snapshot.botPitch !== undefined && !Number.isFinite(snapshot.botPitch)) return false;
  if (
    !Number.isFinite(snapshot.health) ||
    !Number.isFinite(snapshot.food) ||
    !Number.isFinite(snapshot.timeOfDay) ||
    (snapshot.weather !== "clear" &&
      snapshot.weather !== "rain" &&
      snapshot.weather !== "thunder") ||
    !Array.isArray(snapshot.inventorySummary) ||
    !Array.isArray(snapshot.nearbyHostiles)
  ) {
    return false;
  }
  if (
    snapshot.inventorySummary.some(
      (entry) =>
        !isRecord(entry) || typeof entry.name !== "string" || !Number.isFinite(entry.count),
    ) ||
    snapshot.nearbyHostiles.some(
      (entry) =>
        !isRecord(entry) || typeof entry.kind !== "string" || !isTrustedPosition(entry.position),
    )
  ) {
    return false;
  }
  if (
    snapshot.nearbyBlocks !== undefined &&
    (!Array.isArray(snapshot.nearbyBlocks) ||
      snapshot.nearbyBlocks.some(
        (entry) =>
          !isRecord(entry) || typeof entry.name !== "string" || !isTrustedPosition(entry.position),
      ))
  ) {
    return false;
  }
  if (
    snapshot.nearbyEntities !== undefined &&
    (!Array.isArray(snapshot.nearbyEntities) ||
      snapshot.nearbyEntities.some(
        (entry) =>
          !isRecord(entry) ||
          !Number.isFinite(entry.id) ||
          typeof entry.kind !== "string" ||
          !isTrustedPosition(entry.position),
      ))
  ) {
    return false;
  }
  return true;
}

function snapshotPosition(snapshot: unknown, key: "botPosition" | "ownerPosition"): unknown {
  return isRecord(snapshot) ? snapshot[key] : undefined;
}

export function createToolRegistry(dependencies: ToolRegistryDependencies) {
  let observedSnapshot: WorldSnapshot | undefined;
  const observeSnapshot = (snapshot: WorldSnapshot): WorldSnapshot => {
    const trusted = structuredClone(snapshot);
    observedSnapshot = trusted;
    dependencies.observeSnapshot?.(structuredClone(trusted));
    return trusted;
  };
  const takeSnapshot = async (): Promise<WorldSnapshot> => {
    const snapshot: unknown = await dependencies.minecraft.snapshot(dependencies.ownerUsername());
    if (!isTrustedWorldSnapshot(snapshot)) throw new Error("trusted snapshot is unavailable");
    return observeSnapshot(snapshot);
  };
  const currentSnapshot = (): WorldSnapshot | undefined => {
    const snapshot = dependencies.latestSnapshot?.() ?? observedSnapshot;
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  };

  const consume = (
    kind: ToolActionKind,
    lease: string,
    trustedConsumption: TrustedToolConsumption = {},
  ): ToolResult | undefined => {
    const result = dependencies.budget.consume(kind, lease, trustedConsumption);
    return result.ok ? undefined : errorResult(result.reason);
  };
  const checkLease = (lease: string): ToolResult | undefined => {
    const result = dependencies.budget.checkLease(lease);
    return result.ok ? undefined : errorResult(result.reason);
  };
  const runAction = async (action: GameAction, lease: string): Promise<ToolResult> => {
    const invalidLease = checkLease(lease);
    if (invalidLease) return invalidLease;
    const failAttempt = (message: string): ToolResult =>
      consume(action.kind, lease) ?? errorResult(message);
    let baseContext: SafetyContext;
    try {
      baseContext = await dependencies.safetyContextProvider();
    } catch (error) {
      return failAttempt(safeMessage(error));
    }
    const initialContext = actionContext(baseContext, action, dependencies.budget);
    let horizontalTravel: number | undefined;
    if (action.kind === "move_to" || action.kind === "follow_owner") {
      let snapshot: WorldSnapshot;
      try {
        snapshot = await takeSnapshot();
      } catch (error) {
        return failAttempt(safeMessage(error));
      }
      const botPosition = snapshotPosition(snapshot, "botPosition");
      const destination =
        action.kind === "move_to" ? action.position : snapshotPosition(snapshot, "ownerPosition");
      if (!isTrustedPosition(botPosition) || !isTrustedPosition(destination)) {
        return failAttempt("trusted movement distance is unavailable");
      }
      horizontalTravel = trustedTravel(botPosition, destination);
      if (!Number.isFinite(horizontalTravel)) {
        return failAttempt("trusted movement distance is unavailable");
      }
    }
    const exhausted = consume(action.kind, lease, {
      ...(action.kind === "dig_block" || action.kind === "place_block"
        ? { blockChanges: 1 as const }
        : {}),
      ...(horizontalTravel === undefined ? {} : { horizontalTravel }),
      dangerousOperations: classifyActionRisk(action, initialContext).dangerousOperations,
    });
    if (exhausted) return exhausted;
    const taskLease = dependencies.budget.currentTaskLease(lease);
    if (!taskLease) return errorResult("tool turn lease is invalid");
    if (horizontalTravel !== undefined)
      dependencies.budget.recordHorizontalTravel(horizontalTravel);
    try {
      const context = {
        ...actionContext(baseContext, action, dependencies.budget),
        taskLease,
        ...(horizontalTravel === undefined ? {} : { reservedHorizontalTravel: horizontalTravel }),
      };
      return toToolResult(await dependencies.executor.execute(action, context));
    } catch (error) {
      return errorResult(safeMessage(error));
    }
  };

  const registry = {
    minecraft_get_state: {
      description: "Read the current bounded Minecraft state.",
      schema: emptySchema,
      execute: async ({ turnLease: lease }: { turnLease: string }): Promise<ToolResult> => {
        const exhausted = consume("get_state", lease);
        if (exhausted) return exhausted;
        try {
          observedSnapshot = await takeSnapshot();
          return { text: stringify(observedSnapshot) };
        } catch (error) {
          return errorResult(safeMessage(error));
        }
      },
    },
    minecraft_find_block: {
      description: "Find one nearby block by its exact Minecraft identifier.",
      schema: z
        .object({
          blockName: identifier,
          maxDistance: z.number().int().min(1).max(64),
          ...leaseShape,
        })
        .strict(),
      execute: async ({
        blockName,
        maxDistance,
        turnLease: lease,
      }: {
        blockName: string;
        maxDistance: number;
        turnLease: string;
      }): Promise<ToolResult> => {
        const exhausted = consume("find_block", lease);
        if (exhausted) return exhausted;
        try {
          return {
            text: stringify({
              position: await dependencies.minecraft.findBlock(blockName, maxDistance),
            }),
          };
        } catch (error) {
          return errorResult(safeMessage(error));
        }
      },
    },
    minecraft_say: {
      description: "Send a short non-command chat message.",
      schema: z
        .object({
          message: z
            .string()
            .min(1)
            .max(240)
            .refine(
              (message) => !message.trimStart().startsWith("/"),
              "Minecraft commands are not permitted",
            )
            .refine(
              (message) => !/[\u0000-\u001f\u007f]/.test(message),
              "control characters are not permitted",
            ),
          ...leaseShape,
        })
        .strict(),
      execute: async ({
        message,
        turnLease: lease,
      }: {
        message: string;
        turnLease: string;
      }): Promise<ToolResult> => runAction({ kind: "say", message }, lease),
    },
    minecraft_move_to: {
      description: "Move WhiteLily to exact coordinates through the local safety gate.",
      schema: positionSchema,
      execute: async ({
        x,
        y,
        z,
        turnLease: lease,
      }: Vec3 & { turnLease: string }): Promise<ToolResult> =>
        runAction({ kind: "move_to", position: { x, y, z } }, lease),
    },
    minecraft_follow_owner: {
      description: "Follow the configured owner at a bounded distance.",
      schema: z.object({ distance: z.number().int().min(2).max(16), ...leaseShape }).strict(),
      execute: async ({
        distance,
        turnLease: lease,
      }: {
        distance: number;
        turnLease: string;
      }): Promise<ToolResult> => runAction({ kind: "follow_owner", distance }, lease),
    },
    minecraft_look_at: {
      description: "Turn to exact coordinates.",
      schema: positionSchema,
      execute: async ({
        x,
        y,
        z,
        turnLease: lease,
      }: Vec3 & { turnLease: string }): Promise<ToolResult> =>
        runAction({ kind: "look_at", position: { x, y, z } }, lease),
    },
    minecraft_jump: {
      description: "Perform one jump.",
      schema: emptySchema,
      execute: async ({ turnLease: lease }: { turnLease: string }): Promise<ToolResult> =>
        runAction({ kind: "jump" }, lease),
    },
    minecraft_dig_block: {
      description: "Dig one expected block through the local safety gate.",
      schema: z.object({ ...positionShape, blockName: identifier, ...leaseShape }).strict(),
      execute: async ({
        x,
        y,
        z,
        blockName,
        turnLease: lease,
      }: {
        x: number;
        y: number;
        z: number;
        blockName: string;
        turnLease: string;
      }): Promise<ToolResult> =>
        runAction({ kind: "dig_block", position: { x, y, z }, blockName }, lease),
    },
    minecraft_place_block: {
      description: "Place one block through the local safety gate.",
      schema: z.object({ ...positionShape, blockName: identifier, ...leaseShape }).strict(),
      execute: async ({
        x,
        y,
        z,
        blockName,
        turnLease: lease,
      }: {
        x: number;
        y: number;
        z: number;
        blockName: string;
        turnLease: string;
      }): Promise<ToolResult> =>
        runAction({ kind: "place_block", position: { x, y, z }, blockName }, lease),
    },
    minecraft_craft_item: {
      description: "Craft a bounded item count.",
      schema: z.object({ itemName: identifier, count, ...leaseShape }).strict(),
      execute: async ({
        itemName,
        count: itemCount,
        turnLease: lease,
      }: {
        itemName: string;
        count: number;
        turnLease: string;
      }): Promise<ToolResult> =>
        runAction({ kind: "craft_item", itemName, count: itemCount }, lease),
    },
    minecraft_smelt_item: {
      description: "Smelt a bounded item count.",
      schema: z.object({ itemName: identifier, count, ...leaseShape }).strict(),
      execute: async ({
        itemName,
        count: itemCount,
        turnLease: lease,
      }: {
        itemName: string;
        count: number;
        turnLease: string;
      }): Promise<ToolResult> =>
        runAction({ kind: "smelt_item", itemName, count: itemCount }, lease),
    },
    minecraft_collect_dropped: {
      description: "Collect one item entity authorized by the latest snapshot.",
      schema: z.object({ entityId, ...leaseShape }).strict(),
      execute: async ({
        entityId: droppedId,
        turnLease: lease,
      }: {
        entityId: number;
        turnLease: string;
      }): Promise<ToolResult> => {
        const action: GameAction = { kind: "collect_dropped", entityId: droppedId };
        const invalidLease = checkLease(lease);
        if (invalidLease) return invalidLease;
        const failAttempt = (message: string): ToolResult =>
          consume(action.kind, lease) ?? errorResult(message);
        let context: SafetyContext;
        try {
          context = actionContext(
            await dependencies.safetyContextProvider(),
            action,
            dependencies.budget,
          );
        } catch (error) {
          return failAttempt(safeMessage(error));
        }
        const exhausted = consume(action.kind, lease, {
          dangerousOperations: classifyActionRisk(action, context).dangerousOperations,
        });
        if (exhausted) return exhausted;
        const taskLease = dependencies.budget.currentTaskLease(lease);
        if (!taskLease) return errorResult("tool turn lease is invalid");
        try {
          if (!hasDroppedItem(currentSnapshot(), droppedId))
            return errorResult("dropped entity ID is not present in the latest snapshot");
        } catch (error) {
          return errorResult(safeMessage(error));
        }
        try {
          return toToolResult(
            await dependencies.executor.execute(action, {
              ...context,
              taskLease,
            }),
          );
        } catch (error) {
          return errorResult(safeMessage(error));
        }
      },
    },
    minecraft_equip_item: {
      description: "Equip one inventory item to a bounded destination.",
      schema: z
        .object({
          itemName: identifier,
          destination: z.enum(["hand", "head", "torso", "legs", "feet"]),
          ...leaseShape,
        })
        .strict(),
      execute: async ({
        itemName,
        destination,
        turnLease: lease,
      }: {
        itemName: string;
        destination: "hand" | "head" | "torso" | "legs" | "feet";
        turnLease: string;
      }): Promise<ToolResult> => runAction({ kind: "equip_item", itemName, destination }, lease),
    },
    minecraft_attack_hostile: {
      description: "Attack one hostile entity authorized by Minecraft.",
      schema: z.object({ entityId, ...leaseShape }).strict(),
      execute: async ({
        entityId: hostileId,
        turnLease: lease,
      }: {
        entityId: number;
        turnLease: string;
      }): Promise<ToolResult> => runAction({ kind: "attack_hostile", entityId: hostileId }, lease),
    },
    minecraft_wait: {
      description: "Wait for a bounded duration.",
      schema: z
        .object({ milliseconds: z.number().int().min(100).max(10_000), ...leaseShape })
        .strict(),
      execute: async ({
        milliseconds,
        turnLease: lease,
      }: {
        milliseconds: number;
        turnLease: string;
      }): Promise<ToolResult> => runAction({ kind: "wait", milliseconds }, lease),
    },
  } satisfies Record<MinecraftToolName, unknown>;
  return Object.fromEntries(MINECRAFT_TOOL_NAMES.map((name) => [name, registry[name]])) as {
    [Name in MinecraftToolName]: (typeof registry)[Name];
  };
}
