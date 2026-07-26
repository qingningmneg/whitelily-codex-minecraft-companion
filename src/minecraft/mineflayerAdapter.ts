import { createBot, type Bot, type Furnace } from "mineflayer";
import pathfinderPackage from "mineflayer-pathfinder";
import { Vec3 as PrismarineVec3 } from "vec3";
import type { Vec3, WorldSnapshot } from "../domain/types.js";
import type { MinecraftEvent, MinecraftPort } from "./minecraftPort.js";

const { goals, pathfinder } = pathfinderPackage;

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const MAX_SNAPSHOT_ENTITIES = 64;
const MAX_INVENTORY_ITEMS = 36;
const MAX_SMELT_WAIT_TICKS = 20 * 60;
const MAX_KNOWN_HOSTILES = 64;
const HOSTILE_PROXIMITY_RADIUS_SQUARED = 16 ** 2;
const FUEL_OUTPUT_CAPACITY: Readonly<Record<string, number>> = {
  coal: 8,
  charcoal: 8,
};

export interface MineflayerAdapterConfig {
  host: "127.0.0.1";
  port: number;
  botUsername: "WhiteLily";
  ownerUsername: string;
}

interface BotHandlers {
  chat: (username: string, message: string) => void;
  playerJoined: (player: { username: string }) => void;
  playerLeft: (player: { username: string }) => void;
  spawn: () => void;
  death: () => void;
  end: (reason: string) => void;
  entitySpawn: (entity: Bot["entity"]) => void;
  entityMoved: (entity: Bot["entity"]) => void;
  entityGone: (entity: Bot["entity"]) => void;
  move: () => void;
  forcedMove: () => void;
  spawnPosition: (packet: unknown) => void;
}

