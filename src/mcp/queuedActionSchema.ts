import * as z from "zod/v4";
import type { GameAction } from "../domain/types.js";

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_.:-]+$/);
const coordinate = z.number().finite();
const summary = z.string().min(1).max(160);
const count = z.number().int().min(1).max(64);
const entityId = z.number().int().nonnegative().safe();

export const queuedActionSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("move_to"),
      x: coordinate,
      y: coordinate,
      z: coordinate,
      summary,
    })
    .strict(),
  z
    .object({
      kind: z.literal("follow_owner"),
      distance: z.number().int().min(2).max(16),
      summary,
    })
    .strict(),
  z
    .object({
      kind: z.literal("look_at"),
      x: coordinate,
      y: coordinate,
      z: coordinate,
      summary,
    })
    .strict(),
  z.object({ kind: z.literal("jump"), summary }).strict(),
  z
    .object({
      kind: z.literal("dig_block"),
      x: coordinate,
      y: coordinate,
      z: coordinate,
      blockName: identifier,
      summary,
    })
    .strict(),
  z
    .object({
      kind: z.literal("place_block"),
      x: coordinate,
      y: coordinate,
      z: coordinate,
      blockName: identifier,
      summary,
    })
    .strict(),
  z.object({ kind: z.literal("craft_item"), itemName: identifier, count, summary }).strict(),
  z.object({ kind: z.literal("smelt_item"), itemName: identifier, count, summary }).strict(),
  z.object({ kind: z.literal("collect_dropped"), entityId, summary }).strict(),
  z
    .object({
      kind: z.literal("equip_item"),
      itemName: identifier,
      destination: z.enum(["hand", "head", "torso", "legs", "feet"]),
      summary,
    })
    .strict(),
  z.object({ kind: z.literal("attack_hostile"), entityId, summary }).strict(),
  z
    .object({
      kind: z.literal("wait"),
      milliseconds: z.number().int().min(100).max(10_000),
      summary,
    })
    .strict(),
  z.object({ kind: z.literal("fish"), summary }).strict(),
  z.object({ kind: z.literal("consume_item"), itemName: identifier, summary }).strict(),
  z
    .object({
      kind: z.literal("sleep_in_bed"),
      x: coordinate,
      y: coordinate,
      z: coordinate,
      summary,
    })
    .strict(),
  z.object({ kind: z.literal("wake_up"), summary }).strict(),
  z
    .object({
      kind: z.literal("till_soil"),
      x: coordinate,
      y: coordinate,
      z: coordinate,
      summary,
    })
    .strict(),
  z
    .object({
      kind: z.literal("plant_crop"),
      x: coordinate,
      y: coordinate,
      z: coordinate,
      seedName: z.literal("wheat_seeds"),
      summary,
    })
    .strict(),
  z
    .object({
      kind: z.literal("harvest_crop"),
      x: coordinate,
      y: coordinate,
      z: coordinate,
      cropName: z.literal("wheat"),
      summary,
    })
    .strict(),
]);

export type QueuedActionSpec = z.infer<typeof queuedActionSpecSchema>;

export function queuedActionSpecToGameAction(spec: QueuedActionSpec): GameAction {
  switch (spec.kind) {
    case "move_to":
    case "look_at":
      return { kind: spec.kind, position: { x: spec.x, y: spec.y, z: spec.z } };
    case "follow_owner":
      return { kind: spec.kind, distance: spec.distance };
    case "jump":
      return { kind: spec.kind };
    case "dig_block":
    case "place_block":
      return {
        kind: spec.kind,
        position: { x: spec.x, y: spec.y, z: spec.z },
        blockName: spec.blockName,
      };
    case "craft_item":
    case "smelt_item":
      return { kind: spec.kind, itemName: spec.itemName, count: spec.count };
    case "collect_dropped":
    case "attack_hostile":
      return { kind: spec.kind, entityId: spec.entityId };
    case "equip_item":
      return {
        kind: spec.kind,
        itemName: spec.itemName,
        destination: spec.destination,
      };
    case "wait":
      return { kind: spec.kind, milliseconds: spec.milliseconds };
    case "fish":
    case "wake_up":
      return { kind: spec.kind };
    case "consume_item":
      return { kind: spec.kind, itemName: spec.itemName };
    case "sleep_in_bed":
    case "till_soil":
      return { kind: spec.kind, position: { x: spec.x, y: spec.y, z: spec.z } };
    case "plant_crop":
      return {
        kind: spec.kind,
        position: { x: spec.x, y: spec.y, z: spec.z },
        seedName: spec.seedName,
      };
    case "harvest_crop":
      return {
        kind: spec.kind,
        position: { x: spec.x, y: spec.y, z: spec.z },
        cropName: spec.cropName,
      };
  }
}
