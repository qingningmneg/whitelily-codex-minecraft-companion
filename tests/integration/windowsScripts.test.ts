import type { ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearFixtureCleanupIdentityForTest,
  cleanupWindowsFixture,
  findFixtureCodexDelayPids,
  findFixtureServicePids,
  killFixtureProcess,
  processIsAlive,
  queryWindowsProcessIdentity,
  registerFixtureCleanupIdentityForTest,
  runWindowsScriptFixture,
  startOwnedFixtureProcess,
  waitForProcessExit,
} from "../support/windowsScriptHarness.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const privateEmail = ["private-user", "@", "example.net"].join("");

async function waitForPath(path: string, description: string, timeoutMilliseconds = 5_000) {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function waitForText(
  path: string,
  expected: string,
  description: string,
  timeoutMilliseconds = 5_000,
) {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")).includes(expected)) return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EBUSY" && code !== "EACCES" && code !== "EPERM") {
        throw error;
      }
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function observe<T>(
  operation: Promise<T>,
): Promise<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }> {
  try {
    return { status: "fulfilled", value: await operation };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

async function fixtureRoot(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "whitelily-windows-script-"));
  const root = await realpath(created);
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    killFixtureProcess(child);
    await waitForProcessExit(child, 2_000).catch(() => undefined);
  }
  await Promise.all(roots.splice(0).map(cleanupWindowsFixture));
}, 15_000);

