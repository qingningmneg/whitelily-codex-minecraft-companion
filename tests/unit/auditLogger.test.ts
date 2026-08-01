import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIT_MAX_BYTES,
  AUDIT_RETAINED_FILES,
  AuditLogger,
  type AuditEvent,
} from "../../src/logging/auditLogger.js";

async function auditPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "whitelily-audit-")), "audit.jsonl");
}

function event(index: number, detail: AuditEvent["detail"] = {}): AuditEvent {
  return {
    schemaVersion: 1,
    timestamp: new Date(Date.UTC(2026, 6, 29, 0, 0, index)).toISOString(),
    kind: "settings_changed",
    detail: { counter: index, ...detail },
  };
}

describe("AuditLogger", () => {
  it.each([
    ["unknown top-level property", { ...event(0), unexpectedTopLevel: "retained-extra" }],
    ["noncanonical timestamp", { ...event(0), timestamp: "2026-07-29 00:00:00Z" }],
    ["invalid world hash", { ...event(0), worldIdHash: "not-a-sha256" }],
    ["invalid task ID", { ...event(0), taskId: String.raw`..\private` }],
    ["non-string task ID", { ...event(0), taskId: 123 }],
    [
      "nested detail object",
      { ...event(0), detail: { memory: { summary: "private retained memory" } } },
    ],
    ["detail array", { ...event(0), detail: { message: ["private raw chat"] } }],
    ["oversized detail string", { ...event(0), detail: { code: "x".repeat(257) } }],
    ["kind-disallowed detail key", { ...event(0), detail: { memory: "private retained memory" } }],
  ])("rejects an AuditEvent with %s", async (_case, candidate) => {
    const path = await auditPath();
    const logger = new AuditLogger(path);

    await expect(logger.append(candidate as AuditEvent)).rejects.toThrow("audit append failed");
    await expect(access(path)).rejects.toThrow();
  });

  it("accepts finite nonnegative fractional travel while retaining exact values", async () => {
    const path = await auditPath();
    const logger = new AuditLogger(path);

    await logger.append({
      ...event(0),
      kind: "task_stopped",
      detail: {
        horizontalTravel: 0.5,
        maxHorizontalTravel: 7.5,
        toolCalls: 2,
        reason: "completed",
      },
    });

    expect(JSON.parse((await readFile(path, "utf8")).trim()).detail).toEqual({
      horizontalTravel: 0.5,
      maxHorizontalTravel: 7.5,
      toolCalls: 2,
      reason: "completed",
    });
  });

  it.each([
    ["negative horizontal travel", { horizontalTravel: -0.1 }],
    ["NaN horizontal travel", { horizontalTravel: Number.NaN }],
    ["infinite horizontal travel", { horizontalTravel: Number.POSITIVE_INFINITY }],
    ["negative maximum travel", { maxHorizontalTravel: -0.1 }],
    ["NaN maximum travel", { maxHorizontalTravel: Number.NaN }],
    ["infinite maximum travel", { maxHorizontalTravel: Number.POSITIVE_INFINITY }],
    ["fractional discrete counter", { toolCalls: 1.5 }],
  ])("rejects task audit detail with %s", async (_case, detail) => {
    const path = await auditPath();
    const logger = new AuditLogger(path);

    await expect(
      logger.append({
        ...event(0),
        kind: "task_stopped",
        detail,
      }),
    ).rejects.toThrow("audit append failed");
    await expect(access(path)).rejects.toThrow();
  });

  it("serializes concurrent appends as one valid redacted JSON object per line", async () => {
    const path = await auditPath();
    const logger = new AuditLogger(path);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        logger.append({
          ...event(index, {
            ownerUsername: "PrivateOwner",
            path: String.raw`%USERPROFILE%\AppData\Roaming\WhiteLily\auth.json`,
            address: "192.168.1.44",
            authUrl: "https://auth.openai.com/callback?code=private-code&state=private-state",
            accessToken: "Bearer private-access-token",
            email: "owner@example.invalid",
            rawChat: "the complete player conversation",
            memorySummary: "the complete private memory",
            code: "SETTINGS_UPDATED",
          }),
          kind: "connection",
        }),
      ),
    );

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(20);
    expect(lines.map((line) => JSON.parse(line))).toHaveLength(20);
    const output = lines.join("\n");
    for (const secret of [
      "PrivateOwner",
      "auth.json",
      "192.168.1.44",
      "private-code",
      "private-state",
      "private-access-token",
      "owner@example.invalid",
      "the complete player conversation",
      "the complete private memory",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("SETTINGS_UPDATED");
  });

  it("rotates before 10 MiB and retains exactly five audit files including the active file", async () => {
    expect(AUDIT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(AUDIT_RETAINED_FILES).toBe(5);
    const path = await auditPath();
    const logger = new AuditLogger(path, { maxBytes: 220, retainedFiles: 5 });

    for (let index = 0; index < 12; index += 1) {
      await logger.append(event(index, { code: "x".repeat(80) }));
    }

    const names = (await readdir(join(path, ".."))).sort();
    expect(names).toEqual([
      "audit.jsonl",
      "audit.jsonl.1",
      "audit.jsonl.2",
      "audit.jsonl.3",
      "audit.jsonl.4",
    ]);
    for (const name of names) {
      const lines = (await readFile(join(path, "..", name), "utf8")).trim().split("\n");
      expect(lines.every((line) => JSON.parse(line))).toBe(true);
    }
  });

  it("prunes dirty numeric suffixes beyond the five-file managed set during rotation", async () => {
    const path = await auditPath();
    await writeFile(path, "x".repeat(220), "utf8");
    for (let suffix = 1; suffix <= 7; suffix += 1) {
      await writeFile(
        `${path}.${suffix}`,
        suffix < 4 ? `retained-${suffix}` : `private-discarded-${suffix}`,
        "utf8",
      );
    }
    await writeFile(`${path}.0005`, "private-noncanonical-stale", "utf8");
    await writeFile(`${path}.999999999999999999999999`, "private-oversized-stale", "utf8");
    const logger = new AuditLogger(path, { maxBytes: 220, retainedFiles: 5 });

    await logger.append(event(0, { code: "ROTATE" }));
    const firstNames = (await readdir(join(path, ".."))).sort();
    const tombstones = firstNames.filter((name) => name.includes(".tombstone."));
    expect(tombstones.length).toBeGreaterThan(0);
    expect(tombstones.length).toBeLessThanOrEqual(16);
    await writeFile(join(path, "..", tombstones[0]!), "private-restart-tombstone-residue", "utf8");
    const restarted = new AuditLogger(path, { maxBytes: 220, retainedFiles: 5 });
    await restarted.append(event(1, { code: "ROTATE_AGAIN" }));

    const names = (await readdir(join(path, ".."))).sort();
    const managed = names.filter((name) => /^audit\.jsonl(?:\.[1-4])?$/u.test(name));
    expect(managed).toEqual([
      "audit.jsonl",
      "audit.jsonl.1",
      "audit.jsonl.2",
      "audit.jsonl.3",
      "audit.jsonl.4",
    ]);
    expect(names).toHaveLength(firstNames.length);
    expect(names.length).toBeLessThanOrEqual(21);
    for (const name of names) {
      const filePath = join(path, "..", name);
      const content = await readFile(filePath, "utf8");
      expect(content).not.toContain("private-");
      if (!managed.includes(name)) expect((await stat(filePath)).size).toBe(0);
    }
  });

  it("rejects an individual event that cannot fit without creating an oversized audit file", async () => {
    const path = await auditPath();
    const logger = new AuditLogger(path, { maxBytes: 256 });

    await expect(logger.append(event(0, { code: "x".repeat(200) }))).rejects.toThrow(
      "audit append failed",
    );
    await expect(access(path)).rejects.toThrow();
    expect(logger.health()).toBe("failed");
  });

  it("tracks failed writes and recovers only after a successful health probe", async () => {
    const path = await auditPath();
    const logger = new AuditLogger(path, {
      appendLine: async () => {
        throw new Error("disk unavailable");
      },
    });

    await expect(logger.append(event(0))).rejects.toThrow("audit append failed");
    expect(logger.health()).toBe("failed");
    await expect(logger.probeHealth()).resolves.toBe(false);
    expect(logger.health()).toBe("failed");
  });

  it("refuses to append through a reparse-pointed audit directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-audit-root-"));
    const outside = await mkdtemp(join(tmpdir(), "whitelily-audit-outside-"));
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "audit.jsonl"), "outside audit\n", "utf8");
    await symlink(outside, join(root, "logs"), "junction");
    const logger = new AuditLogger(join(root, "logs", "audit.jsonl"));

    await expect(logger.append(event(0))).rejects.toThrow("audit append failed");
    expect(await readFile(join(outside, "audit.jsonl"), "utf8")).toBe("outside audit\n");
  });
});
