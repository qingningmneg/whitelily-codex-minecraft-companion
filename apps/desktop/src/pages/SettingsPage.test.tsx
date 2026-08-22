import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerIdentitySnapshot } from "../../../../src/identity/ownerIdentity.js";
import type { WhiteLilyAppApi } from "../desktopApi.js";
import type { MinecraftComponentStatus } from "../../src-main/minecraftComponents.js";
import { SettingsPage } from "./SettingsPage.js";

const oldOwner: OwnerIdentitySnapshot = {
  revision: 2,
  ownerUsername: "OldOwner",
  configured: true,
  presence: "online",
};

function api(overrides: Partial<WhiteLilyAppApi> = {}): WhiteLilyAppApi {
  return {
    readStartupSetting: vi.fn(async () => ({ enabled: false, available: true })),
    setStartupSetting: vi.fn(async (enabled) => ({ enabled, available: true })),
    readCloseToTraySetting: vi.fn(async () => ({ revision: 0, enabled: true })),
    setCloseToTraySetting: vi.fn(async ({ expectedRevision, enabled }) => ({
      revision: expectedRevision + 1,
      enabled,
    })),
    readOwnerIdentity: vi.fn(async () => oldOwner),
    updateOwnerIdentity: vi.fn(async ({ expectedRevision, ownerUsername }) => ({
      revision: expectedRevision + 1,
      ownerUsername,
      configured: true,
      presence: "offline" as const,
    })),
    detectLanCandidates: vi.fn(async () => []),
    getMinecraftComponentStatus: vi.fn(),
    installMinecraftComponents: vi.fn(),
    removeMinecraftComponents: vi.fn(),
    ...overrides,
  } as WhiteLilyAppApi;
}

