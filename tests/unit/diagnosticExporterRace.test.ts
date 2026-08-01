import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  enabled: false,
  swapped: false,
  dataRoot: "",
  outside: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      if (
        race.enabled &&
        !race.swapped &&
        String(path) === join(race.dataRoot, "logs", "companion.log")
      ) {
        race.swapped = true;
        await actual.rm(join(race.dataRoot, "logs"), { recursive: true });
        await actual.symlink(race.outside, join(race.dataRoot, "logs"), "junction");
      }
      return actual.lstat(path);
    },
  };
});

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { DiagnosticExporter } from "../../src/diagnostics/diagnosticExporter.js";

const cleanup: string[] = [];

afterEach(async () => {
  race.enabled = false;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DiagnosticExporter parent identity", () => {
  it("returns no log bytes when the verified logs directory is replaced before file open", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-diagnostic-race-"));
    const outside = await mkdtemp(join(tmpdir(), "whitelily-diagnostic-race-outside-"));
    cleanup.push(dataRoot, outside);
    await mkdir(join(dataRoot, "logs"), { recursive: true });
    await writeFile(join(dataRoot, "logs", "companion.log"), "", "utf8");
    await writeFile(join(dataRoot, "logs", "audit.jsonl"), "", "utf8");
    await writeFile(join(outside, "companion.log"), "outside private log bytes", "utf8");
    await writeFile(join(outside, "audit.jsonl"), "outside private audit bytes", "utf8");
    race.dataRoot = dataRoot;
    race.outside = outside;
    race.swapped = false;
    race.enabled = true;
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

    expect(race.swapped).toBe(true);
    expect(preview.files.find((file) => file.logicalName === "app-log.jsonl")).toMatchObject({
      size: 0,
      redactions: 0,
    });
    expect(preview.files.find((file) => file.logicalName === "audit-log.jsonl")).toMatchObject({
      size: 0,
      redactions: 0,
    });
  });
});
