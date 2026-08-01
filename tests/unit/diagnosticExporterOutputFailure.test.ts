import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("archiver", async () => {
  const { PassThrough } = await import("node:stream");
  class FailingZipArchive extends PassThrough {
    append(): void {
      this.write(Buffer.from("partial diagnostic ZIP bytes"));
    }

    finalize(): Promise<void> {
      queueMicrotask(() => this.destroy(new Error("injected archive output failure")));
      return Promise.resolve();
    }

    abort(): void {
      this.destroy();
    }
  }
  return { ZipArchive: FailingZipArchive };
});

import { DiagnosticExporter } from "../../src/diagnostics/diagnosticExporter.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DiagnosticExporter output failure cleanup", () => {
  it("identity-safely removes an injected partial output and allows retry", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-output-failure-"));
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
      createExportId: () => "preview_failure_1234",
    });
    const preview = await exporter.preview();
    const path = join(dataRoot, "diagnostics", `${preview.exportId}.zip`);

    await expect(exporter.createArchive(preview.exportId)).rejects.toThrow(
      "injected archive output failure",
    );
    await expect(access(path)).rejects.toThrow();
    await expect(exporter.createArchive(preview.exportId)).rejects.toThrow(
      "injected archive output failure",
    );
    await expect(access(path)).rejects.toThrow();
  });
});
