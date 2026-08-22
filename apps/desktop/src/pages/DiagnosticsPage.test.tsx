import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhiteLilyTask5Api } from "../desktopApi.js";
import type { RuntimeActionQueueProjection } from "../../../../src/runtime/runtimeEvents.js";
import { DiagnosticsPage } from "./DiagnosticsPage.js";

function api(
  errorCode = "missing_tools",
  actionQueue: RuntimeActionQueueProjection = {
    goal: "制作面包",
    items: [
      {
        index: 1,
        kind: "harvest_crop",
        summary: "寻找成熟小麦",
        status: "waiting",
        retryCount: 0,
        enqueuedAt: "2026-08-15T00:00:00.000Z",
      },
    ],
  },
) {
  const runtimeListeners = new Set<(event: unknown) => void>();
  const value = {
    status: vi.fn(async () => ({
      revision: 1,
      lifecycle: "running" as const,
      minecraft: { state: "connected" as const, sessionId: null },
      codex: { state: "ready" as const, model: "gpt-live" },
      actions: null,
      task: null,
      actionQueue,
      lastError: null,
    })),
    subscribeRuntime: vi.fn((listener: (event: unknown) => void) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    }),
    previewDiagnostics: vi.fn(async () => ({
      exportId: "diagnostic_1234567890",
      actionCapability: {
        workspaceVersion: "workspace-1",
        state: "failed" as const,
        mcpListening: true,
        discoveredToolCount: 14,
        errorCode,
      },
      files: [
        { logicalName: "app-version.json", size: 24, redactions: 0 },
        { logicalName: "app-log.jsonl", size: 640, redactions: 7 },
      ],
      omitted: ["authentication-data", "complete-memories", "raw-chat"],
    })),
    exportDiagnostics: vi.fn(async () => ({ status: "saved" as const })),
    emitRuntime(event: unknown): void {
      for (const listener of runtimeListeners) listener(event);
    },
    runtimeListenerCount(): number {
      return runtimeListeners.size;
    },
  };
  return value as unknown as WhiteLilyTask5Api & typeof value;
}

