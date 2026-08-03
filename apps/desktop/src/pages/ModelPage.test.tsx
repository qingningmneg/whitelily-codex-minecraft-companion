import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
        legacyMigrationCompleted: true,
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

  it("disables duplicate apply while switching and renders backend-confirmed success", async () => {
    let resolveSelection!: (
      selection: Awaited<ReturnType<WhiteLilyDesktopApi["selectModel"]>>,
    ) => void;
    const pendingSelection = new Promise<Awaited<ReturnType<WhiteLilyDesktopApi["selectModel"]>>>(
      (resolve) => {
        resolveSelection = resolve;
      },
    );
    const selectModel = vi.fn<WhiteLilyDesktopApi["selectModel"]>(() => pendingSelection);
    const listModels = vi.fn<WhiteLilyDesktopApi["listModels"]>(async () => ({
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
      selection: {
        mode: "explicit",
        modelId: "live-model-a",
        reasoningEffort: "low",
        available: true,
      },
      legacyMigrationCompleted: true,
    }));
    const api = { listModels, selectModel } as unknown as WhiteLilyDesktopApi;
    const user = userEvent.setup();
    render(<ModelPage api={api} locale="zh-CN" />);

    await user.selectOptions(await screen.findByLabelText("模型"), "live-model-b");
    await user.click(screen.getByRole("button", { name: "应用模型" }));

    const pendingButton = screen.getByRole("button", { name: "正在切换…" });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(pendingButton);
    expect(selectModel).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSelection({
        mode: "explicit",
        modelId: "live-model-b",
        reasoningEffort: "medium",
        available: true,
      });
      await pendingSelection;
    });

    expect((await screen.findByRole("status")).textContent).toBe("已切换到 Live Model B · medium");
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("restores the previous confirmed selection and offers a localized retry after failure", async () => {
    const selectModel = vi.fn<WhiteLilyDesktopApi["selectModel"]>(async () => {
      throw new Error("MODEL_OPERATION_FAILED");
    });
    const api = {
      listModels: vi.fn<WhiteLilyDesktopApi["listModels"]>(async () => ({
        models: [
          {
            id: "live-model-a",
            displayName: "Live Model A",
            supportedReasoningEfforts: ["low"],
          },
          {
            id: "live-model-b",
            displayName: "Live Model B",
            supportedReasoningEfforts: ["medium"],
          },
        ],
        selection: {
          mode: "explicit",
          modelId: "live-model-a",
          reasoningEffort: "low",
          available: true,
        },
        legacyMigrationCompleted: true,
      })),
      selectModel,
    } as unknown as WhiteLilyDesktopApi;
    const user = userEvent.setup();
    render(<ModelPage api={api} locale="en" />);

    const model = await screen.findByLabelText("Model");
    await user.selectOptions(model, "live-model-b");
    await user.click(screen.getByRole("button", { name: "Apply model" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The model could not be switched. Try again.",
    );
    await waitFor(() => expect((model as HTMLSelectElement).value).toBe("live-model-a"));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(selectModel).toHaveBeenCalledTimes(2);
    expect(selectModel).toHaveBeenLastCalledWith({
      mode: "explicit",
      modelId: "live-model-b",
      reasoningEffort: "medium",
    });
  });
});
