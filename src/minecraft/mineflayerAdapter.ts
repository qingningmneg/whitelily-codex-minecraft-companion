import { createBot, type Bot, type Furnace } from "mineflayer";
import pathfinderPackage from "mineflayer-pathfinder";
import { Vec3 as PrismarineVec3 } from "vec3";
import type { GameAction, Vec3, WorldSnapshot } from "../domain/types.js";
import { classifyActionRisk } from "../safety/actionRisk.js";
import { createBridgeProofIssuer, type BridgeProofIssuer } from "./bridgeProofIssuer.js";
import {
  MineflayerConnection,
  type MineflayerConnectionEvent,
  type MineflayerSession,
} from "./mineflayerConnection.js";
import { createWorldSnapshot, selectSnapshotEntities } from "./mineflayerObservation.js";
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

const { goals, pathfinder } = pathfinderPackage;

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const MAX_SMELT_WAIT_TICKS = 20 * 60;
const OPERATION_CANCEL_TIMEOUT_MS = 1_000;
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
  dataRoot: string;
}

function abortError(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
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
  private readonly connection: MineflayerConnection;
  private readonly proofIssuer: BridgeProofIssuer;
  private readonly listeners = new Set<(event: MinecraftEvent) => void>();
  private readonly hostileEntityIds = new Set<number>();
  private readonly droppedItemEntityIds = new Set<number>();
  private readonly knownHostileEntities = new Map<number, Bot["entity"]>();
  private readonly nearbyHostileEntityIds = new Set<number>();
  private worldSpawn: Vec3 | undefined;

  constructor(config: MineflayerAdapterConfig) {
    this.proofIssuer = createBridgeProofIssuer({ dataRoot: config.dataRoot });
    this.connection = new MineflayerConnection({
      config: {
        host: config.host,
        port: config.port,
        botUsername: config.botUsername,
      },
      prepareAttempt: (port) => this.proofIssuer.issue(port),
      createBot,
      plugin: pathfinder,
      retryDelaysMs: RETRY_DELAYS_MS,
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    this.connection.onEvent((event) => this.handleConnectionEvent(event));
  }

  connect(): Promise<void> {
    return this.connection.connect();
  }

  async disconnect(): Promise<void> {
    try {
      await this.connection.disconnect();
    } finally {
      await this.proofIssuer.close();
    }
  }

  onEvent(listener: (event: MinecraftEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async isOwnerOnline(username: string): Promise<boolean> {
    return this.requireBot().players[username] !== undefined;
  }

  async snapshot(ownerUsername: string): Promise<WorldSnapshot> {
    const bot = this.requireBot();
    const entities = selectSnapshotEntities(bot);
    const hostiles = entities.filter(isHostile);
    const drops = entities.filter(isDroppedItem);
    this.hostileEntityIds.clear();
    this.droppedItemEntityIds.clear();
    for (const entity of hostiles) this.hostileEntityIds.add(entity.id);
    for (const entity of drops) this.droppedItemEntityIds.add(entity.id);

    return createWorldSnapshot(bot, ownerUsername, {
      ...(this.worldSpawn ? { worldSpawn: this.worldSpawn } : {}),
      hostileEntityIds: this.hostileEntityIds,
      droppedItemEntityIds: this.droppedItemEntityIds,
    });
  }

  async findBlock(blockName: string, maxDistance: number): Promise<Vec3 | null> {
    const bot = this.requireBot();
    const block = this.requireBlock(bot, blockName);
    const radius = Math.max(0, Math.min(64, Math.floor(maxDistance)));
    const found = bot.findBlock({ matching: block.id, maxDistance: radius });
    return found ? toVec3(found.position) : null;
  }

  async inspectBlock(_position: Vec3): Promise<InspectedBlock | null> {
    throw new Error("living action is not implemented");
  }

  async findBlocks(_query: BlockSearchQuery): Promise<BlockSearchResult> {
    throw new Error("living action is not implemented");
  }

  async furnaceSnapshot(_position: Vec3): Promise<FurnaceSnapshot> {
    throw new Error("living action is not implemented");
  }

  async say(message: string): Promise<void> {
    if (message.trimStart().startsWith("/")) {
      throw new Error("Minecraft commands are not permitted");
    }
    this.requireBot().chat(message);
  }

  async moveTo(position: Vec3, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const session = this.requireSession();
    await this.abortable(signal, session, "motion", () =>
      session.bot.pathfinder.goto(new goals.GoalNear(position.x, position.y, position.z, 1)),
    );
  }

  async followOwner(username: string, distance: number, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const session = this.requireSession();
    const bot = session.bot;
    const entity = bot.players[username]?.entity;
    if (!entity) throw new Error(`owner ${username} is not online`);
    await this.abortable(signal, session, "motion", () =>
      bot.pathfinder.goto(new goals.GoalFollow(entity, distance)),
    );
  }

  async lookAt(position: Vec3, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const session = this.requireSession();
    await this.abortable(signal, session, "fence", () =>
      session.bot.lookAt(minecraftVec3(position)),
    );
  }

  async jump(signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const session = this.requireSession();
    const bot = session.bot;
    await this.abortable(signal, session, "motion", async () => {
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
    const session = this.requireSession();
    const bot = session.bot;
    this.requireBlock(bot, expectedBlockName);
    const block = bot.blockAt(minecraftVec3(position));
    if (!block || block.name !== expectedBlockName) {
      throw new Error("block at position does not match expected block name");
    }
    await this.abortable(signal, session, "dig", () => bot.dig(block));
  }

  async placeBlock(position: Vec3, blockName: string, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    this.assertSafeAction({ kind: "place_block", position, blockName });
    const session = this.requireSession();
    const bot = session.bot;
    this.requireBlock(bot, blockName);
    const item = this.requireItem(bot, blockName);
    const held = bot.inventory.items().find((candidate) => candidate.name === item.name);
    if (!held) throw new Error(`missing ${blockName} in inventory`);
    const reference = bot.blockAt(
      minecraftVec3({ x: position.x, y: position.y - 1, z: position.z }),
    );
    if (!reference) throw new Error("no supporting block at placement position");
    await this.abortable(signal, session, "fence", async () => {
      await bot.equip(held, "hand");
      this.assertActive(session, signal);
      await bot.placeBlock(reference, new PrismarineVec3(0, 1, 0));
    });
  }

  async craftItem(itemName: string, count: number, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const session = this.requireSession();
    const bot = session.bot;
    const item = this.requireItem(bot, itemName);
    const recipe = bot.recipesFor(item.id, null, 1, null)[0];
    if (!recipe) throw new Error(`no craftable recipe for ${itemName}`);
    await this.abortable(signal, session, "fence", () => bot.craft(recipe, count));
  }

  async smeltItem(itemName: string, count: number, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("smelt count must be positive");
    const session = this.requireSession();
    const bot = session.bot;
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
      session,
      "fence",
      async () => {
        window = await bot.openFurnace(furnace);
        try {
          this.assertActive(session, signal);
          if (window.inputItem() || window.outputItem() || window.fuelItem()) {
            throw new Error("furnace must be empty before smelting");
          }
          await window.putInput(input.type, null, count);
          this.assertActive(session, signal);
          await window.putFuel(fuel.type, null, fuel.count);
          this.assertActive(session, signal);
          for (let tick = 0; tick < MAX_SMELT_WAIT_TICKS; tick += 1) {
            const output = window.outputItem();
            if (output && output.count >= count) {
              await window.takeOutput();
              return;
            }
            await bot.waitForTicks(1);
            this.assertActive(session, signal);
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
    const session = this.requireSession();
    const bot = session.bot;
    if (!this.droppedItemEntityIds.has(entityId)) {
      throw new Error("dropped entity ID was not authorized by the latest snapshot");
    }
    const entity = bot.entities[String(entityId)];
    if (!entity || !isDroppedItem(entity)) throw new Error("dropped item is no longer available");
    await this.abortable(signal, session, "motion", () =>
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
    this.assertSafeAction({ kind: "equip_item", itemName, destination });
    const session = this.requireSession();
    const bot = session.bot;
    const item = this.requireItem(bot, itemName);
    const held = bot.inventory.items().find((candidate) => candidate.name === item.name);
    if (!held) throw new Error(`missing ${itemName} in inventory`);
    await this.abortable(signal, session, "fence", () => bot.equip(held, destination));
  }

  async attackHostile(entityId: number, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    const session = this.requireSession();
    const bot = session.bot;
    if (!this.hostileEntityIds.has(entityId)) {
      throw new Error("hostile entity ID was not authorized by the latest snapshot");
    }
    const entity = bot.entities[String(entityId)];
    if (!entity || !isHostile(entity)) throw new Error("hostile is no longer available");
    await this.abortable(signal, session, "fence", () => {
      bot.attack(entity);
    });
  }

  async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    this.assertNotAborted(signal);
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;
      let stop: () => void;
      let unregister: () => void = () => undefined;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        unregister();
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => done(abortError());
      stop = () => onAbort();
      timer = setTimeout(done, Math.max(0, milliseconds));
      unregister = this.connection.registerActiveOperation(stop);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async fish(_signal: AbortSignal): Promise<InventoryDelta> {
    throw new Error("living action is not implemented");
  }

  async consumeItem(_itemName: string, _signal: AbortSignal): Promise<FoodDelta> {
    throw new Error("living action is not implemented");
  }

  async sleepInBed(_position: Vec3, _signal: AbortSignal): Promise<void> {
    throw new Error("living action is not implemented");
  }

  async wakeUp(_signal: AbortSignal): Promise<void> {
    throw new Error("living action is not implemented");
  }

  async tillSoil(_position: Vec3, _signal: AbortSignal): Promise<void> {
    throw new Error("living action is not implemented");
  }

  async plantCrop(_position: Vec3, _seedName: "wheat_seeds", _signal: AbortSignal): Promise<void> {
    throw new Error("living action is not implemented");
  }

  async harvestCrop(_position: Vec3, _cropName: "wheat", _signal: AbortSignal): Promise<void> {
    throw new Error("living action is not implemented");
  }

  private handleConnectionEvent(event: MineflayerConnectionEvent): void {
    switch (event.kind) {
      case "connected":
        this.emit({ kind: "connected" });
        return;
      case "outage":
        this.clearSnapshotAuthorizations();
        this.clearHostileProximity();
        this.emit({ kind: "disconnected", reason: event.reason });
        return;
      case "bridge_failed":
        this.clearSnapshotAuthorizations();
        this.clearHostileProximity();
        this.emit(event);
        return;
      case "world_changed":
        this.clearSnapshotAuthorizations();
        this.clearHostileProximity();
        this.emit({ kind: "world_changed" });
        return;
      case "chat":
      case "owner_online":
      case "owner_offline":
      case "death":
        this.emit(event);
        return;
      case "entity_spawn":
      case "entity_moved":
        this.observeHostile(event.bot, event.entity);
        return;
      case "entity_gone":
        if (this.connection.currentBot() === event.bot) this.forgetHostile(event.entity.id);
        return;
      case "move":
      case "forced_move":
        this.reevaluateKnownHostiles(event.bot);
        return;
      case "spawn_position": {
        if (this.connection.currentBot() !== event.bot) return;
        const position = packetSpawnPosition(event.bot, event.packet);
        if (position) this.worldSpawn = position;
        return;
      }
    }
  }

  private emit(event: MinecraftEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private requireBot(): Bot {
    const bot = this.connection.currentBot();
    if (!bot) throw new Error("Minecraft bot is not connected");
    return bot;
  }

  private requireSession(): MineflayerSession {
    const session = this.connection.currentSession();
    if (!session) throw new Error("Minecraft bot is not connected");
    return session;
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
    if (this.connection.currentBot() !== bot) return;
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
    if (this.connection.currentBot() !== bot) return;
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

  private assertActive(session: MineflayerSession, signal: AbortSignal): void {
    this.assertNotAborted(signal);
    if (!this.connection.isCurrentSession(session)) throw abortError();
  }

  private assertSafeAction(action: GameAction): void {
    if (
      classifyActionRisk(action, {
        owner: { x: 0, y: 0, z: 0 },
      }).level === "dangerous"
    ) {
      throw new Error("dangerous item is permanently forbidden");
    }
  }

  private async abortable(
    signal: AbortSignal,
    session: MineflayerSession,
    cancellation: "motion" | "dig" | "fence",
    operation: () => Promise<void> | void,
    abortCleanup?: () => void,
  ): Promise<void> {
    if (signal.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let started = false;
      let aborted = false;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      let unregister: () => void = () => undefined;
      const finishAfterFence = (reason: string) => {
        try {
          this.connection.fenceActiveSession(session, reason);
          finish(abortError());
        } catch (error) {
          finish(asError(error));
        }
      };
      const startFenceTimer = (reason: string) => {
        cancelTimer = setTimeout(() => {
          cancelTimer = undefined;
          finishAfterFence(reason);
        }, OPERATION_CANCEL_TIMEOUT_MS);
        cancelTimer.unref?.();
      };
      const onAbort = () => {
        if (aborted) {
          if (!this.connection.isCurrentSession(session)) finish(abortError());
          return;
        }
        aborted = true;
        this.safelyStopBot(session.bot);
        try {
          abortCleanup?.();
        } catch {
          finishAfterFence("operation cleanup failed");
          return;
        }
        if (!started || !this.connection.isCurrentSession(session)) {
          finish(abortError());
          return;
        }
        if (cancellation === "dig") {
          let cancellationResult: unknown;
          try {
            cancellationResult = session.bot.stopDigging();
          } catch {
            finishAfterFence("dig cancellation failed");
            return;
          }
          startFenceTimer("dig cancellation timed out");
          if (isThenable(cancellationResult)) {
            Promise.resolve(cancellationResult).then(
              () => finish(abortError()),
              () => finishAfterFence("dig cancellation acknowledgement failed"),
            );
          }
          return;
        }
        if (cancellation === "fence") {
          finishAfterFence("operation cancelled");
          return;
        }
        startFenceTimer("motion cancellation timed out");
      };
      const cancel = () => onAbort();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (cancelTimer !== undefined) clearTimeout(cancelTimer);
        cancelTimer = undefined;
        signal.removeEventListener("abort", onAbort);
        unregister();
        if (error) reject(error);
        else resolve();
      };

      unregister = this.connection.registerActiveOperation(cancel);
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => {
          if (aborted || settled) return;
          this.assertActive(session, signal);
          started = true;
          return operation();
        })
        .then(() => {
          if (!aborted) finish();
          else if (cancellation === "motion") finish(abortError());
        })
        .catch((error: unknown) => {
          if (!aborted) finish(asError(error));
          else if (cancellation === "motion") finish(abortError());
        });
    });
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
}
