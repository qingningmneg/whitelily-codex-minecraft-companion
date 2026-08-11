import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskController, type ActiveTask } from "../../src/companion/taskController.js";
import { RuntimeFacade } from "../../src/runtime/runtimeFacade.js";
import { TaskControllerBudget, type TaskBudgetSnapshot } from "../../src/safety/taskBudget.js";
import {
  runPublicRepoPreparation,
  runReleaseJunctionRegressions,
  runReleasePackage,
  runReleaseSecurityRegressions,
} from "../support/publicRepoHarness.js";
import { createCompanionHarness } from "../support/companionHarness.js";

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
  "docs/installation-windows.zh-CN.md",
  "docs/installation-windows.md",
  "docs/smartscreen.zh-CN.md",
  "docs/smartscreen.md",
];

interface InstallerLifecycleAttestation {
  attestationSchemaVersion: number;
  productVersion: string;
  packageSourceCommit: string;
  lifecycleValidationCommit: string;
  canonicalLifecyclePath: string;
  lifecycleSha256: string;
  hostPersistedLastWriteTimeUtc: string;
  candidate: {
    filename: string;
    bytes: number;
    sha256: string;
    signature: string;
    authenticodeStatus: string;
  };
  publicBaseline: {
    releaseTag: string;
    filename: string;
    bytes: number;
    sha256: string;
  };
  lifecycle: {
    schemaVersion: number;
    success: boolean;
    stageCount: number;
    stages: string[];
    controllerSid: string;
    candidateReportWriteDenied: boolean;
    managedWorkspaceResources: number;
    minecraftComponentResources: number;
    componentPreferencesFresh: boolean;
    componentPreferencesUpgradePreserved: boolean;
    componentPreferencesKeepPreserved: boolean;
  };
  zeroResidue: {
    trackedWindowsSandbox: number;
    sandboxMappings: number;
    sandboxRoots: number;
    lifecycleHivePresent: boolean;
    candidatePrincipalPresent: boolean;
    remoteSessionEnumeration: string;
  };
}

function assertAttestationShape(value: unknown): asserts value is InstallerLifecycleAttestation {
  if (!value || typeof value !== "object") throw new Error("attestation object required");
  const attestation = value as Partial<InstallerLifecycleAttestation>;
  if (attestation.attestationSchemaVersion !== 1) throw new Error("attestation schema required");
  if (!/^[0-9a-f]{64}$/u.test(attestation.lifecycleSha256 ?? "")) {
    throw new Error("attestation lifecycle hash required");
  }
  if (
    attestation.canonicalLifecyclePath !==
    "build/electron-installer/WhiteLily-0.2.0-beta.2-windows-x64-installer-lifecycle.json"
  ) {
    throw new Error("attestation canonical lifecycle path required");
  }
  const serialized = JSON.stringify(attestation);
  if (
    /candidate(?:Sid|User|Username)|\b(?:pid|processId)\b|S-1-5-21-|[A-Z]:\\|\/Users\//iu.test(
      serialized,
    )
  ) {
    throw new Error("attestation must not contain personal paths or candidate identity");
  }
}

