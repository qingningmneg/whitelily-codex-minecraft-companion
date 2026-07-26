import type { CompanionMode } from "../domain/types.js";

export interface ModeSnapshot {
  mode: CompanionMode;
  paused: boolean;
  taskId: string | null;
}

export class ModeManager {
  private state: ModeSnapshot = { mode: "friend", paused: false, taskId: null };

  snapshot(): Readonly<ModeSnapshot> {
    return { ...this.state };
  }

  getMode(): CompanionMode {
    return this.state.mode;
  }

  setMode(mode: CompanionMode): void {
    this.state.mode = mode;
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
