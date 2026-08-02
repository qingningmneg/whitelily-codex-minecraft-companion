import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const verifierPath = join(repositoryRoot, "scripts", "verify-electron-main-imports.mjs");
const prepareScriptPath = join(repositoryRoot, "scripts", "prepare-electron-bundle.ps1");
const temporaryRoots: string[] = [];

async function verifySource(source: string) {
  const root = await mkdtemp(join(tmpdir(), "whitelily-main-imports-"));
  temporaryRoots.push(root);
  const mainPath = join(root, "main.js");
  await writeFile(mainPath, source, "utf8");
  return spawnSync(process.execPath, [verifierPath, mainPath], {
    encoding: "utf8",
    windowsHide: true,
  });
}

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("packaged Electron main import boundary", () => {
  it("accepts only Node built-ins and Electron as external runtime imports", async () => {
    const result = await verifySource(
      [
        'import { readFile } from "node:fs/promises";',
        'export { basename } from "node:path";',
        'const electron = await import("electron");',
        "const currentModule = import.meta.url;",
        "void readFile; void electron; void currentModule;",
        "",
      ].join("\n"),
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("rejects any bare package import that would be absent from app.asar", async () => {
    const result = await verifySource(
      [
        'import { z } from "zod";',
        'const toml = await import("smol-toml");',
        "void z; void toml;",
      ].join("\n"),
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "PACKAGED_MAIN_BARE_IMPORTS: smol-toml, zod",
    );
  });

  it("rejects a dynamic import whose runtime package name cannot be inspected", async () => {
    const result = await verifySource(
      [
        'const packageName = "zod";',
        "const dependency = await import(packageName);",
        "void dependency;",
      ].join("\n"),
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "PACKAGED_MAIN_BARE_IMPORTS: <dynamic-import>",
    );
  });

  it("runs the import verifier on the freshly built main bundle during release preparation", async () => {
    const prepareScript = await readFile(prepareScriptPath, "utf8");

    expect(prepareScript).toContain("verify-electron-main-imports.mjs");
    expect(prepareScript).toContain("apps/desktop/dist/main/main.js");
  });
});
