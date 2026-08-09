import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeEvent,
  RuntimeEventPayload,
  RuntimeSnapshot,
} from "../../../../src/runtime/runtimeEvents";
import type { ConnectionInvalidatedEvent } from "../../../../src/desktop/desktopProtocol";
import type { OwnerIdentitySnapshot } from "../../../../src/identity/ownerIdentity";
import App from "../App";
import type { DesktopRendererEvent, WhiteLilyDesktopApi } from "../desktopApi";
import { HomePage } from "./HomePage";

const activeSnapshot: RuntimeSnapshot = {
  revision: 10,
  lifecycle: "running",
  minecraft: { state: "connected", sessionId: "session_7F2A" },
  codex: { state: "ready", model: "gpt-5.6" },
  actions: {
    state: "ready",
    workspaceVersion: "workspace-1",
    mcpListening: true,
    discoveredToolCount: 15,
  },
  task: {
    id: "task_7",
    goal: "走到主人身边",
    status: "running",
    allowedActions: ["get_state", "move_to"],
    effectiveLimits: {
      maxToolCalls: 20,
      maxBlockChanges: 80,
      maxHorizontalTravel: 160,
      maxDurationMs: 300_000,
      maxDangerousOperations: 2,
    },
    startedAt: "2026-07-27T08:00:00.000Z",
    budget: {
      active: true,
      stopReason: null,
      limits: {
        maxToolCalls: 20,
        maxBlockChanges: 80,
        maxHorizontalTravel: 160,
        maxDurationMs: 300_000,
        maxDangerousOperations: 2,
      },
      toolCalls: 7,
      blockChanges: 24,
      horizontalTravel: 38,
      dangerousOperations: 0,
      startedAt: 1_753_603_200_000,
    },
  },
  lastError: null,
};

const stoppedSnapshot: RuntimeSnapshot = {
  revision: 20,
  lifecycle: "stopped",
  minecraft: { state: "disconnected", sessionId: null },
  codex: { state: "stopped", model: null },
  actions: null,
  task: null,
  lastError: null,
};

interface ApiHarness {
  api: WhiteLilyDesktopApi;
  emit(event: RuntimeEvent | RuntimeEventPayload | ConnectionInvalidatedEvent): void;
  stopTask: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["stopTask"]>>;
  emergencyStop: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["emergencyStop"]>>;
  unsubscribe: ReturnType<typeof vi.fn<() => void>>;
}

