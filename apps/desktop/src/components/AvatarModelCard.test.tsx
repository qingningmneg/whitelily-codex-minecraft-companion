import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AvatarAppearanceListItem } from "../../../../src/avatar/avatarModelSchemas.js";
import { AvatarModelCard } from "./AvatarModelCard.js";

const hdModel: AvatarAppearanceListItem = {
  id: "builtin:whitelily",
  displayName: "WhiteLily",
  origin: "builtin",
  worldRenderer: "minecraft-skin",
  armModel: "slim",
  previewDataUrl: "data:image/png;base64,AA==",
  portraitDataUrl: "data:image/png;base64,BB==",
};

describe("AvatarModelCard", () => {
  beforeAll(installDesktopStyles);
  afterAll(removeDesktopStyles);
  afterEach(() => cleanup());

  it("keeps the built-in portrait fully contained without changing its aspect ratio", () => {
    render(
      <AvatarModelCard locale="zh-CN" model={hdModel} active pending={false} onSelect={vi.fn()} />,
    );

    const image = screen.getByAltText("WhiteLily");
    expect(getComputedStyle(image).objectFit).toBe("contain");
    expect(image.getAttribute("src")).toBe(hdModel.portraitDataUrl);
    expect(screen.getByText("正在使用")).toBeTruthy();
  });

  it("shows a stable fallback when a portrait cannot load", () => {
    render(
      <AvatarModelCard
        locale="en"
        model={hdModel}
        active={false}
        pending={false}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.error(screen.getByRole("img"));

    expect(screen.getByTestId("avatar-preview-fallback")).toBeTruthy();
  });

  it("keeps the confirmed active model labelled while another card is pending", () => {
    render(
      <AvatarModelCard
        locale="en"
        model={{ ...hdModel, displayName: "WhiteLily HD" }}
        active
        pending={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("In use")).toBeTruthy();
  });
});

function installDesktopStyles(): void {
  const style = document.createElement("style");
  style.id = "desktop-styles-under-test";
  style.textContent = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
  document.head.append(style);
}

function removeDesktopStyles(): void {
  document.getElementById("desktop-styles-under-test")?.remove();
}
