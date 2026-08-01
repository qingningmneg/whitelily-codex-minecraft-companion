import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  mode: "none" as
    "none" | "swap" | "fail" | "parent_swap" | "phase_two_fail" | "disposition_parent_swap",
  target: "",
  saved: "",
  parent: "",
  savedParent: "",
  outsideParent: "",
  triggered: false,
  failed: false,
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const injectSwap = async (path: string): Promise<void> => {
    if (race.mode !== "swap" || race.triggered || path !== race.target) return;
    race.triggered = true;
    await actual.rename(path, race.saved);
    await actual.writeFile(path, "same-path replacement", "utf8");
  };
  return {
    ...actual,
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ) => {
      await injectSwap(String(path));
      if (
        race.mode === "disposition_parent_swap" &&
        !race.triggered &&
        String(path) === race.target
      ) {
        race.triggered = true;
        await actual.rename(race.parent, race.savedParent);
        await actual.symlink(race.outsideParent, race.parent, "junction");
      }
      return actual.rm(path, options);
    },
    rename: async (from: string, to: string) => {
      await injectSwap(from);
      if (race.mode === "parent_swap" && !race.triggered && from === race.target) {
        race.triggered = true;
        await actual.rename(race.parent, race.savedParent);
        await actual.symlink(race.outsideParent, race.parent, "junction");
      }
      if (race.mode === "fail" && !race.failed && from.endsWith(".2")) {
        race.failed = true;
        throw Object.assign(new Error("injected rotation failure"), { code: "EIO" });
      }
      if (
        race.mode === "phase_two_fail" &&
        !race.failed &&
        from.includes(".rotate-") &&
        to === race.target
      ) {
        race.failed = true;
        throw Object.assign(new Error("injected phase-two failure"), { code: "EIO" });
      }
      return actual.rename(from, to);
    },
  };
});

import { AuditLogger, type AuditEvent } from "../../src/logging/auditLogger.js";

const cleanup: string[] = [];

afterEach(async () => {
  race.mode = "none";
  race.triggered = false;
  race.failed = false;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function rotationFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "whitelily-audit-race-"));
  cleanup.push(root);
  const logs = join(root, "logs");
  await mkdir(logs);
  const path = join(logs, "audit.jsonl");
  await writeFile(path, "x".repeat(220), "utf8");
  for (let suffix = 1; suffix <= 4; suffix += 1) {
    await writeFile(`${path}.${suffix}`, `original-${suffix}`, "utf8");
  }
  return path;
}

function event(counter: number): AuditEvent {
  return {
    schemaVersion: 1,
    timestamp: "2026-07-29T00:00:00.000Z",
    kind: "settings_changed",
    detail: { counter, code: "ROTATE" },
  };
}

describe("AuditLogger rotation identity and recovery", () => {
  it("does not delete or rotate a same-path replacement introduced at the destructive boundary", async () => {
    const path = await rotationFixture();
    race.mode = "swap";
    race.target = `${path}.4`;
    race.saved = `${path}.4-saved`;
    const logger = new AuditLogger(path, { maxBytes: 220, retainedFiles: 5 });

    await expect(logger.append(event(0))).rejects.toThrow("audit append failed");

    expect(race.triggered).toBe(true);
    expect(await readFile(`${path}.4`, "utf8")).toBe("same-path replacement");
  });

  it("rolls back a partial rotation failure so the next append can recover", async () => {
    const path = await rotationFixture();
    race.mode = "fail";
    const logger = new AuditLogger(path, { maxBytes: 220, retainedFiles: 5 });

    await expect(logger.append(event(0))).rejects.toThrow("audit append failed");
    expect(race.failed).toBe(true);
    race.mode = "none";
    await expect(logger.append(event(1))).resolves.toBeUndefined();

    expect((await readdir(join(path, ".."))).sort()).toEqual([
      "audit.jsonl",
      "audit.jsonl.1",
      "audit.jsonl.2",
      "audit.jsonl.3",
      "audit.jsonl.4",
    ]);
  });

  it("restores outside files when the audit parent is swapped at the rename boundary", async () => {
    const path = await rotationFixture();
    const outside = await mkdtemp(join(tmpdir(), "whitelily-audit-parent-swap-"));
    cleanup.push(outside);
    await writeFile(join(outside, "audit.jsonl"), "outside-active", "utf8");
    for (let suffix = 1; suffix <= 4; suffix += 1) {
      await writeFile(join(outside, `audit.jsonl.${suffix}`), `outside-${suffix}`, "utf8");
    }
    race.mode = "parent_swap";
    race.target = `${path}.4`;
    race.parent = join(path, "..");
    race.savedParent = join(race.parent, "..", "logs-saved");
    race.outsideParent = outside;
    const logger = new AuditLogger(path, { maxBytes: 220, retainedFiles: 5 });

    await expect(logger.append(event(0))).rejects.toThrow("audit append failed");

    expect(race.triggered).toBe(true);
    expect(await readFile(join(outside, "audit.jsonl.4"), "utf8")).toBe("outside-4");
    expect((await readdir(outside)).sort()).toEqual([
      "audit.jsonl",
      "audit.jsonl.1",
      "audit.jsonl.2",
      "audit.jsonl.3",
      "audit.jsonl.4",
    ]);
  });

  it("restores every retention generation after a phase-two move fails", async () => {
    const path = await rotationFixture();
    race.mode = "phase_two_fail";
    race.target = `${path}.3`;
    const logger = new AuditLogger(path, { maxBytes: 220, retainedFiles: 5 });

    await expect(logger.append(event(0))).rejects.toThrow("audit append failed");

    expect(race.failed).toBe(true);
    expect(await readFile(path, "utf8")).toBe("x".repeat(220));
    for (let suffix = 1; suffix <= 4; suffix += 1) {
      expect(await readFile(`${path}.${suffix}`, "utf8")).toBe(`original-${suffix}`);
    }
    expect((await readdir(join(path, ".."))).sort()).toEqual([
      "audit.jsonl",
      "audit.jsonl.1",
      "audit.jsonl.2",
      "audit.jsonl.3",
      "audit.jsonl.4",
    ]);
  });

  it("never deletes an outside same-name disposition file through a swapped parent", async () => {
    const path = await rotationFixture();
    const outside = await mkdtemp(join(tmpdir(), "whitelily-audit-rm-swap-"));
    cleanup.push(outside);
    const token = "00000000000040008000000000000000";
    const dispositionName = `audit.jsonl.rotate-${token}-0.delete-${token}`;
    const outsideDisposition = join(outside, dispositionName);
    await writeFile(outsideDisposition, "outside disposition file", "utf8");
    race.mode = "disposition_parent_swap";
    race.target = join(path, "..", dispositionName);
    race.parent = join(path, "..");
    race.savedParent = join(race.parent, "..", "logs-saved");
    race.outsideParent = outside;
    const logger = new AuditLogger(path, { maxBytes: 220, retainedFiles: 5 });

    const result = await logger.append(event(0)).then(
      () => "resolved",
      () => "rejected",
    );

    expect(await readFile(outsideDisposition, "utf8")).toBe("outside disposition file");
    expect(race.triggered).toBe(false);
    expect(result).toBe("resolved");
  });
});
