import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SafeLogger } from "../../src/logging/safeLogger.js";

async function logPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "whitelily-log-"));
  return join(directory, "events.jsonl");
}

describe("SafeLogger", () => {
  it("redacts secrets and drops root full chat fields", async () => {
    const path = await logPath();
    const logger = new SafeLogger(path);
    await logger.info("turn_failed", {
      message: "玩家的完整消息",
      chat: "完整聊天转录",
      token: "sk-test-abcdefghijklmnopqrstuvwxyz123456",
      code: "quota_exhausted",
    });

    const output = await readFile(path, "utf8");
    expect(output).not.toContain("玩家的完整消息");
    expect(output).not.toContain("完整聊天转录");
    expect(output).not.toContain("sk-test-abcdefghijklmnopqrstuvwxyz123456");
    expect(output).toContain("[REDACTED_OPENAI_KEY]");
    expect(output).toContain("quota_exhausted");
  });

  it("drops nested chat and message fields while preserving safe context", async () => {
    const path = await logPath();
    const logger = new SafeLogger(path);
    await logger.error("tool_failed", {
      details: {
        message: "nested player message",
        CHAT: "nested transcript",
        code: "tool_timeout",
        retry: { raw_message: "deeper chat", attempt: 2 },
      },
      history: [{ Message: "array chat", code: "old_failure" }],
    });

    const output = await readFile(path, "utf8");
    expect(output).not.toContain("nested player message");
    expect(output).not.toContain("nested transcript");
    expect(output).not.toContain("deeper chat");
    expect(output).not.toContain("array chat");
    expect(output).toContain("tool_timeout");
    expect(output).toContain("old_failure");
  });

  it("redacts every retained string field and produces valid JSONL for both levels", async () => {
    const path = await logPath();
    const logger = new SafeLogger(path);
    await logger.info("state_changed", {
      note: "PASSWORD=hunter2",
      nested: { email: "player@example.invalid" },
      values: ["phone=13800138000", "safe"],
    });
    await logger.error("connection_failed", { reason: "Bearer abcdefghijklmnopqrstuvwxyz.123456" });

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.level)).toEqual(["info", "error"]);
    expect(events.map((event) => event.event)).toEqual(["state_changed", "connection_failed"]);
    expect(lines.join("\n")).not.toContain("hunter2");
    expect(lines.join("\n")).not.toContain("player@example.invalid");
    expect(lines.join("\n")).not.toContain("13800138000");
    expect(lines.join("\n")).not.toContain("abcdefghijklmnopqrstuvwxyz.123456");
  });

  it("writes a valid safe line for circular, BigInt, array, and Error fields", async () => {
    const path = await logPath();
    const logger = new SafeLogger(path);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const error = Object.assign(new Error("raw error message"), { code: "E_SECRET" });

    await expect(
      logger.info("the player said a full chat message", {
        circular,
        count: 1n,
        values: [2n, error],
        error,
      }),
    ).resolves.toBeUndefined();

    const output = await readFile(path, "utf8");
    const event = JSON.parse(output) as Record<string, unknown>;
    expect(event.event).toBe("invalid_event");
    expect(output).not.toContain("the player said a full chat message");
    expect(output).not.toContain("raw error message");
    expect(event).toHaveProperty("count");
  });

  it("redacts nested JSON environment URLs without breaking JSONL", async () => {
    const path = await logPath();
    await new SafeLogger(path).info("config_loaded", {
      config: { DATABASE_URL: "postgres://player:db-password@localhost/world" },
      cache: { REDIS_URL: "redis://cache-user:redis-password@localhost:6379/0" },
    });

    const output = await readFile(path, "utf8");
    expect(() => JSON.parse(output)).not.toThrow();
    expect(output).not.toContain("db-password");
    expect(output).not.toContain("redis-password");
  });

  it("keeps repeated non-circular objects at each path", async () => {
    const path = await logPath();
    const shared = { code: "same_value" };
    await new SafeLogger(path).info("shared_context", { from: shared, to: shared });

    const event = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(event.from).toEqual({ code: "same_value" });
    expect(event.to).toEqual({ code: "same_value" });
  });

  it("does not leak marker-bypassing secrets or empty-userinfo URLs", async () => {
    const path = await logPath();
    await new SafeLogger(path).info("credentials_seen", {
      nested: { TOKEN: "actual-secret [REDACTED] suffix" },
      endpoint: "redis://:redis-password@localhost:6379/0",
    });

    const output = await readFile(path, "utf8");
    expect(() => JSON.parse(output)).not.toThrow();
    expect(output).not.toContain("actual-secret");
    expect(output).not.toContain("redis-password");
  });

  it("does not leak marker-prefix or non-string sensitive values", async () => {
    const path = await logPath();
    await new SafeLogger(path).info("credentials_seen", {
      note: "TOKEN=[REDACTED]suffix actual-secret",
      TOKEN: { value: "actual-secret" },
      nested: { password: ["actual-secret"] },
    });

    const output = await readFile(path, "utf8");
    expect(() => JSON.parse(output)).not.toThrow();
    expect(output).not.toContain("actual-secret");
  });
});
