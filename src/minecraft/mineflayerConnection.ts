import type { Bot } from "mineflayer";

export type MineflayerConnectionState =
  "idle" | "connecting" | "connected" | "retrying" | "exhausted" | "stopped";

export type MineflayerConnectionEvent =
  | { kind: "connected" }
  | { kind: "outage"; reason: string }
  | { kind: "world_changed" }
  | { kind: "chat"; username: string; message: string }
  | { kind: "owner_online" | "owner_offline"; username: string }
  | { kind: "death" }
  | { kind: "entity_spawn" | "entity_moved" | "entity_gone"; bot: Bot; entity: Bot["entity"] }
  | { kind: "move" | "forced_move"; bot: Bot }
  | { kind: "spawn_position"; bot: Bot; packet: unknown };

export interface MineflayerConnectionDependencies {
  config: {
    host: "127.0.0.1";
    port: number;
    botUsername: "WhiteLily";
  };
  createBot(options: {
    host: "127.0.0.1";
    port: number;
    username: "WhiteLily";
    auth: "offline";
    hideErrors: false;
  }): Bot;
  plugin: Parameters<Bot["loadPlugin"]>[0];
  retryDelaysMs: readonly number[];
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface MineflayerSession {
  bot: Bot;
  generation: number;
}

export class MineflayerTransportFenceError extends Error {
  constructor(reason: string, cause: AggregateError) {
    super(`Minecraft physical transport fence failed: ${reason}`, { cause });
    this.name = "MineflayerTransportFenceError";
  }
}

interface BotHandlers {
  chat: (username: string, message: string) => void;
  playerJoined: (player: { username: string }) => void;
  playerLeft: (player: { username: string }) => void;
  spawn: () => void;
  login: (packet: unknown) => void;
  respawn: (packet: unknown) => void;
  death: () => void;
  end: (reason: string) => void;
  entitySpawn: (entity: Bot["entity"]) => void;
  entityMoved: (entity: Bot["entity"]) => void;
  entityGone: (entity: Bot["entity"]) => void;
  move: () => void;
  forcedMove: () => void;
  spawnPosition: (packet: unknown) => void;
}

type WorldIdentity =
  { kind: "known"; value: string } | { kind: "unknown"; changeNotified: boolean };

function abortError(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

function trustedResourceIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    !/^[a-z0-9_.-]+(?::[a-z0-9_./-]+)?$/.test(normalized)
  ) {
    return undefined;
  }
  return normalized.startsWith("minecraft:") ? normalized.slice("minecraft:".length) : normalized;
}

function trustedWorldIdentity(bot: Bot, packet?: unknown): string | undefined {
  const dimension = (bot.game as unknown as { dimension?: unknown } | undefined)?.dimension;
  const normalizedDimension = trustedResourceIdentity(dimension);
  if (!normalizedDimension) return undefined;
  if (packet === undefined) return normalizedDimension;
  if (typeof packet !== "object" || packet === null) return undefined;
  const outer = packet as Record<string, unknown>;
  let worldNameValue: unknown;
  if (Object.hasOwn(outer, "worldState")) {
    if (
      typeof outer.worldState !== "object" ||
      outer.worldState === null ||
      Array.isArray(outer.worldState)
    ) {
      return undefined;
    }
    const worldState = outer.worldState as Record<string, unknown>;
    if (!Object.hasOwn(worldState, "name")) return undefined;
    worldNameValue = worldState.name;
  } else if (Object.hasOwn(outer, "worldName")) {
    worldNameValue = outer.worldName;
  } else {
    return normalizedDimension;
  }
  const worldName = trustedResourceIdentity(worldNameValue);
  return worldName ? `${normalizedDimension}\u0000${worldName}` : undefined;
}

export class MineflayerConnection {
  private lifecycleState: MineflayerConnectionState = "idle";
  private bot: Bot | undefined;
  private botHandlers: BotHandlers | undefined;
  private readonly listeners = new Set<(event: MineflayerConnectionEvent) => void>();
  private readonly activeOperations = new Set<() => void>();
  private retryTimer: unknown;
  private retryIndex = 0;
  private outageNotified = false;
  private connectionPromise: Promise<void> | undefined;
  private resolveConnection: (() => void) | undefined;
  private rejectConnection: ((error: Error) => void) | undefined;
  private worldIdentity: WorldIdentity | undefined;
  private sessionGeneration = 0;

