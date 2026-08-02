import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const desktopRoot = join(repositoryRoot, "apps", "desktop");

describe("packaged Electron renderer", () => {
  it("builds relative asset URLs that load from the installed file URL", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "whitelily-renderer-"));
    try {
      await build({
        configFile: join(desktopRoot, "vite.config.ts"),
        root: desktopRoot,
        mode: "renderer",
        logLevel: "silent",
        build: {
          emptyOutDir: true,
          outDir,
        },
      });

      const html = await readFile(join(outDir, "index.html"), "utf8");
      const assetUrls = [...html.matchAll(/\b(?:src|href)="([^"]+)"/gu)].map((match) => match[1]!);

      expect(assetUrls.length).toBeGreaterThan(0);
      expect(assetUrls.every((url) => url.startsWith("./assets/"))).toBe(true);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
