import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AvatarModelListItem } from "../../../../src/avatar/avatarModelSchemas.js";
import { AvatarModelCard } from "./AvatarModelCard.js";

const hdModel: AvatarModelListItem = {
  id: "builtin:whitelily-hd",
  displayName: "WhiteLily 高清动漫 3D 模型设定图",
  origin: "builtin",
  format: "builtin-hd",
  previewDataUrl: "data:image/png;base64,AA==",
  bodyAnimation: "whitelily-humanoid-v1",
  expressions: "full",
};

describe("AvatarModelCard", () => {
  beforeAll(installDesktopStyles);
  afterAll(removeDesktopStyles);

  it("keeps the built-in HD turnaround image fully contained without changing its aspect ratio", () => {
    render(
      <AvatarModelCard
        locale="zh-CN"
        model={hdModel}
        active
        pending={false}
        onSelect={vi.fn()}
      />,
    );

    const image = screen.getByAltText("WhiteLily 高清动漫 3D 模型设定图");
    expect(getComputedStyle(image).objectFit).toBe("contain");
    expect(screen.getByText("正在使用")).toBeTruthy();
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
