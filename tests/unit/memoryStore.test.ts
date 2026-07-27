import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/memoryStore.js";

const openAiApiKey = ["OPENAI", "_API", "_KEY"].join("");

async function memoryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "whitelily-memory-"));
  return join(directory, "memories.json");
}

describe("MemoryStore", () => {
  it("returns an empty list when its file is missing", async () => {
    const store = new MemoryStore(await memoryPath());

    await expect(store.list()).resolves.toEqual([]);
  });

  it("persists a concise memory across instances", async () => {
    const path = await memoryPath();
    const first = new MemoryStore(path);
    const saved = await first.add({
      category: "preference",
      summary: "玩家喜欢在山顶建家",
      importance: 4,
    });

    expect(await new MemoryStore(path).search("山顶")).toEqual([saved]);
  });

  it("searches summaries without case sensitivity", async () => {
    const store = new MemoryStore(await memoryPath());
    await store.add({ category: "project", summary: "Build an oak tower", importance: 3 });
    await store.add({ category: "place", summary: "desert outpost", importance: 2 });

    expect(await store.search("OAK")).toMatchObject([{ summary: "Build an oak tower" }]);
  });

  it.each([
    "key=sk-test-abcdefghijklmnopqrstuvwxyz123456",
    "PASSWORD=hunter2",
    `${openAiApiKey}=sk-test-abcdefghijklmnopqrstuvwxyz123456`,
    "DATABASE_URL=postgres://player:secret@localhost/world",
    "Bearer abcdefghijklmnop+private==",
    "authorization: bearer abcdefghijklmnop/private=",
    "https://opaque-access-token@example.invalid/world",
    "redis://cache-user%3Aprivate-password@example.invalid/0",
    "https://first-private@second-private:password@[::1]/world",
    "email=player@example.invalid",
    "PHONE=13800138000",
  ])("refuses sensitive data in a memory summary: %s", async (summary) => {
    const store = new MemoryStore(await memoryPath());

    await expect(store.add({ category: "preference", summary, importance: 5 })).rejects.toThrow(
      "memory contains a credential or sensitive personal datum",
    );
  });

  it.each([
    "221B Baker Street",
    "地址：北京市朝阳区建国路88号",
    "上海市浦东新区世纪大道100号",
    "广东省深圳市南山区科技园科苑路15号",
    "1600 Amphitheatre Parkway, Mountain View",
    "10 Downing St, London",
  ])("refuses a real-world address in a memory summary: %s", async (summary) => {
    const store = new MemoryStore(await memoryPath());
    await expect(store.add({ category: "place", summary, importance: 4 })).rejects.toThrow(
      "memory contains a credential or sensitive personal datum",
    );
  });

  it("rejects an entire candidate batch before writing any safe candidate", async () => {
    const store = new MemoryStore(await memoryPath());
    expect(() =>
      store.addBatch(
        [
          { category: "project", summary: "safe project", importance: 4 },
          { category: "place", summary: "221B Baker Street", importance: 4 },
        ],
        () => true,
      ),
    ).toThrow("memory contains a credential or sensitive personal datum");
    await expect(store.list()).resolves.toEqual([]);
  });

  it("checks batch cancellation immediately after a temporary write before the pre-rename hook", async () => {
    let checks = 0;
    let hookCalls = 0;
    const store = new MemoryStore(await memoryPath(), {
      beforeRename: async () => {
        hookCalls += 1;
      },
    });

    await expect(
      store.addBatch([{ category: "project", summary: "safe project", importance: 4 }], () => {
        checks += 1;
        return checks < 4;
      }),
    ).resolves.toEqual([]);

    expect(hookCalls).toBe(0);
    await expect(store.list()).resolves.toEqual([]);
  });

  it.each([
    JSON.stringify({ password: "hunter2" }),
    JSON.stringify({ token: "abcdefghijklmnopqrstuvwxyz.123456" }),
    JSON.stringify({ note: "password=hunter2" }),
    String.raw`password\u003dhunter2`,
  ])("refuses sensitive JSON and escaped memory payloads: %s", async (summary) => {
    const store = new MemoryStore(await memoryPath());

    await expect(store.add({ category: "preference", summary, importance: 5 })).rejects.toThrow(
      "memory contains a credential or sensitive personal datum",
    );
  });

  it.each([
    JSON.stringify({ DATABASE_URL: "postgres://player:db-password@localhost/world" }),
    JSON.stringify({ config: { REDIS_URL: "redis://cache-user:redis-password@localhost:6379/0" } }),
  ])("refuses credential-bearing JSON environment URLs: %s", async (summary) => {
    const store = new MemoryStore(await memoryPath());

    await expect(store.add({ category: "preference", summary, importance: 5 })).rejects.toThrow(
      "memory contains a credential or sensitive personal datum",
    );
  });

  it.each([
    JSON.stringify({ TOKEN: "actual-secret [REDACTED] suffix" }),
    JSON.stringify({ endpoint: "redis://:redis-password@localhost:6379/0" }),
  ])("refuses marker-bypassing and empty-userinfo JSON payloads: %s", async (summary) => {
    const store = new MemoryStore(await memoryPath());

    await expect(store.add({ category: "preference", summary, importance: 5 })).rejects.toThrow(
      "memory contains a credential or sensitive personal datum",
    );
  });

  it.each([
    "TOKEN=[REDACTED]suffix actual-secret",
    JSON.stringify({ TOKEN: { value: "actual-secret" } }),
    JSON.stringify({ nested: { password: ["actual-secret"] } }),
  ])("refuses marker-prefix and non-string sensitive payloads: %s", async (summary) => {
    const store = new MemoryStore(await memoryPath());

    await expect(store.add({ category: "preference", summary, importance: 5 })).rejects.toThrow(
      "memory contains a credential or sensitive personal datum",
    );
  });

  it.each(["玩家：今晚去挖矿吗？", `模型推理：${"因为这一步可行。".repeat(80)}`])(
    "refuses raw chat and long reasoning: %s",
    async (summary) => {
      const store = new MemoryStore(await memoryPath());

      await expect(store.add({ category: "experience", summary, importance: 3 })).rejects.toThrow(
        "memory must be a concise structured summary",
      );
    },
  );

  it.each([
    {
      label: "unlabeled verbatim owner chat",
      summary: "今晚请陪我去西边森林寻找那棵最高的橡树",
      source: { ownerText: "今晚请陪我去西边森林寻找那棵最高的橡树" },
    },
    {
      label: "unlabeled model reasoning",
      summary: "先检查背包再沿河向北移动可以降低迷路风险",
      source: { modelText: "先检查背包再沿河向北移动可以降低迷路风险" },
    },
    {
      label: "normalized near-copy",
      summary: "今晚请陪我去西边森林，寻找那棵最高的橡树！",
      source: { ownerText: "今晚请陪我去西边森林 寻找那棵最高的橡树" },
    },
  ])("rejects $label from current untrusted source text", ({ summary, source }) => {
    const store = new MemoryStore("unused-for-validation.json");

    expect(() =>
      store.validateCandidate({ category: "experience", summary, importance: 4 }, source),
    ).toThrow("memory overlaps current untrusted source text");
  });

  it("preserves a genuinely structured summary derived from owner text", () => {
    const store = new MemoryStore("unused-for-validation.json");

    expect(() =>
      store.validateCandidate(
        { category: "preference", summary: "玩家偏好山顶橡木住宅", importance: 4 },
        { ownerText: "我真的很喜欢住在山顶，而且建房时最爱使用橡木。" },
      ),
    ).not.toThrow();
  });

  it("keeps identifiers monotonic after a memory is forgotten", async () => {
    const store = new MemoryStore(await memoryPath());
    const first = await store.add({ category: "place", summary: "出生点", importance: 3 });
    const second = await store.add({ category: "project", summary: "橡木小屋", importance: 4 });

    await expect(store.forget(second.id)).resolves.toBe(true);
    const third = await store.add({ category: "promise", summary: "明天一起修桥", importance: 4 });

    expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);
  });

  it("reports a missing memory and clears all saved memories", async () => {
    const store = new MemoryStore(await memoryPath());
    await store.add({ category: "place", summary: "出生点", importance: 3 });

    await expect(store.forget(999)).resolves.toBe(false);
    await store.clear();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("returns records that cannot mutate persisted memory", async () => {
    const path = await memoryPath();
    const store = new MemoryStore(path);
    const saved = await store.add({ category: "preference", summary: "喜欢橡木", importance: 4 });
    saved.summary = "不应保存";

    await expect(new MemoryStore(path).list()).resolves.toMatchObject([{ summary: "喜欢橡木" }]);
  });

  it("writes atomically without leaving a temporary file", async () => {
    const path = await memoryPath();
    const store = new MemoryStore(path);
    await store.add({ category: "place", summary: "矿井入口", importance: 3 });

    await expect(readdir(join(path, ".."))).resolves.not.toContain("memories.json.tmp");
  });

  it("surfaces corrupt memory JSON instead of treating it as an empty store", async () => {
    const path = await memoryPath();
    await writeFile(path, "{not valid json", "utf8");

    await expect(new MemoryStore(path).list()).rejects.toThrow(SyntaxError);
  });

  it("rejects a valid JSON file containing an invalid memory record", async () => {
    const path = await memoryPath();
    await writeFile(
      path,
      JSON.stringify([
        {
          id: "1",
          category: "preference",
          summary: "safe-looking but malformed",
          importance: 4,
          createdAt: "not-a-date",
          chat: "raw transcript",
        },
      ]),
      "utf8",
    );

    await expect(new MemoryStore(path).list()).rejects.toThrow("memory record is invalid");
  });

  it("serializes concurrent adds from separate instances with unique monotonic IDs", async () => {
    const path = await memoryPath();
    const records = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        new MemoryStore(path).add({
          category: "experience",
          summary: `completed safe task ${index}`,
          importance: 3,
        }),
      ),
    );

    expect(records.map((record) => record.id).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    await expect(new MemoryStore(path).list()).resolves.toHaveLength(20);
  });

  it("rejects a next-id sidecar with trailing junk", async () => {
    const path = await memoryPath();
    await writeFile(`${path}.next-id`, "1junk\n", "utf8");

    await expect(
      new MemoryStore(path).add({ category: "preference", summary: "safe summary", importance: 3 }),
    ).rejects.toThrow("memory next-id file is invalid");
  });
});
