import type { Vec3, WorldSnapshot } from "../domain/types.js";
import type {
  BlockSearchQuery,
  BlockSearchResult,
  FoodDelta,
  FurnaceSnapshot,
  InspectedBlock,
  InventoryDelta,
  MinecraftEvent,
  MinecraftPort,
} from "./minecraftPort.js";

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

export class FakeMinecraftPort implements MinecraftPort {
  readonly chatLog: string[] = [];
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  ownerOnline = false;
  inspectBlockResult: InspectedBlock | null = null;
  findBlocksResult: BlockSearchResult = { blocks: [], truncated: false };
  fishResult: InventoryDelta = { added: [], removed: [] };
  consumeItemResult: FoodDelta = {
    healthBefore: 20,
    healthAfter: 20,
    foodBefore: 20,
    foodAfter: 20,
  };
  furnaceSnapshotResult: FurnaceSnapshot = {
    position: { x: 0, y: 0, z: 0 },
    input: null,
    fuel: null,
    output: null,
    progress: 0,
  };
  world: WorldSnapshot = {
    botPosition: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    timeOfDay: 0,
    weather: "clear",
    inventorySummary: [],
    nearbyHostiles: [],
  };
  private readonly listeners = new Set<(event: MinecraftEvent) => void>();

  emit(event: MinecraftEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  onEvent(listener: (event: MinecraftEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.calls.push({ method: "connect", args: [] });
  }

  async disconnect(): Promise<void> {
    this.calls.push({ method: "disconnect", args: [] });
  }

  async isOwnerOnline(_username: string): Promise<boolean> {
    return this.ownerOnline;
  }

  async snapshot(_ownerUsername: string): Promise<WorldSnapshot> {
    return structuredClone(this.world);
  }

  async findBlock(blockName: string, maxDistance: number): Promise<Vec3 | null> {
    this.calls.push({ method: "findBlock", args: [blockName, maxDistance] });
    return null;
  }

  async inspectBlock(position: Vec3): Promise<InspectedBlock | null> {
    this.calls.push({ method: "inspectBlock", args: [structuredClone(position)] });
    return structuredClone(this.inspectBlockResult);
  }

  async findBlocks(query: BlockSearchQuery): Promise<BlockSearchResult> {
    this.calls.push({ method: "findBlocks", args: [structuredClone(query)] });
    return structuredClone(this.findBlocksResult);
  }

  async furnaceSnapshot(position: Vec3): Promise<FurnaceSnapshot> {
    this.calls.push({ method: "furnaceSnapshot", args: [structuredClone(position)] });
    return structuredClone(this.furnaceSnapshotResult);
  }

  async say(message: string): Promise<void> {
    this.chatLog.push(message);
  }

  async moveTo(position: Vec3, signal: AbortSignal): Promise<void> {
    this.recordAbortable("moveTo", [position], signal);
  }

  async followOwner(username: string, distance: number, signal: AbortSignal): Promise<void> {
    this.recordAbortable("followOwner", [username, distance], signal);
  }

  async lookAt(position: Vec3, signal: AbortSignal): Promise<void> {
    this.recordAbortable("lookAt", [position], signal);
  }

  async jump(signal: AbortSignal): Promise<void> {
    this.recordAbortable("jump", [], signal);
  }

  async digBlock(position: Vec3, blockName: string, signal: AbortSignal): Promise<void> {
    this.recordAbortable("digBlock", [position, blockName], signal);
  }

  async placeBlock(position: Vec3, blockName: string, signal: AbortSignal): Promise<void> {
    this.recordAbortable("placeBlock", [position, blockName], signal);
  }

  async craftItem(itemName: string, count: number, signal: AbortSignal): Promise<void> {
    this.recordAbortable("craftItem", [itemName, count], signal);
  }

  async smeltItem(itemName: string, count: number, signal: AbortSignal): Promise<void> {
    this.recordAbortable("smeltItem", [itemName, count], signal);
  }

  async collectDropped(entityId: number, signal: AbortSignal): Promise<void> {
    this.recordAbortable("collectDropped", [entityId], signal);
  }

  async equipItem(
    itemName: string,
    destination: "hand" | "head" | "torso" | "legs" | "feet",
    signal: AbortSignal,
  ): Promise<void> {
    this.recordAbortable("equipItem", [itemName, destination], signal);
  }

  async attackHostile(entityId: number, signal: AbortSignal): Promise<void> {
    this.recordAbortable("attackHostile", [entityId], signal);
  }

  async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    this.recordAbortable("wait", [milliseconds], signal);
  }

  async fish(signal: AbortSignal): Promise<InventoryDelta> {
    this.recordAbortable("fish", [], signal);
    return structuredClone(this.fishResult);
  }

  async consumeItem(itemName: string, signal: AbortSignal): Promise<FoodDelta> {
    this.recordAbortable("consumeItem", [itemName], signal);
    return structuredClone(this.consumeItemResult);
  }

  async sleepInBed(position: Vec3, signal: AbortSignal): Promise<void> {
    this.recordAbortable("sleepInBed", [position], signal);
  }

  async wakeUp(signal: AbortSignal): Promise<void> {
    this.recordAbortable("wakeUp", [], signal);
  }

  async tillSoil(position: Vec3, signal: AbortSignal): Promise<void> {
    this.recordAbortable("tillSoil", [position], signal);
  }

  async plantCrop(position: Vec3, seedName: "wheat_seeds", signal: AbortSignal): Promise<void> {
    this.recordAbortable("plantCrop", [position, seedName], signal);
  }

  async harvestCrop(position: Vec3, cropName: "wheat", signal: AbortSignal): Promise<void> {
    this.recordAbortable("harvestCrop", [position, cropName], signal);
  }

  private recordAbortable(method: string, args: unknown[], signal: AbortSignal): void {
    if (signal.aborted) throw abortError();
    this.calls.push({ method, args });
  }
}
