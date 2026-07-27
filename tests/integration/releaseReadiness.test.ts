import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { formatTaskDisclosureForMinecraft } from "../../src/companion/companionService.js";
import { TaskController, type ActiveTask } from "../../src/companion/taskController.js";
import { RuntimeFacade } from "../../src/runtime/runtimeFacade.js";
import { TaskControllerBudget, type TaskBudgetSnapshot } from "../../src/safety/taskBudget.js";
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
      "awaits every disclosure chunk before calling `TaskController.start()`",
      "exactly one `task_stopped` record",
      "flushes that queue before `stop()` resolves",
    ]) {
      expect(architecture).toContain(heading);
    }
  });

  it("keeps release disclosure values equal to the later acquired lower limits", () => {
    const controller = new TaskController(
      new TaskControllerBudget({
        now: () => 1_700_000_000_000,
        randomId: () => "release-task-lease",
      }),
    );
    const requested = {
      maxToolCalls: 5,
      maxBlockChanges: 6,
      maxHorizontalTravel: 7,
      maxDurationMs: 8_000,
      maxDangerousOperations: 1,
    };
    const prepared = controller.prepare(
      {
        goal: "collect safely",
        expectedActions: ["get_state", "move_to", "dig_block"],
        limits: {
          maxToolCalls: 64,
          maxBlockChanges: 256,
          maxHorizontalTravel: 1_024,
          maxDurationMs: 600_000,
          maxDangerousOperations: 8,
        },
        stopCondition: "owner stops or work completes",
      },
      requested,
    );
    const chunks = formatTaskDisclosureForMinecraft(prepared);
    const sent = chunks.map((chunk) => chunk.replace(/^任务披露(?:（续）)?：/u, "")).join("");

    expect(controller.current()).toBeNull();
    expect(sent).toContain("预计动作类别：get_state、move_to、dig_block");
    expect(sent).toContain("工具调用 5");
    expect(sent).toContain("方块修改 6");
    expect(sent).toContain("水平移动 7");
    expect(sent).toContain("持续时间 8000");
    expect(sent).toContain("危险操作 1");
    expect(sent).toContain("停止条件：owner stops or work completes");
    expect(
      chunks.every(
        (chunk) =>
          chunk.length <= 240 &&
          !/[\uD800-\uDBFF]$/u.test(chunk) &&
          !/^[\uDC00-\uDFFF]/u.test(chunk) &&
          !chunk.startsWith("/"),
      ),
    ).toBe(true);

    expect(controller.start(prepared, prepared.limits).disclosure.limits).toEqual(requested);
    controller.stop("completed");
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
      createPublicTaskId: () => "release-public-task",
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
