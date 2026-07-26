import { afterEach, describe, expect, it } from "vitest";
import {
  companionTurnOutcomeSchema,
  type CompanionTurnOutcome,
} from "../../src/companion/promptBuilder.js";
import {
  createCompanionHarness,
  teardownCompanionHarnesses,
  type CompanionHarnessOptions,
} from "../support/companionHarness.js";

const harnesses: Array<Awaited<ReturnType<typeof createCompanionHarness>>> = [];

async function harness(options: CompanionHarnessOptions = {}) {
  const created = await createCompanionHarness(options);
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  await teardownCompanionHarnesses(harnesses.splice(0));
});

describe("companion harness teardown", () => {
  it("attempts cleanup and propagates a stop failure", async () => {
    const stopError = new Error("stop failed");
    const calls: string[] = [];

    await expect(
      teardownCompanionHarnesses([
        {
          stop: async () => {
            calls.push("stop");
            throw stopError;
          },
          cleanup: async () => {
            calls.push("cleanup");
          },
        },
      ]),
    ).rejects.toBe(stopError);
    expect(calls).toEqual(["stop", "cleanup"]);
  });

  it("propagates a cleanup failure after a successful stop", async () => {
    const cleanupError = new Error("cleanup failed");
    const calls: string[] = [];

    await expect(
      teardownCompanionHarnesses([
        {
          stop: async () => {
            calls.push("stop");
          },
          cleanup: async () => {
            calls.push("cleanup");
            throw cleanupError;
          },
        },
      ]),
    ).rejects.toBe(cleanupError);
    expect(calls).toEqual(["stop", "cleanup"]);
  });

  it("preserves both failures while attempting every harness teardown", async () => {
    const stopError = new Error("stop failed");
    const cleanupError = new Error("cleanup failed");
    const calls: string[] = [];
    let thrown: unknown;

    try {
      await teardownCompanionHarnesses([
        {
          stop: async () => {
            calls.push("first stop");
            throw stopError;
          },
          cleanup: async () => {
            calls.push("first cleanup");
            throw cleanupError;
          },
        },
        {
          stop: async () => {
            calls.push("second stop");
          },
          cleanup: async () => {
            calls.push("second cleanup");
          },
        },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([stopError, cleanupError]);
    expect(calls).toHaveLength(4);
    expect(calls).toEqual(
      expect.arrayContaining(["first stop", "first cleanup", "second stop", "second cleanup"]),
    );
    expect(calls.indexOf("first stop")).toBeLessThan(calls.indexOf("first cleanup"));
    expect(calls.indexOf("second stop")).toBeLessThan(calls.indexOf("second cleanup"));
  });
});

describe("simulated WhiteLily lifecycle", () => {
  it("closes the dangerous equip-plus-generic-use tool chain without touching Minecraft", async () => {
    const value = await harness();
    await value.start();

    const equipped = await value.codexCalls("minecraft_equip_item", {
      itemName: "lava_bucket",
      destination: "hand",
    });

    expect(equipped).toMatchObject({
      isError: true,
      text: expect.stringContaining("permanently forbidden"),
    });
    expect(value.minecraft.calls).not.toContainEqual(
      expect.objectContaining({ method: "equipItem" }),
    );
    expect("minecraft_use_held_item" in value.tools).toBe(false);
  });

  it("completes the approved first-stage lifecycle through the public ports", async () => {
    const value = await harness();
    const rememberedTurn = {
      reply: "好呀，我记住啦。",
      task: null,
      memoryCandidates: [
        {
          category: "preference",
          summary: "玩家喜欢在山顶建家",
          importance: 4,
        },
      ],
    } satisfies CompanionTurnOutcome;

    await value.start();
    value.codex.queueResponse(JSON.stringify(rememberedTurn));
    await value.ownerSays("你好，记住我喜欢在山顶建家");

    expect(value.minecraft.chatLog).toContain("好呀，我记住啦。");
    await expect(value.memories.list()).resolves.toMatchObject([
      {
        category: "preference",
        summary: "玩家喜欢在山顶建家",
        importance: 4,
      },
    ]);

    await value.ownerSays("!mode autonomous");
    expect(value.mode.snapshot().mode).toBe("autonomous");

    const tnt = await value.codexCalls("minecraft_place_block", {
      x: 20,
      y: 64,
      z: 20,
      blockName: "tnt",
    });
    expect(tnt).toMatchObject({ isError: true });
    expect(JSON.parse(tnt.text)).toMatchObject({
      status: "denied",
      reason: "TNT is permanently forbidden",
    });
    expect(value.minecraft.calls).not.toContainEqual(
      expect.objectContaining({ method: "placeBlock" }),
    );

    await value.ownerSays("!stop");
    expect(value.executor.pendingCount()).toBe(0);

    await value.restart();
    expect(value.mode.snapshot().mode).toBe("friend");
    await expect(value.memories.search("山顶")).resolves.toHaveLength(1);

    value.codex.failNextTurn("quota_exhausted");
    await value.ownerSays("我们继续吧");
    expect(value.mode.snapshot().paused).toBe(true);
    expect(value.minecraft.chatLog.at(-1)).toContain("我已安全暂停");
  });

  const validCandidate = {
    category: "project",
    summary: "玩家正在修建一座小木屋",
    importance: 4,
  } as const;
  const invalidOutputs: Array<{
    label: string;
    schemaAccepts: boolean;
    output: unknown;
  }> = [
    {
      label: "four candidates",
      schemaAccepts: false,
      output: {
        reply: "收到",
        task: null,
        memoryCandidates: [
          validCandidate,
          { category: "place", summary: "村庄在出生点东边", importance: 3 },
          { category: "preference", summary: "玩家喜欢云杉木", importance: 4 },
          { category: "promise", summary: "下次一起整理仓库", importance: 3 },
        ],
      },
    },
    {
      label: "a 161-character summary",
      schemaAccepts: false,
      output: {
        reply: "收到",
        task: null,
        memoryCandidates: [
          validCandidate,
          { category: "project", summary: "山".repeat(161), importance: 4 },
        ],
      },
    },
    {
      label: "a credential-like summary",
      schemaAccepts: true,
      output: {
        reply: "收到",
        task: null,
        memoryCandidates: [
          validCandidate,
          {
            category: "preference",
            summary: ["OPENAI", "_API", "_KEY", "=", "sk", "-test-1234567890abcdefghijklmnop"].join(
              "",
            ),
            importance: 5,
          },
        ],
      },
    },
    {
      label: "an email-like summary",
      schemaAccepts: true,
      output: {
        reply: "收到",
        task: null,
        memoryCandidates: [
          validCandidate,
          {
            category: "experience",
            summary: "玩家的邮箱是 lily@example.com",
            importance: 5,
          },
        ],
      },
    },
  ];

  it.each(invalidOutputs)(
    "rejects $label as a whole without raw-chat fallback or partial persistence",
    async ({ label, schemaAccepts, output }) => {
      expect(companionTurnOutcomeSchema.safeParse(output).success).toBe(schemaAccepts);
      const value = await harness();
      await value.start();
      value.codex.queueResponse(JSON.stringify(output));

      await value.ownerSays(`RAW_OWNER_CHAT_${label} 请记住`);

      expect(value.codex.turns).toHaveLength(2);
      await expect(value.memories.list()).resolves.toEqual([]);
      await expect(value.memories.search("RAW_OWNER_CHAT")).resolves.toEqual([]);
      expect(value.minecraft.chatLog).not.toContain("收到");
    },
  );
});
