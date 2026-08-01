export interface StartupSettingSnapshot {
  enabled: boolean;
  available: boolean;
}

export interface LoginItemSettingsPort {
  isPackaged: boolean;
  executablePath: string;
  getLoginItemSettings(options: { path: string; args: string[] }): { openAtLogin: boolean };
  setLoginItemSettings(options: { openAtLogin: boolean; path: string; args: string[] }): void;
}

export interface StartupSettings {
  read(): StartupSettingSnapshot;
  set(enabled: boolean): StartupSettingSnapshot;
}

export function createStartupSettings(port: LoginItemSettingsPort): StartupSettings {
  const nativeOptions = (): { path: string; args: string[] } => ({
    path: port.executablePath,
    args: [],
  });
  return Object.freeze({
    read: (): StartupSettingSnapshot => {
      if (!port.isPackaged) return Object.freeze({ enabled: false, available: false });
      const current = port.getLoginItemSettings(nativeOptions());
      return Object.freeze({ enabled: current.openAtLogin === true, available: true });
    },
    set: (enabled: boolean): StartupSettingSnapshot => {
      if (typeof enabled !== "boolean") throw new Error("invalid startup setting");
      if (!port.isPackaged) {
        if (enabled) throw new Error("startup requires a packaged application");
        return Object.freeze({ enabled: false, available: false });
      }
      port.setLoginItemSettings({ openAtLogin: enabled, ...nativeOptions() });
      return Object.freeze({ enabled, available: true });
    },
  });
}
