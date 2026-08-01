import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSnapshot } from "../../../../src/codex/accountService";
import type { ModelCatalogSnapshot, ModelSelection } from "../../../../src/codex/modelCatalog";
import type { RuntimeSnapshot } from "../../../../src/runtime/runtimeEvents";
import type { Pcl2Candidate } from "../../src-main/discovery/pcl2Discovery";
import type { ConfirmedLanSession, LanCandidate } from "../../src-main/discovery/lanDetector";
import App from "../App";
import { LanCandidateCard } from "../components/LanCandidateCard";
import { ModelPicker } from "../components/ModelPicker";
import type { WhiteLilyDesktopApi } from "../desktopApi";
import { ONBOARDING_STORAGE_KEY, OnboardingPage, safeOnboardingErrorKey } from "./OnboardingPage";

const stoppedSnapshot: RuntimeSnapshot = {
  revision: 10,
  lifecycle: "stopped",
  minecraft: { state: "disconnected", sessionId: null },
  codex: { state: "stopped", model: null },
  task: null,
  lastError: null,
};

const runningSnapshot: RuntimeSnapshot = {
  revision: 20,
  lifecycle: "running",
  minecraft: { state: "connected", sessionId: "private-session" },
  codex: { state: "ready", model: "gpt-live" },
  task: null,
  lastError: null,
};

const liveCatalog: ModelCatalogSnapshot = {
  models: [
    {
      id: "gpt-live",
      displayName: "GPT Live",
      supportedReasoningEfforts: ["low", "high"],
    },
    {
      id: "gpt-calm",
      displayName: "GPT Calm",
      supportedReasoningEfforts: ["medium"],
    },
  ],
  selection: { mode: "automatic" },
};

const pcl2Candidate: Pcl2Candidate = {
  id: "pcl2_candidate_01",
  displayPath: "Plain Craft Launcher 2.exe",
  source: "running_process",
  running: true,
};

const lanCandidate: LanCandidate = {
  id: "lan_candidate_0001",
  port: 51_321,
  version: "1.21.5",
  observedAt: 1_753_603_200_000,
  expiresAt: 1_753_603_260_000,
};

const unknownLanCandidate: LanCandidate = {
  ...lanCandidate,
  id: "lan_candidate_0002",
  port: 51_322,
  version: "unknown",
};