function renderSettings(
  desktopApi: WhiteLilyAppApi,
  options: {
    initialOwner?: OwnerIdentitySnapshot | null;
    initialOwnerStateUnknown?: boolean;
    locale?: "zh-CN" | "en";
    onLocaleChange?: (locale: "zh-CN" | "en") => void;
    onOwnerIdentityChange?: (snapshot: OwnerIdentitySnapshot) => boolean;
    onOwnerDialogOpenChange?: (open: boolean) => void;
  } = {},
) {
  const onOwnerIdentityChange = vi.fn(options.onOwnerIdentityChange ?? (() => true));
  const onOwnerDialogOpenChange = vi.fn(options.onOwnerDialogOpenChange);
  let publishOwnerIdentity!: (snapshot: OwnerIdentitySnapshot | null) => void;
  function Harness() {
    const [ownerIdentity, setOwnerIdentity] = useState<OwnerIdentitySnapshot | null>(() =>
      options.initialOwnerStateUnknown
        ? null
        : options.initialOwner === undefined
          ? oldOwner
          : options.initialOwner,
    );
    const [ownerStateUnknown, setOwnerStateUnknown] = useState(
      options.initialOwnerStateUnknown ?? false,
    );
    publishOwnerIdentity = setOwnerIdentity;
    return (
      <SettingsPage
        api={desktopApi}
        locale={options.locale ?? "en"}
        ownerIdentity={ownerIdentity}
        ownerStateUnknown={ownerStateUnknown}
        onOwnerIdentityChange={(snapshot) => {
          const accepted = onOwnerIdentityChange(snapshot);
          if (accepted) {
            setOwnerIdentity(snapshot);
            setOwnerStateUnknown(false);
          }
          return accepted;
        }}
        onOwnerStateUnknownChange={(unknown) => {
          setOwnerStateUnknown(unknown);
          if (unknown) setOwnerIdentity(null);
        }}
        onOwnerDialogOpenChange={onOwnerDialogOpenChange}
        onLocaleChange={options.onLocaleChange ?? vi.fn()}
      />
    );
  }
  return {
    ...render(<Harness />),
    onOwnerIdentityChange,
    onOwnerDialogOpenChange,
    publishOwnerIdentity(snapshot: OwnerIdentitySnapshot | null) {
      act(() => publishOwnerIdentity(snapshot));
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("SettingsPage", () => {
  afterEach(cleanup);

  it("starts with native startup off and exposes only dedicated startup and close-to-tray controls", async () => {
    const desktopApi = api();
    renderSettings(desktopApi);

    const startup = await screen.findByRole("checkbox", { name: "Start WhiteLily with Windows" });
    const closeToTray = screen.getByRole("checkbox", { name: "Close window to tray" });
    expect((startup as HTMLInputElement).checked).toBe(false);
    expect((closeToTray as HTMLInputElement).checked).toBe(true);

    await userEvent.click(startup);
    await userEvent.click(closeToTray);
    await waitFor(() => {
      expect(desktopApi.setStartupSetting).toHaveBeenCalledWith(true);
      expect(desktopApi.setCloseToTraySetting).toHaveBeenCalledWith({
        expectedRevision: 0,
        enabled: false,
      });
    });
    expect("updateSettings" in desktopApi).toBe(false);
  });

  it("detects a fresh verified instance and displays only fixed component names and states", async () => {
    const observedAt = Date.now();
    const status: MinecraftComponentStatus = {
      state: "ready",
      bridgeInstalled: true,
      bridgeActive: true,
      avatarInstalled: true,
      restartRequired: false,
    };
    const desktopApi = api({
      detectLanCandidates: vi.fn(async () => [
        {
          id: "lan_candidate_1234",
          port: 51_321,
          version: "1.21.5",
          observedAt,
          expiresAt: observedAt + 60_000,
        },
      ]),
      getMinecraftComponentStatus: vi.fn(async () => status),
    });
    renderSettings(desktopApi);

    expect(await screen.findByText("Current verified PCL2 Fabric 1.21.5 instance")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("WhiteLily Bridge")).toBeTruthy();
    expect(screen.getByText("WhiteLily Avatar")).toBeTruthy();
    expect(desktopApi.getMinecraftComponentStatus).toHaveBeenCalledWith("lan_candidate_1234");
    expect(document.body.textContent).not.toContain("51321");
    expect(document.body.textContent).not.toContain("lan_candidate_1234");
    expect(document.body.textContent).not.toContain(String.raw`C:\Private`);
    expect(document.body.textContent).not.toMatch(/[a-f0-9]{64}/u);
  });

  it("does not claim an instance is verified when fresh detection finds none", async () => {
    renderSettings(api());

    expect(
      await screen.findByText(/No current verified PCL2 Fabric 1\.21\.5 instance is available/u),
    ).toBeTruthy();
    expect(screen.queryByText("Current verified PCL2 Fabric 1.21.5 instance")).toBeNull();
  });

  it("renders an unsupported manager status as non-actionable and unverified", async () => {
    const observedAt = Date.now();
    renderSettings(
      api({
        detectLanCandidates: vi.fn(async () => [
          {
            id: "lan_candidate_1234",
            port: 51_321,
            version: "1.21.5",
            observedAt,
            expiresAt: observedAt + 60_000,
          },
        ]),
        getMinecraftComponentStatus: vi.fn<WhiteLilyAppApi["getMinecraftComponentStatus"]>(
          async () => ({
            state: "bridge_version_unsupported",
            bridgeInstalled: false,
            bridgeActive: false,
            avatarInstalled: false,
            restartRequired: false,
          }),
        ),
      }),
    );

    expect(
      await screen.findByText(
        "This candidate is not a verified PCL2 Fabric 1.21.5 instance. Component installation is unavailable.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Current verified PCL2 Fabric 1.21.5 instance")).toBeNull();
    expect(screen.queryByRole("button", { name: /Install or update/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove Bridge/u })).toBeNull();
  });

  it("uses a fresh candidate for Bridge-only and Bridge plus Avatar install or update", async () => {
    const observedAt = Date.now();
    let generation = 0;
    const detectLanCandidates = vi.fn(async () => {
      generation += 1;
      return [
        {
          id: `lan_candidate_${String(generation).padStart(4, "0")}`,
          port: 51_321,
          version: "1.21.5" as const,
          observedAt,
          expiresAt: observedAt + 60_000,
        },
      ];
    });
    const status: MinecraftComponentStatus = {
      state: "avatar_not_installed",
      bridgeInstalled: true,
      bridgeActive: true,
      avatarInstalled: false,
      restartRequired: false,
    };
    const installMinecraftComponents = vi.fn(async () => status);
    const desktopApi = api({
      detectLanCandidates,
      getMinecraftComponentStatus: vi.fn(async () => status),
      installMinecraftComponents,
    });
    renderSettings(desktopApi);
    const user = userEvent.setup();

    await screen.findByText("Current verified PCL2 Fabric 1.21.5 instance");
    await user.click(screen.getByRole("button", { name: "Install or update Bridge only" }));
    await waitFor(() =>
      expect(installMinecraftComponents).toHaveBeenCalledWith("lan_candidate_0002", ["bridge"]),
    );
    await user.click(screen.getByRole("button", { name: "Install or update Bridge and Avatar" }));
    await waitFor(() =>
      expect(installMinecraftComponents).toHaveBeenLastCalledWith("lan_candidate_0003", [
        "bridge",
        "avatar",
      ]),
    );
    expect(detectLanCandidates).toHaveBeenCalledTimes(3);
  });

  it("removes Avatar alone but closes Avatar before Bridge using a fresh candidate", async () => {
    const observedAt = Date.now();
    let generation = 0;
    const detectLanCandidates = vi.fn(async () => {
      generation += 1;
      return [
        {
          id: `lan_candidate_${String(generation).padStart(4, "0")}`,
          port: 51_321,
          version: "1.21.5" as const,
          observedAt,
          expiresAt: observedAt + 60_000,
        },
      ];
    });
    const status: MinecraftComponentStatus = {
      state: "ready",
      bridgeInstalled: true,
      bridgeActive: true,
      avatarInstalled: true,
      restartRequired: false,
    };
    const removeMinecraftComponents = vi.fn(async () => status);
    const desktopApi = api({
      detectLanCandidates,
      getMinecraftComponentStatus: vi.fn(async () => status),
      removeMinecraftComponents,
    });
    renderSettings(desktopApi);
    const user = userEvent.setup();

    await screen.findByText("Current verified PCL2 Fabric 1.21.5 instance");
    await user.click(screen.getByRole("button", { name: "Remove Avatar" }));
    await waitFor(() =>
      expect(removeMinecraftComponents).toHaveBeenCalledWith("lan_candidate_0002", ["avatar"]),
    );
    await user.click(screen.getByRole("button", { name: "Remove Bridge and Avatar" }));
    await waitFor(() =>
      expect(removeMinecraftComponents).toHaveBeenLastCalledWith("lan_candidate_0003", [
        "avatar",
        "bridge",
      ]),
    );
    expect(detectLanCandidates).toHaveBeenCalledTimes(3);
  });

  it("reloads a close-to-tray conflict, retains the desired value, and requires reapply", async () => {
    const conflict = Object.assign(new Error("conflict"), { code: "DOCUMENT_CONFLICT" });
    const readCloseToTraySetting = vi
      .fn()
      .mockResolvedValueOnce({ revision: 0, enabled: true })
      .mockResolvedValueOnce({ revision: 2, enabled: true });
    const setCloseToTraySetting = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ revision: 3, enabled: false });
    renderSettings(api({ readCloseToTraySetting, setCloseToTraySetting }));

    const toggle = await screen.findByRole("checkbox", { name: "Close window to tray" });
    await userEvent.click(toggle);
    expect(await screen.findByText("This document changed elsewhere")).toBeTruthy();
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(setCloseToTraySetting).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Reapply my draft" }));
    expect(setCloseToTraySetting).toHaveBeenLastCalledWith({
      expectedRevision: 2,
      enabled: false,
    });
  });

  it("switches between Chinese and English with matching copy", async () => {
    const onLocaleChange = vi.fn();
    const desktopApi = api();
    const view = renderSettings(desktopApi, { onLocaleChange });
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "中文" }));
    expect(onLocaleChange).toHaveBeenCalledWith("zh-CN");

    view.unmount();
    renderSettings(desktopApi, { locale: "zh-CN", onLocaleChange });
    expect(screen.getByRole("heading", { name: "设置" })).toBeTruthy();
    expect(await screen.findByText("开机启动")).toBeTruthy();
  });

  it("reviews an exact-case owner change in an accessible modal and suppresses double confirm", async () => {
    const pending = deferred<OwnerIdentitySnapshot>();
    const updateOwnerIdentity = vi.fn(() => pending.promise);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const desktopApi = api({ updateOwnerIdentity });
    const { onOwnerIdentityChange, onOwnerDialogOpenChange } = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "eDiTeDOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));

    const dialog = screen.getByRole("dialog", { name: "Confirm owner switch" });
    expect(dialog.textContent).toContain("OldOwner → eDiTeDOwner");
    expect(dialog.textContent).toContain("Any active task will stop");
    const confirm = screen.getByRole("button", { name: "Confirm switch" });
    await waitFor(() => expect(document.activeElement).toBe(confirm));

    await user.dblClick(confirm);
    expect(updateOwnerIdentity).toHaveBeenCalledOnce();
    expect(updateOwnerIdentity).toHaveBeenCalledWith({
      expectedRevision: 2,
      ownerUsername: "eDiTeDOwner",
    });

    pending.resolve({
      revision: 3,
      ownerUsername: "eDiTeDOwner",
      configured: true,
      presence: "offline",
    });
    expect(await screen.findByText("Owner switched.")).toBeTruthy();
    expect(screen.getByText("eDiTeDOwner")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("Waiting for the new owner to come online")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(onOwnerDialogOpenChange).toHaveBeenLastCalledWith(false));
    expect(onOwnerIdentityChange).toHaveBeenCalledWith({
      revision: 3,
      ownerUsername: "eDiTeDOwner",
      configured: true,
      presence: "offline",
    });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(setItem).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("keeps authority unknown when App rejects an exact direct response", async () => {
    const desktopApi = api({
      updateOwnerIdentity: vi.fn(async () => ({
        revision: 3,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline" as const,
      })),
    });
    renderSettings(desktopApi, {
      onOwnerIdentityChange: () => false,
    });
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    expect(
      await screen.findByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();
    expect(screen.queryByText("Owner switched.")).toBeNull();
    expect(screen.queryByText("OldOwner")).toBeNull();
    expect(screen.queryByText("NewOwner")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "New owner username" })).toBeNull();
  });

  it("treats the intended next-revision owner event as success before the direct response settles", async () => {
    const pending = deferred<OwnerIdentitySnapshot>();
    const desktopApi = api({
      updateOwnerIdentity: vi.fn(() => pending.promise),
    });
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));
    expect(await screen.findByRole("button", { name: "Switching" })).toBeTruthy();

    harness.publishOwnerIdentity({
      revision: 3,
      ownerUsername: "NewOwner",
      configured: true,
      presence: "offline",
    });

    expect(await screen.findByText("Owner switched.")).toBeTruthy();
    expect(screen.getByText("NewOwner")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(false));
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect((input as HTMLInputElement).disabled).toBe(false);
    expect(
      screen.queryByText(
        "Owner identity changed elsewhere. Review the latest owner and confirm again.",
      ),
    ).toBeNull();

    await act(async () =>
      pending.reject(new Error("OWNER_IDENTITY_WRITE_FAILED: private://config")),
    );
    expect(screen.getByText("Owner switched.")).toBeTruthy();
    expect(
      screen.queryByText("Could not switch owner. The current owner is unchanged."),
    ).toBeNull();
  });

  it("keeps an in-flight review open when only the old owner's presence changes", async () => {
    const pending = deferred<OwnerIdentitySnapshot>();
    const desktopApi = api({
      updateOwnerIdentity: vi.fn(() => pending.promise),
    });
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    harness.publishOwnerIdentity({
      ...oldOwner,
      presence: "offline",
    });

    expect(screen.getByRole("dialog", { name: "Confirm owner switch" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switching" })).toBeTruthy();
    expect(
      screen.queryByText(
        "Owner identity changed elsewhere. Review the latest owner and confirm again.",
      ),
    ).toBeNull();
    expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(true);
  });

  it.each([
    {
      label: "intended username at an older revision",
      snapshot: {
        revision: 1,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline",
      } satisfies OwnerIdentitySnapshot,
    },
    {
      label: "intended username at the unchanged revision",
      snapshot: {
        revision: 2,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline",
      } satisfies OwnerIdentitySnapshot,
    },
    {
      label: "intended username at an advanced revision",
      snapshot: {
        revision: 4,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline",
      } satisfies OwnerIdentitySnapshot,
    },
    {
      label: "a distinct username at the intended revision",
      snapshot: {
        revision: 3,
        ownerUsername: "OtherOwner",
        configured: true,
        presence: "online",
      } satisfies OwnerIdentitySnapshot,
    },
    {
      label: "an unconfigured identity at the intended revision",
      snapshot: {
        revision: 3,
        ownerUsername: null,
        configured: false,
        presence: "unknown",
      } satisfies OwnerIdentitySnapshot,
    },
  ])("rejects $label as an acknowledgement", async ({ snapshot }) => {
    const pending = deferred<OwnerIdentitySnapshot>();
    const desktopApi = api({
      updateOwnerIdentity: vi.fn(() => pending.promise),
    });
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    harness.publishOwnerIdentity(snapshot);

    expect(
      await screen.findByText(
        "Owner identity changed elsewhere. Review the latest owner and confirm again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(false));
    expect(screen.queryByText("Owner switched.")).toBeNull();
  });

  it("ignores a late successful response after an owner event acknowledges the update", async () => {
    const pending = deferred<OwnerIdentitySnapshot>();
    const desktopApi = api({
      updateOwnerIdentity: vi.fn(() => pending.promise),
    });
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    harness.publishOwnerIdentity({
      revision: 3,
      ownerUsername: "NewOwner",
      configured: true,
      presence: "offline",
    });
    expect(await screen.findByText("Owner switched.")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();

    await act(async () =>
      pending.resolve({
        revision: 3,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "online",
      }),
    );

    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.queryByText("Online")).toBeNull();
    expect(harness.onOwnerIdentityChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    {
      label: "a different username",
      response: {
        revision: 3,
        ownerUsername: "OtherOwner",
        configured: true,
        presence: "online" as const,
      },
    },
    {
      label: "the wrong revision",
      response: {
        revision: 4,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline" as const,
      },
    },
    {
      label: "an unconfigured identity",
      response: {
        revision: 3,
        ownerUsername: null,
        configured: false,
        presence: "unknown" as const,
      },
    },
  ])("treats an owner update success with $label as ambiguous", async ({ response }) => {
    const readOwnerIdentity = vi.fn(async () => {
      throw new Error("private://child-unavailable");
    });
    const desktopApi = api({
      updateOwnerIdentity: vi.fn(async () => response),
      readOwnerIdentity,
    });
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    expect(
      await screen.findByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();
    expect(screen.queryByText("Owner switched.")).toBeNull();
    expect(screen.queryByText("OldOwner")).toBeNull();
    expect(screen.queryByText("OtherOwner")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "New owner username" })).toBeNull();
    expect(document.body.textContent).not.toContain("private://");
    expect(readOwnerIdentity).toHaveBeenCalledOnce();
    expect(harness.onOwnerIdentityChange).not.toHaveBeenCalled();
  });

  it("contains keyboard focus, supports Escape, and makes the background inert", async () => {
    const desktopApi = api();
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    const switchOwner = screen.getByRole("button", { name: "Switch owner" });
    await user.click(switchOwner);

    const confirm = screen.getByRole("button", { name: "Confirm switch" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const background = document.querySelector(".settings-page-content");
    expect(background?.hasAttribute("inert")).toBe(true);
    expect(background?.getAttribute("aria-hidden")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(confirm));

    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(false));
    await waitFor(() => expect(document.activeElement).toBe(switchOwner));
    expect(desktopApi.updateOwnerIdentity).not.toHaveBeenCalled();
  });

  it("does not open or submit confirmation for the exact current owner", async () => {
    const desktopApi = api();
    const harness = renderSettings(desktopApi);

    const switchOwner = await screen.findByRole("button", { name: "Switch owner" });
    expect((switchOwner as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(switchOwner);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(false));
    expect(desktopApi.updateOwnerIdentity).not.toHaveBeenCalled();
  });

  it.each(["ab", "YOURMCNAME", "yourmcname", "WHITELILY", "Player Name"])(
    "rejects invalid owner draft %s before review",
    async (draft) => {
      const desktopApi = api();
      renderSettings(desktopApi);

      const input = await screen.findByRole("textbox", { name: "New owner username" });
      await userEvent.clear(input);
      await userEvent.type(input, draft);

      expect(screen.getByRole("alert").textContent).toContain(
        "Enter a valid Minecraft Java username using 3–16 English letters, numbers, or underscores.",
      );
      expect(
        (screen.getByRole("button", { name: "Switch owner" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("reloads an owner conflict, retains the draft, and requires a fresh review", async () => {
    const conflict = Object.assign(new Error("private conflict path private://secret"), {
      code: "OWNER_IDENTITY_CONFIG_CONFLICT",
    });
    const currentOwner: OwnerIdentitySnapshot = {
      revision: 5,
      ownerUsername: "CurrentOwner",
      configured: true,
      presence: "online",
    };
    const updateOwnerIdentity = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({
      revision: 6,
      ownerUsername: "NewOwner",
      configured: true,
      presence: "offline",
    });
    const desktopApi = api({
      updateOwnerIdentity,
      readOwnerIdentity: vi.fn(async () => currentOwner),
    });
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    expect(
      await screen.findByText(
        "Owner identity changed elsewhere. Review the latest owner and confirm again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(false));
    expect((input as HTMLInputElement).value).toBe("NewOwner");
    expect(screen.getByText("CurrentOwner")).toBeTruthy();
    expect(document.body.textContent).not.toContain("private://secret");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Switch owner" })),
    );

    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    expect(screen.getByRole("dialog").textContent).toContain("CurrentOwner → NewOwner");
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));
    expect(updateOwnerIdentity).toHaveBeenLastCalledWith({
      expectedRevision: 5,
      ownerUsername: "NewOwner",
    });
    expect(await screen.findByText("Owner switched.")).toBeTruthy();
  });

  it("closes a stale review and hides stale owner authority when conflict reload fails", async () => {
    const updateOwnerIdentity = vi.fn(async () => {
      throw Object.assign(new Error("OWNER_IDENTITY_CONFIG_CONFLICT: private://config"), {
        code: "OWNER_IDENTITY_CONFIG_CONFLICT",
      });
    });
    const desktopApi = api({
      updateOwnerIdentity,
      readOwnerIdentity: vi.fn(async () => {
        throw new Error("private://config");
      }),
    });
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    expect(
      await screen.findByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();
    expect(screen.queryByText("OldOwner")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "New owner username" })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh owner status" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(false));
    expect(document.body.textContent).not.toContain("private://config");
  });

  it("keeps the old owner and safe copy after a write failure", async () => {
    const readOwnerIdentity = vi.fn(async () => oldOwner);
    const desktopApi = api({
      updateOwnerIdentity: vi.fn(async () => {
        throw new Error("OWNER_IDENTITY_WRITE_FAILED: private://config");
      }),
      readOwnerIdentity,
    });
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    expect(
      await screen.findByText(
        "The owner identity could not be updated. The previous owner remains active.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("OldOwner")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(false));
    expect(readOwnerIdentity).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("private://config");
  });

  it("reconciles an ambiguous rejection to the committed new owner", async () => {
    const desktopApi = api({
      updateOwnerIdentity: vi.fn(async () => {
        throw new Error("WhiteLily child request timed out after 10000ms");
      }),
      readOwnerIdentity: vi.fn(
        async () =>
          ({
            revision: 3,
            ownerUsername: "NewOwner",
            configured: true,
            presence: "offline",
          }) satisfies OwnerIdentitySnapshot,
      ),
    });
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    expect(await screen.findByText("Owner switched.")).toBeTruthy();
    expect(screen.getByText("NewOwner")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(harness.onOwnerIdentityChange).toHaveBeenCalledWith({
      revision: 3,
      ownerUsername: "NewOwner",
      configured: true,
      presence: "offline",
    });
    expect(
      screen.queryByText(
        "The owner identity could not be updated. The previous owner remains active.",
      ),
    ).toBeNull();
  });

  it("reconciles an ambiguous rejection to a conflicting current owner", async () => {
    const desktopApi = api({
      updateOwnerIdentity: vi.fn(async () => {
        throw new Error("WhiteLily child stdout closed before owner acknowledgement");
      }),
      readOwnerIdentity: vi.fn(
        async () =>
          ({
            revision: 5,
            ownerUsername: "OtherOwner",
            configured: true,
            presence: "online",
          }) satisfies OwnerIdentitySnapshot,
      ),
    });
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    expect(
      await screen.findByText(
        "Owner identity changed elsewhere. Review the latest owner and confirm again.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("OtherOwner")).toBeTruthy();
    expect(harness.onOwnerIdentityChange).toHaveBeenCalledWith({
      revision: 5,
      ownerUsername: "OtherOwner",
      configured: true,
      presence: "online",
    });
  });

  it("shows bounded unknown authority, blocks switching, and recovers through refresh", async () => {
    const readOwnerIdentity = vi
      .fn<WhiteLilyAppApi["readOwnerIdentity"]>()
      .mockRejectedValueOnce(new Error("private://child-unavailable"))
      .mockResolvedValueOnce({
        revision: 3,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline",
      });
    const desktopApi = api({
      updateOwnerIdentity: vi.fn(async () => {
        throw new Error("WhiteLily child request timed out after 10000ms: private://child");
      }),
      readOwnerIdentity,
    });
    renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    expect(
      await screen.findByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();
    expect(screen.queryByText("OldOwner")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "New owner username" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch owner" })).toBeNull();
    expect(document.body.textContent).not.toContain("private://");

    await user.click(screen.getByRole("button", { name: "Refresh owner status" }));

    expect(await screen.findByText("NewOwner")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "New owner username" })).toBeTruthy();
    expect(
      screen.queryByText("Owner status is unknown. Refresh before switching again."),
    ).toBeNull();
    expect(readOwnerIdentity).toHaveBeenCalledTimes(2);
  });

  it("keeps authority unknown when App rejects an ambiguous reread", async () => {
    const desktopApi = api({
      updateOwnerIdentity: vi.fn(async () => {
        throw new Error("WhiteLily child request timed out after 10000ms");
      }),
      readOwnerIdentity: vi.fn(async () => ({
        revision: 4,
        ownerUsername: "OtherOwner",
        configured: true,
        presence: "online" as const,
        childGeneration: 1,
      })),
    });
    renderSettings(desktopApi, {
      onOwnerIdentityChange: () => false,
    });
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    expect(
      await screen.findByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();
    expect(screen.queryByText("Owner switched.")).toBeNull();
    expect(screen.queryByText("OtherOwner")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "New owner username" })).toBeNull();
  });

  it("keeps authority unknown when App rejects a refresh snapshot", async () => {
    const desktopApi = api({
      readOwnerIdentity: vi.fn(async () => ({
        revision: 4,
        ownerUsername: "OtherOwner",
        configured: true,
        presence: "online" as const,
        childGeneration: 1,
      })),
    });
    renderSettings(desktopApi, {
      initialOwnerStateUnknown: true,
      onOwnerIdentityChange: () => false,
    });

    await userEvent.click(screen.getByRole("button", { name: "Refresh owner status" }));

    expect(
      await screen.findByText("Owner status is unknown. Refresh before switching again."),
    ).toBeTruthy();
    expect(screen.queryByText("OtherOwner")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "New owner username" })).toBeNull();
  });

  it("cancels without writing and restores focus to the review button", async () => {
    const desktopApi = api();
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    const switchOwner = screen.getByRole("button", { name: "Switch owner" });
    await user.click(switchOwner);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(false));
    await waitFor(() => expect(document.activeElement).toBe(switchOwner));
    expect(desktopApi.updateOwnerIdentity).not.toHaveBeenCalled();
  });

  it("invalidates an open review when owner authority becomes unconfigured", async () => {
    const desktopApi = api();
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    harness.publishOwnerIdentity({
      revision: 3,
      ownerUsername: null,
      configured: false,
      presence: "unknown",
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(false));
    expect(desktopApi.updateOwnerIdentity).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Settings" })),
    );
  });

  it("ignores an in-flight success after owner authority is removed", async () => {
    const pending = deferred<OwnerIdentitySnapshot>();
    const updateOwnerIdentity = vi.fn(() => pending.promise);
    const desktopApi = api({ updateOwnerIdentity });
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));
    expect(updateOwnerIdentity).toHaveBeenCalledOnce();

    harness.publishOwnerIdentity(null);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(false));

    await act(async () =>
      pending.resolve({
        revision: 3,
        ownerUsername: "StaleOwner",
        configured: true,
        presence: "online",
      }),
    );
    expect(harness.onOwnerIdentityChange).not.toHaveBeenCalled();
    expect(screen.queryByText("Owner switched.")).toBeNull();
    expect(screen.queryByText("StaleOwner")).toBeNull();
  });

  it("does not let a stale failure disturb a newer owner transaction", async () => {
    const first = deferred<OwnerIdentitySnapshot>();
    const second = deferred<OwnerIdentitySnapshot>();
    const updateOwnerIdentity = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const desktopApi = api({ updateOwnerIdentity });
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));

    harness.publishOwnerIdentity({
      revision: 5,
      ownerUsername: "CurrentOwner",
      configured: true,
      presence: "online",
    });
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    expect(screen.getByRole("dialog").textContent).toContain("CurrentOwner → NewOwner");
    await user.click(screen.getByRole("button", { name: "Confirm switch" }));
    expect(updateOwnerIdentity).toHaveBeenCalledTimes(2);

    await act(async () => first.reject(new Error("OWNER_IDENTITY_WRITE_FAILED: private://config")));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switching" })).toBeTruthy();
    expect(
      screen.queryByText("Could not switch owner. The current owner is unchanged."),
    ).toBeNull();

    await act(async () =>
      second.resolve({
        revision: 6,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline",
      }),
    );
    expect(await screen.findByText("Owner switched.")).toBeTruthy();
    expect(harness.onOwnerIdentityChange).toHaveBeenCalledOnce();
  });

  it("releases App-level modality when Settings unmounts with a review open", async () => {
    const desktopApi = api();
    const harness = renderSettings(desktopApi);
    const user = userEvent.setup();

    const input = await screen.findByRole("textbox", { name: "New owner username" });
    await user.clear(input);
    await user.type(input, "NewOwner");
    await user.click(screen.getByRole("button", { name: "Switch owner" }));
    await waitFor(() => expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(true));

    harness.unmount();
    expect(harness.onOwnerDialogOpenChange).toHaveBeenLastCalledWith(false);
  });
});