function abortError(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

function toVec3(position: { x: number; y: number; z: number }): Vec3 {
  return { x: position.x, y: position.y, z: position.z };
}

function minecraftVec3(position: Vec3): PrismarineVec3 {
  return new PrismarineVec3(position.x, position.y, position.z);
}

function isHostile(entity: { type: string; name?: string }): boolean {
  return entity.type === "hostile";
}

function isDroppedItem(entity: { type: string; name?: string }): boolean {
  return entity.type === "other" && entity.name === "item";
}

function distanceSquared(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2;
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

function packetSpawnPosition(bot: Bot, packet: unknown): Vec3 | undefined {
  if (packet === null || typeof packet !== "object") return undefined;
  const record = packet as Record<string, unknown>;
  const candidate = bot.supportFeature("spawnPositionIsGlobal")
    ? (record.globalPos as { location?: unknown } | undefined)?.location
    : record.location;
  if (candidate === null || typeof candidate !== "object") return undefined;
  const position = candidate as Record<string, unknown>;
  return typeof position.x === "number" &&
    Number.isFinite(position.x) &&
    typeof position.y === "number" &&
    Number.isFinite(position.y) &&
    typeof position.z === "number" &&
    Number.isFinite(position.z)
    ? { x: position.x, y: position.y, z: position.z }
    : undefined;
}

export class MineflayerAdapter implements MinecraftPort {
  private bot: Bot | undefined;
  private botHandlers: BotHandlers | undefined;
  private readonly listeners = new Set<(event: MinecraftEvent) => void>();
  private readonly activeAborts = new Set<() => void>();
  private readonly hostileEntityIds = new Set<number>();
  private readonly droppedItemEntityIds = new Set<number>();
  private readonly knownHostileEntities = new Map<number, Bot["entity"]>();
  private readonly nearbyHostileEntityIds = new Set<number>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryIndex = 0;
  private explicitlyDisconnected = false;
  private outageNotified = false;
  private connected = false;
  private recovering = false;
  private retriesExhausted = false;
  private connectionPromise: Promise<void> | undefined;
  private resolveConnection: (() => void) | undefined;
  private rejectConnection: ((error: Error) => void) | undefined;
  private worldSpawn: Vec3 | undefined;

  constructor(private readonly config: MineflayerAdapterConfig) {}

  connect(): Promise<void> {
    if (this.explicitlyDisconnected || this.retriesExhausted) {
      return Promise.reject(new Error("adapter is stopped; create a new adapter to restart"));
    }
    if (this.connected && this.bot) return Promise.resolve();
    if (this.connectionPromise) return this.connectionPromise;

    const waiting = this.createConnectionPromise();
    if (!this.recovering) this.startAttempt();
    return waiting;
  }

  async disconnect(): Promise<void> {
    this.explicitlyDisconnected = true;
    this.clearRetryTimer();
    this.stopActiveOperations();
    this.clearSnapshotAuthorizations();
    this.clearHostileProximity();
    this.rejectConnection?.(abortError());
    this.resolveConnection = undefined;
    this.rejectConnection = undefined;
    this.connectionPromise = undefined;
    this.recovering = false;

    const bot = this.bot;
    if (bot) {
      this.detach(bot);
      this.bot = undefined;
      this.safelyEndBot(bot, "adapter disconnect");
    }
    if (this.connected && !this.outageNotified) {
      this.emit({ kind: "disconnected", reason: "adapter disconnect" });
    }
    this.connected = false;
  }

  onEvent(listener: (event: MinecraftEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async isOwnerOnline(username: string): Promise<boolean> {
    return this.requireBot().players[username]?.entity !== undefined;
  }

  async snapshot(ownerUsername: string): Promise<WorldSnapshot> {
    const bot = this.requireBot();
    const entities = Object.values(bot.entities)
      .sort(
        (left, right) =>
          distanceSquared(left.position, bot.entity.position) -
          distanceSquared(right.position, bot.entity.position),
      )
      .slice(0, MAX_SNAPSHOT_ENTITIES);
    const hostiles = entities.filter(isHostile);
    const drops = entities.filter(isDroppedItem);
    this.hostileEntityIds.clear();
    this.droppedItemEntityIds.clear();
    for (const entity of hostiles) this.hostileEntityIds.add(entity.id);
    for (const entity of drops) this.droppedItemEntityIds.add(entity.id);

    const ownerPosition = bot.players[ownerUsername]?.entity?.position;
    return {
      botPosition: toVec3(bot.entity.position),
      ...(this.worldSpawn ? { worldSpawn: structuredClone(this.worldSpawn) } : {}),
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
        kind: entity.name ?? entity.type,
        position: toVec3(entity.position),
      })),
    };
  }

  async findBlock(blockName: string, maxDistance: number): Promise<Vec3 | null> {
    const bot = this.requireBot();
    const block = this.requireBlock(bot, blockName);
    const radius = Math.max(0, Math.min(64, Math.floor(maxDistance)));
    const found = bot.findBlock({ matching: block.id, maxDistance: radius });
    return found ? toVec3(found.position) : null;
  }

  async say(message: string): Promise<void> {
    if (message.trimStart().startsWith("/")) {
      throw new Error("Minecraft commands are not permitted");
    }
    this.requireBot().chat(message);
  }

  async moveTo(position: Vec3, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const bot = this.requireBot();
    await this.abortable(signal, () =>
      bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 1)),
    );
  }

  async followOwner(username: string, distance: number, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const bot = this.requireBot();
    const entity = bot.players[username]?.entity;
    if (!entity) throw new Error(`owner ${username} is not online`);
    await this.abortable(signal, () => bot.pathfinder.goto(new goals.GoalFollow(entity, distance)));
  }

  async lookAt(position: Vec3, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const bot = this.requireBot();
    await this.abortable(signal, () => bot.lookAt(minecraftVec3(position)));
  }

  async jump(signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const bot = this.requireBot();
    await this.abortable(signal, async () => {
      bot.setControlState("jump", true);
      try {
        await bot.waitForTicks(1);
      } finally {
        bot.setControlState("jump", false);
      }
    });
  }

  async digBlock(position: Vec3, expectedBlockName: string, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const bot = this.requireBot();
    this.requireBlock(bot, expectedBlockName);
    const block = bot.blockAt(minecraftVec3(position));
    if (!block || block.name !== expectedBlockName) {
      throw new Error("block at position does not match expected block name");
    }
    await this.abortable(signal, () => bot.dig(block));
  }

  async placeBlock(position: Vec3, blockName: string, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    this.assertSafeItem(blockName);
    const bot = this.requireBot();
    this.requireBlock(bot, blockName);
    const item = this.requireItem(bot, blockName);
    const held = bot.inventory.items().find((candidate) => candidate.name === item.name);
    if (!held) throw new Error(`missing ${blockName} in inventory`);
    const reference = bot.blockAt(
      minecraftVec3({ x: position.x, y: position.y - 1, z: position.z }),
    );
    if (!reference) throw new Error("no supporting block at placement position");
    await this.abortable(signal, async () => {
      await bot.equip(held, "hand");
      this.assertNotAborted(signal);
      await bot.placeBlock(reference, new PrismarineVec3(0, 1, 0));
    });
  }

  async craftItem(itemName: string, count: number, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const bot = this.requireBot();
    const item = this.requireItem(bot, itemName);
    const recipe = bot.recipesFor(item.id, null, 1, null)[0];
    if (!recipe) throw new Error(`no craftable recipe for ${itemName}`);
    await this.abortable(signal, () => bot.craft(recipe, count));
  }

  async smeltItem(itemName: string, count: number, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("smelt count must be positive");
    const bot = this.requireBot();
    const item = this.requireItem(bot, itemName);
    const input = bot.inventory
      .items()
      .find((candidate) => candidate.name === item.name && candidate.count >= count);
    if (!input) throw new Error(`missing ${itemName} in inventory`);
    const fuel = this.findFuel(bot, count);
    const furnace = bot.findBlock({
      matching: this.requireBlock(bot, "furnace").id,
      maxDistance: 16,
    });
    if (!furnace) throw new Error("no nearby furnace");
    let window: Furnace | undefined;
    let closed = false;
    const closeWindow = () => {
      if (!window || closed) return;
      closed = true;
      window.close();
    };
    await this.abortable(
      signal,
      async () => {
        window = await bot.openFurnace(furnace);
        try {
          this.assertNotAborted(signal);
          if (window.inputItem() || window.outputItem() || window.fuelItem()) {
            throw new Error("furnace must be empty before smelting");
          }
          await window.putInput(input.type, null, count);
          this.assertNotAborted(signal);
          await window.putFuel(fuel.type, null, fuel.count);
          this.assertNotAborted(signal);
          for (let tick = 0; tick < MAX_SMELT_WAIT_TICKS; tick += 1) {
            const output = window.outputItem();
            if (output && output.count >= count) {
              await window.takeOutput();
              return;
            }
            await bot.waitForTicks(1);
            this.assertNotAborted(signal);
          }
          throw new Error("smelting timed out");
        } finally {
          closeWindow();
        }
      },
      closeWindow,
    );
  }

  async collectDropped(entityId: number, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const bot = this.requireBot();
    if (!this.droppedItemEntityIds.has(entityId)) {
      throw new Error("dropped entity ID was not authorized by the latest snapshot");
    }
    const entity = bot.entities[String(entityId)];
    if (!entity || !isDroppedItem(entity)) throw new Error("dropped item is no longer available");
    await this.abortable(signal, () =>
      bot.pathfinder.goto(
        new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 1),
      ),
    );
  }

  async equipItem(
    itemName: string,
    destination: "hand" | "head" | "torso" | "legs" | "feet",
    signal: AbortSignal,
  ): Promise<void> {
    this.assertNotAborted(signal);
    this.assertSafeItem(itemName);
    const bot = this.requireBot();
    const item = this.requireItem(bot, itemName);
    const held = bot.inventory.items().find((candidate) => candidate.name === item.name);
    if (!held) throw new Error(`missing ${itemName} in inventory`);
    await this.abortable(signal, () => bot.equip(held, destination));
  }

  async attackHostile(entityId: number, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const bot = this.requireBot();
    if (!this.hostileEntityIds.has(entityId)) {
      throw new Error("hostile entity ID was not authorized by the latest snapshot");
    }
    const entity = bot.entities[String(entityId)];
    if (!entity || !isHostile(entity)) throw new Error("hostile is no longer available");
    await this.abortable(signal, () => {
      bot.attack(entity);
    });
  }

  async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;
      let stop: () => void;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.activeAborts.delete(stop);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => done(abortError());
      stop = () => onAbort();
      timer = setTimeout(done, Math.max(0, milliseconds));
      this.activeAborts.add(stop);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private startAttempt(): void {
    if (this.explicitlyDisconnected || this.retriesExhausted || this.bot) return;
    try {
      const bot = createBot({
        host: "127.0.0.1",
        port: this.config.port,
        username: this.config.botUsername,
        auth: "offline",
        hideErrors: false,
      });
      this.bot = bot;
      bot.loadPlugin(pathfinder);
      this.attach(bot);
    } catch (error) {
      if (this.bot) this.cleanupPartialBot(this.bot);
      this.handleConnectionEnd(undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private attach(bot: Bot): void {
    const handlers: BotHandlers = {
      chat: (username, message) => this.emit({ kind: "chat", username, message }),
      playerJoined: (player) => this.emit({ kind: "owner_online", username: player.username }),
      playerLeft: (player) => this.emit({ kind: "owner_offline", username: player.username }),
      spawn: () => this.handleSpawn(bot),
      death: () => this.emit({ kind: "death" }),
      end: (reason) => this.handleConnectionEnd(bot, reason),
      entitySpawn: (entity) => this.observeHostile(bot, entity),
      entityMoved: (entity) => this.observeHostile(bot, entity),
      entityGone: (entity) => {
        if (this.bot === bot) this.forgetHostile(entity.id);
      },
      move: () => this.reevaluateKnownHostiles(bot),
      forcedMove: () => this.reevaluateKnownHostiles(bot),
      spawnPosition: (packet) => {
        if (this.bot !== bot) return;
        const position = packetSpawnPosition(bot, packet);
        if (position) this.worldSpawn = position;
      },
    };
    this.botHandlers = handlers;
    bot.on("chat", handlers.chat);
    bot.on("playerJoined", handlers.playerJoined);
    bot.on("playerLeft", handlers.playerLeft);
    bot.once("spawn", handlers.spawn);
    bot.on("death", handlers.death);
    bot.once("end", handlers.end);
    bot.on("entitySpawn", handlers.entitySpawn);
    bot.on("entityMoved", handlers.entityMoved);
    bot.on("entityGone", handlers.entityGone);
    bot.on("move", handlers.move);
    bot.on("forcedMove", handlers.forcedMove);
    bot._client.on("spawn_position", handlers.spawnPosition);
  }

  private detach(bot: Bot): void {
    const handlers = this.botHandlers;
    if (!handlers) return;
    this.tryCleanup(() => bot.removeListener("chat", handlers.chat));
    this.tryCleanup(() => bot.removeListener("playerJoined", handlers.playerJoined));
    this.tryCleanup(() => bot.removeListener("playerLeft", handlers.playerLeft));
    this.tryCleanup(() => bot.removeListener("spawn", handlers.spawn));
    this.tryCleanup(() => bot.removeListener("death", handlers.death));
    this.tryCleanup(() => bot.removeListener("end", handlers.end));
    this.tryCleanup(() => bot.removeListener("entitySpawn", handlers.entitySpawn));
    this.tryCleanup(() => bot.removeListener("entityMoved", handlers.entityMoved));
    this.tryCleanup(() => bot.removeListener("entityGone", handlers.entityGone));
    this.tryCleanup(() => bot.removeListener("move", handlers.move));
    this.tryCleanup(() => bot.removeListener("forcedMove", handlers.forcedMove));
    this.tryCleanup(() => bot._client.removeListener("spawn_position", handlers.spawnPosition));
    this.botHandlers = undefined;
  }

  private cleanupPartialBot(bot: Bot): void {
    this.detach(bot);
    this.clearHostileProximity();
    if (this.bot === bot) this.bot = undefined;
    this.safelyStopBot(bot);
    this.safelyEndBot(bot, "adapter setup failed");
  }

  private handleSpawn(bot: Bot): void {
    if (this.bot !== bot || this.explicitlyDisconnected || this.connected) return;
    this.clearRetryTimer();
    this.connected = true;
    this.recovering = false;
    this.outageNotified = false;
    this.retryIndex = 0;
    this.emit({ kind: "connected" });
    this.resolveConnection?.();
    this.resolveConnection = undefined;
    this.rejectConnection = undefined;
    this.connectionPromise = undefined;
  }

  private handleConnectionEnd(bot: Bot | undefined, reason: string): void {
    if (bot && this.bot !== bot) return;
    if (bot) this.detach(bot);
    if (this.bot === bot) this.bot = undefined;
    this.stopActiveOperations();
    this.clearSnapshotAuthorizations();
    this.clearHostileProximity();
    this.connected = false;
    if (this.explicitlyDisconnected) return;
    this.recovering = true;
    if (!this.outageNotified) {
      this.outageNotified = true;
      this.emit({ kind: "disconnected", reason });
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    const delay = RETRY_DELAYS_MS[this.retryIndex];
    if (delay === undefined) {
      this.retriesExhausted = true;
      this.recovering = false;
      this.rejectConnection?.(new Error("Minecraft connection retries exhausted"));
      this.resolveConnection = undefined;
      this.rejectConnection = undefined;
      this.connectionPromise = undefined;
      return;
    }
    if (this.explicitlyDisconnected || this.retriesExhausted) return;
    this.retryIndex += 1;
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.startAttempt();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private tryCleanup(operation: () => void): void {
    try {
      operation();
    } catch {
      // Listener cleanup is best effort during a failed setup.
    }
  }

  private createConnectionPromise(): Promise<void> {
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnection = resolve;
      this.rejectConnection = reject;
    });
    return this.connectionPromise;
  }

  private emit(event: MinecraftEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private requireBot(): Bot {
    if (!this.bot) throw new Error("Minecraft bot is not connected");
    return this.bot;
  }

  private requireBlock(bot: Bot, name: string) {
    const block = bot.registry.blocksByName[name];
    if (!block) throw new Error(`unknown block: ${name}`);
    return block;
  }

  private requireItem(bot: Bot, name: string) {
    const item = bot.registry.itemsByName[name];
    if (!item) throw new Error(`unknown item: ${name}`);
    return item;
  }

  private findFuel(bot: Bot, outputCount: number) {
    for (const item of bot.inventory.items()) {
      const capacity = FUEL_OUTPUT_CAPACITY[item.name];
      if (!capacity) continue;
      const required = Math.ceil(outputCount / capacity);
      if (item.count >= required) return { type: item.type, count: required };
    }
    throw new Error("missing supported fuel for smelting");
  }

  private clearSnapshotAuthorizations(): void {
    this.hostileEntityIds.clear();
    this.droppedItemEntityIds.clear();
    this.worldSpawn = undefined;
  }

  private clearHostileProximity(): void {
    this.knownHostileEntities.clear();
    this.nearbyHostileEntityIds.clear();
  }

  private observeHostile(bot: Bot, entity: Bot["entity"]): void {
    if (this.bot !== bot) return;
    if (!isHostile(entity)) {
      this.forgetHostile(entity.id);
      return;
    }
    if (!this.knownHostileEntities.has(entity.id)) {
      if (this.knownHostileEntities.size >= MAX_KNOWN_HOSTILES) {
        const farthest = this.farthestKnownHostile(bot);
        if (
          !farthest ||
          distanceSquared(entity.position, bot.entity.position) >= farthest.distanceSquared
        ) {
          return;
        }
        this.forgetHostile(farthest.entityId);
      }
    }
    this.knownHostileEntities.set(entity.id, entity);
    this.updateTrackedHostileProximity(bot, entity);
  }

  private reevaluateKnownHostiles(bot: Bot): void {
    if (this.bot !== bot) return;
    for (const entity of [...this.knownHostileEntities.values()]) {
      if (!isHostile(entity)) {
        this.forgetHostile(entity.id);
        continue;
      }
      this.updateTrackedHostileProximity(bot, entity);
    }
  }

  private updateTrackedHostileProximity(bot: Bot, entity: Bot["entity"]): void {
    const nearby =
      distanceSquared(entity.position, bot.entity.position) <= HOSTILE_PROXIMITY_RADIUS_SQUARED;
    if (!nearby) {
      this.nearbyHostileEntityIds.delete(entity.id);
      return;
    }
    if (this.nearbyHostileEntityIds.has(entity.id)) return;
    this.nearbyHostileEntityIds.add(entity.id);
    this.emit({
      kind: "hostile_nearby",
      entityId: entity.id,
      entityKind: entity.name ?? entity.type,
      position: toVec3(entity.position),
    });
  }

  private farthestKnownHostile(
    bot: Bot,
  ): { entityId: number; distanceSquared: number } | undefined {
    let farthest: { entityId: number; distanceSquared: number } | undefined;
    for (const entity of this.knownHostileEntities.values()) {
      const candidateDistance = distanceSquared(entity.position, bot.entity.position);
      if (!farthest || candidateDistance > farthest.distanceSquared) {
        farthest = { entityId: entity.id, distanceSquared: candidateDistance };
      }
    }
    return farthest;
  }

  private forgetHostile(entityId: number): void {
    this.knownHostileEntities.delete(entityId);
    this.nearbyHostileEntityIds.delete(entityId);
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortError();
  }

  private assertSafeItem(name: string): void {
    if (permanentlyDangerousItems.has(canonicalMinecraftName(name))) {
      throw new Error("dangerous item is permanently forbidden");
    }
  }

  private stopActiveOperations(): void {
    this.safelyStopBot(this.bot);
    for (const abort of this.activeAborts) abort();
    this.activeAborts.clear();
  }

  private async abortable(
    signal: AbortSignal,
    operation: () => Promise<void> | void,
    abortCleanup?: () => void,
  ): Promise<void> {
    if (signal.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let started = false;
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        this.stopMotion();
        abortCleanup?.();
        if (!started) finish(abortError());
      };
      const cancel = () => onAbort();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.activeAborts.delete(cancel);
        if (error) reject(error);
        else resolve();
      };

      this.activeAborts.add(cancel);
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => {
          this.assertNotAborted(signal);
          started = true;
          return operation();
        })
        .then(() => finish(aborted ? abortError() : undefined))
        .catch((error: unknown) =>
          finish(
            aborted ? abortError() : error instanceof Error ? error : new Error(String(error)),
          ),
        );
    });
  }

  private stopMotion(): void {
    this.safelyStopBot(this.bot);
  }

  private safelyStopBot(bot: Bot | undefined): void {
    try {
      bot?.pathfinder?.stop();
    } catch {
      // A partial Mineflayer bot may not have installed pathfinder yet.
    }
    try {
      bot?.clearControlStates?.();
    } catch {
      // Control state cleanup is best effort during failure paths.
    }
  }

  private safelyEndBot(bot: Bot, reason: string): void {
    this.tryCleanup(() => bot.end(reason));
  }
}
