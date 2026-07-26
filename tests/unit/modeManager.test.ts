import { describe, expect, it } from "vitest";
import { ModeManager } from "../../src/mode/modeManager.js";

describe("ModeManager", () => {
  it("always starts safely in friend mode", () => {
    const manager = new ModeManager();

    expect(manager.getMode()).toBe("friend");
    expect(manager.snapshot()).toEqual({
      mode: "friend",
      paused: false,
      taskId: null,
    });
  });

  it("records a selected mode and active task", () => {
    const manager = new ModeManager();
    manager.setMode("balanced");
    manager.startTask("task-2");

    expect(manager.getMode()).toBe("balanced");
    expect(manager.snapshot()).toEqual({
      mode: "balanced",
      paused: false,
      taskId: "task-2",
    });
  });

  it("pauses and resumes without discarding the current task", () => {
    const manager = new ModeManager();
    manager.startTask("task-3");
    manager.pause();
    manager.resume();

    expect(manager.snapshot()).toEqual({
      mode: "friend",
      paused: false,
      taskId: "task-3",
    });
  });

  it("stop cancels the current task and leaves the service paused", () => {
    const manager = new ModeManager();
    manager.startTask("task-1");
    manager.setMode("autonomous");
    manager.stop();

    expect(manager.snapshot()).toEqual({
      mode: "autonomous",
      paused: true,
      taskId: null,
    });
  });
});
