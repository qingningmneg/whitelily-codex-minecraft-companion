import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createBot,
  pathfinder,
  GoalNear,
  GoalFollow,
  createBridgeProofIssuer,
  issueProof,
  closeIssuer,
} = vi.hoisted(() => {
  class NearGoal {
    constructor(
      readonly x: number,
      readonly y: number,
      readonly z: number,
      readonly range: number,
    ) {}
  }
  class FollowGoal {
    constructor(
      readonly entity: unknown,
      readonly range: number,
    ) {}
  }
  return {
    createBot: vi.fn(),
    pathfinder: vi.fn(),
    GoalNear: NearGoal,
    GoalFollow: FollowGoal,
    createBridgeProofIssuer: vi.fn(),
    issueProof: vi.fn(),
    closeIssuer: vi.fn(),
  };
});

vi.mock("mineflayer", () => ({ createBot }));
vi.mock("mineflayer-pathfinder", () => {
  const goals = { GoalNear, GoalFollow };
  return {
    default: { pathfinder, goals },
    pathfinder,
    goals,
  };
});
vi.mock("../../src/minecraft/bridgeProofIssuer.js", () => ({ createBridgeProofIssuer }));

import { MineflayerAdapter } from "../../src/minecraft/mineflayerAdapter.js";
import { ActionExecutor } from "../../src/actions/actionExecutor.js";
import {
  createWorldSnapshot,
  type EntityTracking,
} from "../../src/minecraft/mineflayerObservation.js";
import { ConfirmationStore } from "../../src/safety/confirmationStore.js";

interface FakeEntity {
  id: number;
  name: string;
  type: string;
  position: { x: number; y: number; z: number };
}

interface FakeItem {
  name: string;
  count: number;
  type: number;
}

class FakeFurnace {
  input: FakeItem | null = null;
  fuel: FakeItem | null = null;
  output: FakeItem | null = null;
  progress: number | null = 0;
  readonly close = vi.fn();
  readonly inputItem = vi.fn(() => this.input);
  readonly fuelItem = vi.fn(() => this.fuel);
  readonly outputItem = vi.fn(() => this.output);
  readonly putInput = vi.fn(async (type: number, _metadata: number | null, count: number) => {
    this.input = { name: "iron_ore", type, count };
  });
  readonly putFuel = vi.fn(async (type: number, _metadata: number | null, count: number) => {
    this.fuel = { name: "coal", type, count };
  });
  readonly takeOutput = vi.fn(async () => this.output);
}

class FakeBot extends EventEmitter {
  throwOnEvent: string | undefined;
  readonly game: { dimension: unknown; gameMode: string } = {
    dimension: "overworld",
    gameMode: "survival",
  };
  readonly _client = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    socket: { end: vi.fn(), destroy: vi.fn() },
  });
  readonly supportFeature = vi.fn(() => false);
  readonly chat = vi.fn();
  readonly loadPlugin = vi.fn();
  readonly end = vi.fn();
  readonly clearControlStates = vi.fn();
  readonly setControlState = vi.fn();
  readonly lookAt = vi.fn(async () => undefined);
  readonly equip = vi.fn<(...args: unknown[]) => Promise<void>>(
    async (): Promise<void> => undefined,
  );
  readonly activateItem = vi.fn();
  readonly activateBlock = vi.fn<(...args: unknown[]) => Promise<void>>(
    async (): Promise<void> => undefined,
  );
  readonly deactivateItem = vi.fn();
  readonly fish = vi.fn<() => Promise<void>>(async (): Promise<void> => undefined);
  readonly consume = vi.fn<() => Promise<void>>(async (): Promise<void> => undefined);
  readonly sleep = vi.fn<(...args: unknown[]) => Promise<void>>(
    async (): Promise<void> => undefined,
  );
  readonly wake = vi.fn<() => Promise<void>>(async (): Promise<void> => undefined);
  readonly isABed = vi.fn<(block: unknown) => boolean>(() => false);
  readonly canDigBlock = vi.fn<(block: unknown) => boolean>(() => true);
  readonly attack = vi.fn();
  readonly dig = vi.fn<(...args: unknown[]) => Promise<void>>(async (): Promise<void> => undefined);
  readonly stopDigging = vi.fn<() => unknown>();
  readonly placeBlock = vi.fn(async () => undefined);
  readonly craft = vi.fn<(...args: unknown[]) => Promise<void>>(
    async (): Promise<void> => undefined,
  );
  readonly recipesFor = vi.fn<(...args: unknown[]) => unknown[]>(() => []);
  readonly waitForTicks = vi.fn<() => Promise<void>>(async (): Promise<void> => undefined);
  readonly openFurnace = vi.fn<(block: unknown) => Promise<FakeFurnace>>();
  readonly findBlock = vi.fn<(options: unknown) => unknown>(() => null);
  readonly findBlocks = vi.fn<(options: unknown) => Array<{ x: number; y: number; z: number }>>(
    () => [],
  );
  readonly blockAt = vi.fn<(position: unknown) => unknown>(() => null);
  readonly nearestEntity = vi.fn<(predicate: (entity: FakeEntity) => boolean) => FakeEntity | null>(
    () => null,
  );
  readonly pathfinder = {
    goto: vi.fn<() => Promise<void>>(async (): Promise<void> => undefined),
    setGoal: vi.fn(),
    stop: vi.fn(),
  };
  readonly registry = {
    blocksByName: {
      stone: { id: 1, name: "stone" },
      water: { id: 9, name: "water" },
      furnace: { id: 61, name: "furnace" },
      white_bed: { id: 100, name: "white_bed" },
      crafting_table: { id: 58, name: "crafting_table" },
      wheat: { id: 59, name: "wheat" },
      dirt: { id: 3, name: "dirt" },
      grass_block: { id: 2, name: "grass_block" },
      farmland: { id: 60, name: "farmland" },
      air: { id: 0, name: "air" },
    },
    itemsByName: {
      stick: { id: 2, name: "stick" },
      stone: { id: 1, name: "stone" },
      fishing_rod: { id: 346, name: "fishing_rod" },
      bread: { id: 297, name: "bread" },
      wheat_seeds: { id: 295, name: "wheat_seeds" },
      wooden_hoe: { id: 290, name: "wooden_hoe" },
      iron_ore: { id: 15, name: "iron_ore" },
      coal: { id: 263, name: "coal" },
      tnt: { id: 46, name: "tnt" },
      lava_bucket: { id: 327, name: "lava_bucket" },
      flint_and_steel: { id: 259, name: "flint_and_steel" },
      fire_charge: { id: 385, name: "fire_charge" },
    },
    foodsByName: { bread: { id: 297, name: "bread", foodPoints: 5 } },
  };
  readonly entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 };
  inventoryItems: FakeItem[] = [{ name: "stick", count: 2, type: 2 }];
  readonly inventory = { items: () => this.inventoryItems };
  readonly players: Record<string, { entity?: FakeEntity }> = {};
  readonly entities: Record<string, FakeEntity> = {};
  readonly time = { timeOfDay: 1000 };
  heldItem: FakeItem | null = null;
  isSleeping = false;
  health = 20;
  food = 20;
  isRaining = false;
  thunderState = 0;

  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    const result = super.on(eventName, listener);
    if (eventName === this.throwOnEvent) throw new Error(`attach failed for ${String(eventName)}`);
    return result;
  }
}

