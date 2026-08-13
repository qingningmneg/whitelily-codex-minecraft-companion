import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhiteLilyDesktopApi } from "../desktopApi.js";
import { ApplicationExitButton } from "./ApplicationExitButton.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

describe("ApplicationExitButton", () => {
  afterEach(cleanup);

  it("invokes application quit once and remains disabled while the app exits", async () => {
    const operation = deferred<void>();
    const quitApplication = vi.fn(() => operation.promise);
    render(
      <ApplicationExitButton
        api={{ quitApplication } as Pick<WhiteLilyDesktopApi, "quitApplication">}
        locale="zh-CN"
      />,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "退出 WhiteLily" });

    await user.click(button);
    await user.click(button);

    expect(quitApplication).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toBe("正在退出…");
    operation.resolve();
  });

  it("recovers with a fixed localized failure without exposing the rejection", async () => {
    const operation = deferred<void>();
    const quitApplication = vi.fn(() => operation.promise);
    render(
      <ApplicationExitButton
        api={{ quitApplication } as Pick<WhiteLilyDesktopApi, "quitApplication">}
        locale="en"
      />,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Quit WhiteLily" });

    await user.click(button);
    operation.reject(new Error(String.raw`sentinel PID=1234 C:\private\raw.log`));

    expect((await screen.findByRole("status")).textContent).toBe(
      "WhiteLily could not quit. Please try again.",
    );
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(document.body.textContent).not.toContain("sentinel");
    expect(document.body.textContent).not.toContain("1234");
    expect(document.body.textContent).not.toContain("private");
  });

  it("recovers from a failed quit after the StrictMode effect replay", async () => {
    const operation = deferred<void>();
    const quitApplication = vi.fn(() => operation.promise);
    render(
      <StrictMode>
        <ApplicationExitButton
          api={{ quitApplication } as Pick<WhiteLilyDesktopApi, "quitApplication">}
          locale="en"
        />
      </StrictMode>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Quit WhiteLily" });

    await user.click(button);
    operation.reject(new Error("strict-mode sentinel"));

    expect((await screen.findByRole("status")).textContent).toBe(
      "WhiteLily could not quit. Please try again.",
    );
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not render failure state after the control unmounts", async () => {
    const operation = deferred<void>();
    const quitApplication = vi.fn(() => operation.promise);
    const view = render(
      <ApplicationExitButton
        api={{ quitApplication } as Pick<WhiteLilyDesktopApi, "quitApplication">}
        locale="en"
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Quit WhiteLily" }));
    view.unmount();
    await act(async () => {
      operation.reject(new Error("unmounted sentinel"));
      await operation.promise.catch(() => undefined);
    });

    expect(screen.queryByRole("status")).toBeNull();
    expect(document.body.textContent).not.toContain("unmounted sentinel");
  });
});
