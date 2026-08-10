import type { Vec3, WorldSnapshot } from "../domain/types.js";

export type MinecraftEvent =
  | { kind: "connected" | "disconnected"; reason?: string }
  | {
      kind: "bridge_failed";
      code: "MINECRAFT_BRIDGE_REQUIRED" | "MINECRAFT_BRIDGE_REJECTED";
    }
  | { kind: "world_changed" }
  | { kind: "chat"; username: string; message: string }
  | { kind: "owner_online" | "owner_offline"; username: string }
  | { kind: "death" }
  | { kind: "hostile_nearby"; entityId: number; entityKind: string; position: Vec3 };

export interface MinecraftPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onEvent(listener: (event: MinecraftEvent) => void): () => void;
  isOwnerOnline(username: string): Promise<boolean>;
  snapshot(ownerUsername: string): Promise<WorldSnapshot>;
  findBlock(blockName: string, maxDistance: number): Promise<Vec3 | null>;
  say(message: string): Promise<void>;
  moveTo(position: Vec3, signal: AbortSignal): Promise<void>;
  followOwner(username: string, distance: number, signal: AbortSignal): Promise<void>;
  lookAt(position: Vec3, signal: AbortSignal): Promise<void>;
  jump(signal: AbortSignal): Promise<void>;
  digBlock(position: Vec3, expectedBlockName: string, signal: AbortSignal): Promise<void>;
  placeBlock(position: Vec3, blockName: string, signal: AbortSignal): Promise<void>;
  craftItem(itemName: string, count: number, signal: AbortSignal): Promise<void>;
  smeltItem(itemName: string, count: number, signal: AbortSignal): Promise<void>;
  collectDropped(entityId: number, signal: AbortSignal): Promise<void>;
  equipItem(
    itemName: string,
    destination: "hand" | "head" | "torso" | "legs" | "feet",
    signal: AbortSignal,
  ): Promise<void>;
  attackHostile(entityId: number, signal: AbortSignal): Promise<void>;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}
