import { describe, expect, it } from "vitest";
import { ModeManager } from "../../src/mode/modeManager.js";
import { createDefaultCompanionProfile } from "../../src/profile/profileSchema.js";

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

  it("owns a detached live profile and applies a persisted replacement atomically", () => {
    const initial = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
    const manager = new ModeManager(initial);
    initial.persona = "mutated outside";

    expect(manager.getProfile().persona).toBe("");
    const replacement = {
      ...manager.getProfile(),
      displayName: "小百合",
      mode: "balanced" as const,
      persona: "friendly builder",
      modeSettings: {
        ...manager.getProfile().modeSettings,
        balanced: {
          idleMinutes: 27,
          allowProactiveChat: false,
          allowSuggestions: true,
          allowLowRiskMicroActions: false,
        },
      },
    };

    manager.applyProfile(replacement);
    replacement.persona = "mutated after apply";
    const live = manager.getProfile();
    live.preferredTopics.push("mutated snapshot");

    expect(manager.getMode()).toBe("balanced");
    expect(manager.getModeSettings()).toEqual({
      idleMinutes: 27,
      allowProactiveChat: false,
      allowSuggestions: true,
      allowLowRiskMicroActions: false,
    });
    expect(manager.getProfile()).toMatchObject({
      displayName: "小百合",
      persona: "friendly builder",
      preferredTopics: [],
    });
  });

  it("keeps the existing chat mode switch immediate and session-local", () => {
    const manager = new ModeManager(
      createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99"),
    );

    manager.setMode("autonomous");

    expect(manager.snapshot()).toEqual({
      mode: "autonomous",
      paused: false,
      taskId: null,
    });
    expect(manager.getProfile().mode).toBe("autonomous");
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
