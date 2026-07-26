import { describe, expect, it, vi } from "vitest";
import { FakeMinecraftPort } from "../../src/minecraft/fakeMinecraftPort.js";

describe("FakeMinecraftPort", () => {
  it("delivers events, supports unsubscribe, and records ordinary chat", async () => {
    const port = new FakeMinecraftPort();
    const listener = vi.fn();
    const unsubscribe = port.onEvent(listener);

    port.emit({ kind: "chat", username: "TestOwner", message: "你好" });
    unsubscribe();
    port.emit({ kind: "death" });
    await port.say("你好呀");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      kind: "chat",
      username: "TestOwner",
      message: "你好",
    });
    expect(port.chatLog).toEqual(["你好呀"]);
  });

  it("deep clones snapshots and never records an already-aborted operation", async () => {
    const port = new FakeMinecraftPort();
    const signal = AbortSignal.abort();
    const snapshot = await port.snapshot("TestOwner");
    snapshot.botPosition.x = 99;

    await expect(port.moveTo({ x: 1, y: 64, z: 1 }, signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(port.world.botPosition.x).toBe(0);
    expect(port.calls).toEqual([]);
  });

  it("exposes whether the owner is online without waiting", async () => {
    const port = new FakeMinecraftPort();
    port.ownerOnline = true;

    await expect(port.isOwnerOnline("TestOwner")).resolves.toBe(true);
  });

  it("implements every port command in memory and records each non-chat call", async () => {
    const port = new FakeMinecraftPort();
    const signal = new AbortController().signal;
    const position = { x: 1, y: 64, z: 2 };

    await port.connect();
    await port.disconnect();
    await port.findBlock("stone", 4);
    await port.moveTo(position, signal);
    await port.followOwner("TestOwner", 2, signal);
    await port.lookAt(position, signal);
    await port.jump(signal);
    await port.digBlock(position, "stone", signal);
    await port.placeBlock(position, "stone", signal);
    await port.craftItem("stick", 2, signal);
    await port.smeltItem("iron_ore", 1, signal);
    await port.collectDropped(5, signal);
    await port.equipItem("stick", "hand", signal);
    await port.attackHostile(6, signal);
    await port.wait(60_000, signal);

    expect(port.calls.map((call) => call.method)).toEqual([
      "connect",
      "disconnect",
      "findBlock",
      "moveTo",
      "followOwner",
      "lookAt",
      "jump",
      "digBlock",
      "placeBlock",
      "craftItem",
      "smeltItem",
      "collectDropped",
      "equipItem",
      "attackHostile",
      "wait",
    ]);
  });
});
