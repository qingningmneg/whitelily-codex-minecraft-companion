import { AutonomyScheduler, type AutonomyReason } from "../../src/autonomy/autonomyScheduler.js";
import type { CompanionMode } from "../../src/domain/types.js";
import { ModeManager } from "../../src/mode/modeManager.js";

export interface AutonomySchedulerHarnessOptions {
  mode: CompanionMode;
  ownerOnline?: boolean;
  paused?: boolean;
  busy?: boolean;
  isOwnerOnline?: () => Promise<boolean>;
  requestTurn?: (reason: AutonomyReason) => Promise<void>;
}

export function createAutonomySchedulerHarness(options: AutonomySchedulerHarnessOptions) {
  const mode = new ModeManager();
  mode.setMode(options.mode);
  if (options.paused) mode.pause();
  let ownerOnline = options.ownerOnline ?? true;
  let busy = options.busy ?? false;
  const reasons: AutonomyReason[] = [];
  const requestTurn =
    options.requestTurn ??
    (async (reason: AutonomyReason) => {
      reasons.push(reason);
    });
  const scheduler = new AutonomyScheduler({
    mode,
    minecraft: {
      isOwnerOnline: options.isOwnerOnline ?? (async () => ownerOnline),
    },
    ownerUsername: "TestOwner",
    requestTurn,
    isBusy: () => busy,
    now: () => Date.now(),
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: (timer) => clearTimeout(timer),
  });

  return {
    scheduler,
    mode,
    reasons,
    setOwnerOnline(value: boolean): void {
      ownerOnline = value;
    },
    setBusy(value: boolean): void {
      busy = value;
    },
  };
}
