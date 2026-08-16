import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AvatarModelCatalogSnapshot,
  AvatarModelListItem,
} from "../../../../src/avatar/avatarModelSchemas.js";
import type { WhiteLilyAvatarApi } from "../desktopApi.js";
import { AvatarModelPage } from "./AvatarModelPage.js";

beforeAll(installDesktopStyles);
afterAll(removeDesktopStyles);
afterEach(cleanup);

describe("AvatarModelPage", () => {
  it.each([736, 360])("keeps twelve cards on one horizontal track at %ipx", async (width) => {
    setContentWidth(width);
    const api = avatarApi(catalogWithTenImports());
    render(<AvatarModelPage api={api} locale="zh-CN" />);

    const track = await screen.findByTestId("avatar-model-track");
    const viewport = screen.getByTestId("avatar-model-track-viewport");
    setTrackMetrics(track, width, 2_900);
    expect(track.children).toHaveLength(12);
    expect(getComputedStyle(track).flexWrap).toBe("nowrap");
    expect(track.scrollWidth).toBeGreaterThan(viewport.clientWidth);
    expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
  });

  it("loads and subscribes once, but a locale-only rerender preserves pending state", async () => {
    const switching = deferred<AvatarModelCatalogSnapshot>();
    const api = avatarApi(catalogWithTenImports(), { switchAvatarModel: () => switching.promise });
    const user = userEvent.setup();
    const { rerender } = render(<AvatarModelPage api={api} locale="zh-CN" />);

    await user.click(await screen.findByRole("button", { name: "Imported 1" }));
    expect(screen.getByRole("status").textContent).toBe("正在切换…");
    rerender(<AvatarModelPage api={api} locale="en" />);

    expect(api.listAvatarModels).toHaveBeenCalledOnce();
    expect(api.subscribeAvatarModels).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toBe("Switching…");
  });

  it("silently leaves the catalog alone when import is cancelled", async () => {
    const importAvatarModel = vi.fn(async () => ({ status: "cancelled" as const }));
    const api = avatarApi(catalogWithTenImports(), {
      importAvatarModel,
    });
    const user = userEvent.setup();
    render(<AvatarModelPage api={api} locale="en" />);

    await user.click(await screen.findByRole("button", { name: "Import model" }));

    expect(importAvatarModel).toHaveBeenCalledWith();
    expect(screen.getByTestId("avatar-model-track").children).toHaveLength(12);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the sole confirmed selection when a switch fails", async () => {
    const api = avatarApi(catalogWithTenImports(), {
      switchAvatarModel: async () => {
        const error = Object.assign(new Error("switch failed"), { code: "AVATAR_SWITCH_FAILED" });
        throw error;
      },
    });
    const user = userEvent.setup();
    render(<AvatarModelPage api={api} locale="en" />);

    await user.click(await screen.findByRole("button", { name: "Imported 1" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The avatar model could not be switched. Try again.",
    );
    expect(screen.getAllByText("In use")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "WhiteLily 高清动漫 3D 模型设定图" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
  });

  it("does not switch the already active card", async () => {
    const api = avatarApi(catalogWithTenImports());
    const user = userEvent.setup();
    render(<AvatarModelPage api={api} locale="en" />);

    await user.click(await screen.findByRole("button", { name: "WhiteLily 高清动漫 3D 模型设定图" }));

    expect(api.switchAvatarModel).not.toHaveBeenCalled();
  });

  it("keeps a visible scrollbar and keyboard access to the last card", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const api = avatarApi(catalogWithTenImports());
    const user = userEvent.setup();
    render(<AvatarModelPage api={api} locale="en" />);

    const viewport = await screen.findByTestId("avatar-model-track-viewport");
    expect(getComputedStyle(viewport).overflowX).toBe("scroll");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Import model" }));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "WhiteLily 高清动漫 3D 模型设定图" }),
    );
    await user.keyboard("{End}");
    const lastCard = screen.getByRole("button", { name: "Imported 10" });
    expect(document.activeElement).toBe(lastCard);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "WhiteLily 高清动漫 3D 模型设定图" }),
    );
  });

  it("unsubscribes when the page unmounts", async () => {
    const unsubscribe = vi.fn();
    const api = avatarApi(catalogWithTenImports(), {
      subscribeAvatarModels: () => unsubscribe,
    });
    const view = render(<AvatarModelPage api={api} locale="en" />);

    await screen.findByTestId("avatar-model-track");
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps the page track height stable for two and twelve models", async () => {
    const two = avatarApi(catalogWithTenImports().slice(0, 2));
    const twelve = avatarApi(catalogWithTenImports());
    const { unmount } = render(<AvatarModelPage api={two} locale="en" />);
    const twoViewport = await screen.findByTestId("avatar-model-track-viewport");
    const twoHeight = getComputedStyle(twoViewport).height;
    unmount();
    render(<AvatarModelPage api={twelve} locale="en" />);
    const twelveViewport = await screen.findByTestId("avatar-model-track-viewport");
    expect(getComputedStyle(twelveViewport).height).toBe(twoHeight);
  });
});

function avatarApi(
  models: readonly AvatarModelListItem[],
  overrides: Partial<WhiteLilyAvatarApi> = {},
): WhiteLilyAvatarApi {
  const snapshot: AvatarModelCatalogSnapshot = {
    revision: 1,
    models,
    activeModelId: "builtin:whitelily-hd",
  };
  return {
    listAvatarModels: vi.fn(async () => snapshot),
    importAvatarModel: vi.fn(async () => ({ status: "cancelled" as const })),
    switchAvatarModel: vi.fn(async () => snapshot),
    subscribeAvatarModels: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

function catalogWithTenImports(): readonly AvatarModelListItem[] {
  return [
    avatar("builtin:whitelily-hd", "WhiteLily 高清动漫 3D 模型设定图", "builtin", "builtin-hd"),
    avatar("builtin:whitelily-classic", "WhiteLily Classic", "builtin", "builtin-classic"),
    ...Array.from({ length: 10 }, (_, index) =>
      avatar(
        `user:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        `Imported ${index + 1}`,
        "imported",
        "glb",
      ),
    ),
  ];
}

function avatar(
  id: string,
  displayName: string,
  origin: AvatarModelListItem["origin"],
  format: AvatarModelListItem["format"],
): AvatarModelListItem {
  return {
    id,
    displayName,
    origin,
    format,
    previewDataUrl: "data:image/png;base64,AA==",
    bodyAnimation: "whitelily-humanoid-v1",
    expressions: "full",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setContentWidth(width: number): void {
  Object.defineProperties(document.documentElement, {
    clientWidth: { configurable: true, value: width },
    scrollWidth: { configurable: true, value: width },
  });
}

function setTrackMetrics(track: HTMLElement, clientWidth: number, scrollWidth: number): void {
  Object.defineProperties(track, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
  });
}

function installDesktopStyles(): void {
  const style = document.createElement("style");
  style.id = "desktop-styles-under-test";
  style.textContent = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
  document.head.append(style);
}

function removeDesktopStyles(): void {
  document.getElementById("desktop-styles-under-test")?.remove();
}
