import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  runPublicRepoPreparation,
  runReleaseJunctionRegressions,
  runReleasePackage,
  runReleaseSecurityRegressions,
} from "../support/publicRepoHarness.js";

const required = [
  "README.zh-CN.md",
  "README.md",
  "LICENSE",
  "NOTICE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "scripts/prepare-public-repo.ps1",
  "scripts/package-release.ps1",
  "scripts/release-path-safety.ps1",
  "scripts/release-check.ps1",
  "docs/runtime-architecture.md",
];

describe("public release readiness", () => {
  it("contains every public distribution file", async () => {
    await Promise.all(required.map((path) => access(path)));
  });

  it("documents the reusable runtime boundary", async () => {
    const architecture = await readFile("docs/runtime-architecture.md", "utf8");
    for (const heading of [
      "RuntimeFacade",
      "TaskController",
      "ChatRouter",
      "MineflayerConnection",
      "Emergency stop order",
      "idle --> stopping: stop(reason)",
      "TurnToolBudget forwards task-wide tool-call, block-change, horizontal-travel, and classifier-derived dangerous-operation counts",
      "move and follow distance comes from trusted Minecraft snapshots",
      "deadlines fire independently of later tool calls",
      "cancels queued and in-flight actions",
      "ActionExecutor performs SafetyEngine policy evaluation",
      "MCP registry does not depend directly on TaskController",
    ]) {
      expect(architecture).toContain(heading);
    }
  });

  it("does not publish personal example values", async () => {
    const config = await readFile("config.example.toml", "utf8");
    expect(config).toContain("YourMcName");
    expect(config).not.toMatch(/[A-Z]:\\Users\\/i);
  });

  it("prepares only a local fresh-history candidate", async () => {
    const candidate = await runPublicRepoPreparation({ initializeFreshHistory: true });
    expect(candidate.commitCount).toBe(1);
    expect(candidate.remotes).toEqual([]);
    expect(candidate.files).not.toContain(".git/config.from-internal-repo");
    expect(candidate.files.some((file) => file.startsWith(".superpowers/"))).toBe(false);
    expect(candidate.files.some((file) => file.startsWith("docs/superpowers/"))).toBe(false);
  }, 60_000);

  it("packages the nested Windows smoke-test documentation", async () => {
    const artifact = await runReleasePackage("0.1.0");
    expect(artifact.hasChecksum).toBe(true);
    expect(artifact.stagingRemoved).toBe(true);
    expect(artifact.entries).toContain("docs/windows-smoke-test.md");
    expect(artifact.rawEntries.every((entry) => !entry.includes("\\"))).toBe(true);
    expect(artifact.checksumMatches).toBe(true);
  }, 120_000);

  it("packages only committed files and produces a reproducible archive", async () => {
    const artifact = await runReleasePackage("0.1.1");
    expect(artifact.entries).not.toContain("src/local-credential.txt");
    expect(artifact.hasUntrackedCredential).toBe(false);
    expect(artifact.dirtyHeadMismatchRejected).toBe(true);
    expect(artifact.firstHash).toBe(artifact.secondHash);
  }, 120_000);

  it("fails closed for dirty HEAD exports, UTF-16 secrets, and malformed owner configuration", async () => {
    const result = await runReleaseSecurityRegressions();
    expect(result.dirtyHeadExportRejected).toBe(true);
    expect(result.utf16LeRejected).toBe(true);
    expect(result.utf16BeRejected).toBe(true);
    expect(result.escapedOwnerRejected).toBe(true);
    expect(result.escapedBackslashLowerOwnerRejected).toBe(true);
    expect(result.escapedBackslashUpperOwnerRejected).toBe(true);
    expect(result.malformedOwnerRejected).toBe(true);
    expect(result.sourceOwnerCandidateRejected).toBe(true);
  }, 120_000);

  it("rejects release-root junctions without touching external sentinels", async () => {
    await expect(runReleaseJunctionRegressions()).resolves.toEqual({
      prepareRejectedWithoutExternalMutation: true,
      packageRejectedWithoutExternalMutation: true,
      payloadRejectedWithoutExternalMutation: true,
    });
  }, 120_000);

  it("uses !stop in the public chat documentation", async () => {
    await expect(readFile("README.md", "utf8")).resolves.not.toContain("/wl stop");
    await expect(readFile("README.zh-CN.md", "utf8")).resolves.not.toContain("/wl stop");
    const smokeTest = await readFile("docs/windows-smoke-test.md", "utf8");
    expect(smokeTest).toContain("状态为 paused");
    expect(smokeTest).not.toContain("回到安全的朋友模式");
  });

  it("documents the first release as same-machine only", async () => {
    await expect(readFile("README.md", "utf8")).resolves.toContain(
      "cross-device deployment is not supported",
    );
    await expect(readFile("README.zh-CN.md", "utf8")).resolves.toContain("不支持跨电脑部署");
  });
});