describe("Windows scripts", { timeout: 30_000 }, () => {
  it("cleans a canonical fixture created through a temporary-directory alias", async () => {
    const canonicalTemporaryRoot = await realpath(tmpdir());
    const alias = await mkdtemp(join(dirname(canonicalTemporaryRoot), "whitelily-temp-alias-"));
    await rm(alias, { recursive: true });
    await symlink(canonicalTemporaryRoot, alias, "junction");
    const originalTemp = process.env.TEMP;
    const originalTmp = process.env.TMP;
    try {
      process.env.TEMP = alias;
      process.env.TMP = alias;
      expect(resolve(tmpdir())).toBe(resolve(alias));
      const root = await fixtureRoot();

      await cleanupWindowsFixture(root);

      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (originalTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = originalTemp;
      if (originalTmp === undefined) delete process.env.TMP;
      else process.env.TMP = originalTmp;
      await rm(alias, { force: true });
    }
  });

  it("keeps setup check-only mode non-mutating", async () => {
    const root = await fixtureRoot();
    const result = await runWindowsScriptFixture(root, "setup.ps1", ["-CheckOnly"]);

    expect(result.exitCode).toBe(0);
    expect(result.createdPaths).toEqual([]);
    expect(result.modifiedPaths).toEqual([]);
    expect(result.deletedPaths).toEqual([]);
    expect(result.invocations).toEqual([]);
    expect(result.stdout).toContain("ChatGPT");
    expect(result.stdout).toContain("codex login");
  });

  it("installs and builds while preserving an existing personal config", async () => {
    const root = await fixtureRoot();
    const personal = '[minecraft]\nowner_username = "PrivateOwner"\n';
    const result = await runWindowsScriptFixture(root, "setup.ps1", [], {
      existingConfig: personal,
    });

    expect(result.exitCode).toBe(0);
    expect(result.invocations).toEqual(["npm ci", "npm run build"]);
    await expect(readFile(join(root, "config.toml"), "utf8")).resolves.toBe(personal);
    expect(result.createdPaths).not.toContain("config.toml");
    expect(result.modifiedPaths).not.toContain("config.toml");
    expect(result.deletedPaths).not.toContain("config.toml");
  });

  it("creates a missing config without weakening prerequisite checks", async () => {
    const root = await fixtureRoot();
    const result = await runWindowsScriptFixture(root, "setup.ps1", []);

    expect(result.exitCode).toBe(0);
    expect(result.createdPaths).toContain("config.toml");
    await expect(readFile(join(root, "config.toml"), "utf8")).resolves.toContain(
      'owner_username = "YourMcName"',
    );
  });

  it("fails check-only for an unsupported Node version without mutation", async () => {
    const root = await fixtureRoot();
    const result = await runWindowsScriptFixture(root, "setup.ps1", ["-CheckOnly"], {
      nodeVersion: "v23.9.0",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.createdPaths).toEqual([]);
    expect(result.modifiedPaths).toEqual([]);
    expect(result.deletedPaths).toEqual([]);
    expect(result.stdout + result.stderr).toContain("Node.js 24");
    expect(result.invocations).toEqual([]);
  });

  it("fails check-only for unsupported Windows, old npm, and a missing Codex CLI", async () => {
    const windowsRoot = await fixtureRoot();
    const windows = await runWindowsScriptFixture(windowsRoot, "setup.ps1", ["-CheckOnly"], {
      windowsBuild: 19_045,
    });
    expect(windows.exitCode).not.toBe(0);
    expect(windows.stdout + windows.stderr).toContain("Windows 11");
    expect(windows.createdPaths).toEqual([]);
    expect(windows.modifiedPaths).toEqual([]);
    expect(windows.deletedPaths).toEqual([]);

    const npmRoot = await fixtureRoot();
    const npm = await runWindowsScriptFixture(npmRoot, "setup.ps1", ["-CheckOnly"], {
      npmVersion: "10.9.0",
    });
    expect(npm.exitCode).not.toBe(0);
    expect(npm.stdout + npm.stderr).toContain("npm 11");

    const codexRoot = await fixtureRoot();
    const codex = await runWindowsScriptFixture(codexRoot, "setup.ps1", ["-CheckOnly"], {
      codexAvailable: false,
    });
    expect(codex.exitCode).not.toBe(0);
    expect(codex.stdout + codex.stderr).toContain("codex was not found");
  });

  it("reports a failing Codex ChatGPT login without echoing its raw output", async () => {
    const root = await fixtureRoot();
    const result = await runWindowsScriptFixture(root, "doctor.ps1", [], {
      existingConfig: '[minecraft]\nowner_username = "FixtureOwner"\n',
      codexExitCode: 1,
      codexStatus: "private-user@example.net sk-test-should-not-appear",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Codex login");
    expect(result.stdout + result.stderr).not.toContain("private-user@example.net");
    expect(result.stdout + result.stderr).not.toContain("sk-test-should-not-appear");
  });

  it("refuses to stop an unrelated PID", async () => {
    const root = await fixtureRoot();
    const result = await runWindowsScriptFixture(root, "stop.ps1", [], {
      pidFile: String(process.pid),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("does not belong to WhiteLily");
    expect(result.createdPaths).not.toContain("data/stop.request");
    await expect(readFile(join(root, "data", "whitelily.pid"), "utf8")).resolves.toBe(
      String(process.pid),
    );
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it("rejects malformed PID data and removes only an actually stale PID record", async () => {
    const malformedRoot = await fixtureRoot();
    const malformed = await runWindowsScriptFixture(malformedRoot, "stop.ps1", [], {
      pidFile: "123x",
    });
    expect(malformed.exitCode).not.toBe(0);
    await expect(readFile(join(malformedRoot, "data", "whitelily.pid"), "utf8")).resolves.toBe(
      "123x",
    );

    const staleRoot = await fixtureRoot();
    const stale = await runWindowsScriptFixture(staleRoot, "stop.ps1", [], {
      pidFile: "2147483646",
    });
    expect(stale.exitCode).toBe(0);
    expect(stale.stdout).toContain("stale");
    await expect(access(join(staleRoot, "data", "whitelily.pid"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(stale.createdPaths).not.toContain("data/stop.request");
  });

  it("requests graceful shutdown only for an owned process", async () => {
    const root = await fixtureRoot();
    const owned = await startOwnedFixtureProcess(root, "graceful");
    children.push(owned);
    const result = await runWindowsScriptFixture(root, "stop.ps1", [], {
      pidFile: String(owned.pid),
    });

    expect(result.exitCode).toBe(0);
    await waitForProcessExit(owned);
    expect(result.stdout).toContain("graceful");
    expect(result.createdPaths).not.toContain("data/stop.request");
    await expect(readFile(join(root, "data", "whitelily.pid"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a replacement PID file after the original service exits gracefully", async () => {
    const root = await fixtureRoot();
    const owned = await startOwnedFixtureProcess(root, "graceful-replace-pid", process.pid);
    children.push(owned);
    const result = await runWindowsScriptFixture(root, "stop.ps1", [], {
      pidFile: String(owned.pid),
    });

    expect(result.exitCode).toBe(0);
    await waitForProcessExit(owned);
    await expect(readFile(join(root, "data", "whitelily.pid"), "utf8")).resolves.toBe(
      String(process.pid),
    );
    expect(processIsAlive(process.pid)).toBe(true);
  });

  it("uses forced fallback only after re-verifying a stubborn owned process", async () => {
    const root = await fixtureRoot();
    const owned = await startOwnedFixtureProcess(root, "stubborn");
    children.push(owned);
    const result = await runWindowsScriptFixture(
      root,
      "stop.ps1",
      ["-GracefulTimeoutSeconds", "1"],
      { pidFile: String(owned.pid) },
    );

    expect(result.exitCode).toBe(0);
    await waitForProcessExit(owned);
    expect(result.stdout + result.stderr).toContain("forced fallback");
    expect(processIsAlive(owned.pid!)).toBe(false);
  }, 15_000);

  it("refuses forced fallback when the PID record changes while waiting", async () => {
    const root = await fixtureRoot();
    const owned = await startOwnedFixtureProcess(root, "stubborn");
    children.push(owned);
    const stopping = runWindowsScriptFixture(root, "stop.ps1", ["-GracefulTimeoutSeconds", "2"], {
      pidFile: String(owned.pid),
    });
    const marker = join(root, "data", "stop.request");
    for (let index = 0; index < 100; index += 1) {
      try {
        await access(marker);
        break;
      } catch {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
      }
    }
    await writeFile(join(root, "data", "whitelily.pid"), String(process.pid), "utf8");
    const result = await stopping;

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("PID changed");
    expect(processIsAlive(process.pid)).toBe(true);
    expect(processIsAlive(owned.pid!)).toBe(true);
  }, 15_000);

  it("refuses forced fallback when the original process identity no longer matches", async () => {
    const root = await fixtureRoot();
    const owned = await startOwnedFixtureProcess(root, "stubborn");
    children.push(owned);
    const originalPid = String(owned.pid);
    const result = await runWindowsScriptFixture(
      root,
      "stop.ps1",
      ["-GracefulTimeoutSeconds", "1"],
      {
        pidFile: originalPid,
        dropOwnershipAfterMarker: true,
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("original WhiteLily process");
    await expect(readFile(join(root, "data", "whitelily.pid"), "utf8")).resolves.toBe(originalPid);
    expect(processIsAlive(owned.pid!)).toBe(true);
  }, 15_000);

  it("starts one hidden service and rejects a duplicate before stopping it safely", async () => {
    const root = await fixtureRoot();
    const config = '[minecraft]\nowner_username = "FixtureOwner"\n';
    const started = await runWindowsScriptFixture(root, "start.ps1", [], {
      existingConfig: config,
    });

    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain("stop.ps1");
    expect(started.stdout).toContain("!status");
    const pidText = await readFile(join(root, "data", "whitelily.pid"), "utf8");
    expect(pidText).toMatch(/^[1-9]\d*\r?\n?$/);
    const pid = Number(pidText.trim());
    expect(processIsAlive(pid)).toBe(true);

    const duplicate = await runWindowsScriptFixture(root, "start.ps1", [], {
      existingConfig: config,
      pidFile: pidText,
    });
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stdout + duplicate.stderr).toContain("already running");
    expect(Number((await readFile(join(root, "data", "whitelily.pid"), "utf8")).trim())).toBe(pid);

    const stopped = await runWindowsScriptFixture(
      root,
      "stop.ps1",
      ["-GracefulTimeoutSeconds", "3"],
      { pidFile: pidText },
    );
    expect(stopped.exitCode).toBe(0);
    expect(processIsAlive(pid)).toBe(false);
  }, 20_000);

  it("removes only a stale stop request before starting a fresh service", async () => {
    const root = await fixtureRoot();
    const config = '[minecraft]\nowner_username = "FixtureOwner"\n';
    const started = await runWindowsScriptFixture(root, "start.ps1", [], {
      existingConfig: config,
      staleStopRequest: "stale-marker",
      unrelatedDataFile: "preserve-me",
    });

    expect(started.exitCode).toBe(0);
    await expect(access(join(root, "data", "stop.request"))).rejects.toThrow();
    await expect(readFile(join(root, "data", "keep.txt"), "utf8")).resolves.toBe("preserve-me");
    const pidText = await readFile(join(root, "data", "whitelily.pid"), "utf8");

    const stopped = await runWindowsScriptFixture(
      root,
      "stop.ps1",
      ["-GracefulTimeoutSeconds", "3"],
      { pidFile: pidText, unrelatedDataFile: "preserve-me" },
    );
    expect(stopped.exitCode).toBe(0);
  }, 20_000);

  it("starts again with real Node after stop prepared command shims on the same root", async () => {
    const root = await fixtureRoot();
    const config = '[minecraft]\nowner_username = "FixtureOwner"\n';
    const firstStart = await runWindowsScriptFixture(root, "start.ps1", [], {
      existingConfig: config,
    });
    expect(firstStart.exitCode).toBe(0);
    const firstPid = await readFile(join(root, "data", "whitelily.pid"), "utf8");

    const firstStop = await runWindowsScriptFixture(
      root,
      "stop.ps1",
      ["-GracefulTimeoutSeconds", "3"],
      { pidFile: firstPid },
    );
    expect(firstStop.exitCode).toBe(0);

    const secondStart = await runWindowsScriptFixture(root, "start.ps1", [], {
      existingConfig: config,
    });
    expect(secondStart.exitCode).toBe(0);
    const secondPid = await readFile(join(root, "data", "whitelily.pid"), "utf8");
    expect(secondPid.trim()).not.toBe(firstPid.trim());
    await expect(findFixtureServicePids(root)).resolves.toContain(Number(secondPid.trim()));

    const secondStop = await runWindowsScriptFixture(
      root,
      "stop.ps1",
      ["-GracefulTimeoutSeconds", "3"],
      { pidFile: secondPid },
    );
    expect(secondStop.exitCode).toBe(0);
  }, 30_000);

  it("cleans up the exact child when PID persistence fails after spawn", async () => {
    const root = await fixtureRoot();
    const result = await runWindowsScriptFixture(root, "start.ps1", [], {
      existingConfig: '[minecraft]\nowner_username = "FixtureOwner"\n',
      pidPathAsDirectory: true,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("FAIL");
    const remaining = await findFixtureServicePids(root);
    const identities = await Promise.all(remaining.map(queryWindowsProcessIdentity));
    expect(
      identities.filter((identity) => identity !== undefined),
      JSON.stringify({ result, identities }),
    ).toEqual([]);
  }, 15_000);

  it("cleans up the exact child when fixture identity cannot be established", async () => {
    const root = await fixtureRoot();
    let spawnedPid: number | undefined;

    const result = await observe(
      startOwnedFixtureProcess(root, "stubborn", undefined, {
        expectedIdentityPathForTest: join(root, "dist", "src", "missing.js"),
        onSpawnedPidForTest: (pid) => {
          spawnedPid = pid;
        },
      }),
    );

    expect(result.status).toBe("rejected");
    expect(spawnedPid).toBeDefined();
    expect(processIsAlive(spawnedPid!)).toBe(false);
  }, 15_000);

  it("refuses fixture cleanup when the registered process identity does not match", async () => {
    const root = await fixtureRoot();
    const identity = await queryWindowsProcessIdentity(process.pid);
    expect(identity).toBeDefined();
    registerFixtureCleanupIdentityForTest(root, {
      pid: process.pid,
      creationDate: (BigInt(identity!.creationDate) + 1n).toString(),
      entryPath: join(root, "dist", "src", "index.js"),
    });

    await expect(cleanupWindowsFixture(root)).rejects.toThrow("identity changed");
    await expect(cleanupWindowsFixture(root)).rejects.toThrow("identity changed");
    const lateOperation = await observe(
      runWindowsScriptFixture(root, "doctor.ps1", [], {
        existingConfig: '[minecraft]\nowner_username = "FixtureOwner"\n',
      }),
    );
    expect(lateOperation.status).toBe("rejected");
    if (lateOperation.status === "rejected") {
      expect(lateOperation.reason).toMatchObject({ name: "AbortError" });
    }
    expect(processIsAlive(process.pid)).toBe(true);
    await expect(access(root)).resolves.toBeUndefined();
    clearFixtureCleanupIdentityForTest(root);
    await cleanupWindowsFixture(root);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels an active fixture operation and closes its process tree", async () => {
    const root = await fixtureRoot();
    const controller = new AbortController();
    const running = observe(
      runWindowsScriptFixture(root, "doctor.ps1", [], {
        existingConfig: '[minecraft]\nowner_username = "FixtureOwner"\n',
        codexDelayMilliseconds: 10_000,
        signal: controller.signal,
      }),
    );

    await waitForText(
      join(root, "command-invocations.log"),
      "codex login status",
      "delayed Codex invocation",
    );
    let descendants: number[] = [];
    const descendantDeadline = performance.now() + 5_000;
    while (descendants.length === 0 && performance.now() < descendantDeadline) {
      descendants = await findFixtureCodexDelayPids(root);
      if (descendants.length === 0) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
      }
    }
    expect(descendants.length).toBeGreaterThan(0);
    controller.abort();
    const settled = await running;

    expect(settled.status).toBe("rejected");
    if (settled.status === "rejected") {
      expect(settled.reason).toMatchObject({ name: "AbortError" });
    }
    const identities = await Promise.all(
      descendants.map((pid) => queryWindowsProcessIdentity(pid)),
    );
    expect(identities).toEqual(descendants.map(() => undefined));
    await cleanupWindowsFixture(root);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(findFixtureServicePids(root)).resolves.toEqual([]);
  }, 20_000);

  it("waits for the root process close before reporting a taskkill failure", async () => {
    const root = await fixtureRoot();
    const owned = await startOwnedFixtureProcess(root, "stubborn");
    children.push(owned);
    const controller = new AbortController();
    let closeObserved = false;
    const running = observe(
      runWindowsScriptFixture(root, "stop.ps1", ["-GracefulTimeoutSeconds", "10"], {
        pidFile: String(owned.pid),
        signal: controller.signal,
        taskkillPathForTest: join(root, "missing-taskkill.exe"),
        closeSettlementDelayMillisecondsForTest: 100,
        onProcessCloseForTest: () => {
          closeObserved = true;
        },
      }),
    );

    await waitForPath(join(root, "data", "stop.request"), "fixture stop marker");
    controller.abort();
    const settled = await running;

    expect(settled.status).toBe("rejected");
    expect(closeObserved).toBe(true);
  }, 20_000);

  it("times out and closes the fixture process tree", async () => {
    const root = await fixtureRoot();
    const running = observe(
      runWindowsScriptFixture(root, "doctor.ps1", [], {
        existingConfig: '[minecraft]\nowner_username = "FixtureOwner"\n',
        codexDelayMilliseconds: 30_000,
        operationTimeoutMilliseconds: 12_000,
      }),
    );

    await waitForText(
      join(root, "command-invocations.log"),
      "codex login status",
      "delayed Codex invocation",
      15_000,
    );
    let descendants: number[] = [];
    const descendantDeadline = performance.now() + 3_000;
    while (descendants.length === 0 && performance.now() < descendantDeadline) {
      descendants = await findFixtureCodexDelayPids(root);
      if (descendants.length === 0) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
      }
    }
    expect(descendants.length).toBeGreaterThan(0);
    const settled = await running;

    expect(settled.status).toBe("rejected");
    if (settled.status === "rejected") {
      expect(settled.reason).toMatchObject({ name: "TimeoutError" });
    }
    const identities = await Promise.all(
      descendants.map((pid) => queryWindowsProcessIdentity(pid)),
    );
    expect(identities).toEqual(descendants.map(() => undefined));
    await cleanupWindowsFixture(root);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(findFixtureServicePids(root)).resolves.toEqual([]);
  }, 15_000);

  it("cleanup cancels in-flight fixture operations before removing their cwd", async () => {
    const root = await fixtureRoot();
    const owned = await startOwnedFixtureProcess(root, "stubborn");
    children.push(owned);
    const stopping = observe(
      runWindowsScriptFixture(root, "stop.ps1", ["-GracefulTimeoutSeconds", "10"], {
        pidFile: String(owned.pid),
      }),
    );

    await waitForPath(join(root, "data", "stop.request"), "fixture stop marker");
    const cleanupResults = await Promise.all([
      observe(cleanupWindowsFixture(root)),
      observe(cleanupWindowsFixture(root)),
    ]);
    if (cleanupResults.some((result) => result.status === "rejected")) {
      killFixtureProcess(owned);
    }
    const stopped = await stopping;

    expect(cleanupResults.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(stopped.status).toBe("rejected");
    if (stopped.status === "rejected") {
      expect(stopped.reason).toMatchObject({ name: "AbortError" });
    }
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(findFixtureServicePids(root)).resolves.toEqual([]);
  }, 20_000);

  it("accepts the exact independent ChatGPT login status line", async () => {
    const root = await fixtureRoot();
    const result = await runWindowsScriptFixture(root, "doctor.ps1", [], {
      existingConfig: '[minecraft]\nowner_username = "PrivateOwner"\n',
      codexStatus: "Logged in using ChatGPT",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS");
    expect(result.createdPaths).toEqual([]);
    expect(result.deletedPaths).toEqual([]);
  });

  it("accepts an exact ChatGPT login line within multiline status output", async () => {
    const root = await fixtureRoot();
    const result = await runWindowsScriptFixture(root, "doctor.ps1", [], {
      existingConfig: '[minecraft]\nowner_username = "PrivateOwner"\n',
      codexStatus: "Codex status\r\nLogged in using ChatGPT\r\nReady",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PASS: Codex login");
  });

  it.each([" Logged in using ChatGPT", "Logged in using ChatGPT ", "Logged in using ChatGPT\t"])(
    "rejects a whitespace-mutated ChatGPT login line: %j",
    async (codexStatus) => {
      const root = await fixtureRoot();
      const result = await runWindowsScriptFixture(root, "doctor.ps1", [], {
        existingConfig: '[minecraft]\nowner_username = "PrivateOwner"\n',
        codexStatus,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("FAIL: Codex login");
      expect(result.stdout + result.stderr).not.toContain(codexStatus);
    },
  );

  it("rejects negative wording that merely mentions ChatGPT without echoing it", async () => {
    const root = await fixtureRoot();
    const negativeStatus = `Not logged in; sign in with ChatGPT as ${privateEmail}`;
    const result = await runWindowsScriptFixture(root, "doctor.ps1", [], {
      existingConfig: '[minecraft]\nowner_username = "PrivateOwner"\n',
      codexStatus: negativeStatus,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("FAIL: Codex login");
    expect(result.stdout + result.stderr).not.toContain(negativeStatus);
    expect(result.stdout + result.stderr).not.toContain(privateEmail);
  });
});