  constructor(private readonly dependencies: MineflayerConnectionDependencies) {}

  connect(): Promise<void> {
    switch (this.lifecycleState) {
      case "idle": {
        const waiting = this.createConnectionPromise();
        this.lifecycleState = "connecting";
        this.startAttempt();
        return waiting;
      }
      case "connecting":
      case "retrying":
        return this.connectionPromise ?? this.createConnectionPromise();
      case "connected":
        return Promise.resolve();
      case "exhausted":
      case "stopped":
        return Promise.reject(new Error("adapter is stopped; create a new adapter to restart"));
      default:
        return Promise.reject(new Error("Minecraft connection is in an unknown state"));
    }
  }

  async disconnect(): Promise<void> {
    if (this.lifecycleState === "stopped") return;
    const wasConnected = this.lifecycleState === "connected";
    this.lifecycleState = "stopped";
    this.clearRetryTimer();
    this.rejectConnection?.(abortError());
    this.clearConnectionPromise();

    const bot = this.bot;
    if (bot) {
      this.detach(bot);
      this.bot = undefined;
      this.worldIdentity = undefined;
      this.safelyStopBot(bot);
      this.safelyEndBot(bot, "adapter disconnect");
    }
    this.cancelActiveOperations();
    if (wasConnected && !this.outageNotified) {
      this.emit({ kind: "outage", reason: "adapter disconnect" });
    }
  }

  state(): MineflayerConnectionState {
    return this.lifecycleState;
  }

  currentBot(): Bot | undefined {
    return this.bot;
  }

  currentSession(): MineflayerSession | undefined {
    const bot = this.bot;
    return bot && this.lifecycleState === "connected"
      ? { bot, generation: this.sessionGeneration }
      : undefined;
  }

  isCurrentSession(session: MineflayerSession): boolean {
    return (
      this.lifecycleState === "connected" &&
      this.bot === session.bot &&
      this.sessionGeneration === session.generation
    );
  }

  fenceActiveSession(session: MineflayerSession, reason: string): void {
    if (!this.isCurrentSession(session)) return;
    this.safelyStopBot(session.bot);
    const fenceErrors = this.establishTransportFence(session.bot, reason);
    if (fenceErrors.length > 0) {
      const error = new MineflayerTransportFenceError(
        reason,
        new AggregateError(fenceErrors, "Every available Minecraft transport close failed"),
      );
      this.handleFenceFailure(session.bot, error);
      throw error;
    }
    this.handleEnd(session.bot, reason);
  }