function createApiHarness(
  options: {
    snapshot?: RuntimeSnapshot;
    status?: Promise<RuntimeSnapshot>;
    taskStop?: Promise<RuntimeSnapshot>;
    emergency?: Promise<RuntimeSnapshot>;
  } = {},
): ApiHarness {
  let listener: ((event: DesktopRendererEvent) => void) | undefined;
  let nextRevision = 100;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const status = vi.fn<WhiteLilyDesktopApi["status"]>(() => {
    return options.status ?? Promise.resolve(options.snapshot ?? activeSnapshot);
  });
  const emergencyStop = vi.fn<WhiteLilyDesktopApi["emergencyStop"]>(() => {
    return options.emergency ?? Promise.resolve(stoppedSnapshot);
  });
  const stopTask = vi.fn<WhiteLilyDesktopApi["stopTask"]>(() => {
    const current = options.snapshot ?? activeSnapshot;
    return (
      options.taskStop ??
      Promise.resolve({ ...current, revision: current.revision + 1, task: null })
    );
  });
  return {
    api: {
      status,
      start: vi.fn(async () => options.snapshot ?? activeSnapshot),
      stop: vi.fn(async () => stoppedSnapshot),
      stopTask,
      emergencyStop,
      readOwnerIdentity: vi.fn(async () => ({
        revision: 0,
        ownerUsername: null,
        configured: false,
        presence: "unknown" as const,
      })),
      updateOwnerIdentity: vi.fn(async ({ expectedRevision, ownerUsername }) => ({
        revision: expectedRevision + 1,
        ownerUsername,
        configured: true,
        presence: "unknown" as const,
      })),
      subscribeOwnerIdentity: () => vi.fn(),
      getAccount: vi.fn(async () => ({ status: "signed_out" as const })),
      startChatGptLogin: vi.fn(async () => ({
        status: "pending" as const,
        attemptId: "opaque_attempt_1234",
        expiresAt: 60_000,
      })),
      cancelChatGptLogin: vi.fn(async (attemptId: string) => ({
        status: "cancelled" as const,
        attemptId,
      })),
      listModels: vi.fn(async () => ({
        models: [],
        selection: { mode: "automatic" as const },
        legacyMigrationCompleted: true,
      })),
      migrateModelPreference: vi.fn(async () => ({
        models: [],
        selection: { mode: "automatic" as const },
        legacyMigrationCompleted: true,
      })),
      selectModel: vi.fn(async () => ({ mode: "automatic" as const })),
      discoverPcl2: vi.fn(async () => []),
      detectLanCandidates: vi.fn(async () => []),
      confirmLanCandidate: vi.fn(async () => ({
        status: "confirmed" as const,
        port: 51321,
        version: "unknown",
        confirmedAt: 1_000,
      })),
      subscribeRuntime: (nextListener) => {
        listener = nextListener;
        return unsubscribe;
      },
    },
    emit: (event) =>
      listener?.(
        ("revision" in event
          ? event
          : ({ ...event, revision: nextRevision++ } as RuntimeEvent)) as DesktopRendererEvent,
      ),
    stopTask,
    emergencyStop,
    unsubscribe,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderApp(api: WhiteLilyDesktopApi): ReactElement {
  return <App api={api} />;
}

function revisionedSnapshot(snapshot: RuntimeSnapshot, revision: number): RuntimeSnapshot {
  return { ...snapshot, revision } as RuntimeSnapshot;
}

function revisionedEvent(event: RuntimeEventPayload, revision: number): RuntimeEvent {
  return { ...event, revision } as RuntimeEvent;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("bilingual control-center home", () => {
  it("shows the lease-free current task projection in Chinese", async () => {
    const { api } = createApiHarness();
    render(<HomePage api={api} locale="zh-CN" />);

    const heading = await screen.findByRole("heading", { name: "当前任务" });
    const card = heading.closest("section");
    expect(card).not.toBeNull();
    expect(within(card!).getByText("走到主人身边")).toBeTruthy();
    expect(within(card!).getByText("get_state")).toBeTruthy();
    expect(within(card!).getByText("move_to")).toBeTruthy();
    expect(within(card!).getByText("运行中")).toBeTruthy();
    expect(within(card!).getByText("20 次")).toBeTruthy();
    expect(
      (within(card!).getByRole("button", { name: "停止当前任务" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("stops one task once, disables duplicates, and applies the newer returned snapshot", async () => {
    const taskStop = deferred<RuntimeSnapshot>();
    const harness = createApiHarness({ taskStop: taskStop.promise });
    const user = userEvent.setup();
    render(<HomePage api={harness.api} locale="zh-CN" />);
    const button = await screen.findByRole("button", { name: "停止当前任务" });

    await user.click(button);
    await user.click(button);
    expect(harness.stopTask).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "正在停止任务" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    taskStop.resolve({ ...activeSnapshot, revision: 11, task: null });
    await taskStop.promise;
    await waitFor(() => expect(screen.queryByRole("button", { name: "停止当前任务" })).toBeNull());
  });

  it("does not let an older task-stop response revive a task after a newer event", async () => {
    const taskStop = deferred<RuntimeSnapshot>();
    const harness = createApiHarness({ taskStop: taskStop.promise });
    const user = userEvent.setup();
    render(<HomePage api={harness.api} locale="zh-CN" />);
    await user.click(await screen.findByRole("button", { name: "停止当前任务" }));

    act(() => {
      harness.emit(revisionedEvent({ kind: "task", task: null }, 12));
    });
    taskStop.resolve({ ...activeSnapshot, revision: 11 });
    await taskStop.promise;

    await waitFor(() => expect(screen.queryByRole("button", { name: "停止当前任务" })).toBeNull());
    expect(screen.queryByText("走到主人身边")).toBeNull();
  });

  it("shows a localized nonsecret task-stop error and keeps emergency stop available", async () => {
    const taskStop = deferred<RuntimeSnapshot>();
    const harness = createApiHarness({ taskStop: taskStop.promise });
    const user = userEvent.setup();
    render(<HomePage api={harness.api} locale="zh-CN" />);
    await user.click(await screen.findByRole("button", { name: "停止当前任务" }));

    taskStop.reject(new Error("lease-secret C:\\private\\prompt.txt"));
    await taskStop.promise.catch(() => undefined);

    expect(
      await screen.findByText("未能停止当前任务，请重试；必要时可使用紧急停止。"),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("lease-secret");
    expect((screen.getByRole("button", { name: "紧急停止" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("does not show a task-stop button without an active task", async () => {
    const { api } = createApiHarness({ snapshot: { ...activeSnapshot, task: null } });
    render(<HomePage api={api} locale="zh-CN" />);

    await screen.findByRole("heading", { name: "运行概览" });
    expect(screen.queryByRole("button", { name: "停止当前任务" })).toBeNull();
  });

  it("presents the exact authoritative owner and its offline waiting state", async () => {
    const { api } = createApiHarness();
    const ownerIdentity: OwnerIdentitySnapshot = {
      revision: 3,
      ownerUsername: "ExactCaseOwner",
      configured: true,
      presence: "offline",
    };

    render(<HomePage api={api} locale="en" ownerIdentity={ownerIdentity} />);

    expect(await screen.findByRole("heading", { name: "Owner" })).toBeTruthy();
    expect(screen.getByText("ExactCaseOwner")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("Waiting for the new owner to come online")).toBeTruthy();
  });

  it("does not invent an owner card for a defensive unconfigured snapshot", async () => {
    const { api } = createApiHarness();
    render(
      <HomePage
        api={api}
        locale="en"
        ownerIdentity={{
          revision: 0,
          ownerUsername: null,
          configured: false,
          presence: "unknown",
        }}
      />,
    );

    await screen.findByRole("heading", { name: "Runtime overview" });
    expect(screen.queryByRole("heading", { name: "Owner" })).toBeNull();
  });

  it("routes to onboarding when authoritative invalidation wins a pending older status", async () => {
    const status = deferred<RuntimeSnapshot>();
    const harness = createApiHarness({ status: status.promise });
    render(renderApp(harness.api));

    harness.emit({
      kind: "connection_invalidated",
      revision: 11,
      reason: "runtime_failed",
      snapshot: {
        ...stoppedSnapshot,
        revision: 11,
      },
    });

    await vi.waitFor(() => expect(document.querySelector(".onboarding")).not.toBeNull());
    status.resolve(activeSnapshot);
    await status.promise;
    await Promise.resolve();
    expect(document.querySelector(".onboarding")).not.toBeNull();
  });

  it("ignores an invalidation older than a newer accepted runtime event", async () => {
    const harness = createApiHarness({
      snapshot: revisionedSnapshot(activeSnapshot, 10),
    });
    render(renderApp(harness.api));
    await screen.findAllByText("已连接");

    act(() => {
      harness.emit(revisionedEvent({ kind: "lifecycle", state: "starting" }, 12));
      harness.emit({
        kind: "connection_invalidated",
        revision: 11,
        reason: "account_lost",
        snapshot: revisionedSnapshot(stoppedSnapshot, 11),
      });
    });

    expect(screen.getByRole("main").id).toBe("home");
    expect(document.querySelector(".onboarding")).toBeNull();
  });

  it("updates the model card from a runtime event without returning to onboarding", async () => {
    const harness = createApiHarness({ snapshot: revisionedSnapshot(activeSnapshot, 10) });
    render(renderApp(harness.api));
    await screen.findByText("gpt-5.6");

    act(() => {
      harness.emit(
        revisionedEvent({ kind: "codex", state: { state: "ready", model: "gpt-fast-live" } }, 11),
      );
    });

    expect(await screen.findByText("gpt-fast-live")).toBeTruthy();
    expect(screen.getByRole("main").id).toBe("home");
    expect(document.querySelector(".onboarding")).toBeNull();
  });

  it("replays and describes the latest action-capability event", async () => {
    const status = deferred<RuntimeSnapshot>();
    const harness = createApiHarness({ status: status.promise });
    const onInitialSnapshot = vi.fn();
    render(<HomePage api={harness.api} locale="en" onInitialSnapshot={onInitialSnapshot} />);
    const failedActions = {
      state: "failed" as const,
      workspaceVersion: "workspace-1",
      mcpListening: false,
      discoveredToolCount: 0,
      errorCode: "server_closed",
    };

    act(() => {
      harness.emit(revisionedEvent({ kind: "actions", state: failedActions }, 11));
    });
    await act(async () => {
      status.resolve(revisionedSnapshot(activeSnapshot, 10));
      await status.promise;
    });

    expect(onInitialSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 11, actions: failedActions }),
    );
    expect(
      within(screen.getByRole("region", { name: "Recent activity" })).getByText(
        "Minecraft actions changed to “Failed”",
      ),
    ).toBeTruthy();
  });

  it("ignores an unsafe invalidation without advancing high-water or routing", async () => {
    const harness = createApiHarness({
      snapshot: revisionedSnapshot(activeSnapshot, 10),
    });
    render(renderApp(harness.api));
    await vi.waitFor(() => expect(screen.getByRole("main").id).toBe("home"));

    act(() => {
      harness.emit({
        kind: "connection_invalidated",
        revision: 100,
        reason: "model_unavailable",
        snapshot: revisionedSnapshot(activeSnapshot, 100),
      });
    });
    expect(screen.getByRole("main").id).toBe("home");
    expect(document.querySelector(".onboarding")).toBeNull();

    act(() => {
      harness.emit({
        kind: "connection_invalidated",
        revision: 11,
        reason: "model_unavailable",
        snapshot: revisionedSnapshot(stoppedSnapshot, 11),
      });
    });
    await vi.waitFor(() => expect(document.querySelector(".onboarding")).not.toBeNull());
  });

  it.each([
    { label: "normal control", actionName: "停止伙伴", reason: "owner_stop" as const },
    { label: "emergency stop", actionName: "紧急停止", reason: "emergency_stop" as const },
  ])(
    "routes to onboarding when invalidation arrives during $label and ignores its late response",
    async ({ actionName, reason }) => {
      const control = deferred<RuntimeSnapshot>();
      const harness =
        reason === "emergency_stop"
          ? createApiHarness({ emergency: control.promise })
          : createApiHarness();
      if (reason === "owner_stop") harness.api.stop = vi.fn(() => control.promise);
      const user = userEvent.setup();
      render(renderApp(harness.api));
      await screen.findAllByText("已连接");

      await user.click(screen.getByRole("button", { name: actionName }));
      act(() => {
        harness.emit({
          kind: "connection_invalidated",
          revision: 11,
          reason,
          snapshot: revisionedSnapshot(stoppedSnapshot, 11),
        });
      });
      await vi.waitFor(() => expect(document.querySelector(".onboarding")).not.toBeNull());

      await act(async () => {
        control.resolve(revisionedSnapshot(activeSnapshot, 10));
        await control.promise;
      });
      expect(document.querySelector(".onboarding")).not.toBeNull();
    },
  );

  it("defaults to Chinese and renders the public runtime state cards", async () => {
    const { api } = createApiHarness();
    render(renderApp(api));

    await screen.findAllByText("已连接");

    const navigation = screen.getByRole("navigation", { name: "主导航" });
    expect(navigation).toBeTruthy();
    expect(navigation.textContent).not.toMatch(/[A-Za-z]/u);
    expect(screen.getByRole("heading", { name: "运行概览" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "当前世界" })).toBeTruthy();
    expect(screen.queryByText("session_7F2A")).toBeNull();
    expect(screen.getByRole("heading", { name: "伙伴模式" })).toBeTruthy();
    expect(screen.getAllByText("运行时未提供").length).toBe(3);
    expect(screen.getByRole("heading", { name: "模型" })).toBeTruthy();
    expect(screen.getByText("gpt-5.6")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "安全预设" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "任务预算" })).toBeTruthy();
    expect(screen.getByText("工具调用 7 / 20")).toBeTruthy();
    expect(screen.getByText("方块变更 24 / 80")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "工具调用 7 / 20" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "方块变更 24 / 80" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "水平移动 38 / 160" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "危险操作 0 / 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "紧急停止" })).toBeTruthy();
    expect(screen.queryByText("Emergency stop")).toBeNull();
  });

  it("switches every visible navigation, status, action, and empty-state label to English", async () => {
    const user = userEvent.setup();
    const { api } = createApiHarness();
    render(renderApp(api));
    await screen.findAllByText("已连接");

    await user.click(screen.getByRole("button", { name: "切换到英文" }));

    const navigation = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(navigation).toBeTruthy();
    expect(navigation.textContent).not.toMatch(/[\u3400-\u9fff]/u);
    expect(screen.getByRole("heading", { name: "Runtime overview" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Current world" })).toBeTruthy();
    expect(screen.queryByText("session_7F2A")).toBeNull();
    expect(screen.getByRole("heading", { name: "Companion mode" })).toBeTruthy();
    expect(screen.getAllByText("Not provided by runtime").length).toBe(3);
    expect(screen.getByRole("heading", { name: "Model" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Safety preset" })).toBeTruthy();
    expect(screen.getByText("Tool calls 7 / 20")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Tool calls 7 / 20" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Block changes 24 / 80" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Horizontal travel 38 / 160" })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Dangerous operations 0 / 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Emergency stop" })).toBeTruthy();
    const localeButton = screen.getByRole("button", { name: "Switch to Chinese" });
    expect(localeButton).toBeTruthy();
    expect(localeButton.textContent).not.toMatch(/[\u3400-\u9fff]/u);
    expect(screen.queryByText("已连接")).toBeNull();
    expect(screen.queryByText("运行时未提供")).toBeNull();
    expect(screen.queryByRole("button", { name: "紧急停止" })).toBeNull();
  });

  it("shows loading and localized failure states without exposing raw errors", async () => {
    const status = deferred<RuntimeSnapshot>();
    const { api } = createApiHarness({ status: status.promise });
    const user = userEvent.setup();
    render(renderApp(api));

    expect(screen.getByRole("status").textContent).toContain("正在读取运行状态");
    expect((screen.getByRole("button", { name: "紧急停止" }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    await act(async () => {
      status.reject(new Error("C:\\private\\runtime failed"));
      await status.promise.catch(() => undefined);
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("无法读取运行状态");
    expect(alert.textContent).not.toContain("C:\\private");
    expect(screen.getByText("运行失败")).toBeTruthy();
    expect((screen.getByRole("button", { name: "紧急停止" }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    await user.click(screen.getByRole("button", { name: "切换到英文" }));
    expect(screen.getByRole("alert").textContent).toContain("Runtime status is unavailable");
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText("无法读取运行状态")).toBeNull();
  });

  it("keeps emergency success authoritative when an older status succeeds later", async () => {
    const status = deferred<RuntimeSnapshot>();
    const emergency = deferred<RuntimeSnapshot>();
    const { api } = createApiHarness({ status: status.promise, emergency: emergency.promise });
    const user = userEvent.setup();
    render(renderApp(api));

    await user.click(screen.getByRole("button", { name: "紧急停止" }));
    await act(async () => {
      emergency.resolve(stoppedSnapshot);
      await emergency.promise;
      status.resolve(activeSnapshot);
      await status.promise;
    });

    expect(screen.getAllByText("已停止").length).toBeGreaterThan(0);
    expect(screen.queryByText("运行中")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores an older status failure after emergency success", async () => {
    const status = deferred<RuntimeSnapshot>();
    const emergency = deferred<RuntimeSnapshot>();
    const { api } = createApiHarness({ status: status.promise, emergency: emergency.promise });
    const user = userEvent.setup();
    render(renderApp(api));

    await user.click(screen.getByRole("button", { name: "紧急停止" }));
    await act(async () => {
      emergency.resolve(stoppedSnapshot);
      await emergency.promise;
      status.reject(new Error("stale status failure"));
      await status.promise.catch(() => undefined);
    });

    expect(screen.getAllByText("已停止").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows emergency failure instead of loading when it invalidates pending status", async () => {
    const status = deferred<RuntimeSnapshot>();
    const emergency = deferred<RuntimeSnapshot>();
    const { api, emit } = createApiHarness({
      status: status.promise,
      emergency: emergency.promise,
    });
    const user = userEvent.setup();
    render(renderApp(api));

    await user.click(screen.getByRole("button", { name: "紧急停止" }));
    await act(async () => {
      emergency.reject(new Error("emergency failure"));
      await emergency.promise.catch(() => undefined);
      status.resolve(activeSnapshot);
      await status.promise;
    });

    act(() => {
      for (let index = 0; index < 20; index += 1) {
        emit({ kind: "lifecycle", state: index === 19 ? "running" : "starting" });
        emit({
          kind: "minecraft",
          state: {
            state: index === 19 ? "reconnecting" : "connecting",
            sessionId: `session-buffer-${index}`,
          },
        });
        emit({
          kind: "codex",
          state: { state: index === 19 ? "failed" : "starting", model: null },
        });
        emit({ kind: "task", task: index === 19 ? activeSnapshot.task : null });
        emit({
          kind: "error",
          error: { code: `BUFFER_${index}`, message: `private-buffer-${index}` },
        });
      }
    });

    expect(screen.getByText("运行失败")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("紧急停止未能完成");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("运行中")).toBeNull();
    const activity = screen.getByRole("region", { name: "最近活动" });
    expect(within(activity).getAllByRole("listitem")).toHaveLength(5);
    expect(within(activity).getByText("运行状态变为“运行中”")).toBeTruthy();
    expect(within(activity).getByText("连接状态变为“正在重新连接”")).toBeTruthy();
    expect(within(activity).getByText("伙伴状态变为“伙伴不可用”")).toBeTruthy();
    expect(within(activity).getByText("任务已开始")).toBeTruthy();
    expect(within(activity).getByText(/BUFFER_19/u)).toBeTruthy();
    expect(activity.textContent).not.toContain("BUFFER_18");
    expect(activity.textContent).not.toContain("private-buffer");
  });

  it("replays the latest pre-status event for every disjoint snapshot field", async () => {
    const status = deferred<RuntimeSnapshot>();
    const { api, emit } = createApiHarness({ status: status.promise });
    render(renderApp(api));

    act(() => {
      emit({ kind: "lifecycle", state: "starting" });
      emit({ kind: "lifecycle", state: "running" });
      emit({
        kind: "minecraft",
        state: { state: "reconnecting", sessionId: "session-latest" },
      });
      emit({ kind: "codex", state: { state: "failed", model: null } });
      emit({ kind: "task", task: null });
      emit({
        kind: "error",
        error: { code: "PRE_STATUS_LATEST", message: "private-pre-status" },
      });
    });

    await act(async () => {
      status.resolve(stoppedSnapshot);
      await status.promise;
    });

    expect(screen.getAllByText("运行中").length).toBeGreaterThan(0);
    expect(screen.getAllByText("正在重新连接").length).toBeGreaterThan(0);
    expect(screen.getAllByText("伙伴不可用").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/PRE_STATUS_LATEST/u)).toHaveLength(2);
    expect(screen.getByRole("main").textContent).not.toContain("private-pre-status");
  });

  it("does not let an older buffered event regress a newer running status snapshot", async () => {
    const status = deferred<RuntimeSnapshot>();
    const { api, emit } = createApiHarness({ status: status.promise });
    render(renderApp(api));

    act(() => {
      emit(revisionedEvent({ kind: "lifecycle", state: "starting" }, 5));
    });
    await act(async () => {
      status.resolve(revisionedSnapshot(activeSnapshot, 6));
      await status.promise;
    });

    await waitFor(() => expect(screen.getByRole("main").id).toBe("home"));
  });

  it("applies a newer buffered event sampled after an older status snapshot", async () => {
    const status = deferred<RuntimeSnapshot>();
    const { api, emit } = createApiHarness({ status: status.promise });
    render(renderApp(api));

    act(() => {
      emit(revisionedEvent({ kind: "lifecycle", state: "running" }, 6));
    });
    await act(async () => {
      status.resolve(revisionedSnapshot(stoppedSnapshot, 5));
      await status.promise;
    });

    await waitFor(() => expect(screen.getByRole("main").id).toBe("home"));
  });

  it("does not let an older control response regress a newer runtime event", async () => {
    const normalStop = deferred<RuntimeSnapshot>();
    const harness = createApiHarness({
      snapshot: revisionedSnapshot(activeSnapshot, 10),
    });
    harness.api.stop = vi.fn(() => normalStop.promise);
    const user = userEvent.setup();
    render(renderApp(harness.api));

    await screen.findByRole("button", { name: "切换到英文" });
    await user.click(screen.getByRole("button", { name: "切换到英文" }));
    await user.click(screen.getByRole("button", { name: "Stop companion" }));
    act(() => {
      harness.emit(revisionedEvent({ kind: "lifecycle", state: "starting" }, 12));
    });
    await act(async () => {
      normalStop.resolve(revisionedSnapshot(stoppedSnapshot, 11));
      await normalStop.promise;
    });

    expect(screen.getByRole("button", { name: "Stop companion" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start companion" })).toBeNull();
  });

  it("clears a prior status failure after emergency success", async () => {
    const status = deferred<RuntimeSnapshot>();
    const emergency = deferred<RuntimeSnapshot>();
    const { api } = createApiHarness({ status: status.promise, emergency: emergency.promise });
    const user = userEvent.setup();
    render(renderApp(api));

    await act(async () => {
      status.reject(new Error("status failure"));
      await status.promise.catch(() => undefined);
    });
    expect(screen.getByRole("alert").textContent).toContain("无法读取运行状态");

    await user.click(screen.getByRole("button", { name: "紧急停止" }));
    await act(async () => {
      emergency.resolve(stoppedSnapshot);
      await emergency.promise;
    });

    expect(screen.getAllByText("已停止").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retranslates a normal-control failure when the locale changes", async () => {
    const normalStop = deferred<RuntimeSnapshot>();
    const harness = createApiHarness();
    harness.api.stop = vi.fn(() => normalStop.promise);
    const user = userEvent.setup();
    render(renderApp(harness.api));
    await screen.findAllByText("已连接");

    await user.click(screen.getByRole("button", { name: "停止伙伴" }));
    await act(async () => {
      normalStop.reject(new Error("private control failure"));
      await normalStop.promise.catch(() => undefined);
    });
    expect(screen.getByRole("alert").textContent).toContain("无法更新伙伴运行状态");

    await user.click(screen.getByRole("button", { name: "切换到英文" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not update the companion runtime",
    );
    expect(screen.queryByText("无法更新伙伴运行状态。")).toBeNull();
  });

  it("retranslates an emergency failure when the locale changes", async () => {
    const emergency = deferred<RuntimeSnapshot>();
    const harness = createApiHarness({ emergency: emergency.promise });
    const user = userEvent.setup();
    render(renderApp(harness.api));
    await screen.findAllByText("已连接");

    await user.click(screen.getByRole("button", { name: "紧急停止" }));
    await act(async () => {
      emergency.reject(new Error("private emergency failure"));
      await emergency.promise.catch(() => undefined);
    });
    expect(screen.getByRole("alert").textContent).toContain("紧急停止未能完成");

    await user.click(screen.getByRole("button", { name: "切换到英文" }));
    expect(screen.getByRole("alert").textContent).toContain("Emergency stop did not complete");
    expect(screen.queryByText("紧急停止未能完成，请立即退出 WhiteLily。")).toBeNull();
  });

  it("keeps only the five most recent validated runtime events", async () => {
    const { api, emit } = createApiHarness();
    render(renderApp(api));
    await screen.findAllByText("已连接");

    act(() => {
      for (let index = 1; index <= 7; index += 1) {
        emit({ kind: "error", error: { code: `EVENT_${index}`, message: `private-${index}` } });
      }
    });

    const activity = screen.getByRole("region", { name: "最近活动" });
    expect(within(activity).getAllByRole("listitem")).toHaveLength(5);
    expect(within(activity).queryByText(/EVENT_1/u)).toBeNull();
    expect(within(activity).queryByText(/EVENT_2/u)).toBeNull();
    for (let index = 3; index <= 7; index += 1) {
      expect(within(activity).getByText(new RegExp(`EVENT_${index}`, "u"))).toBeTruthy();
    }
    expect(activity.textContent).not.toContain("private-");
  });

  it("unsubscribes from runtime events when the page unmounts", async () => {
    const { api, unsubscribe } = createApiHarness();
    const view = render(renderApp(api));
    await screen.findAllByText("已连接");

    view.unmount();
    view.unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("invokes emergency stop on one click and blocks duplicate in-flight clicks", async () => {
    const emergency = deferred<RuntimeSnapshot>();
    const confirm = vi.spyOn(window, "confirm");
    const { api, emergencyStop } = createApiHarness({ emergency: emergency.promise });
    const user = userEvent.setup();
    render(renderApp(api));
    await screen.findAllByText("已连接");

    const button = screen.getByRole("button", { name: "紧急停止" });
    await user.click(button);
    await user.click(button);

    expect(emergencyStop).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "正在紧急停止" })).toBeTruthy();

    await act(async () => {
      emergency.resolve(stoppedSnapshot);
      await emergency.promise;
    });

    await waitFor(() => {
      expect(screen.getAllByText("已停止").length).toBeGreaterThan(0);
    });
  });

  it("keeps emergency stop available while a normal runtime control is in flight", async () => {
    const normalStop = deferred<RuntimeSnapshot>();
    const emergency = deferred<RuntimeSnapshot>();
    const harness = createApiHarness({ emergency: emergency.promise });
    harness.api.stop = vi.fn(() => normalStop.promise);
    const user = userEvent.setup();
    render(renderApp(harness.api));
    await screen.findAllByText("已连接");

    await user.click(screen.getByRole("button", { name: "停止伙伴" }));
    const emergencyButton = screen.getByRole("button", { name: "紧急停止" });
    expect((emergencyButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(emergencyButton);

    expect(harness.emergencyStop).toHaveBeenCalledTimes(1);

    await act(async () => {
      emergency.resolve(stoppedSnapshot);
      await emergency.promise;
      normalStop.resolve(activeSnapshot);
      await normalStop.promise;
    });

    expect(screen.getAllByText("已停止").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "停止伙伴" })).toBeNull();
  });

  it("uses accessible landmarks and exposes no high-risk autonomous quick action", async () => {
    const { api } = createApiHarness();
    render(renderApp(api));
    await screen.findAllByText("已连接");

    const main = screen.getByRole("main");
    const content = screen.getByRole("region", { name: "运行概览" });
    const safetyRail = screen.getByRole("region", { name: "紧急停止" });
    expect(main.firstElementChild).toBe(content);
    expect(main.lastElementChild).toBe(safetyRail);
    expect(content.parentElement).toBe(main);
    expect(safetyRail.parentElement).toBe(main);
    expect(within(safetyRail).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "系统状态" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "最近活动" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /高风险|自主|high.?risk|autonomous/iu }),
    ).toBeNull();
  });

  it("updates subscribed state without React act warnings", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { api, emit } = createApiHarness();
    render(renderApp(api));
    await screen.findAllByText("已连接");

    act(() => {
      emit({ kind: "minecraft", state: { state: "reconnecting", sessionId: "session_7F2A" } });
    });

    await screen.findAllByText("正在重新连接");
    expect(
      consoleError.mock.calls.some(([message]) => String(message).includes("not wrapped in act")),
    ).toBe(false);
  });

  it.each(["resolve", "reject"] as const)(
    "cleans each StrictMode subscription once when deferred requests %s after unmount",
    async (settlement) => {
      const staleStatus = deferred<RuntimeSnapshot>();
      const normalStop = deferred<RuntimeSnapshot>();
      const emergency = deferred<RuntimeSnapshot>();
      const cleanups: Array<ReturnType<typeof vi.fn<() => void>>> = [];
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const unhandled = vi.fn();
      window.addEventListener("unhandledrejection", unhandled);
      let statusCall = 0;
      const api: WhiteLilyDesktopApi = {
        status: vi.fn(() => {
          statusCall += 1;
          return statusCall === 1 ? staleStatus.promise : Promise.resolve(activeSnapshot);
        }),
        start: vi.fn(async () => activeSnapshot),
        stop: vi.fn(() => normalStop.promise),
        stopTask: vi.fn(async () => activeSnapshot),
        emergencyStop: vi.fn(() => emergency.promise),
        readOwnerIdentity: vi.fn(async () => ({
          revision: 0,
          ownerUsername: null,
          configured: false,
          presence: "unknown" as const,
        })),
        updateOwnerIdentity: vi.fn(async ({ expectedRevision, ownerUsername }) => ({
          revision: expectedRevision + 1,
          ownerUsername,
          configured: true,
          presence: "unknown" as const,
        })),
        subscribeOwnerIdentity: () => vi.fn(),
        getAccount: vi.fn(async () => ({ status: "signed_out" as const })),
        startChatGptLogin: vi.fn(async () => ({
          status: "pending" as const,
          attemptId: "opaque_attempt_1234",
          expiresAt: 60_000,
        })),
        cancelChatGptLogin: vi.fn(async (attemptId: string) => ({
          status: "cancelled" as const,
          attemptId,
        })),
        listModels: vi.fn(async () => ({
          models: [],
          selection: { mode: "automatic" as const },
          legacyMigrationCompleted: true,
        })),
        migrateModelPreference: vi.fn(async () => ({
          models: [],
          selection: { mode: "automatic" as const },
          legacyMigrationCompleted: true,
        })),
        selectModel: vi.fn(async () => ({ mode: "automatic" as const })),
        discoverPcl2: vi.fn(async () => []),
        detectLanCandidates: vi.fn(async () => []),
        confirmLanCandidate: vi.fn(async () => ({
          status: "confirmed" as const,
          port: 51321,
          version: "unknown",
          confirmedAt: 1_000,
        })),
        subscribeRuntime: () => {
          const unsubscribe = vi.fn();
          cleanups.push(unsubscribe);
          return unsubscribe;
        },
      };
      const user = userEvent.setup();
      const view = render(
        <StrictMode>
          <App api={api} />
        </StrictMode>,
      );
      await screen.findAllByText("已连接");
      await user.click(screen.getByRole("button", { name: "停止伙伴" }));
      await user.click(screen.getByRole("button", { name: "紧急停止" }));
      expect(api.emergencyStop).toHaveBeenCalledTimes(1);

      view.unmount();
      expect(cleanups).toHaveLength(2);
      expect(cleanups.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);

      await act(async () => {
        if (settlement === "resolve") {
          staleStatus.resolve(activeSnapshot);
          normalStop.resolve(stoppedSnapshot);
          emergency.resolve(stoppedSnapshot);
        } else {
          staleStatus.reject(new Error("stale status rejected"));
          normalStop.reject(new Error("normal control rejected"));
          emergency.reject(new Error("emergency rejected"));
        }
        await Promise.allSettled([staleStatus.promise, normalStop.promise, emergency.promise]);
      });

      expect(unhandled).not.toHaveBeenCalled();
      expect(
        consoleError.mock.calls.some(([message]) =>
          /not wrapped in act|unmounted component|state update/iu.test(String(message)),
        ),
      ).toBe(false);
      window.removeEventListener("unhandledrejection", unhandled);
    },
  );
});
