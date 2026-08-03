// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot } from "../../../src/runtime/runtimeEvents.js";
import { createSupervisorTrayRuntime, createTrayController, type TrayAction } from "./tray.js";

const runningSnapshot: RuntimeSnapshot = {
  revision: 1,
  lifecycle: "running",
  minecraft: { state: "connected", sessionId: "session_7F2A" },
  codex: { state: "ready", model: "gpt-5" },
  actions: {
    state: "ready",
    workspaceVersion: "workspace-1",
    mcpListening: true,
    discoveredToolCount: 15,
  },
  task: null,
  lastError: null,
};

const stoppedSnapshot: RuntimeSnapshot = {
  revision: 2,
  lifecycle: "stopped",
  minecraft: { state: "disconnected", sessionId: null },
  codex: { state: "stopped", model: null },
  actions: null,
  task: null,
  lastError: null,
};

function action(actions: readonly TrayAction[], id: TrayAction["id"]): TrayAction {
  const found = actions.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing tray action: ${id}`);
  return found;
}

function createHarness(options: {
  status?: () => Promise<RuntimeSnapshot>;
  proactiveMessages?: {
    isPaused(): boolean;
    toggle(): Promise<void>;
  };
}) {
  const runtime = {
    status: vi.fn(options.status ?? (async () => stoppedSnapshot)),
    start: vi.fn(async () => runningSnapshot),
    stop: vi.fn(async () => stoppedSnapshot),
    emergencyStop: vi.fn(async () => stoppedSnapshot),
  };
  const showWindow = vi.fn();
  const quit = vi.fn(async () => undefined);
  const onActionsChanged = vi.fn();
  const destroyTray = vi.fn();
  const onError = vi.fn();
  const controller = createTrayController({
    runtime,
    showWindow,
    quit,
    proactiveMessages: options.proactiveMessages,
    onActionsChanged,
    destroyTray,
    onError,
  });
  return {
    controller,
    destroyTray,
    onActionsChanged,
    onError,
    quit,
    runtime,
    showWindow,
  };
}

describe("WhiteLily tray controller", () => {
  it("adapts only the fixed four-command supervisor protocol", async () => {
    const request = vi.fn(async () => stoppedSnapshot);
    const emergencyStop = vi.fn(async () => stoppedSnapshot);
    const runtime = createSupervisorTrayRuntime({ emergencyStop, request });

    await runtime.status();
    await runtime.start();
    await runtime.stop();
    await runtime.emergencyStop();

    expect(request.mock.calls).toEqual([
      [{ kind: "get_status" }],
      [{ kind: "start_runtime" }],
      [{ kind: "stop_runtime" }],
    ]);
    expect(emergencyStop).toHaveBeenCalledOnce();
  });

  it("exposes exactly the five approved Chinese-first actions in order", () => {
    const { controller } = createHarness({});

    expect(controller.actions.map(({ id, label, enabled }) => ({ id, label, enabled }))).toEqual([
      { id: "open", label: "打开 WhiteLily", enabled: true },
      { id: "connect_or_disconnect", label: "连接或断开", enabled: true },
      {
        id: "toggle_proactive_messages",
        label: "主动消息（暂不可用）",
        enabled: false,
      },
      { id: "emergency_stop", label: "紧急停止", enabled: true },
      { id: "quit", label: "退出", enabled: true },
    ]);
    expect(controller.actions.map(({ id }) => id)).not.toContain("enable_high_risk");
    expect(controller.actions.map(({ label }) => label).join(" ")).not.toMatch(/高风险|自主模式/);
  });

  it("maps running and stopped status only to the fixed stop and start APIs", async () => {
    const status = vi
      .fn<() => Promise<RuntimeSnapshot>>()
      .mockResolvedValueOnce(runningSnapshot)
      .mockResolvedValueOnce(stoppedSnapshot);
    const { controller, runtime } = createHarness({ status });

    await action(controller.actions, "connect_or_disconnect").invoke();
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(action(controller.actions, "connect_or_disconnect").label).toBe("连接或断开");

    await action(controller.actions, "connect_or_disconnect").invoke();
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(action(controller.actions, "connect_or_disconnect").label).toBe("连接或断开");
  });

  it("routes emergency stop directly to main authority without status or confirmation", async () => {
    const { controller, runtime } = createHarness({});

    await action(controller.actions, "emergency_stop").invoke();

    expect(runtime.emergencyStop).toHaveBeenCalledOnce();
    expect(runtime.status).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("keeps proactive messages unavailable until a real Plan 03 callback is injected", async () => {
    const unavailable = createHarness({});
    await action(unavailable.controller.actions, "toggle_proactive_messages").invoke();
    expect(unavailable.onError).not.toHaveBeenCalled();

    let paused = false;
    const toggle = vi.fn(async () => {
      paused = !paused;
    });
    const available = createHarness({
      proactiveMessages: {
        isPaused: () => paused,
        toggle,
      },
    });

    expect(action(available.controller.actions, "toggle_proactive_messages")).toMatchObject({
      label: "暂停主动消息",
      enabled: true,
    });
    await action(available.controller.actions, "toggle_proactive_messages").invoke();
    expect(toggle).toHaveBeenCalledOnce();
    expect(action(available.controller.actions, "toggle_proactive_messages").label).toBe(
      "恢复主动消息",
    );
  });

  it("contains synchronous and asynchronous callback failures", async () => {
    const status = vi.fn(async () => {
      throw new Error("status failed");
    });
    const { controller, onError, quit, runtime, showWindow } = createHarness({ status });
    showWindow.mockImplementation(() => {
      throw new Error("show failed");
    });
    runtime.emergencyStop.mockRejectedValueOnce(new Error("emergency failed"));
    quit.mockRejectedValueOnce(new Error("quit failed"));

    await expect(action(controller.actions, "open").invoke()).resolves.toBeUndefined();
    await expect(
      action(controller.actions, "connect_or_disconnect").invoke(),
    ).resolves.toBeUndefined();
    await expect(action(controller.actions, "emergency_stop").invoke()).resolves.toBeUndefined();
    await expect(action(controller.actions, "quit").invoke()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(4);
  });

  it("renders the neutral label and destroys the real tray once", () => {
    const { controller, destroyTray, onActionsChanged } = createHarness({});

    expect(onActionsChanged).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "connect_or_disconnect",
          label: "连接或断开",
        }),
      ]),
    );

    controller.destroy();
    controller.destroy();
    expect(destroyTray).toHaveBeenCalledOnce();
  });
});
