import type { CompanionMode } from "../domain/types.js";
import {
  companionProfileSchema,
  createDefaultCompanionProfile,
  type BehaviorModeSettings,
  type CompanionProfile,
} from "../profile/profileSchema.js";

export interface ModeSnapshot {
  mode: CompanionMode;
  paused: boolean;
  taskId: string | null;
}

export class ModeManager {
  private state: ModeSnapshot;
  private profile: CompanionProfile;
  private readonly profileListeners = new Set<() => void>();

  constructor(
    profile: CompanionProfile = createDefaultCompanionProfile(
      "00000000-0000-4000-8000-000000000000",
    ),
  ) {
    this.profile = companionProfileSchema.parse(profile);
    this.state = { mode: this.profile.mode, paused: false, taskId: null };
  }

  snapshot(): Readonly<ModeSnapshot> {
    return { ...this.state };
  }

  getMode(): CompanionMode {
    return this.state.mode;
  }

  setMode(mode: CompanionMode): void {
    this.state.mode = mode;
    this.notifyProfileChanged();
  }

  getProfile(): CompanionProfile {
    return companionProfileSchema.parse({ ...this.profile, mode: this.state.mode });
  }

  getModeSettings(): BehaviorModeSettings {
    return { ...this.profile.modeSettings[this.state.mode] };
  }

  applyProfile(profile: CompanionProfile): void {
    const next = companionProfileSchema.parse(profile);
    this.profile = next;
    this.state.mode = next.mode;
    this.notifyProfileChanged();
  }

  resetModeFromProfile(): void {
    this.state.mode = this.profile.mode;
    this.notifyProfileChanged();
  }

  subscribeProfile(listener: () => void): () => void {
    this.profileListeners.add(listener);
    return () => this.profileListeners.delete(listener);
  }

  private notifyProfileChanged(): void {
    for (const listener of [...this.profileListeners]) {
      try {
        listener();
      } catch {
        // Profile observers cannot affect the live safety state.
      }
    }
  }

  startTask(taskId: string): void {
    this.state.taskId = taskId;
    this.state.paused = false;
  }

  pause(): void {
    this.state.paused = true;
  }

  resume(): void {
    this.state.paused = false;
  }

  stop(): void {
    this.state.taskId = null;
    this.state.paused = true;
  }

  completeTask(): void {
    this.state.taskId = null;
  }
}
