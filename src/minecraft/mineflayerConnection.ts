import type { Bot } from "mineflayer";
import type { BridgeAttemptProof } from "./bridgeProofIssuer.js";

export type MineflayerConnectionState =
  "idle" | "connecting" | "connected" | "retrying" | "exhausted" | "stopped";

export type MineflayerConnectionEvent =
  | { kind: "connected" }
  | { kind: "outage"; reason: string }
  | { kind: "bridge_failed"; code: MineflayerBridgeErrorCode }
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
  prepareAttempt(port: number): Promise<BridgeAttemptProof>;
  createBot(options: {
    host: "127.0.0.1";
    port: number;
    username: "WhiteLily";
    auth: "offline";
    hideErrors: true;
    logErrors: false;
    fakeHost: string;
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

export type MineflayerBridgeErrorCode = "MINECRAFT_BRIDGE_REQUIRED" | "MINECRAFT_BRIDGE_REJECTED";

const BRIDGE_ERROR_MESSAGES: Record<MineflayerBridgeErrorCode, string> = {
  MINECRAFT_BRIDGE_REQUIRED: "Minecraft Bridge is required",
  MINECRAFT_BRIDGE_REJECTED: "Minecraft Bridge rejected the connection",
};

export class MineflayerBridgeError extends Error {
  constructor(readonly code: MineflayerBridgeErrorCode) {
    super(BRIDGE_ERROR_MESSAGES[code]);
    this.name = "MineflayerBridgeError";
  }
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
  error: (error: Error) => void;
  kicked: (reason: string, loggedIn: boolean) => void;
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

function swallowLateBotError(): void {
  // A detached Mineflayer bot may still forward a delayed client/plugin error.
}

function swallowLateBotKick(): void {
  // Keep the protocol rejection payload private and absorb detached repeats.
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
  private readonly failingBots = new WeakSet<Bot>();
  private retryTimer: unknown;
  private retryIndex = 0;
  private outageNotified = false;
  private connectionPromise: Promise<void> | undefined;
  private resolveConnection: (() => void) | undefined;
  private rejectConnection: ((error: Error) => void) | undefined;
  private worldIdentity: WorldIdentity | undefined;
  private sessionGeneration = 0;
  private attemptGeneration = 0;
  private activeProof: BridgeAttemptProof | undefined;
  private activeProofBot: Bot | undefined;
  private readonly preparationOperations = new Set<Promise<void>>();
  private readonly proofCloseOperations = new WeakMap<BridgeAttemptProof, Promise<boolean>>();
  private readonly proofCloseByBot = new WeakMap<Bot, Promise<boolean>>();
  private readonly pendingProofCloses = new Set<Promise<boolean>>();
  private proofCloseFailed = false;
  private readonly usedFakeHosts = new Set<string>();
  private proofBackedLoginRejections = 0;
  private hasConnected = false;
  private terminalBridgeError: MineflayerBridgeError | undefined;
  private terminalFenceError: MineflayerTransportFenceError | undefined;
  private disconnectPromise: Promise<void> | undefined;

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

  disconnect(): Promise<void> {
    this.disconnectPromise ??= this.disconnectInternal();
    return this.disconnectPromise;
  }

  private async disconnectInternal(): Promise<void> {
    const wasConnected = this.lifecycleState === "connected";
    if (this.lifecycleState !== "stopped") {
      this.lifecycleState = "stopped";
      this.attemptGeneration += 1;
      this.clearRetryTimer();
      this.takeAndCloseProof();

      const bot = this.bot;
      if (bot) {
        this.safelyStopBot(bot);
        const fenceErrors = this.establishTransportFence(bot, "adapter disconnect");
        if (fenceErrors.length > 0) {
          this.handleFenceFailure(
            bot,
            this.createTransportFenceError("adapter disconnect", fenceErrors),
          );
        }
        if (this.bot === bot) {
          this.detach(bot);
          this.bot = undefined;
          this.worldIdentity = undefined;
        }
      }
      this.rejectConnection?.(abortError());
      this.clearConnectionPromise();
      this.cancelActiveOperations();
      if (wasConnected && !this.outageNotified) {
        this.emit({ kind: "outage", reason: "adapter disconnect" });
      }
    }
    await this.drainProofWork();
    if (this.terminalFenceError) throw this.terminalFenceError;
    if (this.proofCloseFailed)
      throw this.terminalBridgeError ?? new MineflayerBridgeError("MINECRAFT_BRIDGE_REQUIRED");
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
      const error = this.createTransportFenceError(reason, fenceErrors);
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
    const generation = ++this.attemptGeneration;
    const operation = this.prepareAndStartAttempt(generation).catch(() => {
      if (this.isActiveAttempt(generation)) this.failBridge("MINECRAFT_BRIDGE_REQUIRED");
    });
    this.preparationOperations.add(operation);
    void operation.then(() => this.preparationOperations.delete(operation));
  }

  private async prepareAndStartAttempt(generation: number): Promise<void> {
    let proof: BridgeAttemptProof;
    try {
      proof = await this.dependencies.prepareAttempt(this.dependencies.config.port);
    } catch {
      if (!this.isActiveAttempt(generation)) return;
      this.failBridge("MINECRAFT_BRIDGE_REQUIRED");
      return;
    }
    if (!this.isActiveAttempt(generation)) {
      const closed = await this.closeProof(proof);
      if (!closed && this.lifecycleState !== "stopped") {
        this.failBridge("MINECRAFT_BRIDGE_REQUIRED");
      }
      return;
    }
    if (this.proofCloseOperations.has(proof)) {
      this.failBridge("MINECRAFT_BRIDGE_REQUIRED");
      return;
    }
    if (this.usedFakeHosts.has(proof.fakeHost)) {
      await this.closeProof(proof);
      this.failBridge("MINECRAFT_BRIDGE_REQUIRED");
      return;
    }
    this.usedFakeHosts.add(proof.fakeHost);
    try {
      const bot = this.dependencies.createBot({
        host: "127.0.0.1",
        port: this.dependencies.config.port,
        username: this.dependencies.config.botUsername,
        auth: "offline",
        hideErrors: true,
        logErrors: false,
        fakeHost: proof.fakeHost,
      });
      this.bot = bot;
      this.activeProof = proof;
      this.activeProofBot = bot;
      this.sessionGeneration += 1;
      this.worldIdentity = undefined;
      this.attach(bot);
      bot.loadPlugin(this.dependencies.plugin);
    } catch {
      if (this.bot) {
        try {
          this.cleanupPartialBot(this.bot, "Minecraft connection setup failed");
        } catch {
          return;
        }
        this.handleEnd(this.bot, "Minecraft connection setup failed");
      } else {
        this.handleEnd(undefined, "Minecraft connection setup failed", this.closeProof(proof));
      }
    }
  }

  private isActiveAttempt(generation: number): boolean {
    return (
      generation === this.attemptGeneration &&
      (this.lifecycleState === "connecting" || this.lifecycleState === "retrying") &&
      this.bot === undefined
    );
  }

  private failBridge(code: MineflayerBridgeErrorCode): void {
    if (this.lifecycleState === "stopped" || this.terminalBridgeError) return;
    this.attemptGeneration += 1;
    this.clearRetryTimer();
    const bot = this.bot;
    if (bot) {
      this.detach(bot);
      this.safelyStopBot(bot);
      const fenceErrors = this.establishTransportFence(bot, "Minecraft Bridge failure");
      if (fenceErrors.length > 0) {
        this.terminalFenceError = this.createTransportFenceError(
          "Minecraft Bridge failure",
          fenceErrors,
        );
      }
      if (this.bot === bot) this.bot = undefined;
    }
    this.worldIdentity = undefined;
    this.cancelActiveOperations();
    this.lifecycleState = "exhausted";
    const error = new MineflayerBridgeError(code);
    this.terminalBridgeError = error;
    if (!this.outageNotified) {
      this.outageNotified = true;
      this.emit({ kind: "outage", reason: error.code });
    }
    this.rejectConnection?.(error);
    this.clearConnectionPromise();
    if (this.hasConnected) this.emit({ kind: "bridge_failed", code: error.code });
  }

  private attach(bot: Bot): void {
    const handlers: BotHandlers = {
      chat: (username, message) => this.emitForBot(bot, { kind: "chat", username, message }),
      playerJoined: (player) =>
        this.emitForBot(bot, { kind: "owner_online", username: player.username }),
      playerLeft: (player) =>
        this.emitForBot(bot, { kind: "owner_offline", username: player.username }),
      spawn: () => void this.handleSpawn(bot),
      error: () => this.handleError(bot),
      kicked: (_reason, loggedIn) => this.handleKicked(bot, loggedIn),
      login: (packet) => this.handleLogin(bot, packet),
      respawn: (packet) => this.handleRespawn(bot, packet),
      death: () => this.emitForBot(bot, { kind: "death" }),
      end: () => this.handleEnd(bot, "Minecraft connection ended"),
      entitySpawn: (entity) => this.emitForBot(bot, { kind: "entity_spawn", bot, entity }),
      entityMoved: (entity) => this.emitForBot(bot, { kind: "entity_moved", bot, entity }),
      entityGone: (entity) => this.emitForBot(bot, { kind: "entity_gone", bot, entity }),
      move: () => this.emitForBot(bot, { kind: "move", bot }),
      forcedMove: () => this.emitForBot(bot, { kind: "forced_move", bot }),
      spawnPosition: (packet) => this.emitForBot(bot, { kind: "spawn_position", bot, packet }),
    };
    this.botHandlers = handlers;
    bot.on("error", swallowLateBotError);
    bot.once("error", handlers.error);
    bot.on("kicked", swallowLateBotKick);
    bot.once("kicked", handlers.kicked);
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
    this.tryCleanup(() => bot.removeListener("error", handlers.error));
    this.tryCleanup(() => bot.removeListener("kicked", handlers.kicked));
    // Keep swallowLateBotError attached after lifecycle teardown. Mineflayer can
    // forward a delayed client/plugin error after the transport begins closing,
    // and Node throws an `error` event that has no listener. The kicked sink is
    // likewise persistent so repeated or delayed rejection payloads stay inert.
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

  private cleanupPartialBot(bot: Bot, setupReason: string): void {
    this.detach(bot);
    this.safelyStopBot(bot);
    const reason = `adapter setup failed: ${setupReason}`;
    const fenceErrors = this.establishTransportFence(bot, reason);
    if (fenceErrors.length > 0) {
      const error = this.createTransportFenceError(reason, fenceErrors);
      this.handleFenceFailure(bot, error);
      throw error;
    }
  }

  private async handleSpawn(bot: Bot): Promise<void> {
    if (
      this.bot !== bot ||
      (this.lifecycleState !== "connecting" && this.lifecycleState !== "retrying")
    ) {
      return;
    }
    const generation = this.attemptGeneration;
    const proofClosed = await (this.takeAndCloseProof(bot) ?? Promise.resolve(true));
    if (!proofClosed) {
      if (generation === this.attemptGeneration && this.bot === bot) {
        this.failBridge("MINECRAFT_BRIDGE_REQUIRED");
      }
      return;
    }
    if (
      generation !== this.attemptGeneration ||
      this.bot !== bot ||
      (this.lifecycleState !== "connecting" && this.lifecycleState !== "retrying")
    ) {
      return;
    }
    this.clearRetryTimer();
    this.lifecycleState = "connected";
    this.hasConnected = true;
    this.outageNotified = false;
    this.retryIndex = 0;
    this.proofBackedLoginRejections = 0;
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

  private handleError(bot: Bot): void {
    this.handleConnectionFailure(bot, "Minecraft connection error");
  }

  private handleKicked(bot: Bot, loggedIn: boolean): void {
    if (loggedIn === false && this.activeProofBot === bot) {
      this.proofBackedLoginRejections += 1;
    }
    this.handleConnectionFailure(bot, "Minecraft connection rejected");
  }

  private handleConnectionFailure(bot: Bot, reason: string): void {
    if (
      this.bot !== bot ||
      this.lifecycleState === "stopped" ||
      this.lifecycleState === "exhausted" ||
      this.failingBots.has(bot)
    ) {
      return;
    }
    this.failingBots.add(bot);
    this.safelyStopBot(bot);
    const fenceErrors = this.establishTransportFence(bot, reason);
    if (fenceErrors.length > 0) {
      this.handleFenceFailure(bot, this.createTransportFenceError(reason, fenceErrors));
      return;
    }
    this.handleEnd(bot, reason);
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

  private handleEnd(
    bot: Bot | undefined,
    reason: string,
    detachedProofClose?: Promise<boolean>,
  ): void {
    if (bot && this.bot !== bot) return;
    this.attemptGeneration += 1;
    const generation = this.attemptGeneration;
    const proofClose = detachedProofClose ?? this.takeAndCloseProof(bot);
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
    void this.finishRetryTransition(generation, proofClose);
  }

  private async finishRetryTransition(
    generation: number,
    proofClose: Promise<boolean> | undefined,
  ): Promise<void> {
    if (proofClose !== undefined && !(await proofClose)) {
      if (generation === this.attemptGeneration && this.lifecycleState !== "stopped") {
        this.failBridge("MINECRAFT_BRIDGE_REQUIRED");
      }
      return;
    }
    if (generation !== this.attemptGeneration || this.lifecycleState !== "retrying") return;
    if (this.proofBackedLoginRejections >= 5) {
      this.failBridge("MINECRAFT_BRIDGE_REJECTED");
      return;
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

  private createTransportFenceError(
    reason: string,
    fenceErrors: Error[],
  ): MineflayerTransportFenceError {
    return new MineflayerTransportFenceError(
      reason,
      new AggregateError(fenceErrors, "Every available Minecraft transport close failed"),
    );
  }

  private handleFenceFailure(bot: Bot, error: MineflayerTransportFenceError): void {
    if (this.bot && this.bot !== bot) return;
    if (this.bot === bot) {
      const proofClose = this.takeAndCloseProof(bot);
      if (proofClose !== undefined) {
        void proofClose.then((closed) => {
          if (!closed && this.lifecycleState !== "stopped") {
            this.failBridge("MINECRAFT_BRIDGE_REQUIRED");
          }
        });
      }
      this.detach(bot);
      this.bot = undefined;
    }
    this.worldIdentity = undefined;
    this.clearRetryTimer();
    this.lifecycleState = "exhausted";
    this.terminalFenceError = error;
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

  private takeAndCloseProof(bot?: Bot): Promise<boolean> | undefined {
    if (!this.activeProof || (bot && this.activeProofBot !== bot)) {
      return bot ? this.proofCloseByBot.get(bot) : undefined;
    }
    const proof = this.activeProof;
    const proofBot = this.activeProofBot;
    this.activeProof = undefined;
    this.activeProofBot = undefined;
    const operation = this.closeProof(proof);
    if (proofBot) this.proofCloseByBot.set(proofBot, operation);
    return operation;
  }

  private closeProof(proof: BridgeAttemptProof): Promise<boolean> {
    const existing = this.proofCloseOperations.get(proof);
    if (existing) return existing;
    let closeOperation: Promise<void>;
    try {
      closeOperation = Promise.resolve(proof.close());
    } catch {
      closeOperation = Promise.reject(new Error("Minecraft Bridge proof close failed"));
    }
    const operation = closeOperation.then(
      () => true,
      () => {
        this.proofCloseFailed = true;
        return false;
      },
    );
    this.proofCloseOperations.set(proof, operation);
    this.pendingProofCloses.add(operation);
    void operation.then(() => this.pendingProofCloses.delete(operation));
    return operation;
  }

  private async drainProofWork(): Promise<void> {
    while (this.preparationOperations.size > 0) {
      await Promise.all([...this.preparationOperations]);
    }
    while (this.pendingProofCloses.size > 0) {
      await Promise.all([...this.pendingProofCloses]);
    }
  }
}
