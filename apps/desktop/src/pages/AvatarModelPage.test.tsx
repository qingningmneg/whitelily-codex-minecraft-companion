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
const originalScrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => {
  cleanup();
  if (originalScrollIntoView) {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  } else {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});

describe("AvatarModelPage", () => {
  it("keeps twelve cards in the fixed single-line rail without leaking page overflow", async () => {
    const api = avatarApi(catalogWithTenImports());
    render(
      <div className="app-shell" data-testid="app-shell">
        <AvatarModelPage api={api} locale="zh-CN" />
      </div>,
    );

    const track = await screen.findByTestId("avatar-model-track");
    const viewport = screen.getByTestId("avatar-model-track-viewport");
    const page = screen.getByRole("main");
    const shell = screen.getByTestId("app-shell");
    const cards = screen.getAllByRole("button").filter((button) => button.dataset.avatarModelId);
    expect(track.children).toHaveLength(12);
    expect(getComputedStyle(document.documentElement).minWidth).toBe("320px");
    expect(getComputedStyle(document.body).minWidth).toBe("320px");
    expect(getComputedStyle(shell).overflow).toBe("hidden");
    expect(getComputedStyle(page).minWidth).toBe("0px");
    expect(getComputedStyle(page).overflow).toBe("hidden");
    expect(getComputedStyle(viewport).overflowX).toBe("scroll");
    expect(getComputedStyle(track).flexWrap).toBe("nowrap");
    expect(getComputedStyle(track).width).toBe("max-content");
    expect(getComputedStyle(track).height).toBe("430px");
    expect(getComputedStyle(cards[0]!).flexBasis).toBe("300px");
    expect(getComputedStyle(cards[1]!).flexBasis).toBe("220px");
    expect(getComputedStyle(screen.getByAltText("WhiteLily 高清动漫 3D 模型设定图")).height).toBe(
      "320px",
    );
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

  it("keeps an existing error, catalog, and pending card unchanged when import is cancelled", async () => {
    let publish!: (snapshot: AvatarModelCatalogSnapshot) => void;
    const api = avatarApi(catalogWithTenImports(), {
      importAvatarModel: vi.fn(async () => ({ status: "cancelled" as const })),
      switchAvatarModel: vi.fn(async () => {
        throw Object.assign(new Error("switch failed"), { code: "AVATAR_SWITCH_FAILED" });
      }),
      subscribeAvatarModels: (listener) => {
        publish = listener;
        return () => undefined;
      },
    });
    const user = userEvent.setup();
    render(<AvatarModelPage api={api} locale="en" />);

    await user.click(await screen.findByRole("button", { name: "Imported 1" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The avatar model could not be switched. Try again.",
    );
    act(() =>
      publish({
        revision: 2,
        models: catalogWithTenImports(),
        activeModelId: "builtin:whitelily-hd",
        pendingModelId: "user:00000000-0000-4000-8000-000000000001",
      }),
    );
    const originalTrack = screen.getByTestId("avatar-model-track");

    await user.click(screen.getByRole("button", { name: "Import model" }));

    expect(screen.getByRole("alert").textContent).toBe(
      "The avatar model could not be switched. Try again.",
    );
    expect(screen.getByTestId("avatar-model-track")).toBe(originalTrack);
    expect(screen.getByRole("status").textContent).toBe("Switching…");
  });

  it.each([
    ["AVATAR_FORMAT_UNSUPPORTED", "This avatar model format is not supported."],
    ["AVATAR_GLB_INVALID", "The avatar model file is invalid."],
    ["AVATAR_EXTERNAL_RESOURCE", "The avatar model must not use external resources."],
    ["AVATAR_REQUIRED_BONE_MISSING", "The avatar model is missing required bones."],
    ["AVATAR_PREVIEW_FAILED", "The avatar preview could not be created. Try again."],
    ["AVATAR_DIGEST_MISMATCH", "The avatar model changed while it was being imported. Try again."],
    ["AVATAR_IMPORT_FAILED", "The avatar model could not be imported. Try again."],
  ])("shows the localized stable error for %s", async (code, message) => {
    const api = avatarApi(catalogWithTenImports(), {
      importAvatarModel: vi.fn(async () => {
        throw Object.assign(new Error("transport message"), { code });
      }),
    });
    const user = userEvent.setup();
    render(<AvatarModelPage api={api} locale="en" />);

    await user.click(await screen.findByRole("button", { name: "Import model" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
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

  it("keeps the sidebar collapsed by the 360px media rule", () => {
    const stylesheet = [...document.styleSheets].find(
      (candidate) =>
        candidate.ownerNode instanceof HTMLElement &&
        candidate.ownerNode.id === "desktop-styles-under-test",
    );
    const compactRule = [...(stylesheet?.cssRules ?? [])].find(
      (rule) => rule instanceof CSSMediaRule && rule.conditionText === "(max-width: 940px)",
    ) as CSSMediaRule | undefined;
    const sidebarRule = [...(compactRule?.cssRules ?? [])].find(
      (rule) => rule instanceof CSSStyleRule && rule.selectorText === ".sidebar",
    ) as CSSStyleRule | undefined;
    const narrowRule = [...(stylesheet?.cssRules ?? [])].find(
      (rule) => rule instanceof CSSMediaRule && rule.conditionText === "(max-width: 680px)",
    ) as CSSMediaRule | undefined;
    const hiddenNavigationRule = [...(narrowRule?.cssRules ?? [])].find(
      (rule) =>
        rule instanceof CSSStyleRule && rule.selectorText === ".nav-list li:not(:first-child)",
    ) as CSSStyleRule | undefined;

    expect(compactRule).toBeTruthy();
    expect(sidebarRule?.style.paddingInline).toBe("0.7rem");
    expect(narrowRule).toBeTruthy();
    expect(hiddenNavigationRule?.style.display).toBe("none");
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

function installDesktopStyles(): void {
  const style = document.createElement("style");
  style.id = "desktop-styles-under-test";
  style.textContent = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
  document.head.append(style);
}

function removeDesktopStyles(): void {
  document.getElementById("desktop-styles-under-test")?.remove();
}