interface ApiHarness {
  api: WhiteLilyDesktopApi;
  getAccount: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["getAccount"]>>;
  startChatGptLogin: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["startChatGptLogin"]>>;
  cancelChatGptLogin: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["cancelChatGptLogin"]>>;
  listModels: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["listModels"]>>;
  selectModel: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["selectModel"]>>;
  discoverPcl2: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["discoverPcl2"]>>;
  detectLanCandidates: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["detectLanCandidates"]>>;
  confirmLanCandidate: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["confirmLanCandidate"]>>;
  start: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["start"]>>;
  readOwnerIdentity: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["readOwnerIdentity"]>>;
  updateOwnerIdentity: ReturnType<typeof vi.fn<WhiteLilyDesktopApi["updateOwnerIdentity"]>>;
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

function createApiHarness(
  options: {
    status?: RuntimeSnapshot | readonly RuntimeSnapshot[];
    account?: AccountSnapshot | readonly AccountSnapshot[];
    catalog?: ModelCatalogSnapshot;
    pcl2?: readonly Pcl2Candidate[];
    lan?: readonly LanCandidate[] | readonly (readonly LanCandidate[])[];
    confirm?: ConfirmedLanSession | Error;
    start?: RuntimeSnapshot | Error;
    owner?: Awaited<ReturnType<WhiteLilyDesktopApi["readOwnerIdentity"]>> | Error;
    ownerUpdate?: Error;
  } = {},
): ApiHarness {
  const statuses = Array.isArray(options.status)
    ? [...options.status]
    : [options.status ?? stoppedSnapshot];
  const finalStatus = statuses.at(-1) ?? stoppedSnapshot;
  const accounts = Array.isArray(options.account)
    ? [...options.account]
    : [options.account ?? { status: "signed_in", auth: "chatgpt" }];
  const lanResults =
    options.lan && Array.isArray(options.lan[0])
      ? [...(options.lan as readonly (readonly LanCandidate[])[])]
      : [(options.lan as readonly LanCandidate[] | undefined) ?? []];

  const status = vi.fn<WhiteLilyDesktopApi["status"]>(async () => {
    return statuses.shift() ?? finalStatus;
  });
  const getAccount = vi.fn<WhiteLilyDesktopApi["getAccount"]>(async () => {
    return accounts.shift() ?? accounts.at(-1) ?? { status: "signed_in", auth: "chatgpt" };
  });
  const startChatGptLogin = vi.fn<WhiteLilyDesktopApi["startChatGptLogin"]>(async () => ({
    status: "pending",
    attemptId: "opaque_attempt_1234",
    expiresAt: Date.now() + 60_000,
  }));
  const cancelChatGptLogin = vi.fn<WhiteLilyDesktopApi["cancelChatGptLogin"]>(
    async (attemptId) => ({ status: "cancelled", attemptId }),
  );
  const listModels = vi.fn<WhiteLilyDesktopApi["listModels"]>(
    async () => options.catalog ?? liveCatalog,
  );
  const selectModel = vi.fn<WhiteLilyDesktopApi["selectModel"]>(
    async (selection): Promise<ModelSelection> =>
      selection.mode === "automatic" ? { mode: "automatic" } : { ...selection, available: true },
  );
  const discoverPcl2 = vi.fn<WhiteLilyDesktopApi["discoverPcl2"]>(async () => options.pcl2 ?? []);
  const detectLanCandidates = vi.fn<WhiteLilyDesktopApi["detectLanCandidates"]>(
    async () => lanResults.shift() ?? [],
  );
  const confirmLanCandidate = vi.fn<WhiteLilyDesktopApi["confirmLanCandidate"]>(async () => {
    if (options.confirm instanceof Error) throw options.confirm;
    return (
      options.confirm ?? {
        status: "confirmed",
        port: 51_321,
        version: "1.21.5",
        confirmedAt: Date.now(),
      }
    );
  });
  const start = vi.fn<WhiteLilyDesktopApi["start"]>(async () => {
    if (options.start instanceof Error) throw options.start;
    return options.start ?? runningSnapshot;
  });
  const readOwnerIdentity = vi.fn<WhiteLilyDesktopApi["readOwnerIdentity"]>(async () => {
    if (options.owner instanceof Error) throw options.owner;
    return (
      options.owner ?? {
        revision: 0,
        ownerUsername: null,
        configured: false,
        presence: "unknown" as const,
      }
    );
  });
  const updateOwnerIdentity = vi.fn<WhiteLilyDesktopApi["updateOwnerIdentity"]>(
    async ({ expectedRevision, ownerUsername }) => {
      if (options.ownerUpdate) throw options.ownerUpdate;
      return {
        revision: expectedRevision + 1,
        ownerUsername,
        configured: true,
        presence: "unknown" as const,
      };
    },
  );

  return {
    api: {
      status,
      start,
      stop: vi.fn(async () => stoppedSnapshot),
      stopTask: vi.fn(async () => stoppedSnapshot),
      emergencyStop: vi.fn(async () => stoppedSnapshot),
      readOwnerIdentity,
      updateOwnerIdentity,
      subscribeOwnerIdentity: () => vi.fn(),
      getAccount,
      startChatGptLogin,
      cancelChatGptLogin,
      listModels,
      selectModel,
      discoverPcl2,
      detectLanCandidates,
      confirmLanCandidate,
      subscribeRuntime: () => vi.fn(),
    },
    getAccount,
    startChatGptLogin,
    cancelChatGptLogin,
    listModels,
    selectModel,
    discoverPcl2,
    detectLanCandidates,
    confirmLanCandidate,
    start,
    readOwnerIdentity,
    updateOwnerIdentity,
  };
}

async function reachOwner(harness: ApiHarness, language: "zh-CN" | "en" = "zh-CN"): Promise<void> {
  const user = userEvent.setup();
  render(<App api={harness.api} />);
  await screen.findByRole("heading", { name: "选择智能模型" });
  if (language === "en") {
    await user.click(screen.getByRole("button", { name: "English" }));
  }
  await user.click(
    screen.getByRole("button", {
      name: language === "en" ? "Continue to owner identity" : "继续确认主人身份",
    }),
  );
  await screen.findByRole("heading", {
    name: language === "en" ? "Who should WhiteLily listen to?" : "谁是白百合的主人？",
  });
}

async function reachPcl2(harness: ApiHarness): Promise<void> {
  await reachOwner(harness);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Minecraft Java 用户名"), "NewOwner");
  await user.click(screen.getByRole("button", { name: "确认主人身份" }));
  await screen.findByRole("heading", { name: "检查 PCL2" });
}

async function reachLan(harness: ApiHarness): Promise<void> {
  await reachPcl2(harness);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "继续查找局域网世界" }));
  await screen.findByRole("heading", { name: "连接局域网世界" });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("first-run onboarding", () => {
  it("adds a seven-step owner confirmation without persisting the exact-case username", async () => {
    const harness = createApiHarness();
    const user = userEvent.setup();
    render(<App api={harness.api} />);

    await screen.findByRole("heading", { name: "选择智能模型" });
    await user.click(screen.getByRole("button", { name: "English" }));
    const progress = screen.getByRole("navigation", { name: "First-time setup progress" });
    expect(within(progress).getAllByRole("listitem")).toHaveLength(7);
    expect(progress.textContent).toBe("✓Environment✓Sign in3Model4Owner5PCL26LAN world7Ready");
    await user.click(screen.getByRole("button", { name: "Continue to owner identity" }));

    const heading = await screen.findByRole("heading", {
      name: "Who should WhiteLily listen to?",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const input = screen.getByLabelText("Minecraft Java username");
    expect(input.getAttribute("aria-describedby")).toBe("owner-help owner-error");
    expect(screen.getByText("Enter 3–16 English letters, numbers, or underscores.")).toBeTruthy();
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Confirm owner identity" }));

    await screen.findByRole("heading", { name: "Check PCL2" });
    expect(harness.readOwnerIdentity).toHaveBeenCalledTimes(1);
    expect(harness.updateOwnerIdentity).toHaveBeenCalledWith({
      expectedRevision: 0,
      ownerUsername: "NewOwner",
    });
    const stored = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
    expect(stored).not.toContain("NewOwner");
    expect(Object.keys(JSON.parse(stored!)).sort()).toEqual([
      "locale",
      "modelPreference",
      "progressHint",
      "version",
    ]);
  });

  it("rejects malformed, placeholder, and bot-collision usernames before submission", async () => {
    const harness = createApiHarness();
    await reachOwner(harness, "en");
    const input = screen.getByLabelText("Minecraft Java username");
    const confirm = screen.getByRole("button", { name: "Confirm owner identity" });

    for (const invalid of [
      "ab",
      "a".repeat(17),
      "主人名",
      "Owner Name",
      "YourMcName",
      "yOuRmCnAmE",
    ]) {
      fireEvent.change(input, { target: { value: invalid } });
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByText(/Enter a valid Minecraft Java username/u)).toBeTruthy();
    }

    fireEvent.change(input, { target: { value: "wHiTeLiLy" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/WhiteLily is reserved for the bot/u)).toBeTruthy();
    expect(harness.updateOwnerIdentity).not.toHaveBeenCalled();
  });

  it("prefills a configured owner exactly and preserves edited submission case", async () => {
    const harness = createApiHarness({
      owner: {
        revision: 8,
        ownerUsername: "ExistingOwner",
        configured: true,
        presence: "offline",
      },
      pcl2: [],
    });
    await reachOwner(harness, "en");
    const user = userEvent.setup();
    const input = screen.getByLabelText("Minecraft Java username");

    expect((input as HTMLInputElement).value).toBe("ExistingOwner");
    await user.clear(input);
    await user.type(input, "eDiTeDOwner");
    await user.click(screen.getByRole("button", { name: "Confirm owner identity" }));

    await screen.findByRole("heading", { name: "Check PCL2" });
    expect(harness.updateOwnerIdentity).toHaveBeenCalledWith({
      expectedRevision: 8,
      ownerUsername: "eDiTeDOwner",
    });
  });

  it.each([
    [
      "OWNER_IDENTITY_CONFIG_CONFLICT",
      "The owner identity changed elsewhere. Return to this step and try again.",
    ],
    [
      "OWNER_IDENTITY_WRITE_FAILED",
      "WhiteLily could not save the owner identity. Check write permissions and try again.",
    ],
    [
      "OWNER_IDENTITY_CONFIG_INVALID",
      "WhiteLily's owner configuration is invalid. Repair the config, then try again.",
    ],
  ])(
    "maps %s to bounded owner guidance and focuses the rejected-save alert",
    async (code, copy) => {
      const secret = "private://config token=secret";
      const harness = createApiHarness({ ownerUpdate: new Error(`${code}: ${secret}`) });
      await reachOwner(harness, "en");
      const user = userEvent.setup();
      await user.type(screen.getByLabelText("Minecraft Java username"), "NewOwner");
      await user.click(screen.getByRole("button", { name: "Confirm owner identity" }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(copy);
      await waitFor(() => expect(document.activeElement).toBe(alert));
      expect(document.body.textContent).not.toContain(secret);
      expect(screen.getByRole("heading", { name: "Who should WhiteLily listen to?" })).toBeTruthy();
    },
  );

  it.each([
    [
      "OWNER_IDENTITY_CONFIG_INVALID",
      "WhiteLily's owner configuration is invalid. Repair the config, then try again.",
    ],
    ["ECONNREFUSED", "The WhiteLily core is unavailable. Restart WhiteLily, then try again."],
  ])("bounds owner read failure %s without leaking details", async (code, copy) => {
    const secret = "private-token-and-config-path";
    const harness = createApiHarness({ owner: new Error(`${code}: ${secret}`) });
    await reachOwner(harness, "en");

    expect((await screen.findByRole("alert")).textContent).toBe(copy);
    expect(document.body.textContent).not.toContain(secret);
    expect(
      (screen.getByRole("button", { name: "Confirm owner identity" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("suppresses a double submit while the owner update is pending", async () => {
    const pending = deferred<Awaited<ReturnType<WhiteLilyDesktopApi["updateOwnerIdentity"]>>>();
    const harness = createApiHarness();
    harness.updateOwnerIdentity.mockImplementation(() => pending.promise);
    await reachOwner(harness, "en");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Minecraft Java username"), "NewOwner");
    const confirm = screen.getByRole("button", { name: "Confirm owner identity" });

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(harness.updateOwnerIdentity).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Saving" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    pending.resolve({
      revision: 1,
      ownerUsername: "NewOwner",
      configured: true,
      presence: "unknown",
    });
    await screen.findByRole("heading", { name: "Check PCL2" });
  });

  it.each([
    ["success", "before resume"],
    ["success", "after resume"],
    ["failure", "before resume"],
    ["failure", "after resume"],
  ] as const)(
    "resets a pending owner save on close and fences its stale %s settled %s",
    async (outcome, settleTiming) => {
      const staleUpdate =
        deferred<Awaited<ReturnType<WhiteLilyDesktopApi["updateOwnerIdentity"]>>>();
      const harness = createApiHarness();
      harness.readOwnerIdentity
        .mockResolvedValueOnce({
          revision: 0,
          ownerUsername: null,
          configured: false,
          presence: "unknown",
        })
        .mockResolvedValueOnce({
          revision: 7,
          ownerUsername: "CurrentOwner",
          configured: true,
          presence: "offline",
        });
      harness.updateOwnerIdentity
        .mockImplementationOnce(() => staleUpdate.promise)
        .mockImplementation(async ({ expectedRevision, ownerUsername }) => ({
          revision: expectedRevision + 1,
          ownerUsername,
          configured: true,
          presence: "unknown",
        }));
      const onReady = vi.fn();
      const view = render(
        <OnboardingPage api={harness.api} locale="en" active onReady={onReady} />,
      );
      const user = userEvent.setup();

      await screen.findByRole("heading", { name: "Choose an AI model" });
      await user.click(screen.getByRole("button", { name: "Continue to owner identity" }));
      await screen.findByRole("heading", { name: "Who should WhiteLily listen to?" });
      await user.type(screen.getByLabelText("Minecraft Java username"), "FirstOwner");
      await user.click(screen.getByRole("button", { name: "Confirm owner identity" }));
      expect((screen.getByRole("button", { name: "Saving" }) as HTMLButtonElement).disabled).toBe(
        true,
      );

      view.rerender(
        <OnboardingPage api={harness.api} locale="en" active={false} onReady={onReady} />,
      );
      await screen.findByRole("heading", { name: "Checking WhiteLily" });

      const settleStaleUpdate = async (): Promise<void> => {
        if (outcome === "success") {
          staleUpdate.resolve({
            revision: 1,
            ownerUsername: "FirstOwner",
            configured: true,
            presence: "unknown",
          });
          await staleUpdate.promise;
        } else {
          staleUpdate.reject(new Error("OWNER_IDENTITY_WRITE_FAILED: private stale detail"));
          await staleUpdate.promise.catch(() => undefined);
        }
      };
      if (settleTiming === "before resume") {
        await act(settleStaleUpdate);
      }

      view.rerender(<OnboardingPage api={harness.api} locale="en" active onReady={onReady} />);
      await screen.findByRole("heading", { name: "Choose an AI model" });
      await user.click(screen.getByRole("button", { name: "Continue to owner identity" }));
      await screen.findByRole("heading", { name: "Who should WhiteLily listen to?" });
      await waitFor(() => expect(harness.readOwnerIdentity).toHaveBeenCalledTimes(2));
      const resumedInput = screen.getByLabelText("Minecraft Java username") as HTMLInputElement;
      expect(resumedInput.value).toBe("CurrentOwner");

      if (settleTiming === "after resume") {
        await act(settleStaleUpdate);
      }

      expect(screen.getByRole("heading", { name: "Who should WhiteLily listen to?" })).toBeTruthy();
      expect(resumedInput.value).toBe("CurrentOwner");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("heading", { name: "Check PCL2" })).toBeNull();
      expect(document.body.textContent).not.toContain("private stale detail");
      const confirm = screen.getByRole("button", {
        name: "Confirm owner identity",
      }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(false);

      await user.click(confirm);
      expect(harness.updateOwnerIdentity).toHaveBeenLastCalledWith({
        expectedRevision: 7,
        ownerUsername: "CurrentOwner",
      });
      await screen.findByRole("heading", { name: "Check PCL2" });
    },
  );

  it.each(["success", "failure"] as const)(
    "does not let stale %s cleanup clear a newer pending owner save",
    async (staleOutcome) => {
      const staleUpdate =
        deferred<Awaited<ReturnType<WhiteLilyDesktopApi["updateOwnerIdentity"]>>>();
      const newerUpdate =
        deferred<Awaited<ReturnType<WhiteLilyDesktopApi["updateOwnerIdentity"]>>>();
      const harness = createApiHarness();
      harness.readOwnerIdentity
        .mockResolvedValueOnce({
          revision: 0,
          ownerUsername: null,
          configured: false,
          presence: "unknown",
        })
        .mockResolvedValueOnce({
          revision: 9,
          ownerUsername: "CurrentOwner",
          configured: true,
          presence: "unknown",
        });
      harness.updateOwnerIdentity
        .mockImplementationOnce(() => staleUpdate.promise)
        .mockImplementationOnce(() => newerUpdate.promise);
      const onReady = vi.fn();
      const view = render(
        <OnboardingPage api={harness.api} locale="en" active onReady={onReady} />,
      );
      const user = userEvent.setup();

      await screen.findByRole("heading", { name: "Choose an AI model" });
      await user.click(screen.getByRole("button", { name: "Continue to owner identity" }));
      await screen.findByRole("heading", { name: "Who should WhiteLily listen to?" });
      await user.type(screen.getByLabelText("Minecraft Java username"), "FirstOwner");
      await user.click(screen.getByRole("button", { name: "Confirm owner identity" }));

      view.rerender(
        <OnboardingPage api={harness.api} locale="en" active={false} onReady={onReady} />,
      );
      await screen.findByRole("heading", { name: "Checking WhiteLily" });
      view.rerender(<OnboardingPage api={harness.api} locale="en" active onReady={onReady} />);
      await screen.findByRole("heading", { name: "Choose an AI model" });
      await user.click(screen.getByRole("button", { name: "Continue to owner identity" }));
      await screen.findByRole("heading", { name: "Who should WhiteLily listen to?" });
      await user.click(screen.getByRole("button", { name: "Confirm owner identity" }));
      expect(harness.updateOwnerIdentity).toHaveBeenCalledTimes(2);
      expect((screen.getByRole("button", { name: "Saving" }) as HTMLButtonElement).disabled).toBe(
        true,
      );

      await act(async () => {
        if (staleOutcome === "success") {
          staleUpdate.resolve({
            revision: 1,
            ownerUsername: "FirstOwner",
            configured: true,
            presence: "unknown",
          });
          await staleUpdate.promise;
        } else {
          staleUpdate.reject(new Error("OWNER_IDENTITY_WRITE_FAILED: stale private detail"));
          await staleUpdate.promise.catch(() => undefined);
        }
      });

      expect(harness.updateOwnerIdentity).toHaveBeenLastCalledWith({
        expectedRevision: 9,
        ownerUsername: "CurrentOwner",
      });
      expect((screen.getByRole("button", { name: "Saving" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(document.body.textContent).not.toContain("stale private detail");

      newerUpdate.resolve({
        revision: 10,
        ownerUsername: "CurrentOwner",
        configured: true,
        presence: "unknown",
      });
      await screen.findByRole("heading", { name: "Check PCL2" });
    },
  );

  it("resumes the owner step from a privacy-safe hint without storing a username", async () => {
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        locale: "en",
        progressHint: "owner",
        modelPreference: { mode: "automatic" },
      }),
    );
    const harness = createApiHarness();
    render(<App api={harness.api} />);

    expect(
      await screen.findByRole("heading", { name: "Who should WhiteLily listen to?" }),
    ).toBeTruthy();
    expect(harness.readOwnerIdentity).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toMatch(
      /ownerUsername|NewOwner/u,
    );
  });

  it("migrates a pre-owner v1 downstream hint back to mandatory owner confirmation", async () => {
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        locale: "en",
        progressHint: "pcl2",
        modelPreference: { mode: "automatic" },
      }),
    );
    const harness = createApiHarness({
      owner: {
        revision: 0,
        ownerUsername: null,
        configured: false,
        presence: "unknown",
      },
    });
    render(<App api={harness.api} />);

    expect(
      await screen.findByRole("heading", { name: "Who should WhiteLily listen to?" }),
    ).toBeTruthy();
    expect(harness.readOwnerIdentity).toHaveBeenCalledTimes(1);
    expect(harness.discoverPcl2).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject({
      version: 2,
      progressHint: "owner",
    });
  });

  it("keeps the owner input disabled until the authoritative prefill finishes loading", async () => {
    const pending = deferred<Awaited<ReturnType<WhiteLilyDesktopApi["readOwnerIdentity"]>>>();
    const harness = createApiHarness();
    harness.readOwnerIdentity.mockImplementation(() => pending.promise);
    const user = userEvent.setup();
    render(<App api={harness.api} />);
    await screen.findByRole("heading", { name: "选择智能模型" });
    await user.click(screen.getByRole("button", { name: "继续确认主人身份" }));

    await screen.findByRole("heading", { name: "谁是白百合的主人？" });
    const input = screen.getByLabelText("Minecraft Java 用户名") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    pending.resolve({
      revision: 3,
      ownerUsername: "ExactOwner",
      configured: true,
      presence: "unknown",
    });
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(input.value).toBe("ExactOwner");
  });

  it("cancels a login intent clicked before the start response and fences the late attempt", async () => {
    const lateAttempt = deferred<Extract<AccountSnapshot, { status: "pending" }>>();
    const harness = createApiHarness({ account: { status: "signed_out" } });
    const startLogin = vi.fn(() => lateAttempt.promise);
    harness.api.startChatGptLogin = startLogin;
    const user = userEvent.setup();
    render(<App api={harness.api} />);

    await screen.findByRole("heading", { name: /ChatGPT/u });
    await user.click(screen.getByRole("button", { name: "English" }));
    await user.click(screen.getByRole("button", { name: "Sign in with system browser" }));
    await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));

    lateAttempt.resolve({
      status: "pending",
      attemptId: "opaque_attempt_1234",
      expiresAt: Date.now() + 60_000,
    });
    await waitFor(() => {
      expect(harness.cancelChatGptLogin).toHaveBeenCalledWith("opaque_attempt_1234");
    });
    expect(screen.getByRole("heading", { name: "Sign in to ChatGPT" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Choose an AI model" })).toBeNull();
    expect(harness.getAccount).toHaveBeenCalledTimes(1);
  });

  it("retires and cancels a known attempt when account polling rejects", async () => {
    const harness = createApiHarness({ account: { status: "signed_out" } });
    const user = userEvent.setup();
    render(<App api={harness.api} />);

    await screen.findByRole("heading", { name: /ChatGPT/u });
    await user.click(screen.getByRole("button", { name: "English" }));
    harness.getAccount.mockRejectedValueOnce(new Error(String.raw`C:\private\poll failure`));
    await user.click(screen.getByRole("button", { name: "Sign in with system browser" }));

    await screen.findByRole("alert");
    expect(harness.cancelChatGptLogin).toHaveBeenCalledWith("opaque_attempt_1234");
    expect(screen.getByRole("button", { name: "Sign in with system browser" })).toBeTruthy();
    expect(document.body.textContent).not.toContain(String.raw`C:\private`);
  });

  it("retires and cancels an attempt whose polling deadline has already expired", async () => {
    const harness = createApiHarness({ account: { status: "signed_out" } });
    harness.api.startChatGptLogin = vi.fn(
      async (): Promise<Extract<AccountSnapshot, { status: "pending" }>> => ({
        status: "pending",
        attemptId: "opaque_attempt_1234",
        expiresAt: Date.now() - 1,
      }),
    );
    const user = userEvent.setup();
    render(<App api={harness.api} />);

    await screen.findByRole("heading", { name: /ChatGPT/u });
    await user.click(screen.getByRole("button", { name: "English" }));
    await user.click(screen.getByRole("button", { name: "Sign in with system browser" }));

    await screen.findByRole("alert");
    expect(harness.cancelChatGptLogin).toHaveBeenCalledWith("opaque_attempt_1234");
    expect(harness.getAccount).toHaveBeenCalledTimes(1);
  });

  it("starts in Chinese, opens the controlled browser login, and advances only after live sign-in", async () => {
    const harness = createApiHarness({
      account: [
        { status: "signed_out" },
        { status: "pending", attemptId: "opaque_attempt_1234", expiresAt: Date.now() + 60_000 },
        { status: "signed_in", auth: "chatgpt" },
      ],
    });
    const user = userEvent.setup();

    render(<App api={harness.api} />);

    expect(await screen.findByRole("heading", { name: "登录 ChatGPT" })).toBeTruthy();
    expect(screen.getAllByText(/系统浏览器/u)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "在系统浏览器中登录" }));

    expect(harness.startChatGptLogin).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "选择智能模型" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("opaque_attempt_1234");
    expect(document.body.textContent).not.toMatch(/https?:\/\//u);
  });

  it("shows only live service labels and applies model plus reasoning selections", async () => {
    const harness = createApiHarness();
    const user = userEvent.setup();
    render(<App api={harness.api} />);

    await screen.findByRole("heading", { name: "选择智能模型" });
    const model = screen.getByRole("combobox", { name: "模型" });
    expect(within(model).getByRole("option", { name: "自动选择" })).toBeTruthy();
    expect(within(model).getByRole("option", { name: "GPT Live" })).toBeTruthy();
    expect(within(model).getByRole("option", { name: "GPT Calm" })).toBeTruthy();
    expect(screen.queryByText("gpt-5.6")).toBeNull();

    await user.selectOptions(model, "gpt-live");
    await waitFor(() => {
      expect(harness.selectModel).toHaveBeenCalledWith({
        mode: "explicit",
        modelId: "gpt-live",
        reasoningEffort: "low",
      });
    });
    await user.selectOptions(screen.getByRole("combobox", { name: "推理强度" }), "high");
    await waitFor(() => {
      expect(harness.selectModel).toHaveBeenLastCalledWith({
        mode: "explicit",
        modelId: "gpt-live",
        reasoningEffort: "high",
      });
    });
    expect(screen.getByRole("status").textContent).toContain("GPT Live");
  });

  it("supports automatic selection and never invents a fallback model", async () => {
    const harness = createApiHarness({
      catalog: {
        ...liveCatalog,
        selection: {
          mode: "explicit",
          modelId: "gpt-live",
          reasoningEffort: "low",
          available: true,
        },
      },
    });
    const user = userEvent.setup();
    render(<App api={harness.api} />);

    await screen.findByRole("heading", { name: "选择智能模型" });
    await user.selectOptions(screen.getByRole("combobox", { name: "模型" }), "automatic");

    await waitFor(() => {
      expect(harness.selectModel).toHaveBeenLastCalledWith({ mode: "automatic" });
    });
    expect(screen.getByRole("status").textContent).toContain("自动选择");
  });

  it("restores a persisted explicit preference only after the live selection succeeds", async () => {
    window.localStorage.setItem(
      "whitelily.onboarding.v1",
      JSON.stringify({
        version: 2,
        locale: "zh-CN",
        progressHint: "model",
        modelPreference: {
          mode: "explicit",
          modelId: "gpt-live",
          reasoningEffort: "high",
        },
      }),
    );
    const harness = createApiHarness();
    render(<App api={harness.api} />);

    await screen.findByRole("heading", { name: "选择智能模型" });
    expect(harness.selectModel).toHaveBeenCalledWith({
      mode: "explicit",
      modelId: "gpt-live",
      reasoningEffort: "high",
    });
    expect(screen.getByRole("status").textContent).toContain("GPT Live · high");
  });

  it("clears a missing persisted model and applies automatic selection to live authority", async () => {
    window.localStorage.setItem(
      "whitelily.onboarding.v1",
      JSON.stringify({
        version: 2,
        locale: "zh-CN",
        progressHint: "model",
        modelPreference: {
          mode: "explicit",
          modelId: "gpt-removed",
          reasoningEffort: "high",
        },
      }),
    );
    const harness = createApiHarness({
      catalog: {
        ...liveCatalog,
        selection: {
          mode: "explicit",
          modelId: "gpt-live",
          reasoningEffort: "low",
          available: true,
        },
      },
    });
    render(<App api={harness.api} />);

    await screen.findByRole("heading", { name: "选择智能模型" });
    expect(harness.selectModel).toHaveBeenCalledWith({ mode: "automatic" });
    expect(screen.getByRole("status").textContent).toContain("自动选择");
    expect(JSON.parse(window.localStorage.getItem("whitelily.onboarding.v1")!)).toMatchObject({
      modelPreference: null,
    });
  });

  it("blocks progress when the live account returns no usable models", async () => {
    const harness = createApiHarness({
      catalog: { models: [], selection: { mode: "automatic" } },
    });
    render(<App api={harness.api} />);

    await screen.findByRole("heading", { name: "选择智能模型" });
    expect(screen.getByRole("alert").textContent).toContain("模型列表");
    expect(screen.queryByRole("button", { name: "继续检查 PCL2" })).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("shares an in-flight catalog retry even when two clicks arrive before React commits", async () => {
    const retryCatalog = deferred<ModelCatalogSnapshot>();
    const harness = createApiHarness();
    harness.listModels
      .mockResolvedValueOnce({ models: [], selection: { mode: "automatic" } })
      .mockImplementationOnce(() => retryCatalog.promise);
    render(<App api={harness.api} />);

    const retry = await screen.findByRole("button", { name: "重试" });
    fireEvent.click(retry);
    fireEvent.click(retry);

    await waitFor(() => expect(harness.listModels).toHaveBeenCalledTimes(2));
    expect((retry as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      retryCatalog.resolve(liveCatalog);
      await retryCatalog.promise;
    });
    expect(await screen.findByRole("combobox", { name: "模型" })).toBeTruthy();
  });

  it("lets a locale-triggered latest catalog intent own UI, storage, step, and final model authority", async () => {
    const older = deferred<ModelCatalogSnapshot>();
    const latest = deferred<ModelCatalogSnapshot>();
    const harness = createApiHarness();
    harness.listModels
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => latest.promise);
    window.localStorage.setItem(
      "whitelily.onboarding.v1",
      JSON.stringify({
        version: 2,
        locale: "zh-CN",
        progressHint: "model",
        modelPreference: {
          mode: "explicit",
          modelId: "latest-model",
          reasoningEffort: "high",
        },
      }),
    );
    const user = userEvent.setup();
    render(<App api={harness.api} />);
    await waitFor(() => expect(harness.listModels).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(harness.listModels).toHaveBeenCalledTimes(2));

    await act(async () => {
      latest.resolve({
        models: [
          {
            id: "latest-model",
            displayName: "Latest Service Model",
            supportedReasoningEfforts: ["high"],
          },
        ],
        selection: { mode: "automatic" },
      });
      await latest.promise;
    });
    expect(await screen.findByRole("option", { name: "Latest Service Model" })).toBeTruthy();

    await act(async () => {
      older.resolve({
        models: [
          {
            id: "older-model",
            displayName: "Older Service Model",
            supportedReasoningEfforts: ["low"],
          },
        ],
        selection: { mode: "automatic" },
      });
      await older.promise;
    });

    expect(screen.queryByRole("option", { name: "Older Service Model" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Choose an AI model" })).toBeTruthy();
    expect(harness.selectModel).toHaveBeenLastCalledWith({
      mode: "explicit",
      modelId: "latest-model",
      reasoningEffort: "high",
    });
    expect(JSON.parse(window.localStorage.getItem("whitelily.onboarding.v1")!)).toMatchObject({
      locale: "en",
      progressHint: "model",
      modelPreference: {
        mode: "explicit",
        modelId: "latest-model",
        reasoningEffort: "high",
      },
    });
    expect(harness.discoverPcl2).not.toHaveBeenCalled();
  });

  it("reapplies the latest model choice after a stale catalog selection was already sent", async () => {
    const staleSelection = deferred<ModelSelection>();
    const latestSelection = deferred<ModelSelection>();
    const harness = createApiHarness();
    harness.listModels
      .mockResolvedValueOnce({
        models: [
          {
            id: "older-model",
            displayName: "Older Service Model",
            supportedReasoningEfforts: ["low"],
          },
        ],
        selection: { mode: "automatic" },
      })
      .mockResolvedValueOnce({
        models: [
          {
            id: "latest-model",
            displayName: "Latest Service Model",
            supportedReasoningEfforts: ["high"],
          },
        ],
        selection: { mode: "automatic" },
      });
    harness.selectModel
      .mockImplementationOnce(() => staleSelection.promise)
      .mockImplementationOnce(() => latestSelection.promise);
    window.localStorage.setItem(
      "whitelily.onboarding.v1",
      JSON.stringify({
        version: 2,
        locale: "zh-CN",
        progressHint: "model",
        modelPreference: {
          mode: "explicit",
          modelId: "latest-model",
          reasoningEffort: "high",
        },
      }),
    );
    const user = userEvent.setup();
    render(<App api={harness.api} />);
    await waitFor(() => expect(harness.selectModel).toHaveBeenCalledWith({ mode: "automatic" }));

    await user.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(harness.listModels).toHaveBeenCalledTimes(2));
    expect(harness.selectModel).toHaveBeenCalledTimes(1);

    await act(async () => {
      staleSelection.resolve({ mode: "automatic" });
      await staleSelection.promise;
    });
    await waitFor(() => expect(harness.selectModel).toHaveBeenCalledTimes(2));
    expect(harness.selectModel).toHaveBeenLastCalledWith({
      mode: "explicit",
      modelId: "latest-model",
      reasoningEffort: "high",
    });

    await act(async () => {
      latestSelection.resolve({
        mode: "explicit",
        modelId: "latest-model",
        reasoningEffort: "high",
        available: true,
      });
      await latestSelection.promise;
    });
    expect(await screen.findByRole("option", { name: "Latest Service Model" })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("whitelily.onboarding.v1")!)).toMatchObject({
      locale: "en",
      progressHint: "model",
      modelPreference: {
        mode: "explicit",
        modelId: "latest-model",
        reasoningEffort: "high",
      },
    });
  });

  it("does not let a persisted ready hint bypass an empty live model catalog", async () => {
    window.localStorage.setItem(
      "whitelily.onboarding.v1",
      JSON.stringify({
        version: 2,
        locale: "en",
        progressHint: "ready",
        modelPreference: null,
      }),
    );
    const harness = createApiHarness({
      catalog: { models: [], selection: { mode: "automatic" } },
      pcl2: [pcl2Candidate],
    });
    render(<App api={harness.api} />);

    expect(await screen.findByRole("heading", { name: "Choose an AI model" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("model catalog");
    expect(harness.discoverPcl2).not.toHaveBeenCalled();
    expect(harness.detectLanCandidates).not.toHaveBeenCalled();
  });

  it("does not resume past model selection when restoring live authority fails", async () => {
    window.localStorage.setItem(
      "whitelily.onboarding.v1",
      JSON.stringify({
        version: 2,
        locale: "en",
        progressHint: "ready",
        modelPreference: { mode: "automatic" },
      }),
    );
    const harness = createApiHarness({ pcl2: [pcl2Candidate] });
    harness.selectModel.mockRejectedValue(new Error("MODEL_UNAVAILABLE"));
    render(<App api={harness.api} />);

    expect(await screen.findByRole("heading", { name: "Choose an AI model" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("model catalog");
    expect(harness.discoverPcl2).not.toHaveBeenCalled();
    expect(harness.detectLanCandidates).not.toHaveBeenCalled();
  });

  it("applies live automatic authority before using a resumed downstream hint", async () => {
    window.localStorage.setItem(
      "whitelily.onboarding.v1",
      JSON.stringify({
        version: 2,
        locale: "en",
        progressHint: "pcl2",
        modelPreference: null,
      }),
    );
    const harness = createApiHarness({
      owner: {
        revision: 4,
        ownerUsername: "LiveOwner",
        configured: true,
        presence: "offline",
      },
      pcl2: [],
    });
    render(<App api={harness.api} />);

    expect(await screen.findByRole("heading", { name: "Check PCL2" })).toBeTruthy();
    expect(harness.selectModel).toHaveBeenCalledWith({ mode: "automatic" });
    expect(harness.readOwnerIdentity).toHaveBeenCalledTimes(1);
    expect(harness.selectModel.mock.invocationCallOrder[0]).toBeLessThan(
      harness.readOwnerIdentity.mock.invocationCallOrder[0]!,
    );
    expect(harness.discoverPcl2).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "pcl2",
      "configured",
      {
        revision: 4,
        ownerUsername: "LiveOwner",
        configured: true,
        presence: "offline",
      },
      "Check PCL2",
      null,
    ],
    [
      "lan",
      "configured",
      {
        revision: 4,
        ownerUsername: "LiveOwner",
        configured: true,
        presence: "offline",
      },
      "Connect to a LAN world",
      null,
    ],
    [
      "ready",
      "configured",
      {
        revision: 4,
        ownerUsername: "LiveOwner",
        configured: true,
        presence: "offline",
      },
      "Connect to a LAN world",
      null,
    ],
    [
      "pcl2",
      "unconfigured",
      {
        revision: 5,
        ownerUsername: null,
        configured: false,
        presence: "unknown",
      },
      "Who should WhiteLily listen to?",
      null,
    ],
    [
      "lan",
      "unconfigured",
      {
        revision: 5,
        ownerUsername: null,
        configured: false,
        presence: "unknown",
      },
      "Who should WhiteLily listen to?",
      null,
    ],
    [
      "ready",
      "unconfigured",
      {
        revision: 5,
        ownerUsername: null,
        configured: false,
        presence: "unknown",
      },
      "Who should WhiteLily listen to?",
      null,
    ],
    [
      "pcl2",
      "config-invalid",
      new Error("OWNER_IDENTITY_CONFIG_INVALID: C:\\Users\\PrivateOwner\\config.toml"),
      "Who should WhiteLily listen to?",
      "WhiteLily's owner configuration is invalid. Repair the config, then try again.",
    ],
    [
      "lan",
      "config-invalid",
      new Error("OWNER_IDENTITY_CONFIG_INVALID: C:\\Users\\PrivateOwner\\config.toml"),
      "Who should WhiteLily listen to?",
      "WhiteLily's owner configuration is invalid. Repair the config, then try again.",
    ],
    [
      "ready",
      "config-invalid",
      new Error("OWNER_IDENTITY_CONFIG_INVALID: C:\\Users\\PrivateOwner\\config.toml"),
      "Who should WhiteLily listen to?",
      "WhiteLily's owner configuration is invalid. Repair the config, then try again.",
    ],
    [
      "pcl2",
      "rejected",
      new Error("ECONNREFUSED: C:\\Users\\PrivateOwner\\owner-name"),
      "Who should WhiteLily listen to?",
      "The WhiteLily core is unavailable. Restart WhiteLily, then try again.",
    ],
    [
      "lan",
      "rejected",
      new Error("ECONNREFUSED: C:\\Users\\PrivateOwner\\owner-name"),
      "Who should WhiteLily listen to?",
      "The WhiteLily core is unavailable. Restart WhiteLily, then try again.",
    ],
    [
      "ready",
      "rejected",
      new Error("ECONNREFUSED: C:\\Users\\PrivateOwner\\owner-name"),
      "Who should WhiteLily listen to?",
      "The WhiteLily core is unavailable. Restart WhiteLily, then try again.",
    ],
  ] as const)(
    "gates the v2 $0 hint on a $1 live owner snapshot",
    async (progressHint, _ownerState, owner, expectedHeading, expectedGuidance) => {
      window.localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({
          version: 2,
          locale: "en",
          progressHint,
          modelPreference: { mode: "automatic" },
        }),
      );
      const harness = createApiHarness({
        owner,
        pcl2: [pcl2Candidate],
        lan: [lanCandidate],
      });
      render(<App api={harness.api} />);

      expect(await screen.findByRole("heading", { name: expectedHeading })).toBeTruthy();
      expect(harness.readOwnerIdentity).toHaveBeenCalledTimes(1);
      if (expectedGuidance === null) {
        expect(screen.queryByRole("alert")).toBeNull();
      } else {
        expect(screen.getByRole("alert").textContent).toBe(expectedGuidance);
      }

      if (_ownerState === "configured") {
        expect(harness.discoverPcl2).toHaveBeenCalledTimes(1);
        expect(harness.detectLanCandidates).toHaveBeenCalledTimes(progressHint === "pcl2" ? 0 : 1);
      } else {
        expect(harness.discoverPcl2).not.toHaveBeenCalled();
        expect(harness.detectLanCandidates).not.toHaveBeenCalled();
        expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!)).toMatchObject({
          progressHint: "owner",
        });
      }

      const stored = window.localStorage.getItem(ONBOARDING_STORAGE_KEY)!;
      expect(stored).not.toMatch(/ownerUsername|LiveOwner|PrivateOwner|owner-name/u);
      expect(document.body.textContent).not.toMatch(/PrivateOwner|owner-name/u);
    },
  );

  it("does not let an older locale-triggered owner read override newer live authority", async () => {
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        locale: "zh-CN",
        progressHint: "pcl2",
        modelPreference: { mode: "automatic" },
      }),
    );
    const staleOwnerRead =
      deferred<Awaited<ReturnType<WhiteLilyDesktopApi["readOwnerIdentity"]>>>();
    const harness = createApiHarness({ pcl2: [pcl2Candidate] });
    harness.readOwnerIdentity
      .mockImplementationOnce(() => staleOwnerRead.promise)
      .mockResolvedValueOnce({
        revision: 8,
        ownerUsername: null,
        configured: false,
        presence: "unknown",
      });
    const user = userEvent.setup();
    render(<App api={harness.api} />);

    await waitFor(() => expect(harness.readOwnerIdentity).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "English" }));
    expect(
      await screen.findByRole("heading", { name: "Who should WhiteLily listen to?" }),
    ).toBeTruthy();
    expect(harness.readOwnerIdentity).toHaveBeenCalledTimes(2);

    await act(async () => {
      staleOwnerRead.resolve({
        revision: 7,
        ownerUsername: "StaleOwner",
        configured: true,
        presence: "offline",
      });
      await staleOwnerRead.promise;
    });

    expect(screen.getByRole("heading", { name: "Who should WhiteLily listen to?" })).toBeTruthy();
    expect(harness.discoverPcl2).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).not.toMatch(
      /ownerUsername|StaleOwner/u,
    );
  });

  it("clears a restored-model failure after a later live selection succeeds", async () => {
    window.localStorage.setItem(
      "whitelily.onboarding.v1",
      JSON.stringify({
        version: 2,
        locale: "zh-CN",
        progressHint: "model",
        modelPreference: { mode: "automatic" },
      }),
    );
    const harness = createApiHarness();
    harness.selectModel.mockRejectedValueOnce(new Error("MODEL_UNAVAILABLE"));
    const user = userEvent.setup();
    render(<App api={harness.api} />);

    await screen.findByRole("heading", { name: "选择智能模型" });
    expect(screen.getByRole("alert").textContent).toContain("模型列表");
    await user.selectOptions(screen.getByRole("combobox", { name: "模型" }), "gpt-live");

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("GPT Live");
  });

  it("keeps a changed locale when later progress hints are persisted", async () => {
    const harness = createApiHarness({ pcl2: [] });
    const user = userEvent.setup();
    render(<App api={harness.api} />);

    await screen.findByRole("heading", { name: "选择智能模型" });
    await user.click(screen.getByRole("button", { name: "English" }));
    await user.click(screen.getByRole("button", { name: "Continue to owner identity" }));
    await screen.findByRole("heading", { name: "Who should WhiteLily listen to?" });
    await user.type(screen.getByLabelText("Minecraft Java username"), "NewOwner");
    await user.click(screen.getByRole("button", { name: "Confirm owner identity" }));
    await screen.findByRole("heading", { name: "Check PCL2" });

    expect(JSON.parse(window.localStorage.getItem("whitelily.onboarding.v1")!)).toMatchObject({
      locale: "en",
      progressHint: "pcl2",
    });
  });

  it("explains how to install or start PCL2 without accepting an executable path", async () => {
    const harness = createApiHarness({ pcl2: [] });
    await reachPcl2(harness);

    expect(await screen.findByText("未发现 Plain Craft Launcher 2")).toBeTruthy();
    expect(screen.getByText(/请自行安装或启动 PCL2/u)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /浏览|选择路径/u })).toBeNull();
  });

  it("shows LAN instructions and public candidate details without connecting automatically", async () => {
    const harness = createApiHarness({
      pcl2: [pcl2Candidate],
      lan: [lanCandidate, unknownLanCandidate],
    });
    await reachLan(harness);

    expect(screen.getByText(/请先用 PCL2 启动 Minecraft Java 1\.21\.5/u)).toBeTruthy();
    expect(await screen.findByText("端口 51321")).toBeTruthy();
    expect(screen.getByText("Minecraft 1.21.5")).toBeTruthy();
    expect(screen.getByText("端口 51322")).toBeTruthy();
    expect(screen.getByText(/无法确认 Minecraft 版本/u)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /51321/u })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /51322/u })).toBeTruthy();
    const verifiedAction = screen.getByRole("button", { name: /51321.*1\.21\.5/u });
    const unknownAction = screen.getByRole("button", { name: /51322.*unknown|51322.*未知/iu });
    expect(verifiedAction.getAttribute("aria-describedby")).toBeTruthy();
    expect(unknownAction.getAttribute("aria-describedby")).toBeTruthy();
    expect(verifiedAction.getAttribute("aria-describedby")).not.toBe(
      unknownAction.getAttribute("aria-describedby"),
    );
    expect(document.body.textContent).not.toContain("lan_candidate_0001");
    expect(harness.confirmLanCandidate).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("connects only after an explicit candidate confirmation and enters Home only when running", async () => {
    const harness = createApiHarness({
      status: [stoppedSnapshot, runningSnapshot],
      pcl2: [pcl2Candidate],
      lan: [lanCandidate],
      start: runningSnapshot,
    });
    const user = userEvent.setup();
    await reachLan(harness);

    await user.click(await screen.findByRole("button", { name: /确认并连接.*51321/u }));

    expect(harness.confirmLanCandidate).toHaveBeenCalledWith("lan_candidate_0001");
    expect(harness.start).toHaveBeenCalledTimes(1);
    const homeHeading = await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(homeHeading));
    expect(await screen.findByRole("heading", { name: "运行概览" })).toBeTruthy();
  });

  it("refreshes an expired candidate and requires another explicit click", async () => {
    const harness = createApiHarness({
      pcl2: [pcl2Candidate],
      lan: [[lanCandidate], []],
      confirm: new Error("LAN_CANDIDATE_EXPIRED private://config"),
    });
    const user = userEvent.setup();
    await reachLan(harness);

    await user.click(await screen.findByRole("button", { name: /确认并连接.*51321/u }));

    expect(await screen.findByText("候选已过期，请重新开放 LAN 后刷新。")).toBeTruthy();
    expect(harness.detectLanCandidates).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: /确认并连接/u })).toBeNull();
    expect(document.body.textContent).not.toContain("private://config");
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("refreshes after a confirmed candidate fails to start and does not reuse its authority", async () => {
    const harness = createApiHarness({
      pcl2: [pcl2Candidate],
      lan: [[lanCandidate], []],
      start: new Error("MINECRAFT_CONNECT_FAILED private://config"),
    });
    const user = userEvent.setup();
    await reachLan(harness);

    await user.click(await screen.findByRole("button", { name: /确认并连接.*51321/u }));

    expect(
      await screen.findByText("无法连接 Minecraft，请确认世界仍开放 LAN 后重试。"),
    ).toBeTruthy();
    expect(harness.detectLanCandidates).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: /确认并连接/u })).toBeNull();
    expect(document.body.textContent).not.toContain("private://config");
  });

  it("moves focus to each new step heading for keyboard and screen-reader users", async () => {
    const harness = createApiHarness();
    render(<App api={harness.api} />);

    const heading = await screen.findByRole("heading", { name: "选择智能模型" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("treats persisted progress as a hint and never bypasses live account validation", async () => {
    window.localStorage.setItem(
      "whitelily.onboarding.v1",
      JSON.stringify({
        version: 2,
        locale: "en",
        progressHint: "ready",
        modelPreference: {
          mode: "explicit",
          modelId: "gpt-live",
          reasoningEffort: "high",
        },
      }),
    );
    const harness = createApiHarness({ account: { status: "signed_out" } });

    render(<App api={harness.api} />);

    expect(await screen.findByRole("heading", { name: "Sign in to ChatGPT" })).toBeTruthy();
    expect(harness.getAccount).toHaveBeenCalled();
    expect(harness.discoverPcl2).not.toHaveBeenCalled();
    expect(harness.detectLanCandidates).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("clears corrupt or oversized progress instead of trusting it", async () => {
    window.localStorage.setItem(
      "whitelily.onboarding.v1",
      JSON.stringify({
        version: 1,
        locale: "zh-CN",
        progressHint: "ready",
        candidateId: "lan_candidate_0001",
        lanPort: 51_321,
        padding: "x".repeat(4_096),
      }),
    );
    const harness = createApiHarness({ account: { status: "signed_out" } });

    render(<App api={harness.api} />);
    await screen.findByRole("heading", { name: "登录 ChatGPT" });

    expect(JSON.parse(window.localStorage.getItem("whitelily.onboarding.v1")!)).toEqual({
      version: 2,
      locale: "zh-CN",
      progressHint: "login",
      modelPreference: null,
    });
    expect(window.localStorage.getItem("whitelily.onboarding.v1")).not.toContain(
      "lan_candidate_0001",
    );
  });

  it("routes a live running runtime to Home but sends every non-running state through onboarding", async () => {
    const runningHarness = createApiHarness({ status: runningSnapshot });
    const runningView = render(<App api={runningHarness.api} />);
    expect(await screen.findByRole("heading", { name: "运行概览" })).toBeTruthy();
    expect(runningHarness.getAccount).not.toHaveBeenCalled();
    runningView.unmount();

    const stoppedHarness = createApiHarness({
      status: stoppedSnapshot,
      account: { status: "signed_out" },
    });
    render(<App api={stoppedHarness.api} />);
    expect(await screen.findByRole("heading", { name: "登录 ChatGPT" })).toBeTruthy();
  });
});

describe("model picker concurrency", () => {
  it("constrains a long model label while preserving its full accessible name", () => {
    const longLabel = "L".repeat(160);

    render(
      <ModelPicker
        locale="en"
        catalog={{
          models: [
            {
              id: "long-model",
              displayName: longLabel,
              supportedReasoningEfforts: ["high"],
            },
          ],
          selection: {
            mode: "explicit",
            modelId: "long-model",
            reasoningEffort: "high",
            available: true,
          },
        }}
        onSelect={vi.fn()}
        onApplied={vi.fn()}
        onContinue={vi.fn()}
      />,
    );

    const model = screen.getByRole("combobox", { name: "Model" });
    const option = screen.getByRole("option", { name: longLabel });
    expect(model).toBeTruthy();
    expect(option.textContent).toBe(longLabel);
    expect(screen.getByRole("status").textContent).toContain(longLabel);
  });

  it("serializes writes and lets the latest intent own visible and persisted selection", async () => {
    const first = deferred<ModelSelection>();
    const second = deferred<ModelSelection>();
    const onSelect = vi
      .fn<
        (selection: Parameters<WhiteLilyDesktopApi["selectModel"]>[0]) => Promise<ModelSelection>
      >()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onApplied = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelPicker
        locale="zh-CN"
        catalog={liveCatalog}
        onSelect={onSelect}
        onApplied={onApplied}
        onContinue={vi.fn()}
      />,
    );

    const model = screen.getByRole("combobox", { name: "模型" });
    await user.selectOptions(model, "gpt-live");
    await user.selectOptions(model, "automatic");
    expect((model as HTMLSelectElement).value).toBe("automatic");
    expect(onSelect).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({
        mode: "explicit",
        modelId: "gpt-live",
        reasoningEffort: "low",
        available: true,
      });
      await first.promise;
    });
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(2));
    expect(onApplied).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve({ mode: "automatic" });
      await second.promise;
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith({ mode: "automatic" }));
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("自动选择");
  });
});