describe("public release readiness", () => {
  it("attests the canonical installer lifecycle without personal host details", async () => {
    const attestationPath =
      "docs/release-evidence/WhiteLily-0.2.0-beta.2-installer-lifecycle.attestation.json";
    const attestation = JSON.parse(await readFile(attestationPath, "utf8")) as unknown;
    assertAttestationShape(attestation);
    const record = attestation as InstallerLifecycleAttestation;
    expect(Number.isNaN(Date.parse(record.hostPersistedLastWriteTimeUtc))).toBe(false);
    expect(record).toMatchObject({
      productVersion: "0.2.0-beta.2",
      packageSourceCommit: "44901a5e8f17bba77378746e4bc04fab6c335962",
      lifecycleValidationCommit: "44901a5e8f17bba77378746e4bc04fab6c335962",
      lifecycleSha256: "6f966e8d4a700d3142e043765958b4d164a936a76476affacb8537b3cdb70fb2",
      hostPersistedLastWriteTimeUtc: "2026-08-11T15:21:33.8495467Z",
      candidate: {
        filename: "WhiteLily-0.2.0-beta.2-windows-x64-setup.exe",
        bytes: 229_357_597,
        sha256: "baac43d0677b398e55ea92f336e35cc71d34c426b539f0f278ab13dbc74c7ebd",
        signature: "unsigned",
        authenticodeStatus: "NotSigned",
      },
      publicBaseline: {
        releaseTag: "v0.2.0-beta.1",
        filename: "WhiteLily-0.2.0-beta.1-windows-x64-setup.exe",
        bytes: 226_359_624,
        sha256: "e3ba23e37d62eee8697c7a3af94206357acf3bae0755a61e8b92702aa60a8cd4",
      },
      lifecycle: {
        schemaVersion: 2,
        success: true,
        stageCount: 15,
        controllerSid: "S-1-5-18",
        candidateReportWriteDenied: true,
        managedWorkspaceResources: 3,
        minecraftComponentResources: 9,
        componentPreferencesFresh: true,
        componentPreferencesUpgradePreserved: true,
        componentPreferencesKeepPreserved: true,
      },
      zeroResidue: {
        trackedWindowsSandbox: 0,
        sandboxMappings: 0,
        sandboxRoots: 0,
        lifecycleHivePresent: false,
        candidatePrincipalPresent: false,
        remoteSessionEnumeration: "not-performed",
      },
    });

    const [rootPackage, desktopPackage, runtimeManifest, baselineContract] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("apps/desktop/package.json", "utf8"),
      readFile("packaging/electron/runtime-manifest.json", "utf8"),
      readFile("packaging/electron/public-installer-baselines.json", "utf8"),
    ]);
    expect(JSON.parse(rootPackage).version).toBe(record.productVersion);
    expect(JSON.parse(desktopPackage).version).toBe(record.productVersion);
    expect(JSON.parse(runtimeManifest).productVersion).toBe(record.productVersion);
    expect(JSON.parse(baselineContract).baselines).toContainEqual({
      version: "0.2.0-beta.1",
      releaseTag: record.publicBaseline.releaseTag,
      assetName: record.publicBaseline.filename,
      bytes: record.publicBaseline.bytes,
      sha256: record.publicBaseline.sha256,
    });

    const verification = spawnSync(
      process.execPath,
      [
        resolve(
          import.meta.dirname,
          "..",
          "..",
          "scripts",
          "verify-installer-lifecycle-attestation.mjs",
        ),
        "--repo-root",
        process.cwd(),
      ],
      { encoding: "utf8" },
    );
    expect(verification.status, `${verification.stdout}\n${verification.stderr}`).toBe(0);
  });

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
      "publishes one fail-closed `world_changed` event",
      "normalizes modern `worldState.name` and legacy flat `worldName`",
      "world invalidation latch",
      "persists the world invalidation marker across process restart",
      "Dig cancellation calls Mineflayer's `stopDigging`",
      "Movement and dig cancellation are bounded by a one-second physical acknowledgement window",
      "physical transport close",
      "Explicit disconnect and partial setup teardown use the same physical transport close",
      "ActionExecutor performs SafetyEngine policy evaluation",
      "MCP registry does not depend directly on TaskController",
      "authority-free `prepare()`",
      "exactly one `task_stopped` record",
      "flushes that queue before `stop()` resolves",
    ]) {
      expect(architecture).toContain(heading);
    }
  });

  it("publishes an auditable public task while Minecraft receives zero authorization disclosure", async () => {
    const value = await createCompanionHarness({
      deferredTurns: [0],
      intentResponses: [
        JSON.stringify({
          kind: "start_task",
          naturalReply: null,
          task: {
            goal: "走到主人身边",
            allowedActions: ["get_state", "move_to"],
            requestedLimits: { maxToolCalls: 4, maxHorizontalTravel: 64 },
          },
          memoryCandidates: [],
        }),
      ],
      executionResponses: [
        JSON.stringify({ reply: "我到你身边了。", status: "completed", memoryCandidates: [] }),
      ],
    });
    try {
      await value.start();
      await value.emitOwnerText("走到我身边来");
      await value.untilCodexTurns(1);
      const activeTask = value.taskController.current();
      if (!activeTask) throw new Error("expected active task state");
      const { minecraft } = value;
      const budget: TaskBudgetSnapshot = {
        active: true,
        stopReason: null,
        limits: { ...activeTask.disclosure.limits },
        toolCalls: 0,
        blockChanges: 0,
        horizontalTravel: 0,
        dangerousOperations: 0,
        startedAt: activeTask.lease.startedAt,
      };
      const runtime = new RuntimeFacade({
        lifecycle: {
          start: async () => undefined,
          stop: async () => undefined,
        },
        task: {
          current: () => value.taskController.current(),
          budget: () => budget,
          status: () => "running",
          stop: (reason) => value.taskController.stop(reason),
          subscribe: () => () => undefined,
        },
        createPublicTaskId: () => "task_release_public",
      });
      const publicTask = runtime.snapshot().task;

      expect(publicTask).toEqual({
        id: "task_release_public",
        goal: "走到主人身边",
        status: "running",
        allowedActions: ["get_state", "move_to"],
        effectiveLimits: budget.limits,
        startedAt: activeTask.startedAt,
        budget,
      });
      expect(JSON.stringify(publicTask)).not.toContain(activeTask.lease.id);
      expect(JSON.stringify(publicTask)).not.toContain("ownerMessage");
      expect(JSON.stringify(publicTask)).not.toContain("prompt");
      expect(minecraft.chatLog.join("\n")).not.toMatch(
        /任务披露|expectedActions|allowedActions|maxToolCalls|maxBlockChanges|maxHorizontalTravel|maxDurationMs|maxDangerousOperations|leaseId|stopCondition/u,
      );
      expect(value.taskAuditEvents).toEqual(["task_started"]);

      value.taskController.stop("owner_stop");
      expect(value.taskAuditEvents).toEqual(["task_started", "task_stopped:owner_stop"]);
    } finally {
      await value.stop();
      await value.cleanup();
    }
  });

  it("enforces the public disclosure and operational fail-closed behavior", async () => {
    const limits = {
      maxToolCalls: 64,
      maxBlockChanges: 256,
      maxHorizontalTravel: 1_024,
      maxDurationMs: 600_000,
      maxDangerousOperations: 8,
    };
    const task: ActiveTask = {
      id: "release-private-lease",
      lease: { id: "release-private-lease", startedAt: 1_700_000_000_000 },
      disclosure: {
        goal: `Inspect ${"C:" + String.raw`\Users\Jane Doe\Private Notes\todo.txt`} password="Jane Doe private password"`,
        expectedActions: ["place"],
        limits,
        stopCondition: "Stop safely",
      },
      startedAt: "2023-11-14T22:13:20.000Z",
    };
    const budget: TaskBudgetSnapshot = {
      active: true,
      stopReason: null,
      limits,
      toolCalls: 0,
      blockChanges: 0,
      horizontalTravel: 0,
      dangerousOperations: 0,
      startedAt: 1_700_000_000_000,
    };
    let minecraftListener: ((event: unknown) => void) | undefined;
    let taskStops = 0;
    let lifecycleStops = 0;
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => {
          lifecycleStops += 1;
        },
      },
      task: {
        current: () => task,
        budget: () => budget,
        stop: () => {
          taskStops += 1;
        },
      },
      minecraft: {
        subscribe: (listener) => {
          minecraftListener = listener as (event: unknown) => void;
          return () => undefined;
        },
      },
      createPublicTaskId: () => "task_release_public",
    });

    const published = JSON.stringify(runtime.snapshot());
    expect(published).not.toContain("Jane Doe");
    expect(published).not.toContain("Private Notes");
    expect(published).not.toContain("private password");
    expect(published).not.toContain(task.lease.id);

    minecraftListener?.({ kind: "world_changed", extra: "private backend state" });

    expect(runtime.snapshot()).toMatchObject({
      lifecycle: "failed",
      task: null,
      lastError: { code: "MINECRAFT_STATE_UNKNOWN" },
    });
    expect(taskStops).toBe(1);
    await runtime.stop("process_exit");
    expect(lifecycleStops).toBe(1);
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
    expect(candidate.files).toContain("apps/desktop/build/after-pack.cjs");
    expect(candidate.files).toContain("apps/desktop/build/icon.ico");
    expect(candidate.files).not.toContain(".git/config.from-internal-repo");
    expect(candidate.files.some((file) => file.startsWith(".superpowers/"))).toBe(false);
    expect(candidate.files.some((file) => file.startsWith("docs/superpowers/"))).toBe(false);
  }, 60_000);

  it("packages a closed README documentation bundle from the produced ZIP", async () => {
    const artifact = await runReleasePackage("0.1.0");
    expect(artifact.hasChecksum).toBe(true);
    expect(artifact.stagingRemoved).toBe(true);
    expect(artifact.entries).toContain("docs/windows-smoke-test.md");
    expect(artifact.entries).toContain("docs/installation-windows.zh-CN.md");
    expect(artifact.entries).toContain("docs/runtime-architecture.md");
    expect(artifact.readmeLocalLinks).toContain("docs/installation-windows.zh-CN.md");
    expect(artifact.readmeLocalLinks).toContain("docs/runtime-architecture.md");
    expect(artifact.missingReadmeLocalLinks).toEqual([]);
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
    expect(result.dependencyLockEmailAllowed).toBe(true);
    expect(result.sourceEmailRejected).toBe(true);
    expect(result.placeholderUserPathsAllowed).toBe(true);
    expect(result.personalUserPathRejected).toBe(true);
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

  it("documents the installed Minecraft action acceptance and rollback evidence", async () => {
    const smokeTest = await readFile("docs/windows-smoke-test.md", "utf8");

    for (const evidence of [
      String.raw`%LOCALAPPDATA%\WhiteLily\codex-workspace\AGENTS.md`,
      String.raw`%LOCALAPPDATA%\WhiteLily\codex-workspace\.codex\config.toml`,
      String.raw`%LOCALAPPDATA%\WhiteLily\codex-workspace\workspace-manifest.json`,
      "127.0.0.1:32123",
      "workspaceVersion",
      "mcpListening",
      "discoveredToolCount",
      "toolCalls >= 1",
      "查看一下你现在的位置",
      "走到我身边来",
      "Minecraft Java 1.21.5",
      "可丢弃",
      "重启",
      "回滚",
    ]) {
      expect(smokeTest).toContain(evidence);
    }
    expect(smokeTest).toMatch(/实际移动[\s\S]{0,120}(?:预算|审计)/u);
  });

  it("documents the first release as same-machine only", async () => {
    await expect(readFile("README.md", "utf8")).resolves.toContain(
      "cross-device deployment is not supported",
    );
    await expect(readFile("README.zh-CN.md", "utf8")).resolves.toContain("不支持跨电脑部署");
  });

  it("publishes the real Windows installer only from beta tags", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");

    expect(workflow).toContain('- "v*-beta.*"');
    expect(workflow).not.toContain('- "v*"\n');
    expect(workflow).toContain("./scripts/package-installer.ps1");
    expect(workflow).toContain("WhiteLily-*-windows-x64-setup.exe");
    expect(workflow).toContain("WhiteLily-*-windows-x64-setup.exe.sha256");
    expect(workflow).toContain("WhiteLily-*-windows-x64-setup.exe.signing-status.txt");
    expect(workflow).toContain("--prerelease");
  });

  it.each([".github/workflows/ci.yml", ".github/workflows/release.yml"])(
    "%s prepares deterministic desktop resources before testing",
    async (path) => {
      const workflow = await readFile(path, "utf8");
      const runCommands = [...workflow.matchAll(/^\s*-\s+run:\s+(.+)$/gmu)].map(
        (match) => match[1]?.trim() ?? "",
      );
      const testCommand = runCommands.find((command) => command.startsWith("npm test"));

      expect(runCommands).toContain("npm run desktop:prepare");
      expect(runCommands.indexOf("npm run desktop:prepare")).toBeLessThan(
        runCommands.indexOf(testCommand ?? ""),
      );
      expect(testCommand).toBe("npm test -- --no-file-parallelism");
      expect(workflow).not.toContain("${{ runner.temp }}");
      expect(workflow).toContain('"TEMP=$env:RUNNER_TEMP" >> $env:GITHUB_ENV');
      expect(workflow).toContain('"TMP=$env:RUNNER_TEMP" >> $env:GITHUB_ENV');
      expect(workflow.indexOf('"TEMP=$env:RUNNER_TEMP"')).toBeLessThan(
        workflow.indexOf("- run: npm ci"),
      );
    },
  );

  it("documents the released Windows Public Beta workflow in Chinese and English", async () => {
    const [readme, readmeZh, installZh, installEn, smartScreenZh, smartScreenEn] =
      await Promise.all(
        [
          "README.md",
          "README.zh-CN.md",
          "docs/installation-windows.zh-CN.md",
          "docs/installation-windows.md",
          "docs/smartscreen.zh-CN.md",
          "docs/smartscreen.md",
        ].map((path) => readFile(path, "utf8")),
      );
    const chinese = [readme, readmeZh, installZh, smartScreenZh].join("\n");
    const english = [readme, installEn, smartScreenEn].join("\n");

    for (const corpus of [chinese, english]) {
      expect(corpus).toContain("WhiteLily-0.2.0-beta.1-windows-x64-setup.exe");
      expect(corpus).toContain(".sha256");
      expect(corpus).toContain("SHA-256");
      expect(corpus).toContain("127.0.0.1");
      expect(corpus).toContain("PCL2");
      expect(corpus).toContain("Minecraft Java");
      expect(corpus).toContain("1.21.5");
      expect(corpus).toContain("ChatGPT");
      expect(corpus).toMatch(/Node(?:\.js)?[\s\S]{0,160}npm[\s\S]{0,160}Git[\s\S]{0,160}Codex/u);
    }

    expect(chinese).toMatch(/Public Beta/u);
    expect(chinese).toMatch(/预发布/u);
    expect(chinese).toMatch(/(?:隔离|Sandbox).{0,120}(?:安装|生命周期).{0,120}验收/u);
    expect(chinese).toMatch(/未签名/u);
    expect(chinese).toContain("SmartScreen");
    expect(chinese).toMatch(/用户自行.{0,80}(?:启动|操作).{0,80}PCL2/u);
    expect(chinese).toMatch(/不会.{0,80}(?:启动|控制|点击|修改).{0,80}PCL2/u);
    expect(chinese).toMatch(/不提供.{0,80}API.{0,40}(?:密钥|Key).{0,40}回退/iu);
    expect(chinese).toMatch(/升级.{0,80}保留.{0,80}(?:设置|配置|记忆|数据)/u);
    expect(chinese).toContain("保留 WhiteLily 数据");
    expect(chinese).toContain("删除 WhiteLily 数据");
    expect(chinese).toMatch(/保留 WhiteLily 数据.{0,40}(?:默认|推荐)/u);

    expect(english).toMatch(/Public Beta/i);
    expect(english).toMatch(/prerelease/i);
    expect(english).toMatch(
      /(?:isolated|Sandbox).{0,120}(?:installer|lifecycle).{0,120}acceptance/is,
    );
    expect(english).toMatch(/unsigned/i);
    expect(english).toContain("SmartScreen");
    expect(english).toMatch(/you (?:start|operate).{0,80}PCL2|PCL2.{0,80}under your control/is);
    expect(english).toMatch(/does not.{0,80}(?:launch|control|click|modify).{0,80}PCL2/is);
    expect(english).toMatch(/no.{0,80}(?:Platform )?API[- ]key fallback/is);
    expect(english).toMatch(
      /upgrade.{0,120}preserv(?:e|es).{0,80}(?:settings|configuration|memory|data)/is,
    );
    expect(english).toContain("Keep WhiteLily data");
    expect(english).toContain("Delete WhiteLily data");
    expect(english).toMatch(/Keep WhiteLily data.{0,40}default/is);
  });
});
