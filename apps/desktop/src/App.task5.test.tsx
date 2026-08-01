import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerIdentitySnapshot } from "../../../src/identity/ownerIdentity.js";
import type { DesktopRendererEvent, WhiteLilyAppApi } from "./desktopApi.js";
import App from "./App.js";
import { ONBOARDING_STORAGE_KEY, persistOnboardingLocale } from "./pages/OnboardingPage.js";

type OwnerAuthoritySnapshot = OwnerIdentitySnapshot & { childGeneration: number };

const runningSnapshot = {
  revision: 1,
  lifecycle: "running" as const,
  minecraft: { state: "connected" as const, sessionId: "session" },
  codex: { state: "ready" as const, model: "live-model" },
  task: null,
  lastError: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createAppApi(
  ownerRead: Promise<OwnerAuthoritySnapshot> = Promise.resolve(owner("OldOwner")),
) {
  const ownerListeners = new Set<(snapshot: OwnerAuthoritySnapshot) => void>();
  const runtimeListeners = new Set<(event: DesktopRendererEvent) => void>();
  const ownerUnsubscribe = vi.fn();
  let retainedOwnerListener: ((snapshot: OwnerAuthoritySnapshot) => void) | undefined;
  const api = {
    status: vi.fn(async () => runningSnapshot),
    start: vi.fn(async () => runningSnapshot),
    stop: vi.fn(async () => runningSnapshot),
    emergencyStop: vi.fn(async () => runningSnapshot),
    getAccount: vi.fn(async () => ({ status: "signed_out" as const })),
    startChatGptLogin: vi.fn(),
    cancelChatGptLogin: vi.fn(),
    listModels: vi.fn(async () => ({ models: [], selection: { mode: "automatic" as const } })),
    selectModel: vi.fn(),
    discoverPcl2: vi.fn(async () => []),
    detectLanCandidates: vi.fn(async () => []),
    confirmLanCandidate: vi.fn(),
    subscribeRuntime: vi.fn((listener) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    }),
    readOwnerIdentity: vi.fn(() => ownerRead),
    updateOwnerIdentity: vi.fn(async ({ expectedRevision, ownerUsername }) => ({
      revision: expectedRevision + 1,
      ownerUsername,
      configured: true,
      presence: "unknown" as const,
      childGeneration: 1,
    })),
    subscribeOwnerIdentity: vi.fn((listener) => {
      retainedOwnerListener = listener;
      ownerListeners.add(listener);
      return () => {
        ownerListeners.delete(listener);
        ownerUnsubscribe();
      };
    }),
    readProfile: vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: 1,
      updatedAt: "2026-07-29T00:00:00.000Z",
      value: {
        id: "8af32ca8-d1d7-4d87-b684-f6aaf04fb907",
        displayName: "White Lily",
        language: "en",
        tone: "Warm",
        preferredTopics: [],
        avoidedTopics: [],
        persona: "",
        mode: "friend" as const,
        modeSettings: {
          friend: {
            idleMinutes: 120,
            allowProactiveChat: false,
            allowSuggestions: false,
            allowLowRiskMicroActions: false,
          },
          balanced: {
            idleMinutes: 2,
            allowProactiveChat: true,
            allowSuggestions: true,
            allowLowRiskMicroActions: false,
          },
          autonomous: {
            idleMinutes: 1,
            allowProactiveChat: true,
            allowSuggestions: true,
            allowLowRiskMicroActions: true,
          },
        },
        modelPreference: { mode: "automatic" as const },
      },
    })),
    readStartupSetting: vi.fn(async () => ({ enabled: false, available: true })),
    setStartupSetting: vi.fn(async (enabled) => ({ enabled, available: true })),
    readCloseToTraySetting: vi.fn(async () => ({ revision: 0, enabled: true })),
    setCloseToTraySetting: vi.fn(async ({ expectedRevision, enabled }) => ({
      revision: expectedRevision + 1,
      enabled,
    })),
    readWorldProfile: vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: 0,
      updatedAt: "2026-07-30T00:00:00.000Z",
      value: null,
    })),
    bindConfirmedWorld: vi.fn(),
    updateSafetyProfile: vi.fn(),
  } as unknown as WhiteLilyAppApi;
  return {
    api,
    emitOwner(snapshot: OwnerAuthoritySnapshot) {
      for (const listener of ownerListeners) listener(snapshot);
    },
    emitRetainedOwner(snapshot: OwnerAuthoritySnapshot) {
      retainedOwnerListener?.(snapshot);
    },
    emitRuntime(event: DesktopRendererEvent) {
      for (const listener of runtimeListeners) listener(event);
    },
    ownerUnsubscribe,
  };
}

