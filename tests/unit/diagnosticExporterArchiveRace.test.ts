import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  enabled: false,
  swapped: false,
  diagnosticsRoot: "",
  outside: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => {
      const result = await actual.realpath(path);
      if (race.enabled && !race.swapped && String(path) === race.diagnosticsRoot) {
        race.swapped = true;
        await actual.rm(race.diagnosticsRoot, { recursive: true });
        await actual.symlink(race.outside, race.diagnosticsRoot, "junction");
      }
      return result;
    },
  };
});

import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DiagnosticExporter } from "../../src/diagnostics/diagnosticExporter.js";

const cleanup: string[] = [];

afterEach(async () => {
  race.enabled = false;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DiagnosticExporter archive parent identity", () => {
  it("writes no ZIP bytes when diagnostics is replaced after its trust check", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-archive-race-"));
    const outside = await mkdtemp(join(tmpdir(), "whitelily-archive-race-outside-"));
    cleanup.push(dataRoot, outside);
    await mkdir(join(dataRoot, "logs"), { recursive: true });
    await writeFile(join(dataRoot, "logs", "companion.log"), "", "utf8");
    await writeFile(join(dataRoot, "logs", "audit.jsonl"), "", "utf8");
    await mkdir(join(dataRoot, "diagnostics"), { recursive: true });
    const exporter = new DiagnosticExporter({
      dataRoot,
      appVersion: "0.1.1",
      osSummary: {},
      dependencyVersions: {},
      compatibilityManifest: {},
      configSchemaSummary: {},
      createExportId: () => "preview_1234567890",
    });
    const preview = await exporter.preview();
    race.diagnosticsRoot = join(dataRoot, "diagnostics");
    race.outside = outside;
    race.swapped = false;
    race.enabled = true;

    await expect(exporter.createArchive(preview.exportId)).rejects.toThrow();

    expect(race.swapped).toBe(true);
    const outsideArchive = join(outside, `${preview.exportId}.zip`);
    let outsideBytes = 0;
    try {
      outsideBytes = (await readFile(outsideArchive)).byteLength;
    } catch {
      // Rejection before exclusive creation is also safe.
    }
    expect(outsideBytes).toBe(0);
    await expect(access(outsideArchive)).rejects.toThrow();
    await expect(exporter.createArchive(preview.exportId)).rejects.not.toThrow(
      /EEXIST|already exists/u,
    );
  });
});
