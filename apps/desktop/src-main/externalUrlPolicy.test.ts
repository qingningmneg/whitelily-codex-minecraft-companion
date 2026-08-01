// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createExternalUrlHandlers, ExternalUrlPolicy } from "./externalUrlPolicy.js";

const repositoryUrl = "https://github.com/qingningmneg/whitelily-codex-minecraft-companion";
const releasesUrl =
  "https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/tag/v0.2.0-beta.1";

describe("ExternalUrlPolicy", () => {
  it("allows only the WhiteLily repository and Releases paths on GitHub", () => {
    const policy = new ExternalUrlPolicy();

    expect(policy.canOpen(repositoryUrl)).toBe(true);
    expect(policy.canOpen(`${repositoryUrl}/`)).toBe(true);
    expect(policy.canOpen(releasesUrl)).toBe(true);
    expect(policy.canOpen(`${repositoryUrl}/issues`)).toBe(false);
    expect(policy.canOpen("https://github.com/other/whitelily-codex-minecraft-companion")).toBe(
      false,
    );
    expect(
      policy.canOpen(
        "https://github.com/qingningmneg/whitelily-codex-minecraft-companion.evil.example/releases",
      ),
    ).toBe(false);
  });

  it.each([
    "http://github.com/qingningmneg/whitelily-codex-minecraft-companion",
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    "not a URL",
    "https://identity!@github.com/qingningmneg/whitelily-codex-minecraft-companion",
    "https://github.com:443/qingningmneg/whitelily-codex-minecraft-companion",
    "https://github.com:8443/qingningmneg/whitelily-codex-minecraft-companion",
    "https://github.com./qingningmneg/whitelily-codex-minecraft-companion",
    "https://github.com\\qingningmneg\\whitelily-codex-minecraft-companion",
    "https://github.com/qingningmneg/other/../whitelily-codex-minecraft-companion",
    "https://github.com/qingningmneg/%2e%2e/qingningmneg/whitelily-codex-minecraft-companion",
    "https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases%2ftag/v1",
    "https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases%5ctag/v1",
  ])("rejects non-HTTPS or malformed external URLs: %s", (url) => {
    expect(new ExternalUrlPolicy().canOpen(url)).toBe(false);
  });

  it("allows canonical HTTPS host casing, query strings, and fragments", () => {
    const policy = new ExternalUrlPolicy();

    expect(
      policy.canOpen(
        "HTTPS://GITHUB.COM/qingningmneg/whitelily-codex-minecraft-companion/releases?after=v1#notes",
      ),
    ).toBe(true);
    expect(policy.canOpen(`${repositoryUrl}#readme`)).toBe(true);
  });

  it("allows exactly one active main-validated Codex login URL", () => {
    const policy = new ExternalUrlPolicy();
    const first = "https://auth.openai.com/authorize?client_id=codex&state=first";
    const second = "https://chatgpt.com/auth/login?state=second";

    expect(policy.canOpen(first)).toBe(false);
    policy.setActiveCodexLoginUrl(first);
    expect(policy.canOpen(first)).toBe(true);
    expect(policy.canOpen(`${first}-changed`)).toBe(false);

    policy.setActiveCodexLoginUrl(second);
    expect(policy.canOpen(first)).toBe(false);
    expect(policy.canOpen(second)).toBe(true);

    policy.clearActiveCodexLoginUrl();
    expect(policy.canOpen(second)).toBe(false);
  });

  it.each([
    "http://auth.openai.com/authorize",
    "https://openai.com.evil.example/authorize",
    "https://example.com/login",
    "file:///C:/login.html",
  ])("refuses to activate a Codex login URL outside validated HTTPS origins: %s", (url) => {
    expect(() => new ExternalUrlPolicy().setActiveCodexLoginUrl(url)).toThrow(
      "invalid Codex login URL",
    );
  });

  it.each([
    "https://identity!@auth.openai.com/authorize",
    "https://auth.openai.com:443/authorize",
    "https://auth.openai.com.evil.example/authorize",
    "https://auth.openai.com\\@evil.example/authorize",
  ])("refuses ambiguous Codex login authority: %s", (url) => {
    expect(() => new ExternalUrlPolicy().setActiveCodexLoginUrl(url)).toThrow(
      "invalid Codex login URL",
    );
  });
});

describe("external URL Electron handlers", () => {
  it("uses the same allowlist decision for new windows and renderer navigation", () => {
    const opened: string[] = [];
    const handlers = createExternalUrlHandlers(new ExternalUrlPolicy(), (url) => {
      opened.push(url);
    });
    const allowedNavigation = { preventDefault: vi.fn() };
    const deniedNavigation = { preventDefault: vi.fn() };

    expect(handlers.openWindow({ url: repositoryUrl })).toEqual({ action: "deny" });
    handlers.navigate(allowedNavigation, releasesUrl);
    handlers.navigate(deniedNavigation, "http://example.com");

    expect(allowedNavigation.preventDefault).toHaveBeenCalledOnce();
    expect(deniedNavigation.preventDefault).toHaveBeenCalledOnce();
    expect(opened).toEqual([repositoryUrl, releasesUrl]);
  });
});
