import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceVersionEnvironment,
  resolveDesktopCodexWorkspaceResources,
} from "./codexWorkspaceProvisioner.js";
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

describe("resolveDesktopCodexWorkspaceResources", () => {
  it("resolves the reviewed repository workspace during development", () => {
    const appPath = String.raw`C:\source\whitelily\apps\desktop`;

    expect(
      resolveDesktopCodexWorkspaceResources({
        appPath,
        resourcesPath: String.raw`C:\untrusted\electron\resources`,
        development: true,
      }),
    ).toEqual({
      resourceDirectory: resolve(String.raw`C:\source\whitelily`, "codex-workspace"),
      manifestPath: resolve(
        String.raw`C:\source\whitelily`,
        "codex-workspace",
        "workspace-manifest.json",
      ),
    });
  });

  it("resolves only Electron's packaged codex-workspace resource", () => {
    const resourcesPath = String.raw`C:\Program Files\WhiteLily\resources`;

    expect(
      resolveDesktopCodexWorkspaceResources({
        appPath: String.raw`C:\Program Files\WhiteLily\resources\app.asar`,
        resourcesPath,
        development: false,
      }),
    ).toEqual({
      resourceDirectory: resolve(resourcesPath, "codex-workspace"),
      manifestPath: resolve(resourcesPath, "codex-workspace", "workspace-manifest.json"),
    });
  });

  it("passes only the bounded verified content version to the child environment", () => {
    expect(
      createWorkspaceVersionEnvironment({
        contentVersion: "release-1.2_3",
        installed: true,
        repaired: false,
        targetDirectory: String.raw`C:\Users\Owner\AppData\Local\WhiteLily\codex-workspace`,
      }),
    ).toEqual({ WHITELILY_WORKSPACE_VERSION: "release-1.2_3" });
  });

  it("rejects an unbounded workspace version before supervisor construction", () => {
    expect(() =>
      createWorkspaceVersionEnvironment({
        contentVersion: "../not-attested",
        installed: true,
        repaired: false,
        targetDirectory: String.raw`C:\Users\Owner\AppData\Local\WhiteLily\codex-workspace`,
      }),
    ).toThrow("WhiteLily workspace version is invalid");
  });
});
