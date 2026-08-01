import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhiteLilyTask5Api } from "../desktopApi.js";
import { DiagnosticsPage } from "./DiagnosticsPage.js";

function api() {
  return {
    previewDiagnostics: vi.fn(async () => ({
      exportId: "diagnostic_1234567890",
      files: [
        { logicalName: "app-version.json", size: 24, redactions: 0 },
        { logicalName: "app-log.jsonl", size: 640, redactions: 7 },
      ],
      omitted: ["authentication-data", "complete-memories", "raw-chat"],
    })),
    exportDiagnostics: vi.fn(async () => ({ status: "saved" as const })),
  } as unknown as WhiteLilyTask5Api;
}

describe("DiagnosticsPage", () => {
  afterEach(cleanup);

  it("shows the local-only whitelist preview, omissions, and redaction counts", async () => {
    const desktopApi = api();
    render(<DiagnosticsPage api={desktopApi} locale="en" />);

    expect(await screen.findByRole("heading", { name: "Logs & diagnostics" })).toBeTruthy();
    expect(screen.getByText("app-version.json")).toBeTruthy();
    expect(screen.getByText("app-log.jsonl")).toBeTruthy();
    expect(screen.getByText("7 redactions")).toBeTruthy();
    expect(screen.getByText("Authentication data")).toBeTruthy();
    expect(screen.getByText("Complete memories")).toBeTruthy();
    expect(screen.getByText("Raw chat")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /send|upload/iu })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("can approve only the active opaque preview ID and exposes no destination input", async () => {
    const desktopApi = api();
    render(<DiagnosticsPage api={desktopApi} locale="en" />);

    await screen.findByText("app-log.jsonl");
    await userEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
    await waitFor(() =>
      expect(desktopApi.exportDiagnostics).toHaveBeenCalledWith("diagnostic_1234567890"),
    );
    expect(await screen.findByText("Diagnostic archive saved")).toBeTruthy();
    expect(screen.queryByLabelText(/path|destination/iu)).toBeNull();
  });

  it("renders Chinese-default copy from the complete bilingual catalog", async () => {
    render(<DiagnosticsPage api={api()} locale="zh-CN" />);
    expect(await screen.findByRole("heading", { name: "日志与诊断" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "导出诊断包" })).toBeTruthy();
  });
});
