import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDesktopCodexResources } from "./main.js";

describe("resolveDesktopCodexResources", () => {
  it("uses the reviewed node_modules native package explicitly during development", () => {
    const appPath = String.raw`C:\source\whitelily\apps\desktop`;

    expect(
      resolveDesktopCodexResources({
        appPath,
        resourcesPath: String.raw`C:\untrusted\electron\resources`,
        development: true,
      }),
    ).toEqual({
      resourceRoot: resolve(
        String.raw`C:\source\whitelily`,
        "node_modules",
        "@openai",
        "codex-win32-x64",
      ),
      manifestPath: resolve(
        String.raw`C:\source\whitelily`,
        "packaging",
        "electron",
        "runtime-manifest.json",
      ),
      layout: "development",
    });
  });

  it("uses only Electron's explicit packaged resources directory in production", () => {
    const resourcesPath = String.raw`C:\Program Files\WhiteLily\resources`;

    expect(
      resolveDesktopCodexResources({
        appPath: String.raw`C:\Program Files\WhiteLily\resources\app.asar`,
        resourcesPath,
        development: false,
      }),
    ).toEqual({
      resourceRoot: resolve(resourcesPath),
      manifestPath: resolve(resourcesPath, "runtime-manifest.json"),
      layout: "packaged",
    });
  });
});
