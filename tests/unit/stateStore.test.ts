import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../src/memory/stateStore.js";

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "whitelily-state-"));
  return join(directory, "state.json");
}

describe("StateStore", () => {
  it("returns the safe initial state when its file is missing", async () => {
    const store = new StateStore(await statePath());

    await expect(store.load()).resolves.toEqual({
      lastMode: "friend",
      paused: false,
      unfinishedTaskSummary: null,
    });
  });

  it("persists only a compact unfinished-task summary", async () => {
    const path = await statePath();
    const store = new StateStore(path);
    await store.save({
      lastMode: "autonomous",
      paused: true,
      unfinishedTaskSummary: "收集橡木，尚缺 6 个",
    });

    await expect(new StateStore(path).load()).resolves.toMatchObject({
      lastMode: "autonomous",
      paused: true,
      unfinishedTaskSummary: "收集橡木，尚缺 6 个",
      updatedAt: expect.any(String),
    });
  });

  it("returns state copies that cannot mutate persisted state", async () => {
    const path = await statePath();
    const store = new StateStore(path);
    await store.save({ lastMode: "balanced", paused: false, unfinishedTaskSummary: "修桥" });
    const loaded = await store.load();
    loaded.paused = true;

    await expect(new StateStore(path).load()).resolves.toMatchObject({ paused: false });
  });

  it("writes atomically without leaving a temporary file", async () => {
    const path = await statePath();
    await new StateStore(path).save({
      lastMode: "friend",
      paused: false,
      unfinishedTaskSummary: null,
    });

    await expect(readdir(join(path, ".."))).resolves.not.toContain("state.json.tmp");
  });

  it("surfaces corrupt state JSON instead of silently returning defaults", async () => {
    const path = await statePath();
    await writeFile(path, "{not valid json", "utf8");

    await expect(new StateStore(path).load()).rejects.toThrow(SyntaxError);
  });

  it("persists only the state whitelist when runtime input has chat fields", async () => {
    const path = await statePath();
    await new StateStore(path).save({
      lastMode: "balanced",
      paused: false,
      unfinishedTaskSummary: "repair bridge",
      chat: "raw chat transcript",
      message: "raw message",
      reasoning: "long reasoning",
    } as never);

    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      lastMode: "balanced",
      paused: false,
      unfinishedTaskSummary: "repair bridge",
      updatedAt: expect.any(String),
    });
    expect(stored).not.toHaveProperty("chat");
    expect(stored).not.toHaveProperty("message");
    expect(stored).not.toHaveProperty("reasoning");
  });

  it.each([
    { lastMode: "unsafe", paused: false, unfinishedTaskSummary: null },
    { lastMode: "friend", paused: "false", unfinishedTaskSummary: null },
    { lastMode: "friend", paused: false, unfinishedTaskSummary: 7 },
    { lastMode: "friend", paused: false, unfinishedTaskSummary: null, updatedAt: 7 },
    { lastMode: "friend", paused: false, unfinishedTaskSummary: null, chat: "raw transcript" },
  ])("rejects a tampered state shape: %j", async (state) => {
    const path = await statePath();
    await writeFile(path, JSON.stringify(state), "utf8");

    await expect(new StateStore(path).load()).rejects.toThrow("persistent state is invalid");
  });

  it("serializes concurrent saves without corrupting state", async () => {
    const path = await statePath();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        new StateStore(path).save({
          lastMode: index % 2 === 0 ? "friend" : "balanced",
          paused: index % 3 === 0,
          unfinishedTaskSummary: `task ${index}`,
        }),
      ),
    );

    await expect(new StateStore(path).load()).resolves.toMatchObject({
      updatedAt: expect.any(String),
    });
  });
});
