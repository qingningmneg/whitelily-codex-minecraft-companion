import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../../src/mcp/toolRegistry.js";
import type { ActionSafety } from "../../src/actions/actionExecutor.js";
import type { WorldSnapshot } from "../../src/domain/types.js";
import { createToolRegistryHarness } from "../support/toolRegistryHarness.js";

function leased<T extends Record<string, unknown> = Record<never, never>>(
  harness: ReturnType<typeof createToolRegistryHarness>,
  input?: T,
): T & { turnLease: string } {
  return { ...input, turnLease: harness.turnLease } as T & { turnLease: string };
}

describe("Minecraft MCP tools", () => {
  it("exports only the reviewed allowlist", () => {
    const harness = createToolRegistryHarness();
    expect(Object.keys(createToolRegistry(harness.dependencies)).sort()).toEqual([
      "minecraft_attack_hostile",
      "minecraft_collect_dropped",
      "minecraft_craft_item",
      "minecraft_dig_block",
      "minecraft_equip_item",
      "minecraft_find_block",
      "minecraft_follow_owner",
      "minecraft_get_state",
      "minecraft_jump",
      "minecraft_look_at",
      "minecraft_move_to",
      "minecraft_place_block",
      "minecraft_say",
      "minecraft_smelt_item",
      "minecraft_wait",
    ]);
  });

  it("does not expose generic shell, script, command, or arbitrary entity attack tools", () => {
    const harness = createToolRegistryHarness();
    const names = Object.keys(createToolRegistry(harness.dependencies)).join(" ");
    expect(names).not.toMatch(/shell|script|javascript|command|attack_entity|use_held_item/);
  });

  it("consumes before safety context or Minecraft reads and reports unavailable turn as an error", async () => {
    const harness = createToolRegistryHarness({ begun: false });
    const result = await createToolRegistry(harness.dependencies).minecraft_get_state.execute(
      leased(harness),
    );

    expect(result).toMatchObject({ isError: true });
    expect(harness.minecraft.calls).toEqual([]);
  });

  it("rejects command-like chat before it reaches Minecraft", async () => {
    const harness = createToolRegistryHarness();
    const tool = createToolRegistry(harness.dependencies).minecraft_say;

    expect(() => tool.schema.parse(leased(harness, { message: "  /op WhiteLily" }))).toThrow();
    expect(() => tool.schema.parse(leased(harness, { message: "hello\nthere" }))).toThrow();
    expect(tool.schema.parse(leased(harness, { message: "a".repeat(240) }))).toEqual(
      leased(harness, { message: "a".repeat(240) }),
    );
    expect(() => tool.schema.parse(leased(harness, { message: "a".repeat(241) }))).toThrow();
    expect(harness.minecraft.chatLog).toEqual([]);
  });

  it("keeps every schema strict and applies every bounded scalar boundary", () => {
    const harness = createToolRegistryHarness();
    const tools = createToolRegistry(harness.dependencies);
    const strictSchemas: Array<{
      schema: { safeParse(input: unknown): { success: boolean } };
      input: Record<string, unknown>;
    }> = [
      { schema: tools.minecraft_get_state.schema, input: leased(harness) },
      {
        schema: tools.minecraft_find_block.schema,
        input: leased(harness, { blockName: "stone", maxDistance: 1 }),
      },
      { schema: tools.minecraft_say.schema, input: leased(harness, { message: "safe" }) },
      {
        schema: tools.minecraft_move_to.schema,
        input: leased(harness, { x: 1, y: 2, z: 3 }),
      },
      {
        schema: tools.minecraft_follow_owner.schema,
        input: leased(harness, { distance: 2 }),
      },
      {
        schema: tools.minecraft_look_at.schema,
        input: leased(harness, { x: 1, y: 2, z: 3 }),
      },
      { schema: tools.minecraft_jump.schema, input: leased(harness) },
      {
        schema: tools.minecraft_dig_block.schema,
        input: leased(harness, { x: 1, y: 2, z: 3, blockName: "stone" }),
      },
      {
        schema: tools.minecraft_place_block.schema,
        input: leased(harness, { x: 1, y: 2, z: 3, blockName: "stone" }),
      },
      {
        schema: tools.minecraft_craft_item.schema,
        input: leased(harness, { itemName: "stick", count: 1 }),
      },
      {
        schema: tools.minecraft_smelt_item.schema,
        input: leased(harness, { itemName: "iron_ore", count: 1 }),
      },
      {
        schema: tools.minecraft_collect_dropped.schema,
        input: leased(harness, { entityId: 1 }),
      },
      {
        schema: tools.minecraft_equip_item.schema,
        input: leased(harness, { itemName: "stick", destination: "hand" }),
      },
      {
        schema: tools.minecraft_attack_hostile.schema,
        input: leased(harness, { entityId: 1 }),
      },
      {
        schema: tools.minecraft_wait.schema,
        input: leased(harness, { milliseconds: 100 }),
      },
    ];
    for (const { schema, input } of strictSchemas) {
      expect(schema.safeParse({ ...input, unexpected: true }).success).toBe(false);
    }
    expect(() =>
      tools.minecraft_move_to.schema.parse(leased(harness, { x: Infinity, y: 64, z: 0 })),
    ).toThrow();
    expect(() =>
      tools.minecraft_dig_block.schema.parse(
        leased(harness, { x: 1, y: 2, z: 3, blockName: "Stone" }),
      ),
    ).toThrow();
    expect(() =>
      tools.minecraft_dig_block.schema.parse(
        leased(harness, { x: 1, y: 2, z: 3, blockName: "a".repeat(65) }),
      ),
    ).toThrow();
    expect(() =>
      tools.minecraft_craft_item.schema.parse(leased(harness, { itemName: "stick", count: 0 })),
    ).toThrow();
    expect(() =>
      tools.minecraft_craft_item.schema.parse(leased(harness, { itemName: "stick", count: 65 })),
    ).toThrow();
    expect(() =>
      tools.minecraft_collect_dropped.schema.parse(leased(harness, { entityId: 0 })),
    ).toThrow();
    expect(() =>
      tools.minecraft_attack_hostile.schema.parse(
        leased(harness, { entityId: Number.MAX_SAFE_INTEGER + 1 }),
      ),
    ).toThrow();
    expect(tools.minecraft_follow_owner.schema.parse(leased(harness, { distance: 2 }))).toEqual(
      leased(harness, { distance: 2 }),
    );
    expect(tools.minecraft_follow_owner.schema.parse(leased(harness, { distance: 16 }))).toEqual(
      leased(harness, { distance: 16 }),
    );
    expect(() =>
      tools.minecraft_follow_owner.schema.parse(leased(harness, { distance: 1 })),
    ).toThrow();
    expect(
      tools.minecraft_find_block.schema.parse(
        leased(harness, { blockName: "minecraft:stone", maxDistance: 64 }),
      ),
    ).toEqual(leased(harness, { blockName: "minecraft:stone", maxDistance: 64 }));
    expect(() =>
      tools.minecraft_find_block.schema.parse(
        leased(harness, { blockName: "stone", maxDistance: 65 }),
      ),
    ).toThrow();
    expect(tools.minecraft_wait.schema.parse(leased(harness, { milliseconds: 100 }))).toEqual(
      leased(harness, { milliseconds: 100 }),
    );
    expect(tools.minecraft_wait.schema.parse(leased(harness, { milliseconds: 10_000 }))).toEqual(
      leased(harness, { milliseconds: 10_000 }),
    );
    expect(() =>
      tools.minecraft_wait.schema.parse(leased(harness, { milliseconds: 99 })),
    ).toThrow();
    expect(() =>
      tools.minecraft_equip_item.schema.parse(
        leased(harness, { itemName: "iron_helmet", destination: "belt" }),
      ),
    ).toThrow();
    expect(() =>
      tools.minecraft_say.schema.parse(leased(harness, { message: "safe", extra: true })),
    ).toThrow();
    expect(() => tools.minecraft_say.schema.parse({ message: "safe" })).toThrow();
    expect(() =>
      tools.minecraft_say.schema.parse({ message: "safe", turnLease: "short" }),
    ).toThrow();
  });

  it("returns structured errors for a failed safety context without touching Minecraft", async () => {
    const harness = createToolRegistryHarness();
    const dependencies = {
      ...harness.dependencies,
      safetyContextProvider: async () => {
        throw new Error("context unavailable");
      },
    };

    await expect(
      createToolRegistry(dependencies).minecraft_say.execute(leased(harness, { message: "safe" })),
    ).resolves.toEqual({
      text: '{"error":"context unavailable"}',
      isError: true,
    });
    expect(harness.minecraft.chatLog).toEqual([]);
  });

  it("does not touch Minecraft before begin or after end", async () => {
    const harness = createToolRegistryHarness({ begun: false });
    harness.minecraft.snapshot = async () => {
      harness.minecraft.calls.push({ method: "snapshot", args: [] });
      return harness.minecraft.world;
    };
    const tools = createToolRegistry(harness.dependencies);

    await expect(tools.minecraft_get_state.execute(leased(harness))).resolves.toMatchObject({
      isError: true,
    });
    harness.beginTurn();
    harness.budget.end();
    await expect(tools.minecraft_get_state.execute(leased(harness))).resolves.toMatchObject({
      isError: true,
    });
    expect(harness.minecraft.calls).toEqual([]);
  });

  it("feeds cumulative edits only to their matching action", async () => {
    const harness = createToolRegistryHarness();
    const tools = createToolRegistry(harness.dependencies);
    for (let call = 0; call < 33; call += 1) {
      await tools.minecraft_dig_block.execute(
        leased(harness, { x: 20, y: 64, z: 0, blockName: "stone" }),
      );
    }
    const say = await tools.minecraft_say.execute(leased(harness, { message: "still safe" }));

    expect(say).toEqual({ text: '{"status":"completed"}' });
    expect(harness.minecraft.chatLog).toEqual(["still safe"]);
  });

  it("derives travel from the trusted snapshot and adds it before safety evaluation", async () => {
    const harness = createToolRegistryHarness();
    const result = await createToolRegistry(harness.dependencies).minecraft_move_to.execute(
      leased(harness, {
        x: 300,
        y: 64,
        z: 0,
      }),
    );

    expect(result).toEqual({ text: '{"status":"completed"}' });
    expect(harness.budget.snapshot().cumulativeHorizontalTravel).toBe(300);
    expect(harness.contexts.at(-1)).toMatchObject({ estimatedTravelDistance: 300 });
  });

  it("reads a fresh actual position for each movement segment", async () => {
    const harness = createToolRegistryHarness();
    const snapshots = [
      { ...harness.minecraft.world, botPosition: { x: 0, y: 64, z: 0 } },
      { ...harness.minecraft.world, botPosition: { x: 100, y: 64, z: 0 } },
    ];
    harness.minecraft.snapshot = async () => {
      const snapshot = snapshots.shift();
      if (!snapshot) throw new Error("unexpected snapshot");
      return snapshot;
    };
    const tools = createToolRegistry(harness.dependencies);

    await tools.minecraft_move_to.execute(leased(harness, { x: 100, y: 64, z: 0 }));
    await tools.minecraft_move_to.execute(leased(harness, { x: 200, y: 64, z: 0 }));

    expect(harness.budget.snapshot().cumulativeHorizontalTravel).toBe(200);
    expect(harness.contexts.at(-1)).toMatchObject({ estimatedTravelDistance: 200 });
  });

  it("fails closed on an extreme trusted movement without calling moveTo", async () => {
    const safety: ActionSafety = {
      evaluate: (_action, context) =>
        context.estimatedTravelDistance === Infinity
          ? {
              kind: "confirm",
              reason: "far travel",
              confirmationId: 1,
              expiresAt: "2026-07-25T00:02:00.000Z",
            }
          : { kind: "allow" },
      evaluatePermanent: () => ({ kind: "allow" }),
    };
    const harness = createToolRegistryHarness({ safety });
    harness.minecraft.snapshot = async () => ({
      ...harness.minecraft.world,
      botPosition: { x: -Number.MAX_VALUE, y: 64, z: 0 },
    });

    await expect(
      createToolRegistry(harness.dependencies).minecraft_move_to.execute({
        x: Number.MAX_VALUE,
        y: 64,
        z: 0,
        turnLease: harness.turnLease,
      }),
    ).resolves.toMatchObject({
      isError: true,
      text: expect.stringContaining("confirmation_required"),
    });
    expect(harness.budget.snapshot().cumulativeHorizontalTravel).toBe(Infinity);
    expect(harness.minecraft.calls).not.toContainEqual(
      expect.objectContaining({ method: "moveTo" }),
    );
  });

  it("returns an error and saturates travel when the fresh snapshot fails", async () => {
    const harness = createToolRegistryHarness();
    harness.minecraft.snapshot = async () => {
      throw new Error("snapshot unavailable");
    };

    await expect(
      createToolRegistry(harness.dependencies).minecraft_move_to.execute(
        leased(harness, { x: 1, y: 64, z: 0 }),
      ),
    ).resolves.toEqual({ text: '{"error":"snapshot unavailable"}', isError: true });
    expect(harness.budget.snapshot().cumulativeHorizontalTravel).toBe(Infinity);
    expect(harness.minecraft.calls).not.toContainEqual(
      expect.objectContaining({ method: "moveTo" }),
    );
  });

  it("reports a cancelled game action as an MCP tool error", async () => {
    const harness = createToolRegistryHarness();
    harness.minecraft.jump = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    };

    await expect(
      createToolRegistry(harness.dependencies).minecraft_jump.execute(leased(harness)),
    ).resolves.toEqual({
      text: '{"status":"cancelled"}',
      isError: true,
    });
  });

  it("uses get_state as the bounded source for dropped-entity authorization", async () => {
    const harness = createToolRegistryHarness();
    harness.minecraft.world.nearbyEntities = [
      { id: 7, kind: "item", position: { x: 1, y: 64, z: 0 } },
    ];
    const dependencies = { ...harness.dependencies, latestSnapshot: () => undefined };
    const tools = createToolRegistry(dependencies);

    await expect(tools.minecraft_get_state.execute(leased(harness))).resolves.toEqual({
      text: expect.any(String),
    });
    await expect(
      tools.minecraft_collect_dropped.execute(leased(harness, { entityId: 7 })),
    ).resolves.toEqual({
      text: '{"status":"completed"}',
    });
    await expect(
      tools.minecraft_collect_dropped.execute(leased(harness, { entityId: 8 })),
    ).resolves.toMatchObject({
      isError: true,
    });
    expect(harness.minecraft.calls).toContainEqual({ method: "collectDropped", args: [7] });
  });

  it("publishes defensive snapshots across registries and replaces stale entity authorization", async () => {
    const harness = createToolRegistryHarness();
    let latest: WorldSnapshot | undefined;
    const dependencies = {
      ...harness.dependencies,
      latestSnapshot: () => (latest === undefined ? undefined : structuredClone(latest)),
      observeSnapshot: (snapshot: WorldSnapshot) => {
        latest = structuredClone(snapshot);
      },
    };
    harness.minecraft.world.nearbyEntities = [
      { id: 7, kind: "item", position: { x: 1, y: 64, z: 0 } },
    ];

    const earlierRegistry = createToolRegistry(dependencies);
    await earlierRegistry.minecraft_get_state.execute(leased(harness));
    harness.minecraft.world.nearbyEntities[0]!.id = 99;
    await expect(
      createToolRegistry(dependencies).minecraft_collect_dropped.execute(
        leased(harness, { entityId: 7 }),
      ),
    ).resolves.toEqual({ text: '{"status":"completed"}' });

    harness.minecraft.world.nearbyEntities = [];
    await createToolRegistry(dependencies).minecraft_get_state.execute(leased(harness));
    await expect(
      earlierRegistry.minecraft_collect_dropped.execute(leased(harness, { entityId: 7 })),
    ).resolves.toMatchObject({ isError: true });
  });

  it("does not replace the last trusted shared snapshot when a newer snapshot fails", async () => {
    const harness = createToolRegistryHarness();
    let latest: WorldSnapshot | undefined;
    const dependencies = {
      ...harness.dependencies,
      latestSnapshot: () => (latest === undefined ? undefined : structuredClone(latest)),
      observeSnapshot: (snapshot: WorldSnapshot) => {
        latest = structuredClone(snapshot);
      },
    };
    harness.minecraft.world.nearbyEntities = [
      { id: 7, kind: "item", position: { x: 1, y: 64, z: 0 } },
    ];
    await createToolRegistry(dependencies).minecraft_get_state.execute(leased(harness));
    harness.minecraft.snapshot = async () => {
      throw new Error("snapshot unavailable");
    };

    await expect(
      createToolRegistry(dependencies).minecraft_get_state.execute(leased(harness)),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      createToolRegistry(dependencies).minecraft_collect_dropped.execute(
        leased(harness, { entityId: 7 }),
      ),
    ).resolves.toEqual({ text: '{"status":"completed"}' });
  });

  it("defensively clones the shared snapshot at publish and read boundaries", async () => {
    const module = await import("../../src/mcp/toolRegistry.js");
    const createStore = (
      module as typeof module & {
        createTrustedSnapshotStore?: () => {
          publish(snapshot: WorldSnapshot): void;
          latest(): WorldSnapshot | undefined;
        };
      }
    ).createTrustedSnapshotStore;
    expect(createStore).toBeTypeOf("function");
    if (!createStore) throw new Error("missing trusted snapshot store");
    const store = createStore();
    const harness = createToolRegistryHarness();
    const published = structuredClone(harness.minecraft.world);
    published.nearbyEntities = [{ id: 7, kind: "item", position: { x: 1, y: 64, z: 0 } }];
    store.publish(published);
    published.nearbyEntities[0]!.id = 88;
    const first = store.latest()!;
    first.nearbyEntities![0]!.id = 99;

    expect(store.latest()?.nearbyEntities?.[0]?.id).toBe(7);
  });
});
