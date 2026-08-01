// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createStartupSettings } from "./startupSettings.js";

describe("native startup settings", () => {
  it("defaults off and fails closed outside a packaged application", () => {
    const setLoginItemSettings = vi.fn();
    const settings = createStartupSettings({
      isPackaged: false,
      executablePath: String.raw`C:\repo\node_modules\electron\electron.exe`,
      getLoginItemSettings: vi.fn(),
      setLoginItemSettings,
    });

    expect(settings.read()).toEqual({ enabled: false, available: false });
    expect(() => settings.set(true)).toThrow("packaged application");
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("uses only the current packaged executable and never renderer paths or arguments", () => {
    const getLoginItemSettings = vi.fn(() => ({ openAtLogin: false }));
    const setLoginItemSettings = vi.fn();
    const settings = createStartupSettings({
      isPackaged: true,
      executablePath: String.raw`C:\Program Files\WhiteLily\WhiteLily.exe`,
      getLoginItemSettings,
      setLoginItemSettings,
    });

    expect(settings.read()).toEqual({ enabled: false, available: true });
    expect(settings.set(true)).toEqual({ enabled: true, available: true });
    expect(getLoginItemSettings).toHaveBeenCalledWith({
      path: String.raw`C:\Program Files\WhiteLily\WhiteLily.exe`,
      args: [],
    });
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: String.raw`C:\Program Files\WhiteLily\WhiteLily.exe`,
      args: [],
    });
  });
});
