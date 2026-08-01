import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhiteLilyDesktopApi } from "../desktopApi.js";
import { ModelPage } from "./ModelPage.js";

describe("ModelPage", () => {
  afterEach(cleanup);

  it("renders only live catalog models and their supported reasoning efforts", async () => {
    const selectModel = vi.fn<WhiteLilyDesktopApi["selectModel"]>(async (selection) =>
      selection.mode === "automatic" ? selection : { ...selection, available: true },
    );
    const api = {
      listModels: vi.fn(async () => ({
        models: [
          {
            id: "live-model-a",
            displayName: "Live Model A",
            supportedReasoningEfforts: ["low", "high"],
          },
          {
            id: "live-model-b",
            displayName: "Live Model B",
            supportedReasoningEfforts: ["medium"],
          },
        ],
        selection: { mode: "automatic" as const },
      })),
      selectModel,
    } as unknown as WhiteLilyDesktopApi;
    render(<ModelPage api={api} locale="en" />);

    expect(await screen.findByRole("option", { name: "Live Model A" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Live Model B" })).toBeTruthy();
    expect(screen.queryByText(/GPT-4/i)).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Model"), "live-model-a");
    expect(screen.getByRole("option", { name: "low" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "high" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "medium" })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Reasoning effort"), "high");
    await userEvent.click(screen.getByRole("button", { name: "Apply model" }));

    expect(selectModel).toHaveBeenCalledWith({
      mode: "explicit",
      modelId: "live-model-a",
      reasoningEffort: "high",
    });
  });
});
