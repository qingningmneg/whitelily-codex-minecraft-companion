import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDesktopChild } from "../../src/desktop/childMain.js";
import { DESKTOP_PROTOCOL_VERSION } from "../../src/desktop/desktopProtocol.js";
import { validConfig } from "../support/appHarness.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const require = createRequire(import.meta.url);
const unzipper = require("unzipper") as {
  Open: {
    file(path: string): Promise<{
      files: Array<{ path: string; buffer(): Promise<Buffer> }>;
    }>;
  };
};
const temporaryRoots: string[] = [];

afterEach(async () => {
  delete process.env.WHITELILY_APP_VERSION;
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("desktop child diagnostic version composition", () => {
  it("exports the one release version agreed by root, desktop, and runtime manifests", async () => {
    const [rootPackage, desktopPackage, runtimeManifest] = await Promise.all([
      readJson(join(repositoryRoot, "package.json")),
      readJson(join(repositoryRoot, "apps", "desktop", "package.json")),
      readJson(join(repositoryRoot, "packaging", "electron", "runtime-manifest.json")),
    ]);
    expect(rootPackage.version).toBe("0.2.0-beta.2");
    expect(desktopPackage.version).toBe(rootPackage.version);
    expect(runtimeManifest.productVersion).toBe(rootPackage.version);

    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-version-diagnostic-"));
    temporaryRoots.push(dataRoot);
    await writeFile(join(dataRoot, "config.toml"), validConfig, "utf8");
    process.env.WHITELILY_APP_VERSION = rootPackage.version;

    const input = new PassThrough();
    const output = new PassThrough();
    let rawOutput = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      rawOutput += chunk;
    });
    const running = runDesktopChild([], { input, output, cwd: dataRoot });
    input.write(`${request("preview", { kind: "preview_diagnostics" })}\n`);
    await vi.waitFor(() => expect(rawOutput).toContain('"id":"preview"'));
    const preview = response(rawOutput, "preview");
    expect(preview.ok).toBe(true);
    const exportId = (preview.result as { exportId: string }).exportId;

    input.write(`${request("archive", { kind: "prepare_diagnostic_archive", exportId })}\n`);
    await vi.waitFor(() => expect(rawOutput).toContain('"id":"archive"'));
    const archive = await unzipper.Open.file(join(dataRoot, "diagnostics", `${exportId}.zip`));
    const versionEntry = archive.files.find((entry) => entry.path === "app-version.json");
    expect(versionEntry).toBeDefined();
    expect(JSON.parse((await versionEntry!.buffer()).toString("utf8"))).toEqual({
      version: rootPackage.version,
    });

    input.end();
    await running;
  });
});

function request(id: string, command: Record<string, unknown>): string {
  return JSON.stringify({ version: DESKTOP_PROTOCOL_VERSION, id, command });
}

function response(rawOutput: string, id: string): Record<string, unknown> {
  const line = rawOutput
    .trim()
    .split("\n")
    .find((candidate) => (JSON.parse(candidate) as { id?: unknown }).id === id);
  if (!line) throw new Error(`response ${id} was not emitted`);
  return JSON.parse(line) as Record<string, unknown>;
}

async function readJson(path: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
}
