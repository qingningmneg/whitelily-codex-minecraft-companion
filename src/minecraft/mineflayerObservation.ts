import type { Bot } from "mineflayer";
import type { Vec3, WorldSnapshot } from "../domain/types.js";
import type { InspectedBlock } from "./minecraftPort.js";

const MAX_SNAPSHOT_ENTITIES = 64;
const MAX_INVENTORY_ITEMS = 36;
const MAX_KNOWN_HOSTILES = 64;

export interface EntityTracking {
  readonly worldSpawn?: Readonly<Vec3>;
  readonly hostileEntityIds: ReadonlySet<number>;
  readonly droppedItemEntityIds: ReadonlySet<number>;
}

function toVec3(position: { x: number; y: number; z: number }): Vec3 {
  return { x: position.x, y: position.y, z: position.z };
}

function distanceSquared(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
}

type MinecraftBlock = NonNullable<ReturnType<Bot["blockAt"]>>;

export function createInspectedBlock(block: MinecraftBlock): InspectedBlock {
  if (typeof block.name !== "string" || block.name.length === 0 || block.name.length > 64) {
    throw new Error("block name is invalid");
  }
  const properties: Record<string, string | number | boolean> = {};
  const source = block.getProperties();
  for (const [rawKey, rawValue] of Object.entries(source).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (Object.keys(properties).length >= 16) break;
    if (rawKey.length === 0) continue;
    const key = rawKey.slice(0, 64);
    if (Object.hasOwn(properties, key)) continue;
    if (typeof rawValue === "string") properties[key] = rawValue.slice(0, 64);
    else if (typeof rawValue === "boolean") properties[key] = rawValue;
    else if (typeof rawValue === "number" && Number.isFinite(rawValue)) properties[key] = rawValue;
  }
  return {
    name: block.name,
    position: toVec3(block.position),
    properties,
  };
}

export function selectSnapshotEntities(bot: Bot): Bot["entity"][] {
  return Object.values(bot.entities)
    .sort(
      (left, right) =>
        distanceSquared(left.position, bot.entity.position) -
        distanceSquared(right.position, bot.entity.position),
    )
    .slice(0, MAX_SNAPSHOT_ENTITIES);
}

export function createWorldSnapshot(
  bot: Bot,
  ownerUsername: string,
  tracking: EntityTracking,
): WorldSnapshot {
  const entities = selectSnapshotEntities(bot);
  const ownerPosition = bot.players[ownerUsername]?.entity?.position;
  const hostiles = entities
    .filter((entity) => entity.type === "hostile" && tracking.hostileEntityIds.has(entity.id))
    .slice(0, MAX_KNOWN_HOSTILES);

  return {
    botPosition: toVec3(bot.entity.position),
    ...(tracking.worldSpawn ? { worldSpawn: toVec3(tracking.worldSpawn) } : {}),
    botYaw: bot.entity.yaw,
    botPitch: bot.entity.pitch,
    ...(ownerPosition ? { ownerPosition: toVec3(ownerPosition) } : {}),
    health: bot.health,
    food: bot.food,
    timeOfDay: bot.time.timeOfDay,
    weather: bot.thunderState > 0 ? "thunder" : bot.isRaining ? "rain" : "clear",
    inventorySummary: bot.inventory
      .items()
      .slice(0, MAX_INVENTORY_ITEMS)
      .map((item) => ({ name: item.name, count: item.count })),
    nearbyEntities: entities.map((entity) => ({
      id: entity.id,
      kind: entity.name ?? entity.type,
      position: toVec3(entity.position),
    })),
    nearbyHostiles: hostiles.map((entity) => ({
      entityId: entity.id,
      kind: entity.name ?? entity.type,
      position: toVec3(entity.position),
    })),
  };
}
