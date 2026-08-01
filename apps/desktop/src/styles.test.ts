import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

const contrastPairs = [
  ["--text-primary", "--surface-page"],
  ["--text-primary", "--surface-card"],
  ["--text-secondary", "--surface-page"],
  ["--text-secondary", "--surface-card"],
  ["--text-muted", "--surface-page"],
  ["--text-muted", "--surface-card"],
  ["--text-accent", "--surface-page"],
  ["--text-accent", "--surface-active"],
  ["--text-alert", "--surface-alert"],
  ["--text-emergency", "--surface-emergency"],
  ["--text-success", "--surface-success"],
  ["--text-on-emergency", "--emergency-bg"],
  ["--text-on-brand", "--brand-bg-start"],
  ["--text-on-brand", "--brand-bg-end"],
] as const;

describe("desktop style safety invariants", () => {
  it("keeps the safety rail outside the independently scrolling content", () => {
    const homeRule = css.match(/\.home\s*\{([^}]+)\}/su)?.[1];
    expect(homeRule).toMatch(/height:\s*100vh/u);
    expect(homeRule).toMatch(/overflow:\s*hidden/u);
    expect(homeRule).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto/u);
    expect(css).toMatch(/\.home-scroll\s*\{[^}]*overflow-y:\s*auto/su);
    const safetyRailRule = css.match(/\.safety-rail\s*\{([^}]+)\}/su)?.[1];
    expect(safetyRailRule).toMatch(/position:\s*sticky/u);
    expect(safetyRailRule).toMatch(/bottom:\s*0/u);
  });

  it("lets long model labels shrink inside the onboarding panel", () => {
    const pickerRule = css.match(/\.model-picker\s*\{([^}]+)\}/su)?.[1];
    const labelRule = css.match(/\.model-picker label\s*\{([^}]+)\}/su)?.[1];
    const selectRule = css.match(/\.model-picker select\s*\{([^}]+)\}/su)?.[1];
    const statusRule = css.match(/\.model-picker__status\s*\{([^}]+)\}/su)?.[1];

    for (const rule of [pickerRule, labelRule, selectRule]) {
      expect(rule).toMatch(/min-width:\s*0/u);
      expect(rule).toMatch(/width:\s*100%/u);
    }
    expect(labelRule).toMatch(/max-width:\s*100%/u);
    expect(selectRule).toMatch(/max-width:\s*100%/u);
    expect(statusRule).toMatch(/min-width:\s*0/u);
    expect(statusRule).toMatch(/max-width:\s*100%/u);
    expect(statusRule).toMatch(/overflow-wrap:\s*anywhere/u);
  });

  it("audits every normal text token at 4.5:1 or better", () => {
    const normalCss = css.split("@media (forced-colors: active)")[0] ?? css;
    const tokenValues = readRootTokens(css);
    const auditedTextTokens = new Set<string>(contrastPairs.map(([foreground]) => foreground));
    const directColors = [...normalCss.matchAll(/^\s*color:\s*([^;]+);/gmu)].map(([, value]) =>
      value.trim(),
    );

    expect(directColors.length).toBeGreaterThan(0);
    for (const value of directColors) {
      expect(value).toMatch(/^var\((--[\w-]+)\)$/u);
      const token = /^var\((--[\w-]+)\)$/u.exec(value)?.[1];
      expect(token && auditedTextTokens.has(token)).toBe(true);
    }

    for (const [foreground, background] of contrastPairs) {
      expect(
        contrast(tokenValues.get(foreground), tokenValues.get(background)),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("defines forced-colors focus, disabled, alert, emergency, and rail states", () => {
    const forcedColors = css.match(/@media \(forced-colors: active\)\s*\{([\s\S]+)\}\s*$/u)?.[1];

    expect(forcedColors).toBeTruthy();
    expect(forcedColors).toMatch(/:focus-visible/u);
    expect(forcedColors).toMatch(/button:disabled/u);
    expect(forcedColors).toMatch(
      /\.state-panel--error[\s\S]*\.action-error[\s\S]*\.runtime-error/u,
    );
    expect(forcedColors).toMatch(/\.emergency-button/u);
    expect(forcedColors).toMatch(/\.safety-rail/u);
    for (const systemColor of ["Canvas", "CanvasText", "Highlight", "GrayText"]) {
      expect(forcedColors).toContain(systemColor);
    }
  });
});

function readRootTokens(source: string): Map<string, string> {
  const root = source.match(/:root\s*\{([^}]+)\}/su)?.[1] ?? "";
  return new Map(
    [...root.matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/giu)].map(([, name, value]) => [name, value]),
  );
}

function contrast(foreground: string | undefined, background: string | undefined): number {
  expect(foreground).toBeTruthy();
  expect(background).toBeTruthy();
  const foregroundLuminance = luminance(foreground!);
  const backgroundLuminance = luminance(background!);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/gu)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
