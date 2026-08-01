import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_ENTRY_NAMES,
  DIAGNOSTIC_OMISSIONS,
  createDiagnosticEntries,
} from "../../src/diagnostics/diagnosticManifest.js";
import {
  DIAGNOSTIC_PREVIEW_TTL_MS,
  DiagnosticExporter,
} from "../../src/diagnostics/diagnosticExporter.js";

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-diagnostics-"));
  const logs = join(dataRoot, "logs");
  await mkdir(logs, { recursive: true });
  await writeFile(
    join(logs, "companion.log"),
    [
      JSON.stringify({
        event: "connection_failed",
        owner: "PrivateOwner",
        path: String.raw`%USERPROFILE%\saves\World`,
        ip: "127.0.0.1",
        token: "Bearer private-access-token",
        email: "owner@example.invalid",
        rawChat: "complete private chat",
      }),
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(logs, "audit.jsonl"),
    `${JSON.stringify({ kind: "connection", detail: { code: "CONNECTED" } })}\n`,
    "utf8",
  );
  await writeFile(join(logs, "unexpected-private-file.txt"), "must never ship", "utf8");
  await mkdir(join(dataRoot, "saves"), { recursive: true });
  await writeFile(join(dataRoot, "saves", "level.dat"), "minecraft save", "utf8");
  await mkdir(join(dataRoot, "auth"), { recursive: true });
  await writeFile(join(dataRoot, "auth", "auth.json"), "codex auth", "utf8");
  await mkdir(join(dataRoot, "PCL2"), { recursive: true });
  await writeFile(join(dataRoot, "PCL2", "accounts.json"), "pcl2 account", "utf8");
  await mkdir(join(dataRoot, "config", "profiles"), { recursive: true });
  await writeFile(join(dataRoot, "config", "profiles", "profile.json"), "complete profile", "utf8");
  await mkdir(join(dataRoot, "data"), { recursive: true });
  await writeFile(join(dataRoot, "data", "memories.json"), "complete memory", "utf8");
  return dataRoot;
}

function createExporter(
  dataRoot: string,
  now: () => number,
  createExportId = () => "preview_1234567890",
) {
  return new DiagnosticExporter({
    dataRoot,
    now,
    createExportId,
    appVersion: "0.1.1",
    osSummary: { platform: "win32", release: "test-release", arch: "x64" },
    dependencyVersions: { node: "24.0.0", codex: "0.145.0", mineflayer: "4.37.1" },
    compatibilityManifest: { minecraftJava: ["1.21.5"], status: "beta" },
    configSchemaSummary: {
      sections: ["minecraft", "codex", "companion", "safety"],
      secretsIncluded: false,
    },
  });
}