  onEvent(listener: (event: MineflayerConnectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerActiveOperation(cancel: () => void): () => void {
    this.activeOperations.add(cancel);
    return () => this.activeOperations.delete(cancel);
  }

  private startAttempt(): void {
    if (this.lifecycleState !== "connecting" && this.lifecycleState !== "retrying") return;
    if (this.bot) return;
    try {
      const bot = this.dependencies.createBot({
        host: "127.0.0.1",
        port: this.dependencies.config.port,
        username: this.dependencies.config.botUsername,
        auth: "offline",
        hideErrors: false,
      });
      this.bot = bot;
      this.sessionGeneration += 1;
      this.worldIdentity = undefined;
      bot.loadPlugin(this.dependencies.plugin);
      this.attach(bot);
    } catch (error) {
      if (this.bot) this.cleanupPartialBot(this.bot);
      this.handleEnd(undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private attach(bot: Bot): void {
    const handlers: BotHandlers = {
      chat: (username, message) => this.emitForBot(bot, { kind: "chat", username, message }),
      playerJoined: (player) =>
        this.emitForBot(bot, { kind: "owner_online", username: player.username }),
      playerLeft: (player) =>
        this.emitForBot(bot, { kind: "owner_offline", username: player.username }),
      spawn: () => this.handleSpawn(bot),
      login: (packet) => this.handleLogin(bot, packet),
      respawn: (packet) => this.handleRespawn(bot, packet),
      death: () => this.emitForBot(bot, { kind: "death" }),
      end: (reason) => this.handleEnd(bot, reason),
      entitySpawn: (entity) => this.emitForBot(bot, { kind: "entity_spawn", bot, entity }),
      entityMoved: (entity) => this.emitForBot(bot, { kind: "entity_moved", bot, entity }),
      entityGone: (entity) => this.emitForBot(bot, { kind: "entity_gone", bot, entity }),
      move: () => this.emitForBot(bot, { kind: "move", bot }),
      forcedMove: () => this.emitForBot(bot, { kind: "forced_move", bot }),
      spawnPosition: (packet) => this.emitForBot(bot, { kind: "spawn_position", bot, packet }),
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
    bot._client.on("login", handlers.login);
    bot._client.on("respawn", handlers.respawn);
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
    this.tryCleanup(() => bot._client.removeListener("login", handlers.login));
    this.tryCleanup(() => bot._client.removeListener("respawn", handlers.respawn));
    this.tryCleanup(() => bot._client.removeListener("spawn_position", handlers.spawnPosition));
    this.botHandlers = undefined;
  }

  private cleanupPartialBot(bot: Bot): void {
    this.detach(bot);
    if (this.bot === bot) this.bot = undefined;
    this.safelyStopBot(bot);
    this.safelyEndBot(bot, "adapter setup failed");
  }

  private handleSpawn(bot: Bot): void {
    if (
      this.bot !== bot ||
      (this.lifecycleState !== "connecting" && this.lifecycleState !== "retrying")
    ) {
      return;
    }
    this.clearRetryTimer();
    this.lifecycleState = "connected";
    this.outageNotified = false;
    this.retryIndex = 0;
    if (this.worldIdentity === undefined) {
      const identity = trustedWorldIdentity(bot);
      this.worldIdentity =
        identity === undefined
          ? { kind: "unknown", changeNotified: false }
          : { kind: "known", value: identity };
    }
    this.emit({ kind: "connected" });
    this.resolveConnection?.();
    this.clearConnectionPromise();
  }

  private handleLogin(bot: Bot, packet: unknown): void {
    if (
      this.bot !== bot ||
      (this.lifecycleState !== "connecting" && this.lifecycleState !== "retrying")
    ) {
      return;
    }
    const identity = trustedWorldIdentity(bot, packet);
    this.worldIdentity =
      identity === undefined
        ? { kind: "unknown", changeNotified: false }
        : { kind: "known", value: identity };
  }

  private handleRespawn(bot: Bot, packet: unknown): void {
    if (this.bot !== bot || this.lifecycleState !== "connected") return;
    const identity = trustedWorldIdentity(bot, packet);
    const previous = this.worldIdentity;
    if (identity === undefined) {
      if (previous?.kind === "unknown" && previous.changeNotified) return;
      this.worldIdentity = { kind: "unknown", changeNotified: true };
      this.emit({ kind: "world_changed" });
      return;
    }
    if (previous?.kind === "known") {
      if (previous.value === identity) return;
      this.worldIdentity = { kind: "known", value: identity };
      this.emit({ kind: "world_changed" });
      return;
    }
    const shouldNotify = previous === undefined || !previous.changeNotified;
    this.worldIdentity = { kind: "known", value: identity };
    if (shouldNotify) this.emit({ kind: "world_changed" });
  }

  private handleEnd(bot: Bot | undefined, reason: string): void {
    if (bot && this.bot !== bot) return;
    if (bot) this.detach(bot);
    if (this.bot === bot) this.bot = undefined;
    this.worldIdentity = undefined;
    this.cancelActiveOperations();
    if (this.lifecycleState === "stopped" || this.lifecycleState === "exhausted") return;
    this.lifecycleState = "retrying";
    if (!this.outageNotified) {
      this.outageNotified = true;
      this.emit({ kind: "outage", reason });
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    const delay = this.dependencies.retryDelaysMs[this.retryIndex];
    if (delay === undefined) {
      this.lifecycleState = "exhausted";
      this.rejectConnection?.(new Error("Minecraft connection retries exhausted"));
      this.clearConnectionPromise();
      return;
    }
    if (this.lifecycleState !== "retrying") return;
    this.retryIndex += 1;
    this.clearRetryTimer();
    this.retryTimer = this.dependencies.setTimer(() => {
      this.retryTimer = undefined;
      this.startAttempt();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) this.dependencies.clearTimer(this.retryTimer);
    this.retryTimer = undefined;
  }

  private createConnectionPromise(): Promise<void> {
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnection = resolve;
      this.rejectConnection = reject;
    });
    return this.connectionPromise;
  }

  private clearConnectionPromise(): void {
    this.resolveConnection = undefined;
    this.rejectConnection = undefined;
    this.connectionPromise = undefined;
  }

  private emit(event: MineflayerConnectionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitForBot(bot: Bot, event: MineflayerConnectionEvent): void {
    if (this.bot === bot) this.emit(event);
  }

  private cancelActiveOperations(): void {
    this.safelyStopBot(this.bot);
    for (const cancel of [...this.activeOperations]) this.tryCleanup(cancel);
    this.activeOperations.clear();
  }

  private safelyStopBot(bot: Bot | undefined): void {
    this.tryCleanup(() => bot?.pathfinder?.stop());
    this.tryCleanup(() => bot?.clearControlStates?.());
  }

  private safelyEndBot(bot: Bot, reason: string): void {
    this.tryCleanup(() => bot.end(reason));
  }

  private establishTransportFence(bot: Bot, reason: string): Error[] {
    const candidate = bot as unknown as {
      end?: (reason?: string) => void;
      _client?: {
        end?: (reason?: string) => void;
        socket?: {
          end?: () => void;
          destroy?: () => void;
        };
      };
    };
    const botEnd =
      typeof candidate.end === "function" ? () => candidate.end?.call(bot, reason) : undefined;
    const clientEnd =
      typeof candidate._client?.end === "function"
        ? () => candidate._client?.end?.call(candidate._client, reason)
        : undefined;
    const attempts: Array<{
      operation: (() => void) | undefined;
      label: string;
    }> = [
      {
        label: "bot.end",
        operation: botEnd,
      },
      {
        label: "bot._client.end",
        // Installed Mineflayer's bot.end delegates to this exact method. Calling it
        // again after bot.end throws would repeat the same failing close attempt.
        operation: botEnd ? undefined : clientEnd,
      },
      {
        label: "bot._client.socket.end",
        operation:
          typeof candidate._client?.socket?.end === "function"
            ? () => candidate._client?.socket?.end?.call(candidate._client.socket)
            : undefined,
      },
      {
        label: "bot._client.socket.destroy",
        operation:
          typeof candidate._client?.socket?.destroy === "function"
            ? () => candidate._client?.socket?.destroy?.call(candidate._client.socket)
            : undefined,
      },
    ];
    const errors: Error[] = [];
    for (const attempt of attempts) {
      if (!attempt.operation) continue;
      try {
        attempt.operation();
        return [];
      } catch (error) {
        errors.push(
          new Error(`${attempt.label} failed`, {
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
        );
      }
    }
    if (errors.length === 0)
      errors.push(new Error("no Minecraft transport close API is available"));
    return errors;
  }

  private handleFenceFailure(bot: Bot, error: MineflayerTransportFenceError): void {
    if (this.bot !== bot) return;
    this.detach(bot);
    this.bot = undefined;
    this.worldIdentity = undefined;
    this.clearRetryTimer();
    this.lifecycleState = "exhausted";
    this.rejectConnection?.(error);
    this.clearConnectionPromise();
    if (!this.outageNotified) {
      this.outageNotified = true;
      this.emit({ kind: "outage", reason: error.message });
    }
    queueMicrotask(() => this.cancelActiveOperations());
  }

  private tryCleanup(operation: () => void): void {
    try {
      operation();
    } catch {
      // Connection teardown must continue after best-effort Mineflayer cleanup.
    }
  }
}
