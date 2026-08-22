// @vitest-environment node

import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "vite";
import {
  provisionCodexWorkspace,
  resolveDesktopCodexWorkspaceResources,
} from "./codexWorkspaceProvisioner.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("desktop development child entry", () => {
  it("orders child compilation before development workspace publication", async () => {
    const packageJson = JSON.parse(
      await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { scripts: { predev: string } };
    expect(packageJson.scripts.predev).toBe(
      "npm run build:desktop-child --prefix ../.. && npm run build:desktop-dev-workspace --prefix ../..",
    );
  });

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

  it("workspace predev builds the child before exposing an attested development workspace", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "whitelily-desktop-child-"));
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-desktop-data-"));
    temporaryRoots.push(outputRoot);
    temporaryRoots.push(dataRoot);
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

    const resources = resolveDesktopCodexWorkspaceResources({
      appPath: join(import.meta.dirname, ".."),
      resourcesPath: join(import.meta.dirname, "untrusted-resources"),
      development: true,
    });
    expect((await readdir(resources.resourceDirectory, { recursive: true })).sort()).toEqual([
      ".codex",
      join(".codex", "config.toml"),
      "AGENTS.md",
      "workspace-manifest.json",
    ]);

    const first = await provisionCodexWorkspace({
      resourceDirectory: resources.resourceDirectory,
      dataRoot,
    });
    expect(first).toMatchObject({ installed: true, repaired: false });
    expect(JSON.parse(await readFile(resources.manifestPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      files: [
        { path: ".codex/config.toml", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        { path: "AGENTS.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      ],
    });

    await writeFile(join(first.targetDirectory, "AGENTS.md"), "drifted\n", "utf8");
    await expect(
      provisionCodexWorkspace({ resourceDirectory: resources.resourceDirectory, dataRoot }),
    ).resolves.toMatchObject({ installed: true, repaired: true });
    expect(await readFile(join(first.targetDirectory, "AGENTS.md"), "utf8")).toBe(
      await readFile(join(resources.resourceDirectory, "AGENTS.md"), "utf8"),
    );
  }, 35_000);
});