describe("safe onboarding error mapping", () => {
  it.each([
    ["CODEX_NOT_LOGGED_IN", "onboarding.error.CODEX_NOT_LOGGED_IN"],
    ["MODEL_UNAVAILABLE", "onboarding.error.MODEL_UNAVAILABLE"],
    ["PCL2_NOT_FOUND", "onboarding.error.PCL2_NOT_FOUND"],
    ["LAN_NOT_FOUND", "onboarding.error.LAN_NOT_FOUND"],
    ["LAN_CANDIDATE_EXPIRED", "onboarding.error.LAN_CANDIDATE_EXPIRED"],
    ["MINECRAFT_VERSION_UNVERIFIED", "onboarding.error.MINECRAFT_VERSION_UNVERIFIED"],
    ["MINECRAFT_CONNECT_FAILED", "onboarding.error.MINECRAFT_CONNECT_FAILED"],
  ] as const)("maps %s without returning raw error text", (code, expected) => {
    expect(safeOnboardingErrorKey(new Error(`${code} ${String.raw`C:\private\token`}`))).toBe(
      expected,
    );
  });

  it("maps unknown and non-Error rejections to a generic localized message", () => {
    expect(safeOnboardingErrorKey(new Error(String.raw`C:\private\token`))).toBe(
      "onboarding.error.UNKNOWN",
    );
    expect(safeOnboardingErrorKey({ token: "secret" })).toBe("onboarding.error.UNKNOWN");
  });
});

describe("LAN candidate presentation", () => {
  it("does not crash when a validated safe-integer timestamp is outside the JavaScript Date range", () => {
    const extremeTimestampCandidate: LanCandidate = {
      ...lanCandidate,
      observedAt: 8_640_000_000_000_001,
      expiresAt: 8_640_000_000_000_002,
    };

    const view = render(
      <LanCandidateCard
        candidate={extremeTimestampCandidate}
        locale="zh-CN"
        pending={false}
        disabled={false}
        onConfirm={() => undefined}
      />,
    );

    expect(view.container.querySelector("time")).toBeTruthy();
  });
});
