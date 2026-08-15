import type { Vec3, WorldSnapshot } from "../domain/types.js";

export interface InspectedBlock {
  readonly name: string;
  readonly position: Vec3;
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}

export interface BlockSearchQuery {
  readonly names?: readonly string[];
  readonly tag?: "bed" | "water" | "mature_wheat";
  readonly maxDistance: number;
  readonly maxResults: number;
}

export interface BlockSearchResult {
  readonly blocks: readonly InspectedBlock[];
  readonly truncated: boolean;
}

export interface InventoryDelta {
  readonly added: readonly { readonly name: string; readonly count: number }[];
  readonly removed: readonly { readonly name: string; readonly count: number }[];
}

export interface FoodDelta {
  readonly healthBefore: number;
  readonly healthAfter: number;
  readonly foodBefore: number;
  readonly foodAfter: number;
}

export interface FurnaceSnapshot {
  readonly position: Vec3;
  readonly input: { readonly name: string; readonly count: number } | null;
  readonly fuel: { readonly name: string; readonly count: number } | null;
  readonly output: { readonly name: string; readonly count: number } | null;
  readonly progress: number;
}

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
  inspectBlock(position: Vec3): Promise<InspectedBlock | null>;
  findBlocks(query: BlockSearchQuery): Promise<BlockSearchResult>;
  furnaceSnapshot(position: Vec3): Promise<FurnaceSnapshot>;
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
  fish(signal: AbortSignal): Promise<InventoryDelta>;
  consumeItem(itemName: string, signal: AbortSignal): Promise<FoodDelta>;
  sleepInBed(position: Vec3, signal: AbortSignal): Promise<void>;
  wakeUp(signal: AbortSignal): Promise<void>;
  tillSoil(position: Vec3, signal: AbortSignal): Promise<void>;
  plantCrop(position: Vec3, seedName: "wheat_seeds", signal: AbortSignal): Promise<void>;
  harvestCrop(position: Vec3, cropName: "wheat", signal: AbortSignal): Promise<void>;
}