describe("DiagnosticsPage", () => {
  afterEach(cleanup);

  it("shows the local-only whitelist preview, omissions, and redaction counts", async () => {
    const desktopApi = api();
    render(<DiagnosticsPage api={desktopApi} locale="en" />);

    expect(await screen.findByRole("heading", { name: "Logs & diagnostics" })).toBeTruthy();
    expect(screen.getByText("app-version.json")).toBeTruthy();
    expect(screen.getByText("app-log.jsonl")).toBeTruthy();
    expect(screen.getByText("7 redactions")).toBeTruthy();
    expect(screen.getByText("Authentication data")).toBeTruthy();
    expect(screen.getByText("Complete memories")).toBeTruthy();
    expect(screen.getByText("Raw chat")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /send|upload/iu })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("heading", { name: "AI action queue" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Queued at" })).toBeTruthy();
  });

  it("can approve only the active opaque preview ID and exposes no destination input", async () => {
    const desktopApi = api();
    render(<DiagnosticsPage api={desktopApi} locale="en" />);

    await screen.findByText("app-log.jsonl");
    await userEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
    await waitFor(() =>
      expect(desktopApi.exportDiagnostics).toHaveBeenCalledWith("diagnostic_1234567890"),
    );
    expect(await screen.findByText("Diagnostic archive saved")).toBeTruthy();
    expect(screen.queryByLabelText(/path|destination/iu)).toBeNull();
  });

  it("renders Chinese-default copy from the complete bilingual catalog", async () => {
    render(<DiagnosticsPage api={api()} locale="zh-CN" />);
    expect(await screen.findByRole("heading", { name: "日志与诊断" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "导出诊断包" })).toBeTruthy();
  });

  it("renders bounded action health and a localized recovery message without private details", async () => {
    render(<DiagnosticsPage api={api()} locale="zh-CN" />);

    expect(await screen.findByText("workspace-1")).toBeTruthy();
    expect(screen.getByText("运行失败")).toBeTruthy();
    expect(screen.getByText("是")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getByText("Minecraft 动作组件不完整；")).toBeTruthy();
    expect(screen.getByText("MCP_TOOL_CATALOG_INVALID")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/schema|payload|C:\\|prompt|chat|token/iu);
  });

  it("reads and live-updates the private AI action queue without showing authority data", async () => {
    const desktopApi = api();
    render(<DiagnosticsPage api={desktopApi} locale="zh-CN" />);

    expect(await screen.findByRole("heading", { name: "AI 动作队列" })).toBeTruthy();
    expect(screen.getByText("制作面包")).toBeTruthy();
    expect(screen.getByText("寻找成熟小麦")).toBeTruthy();
    expect(screen.getByText("等待中")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/lease|observation|private-queue|\bx\b/iu);

    act(() =>
      desktopApi.emitRuntime({
        kind: "action_queue",
        revision: 2,
        actionQueue: {
          goal: "制作面包",
          items: [
            {
              index: 1,
              kind: "harvest_crop",
              summary: "寻找成熟小麦",
              status: "cancelled",
              retryCount: 0,
              enqueuedAt: "2026-08-15T00:00:00.000Z",
              endedAt: "2026-08-15T00:00:01.000Z",
              reason: "owner_stop",
            },
          ],
        },
      }),
    );

    expect(await screen.findByText("已取消")).toBeTruthy();
    expect(screen.getByText("owner_stop")).toBeTruthy();
  });

  it("shows an empty queue and removes the runtime subscription on unmount", async () => {
    const desktopApi = api("missing_tools", { goal: null, items: [] });
    const view = render(<DiagnosticsPage api={desktopApi} locale="en" />);

    expect(await screen.findByText("No AI actions are queued.")).toBeTruthy();
    expect(desktopApi.runtimeListenerCount()).toBe(1);
    view.unmount();
    expect(desktopApi.runtimeListenerCount()).toBe(0);
  });

  it("renders the 256-item boundary and the permission-wait status", async () => {
    const desktopApi = api("missing_tools", {
      goal: "种植小麦",
      items: Array.from({ length: 256 }, (_, index) => ({
        index: index + 1,
        kind: index === 0 ? "wheat_farming_permission" : "wait",
        summary: index === 0 ? "等待小麦种植许可" : `等待 ${index}`,
        status: index === 0 ? ("waiting_permission" as const) : ("waiting" as const),
        retryCount: 0,
        enqueuedAt: "2026-08-15T00:00:00.000Z",
      })),
    });

    render(<DiagnosticsPage api={desktopApi} locale="zh-CN" />);

    expect(await screen.findByText("等待许可")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(257);
  });

  it.each([
    ["server_start_failed", "MCP_PORT_UNAVAILABLE", "The local action port is already in use."],
    [
      "duplicate_tools",
      "MCP_TOOL_CATALOG_INVALID",
      "The Minecraft action component is incomplete.",
    ],
    ["connection_failed", "MCP_READINESS_TIMEOUT", "The Minecraft action component timed out."],
    [
      "MINECRAFT_BRIDGE_REQUIRED",
      "MINECRAFT_BRIDGE_REQUIRED",
      "WhiteLily Bridge must be installed and enabled. Install the component, then restart Minecraft.",
    ],
    [
      "MINECRAFT_BRIDGE_REJECTED",
      "MINECRAFT_BRIDGE_REJECTED",
      "WhiteLily Bridge rejected the connection. Check the component, then restart Minecraft.",
    ],
  ])("renders bounded recovery for %s", async (errorCode, stableCode, recoveryMessage) => {
    render(<DiagnosticsPage api={api(errorCode)} locale="en" />);

    expect(await screen.findByText(stableCode)).toBeTruthy();
    expect(screen.getByText(recoveryMessage)).toBeTruthy();
  });
});
