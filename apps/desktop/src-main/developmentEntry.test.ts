// @vitest-environment node

import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "vite";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("desktop development child entry", () => {
  it("serves the renderer on the same fixed IPv4 origin awaited and loaded by Electron", async () => {
    const config = await resolveConfig(
      {
        configFile: join(import.meta.dirname, "..", "vite.config.ts"),
      },
      "serve",
    );

    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.port).toBe(5_173);
    expect(config.server.strictPort).toBe(true);
  });

  it("workspace predev creates the fixed child entry without a stale root dist", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "whitelily-desktop-child-"));
    temporaryRoots.push(outputRoot);
    const npmCli = process.env.npm_execpath;
    expect(npmCli).toBeTruthy();

    await expect(access(join(outputRoot, "src", "desktop", "childMain.js"))).rejects.toThrow();

    await execFileAsync(
      process.execPath,
      [npmCli!, "run", "predev", "--workspace", "@whitelily/desktop"],
      {
        cwd: join(import.meta.dirname, "..", "..", ".."),
        env: {
          ...process.env,
          WHITELILY_DESKTOP_CHILD_OUT_DIR: outputRoot,
        },
        timeout: 30_000,
        windowsHide: true,
      },
    );

    await expect(
      access(join(outputRoot, "src", "desktop", "childMain.js")),
    ).resolves.toBeUndefined();
  }, 35_000);
});
