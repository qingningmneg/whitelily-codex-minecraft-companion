import type { MinecraftPort } from "../minecraft/minecraftPort.js";
import type { ModeManager } from "../mode/modeManager.js";
import type { ProactiveKind } from "../companion/promptBuilder.js";

export type AutonomyReason =
  "balanced_idle" | "autonomous_idle" | "goal_completed" | "action_failed" | "nearby_threat";

const idleReasons = {
  friend: null,
  balanced: "balanced_idle",
  autonomous: "autonomous_idle",
} as const;

const proactiveChatCooldowns = {
  friend: Number.POSITIVE_INFINITY,
  balanced: 180_000,
  autonomous: 120_000,
} as const;

export interface AutonomySchedulerOptions {
  mode: ModeManager;
  minecraft: Pick<MinecraftPort, "isOwnerOnline">;
  ownerUsername: () => string;
  requestTurn: (reason: AutonomyReason) => Promise<void>;
  isBusy: () => boolean;
  now?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class AutonomyScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private readonly drainingGenerations = new Set<number>();
  private pendingReason: AutonomyReason | null = null;
  private lastProactiveChatAt = Number.NEGATIVE_INFINITY;
  private generation = 0;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<AutonomySchedulerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<AutonomySchedulerOptions["clearTimer"]>;

  constructor(private readonly options: AutonomySchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    options.mode.subscribeProfile(() => this.notifyModeChanged());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.generation += 1;
    this.scheduleIdle();
  }

  stop(): void {
    if (!this.started && this.timer === null && this.pendingReason === null) return;
    this.started = false;
    this.generation += 1;
    this.drainingGenerations.clear();
    this.pendingReason = null;
    this.cancelTimer();
  }

  notifyModeChanged(): void {
    if (!this.started) return;
    this.generation += 1;
    this.drainingGenerations.clear();
    this.cancelTimer();
    this.pendingReason = null;
    this.scheduleIdle();
  }

  notifyGoalCompleted(): void {
    this.enqueue("goal_completed");
  }

  notifyActionFailed(): void {
    this.enqueue("action_failed");
  }

  notifyThreat(): void {
    this.enqueue("nearby_threat");
  }

  canChatProactively(): boolean {
    return this.canSendProactively("chat");
  }

  canSendProactively(kind: ProactiveKind): boolean {
    const mode = this.options.mode.snapshot().mode;
    const settings = this.options.mode.getModeSettings();
    if (kind === "chat" && !settings.allowProactiveChat) return false;
    if (kind === "suggestion" && !settings.allowSuggestions) return false;
    const cooldown = proactiveChatCooldowns[mode];
    return Number.isFinite(cooldown) && this.now() - this.lastProactiveChatAt >= cooldown;
  }

  markProactiveChat(): void {
    this.lastProactiveChatAt = this.now();
  }

  private enqueue(reason: AutonomyReason): void {
    if (!this.started) return;
    this.pendingReason ??= reason;
    this.cancelTimer();
    const generation = this.generation;
    queueMicrotask(() => void this.drain(generation));
  }

  private scheduleIdle(delayOverride?: number): void {
    if (!this.started || this.timer !== null) return;
    const mode = this.options.mode.snapshot().mode;
    const delay =
      delayOverride ??
      (mode === "friend" ? null : this.options.mode.getModeSettings().idleMinutes * 60_000);
    if (delay === null) return;
    const idleReason = idleReasons[mode];
    if (idleReason === null) return;
    const generation = this.generation;
    this.timer = this.setTimer(() => {
      if (!this.started || generation !== this.generation) return;
      this.timer = null;
      this.pendingReason ??= idleReason;
      void this.drain(generation);
    }, delay);
  }

  private async drain(generation: number): Promise<void> {
    if (
      !this.started ||
      generation !== this.generation ||
      this.drainingGenerations.has(generation) ||
      this.pendingReason === null
    ) {
      return;
    }
    this.drainingGenerations.add(generation);
    try {
      const mode = this.options.mode.snapshot();
      if (mode.mode === "friend" || mode.paused) {
        this.pendingReason = null;
        this.scheduleIdle();
        return;
      }
      if (this.options.isBusy()) {
        this.scheduleIdle(1_000);
        return;
      }
      if (!(await this.options.minecraft.isOwnerOnline(this.options.ownerUsername()))) {
        if (!this.isCurrentGeneration(generation)) return;
        this.pendingReason = null;
        this.scheduleIdle();
        return;
      }
      if (!this.isCurrentGeneration(generation)) return;
      const currentMode = this.options.mode.snapshot();
      if (currentMode.mode === "friend" || currentMode.paused || this.pendingReason === null) {
        this.pendingReason = null;
        this.scheduleIdle();
        return;
      }
      if (this.options.isBusy()) {
        this.scheduleIdle(1_000);
        return;
      }
      const reason = this.pendingReason;
      this.pendingReason = null;
      await this.options.requestTurn(reason);
    } finally {
      this.drainingGenerations.delete(generation);
      if (!this.isCurrentGeneration(generation)) return;
      const mode = this.options.mode.snapshot();
      if (mode.mode === "friend" || mode.paused) {
        this.pendingReason = null;
        this.scheduleIdle();
        return;
      }
      if (this.options.isBusy()) {
        if (this.pendingReason !== null) this.scheduleIdle(1_000);
        else this.scheduleIdle();
        return;
      }
      if (this.pendingReason !== null && this.timer === null) {
        queueMicrotask(() => void this.drain(generation));
      } else if (this.pendingReason === null) {
        this.scheduleIdle();
      }
    }
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.started && generation === this.generation;
  }
}
