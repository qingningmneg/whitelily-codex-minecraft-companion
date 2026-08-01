import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  target: "",
  saved: "",
  triggered: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const injectSwap = async (path: string): Promise<void> => {
    if (race.triggered || path !== race.target) return;
    race.triggered = true;
    await actual.rename(path, race.saved);
    await actual.writeFile(path, "same-path replacement", "utf8");
  };
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await injectSwap(from);
      return actual.rename(from, to);
    },
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ) => {
      await injectSwap(String(path));
      return actual.rm(path, options);
    },
  };
});

import { DiagnosticExporter } from "../../src/diagnostics/diagnosticExporter.js";

const cleanup: string[] = [];

afterEach(async () => {
  race.target = "";
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DiagnosticExporter retained archive cleanup identity", () => {
  it("preserves a same-path replacement introduced at the destructive boundary", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-retained-cleanup-race-"));
    cleanup.push(dataRoot);
    await mkdir(join(dataRoot, "logs"), { recursive: true });
    await writeFile(join(dataRoot, "logs", "companion.log"), "", "utf8");
    await writeFile(join(dataRoot, "logs", "audit.jsonl"), "", "utf8");
    const exporter = new DiagnosticExporter({
      dataRoot,
      appVersion: "0.1.1",
      osSummary: {},
      dependencyVersions: {},
      compatibilityManifest: {},
      configSchemaSummary: {},
      createExportId: () => "preview_cleanup_race_1234",
    });
    const preview = await exporter.preview();
    const prepared = await exporter.createArchive(preview.exportId);
    race.target = prepared.path;
    race.saved = `${prepared.path}.saved-original`;

    await exporter.dispose();

    expect(race.triggered).toBe(true);
    expect(await readFile(prepared.path, "utf8")).toBe("same-path replacement");
  });
});
