import type { Bot } from "mineflayer";
import type { Vec3, WorldSnapshot } from "../domain/types.js";

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