function config() {
  return {
    host: "127.0.0.1" as const,
    port: 25565,
    botUsername: "WhiteLily" as const,
    ownerUsername: "TestOwner",
    dataRoot: "C:\\WhiteLilyData",
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("createWorldSnapshot", () => {
  it("bounds projection output, returns fresh values, and leaves tracking input unchanged", () => {
    const bot = new FakeBot();
    bot.inventoryItems = Array.from({ length: 40 }, (_, index) => ({
      name: `item_${index}`,
      count: index + 1,
      type: index,
    }));
    for (let index = 0; index < 70; index += 1) {
      bot.entities[String(index)] = {
        id: index,
        name: `hostile_${index}`,
        type: "hostile",
        position: { x: index + 1, y: 64, z: 0 },
      };
    }
    const hostileEntityIds = new Set(Array.from({ length: 70 }, (_, index) => index));
    const droppedItemEntityIds = new Set([100, 101]);
    const worldSpawn = { x: 10, y: 70, z: -20 };
    bot.players.TestOwner = {
      entity: {
        id: 500,
        name: "player",
        type: "player",
        position: { x: 5, y: 64, z: 5 },
      },
    };
    const tracking: EntityTracking = {
      worldSpawn,
      hostileEntityIds,
      droppedItemEntityIds,
    };

    const first = createWorldSnapshot(bot as never, "TestOwner", tracking);
    const second = createWorldSnapshot(bot as never, "TestOwner", tracking);

    expect(first.inventorySummary).toHaveLength(36);
    expect(first.nearbyEntities).toHaveLength(64);
    expect(first.nearbyHostiles).toHaveLength(64);
    expect(first.nearbyHostiles[0]).toMatchObject({
      entityId: 0,
      kind: "hostile_0",
      position: { x: 1, y: 64, z: 0 },
    });
    expect(hostileEntityIds).toHaveLength(70);
    expect(droppedItemEntityIds).toEqual(new Set([100, 101]));
    expect(first).not.toBe(second);
    expect(first.botPosition).not.toBe(bot.entity.position);
    expect(first.botPosition).not.toBe(second.botPosition);
    expect(first.worldSpawn).not.toBe(worldSpawn);
    expect(first.ownerPosition).not.toBe(bot.players.TestOwner?.entity?.position);
    expect(first.ownerPosition).not.toBe(second.ownerPosition);
    expect(first.inventorySummary[0]).not.toBe(second.inventorySummary[0]);
    expect(first.nearbyEntities?.[0]?.position).not.toBe(second.nearbyEntities?.[0]?.position);
    expect(first.nearbyHostiles[0]?.position).not.toBe(second.nearbyHostiles[0]?.position);

    first.worldSpawn!.x = 999;
    first.inventorySummary[0]!.count = 999;
    first.nearbyEntities![0]!.position.x = 999;
    expect(second.worldSpawn).toEqual({ x: 10, y: 70, z: -20 });
    expect(second.inventorySummary[0]).toEqual({ name: "item_0", count: 1 });
    expect(second.nearbyEntities?.[0]).toMatchObject({
      id: 0,
      position: { x: 1, y: 64, z: 0 },
    });
  });
});

describe("MineflayerAdapter", () => {
  beforeEach(() => {
    createBot.mockReset();
    pathfinder.mockReset();
    issueProof.mockReset();
    closeIssuer.mockReset();
    createBridgeProofIssuer.mockReset();
    let proofIndex = 0;
    issueProof.mockImplementation(async () => ({
      fakeHost: `127.0.0.1\0WL1\0adapter-proof-${++proofIndex}`,
      close: vi.fn(async () => undefined),
    }));
    closeIssuer.mockResolvedValue(undefined);
    createBridgeProofIssuer.mockReturnValue({ issue: issueProof, close: closeIssuer });
  });

  it("refuses immature wheat without changing the block", async () => {
    const bot = new FakeBot();
    const position = { x: 4, y: 64, z: 4 };
    bot.blockAt.mockReturnValue({
      name: "wheat",
      position,
      getProperties: () => ({ age: 6 }),
    });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(
      adapter.harvestCrop(position, "wheat", new AbortController().signal),
    ).rejects.toThrow("crop is not mature");
    expect(bot.dig).not.toHaveBeenCalled();
  });

  it("uses a trusted nearby crafting table when the recipe requires one", async () => {
    const bot = new FakeBot();
    const recipe = { result: { id: 297 } };
    const craftingTable = { name: "crafting_table", position: { x: 2, y: 64, z: 2 } };
    bot.recipesFor.mockImplementation((_itemId, _metadata, _count, table) =>
      table ? [recipe] : [],
    );
    bot.findBlock.mockReturnValue(craftingTable);
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await adapter.craftItem("bread", 1, new AbortController().signal);

    expect(bot.findBlock).toHaveBeenCalledWith({ matching: 58, maxDistance: 16 });
    expect(bot.craft).toHaveBeenCalledWith(recipe, 1, craftingTable);
  });

  it("tills only unobstructed dirt or grass with an available hoe", async () => {
    const bot = new FakeBot();
    const position = { x: 4, y: 64, z: 4 };
    const dirt = { name: "dirt", position, getProperties: () => ({}) };
    const air = { name: "air", position: { x: 4, y: 65, z: 4 }, getProperties: () => ({}) };
    const hoe = { name: "wooden_hoe", count: 1, type: 290 };
    bot.inventoryItems = [hoe];
    bot.blockAt.mockImplementation((value: unknown) =>
      (value as { y: number }).y === 65 ? air : dirt,
    );
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await adapter.tillSoil(position, new AbortController().signal);

    expect(bot.equip).toHaveBeenCalledWith(hoe, "hand");
    expect(bot.activateBlock).toHaveBeenCalledWith(dirt);
  });

  it("refuses tilling obstructed or unsupported ground and refuses to work without a hoe", async () => {
    const bot = new FakeBot();
    const position = { x: 4, y: 64, z: 4 };
    const ground = { name: "stone", position, getProperties: () => ({}) };
    const above = { name: "air", position: { x: 4, y: 65, z: 4 }, getProperties: () => ({}) };
    bot.blockAt.mockImplementation((value: unknown) =>
      (value as { y: number }).y === 65 ? above : ground,
    );
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.tillSoil(position, new AbortController().signal)).rejects.toThrow(
      "target block cannot be tilled",
    );
    ground.name = "dirt";
    above.name = "stone";
    await expect(adapter.tillSoil(position, new AbortController().signal)).rejects.toThrow(
      "space above soil is blocked",
    );
    above.name = "air";
    await expect(adapter.tillSoil(position, new AbortController().signal)).rejects.toThrow(
      "missing hoe",
    );
    expect(bot.activateBlock).not.toHaveBeenCalled();
  });

  it("plants wheat seeds only on lit unobstructed farmland", async () => {
    const bot = new FakeBot();
    const position = { x: 4, y: 64, z: 4 };
    const farmland = { name: "farmland", position, getProperties: () => ({}) };
    const air = {
      name: "air",
      position: { x: 4, y: 65, z: 4 },
      light: 9,
      getProperties: () => ({}),
    };
    const seeds = { name: "wheat_seeds", count: 2, type: 295 };
    bot.inventoryItems = [seeds];
    bot.blockAt.mockImplementation((value: unknown) =>
      (value as { y: number }).y === 65 ? air : farmland,
    );
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await adapter.plantCrop(position, "wheat_seeds", new AbortController().signal);

    expect(bot.equip).toHaveBeenCalledWith(seeds, "hand");
    expect(bot.placeBlock).toHaveBeenCalledWith(farmland, expect.objectContaining({ y: 1 }));
  });

  it("refuses planting on non-farmland, blocked, dark, or seedless targets", async () => {
    const bot = new FakeBot();
    const position = { x: 4, y: 64, z: 4 };
    const farmland = { name: "dirt", position, getProperties: () => ({}) };
    const air = {
      name: "air",
      position: { x: 4, y: 65, z: 4 },
      light: 9,
      getProperties: () => ({}),
    };
    bot.blockAt.mockImplementation((value: unknown) =>
      (value as { y: number }).y === 65 ? air : farmland,
    );
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(
      adapter.plantCrop(position, "wheat_seeds", new AbortController().signal),
    ).rejects.toThrow("target block is not farmland");
    farmland.name = "farmland";
    air.name = "stone";
    await expect(
      adapter.plantCrop(position, "wheat_seeds", new AbortController().signal),
    ).rejects.toThrow("space above farmland is blocked");
    air.name = "air";
    air.light = 7;
    await expect(
      adapter.plantCrop(position, "wheat_seeds", new AbortController().signal),
    ).rejects.toThrow("insufficient light for wheat");
    air.light = 9;
    await expect(
      adapter.plantCrop(position, "wheat_seeds", new AbortController().signal),
    ).rejects.toThrow("missing wheat_seeds in inventory");
    expect(bot.placeBlock).not.toHaveBeenCalled();
  });

  it("harvests mature wheat through the cancellable dig path", async () => {
    const bot = new FakeBot();
    const position = { x: 4, y: 64, z: 4 };
    const wheat = { name: "wheat", position, getProperties: () => ({ age: 7 }) };
    bot.blockAt.mockReturnValue(wheat);
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await adapter.harvestCrop(position, "wheat", new AbortController().signal);

    expect(bot.dig).toHaveBeenCalledWith(wheat);
  });

  it("reads a bounded furnace snapshot and always closes the window", async () => {
    const bot = new FakeBot();
    const position = { x: 5, y: 64, z: 5 };
    const block = { name: "furnace", position, getProperties: () => ({ lit: true }) };
    const furnace = new FakeFurnace();
    furnace.input = { name: "raw_cod", type: 349, count: 2 };
    furnace.fuel = { name: "coal", type: 263, count: 1 };
    furnace.output = { name: "cooked_cod", type: 350, count: 1 };
    furnace.progress = 0.5;
    bot.blockAt.mockReturnValue(block);
    bot.openFurnace.mockResolvedValue(furnace);
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.furnaceSnapshot(position)).resolves.toEqual({
      position,
      input: { name: "raw_cod", count: 2 },
      fuel: { name: "coal", count: 1 },
      output: { name: "cooked_cod", count: 1 },
      progress: 0.5,
    });
    expect(furnace.close).toHaveBeenCalledOnce();
  });

  it("continues compatible partial furnace input and fuel", async () => {
    const bot = new FakeBot();
    const furnace = new FakeFurnace();
    furnace.input = { name: "iron_ore", type: 15, count: 1 };
    furnace.fuel = { name: "coal", type: 263, count: 1 };
    furnace.putInput.mockImplementation(async (type, _metadata, count) => {
      furnace.input = { name: "iron_ore", type, count: (furnace.input?.count ?? 0) + count };
    });
    bot.inventoryItems = [{ name: "iron_ore", type: 15, count: 1 }];
    bot.findBlock.mockReturnValue({ name: "furnace", position: { x: 1, y: 64, z: 1 } });
    bot.openFurnace.mockResolvedValue(furnace);
    bot.waitForTicks.mockImplementation(async () => {
      furnace.output = { name: "iron_ingot", type: 265, count: 2 };
    });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await adapter.smeltItem("iron_ore", 2, new AbortController().signal);

    expect(furnace.putInput).toHaveBeenCalledWith(15, null, 1);
    expect(furnace.putFuel).not.toHaveBeenCalled();
    expect(furnace.takeOutput).toHaveBeenCalledOnce();
    expect(furnace.close).toHaveBeenCalledOnce();
  });

  it("refuses a furnace containing incompatible input", async () => {
    const bot = new FakeBot();
    const furnace = new FakeFurnace();
    furnace.input = { name: "gold_ore", type: 14, count: 1 };
    bot.inventoryItems = [
      { name: "iron_ore", type: 15, count: 1 },
      { name: "coal", type: 263, count: 1 },
    ];
    bot.findBlock.mockReturnValue({ name: "furnace", position: { x: 1, y: 64, z: 1 } });
    bot.openFurnace.mockResolvedValue(furnace);
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.smeltItem("iron_ore", 1, new AbortController().signal)).rejects.toThrow(
      "furnace input is incompatible",
    );
    expect(furnace.putInput).not.toHaveBeenCalled();
    expect(furnace.close).toHaveBeenCalledOnce();
  });

  it("retracts fishing and rejects late completion after abort", async () => {
    const bot = new FakeBot();
    const pendingFish = deferred<void>();
    bot.heldItem = { name: "fishing_rod", count: 1, type: 346 };
    bot.inventoryItems = [{ name: "fishing_rod", count: 1, type: 346 }];
    bot.findBlock.mockReturnValue({ name: "water", position: { x: 2, y: 63, z: 2 } });
    bot.blockAt.mockReturnValue({ name: "air", position: { x: 2, y: 64, z: 2 } });
    bot.fish.mockReturnValue(pendingFish.promise);
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const controller = new AbortController();

    let rejection: unknown;
    const fishing = adapter.fish(controller.signal).catch((error: unknown) => {
      rejection = error;
    });
    await flush();
    expect(bot.fish).toHaveBeenCalledOnce();
    controller.abort();

    await fishing;
    expect(rejection).toMatchObject({ name: "AbortError" });
    expect(bot.deactivateItem).toHaveBeenCalledOnce();
    pendingFish.resolve();
    await flush();
    expect(bot.fish).toHaveBeenCalledOnce();
  });

  it("returns a bounded inventory delta after successful fishing", async () => {
    const bot = new FakeBot();
    bot.heldItem = { name: "fishing_rod", count: 1, type: 346 };
    bot.inventoryItems = [{ name: "fishing_rod", count: 1, type: 346 }];
    bot.findBlock.mockReturnValue({ name: "water", position: { x: 2, y: 63, z: 2 } });
    bot.blockAt.mockReturnValue({ name: "air", position: { x: 2, y: 64, z: 2 } });
    bot.fish.mockImplementation(async () => {
      bot.inventoryItems = [
        { name: "fishing_rod", count: 1, type: 346 },
        { name: "cod", count: 1, type: 349 },
      ];
    });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.fish(new AbortController().signal)).resolves.toEqual({
      added: [{ name: "cod", count: 1 }],
      removed: [],
    });
  });

  it("refuses fishing without an equipped rod", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.fish(new AbortController().signal)).rejects.toThrow(
      "fishing rod is not equipped",
    );
    expect(bot.findBlock).not.toHaveBeenCalled();
    expect(bot.fish).not.toHaveBeenCalled();
  });

  it("refuses fishing without suitable nearby water", async () => {
    const bot = new FakeBot();
    bot.heldItem = { name: "fishing_rod", count: 1, type: 346 };
    bot.inventoryItems = [{ name: "fishing_rod", count: 1, type: 346 }];
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.fish(new AbortController().signal)).rejects.toThrow(
      "no suitable nearby water",
    );
    expect(bot.fish).not.toHaveBeenCalled();
  });

  it("refuses fishing at water without an open surface", async () => {
    const bot = new FakeBot();
    bot.heldItem = { name: "fishing_rod", count: 1, type: 346 };
    bot.inventoryItems = [{ name: "fishing_rod", count: 1, type: 346 }];
    bot.findBlock.mockReturnValue({ name: "water", position: { x: 2, y: 63, z: 2 } });
    bot.blockAt.mockReturnValue({ name: "stone", position: { x: 2, y: 64, z: 2 } });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.fish(new AbortController().signal)).rejects.toThrow(
      "no suitable nearby water",
    );
    expect(bot.fish).not.toHaveBeenCalled();
  });

  it("returns bounded block properties without exposing registry objects", async () => {
    const bot = new FakeBot();
    const position = { x: 3, y: 65, z: 4 };
    const properties = Object.fromEntries([
      ["age", 7],
      ["description", "x".repeat(100)],
      ...Array.from({ length: 20 }, (_, index) => [`property_${index}`, index]),
    ]);
    bot.blockAt.mockReturnValue({ name: "wheat", position, getProperties: () => properties });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    const inspected = await adapter.inspectBlock(position);

    expect(inspected).toMatchObject({ name: "wheat", position });
    expect(Object.keys(inspected?.properties ?? {})).toHaveLength(16);
    expect(String(inspected?.properties.description ?? "").length).toBeLessThanOrEqual(64);
    expect(inspected?.position).not.toBe(position);
  });

  it("sorts block searches stably, limits results, and reports truncation", async () => {
    const bot = new FakeBot();
    const positions = Array.from({ length: 33 }, (_, index) => ({
      x: 33 - index,
      y: 64,
      z: index % 2,
    }));
    bot.findBlocks.mockReturnValue(positions);
    bot.blockAt.mockImplementation((value: unknown) => ({
      name: "stone",
      position: value,
      getProperties: () => ({}),
    }));
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    const result = await adapter.findBlocks({ names: ["stone"], maxDistance: 64, maxResults: 32 });

    expect(result.blocks).toHaveLength(32);
    expect(result.truncated).toBe(true);
    expect(result.blocks[0]?.position).toEqual({ x: 1, y: 64, z: 0 });
    expect(bot.findBlocks).toHaveBeenCalledWith({ matching: [1], maxDistance: 64, count: 33 });
  });

  it("rejects unknown exact blocks and unsupported search tags", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(
      adapter.findBlocks({ names: ["unknown_block"], maxDistance: 16, maxResults: 8 }),
    ).rejects.toThrow("unknown block");
    await expect(
      adapter.findBlocks({
        tag: "valuable_ore" as "bed",
        maxDistance: 16,
        maxResults: 8,
      }),
    ).rejects.toThrow("unsupported block search tag");
  });

  it("matches only mature wheat for the mature crop search tag", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await adapter.findBlocks({ tag: "mature_wheat", maxDistance: 16, maxResults: 8 });
    const matching = (
      bot.findBlocks.mock.calls[0]?.[0] as { matching: (block: unknown) => boolean }
    ).matching;

    expect(matching({ name: "wheat", getProperties: () => ({ age: 7 }) })).toBe(true);
    expect(matching({ name: "wheat", getProperties: () => ({ age: 6 }) })).toBe(false);
    expect(matching({ name: "carrots", getProperties: () => ({ age: 7 }) })).toBe(false);
  });

  it("consumes only registered inventory food and returns health and hunger changes", async () => {
    const bot = new FakeBot();
    const bread = { name: "bread", count: 1, type: 297 };
    bot.inventoryItems = [bread];
    bot.health = 18;
    bot.food = 12;
    bot.consume.mockImplementation(async () => {
      bot.food = 17;
    });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.consumeItem("bread", new AbortController().signal)).resolves.toEqual({
      healthBefore: 18,
      healthAfter: 18,
      foodBefore: 12,
      foodAfter: 17,
    });
    expect(bot.equip).toHaveBeenCalledWith(bread, "hand");
    expect(bot.consume).toHaveBeenCalledOnce();
  });

  it("refuses non-food items before equipping or consuming them", async () => {
    const bot = new FakeBot();
    bot.inventoryItems = [{ name: "stick", count: 2, type: 2 }];
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.consumeItem("stick", new AbortController().signal)).rejects.toThrow(
      "item is not edible",
    );
    expect(bot.equip).not.toHaveBeenCalled();
    expect(bot.consume).not.toHaveBeenCalled();
  });

  it("sleeps only in an unoccupied reachable bed at night", async () => {
    const bot = new FakeBot();
    const position = { x: 2, y: 64, z: 2 };
    const bed = { name: "white_bed", position, getProperties: () => ({ occupied: false }) };
    bot.time.timeOfDay = 13_000;
    bot.blockAt.mockReturnValue(bed);
    bot.isABed.mockReturnValue(true);
    bot.sleep.mockImplementation(async () => {
      bot.isSleeping = true;
    });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(
      adapter.sleepInBed(position, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(bot.canDigBlock).toHaveBeenCalledWith(bed);
    expect(bot.sleep).toHaveBeenCalledWith(bed);
  });

  it("refuses occupied beds and daytime sleep before calling Mineflayer sleep", async () => {
    const bot = new FakeBot();
    const position = { x: 2, y: 64, z: 2 };
    bot.blockAt.mockReturnValue({
      name: "white_bed",
      position,
      getProperties: () => ({ occupied: true }),
    });
    bot.isABed.mockReturnValue(true);
    bot.time.timeOfDay = 13_000;
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.sleepInBed(position, new AbortController().signal)).rejects.toThrow(
      "bed is occupied",
    );
    bot.blockAt.mockReturnValue({
      name: "white_bed",
      position,
      getProperties: () => ({ occupied: false }),
    });
    bot.time.timeOfDay = 1_000;
    await expect(adapter.sleepInBed(position, new AbortController().signal)).rejects.toThrow(
      "sleeping is not allowed now",
    );
    expect(bot.sleep).not.toHaveBeenCalled();
  });

  it("wakes a sleeping bot when the sleep action is aborted", async () => {
    const bot = new FakeBot();
    const position = { x: 2, y: 64, z: 2 };
    const pendingSleep = deferred<void>();
    bot.time.timeOfDay = 13_000;
    bot.blockAt.mockReturnValue({
      name: "white_bed",
      position,
      getProperties: () => ({ occupied: false }),
    });
    bot.isABed.mockReturnValue(true);
    bot.sleep.mockReturnValue(pendingSleep.promise);
    bot.wake.mockImplementation(async () => {
      bot.isSleeping = false;
    });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const controller = new AbortController();
    let rejection: unknown;
    const sleeping = adapter.sleepInBed(position, controller.signal).catch((error: unknown) => {
      rejection = error;
    });
    await flush();
    bot.isSleeping = true;

    controller.abort();

    await sleeping;
    expect(rejection).toMatchObject({ name: "AbortError" });
    expect(bot.wake).toHaveBeenCalledOnce();
    pendingSleep.resolve();
    await flush();
  });

  it("treats waking while already awake as an idempotent success", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.wakeUp(new AbortController().signal)).resolves.toBeUndefined();
    expect(bot.wake).not.toHaveBeenCalled();
    bot.isSleeping = true;
    await expect(adapter.wakeUp(new AbortController().signal)).resolves.toBeUndefined();
    expect(bot.wake).toHaveBeenCalledOnce();
  });

  it("fails every living and observation method closed while disconnected", async () => {
    const adapter = new MineflayerAdapter(config());
    const position = { x: 1, y: 64, z: 2 };
    const signal = new AbortController().signal;
    const attempts = [
      () => adapter.inspectBlock(position),
      () => adapter.findBlocks({ names: ["stone"], maxDistance: 16, maxResults: 8 }),
      () => adapter.furnaceSnapshot(position),
      () => adapter.fish(signal),
      () => adapter.consumeItem("bread", signal),
      () => adapter.sleepInBed(position, signal),
      () => adapter.wakeUp(signal),
      () => adapter.tillSoil(position, signal),
      () => adapter.plantCrop(position, "wheat_seeds", signal),
      () => adapter.harvestCrop(position, "wheat", signal),
    ];

    for (const attempt of attempts) await expect(attempt()).rejects.toThrow("not connected");
  });

  it("keeps third-party parser diagnostics off the desktop protocol stream", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const events: string[] = [];
    adapter.onEvent((event) => events.push(event.kind));

    const connecting = adapter.connect();
    await vi.waitFor(() => expect(createBot).toHaveBeenCalledOnce());
    bot.emit("playerJoined", { username: "TestOwner" });
    bot.emit("chat", "TestOwner", "hello");
    bot.emit("spawn");
    await connecting;
    bot.emit("playerLeft", { username: "TestOwner" });
    const secondConnect = adapter.connect();

    expect(createBot).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 25565,
      username: "WhiteLily",
      auth: "offline",
      hideErrors: true,
      logErrors: false,
      fakeHost: "127.0.0.1\0WL1\0adapter-proof-1",
    });
    expect(createBridgeProofIssuer).toHaveBeenCalledWith({ dataRoot: "C:\\WhiteLilyData" });
    expect(issueProof).toHaveBeenCalledWith(25565);
    expect(bot.loadPlugin).toHaveBeenCalledWith(pathfinder);
    expect(events).toEqual(["owner_online", "chat", "connected", "owner_offline"]);
    expect(createBot).toHaveBeenCalledTimes(1);
    await expect(secondConnect).resolves.toBeUndefined();
  });

  it("forwards one stable terminal Bridge event after post-connect automatic rejections", async () => {
    vi.useFakeTimers();
    const bots: FakeBot[] = [];
    createBot.mockImplementation(() => {
      const bot = new FakeBot();
      bots.push(bot);
      return bot;
    });
    const adapter = new MineflayerAdapter(config());
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    const connecting = adapter.connect();
    await flush();
    bots[0]?.emit("spawn");
    await connecting;

    bots[0]?.emit("end", "private connected end");
    await flush();
    for (let rejectionIndex = 0; rejectionIndex < 5; rejectionIndex += 1) {
      await vi.advanceTimersToNextTimerAsync();
      await flush();
      bots.at(-1)?.emit("kicked", `private rejection ${rejectionIndex}`, false);
      await flush();
    }

    expect(createBot).toHaveBeenCalledTimes(6);
    expect(events).toContainEqual({
      kind: "bridge_failed",
      code: "MINECRAFT_BRIDGE_REJECTED",
    });
    expect(JSON.stringify(events)).not.toContain("private rejection");
    await adapter.disconnect().catch(() => undefined);
  });

  it("maps issuer preparation failure without creating a bot or exposing issuer details", async () => {
    const secret =
      "nonce-secret C:\\Users\\Owner\\WhiteLily\\bridge\\requests\\private.json 127.0.0.1:25565";
    issueProof.mockRejectedValueOnce(new Error(secret));
    const adapter = new MineflayerAdapter(config());

    const rejection = await adapter.connect().catch((error: unknown) => error);

    expect(rejection).toMatchObject({ code: "MINECRAFT_BRIDGE_REQUIRED" });
    expect(String(rejection)).not.toContain(secret);
    expect(createBot).not.toHaveBeenCalled();
    await adapter.disconnect();
    expect(closeIssuer).toHaveBeenCalledOnce();
  });

  it("drains pending preparation and proof close before shutting down the issuer", async () => {
    const issueGate = deferred<{
      fakeHost: string;
      close: ReturnType<typeof vi.fn>;
    }>();
    const closeGate = deferred();
    const proof = {
      fakeHost: "127.0.0.1\0WL1\0adapter-disconnect-drain",
      close: vi.fn(() => closeGate.promise),
    };
    issueProof.mockReturnValueOnce(issueGate.promise);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect().catch((error: unknown) => error);

    let disconnectSettled = false;
    const disconnecting = adapter.disconnect().finally(() => {
      disconnectSettled = true;
    });
    await flush();
    expect(disconnectSettled).toBe(false);
    expect(closeIssuer).not.toHaveBeenCalled();

    issueGate.resolve(proof);
    await flush();
    expect(proof.close).toHaveBeenCalledOnce();
    expect(disconnectSettled).toBe(false);
    expect(closeIssuer).not.toHaveBeenCalled();

    closeGate.resolve();
    await disconnecting;
    await connecting;
    expect(closeIssuer).toHaveBeenCalledOnce();
  });

  it("passes the pinned Mineflayer logging opt-out and fails repeated bot errors closed once", async () => {
    const bot = new FakeBot();
    const protocolStdoutLines: string[] = [];
    // This mock mirrors the pinned loader's logErrors branch; the separate loader
    // boundary test below exercises the installed dependency itself.
    createBot.mockImplementation((options: { logErrors?: boolean }) => {
      if (options.logErrors !== false) {
        bot.on("error", (error: Error) => {
          protocolStdoutLines.push(...(error.stack ?? error.message).split(/\r?\n/u));
        });
      }
      return bot;
    });
    const adapter = new MineflayerAdapter(config());
    const events: string[] = [];
    adapter.onEvent((event) => events.push(event.kind));
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    expect(() => bot.emit("error", new Error("private stack"))).not.toThrow();

    expect(protocolStdoutLines).toEqual([]);
    expect(events).toEqual(["connected", "disconnected"]);
    expect(bot.end).toHaveBeenCalledWith("Minecraft connection error");

    expect(() => bot.emit("error", new Error("late private stack"))).not.toThrow();
    expect(protocolStdoutLines).toEqual([]);
    expect(events).toEqual(["connected", "disconnected"]);
    expect(bot.end).toHaveBeenCalledTimes(1);
  });

  it("maps a connected kick to one generic public disconnect without exposing its reason", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const events: Array<{ kind: string; reason?: string }> = [];
    adapter.onEvent((event) => events.push(event));
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const privateReason = '{"text":"private server rejection"}';

    expect(() => bot.emit("kicked", privateReason, true)).not.toThrow();
    expect(() => bot.emit("kicked", "late private rejection", true)).not.toThrow();
    expect(() => bot.emit("error", new Error("late private error"))).not.toThrow();
    expect(() => bot.emit("end", "late private end")).not.toThrow();

    expect(bot.end).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { kind: "connected" },
      { kind: "disconnected", reason: "Minecraft connection rejected" },
    ]);
    expect(JSON.stringify(events)).not.toContain(privateReason);
    await adapter.disconnect();
  });

  it("reports a tab-list owner online even when their entity is outside tracking range", async () => {
    const bot = new FakeBot();
    bot.players.TestOwner = {};
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.isOwnerOnline("TestOwner")).resolves.toBe(true);
    await expect(adapter.isOwnerOnline("OtherOwner")).resolves.toBe(false);
  });

  it("maps only trusted active-bot dimension transitions to the public world event", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const events: string[] = [];
    adapter.onEvent((event) => events.push(event.kind));
    const connecting = adapter.connect();
    await flush();
    bot._client.emit("login", { worldName: "minecraft:overworld" });
    bot.emit("spawn");
    await connecting;

    bot._client.emit("respawn", { worldName: "minecraft:overworld" });
    bot.game.dimension = "the_nether";
    bot._client.emit("respawn", { worldName: "minecraft:the_nether" });
    bot._client.emit("respawn", { worldName: "minecraft:the_nether" });

    expect(events).toEqual(["connected", "world_changed"]);
  });

  it("publishes only protocol-authoritative world spawn and tracks nonzero runtime changes", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.snapshot("TestOwner")).resolves.not.toHaveProperty("worldSpawn");

    bot._client.emit("spawn_position", { location: { x: 120, y: 71, z: -45 } });
    await expect(adapter.snapshot("TestOwner")).resolves.toMatchObject({
      worldSpawn: { x: 120, y: 71, z: -45 },
    });

    bot._client.emit("spawn_position", { location: { x: -80, y: 64, z: 230 } });
    await expect(adapter.snapshot("TestOwner")).resolves.toMatchObject({
      worldSpawn: { x: -80, y: 64, z: 230 },
    });
  });

  it.each(["tnt", "lava_bucket", "flint_and_steel", "fire_charge"])(
    "rejects dangerous item %s at the live adapter equip boundary",
    async (itemName) => {
      const bot = new FakeBot();
      bot.inventoryItems = [{ name: itemName, type: 1, count: 1 }];
      createBot.mockReturnValue(bot);
      const adapter = new MineflayerAdapter(config());
      const connecting = adapter.connect();
      await flush();
      bot.emit("spawn");
      await connecting;

      await expect(
        adapter.equipItem(itemName, "hand", new AbortController().signal),
      ).rejects.toThrow("dangerous item is permanently forbidden");
      expect(bot.equip).not.toHaveBeenCalled();
    },
  );

  it("emits bounded hostile proximity entries once per near interval and permits re-entry", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const threats: Array<{
      kind: "hostile_nearby";
      entityId: number;
      entityKind: string;
      position: { x: number; y: number; z: number };
    }> = [];
    adapter.onEvent((event) => {
      if (event.kind === "hostile_nearby") threats.push(event);
    });
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const zombie: FakeEntity = {
      id: 7,
      name: "zombie",
      type: "hostile",
      position: { x: 17, y: 64, z: 0 },
    };
    bot.entities["7"] = zombie;

    bot.emit("entitySpawn", zombie);
    expect(threats).toEqual([]);
    zombie.position = { x: 16, y: 64, z: 0 };
    bot.emit("entityMoved", zombie);
    bot.emit("entityMoved", zombie);
    expect(threats).toEqual([
      {
        kind: "hostile_nearby",
        entityId: 7,
        entityKind: "zombie",
        position: { x: 16, y: 64, z: 0 },
      },
    ]);

    zombie.position = { x: 17, y: 64, z: 0 };
    bot.emit("entityMoved", zombie);
    zombie.position = { x: 1, y: 64, z: 1 };
    bot.emit("entityMoved", zombie);
    expect(threats).toHaveLength(2);

    bot.emit("entityGone", zombie);
    bot.emit("entitySpawn", zombie);
    expect(threats).toHaveLength(3);
  });

  it("reevaluates a stationary hostile when only the bot moves or is forcibly moved", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const threatIds: number[] = [];
    adapter.onEvent((event) => {
      if (event.kind === "hostile_nearby") threatIds.push(event.entityId);
    });
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const stationaryZombie: FakeEntity = {
      id: 7,
      name: "zombie",
      type: "hostile",
      position: { x: 20, y: 64, z: 0 },
    };
    bot.entities["7"] = stationaryZombie;
    bot.emit("entitySpawn", stationaryZombie);
    expect(threatIds).toEqual([]);

    bot.entity.position = { x: 5, y: 64, z: 0 };
    bot.emit("move");
    bot.emit("move");
    expect(threatIds).toEqual([7]);

    bot.entity.position = { x: 0, y: 64, z: 0 };
    bot.emit("forcedMove");
    bot.entity.position = { x: 5, y: 64, z: 0 };
    bot.emit("forcedMove");

    expect(threatIds).toEqual([7, 7]);
  });

  it("caps known hostiles at 64 while retaining a nearer sixty-fifth hostile", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const threatIds: number[] = [];
    adapter.onEvent((event) => {
      if (event.kind === "hostile_nearby") threatIds.push(event.entityId);
    });
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    for (let id = 1; id <= 64; id += 1) {
      const hostile: FakeEntity = {
        id,
        name: `hostile-${id}`,
        type: "hostile",
        position: { x: id * 1_000, y: 64, z: 0 },
      };
      bot.entities[String(id)] = hostile;
      bot.emit("entitySpawn", hostile);
    }
    const nearer: FakeEntity = {
      id: 65,
      name: "nearer",
      type: "hostile",
      position: { x: 1, y: 64, z: 0 },
    };
    bot.entities["65"] = nearer;
    bot.emit("entitySpawn", nearer);
    expect(threatIds).toEqual([65]);

    bot.entity.position = { x: 64_000, y: 64, z: 0 };
    bot.emit("move");
    bot.entity.position = { x: 63_000, y: 64, z: 0 };
    bot.emit("forcedMove");

    expect(threatIds).toEqual([65, 63]);
    expect(threatIds).not.toContain(64);
  });

  it("detaches hostile tracking from an old bot across disconnect and reconnect", async () => {
    vi.useFakeTimers();
    const first = new FakeBot();
    const second = new FakeBot();
    createBot.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const adapter = new MineflayerAdapter(config());
    const threatIds: number[] = [];
    adapter.onEvent((event) => {
      if (event.kind === "hostile_nearby") threatIds.push(event.entityId);
    });
    const connecting = adapter.connect();
    await flush();
    first.emit("spawn");
    await connecting;
    const oldZombie: FakeEntity = {
      id: 7,
      name: "zombie",
      type: "hostile",
      position: { x: 1, y: 64, z: 1 },
    };
    first.entities["7"] = oldZombie;
    first.emit("entitySpawn", oldZombie);
    expect(threatIds).toEqual([7]);
    expect(first.listenerCount("move")).toBe(1);
    expect(first.listenerCount("forcedMove")).toBe(1);

    first.emit("end", "lost");
    await vi.advanceTimersByTimeAsync(1_000);
    second.emit("spawn");
    first.emit("entityMoved", oldZombie);
    const newZombie: FakeEntity = {
      id: 8,
      name: "husk",
      type: "hostile",
      position: { x: 2, y: 64, z: 2 },
    };
    second.entities["8"] = newZombie;
    second.emit("entitySpawn", newZombie);

    expect(threatIds).toEqual([7, 8]);
    expect(first.listenerCount("entitySpawn")).toBe(0);
    expect(first.listenerCount("entityMoved")).toBe(0);
    expect(first.listenerCount("entityGone")).toBe(0);
    expect(first.listenerCount("move")).toBe(0);
    expect(first.listenerCount("forcedMove")).toBe(0);
    vi.useRealTimers();
  });

  it("rejects slash chat after leading whitespace before reaching Mineflayer", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.say("  /op WhiteLily")).rejects.toThrow("commands");
    expect(bot.chat).not.toHaveBeenCalled();
  });

  it("caps block searches at 64 and rejects unknown registry names", async () => {
    const bot = new FakeBot();
    bot.findBlock.mockReturnValue({ position: { x: 4, y: 65, z: 6 } });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.findBlock("stone", 999)).resolves.toEqual({ x: 4, y: 65, z: 6 });
    await expect(adapter.findBlock("unknown_block", 5)).rejects.toThrow("unknown block");
    await expect(
      adapter.craftItem("unknown_item", 1, new AbortController().signal),
    ).rejects.toThrow("unknown item");
    expect(bot.findBlock).toHaveBeenCalledWith({ matching: 1, maxDistance: 64 });
  });

  it("authorizes only Mineflayer hostile and dropped-item types from the latest nearest snapshot", async () => {
    const bot = new FakeBot();
    const zombie = { id: 7, name: "zombie", type: "hostile", position: { x: 20, y: 64, z: 2 } };
    const drop = { id: 8, name: "item", type: "other", position: { x: 2, y: 64, z: 2 } };
    const allay = { id: 9, name: "allay", type: "mob", position: { x: 1, y: 64, z: 1 } };
    bot.entities["7"] = zombie;
    bot.entities["8"] = drop;
    bot.entities["9"] = allay;
    bot.nearestEntity.mockImplementation((predicate: (entity: FakeEntity) => boolean) =>
      predicate(drop) ? drop : null,
    );
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(adapter.attackHostile(7, new AbortController().signal)).rejects.toThrow(
      "snapshot",
    );
    const snapshot = await adapter.snapshot("TestOwner");
    await adapter.attackHostile(7, new AbortController().signal);
    await adapter.collectDropped(8, new AbortController().signal);
    await expect(adapter.attackHostile(9, new AbortController().signal)).rejects.toThrow(
      "snapshot",
    );
    expect(snapshot.nearbyEntities?.map((entity) => entity.id)).toEqual([9, 8, 7]);
    bot.entities["7"] = { ...zombie, type: "mob" };
    await expect(adapter.attackHostile(7, new AbortController().signal)).rejects.toThrow(
      "no longer available",
    );
    bot.entities["8"] = { ...drop, type: "object" };
    await expect(adapter.collectDropped(8, new AbortController().signal)).rejects.toThrow(
      "no longer available",
    );
    delete bot.entities["7"];
    await adapter.snapshot("TestOwner");
    await expect(adapter.attackHostile(7, new AbortController().signal)).rejects.toThrow(
      "snapshot",
    );

    expect(bot.attack).toHaveBeenCalledWith(zombie);
    expect(bot.pathfinder.goto).toHaveBeenCalledWith(expect.any(GoalNear));
  });

  it("clears snapshot entity authorizations across a disconnect and reconnect", async () => {
    vi.useFakeTimers();
    const first = new FakeBot();
    first.entities["7"] = {
      id: 7,
      name: "zombie",
      type: "hostile",
      position: { x: 1, y: 64, z: 1 },
    };
    const second = new FakeBot();
    createBot.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    first.emit("spawn");
    await connecting;
    await adapter.snapshot("TestOwner");
    first.emit("end", "lost");
    await vi.advanceTimersByTimeAsync(1_000);
    second.emit("spawn");
    await flush();

    await expect(adapter.attackHostile(7, new AbortController().signal)).rejects.toThrow(
      "snapshot",
    );
    vi.useRealTimers();
  });

  it("rejects the initial connect promise after the fifth retry and never starts a seventh bot", async () => {
    vi.useFakeTimers();
    const bots = Array.from({ length: 6 }, () => new FakeBot());
    for (const bot of bots) createBot.mockReturnValueOnce(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      bots[attempt]?.emit("end", "lost");
      const delay = [1000, 2000, 4000, 8000, 15000][attempt] ?? 0;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(createBot).toHaveBeenCalledTimes(attempt + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(createBot).toHaveBeenCalledTimes(attempt + 2);
    }
    bots[5]?.emit("end", "lost");

    await expect(connecting).rejects.toThrow("retries exhausted");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createBot).toHaveBeenCalledTimes(6);
    vi.useRealTimers();
  });

  it("rejects a pre-spawn connect promise when explicitly disconnected", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();

    await adapter.disconnect();

    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("resolves an explicit connected disconnect despite stop, control, or end cleanup failures", async () => {
    const scenarios = [
      {
        name: "pathfinder stop",
        configure: (bot: FakeBot) =>
          bot.pathfinder.stop.mockImplementation(() => {
            throw new Error("stop failed");
          }),
      },
      {
        name: "control reset",
        configure: (bot: FakeBot) =>
          bot.clearControlStates.mockImplementation(() => {
            throw new Error("clear failed");
          }),
      },
      {
        name: "bot end",
        configure: (bot: FakeBot) =>
          bot.end.mockImplementation(() => {
            throw new Error("end failed");
          }),
      },
    ];

    for (const scenario of scenarios) {
      vi.useFakeTimers();
      createBot.mockReset();
      const bot = new FakeBot();
      scenario.configure(bot);
      createBot.mockReturnValue(bot);
      const adapter = new MineflayerAdapter(config());
      const events: string[] = [];
      adapter.onEvent((event) => events.push(event.kind));
      const connecting = adapter.connect();
      await flush();
      bot.emit("spawn");
      await connecting;

      await expect(adapter.disconnect(), scenario.name).resolves.toBeUndefined();
      await expect(adapter.disconnect(), `${scenario.name} idempotent`).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(bot.clearControlStates, scenario.name).toHaveBeenCalled();
      expect(bot.end, scenario.name).toHaveBeenCalledOnce();
      expect(createBot, scenario.name).toHaveBeenCalledTimes(1);
      expect(events, scenario.name).toEqual(["connected", "disconnected"]);
      vi.useRealTimers();
    }
  });

  it("cleans partial bots and rejects after five retries when plugin setup always throws", async () => {
    vi.useFakeTimers();
    const bots = Array.from({ length: 6 }, () => new FakeBot());
    for (const bot of bots) {
      bot.loadPlugin.mockImplementation(() => {
        throw new Error("plugin setup failed");
      });
      bot.end.mockImplementation(() => {
        throw new Error("end also failed");
      });
      createBot.mockReturnValueOnce(bot);
    }
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    const rejected = expect(connecting).rejects.toThrow("retries exhausted");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await vi.advanceTimersByTimeAsync([1000, 2000, 4000, 8000, 15000][attempt] ?? 0);
      expect(createBot).toHaveBeenCalledTimes(attempt + 2);
    }

    await rejected;
    for (const bot of bots) {
      expect(bot.end).toHaveBeenCalledOnce();
      expect(bot.eventNames()).toEqual(["error", "kicked"]);
      expect(() => bot.emit("error", new Error("late private stack"))).not.toThrow();
      expect(() => bot.emit("kicked", "late private rejection", false)).not.toThrow();
    }
    vi.useRealTimers();
  });

  it("detaches partial listeners after attach throws and lets the next attempt spawn", async () => {
    vi.useFakeTimers();
    const partial = new FakeBot();
    partial.throwOnEvent = "playerJoined";
    const succeeding = new FakeBot();
    createBot.mockReturnValueOnce(partial).mockReturnValueOnce(succeeding);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();

    expect(partial.listenerCount("chat")).toBe(0);
    expect(partial.listenerCount("playerJoined")).toBe(0);
    expect(partial.end).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    succeeding.emit("spawn");
    await expect(connecting).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("shares recovery callers while the retry timer is pending and while its bot awaits spawn", async () => {
    vi.useFakeTimers();
    const first = new FakeBot();
    const retry = new FakeBot();
    createBot.mockReturnValueOnce(first).mockReturnValueOnce(retry);
    const adapter = new MineflayerAdapter(config());
    const initial = adapter.connect();
    await flush();
    first.emit("spawn");
    await initial;
    first.emit("end", "lost");

    const waitingForTimer = adapter.connect();
    const sameTimerWait = adapter.connect();
    expect(createBot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(createBot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(createBot).toHaveBeenCalledTimes(2);

    const waitingForSpawn = adapter.connect();
    expect(createBot).toHaveBeenCalledTimes(2);
    retry.emit("spawn");

    await expect(Promise.all([waitingForTimer, sameTimerWait, waitingForSpawn])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    vi.useRealTimers();
  });

  it("rejects shared recovery waiters together on exhaustion or explicit disconnect", async () => {
    vi.useFakeTimers();
    const bots = Array.from({ length: 6 }, () => new FakeBot());
    for (const bot of bots) createBot.mockReturnValueOnce(bot);
    const adapter = new MineflayerAdapter(config());
    const initial = adapter.connect();
    await flush();
    bots[0]?.emit("spawn");
    await initial;
    bots[0]?.emit("end", "lost");
    const firstWaiter = adapter.connect();
    const secondWaiter = adapter.connect();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await vi.advanceTimersByTimeAsync([1000, 2000, 4000, 8000, 15000][attempt] ?? 0);
      bots[attempt + 1]?.emit("end", "lost");
    }
    await expect(firstWaiter).rejects.toThrow("retries exhausted");
    await expect(secondWaiter).rejects.toThrow("retries exhausted");

    createBot.mockClear();
    const active = new FakeBot();
    createBot.mockReturnValue(active);
    const stopping = new MineflayerAdapter(config());
    const started = stopping.connect();
    await flush();
    active.emit("spawn");
    await started;
    active.emit("end", "lost");
    const stoppingOne = stopping.connect();
    const stoppingTwo = stopping.connect();
    await stopping.disconnect();
    await expect(stoppingOne).rejects.toMatchObject({ name: "AbortError" });
    await expect(stoppingTwo).rejects.toMatchObject({ name: "AbortError" });
    vi.useRealTimers();
  });

  it("rechecks a block name before digging and stops a running path when aborted", async () => {
    const bot = new FakeBot();
    let finishPath: (() => void) | undefined;
    bot.pathfinder.goto.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPath = resolve;
        }),
    );
    bot.blockAt.mockReturnValue({ name: "dirt" });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(
      adapter.digBlock({ x: 1, y: 64, z: 1 }, "stone", new AbortController().signal),
    ).rejects.toThrow("does not match");

    const controller = new AbortController();
    const moving = adapter.moveTo({ x: 10, y: 64, z: 10 }, controller.signal);
    await flush();
    controller.abort();
    finishPath?.();
    await expect(moving).rejects.toMatchObject({ name: "AbortError" });

    expect(bot.pathfinder.stop).toHaveBeenCalled();
    expect(bot.clearControlStates).toHaveBeenCalled();
  });

  it("aborts dig before inspecting the world", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await expect(
      adapter.digBlock({ x: 1, y: 64, z: 1 }, "stone", AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(bot.blockAt).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "keeps an aborted dig pending until the cancellation fence when the original dig %s",
    async (originalOutcome) => {
      vi.useFakeTimers();
      const bot = new FakeBot();
      bot.blockAt.mockReturnValue({ name: "stone" });
      let settleDig: (() => void) | undefined;
      let acknowledgeStop: (() => void) | undefined;
      bot.dig.mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            settleDig = () =>
              originalOutcome === "resolve"
                ? resolve()
                : reject(new Error("stale original dig failure"));
          }),
      );
      bot.stopDigging.mockReturnValue(
        new Promise<void>((resolve) => {
          acknowledgeStop = resolve;
        }),
      );
      createBot.mockReturnValue(bot);
      const adapter = new MineflayerAdapter(config());
      const connecting = adapter.connect();
      await flush();
      bot.emit("spawn");
      await connecting;

      const controller = new AbortController();
      const digging = adapter.digBlock({ x: 1, y: 64, z: 1 }, "stone", controller.signal);
      await flush();
      let outcome = "pending";
      let settlements = 0;
      void digging.then(
        () => {
          outcome = "resolved";
          settlements += 1;
        },
        () => {
          outcome = "aborted";
          settlements += 1;
        },
      );

      controller.abort();
      settleDig?.();
      await flush();
      await flush();
      expect(outcome).toBe("pending");
      expect(bot.stopDigging).toHaveBeenCalledOnce();
      expect(bot.pathfinder.stop).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(outcome).toBe("pending");
      expect(bot.end).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(digging).rejects.toMatchObject({ name: "AbortError" });
      expect(outcome).toBe("aborted");
      expect(settlements).toBe(1);
      expect(bot.end).toHaveBeenCalledOnce();

      acknowledgeStop?.();
      await flush();
      expect(settlements).toBe(1);
      vi.useRealTimers();
    },
  );

  it("accepts a resolved stopDigging thenable as the physical cancellation acknowledgement", async () => {
    const bot = new FakeBot();
    bot.blockAt.mockReturnValue({ name: "stone" });
    let resolveDig: (() => void) | undefined;
    bot.dig.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDig = resolve;
        }),
    );
    bot.stopDigging.mockReturnValue(Promise.resolve());
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const controller = new AbortController();
    const digging = adapter.digBlock({ x: 1, y: 64, z: 1 }, "stone", controller.signal);
    await flush();

    controller.abort();

    await expect(digging).rejects.toMatchObject({ name: "AbortError" });
    expect(bot.end).not.toHaveBeenCalled();
    resolveDig?.();
    await flush();
    expect(bot.end).not.toHaveBeenCalled();
  });

  it("handles a rejected stopDigging thenable and fences the stale dig without an unhandled rejection", async () => {
    const bot = new FakeBot();
    bot.blockAt.mockReturnValue({ name: "stone" });
    bot.dig.mockImplementation(() => new Promise<void>(() => undefined));
    bot.stopDigging.mockReturnValue(Promise.reject(new Error("stop acknowledgement failed")));
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const controller = new AbortController();
    const digging = adapter.digBlock({ x: 1, y: 64, z: 1 }, "stone", controller.signal);
    await flush();

    controller.abort();

    await expect(digging).rejects.toMatchObject({ name: "AbortError" });
    expect(bot.end).toHaveBeenCalledOnce();
  });

  it("times out a never-settling stopDigging thenable and fences the stale dig", async () => {
    vi.useFakeTimers();
    const bot = new FakeBot();
    bot.blockAt.mockReturnValue({ name: "stone" });
    bot.dig.mockImplementation(() => new Promise<void>(() => undefined));
    bot.stopDigging.mockReturnValue(new Promise<void>(() => undefined));
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const controller = new AbortController();
    const digging = adapter.digBlock({ x: 1, y: 64, z: 1 }, "stone", controller.signal);
    await flush();

    controller.abort();
    const rejected = expect(digging).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(999);
    expect(bot.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await rejected;
    expect(bot.end).toHaveBeenCalledOnce();
  });

  it("fences a dig if physical cancellation does not settle within one second", async () => {
    vi.useFakeTimers();
    const bot = new FakeBot();
    bot.blockAt.mockReturnValue({ name: "stone" });
    bot.dig.mockImplementation(() => new Promise<void>(() => undefined));
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const controller = new AbortController();
    const digging = adapter.digBlock({ x: 1, y: 64, z: 1 }, "stone", controller.signal);
    await flush();
    let outcome = "pending";
    void digging.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "aborted";
      },
    );

    controller.abort();
    expect(bot.stopDigging).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(outcome).toBe("pending");
    expect(bot.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome).toBe("aborted");
    expect(bot.end).toHaveBeenCalledOnce();
    await adapter.disconnect();
  });

  it("settles a dig once when disconnect races its physical cancellation", async () => {
    const bot = new FakeBot();
    bot.blockAt.mockReturnValue({ name: "stone" });
    let resolveDig: (() => void) | undefined;
    bot.dig.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDig = resolve;
        }),
    );
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const controller = new AbortController();
    const digging = adapter.digBlock({ x: 1, y: 64, z: 1 }, "stone", controller.signal);
    await flush();
    let outcome = "pending";
    let settlements = 0;
    void digging.then(
      () => {
        outcome = "resolved";
        settlements += 1;
      },
      () => {
        outcome = "aborted";
        settlements += 1;
      },
    );

    controller.abort();
    await adapter.disconnect();
    await vi.waitFor(() => expect(outcome).toBe("aborted"), { timeout: 100 });
    expect(bot.stopDigging).toHaveBeenCalledOnce();
    expect(bot.end).toHaveBeenCalledOnce();
    expect(settlements).toBe(1);

    resolveDig?.();
    await flush();
    await flush();
    expect(outcome).toBe("aborted");
    expect(settlements).toBe(1);
  });

  it("stays fenced when stopDigging and fallback bot shutdown both throw", async () => {
    const bot = new FakeBot();
    bot.blockAt.mockReturnValue({ name: "stone" });
    bot.stopDigging.mockImplementation(() => {
      throw new Error("stop digging failed");
    });
    bot.end.mockImplementation(() => {
      throw new Error("bot shutdown failed");
    });
    let resolveDig: (() => void) | undefined;
    bot.dig.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDig = resolve;
        }),
    );
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const controller = new AbortController();
    const digging = adapter.digBlock({ x: 1, y: 64, z: 1 }, "stone", controller.signal);
    await flush();
    let settlements = 0;
    void digging.then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      },
    );

    controller.abort();

    await expect(digging).rejects.toMatchObject({ name: "AbortError" });
    expect(bot.stopDigging).toHaveBeenCalledOnce();
    expect(bot.end).toHaveBeenCalledOnce();
    expect(settlements).toBe(1);

    resolveDig?.();
    await flush();
    await flush();
    expect(bot.end).toHaveBeenCalledOnce();
    expect(settlements).toBe(1);
    await adapter.disconnect();
  });

  it("normalizes a deferred dig rejection after abort to AbortError", async () => {
    const bot = new FakeBot();
    bot.blockAt.mockReturnValue({ name: "stone" });
    let rejectDig: ((error: Error) => void) | undefined;
    bot.dig.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDig = reject;
        }),
    );
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    const controller = new AbortController();
    const digging = adapter.digBlock({ x: 1, y: 64, z: 1 }, "stone", controller.signal);
    await flush();
    controller.abort();
    rejectDig?.(new Error("underlying dig failed"));

    await expect(digging).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not start a pathfinder operation when aborted before its microtask", async () => {
    const bot = new FakeBot();
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const controller = new AbortController();
    const moving = adapter.moveTo({ x: 10, y: 64, z: 10 }, controller.signal);
    controller.abort();

    await expect(moving).rejects.toMatchObject({ name: "AbortError" });
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
  });

  it.each(["move", "follow", "collect"] as const)(
    "fences a never-settling %s path within one second of cancellation",
    async (kind) => {
      vi.useFakeTimers();
      const bot = new FakeBot();
      bot.pathfinder.goto.mockImplementation(() => new Promise<void>(() => undefined));
      bot.players.TestOwner = {
        entity: {
          id: 1,
          name: "player",
          type: "player",
          position: { x: 2, y: 64, z: 2 },
        },
      };
      bot.entities["8"] = {
        id: 8,
        name: "item",
        type: "other",
        position: { x: 3, y: 64, z: 3 },
      };
      createBot.mockReturnValue(bot);
      const adapter = new MineflayerAdapter(config());
      const connecting = adapter.connect();
      await flush();
      bot.emit("spawn");
      await connecting;
      if (kind === "collect") await adapter.snapshot("TestOwner");
      const controller = new AbortController();
      const operation =
        kind === "move"
          ? adapter.moveTo({ x: 10, y: 64, z: 10 }, controller.signal)
          : kind === "follow"
            ? adapter.followOwner("TestOwner", 2, controller.signal)
            : adapter.collectDropped(8, controller.signal);
      let outcome = "pending";
      void operation.then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "aborted";
        },
      );
      await flush();

      controller.abort();
      await vi.advanceTimersByTimeAsync(999);
      expect(outcome).toBe("pending");
      expect(bot.end).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(outcome).toBe("aborted");
      expect(bot.end).toHaveBeenCalledOnce();
      await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    },
  );

  it("reopens the ActionExecutor gate only after a timed-out path is fenced and uses the replacement session", async () => {
    vi.useFakeTimers();
    const first = new FakeBot();
    const replacement = new FakeBot();
    first.pathfinder.goto.mockImplementation(() => new Promise<void>(() => undefined));
    createBot.mockReturnValueOnce(first).mockReturnValueOnce(replacement);
    const adapter = new MineflayerAdapter(config());
    const lifecycle: string[] = [];
    let executor: ActionExecutor | undefined;
    adapter.onEvent((event) => {
      lifecycle.push(event.kind);
      if (event.kind === "world_changed") executor?.stopAll();
    });
    const connecting = adapter.connect();
    await flush();
    first._client.emit("login", { worldState: { name: "minecraft:overworld" } });
    first.emit("spawn");
    await connecting;
    const confirmations = new ConfirmationStore();
    executor = new ActionExecutor(
      adapter,
      {
        evaluate: () => ({ kind: "allow" }),
        evaluatePermanent: () => ({ kind: "allow" }),
      },
      confirmations,
      () => "TestOwner",
    );
    const context = {
      spawn: { x: 0, y: 64, z: 0 },
      owner: { x: 0, y: 64, z: 0 },
    };
    const active = executor.execute(
      { kind: "move_to", position: { x: 10, y: 64, z: 10 } },
      context,
    );
    const queued = executor.execute({ kind: "jump" }, context);
    await flush();
    await flush();
    await flush();
    expect(first.pathfinder.goto).toHaveBeenCalledOnce();

    first._client.emit("respawn", { worldState: { name: "custom:mirror_world" } });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(Promise.all([active, queued])).resolves.toEqual([
      { status: "cancelled" },
      { status: "cancelled" },
    ]);
    expect(first.waitForTicks).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(createBot).toHaveBeenCalledTimes(2);
    replacement._client.emit("login", { worldState: { name: "custom:mirror_world" } });
    replacement.emit("spawn");
    await flush();
    const subsequent = executor.execute(
      { kind: "move_to", position: { x: 20, y: 64, z: 20 } },
      context,
    );

    await expect(subsequent).resolves.toEqual({ status: "completed" });
    expect(lifecycle).toEqual(["connected", "world_changed", "disconnected", "connected"]);
    expect(first.pathfinder.goto).toHaveBeenCalledOnce();
    expect(replacement.pathfinder.goto).toHaveBeenCalledOnce();
  });

  it("fails the active action and blocks all primitives after every transport fence fallback throws", async () => {
    vi.useFakeTimers();
    const bot = new FakeBot();
    bot.pathfinder.goto.mockImplementation(() => new Promise<void>(() => undefined));
    bot.end.mockImplementation(() => {
      throw new Error("bot end failed");
    });
    bot._client.end.mockImplementation(() => {
      throw new Error("client end failed");
    });
    Object.assign(bot._client, {
      socket: {
        end: vi.fn(() => {
          throw new Error("socket end failed");
        }),
        destroy: vi.fn(() => {
          throw new Error("socket destroy failed");
        }),
      },
    });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const confirmations = new ConfirmationStore();
    const executor = new ActionExecutor(
      adapter,
      {
        evaluate: () => ({ kind: "allow" }),
        evaluatePermanent: () => ({ kind: "allow" }),
      },
      confirmations,
      () => "TestOwner",
    );
    const context = {
      spawn: { x: 0, y: 64, z: 0 },
      owner: { x: 0, y: 64, z: 0 },
    };
    const active = executor.execute(
      { kind: "move_to", position: { x: 10, y: 64, z: 10 } },
      context,
    );
    const queued = executor.execute({ kind: "jump" }, context);
    await flush();
    await flush();
    await flush();
    expect(bot.pathfinder.goto).toHaveBeenCalledOnce();

    executor.stopAll();
    const activeResult = expect(active).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("physical transport fence failed"),
    });
    const queuedResult = expect(queued).resolves.toEqual({ status: "cancelled" });
    await vi.advanceTimersByTimeAsync(1_000);

    await activeResult;
    await queuedResult;
    await expect(adapter.connect()).rejects.toThrow("adapter is stopped");
    const subsequent = executor.execute(
      { kind: "move_to", position: { x: 20, y: 64, z: 20 } },
      context,
    );
    await expect(subsequent).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("not connected"),
    });
    expect(bot.pathfinder.goto).toHaveBeenCalledOnce();
    expect(bot.waitForTicks).not.toHaveBeenCalled();
  });

  it("rejects a fatal explicit disconnect while settling active and queued actions without new primitives", async () => {
    const bot = new FakeBot();
    bot.pathfinder.goto.mockImplementation(() => new Promise<void>(() => undefined));
    bot.end.mockImplementation(() => {
      throw new Error("bot end failed");
    });
    bot._client.socket.end.mockImplementation(() => {
      throw new Error("socket end failed");
    });
    bot._client.socket.destroy.mockImplementation(() => {
      throw new Error("socket destroy failed");
    });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const confirmations = new ConfirmationStore();
    const executor = new ActionExecutor(
      adapter,
      {
        evaluate: () => ({ kind: "allow" }),
        evaluatePermanent: () => ({ kind: "allow" }),
      },
      confirmations,
      () => "TestOwner",
    );
    const context = {
      spawn: { x: 0, y: 64, z: 0 },
      owner: { x: 0, y: 64, z: 0 },
    };
    const results: string[] = [];
    executor.onResult((result) => results.push(result.status));
    const active = executor.execute(
      { kind: "move_to", position: { x: 10, y: 64, z: 10 } },
      context,
    );
    const queued = executor.execute({ kind: "jump" }, context);
    await flush();
    await flush();
    await flush();
    expect(bot.pathfinder.goto).toHaveBeenCalledOnce();

    await expect(adapter.disconnect()).rejects.toThrow("physical transport fence failed");
    await expect(active).resolves.toEqual({ status: "cancelled" });
    await expect(queued).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("not connected"),
    });
    const subsequent = executor.execute(
      { kind: "move_to", position: { x: 20, y: 64, z: 20 } },
      context,
    );
    await expect(subsequent).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("not connected"),
    });

    expect(results).toEqual(["cancelled", "failed", "failed"]);
    expect(bot.pathfinder.goto).toHaveBeenCalledOnce();
    expect(bot.waitForTicks).not.toHaveBeenCalled();
    expect(bot._client.end).not.toHaveBeenCalled();
    expect(bot._client.socket.end).toHaveBeenCalledOnce();
    expect(bot._client.socket.destroy).toHaveBeenCalledOnce();
  });

  it.each(["disconnect", "outage"] as const)(
    "does not start a queued action after connection-driven %s cancellation",
    async (cancellationKind) => {
      vi.useFakeTimers();
      const bot = new FakeBot();
      createBot.mockReturnValue(bot);
      const adapter = new MineflayerAdapter(config());
      const connecting = adapter.connect();
      await flush();
      bot.emit("spawn");
      await connecting;
      const moving = adapter.moveTo({ x: 10, y: 64, z: 10 }, new AbortController().signal);
      const rejected = expect(moving).rejects.toMatchObject({ name: "AbortError" });

      if (cancellationKind === "disconnect") {
        await adapter.disconnect();
      } else {
        bot.emit("end", "socket closed");
      }

      await rejected;
      await flush();
      await flush();
      expect(bot.pathfinder.goto).not.toHaveBeenCalled();

      await adapter.disconnect();
      vi.useRealTimers();
    },
  );

  it("fences a deferred placement before stale equip completion can place", async () => {
    const bot = new FakeBot();
    bot.end.mockImplementation(() => {
      throw new Error("Mineflayer end failed");
    });
    bot.inventoryItems = [{ name: "stone", type: 1, count: 1 }];
    bot.blockAt.mockReturnValue({ name: "dirt" });
    let resolveEquip: (() => void) | undefined;
    bot.equip.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEquip = resolve;
        }),
    );
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const controller = new AbortController();
    const placing = adapter.placeBlock({ x: 1, y: 64, z: 1 }, "stone", controller.signal);
    await flush();
    controller.abort();

    let outcome = "pending";
    void placing.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "aborted";
      },
    );
    await vi.waitFor(() => expect(outcome).toBe("aborted"), { timeout: 100 });
    expect(bot.end).toHaveBeenCalledOnce();
    expect(bot._client.end).not.toHaveBeenCalled();
    expect(bot._client.socket.end).toHaveBeenCalledOnce();
    expect(bot._client.socket.destroy).not.toHaveBeenCalled();
    await adapter.disconnect();
    resolveEquip?.();
    await expect(placing).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(bot.placeBlock).not.toHaveBeenCalled();
  });

  it("fences a deferred craft and ignores its stale completion after abort", async () => {
    const bot = new FakeBot();
    let resolveCraft: (() => void) | undefined;
    bot.craft.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCraft = resolve;
        }),
    );
    (
      bot as unknown as {
        recipesFor: () => Array<{ result: { id: number } }>;
      }
    ).recipesFor = () => [{ result: { id: 2 } }];
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const controller = new AbortController();
    const crafting = adapter.craftItem("stick", 1, controller.signal);
    await flush();
    controller.abort();

    let outcome = "pending";
    void crafting.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "aborted";
      },
    );
    await vi.waitFor(() => expect(outcome).toBe("aborted"), { timeout: 100 });
    expect(bot.end).toHaveBeenCalledOnce();
    await adapter.disconnect();
    resolveCraft?.();
    await expect(crafting).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(bot.end).toHaveBeenCalledOnce();
  });

  it("cleans up follow, jump, and wait when each is aborted while running", async () => {
    vi.useFakeTimers();
    const bot = new FakeBot();
    bot.players.TestOwner = {
      entity: { id: 1, name: "player", type: "player", position: { x: 2, y: 64, z: 2 } },
    };
    let finishFollow: (() => void) | undefined;
    let finishJump: (() => void) | undefined;
    bot.pathfinder.goto.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishFollow = resolve;
        }),
    );
    bot.waitForTicks.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishJump = resolve;
        }),
    );
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    const followController = new AbortController();
    const following = adapter.followOwner("TestOwner", 2, followController.signal);
    await flush();
    followController.abort();
    finishFollow?.();
    await expect(following).rejects.toMatchObject({ name: "AbortError" });

    const jumpController = new AbortController();
    const jumping = adapter.jump(jumpController.signal);
    await flush();
    jumpController.abort();
    finishJump?.();
    await expect(jumping).rejects.toMatchObject({ name: "AbortError" });
    await flush();

    const waitController = new AbortController();
    const waiting = adapter.wait(60_000, waitController.signal);
    waitController.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(bot.pathfinder.stop).toHaveBeenCalled();
    expect(bot.clearControlStates).toHaveBeenCalled();
    expect(bot.setControlState).toHaveBeenCalledWith("jump", false);
    vi.useRealTimers();
  });

  it("smelts the requested output with supported fuel and closes the furnace", async () => {
    const bot = new FakeBot();
    const furnace = new FakeFurnace();
    furnace.putFuel.mockImplementation(async (type, metadata, count) => {
      furnace.fuel = { name: "coal", type, count };
      furnace.output = { name: "iron_ingot", type: 265, count: 2 };
    });
    bot.inventoryItems = [
      { name: "iron_ore", type: 15, count: 2 },
      { name: "coal", type: 263, count: 1 },
    ];
    bot.findBlock.mockReturnValue({ position: { x: 1, y: 64, z: 1 } });
    bot.openFurnace.mockResolvedValue(furnace);
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    await adapter.smeltItem("iron_ore", 2, new AbortController().signal);

    expect(furnace.putInput).toHaveBeenCalledWith(15, null, 2);
    expect(furnace.putFuel).toHaveBeenCalledWith(263, null, 1);
    expect(furnace.takeOutput).toHaveBeenCalledOnce();
    expect(furnace.close).toHaveBeenCalledOnce();
  });

  it("closes a furnace and does not continue writes after an abort during opening or input", async () => {
    const bot = new FakeBot();
    const openingFurnace = new FakeFurnace();
    let resolveOpen: ((furnace: FakeFurnace) => void) | undefined;
    bot.inventoryItems = [
      { name: "iron_ore", type: 15, count: 1 },
      { name: "coal", type: 263, count: 1 },
    ];
    bot.findBlock.mockReturnValue({ position: { x: 1, y: 64, z: 1 } });
    bot.openFurnace.mockImplementation(
      () =>
        new Promise<FakeFurnace>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    const openingController = new AbortController();
    const opening = adapter.smeltItem("iron_ore", 1, openingController.signal);
    await flush();
    openingController.abort();
    resolveOpen?.(openingFurnace);
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(openingFurnace.close).toHaveBeenCalled();
    expect(openingFurnace.putInput).not.toHaveBeenCalled();
    await adapter.disconnect();

    const inputBot = new FakeBot();
    inputBot.inventoryItems = [
      { name: "iron_ore", type: 15, count: 1 },
      { name: "coal", type: 263, count: 1 },
    ];
    inputBot.findBlock.mockReturnValue({ position: { x: 1, y: 64, z: 1 } });
    const inputFurnace = new FakeFurnace();
    let resolveInput: (() => void) | undefined;
    inputFurnace.putInput.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInput = resolve;
        }),
    );
    inputBot.openFurnace.mockResolvedValue(inputFurnace);
    createBot.mockReturnValue(inputBot);
    const inputAdapter = new MineflayerAdapter(config());
    const inputConnecting = inputAdapter.connect();
    await flush();
    inputBot.emit("spawn");
    await inputConnecting;
    const inputController = new AbortController();
    const inputting = inputAdapter.smeltItem("iron_ore", 1, inputController.signal);
    await flush();
    await flush();
    await flush();
    inputController.abort();
    expect(inputFurnace.close).toHaveBeenCalled();
    resolveInput?.();
    await expect(inputting).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(inputFurnace.putFuel).not.toHaveBeenCalled();
    await inputAdapter.disconnect();
  });

  it("closes a furnace during fuel and output-wait aborts", async () => {
    const bot = new FakeBot();
    bot.inventoryItems = [
      { name: "iron_ore", type: 15, count: 1 },
      { name: "coal", type: 263, count: 1 },
    ];
    bot.findBlock.mockReturnValue({ position: { x: 1, y: 64, z: 1 } });
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;

    const fuelFurnace = new FakeFurnace();
    let resolveFuel: (() => void) | undefined;
    fuelFurnace.putFuel.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFuel = resolve;
        }),
    );
    bot.openFurnace.mockResolvedValue(fuelFurnace);
    const fuelController = new AbortController();
    const fueling = adapter.smeltItem("iron_ore", 1, fuelController.signal);
    await flush();
    await flush();
    await flush();
    fuelController.abort();
    expect(fuelFurnace.close).toHaveBeenCalled();
    resolveFuel?.();
    await expect(fueling).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    await adapter.disconnect();

    const waitingBot = new FakeBot();
    waitingBot.inventoryItems = [
      { name: "iron_ore", type: 15, count: 1 },
      { name: "coal", type: 263, count: 1 },
    ];
    waitingBot.findBlock.mockReturnValue({ position: { x: 1, y: 64, z: 1 } });
    const waitingFurnace = new FakeFurnace();
    let resolveTick: (() => void) | undefined;
    waitingBot.waitForTicks.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        }),
    );
    waitingBot.openFurnace.mockResolvedValue(waitingFurnace);
    createBot.mockReturnValue(waitingBot);
    const waitingAdapter = new MineflayerAdapter(config());
    const waitingConnecting = waitingAdapter.connect();
    await flush();
    waitingBot.emit("spawn");
    await waitingConnecting;
    const waitingController = new AbortController();
    const smelting = waitingAdapter.smeltItem("iron_ore", 1, waitingController.signal);
    await flush();
    await flush();
    await flush();
    waitingController.abort();
    expect(waitingFurnace.close).toHaveBeenCalled();
    resolveTick?.();
    await expect(smelting).rejects.toMatchObject({ name: "AbortError" });
    await waitingAdapter.disconnect();
  });

  it("settles a disconnected primitive once even when its abort cleanup throws", async () => {
    const bot = new FakeBot();
    bot.inventoryItems = [
      { name: "iron_ore", type: 15, count: 1 },
      { name: "coal", type: 263, count: 1 },
    ];
    bot.findBlock.mockReturnValue({ position: { x: 1, y: 64, z: 1 } });
    const furnace = new FakeFurnace();
    furnace.close.mockImplementation(() => {
      throw new Error("window cleanup failed");
    });
    let resolveInput: (() => void) | undefined;
    furnace.putInput.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInput = resolve;
        }),
    );
    bot.openFurnace.mockResolvedValue(furnace);
    createBot.mockReturnValue(bot);
    const adapter = new MineflayerAdapter(config());
    const connecting = adapter.connect();
    await flush();
    bot.emit("spawn");
    await connecting;
    const smelting = adapter.smeltItem("iron_ore", 1, new AbortController().signal);
    await vi.waitFor(() => expect(resolveInput).toBeTypeOf("function"));
    let outcome = "pending";
    let settlements = 0;
    void smelting.then(
      () => {
        outcome = "resolved";
        settlements += 1;
      },
      () => {
        outcome = "aborted";
        settlements += 1;
      },
    );

    await adapter.disconnect();
    await vi.waitFor(() => expect(outcome).toBe("aborted"), { timeout: 100 });
    expect(furnace.close).toHaveBeenCalledOnce();
    expect(bot.end).toHaveBeenCalledOnce();
    expect(settlements).toBe(1);

    resolveInput?.();
    await expect(smelting).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    expect(furnace.close).toHaveBeenCalledOnce();
    expect(settlements).toBe(1);
  });

  it("retries exactly five times at capped delays and disconnect cancels a pending retry", async () => {
    vi.useFakeTimers();
    const bots = Array.from({ length: 6 }, () => new FakeBot());
    for (const bot of bots) createBot.mockReturnValueOnce(bot);
    const adapter = new MineflayerAdapter(config());
    const events: string[] = [];
    adapter.onEvent((event) => events.push(event.kind));
    const connected = adapter.connect();
    await flush();
    bots[0]?.emit("spawn");
    await connected;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      bots[attempt]?.emit("end", "lost");
      await vi.advanceTimersByTimeAsync([1000, 2000, 4000, 8000, 15000][attempt] ?? 0);
    }
    bots[5]?.emit("end", "lost");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(createBot).toHaveBeenCalledTimes(6);
    expect(events.filter((event) => event === "disconnected")).toHaveLength(1);

    createBot.mockClear();
    const cancellingBot = new FakeBot();
    createBot.mockReturnValue(cancellingBot);
    const cancelling = new MineflayerAdapter(config());
    const cancelled = cancelling.connect();
    await flush();
    cancellingBot.emit("end", "lost");
    await cancelling.disconnect();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(createBot).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("pinned Mineflayer loader logging boundary", () => {
  it("does not call console.log for an owned bot error when logErrors is false", async () => {
    const mineflayer = await vi.importActual<typeof import("mineflayer")>("mineflayer");
    const client = Object.assign(new EventEmitter(), {
      wait_connect: true,
      end: vi.fn(),
    });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const bot = mineflayer.createBot({
        username: "WhiteLily",
        auth: "offline",
        client: client as never,
        loadInternalPlugins: false,
        hideErrors: false,
        logErrors: false,
      });
      const ownedError = vi.fn();
      bot.on("error", ownedError);

      expect(() => client.emit("error", new Error("private stack"))).not.toThrow();

      expect(ownedError).toHaveBeenCalledOnce();
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
    }
  });
});