function owner(
  ownerUsername: string,
  revision = 2,
  presence: OwnerIdentitySnapshot["presence"] = "online",
  childGeneration = 1,
): OwnerAuthoritySnapshot {
  return { revision, ownerUsername, configured: true, presence, childGeneration };
}

describe("Task 5 application routing", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("routes fixed sidebar destinations and returns to onboarding after connection invalidation", async () => {
    const listeners = new Set<(event: DesktopRendererEvent) => void>();
    const api = {
      status: vi.fn(async () => ({
        revision: 1,
        lifecycle: "running",
        minecraft: { state: "connected", sessionId: "session" },
        codex: { state: "ready", model: "live-model" },
        task: null,
        lastError: null,
      })),
      start: vi.fn(),
      stop: vi.fn(),
      emergencyStop: vi.fn(),
      getAccount: vi.fn(async () => ({ status: "signed_out" })),
      startChatGptLogin: vi.fn(),
      cancelChatGptLogin: vi.fn(),
      listModels: vi.fn(async () => ({ models: [], selection: { mode: "automatic" } })),
      selectModel: vi.fn(),
      discoverPcl2: vi.fn(async () => []),
      detectLanCandidates: vi.fn(async () => []),
      confirmLanCandidate: vi.fn(),
      readOwnerIdentity: vi.fn(async () => owner("OldOwner")),
      updateOwnerIdentity: vi.fn(),
      subscribeOwnerIdentity: vi.fn(() => vi.fn()),
      subscribeRuntime: vi.fn((next) => {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      }),
      readProfile: vi.fn(async () => ({
        schemaVersion: 1,
        revision: 1,
        updatedAt: "2026-07-29T00:00:00.000Z",
        value: {
          id: "8af32ca8-d1d7-4d87-b684-f6aaf04fb907",
          displayName: "White Lily",
          language: "en",
          tone: "Warm",
          preferredTopics: [],
          avoidedTopics: [],
          persona: "",
          mode: "friend",
          modeSettings: {
            friend: {
              idleMinutes: 120,
              allowProactiveChat: false,
              allowSuggestions: false,
              allowLowRiskMicroActions: false,
            },
            balanced: {
              idleMinutes: 2,
              allowProactiveChat: true,
              allowSuggestions: true,
              allowLowRiskMicroActions: false,
            },
            autonomous: {
              idleMinutes: 1,
              allowProactiveChat: true,
              allowSuggestions: true,
              allowLowRiskMicroActions: true,
            },
          },
          modelPreference: { mode: "automatic" },
        },
      })),
    } as unknown as WhiteLilyAppApi;

    render(<App api={api} />);
    await screen.findByRole("heading", { name: "运行概览" });
    await userEvent.click(screen.getByRole("link", { name: "伙伴设定" }));
    expect(await screen.findByRole("heading", { name: "伙伴设定" })).toBeTruthy();
    expect(screen.getAllByRole("link", { current: "page" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "伙伴设定" }).getAttribute("aria-current")).toBe(
      "page",
    );

    const invalidation: DesktopRendererEvent = {
      kind: "connection_invalidated",
      reason: "lan_changed",
      revision: 2,
      snapshot: {
        revision: 2,
        lifecycle: "stopped",
        minecraft: { state: "disconnected", sessionId: null },
        codex: { state: "stopped", model: null },
        task: null,
        lastError: null,
      },
    };
    for (const next of listeners) next(invalidation);
    expect(await screen.findByText("首次设置")).toBeTruthy();
  });

  it("keeps the newest owner revision when the initial read races a live event", async () => {
    persistOnboardingLocale("en");
    const pendingRead = deferred<OwnerAuthoritySnapshot>();
    const harness = createAppApi(pendingRead.promise);

    render(<App api={harness.api} />);
    await screen.findByRole("heading", { name: "Runtime overview" });
    await waitFor(() => expect(harness.api.subscribeOwnerIdentity).toHaveBeenCalledOnce());

    act(() => harness.emitOwner(owner("NewOwner", 3, "offline")));
    expect(await screen.findByText("NewOwner")).toBeTruthy();
    expect(screen.getByText("Waiting for the new owner to come online")).toBeTruthy();

    await act(async () => pendingRead.resolve(owner("EqualReadOwner", 3, "online")));
    expect(screen.queryByText("EqualReadOwner")).toBeNull();
    expect(screen.getByText("NewOwner")).toBeTruthy();

    act(() => harness.emitOwner(owner("OlderOwner", 2, "online")));
    expect(screen.queryByText("OlderOwner")).toBeNull();

    act(() => harness.emitOwner(owner("NewOwner", 3, "online")));
    expect(await screen.findByText("Online")).toBeTruthy();
    expect(screen.queryByText("Waiting for the new owner to come online")).toBeNull();

    act(() =>
      harness.emitRuntime({
        kind: "codex",
        revision: 2,
        state: { state: "ready", model: "runtime-revision-is-independent" },
      }),
    );
    expect(await screen.findByText("runtime-revision-is-independent")).toBeTruthy();
  });

  it("accepts an initial read that is newer than a pre-read owner event", async () => {
    persistOnboardingLocale("en");
    const pendingRead = deferred<OwnerAuthoritySnapshot>();
    const harness = createAppApi(pendingRead.promise);

    render(<App api={harness.api} />);
    await screen.findByRole("heading", { name: "Runtime overview" });
    await waitFor(() => expect(harness.api.subscribeOwnerIdentity).toHaveBeenCalledOnce());
    act(() => harness.emitOwner(owner("EventOwner", 3, "offline")));
    expect(await screen.findByText("EventOwner")).toBeTruthy();

    await act(async () => pendingRead.resolve(owner("ReadOwner", 4, "online")));
    expect(await screen.findByText("ReadOwner")).toBeTruthy();
    expect(screen.queryByText("EventOwner")).toBeNull();
  });

  it("creates one owner subscription across route changes and removes it on unmount", async () => {
    persistOnboardingLocale("en");
    const harness = createAppApi();
    const view = render(<App api={harness.api} />);
    await screen.findByRole("heading", { name: "Runtime overview" });
    await waitFor(() => expect(harness.api.subscribeOwnerIdentity).toHaveBeenCalledOnce());

    await userEvent.click(screen.getByRole("link", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings" });
    await userEvent.click(screen.getByRole("link", { name: "Home" }));
    await screen.findByRole("heading", { name: "Runtime overview" });
    expect(harness.api.subscribeOwnerIdentity).toHaveBeenCalledOnce();

    view.unmount();
    expect(harness.ownerUnsubscribe).toHaveBeenCalledOnce();
    act(() => harness.emitRetainedOwner(owner("AfterUnmount", 99, "online")));
    await waitFor(() => expect(screen.queryByText("AfterUnmount")).toBeNull());
  });

  it("invalidates a pending direct update when an earlier live event changes authority", async () => {
    persistOnboardingLocale("en");
    const pendingUpdate = deferred<OwnerIdentitySnapshot>();
    const harness = createAppApi();
    vi.mocked(harness.api.updateOwnerIdentity).mockImplementation(() => pendingUpdate.promise);
    render(<App api={harness.api} />);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Runtime overview" });
    await user.click(screen.getByRole("link", { name: "Settings" }));
    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "ResponseOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    act(() => harness.emitOwner(owner("EventOwner", 3, "offline")));
    expect(
      await screen.findByText(
        "Owner identity changed elsewhere. Review the latest owner and confirm again.",
      ),
    ).toBeTruthy();
    await act(async () => pendingUpdate.resolve(owner("ResponseOwner", 3, "online")));
    expect(screen.queryByText("Owner switched.")).toBeNull();
    await user.click(screen.getByRole("link", { name: "Home" }));

    expect(await screen.findByText("EventOwner")).toBeTruthy();
    expect(screen.queryByText("ResponseOwner")).toBeNull();
    expect(screen.getByText("Waiting for the new owner to come online")).toBeTruthy();
  });

  it("lets a same-revision live event refresh a direct update response", async () => {
    persistOnboardingLocale("en");
    const harness = createAppApi();
    vi.mocked(harness.api.updateOwnerIdentity).mockResolvedValue(owner("NewOwner", 3, "online"));
    render(<App api={harness.api} />);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Runtime overview" });
    await user.click(screen.getByRole("link", { name: "Settings" }));
    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));
    await screen.findByText("Owner switched.");
    await user.click(screen.getByRole("link", { name: "Home" }));
    expect(await screen.findByText("Online")).toBeTruthy();

    act(() => harness.emitOwner(owner("NewOwner", 3, "offline")));
    expect(await screen.findByText("Offline")).toBeTruthy();
    expect(screen.getByText("Waiting for the new owner to come online")).toBeTruthy();
  });

  it("recovers an unknown owner update after a restarted child publishes authority", async () => {
    persistOnboardingLocale("en");
    const harness = createAppApi();
    vi.mocked(harness.api.updateOwnerIdentity).mockRejectedValue(
      new Error("WhiteLily child request timed out after 10000ms"),
    );
    vi.mocked(harness.api.readOwnerIdentity)
      .mockResolvedValueOnce(owner("OldOwner", 7, "online", 1))
      .mockRejectedValueOnce(new Error("WhiteLily child is quarantined until process exit"));
    render(<App api={harness.api} />);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Runtime overview" });
    await user.click(screen.getByRole("link", { name: "Settings" }));
    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    expect(
      await screen.findByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();
    expect(screen.queryByText("OldOwner")).toBeNull();

    await user.click(screen.getByRole("link", { name: "Home" }));
    expect(await screen.findByRole("heading", { name: "Runtime overview" })).toBeTruthy();
    expect(screen.queryByText("OldOwner")).toBeNull();
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(
      await screen.findByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();

    act(() => harness.emitOwner(owner("OldOwner", 0, "offline", 1)));
    expect(
      screen.getByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();
    expect(screen.queryByText("OldOwner")).toBeNull();

    act(() => harness.emitOwner(owner("NewOwner", 0, "offline", 2)));
    expect(await screen.findByText("NewOwner")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "New owner username" })).toBeTruthy();
    expect(
      screen.queryByText("Owner status is unknown. Refresh before switching again."),
    ).toBeNull();

    act(() => harness.emitOwner(owner("NewOwner", 1, "online", 2)));
    expect(await screen.findByText("Online")).toBeTruthy();
    act(() => harness.emitOwner(owner("OldOwner", 0, "offline", 2)));
    expect(screen.getByText("NewOwner")).toBeTruthy();
    expect(screen.queryByText("OldOwner")).toBeNull();
  });

  it("does not let a stale initial owner read clear an ambiguous owner state", async () => {
    persistOnboardingLocale("en");
    const initialRead = deferred<OwnerAuthoritySnapshot>();
    const harness = createAppApi(initialRead.promise);
    vi.mocked(harness.api.readOwnerIdentity)
      .mockImplementationOnce(() => initialRead.promise)
      .mockRejectedValueOnce(new Error("WhiteLily child is quarantined until process exit"));
    vi.mocked(harness.api.updateOwnerIdentity).mockRejectedValue(
      new Error("WhiteLily child request timed out after 10000ms"),
    );
    render(<App api={harness.api} />);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Runtime overview" });
    await waitFor(() => expect(harness.api.subscribeOwnerIdentity).toHaveBeenCalledTimes(1));
    act(() => harness.emitOwner(owner("OldOwner", 2, "online")));
    await user.click(screen.getByRole("link", { name: "Settings" }));
    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));
    expect(
      await screen.findByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();

    await act(async () => initialRead.resolve(owner("OldOwner", 2, "online")));

    expect(
      screen.getByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();
    expect(screen.queryByText("OldOwner")).toBeNull();

    await user.click(screen.getByRole("link", { name: "Home" }));
    expect(await screen.findByRole("heading", { name: "Runtime overview" })).toBeTruthy();
    expect(screen.queryByText("OldOwner")).toBeNull();
    await user.click(screen.getByRole("link", { name: "World & safety" }));
    expect(await screen.findByRole("heading", { name: "World & safety" })).toBeTruthy();
    expect(screen.queryByText("OldOwner")).toBeNull();
  });

  it("lets an explicit reconciliation replace a previous-generation high revision with zero", async () => {
    persistOnboardingLocale("en");
    const initialRead = deferred<OwnerAuthoritySnapshot>();
    const harness = createAppApi(initialRead.promise);
    vi.mocked(harness.api.readOwnerIdentity)
      .mockImplementationOnce(() => initialRead.promise)
      .mockRejectedValueOnce(new Error("WhiteLily child is quarantined until process exit"))
      .mockResolvedValueOnce(owner("NewOwner", 0, "offline", 2));
    vi.mocked(harness.api.updateOwnerIdentity).mockRejectedValue(
      new Error("WhiteLily child request timed out after 10000ms"),
    );
    render(<App api={harness.api} />);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Runtime overview" });
    await waitFor(() => expect(harness.api.subscribeOwnerIdentity).toHaveBeenCalledTimes(1));
    act(() => harness.emitOwner(owner("OldOwner", 7, "online", 1)));
    await user.click(screen.getByRole("link", { name: "Settings" }));
    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));
    expect(
      await screen.findByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();
    await act(async () => initialRead.resolve(owner("OldOwner", 7, "online", 1)));

    await user.click(screen.getByRole("button", { name: "Refresh owner status" }));

    expect(await screen.findByText("NewOwner")).toBeTruthy();
    expect(screen.queryByText("OldOwner")).toBeNull();
    expect(screen.getByText("Offline")).toBeTruthy();
  });

  it.each([
    {
      label: "an older child generation",
      refresh: owner("OtherOwner", 99, "online", 1),
    },
    {
      label: "a regressed revision in the current child generation",
      refresh: owner("OtherOwner", 4, "online", 2),
    },
  ])("keeps owner status unknown after refresh returns $label", async ({ refresh }) => {
    persistOnboardingLocale("en");
    const current = owner("OldOwner", 5, "online", 2);
    const harness = createAppApi(Promise.resolve(current));
    vi.mocked(harness.api.readOwnerIdentity)
      .mockResolvedValueOnce(current)
      .mockRejectedValueOnce(new Error("WhiteLily child is quarantined until process exit"))
      .mockResolvedValueOnce(refresh);
    vi.mocked(harness.api.updateOwnerIdentity).mockRejectedValue(
      new Error("WhiteLily child request timed out after 10000ms"),
    );
    render(<App api={harness.api} />);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Runtime overview" });
    expect(await screen.findByText("OldOwner")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Settings" }));
    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));
    expect(
      await screen.findByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Refresh owner status" }));

    expect(
      await screen.findByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();
    expect(screen.queryByText("OldOwner")).toBeNull();
    expect(screen.queryByText("OtherOwner")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "New owner username" })).toBeNull();
  });

  it("omits the previous owner while main re-enters after onboarding changed authority", async () => {
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        locale: "en",
        progressHint: "ready",
        modelPreference: { mode: "automatic" },
      }),
    );
    const reentryRead = deferred<OwnerAuthoritySnapshot>();
    const harness = createAppApi();
    vi.mocked(harness.api.readOwnerIdentity)
      .mockResolvedValueOnce(owner("OldOwner", 2, "online"))
      .mockResolvedValueOnce(owner("OldOwner", 2, "online"))
      .mockImplementation(() => reentryRead.promise);
    vi.mocked(harness.api.getAccount).mockResolvedValue({
      status: "signed_in",
      auth: "chatgpt",
    });
    vi.mocked(harness.api.listModels).mockResolvedValue({
      models: [
        {
          id: "gpt-live",
          displayName: "GPT Live",
          supportedReasoningEfforts: ["low"],
        },
      ],
      selection: { mode: "automatic" },
    });
    vi.mocked(harness.api.selectModel).mockResolvedValue({ mode: "automatic" });
    vi.mocked(harness.api.discoverPcl2).mockResolvedValue([
      {
        id: "pcl2_candidate_01",
        displayPath: "Plain Craft Launcher 2.exe",
        source: "running_process",
        running: true,
      },
    ]);
    vi.mocked(harness.api.detectLanCandidates).mockResolvedValue([
      {
        id: "lan_candidate_0001",
        port: 51_321,
        version: "1.21.5",
        observedAt: 1_753_603_200_000,
        expiresAt: 1_753_603_260_000,
      },
    ]);
    vi.mocked(harness.api.confirmLanCandidate).mockResolvedValue({
      status: "confirmed",
      port: 51_321,
      version: "1.21.5",
      confirmedAt: 1_753_603_200_100,
    });
    render(<App api={harness.api} />);

    expect(await screen.findByText("OldOwner")).toBeTruthy();
    act(() =>
      harness.emitRuntime({
        kind: "connection_invalidated",
        reason: "lan_changed",
        revision: 2,
        snapshot: {
          revision: 2,
          lifecycle: "stopped",
          minecraft: { state: "disconnected", sessionId: null },
          codex: { state: "stopped", model: null },
          task: null,
          lastError: null,
        },
      }),
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Confirm and connect: port 51321, Minecraft 1.21.5",
      }),
    );
    await screen.findByRole("heading", { name: "Runtime overview" });
    expect(screen.queryByText("OldOwner")).toBeNull();

    await act(async () => reentryRead.resolve(owner("NewOwner", 3, "offline")));
    expect(await screen.findByText("NewOwner")).toBeTruthy();
    expect(screen.getByText("Waiting for the new owner to come online")).toBeTruthy();
  });

  it("blocks and hides the full sidebar until owner confirmation closes", async () => {
    persistOnboardingLocale("en");
    const harness = createAppApi();
    render(<App api={harness.api} />);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Runtime overview" });
    const homeLink = screen.getByRole("link", { name: "Home" });
    const localeButton = screen.getByRole("button", { name: "Switch to Chinese" });
    await user.click(screen.getByRole("link", { name: "Settings" }));
    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));

    const sidebar = document.querySelector(".sidebar");
    expect(sidebar?.hasAttribute("inert")).toBe(true);
    expect(sidebar?.getAttribute("aria-hidden")).toBe("true");
    expect((homeLink as HTMLAnchorElement).tabIndex).toBe(-1);
    expect((localeButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();

    const confirm = screen.getByRole("button", { name: "Confirm switch" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(confirm);

    await user.click(homeLink);
    expect(screen.queryByRole("heading", { name: "Runtime overview" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.click(localeButton);
    expect(screen.getByRole("button", { name: "Confirm switch" })).toBeTruthy();

    await user.click(cancel);
    expect(sidebar?.hasAttribute("inert")).toBe(false);
    expect(sidebar?.hasAttribute("aria-hidden")).toBe(false);
    expect((homeLink as HTMLAnchorElement).tabIndex).toBe(0);
    expect((localeButton as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeTruthy();
    await user.click(homeLink);
    expect(await screen.findByRole("heading", { name: "Runtime overview" })).toBeTruthy();
  });
});