describe("DiagnosticExporter", () => {
  it("exports only approved security fields from both log schemas and drops nested aliases", () => {
    const appLine = JSON.stringify({
      at: "2026-07-29T00:00:00.000Z",
      level: "error",
      event: "task_audit_write_failed",
      code: "AUDIT_UNAVAILABLE",
      reason: "fail_closed",
      status: "blocked",
      counter: 2,
      startedAt: "2026-07-29T00:00:00.000Z",
      expectedActionCategoryCount: 2,
      limits: {
        maxToolCalls: 20,
        maxBlockChanges: 64,
        maxHorizontalTravel: 7.5,
        maxDurationMs: 60_000,
        maxDangerousOperations: 1,
        memorySnapshot: "private nested limit alias",
      },
      counters: {
        toolCalls: 2,
        blockChanges: 3,
        horizontalTravel: 0.5,
        dangerousOperations: 0,
        utterance: "private nested counter alias",
      },
      memorySnapshot: { records: [{ summary: "private snapshot memory" }] },
      authState: { session: "private auth state" },
      context: {
        pcl2: { displayName: "private nested pcl2 identity" },
        utterance: "private nested utterance",
      },
    });
    const auditLine = JSON.stringify({
      schemaVersion: 1,
      timestamp: "2026-07-29T00:00:00.000Z",
      kind: "action_denied",
      worldIdHash: "a".repeat(64),
      taskId: "task_public_123",
      detail: {
        action: "dig",
        category: "block_change",
        reason: "policy",
        code: "DENIED",
        memorySnapshot: { summary: "private nested audit memory" },
        authState: { session: "private nested audit auth" },
        pcl2: { displayName: "private nested audit pcl2" },
        utterance: "private nested audit utterance",
      },
      profileData: { persona: "private top-level profile" },
    });
    const entries = createDiagnosticEntries({
      appVersion: "0.1.1",
      osSummary: {},
      dependencyVersions: {},
      compatibilityManifest: {},
      configSchemaSummary: {},
      appLog: `${appLine}\n`,
      auditLog: `${auditLine}\n`,
    });

    const appOutput = JSON.parse(
      entries.find((entry) => entry.logicalName === "app-log.jsonl")!.content.toString("utf8"),
    );
    expect(appOutput).toEqual({
      at: "2026-07-29T00:00:00.000Z",
      level: "error",
      event: "task_audit_write_failed",
      code: "AUDIT_UNAVAILABLE",
      reason: "fail_closed",
      status: "blocked",
      counter: 2,
      startedAt: "2026-07-29T00:00:00.000Z",
      expectedActionCategoryCount: 2,
      limits: {
        maxToolCalls: 20,
        maxBlockChanges: 64,
        maxHorizontalTravel: 7.5,
        maxDurationMs: 60_000,
        maxDangerousOperations: 1,
      },
      counters: {
        toolCalls: 2,
        blockChanges: 3,
        horizontalTravel: 0.5,
        dangerousOperations: 0,
      },
    });

    const auditOutput = JSON.parse(
      entries.find((entry) => entry.logicalName === "audit-log.jsonl")!.content.toString("utf8"),
    );
    expect(auditOutput).toEqual({
      schemaVersion: 1,
      timestamp: "2026-07-29T00:00:00.000Z",
      kind: "action_denied",
      worldIdHash: "a".repeat(64),
      taskId: "task_public_123",
      detail: {
        action: "dig",
        category: "block_change",
        reason: "policy",
        code: "DENIED",
      },
    });
  });

  it("previews only the fixed whitelist with redaction counts and explicit omissions", async () => {
    const dataRoot = await fixture();
    const exporter = createExporter(dataRoot, () => 1_000);

    const preview = await exporter.preview();

    expect(DIAGNOSTIC_PREVIEW_TTL_MS).toBe(10 * 60 * 1_000);
    expect(preview.exportId).toBe("preview_1234567890");
    expect(preview.files.map((file) => file.logicalName)).toEqual(DIAGNOSTIC_ENTRY_NAMES);
    expect(preview.omitted).toEqual(DIAGNOSTIC_OMISSIONS);
    expect(
      preview.files.find((file) => file.logicalName === "app-log.jsonl")?.redactions,
    ).toBeGreaterThan(0);
    expect(
      preview.files.every((file) => file.size >= 0 && file.logicalName.includes("/") === false),
    ).toBe(true);
  });

  it("requires the one active unexpired preview ID and bounds replacement lifecycle", async () => {
    const dataRoot = await fixture();
    let now = 1_000;
    let sequence = 0;
    const exporter = createExporter(
      dataRoot,
      () => now,
      () => `preview_${++sequence}234567890`,
    );
    const first = await exporter.preview();
    const second = await exporter.preview();

    await expect(exporter.createArchive(first.exportId)).rejects.toThrow(
      "diagnostic preview is unavailable",
    );
    now += DIAGNOSTIC_PREVIEW_TTL_MS + 1;
    await expect(exporter.createArchive(second.exportId)).rejects.toThrow(
      "diagnostic preview expired",
    );
    expect(await exporter.retainedArtifactCount()).toBe(0);
  });

  it("creates a ZIP with exact logical names and no excluded paths or contents", async () => {
    const dataRoot = await fixture();
    const exporter = createExporter(dataRoot, () => 1_000);
    const preview = await exporter.preview();

    const archive = await exporter.createArchive(preview.exportId);
    const zip = await readFile(archive.path);
    const entries = listZipEntryNames(zip);
    const printable = zip.toString("latin1");

    expect(entries).toEqual(DIAGNOSTIC_ENTRY_NAMES);
    expect(archive.exportId).toBe(preview.exportId);
    expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(createHash("sha256").update(zip).digest("hex")).toBe(archive.sha256);
    expect(archive.path).toBe(join(dataRoot, "diagnostics", `${preview.exportId}.zip`));
    expect(
      entries.every(
        (name) => !name.includes("\\") && !name.startsWith("/") && !/^[A-Za-z]:/u.test(name),
      ),
    ).toBe(true);
    for (const forbidden of [
      "unexpected-private-file",
      "level.dat",
      "auth.json",
      "accounts.json",
      "profile.json",
      "memories.json",
      "PrivateOwner",
      "private-access-token",
      "owner@example.invalid",
      "complete private chat",
    ]) {
      expect(printable).not.toContain(forbidden);
    }
  });

  it("never follows a symlink at a whitelisted log path", async () => {
    const dataRoot = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "whitelily-outside-"));
    await writeFile(join(outside, "private.log"), "outside private data", "utf8");
    await rm(join(dataRoot, "logs", "companion.log"));
    await symlink(outside, join(dataRoot, "logs", "companion.log"), "junction");
    const exporter = new DiagnosticExporter({
      dataRoot,
      now: () => 1_000,
      createExportId: () => "preview_1234567890",
      appVersion: "0.1.1",
      osSummary: { platform: "win32", release: "test", arch: "x64" },
      dependencyVersions: {},
      compatibilityManifest: {},
      configSchemaSummary: {},
    });

    const preview = await exporter.preview();
    const log = preview.files.find((file) => file.logicalName === "app-log.jsonl");
    expect(log).toMatchObject({ size: 0, redactions: 0 });
    const archive = await exporter.createArchive(preview.exportId);
    expect((await readFile(archive.path)).toString("latin1")).not.toContain("outside private data");
  });

  it("ignores caller-selected log filenames outside the fixed source whitelist", async () => {
    const dataRoot = await fixture();
    await writeFile(join(dataRoot, "logs", "companion.log"), "", "utf8");
    await writeFile(join(dataRoot, "logs", "arbitrary.log"), "arbitrary diagnostic source", "utf8");
    const options = {
      dataRoot,
      now: () => 1_000,
      createExportId: () => "preview_1234567890",
      appVersion: "0.1.1",
      osSummary: { platform: "win32", release: "test", arch: "x64" },
      dependencyVersions: {},
      compatibilityManifest: {},
      configSchemaSummary: {},
      appLogFileName: "arbitrary.log",
    };
    const exporter = new DiagnosticExporter(options);

    const preview = await exporter.preview();
    const archive = await exporter.createArchive(preview.exportId);

    expect(preview.files.find((file) => file.logicalName === "app-log.jsonl")?.size).toBe(0);
    expect((await readFile(archive.path)).toString("latin1")).not.toContain(
      "arbitrary diagnostic source",
    );
  });

  it("never follows a reparse point that replaces the known logs directory", async () => {
    const dataRoot = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "whitelily-outside-logs-"));
    await writeFile(join(outside, "companion.log"), "outside parent private data", "utf8");
    await writeFile(join(outside, "audit.jsonl"), "outside parent audit data", "utf8");
    await rm(join(dataRoot, "logs"), { recursive: true });
    await symlink(outside, join(dataRoot, "logs"), "junction");
    const exporter = createExporter(dataRoot, () => 1_000);

    const preview = await exporter.preview();
    expect(preview.files.find((file) => file.logicalName === "app-log.jsonl")).toMatchObject({
      size: 0,
      redactions: 0,
    });
    const archive = await exporter.createArchive(preview.exportId);
    const printable = (await readFile(archive.path)).toString("latin1");
    expect(printable).not.toContain("outside parent private data");
    expect(printable).not.toContain("outside parent audit data");
  });

  it("refuses to create a prepared archive through a reparse diagnostics directory", async () => {
    const dataRoot = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "whitelily-outside-diagnostics-"));
    await symlink(outside, join(dataRoot, "diagnostics"), "junction");
    const exporter = createExporter(dataRoot, () => 1_000);
    const preview = await exporter.preview();

    await expect(exporter.createArchive(preview.exportId)).rejects.toThrow(
      "diagnostic directory is not trusted",
    );
    await expect(readFile(join(outside, `${preview.exportId}.zip`))).rejects.toThrow();
  });

  it("does not release a retained archive path through a replaced diagnostics directory", async () => {
    const dataRoot = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "whitelily-outside-release-"));
    const exporter = createExporter(dataRoot, () => 1_000);
    const first = await exporter.preview();
    await exporter.createArchive(first.exportId);
    await rm(join(dataRoot, "diagnostics"), { recursive: true });
    const outsideArchive = join(outside, `${first.exportId}.zip`);
    await writeFile(outsideArchive, "outside archive", "utf8");
    await symlink(outside, join(dataRoot, "diagnostics"), "junction");

    await exporter.preview();

    expect(await readFile(outsideArchive, "utf8")).toBe("outside archive");
  });

  it("does not delete a same-path regular replacement when releasing a prepared archive", async () => {
    const dataRoot = await fixture();
    const exporter = createExporter(dataRoot, () => 1_000);
    const preview = await exporter.preview();
    const prepared = await exporter.createArchive(preview.exportId);
    await rm(prepared.path);
    await writeFile(prepared.path, "same-path replacement", "utf8");

    await exporter.preview();

    expect(await readFile(prepared.path, "utf8")).toBe("same-path replacement");
    expect(await exporter.retainedArtifactCount()).toBe(0);
  });

  it("idempotently disposes active previews and prepared archives", async () => {
    const dataRoot = await fixture();
    const exporter = createExporter(dataRoot, () => 1_000);
    const active = await exporter.preview();

    await (exporter as unknown as { dispose(): Promise<void> }).dispose();
    await (exporter as unknown as { dispose(): Promise<void> }).dispose();
    await expect(exporter.createArchive(active.exportId)).rejects.toThrow(
      "diagnostic preview is unavailable",
    );

    const next = await exporter.preview();
    const prepared = await exporter.createArchive(next.exportId);
    await (exporter as unknown as { dispose(): Promise<void> }).dispose();
    await (exporter as unknown as { dispose(): Promise<void> }).dispose();

    await expect(readFile(prepared.path)).rejects.toThrow();
    expect(await exporter.retainedArtifactCount()).toBe(0);
  });

  it("aborts at the streaming ZIP ceiling, removes its own partial file, and remains retryable", async () => {
    const dataRoot = await fixture();
    const exporter = new DiagnosticExporter({
      dataRoot,
      now: () => 1_000,
      createExportId: () => "preview_oversize_1234",
      appVersion: "0.1.1",
      osSummary: { publicCode: randomBytes(5 * 1024 * 1024).toString("hex") },
      dependencyVersions: {},
      compatibilityManifest: {},
      configSchemaSummary: {},
    });
    const preview = await exporter.preview();
    const path = join(dataRoot, "diagnostics", `${preview.exportId}.zip`);

    await expect(exporter.createArchive(preview.exportId)).rejects.toThrow(
      "diagnostic archive exceeds maximum size",
    );
    await expect(access(path)).rejects.toThrow();
    await expect(exporter.createArchive(preview.exportId)).rejects.toThrow(
      "diagnostic archive exceeds maximum size",
    );
    await expect(access(path)).rejects.toThrow();
  }, 30_000);
});

function listZipEntryNames(zip: Buffer): string[] {
  const names: string[] = [];
  for (let offset = 0; offset <= zip.length - 46; offset += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return names;
}
