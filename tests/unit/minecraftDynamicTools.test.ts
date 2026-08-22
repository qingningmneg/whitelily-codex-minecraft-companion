import { describe, expect, it } from "vitest";
import { MINECRAFT_EXECUTION_TOOL_NAMES } from "../../src/mcp/toolRegistry.js";
import { createMinecraftDynamicTools } from "../../src/codex/minecraftDynamicTools.js";
import type { JsonValue } from "../../src/codex/generated/serde_json/JsonValue.js";
import type { DynamicToolCallParams } from "../../src/codex/generated/v2/DynamicToolCallParams.js";
import { createToolRegistryHarness } from "../support/toolRegistryHarness.js";

function callParams(
  tool: string,
  argumentsValue: JsonValue,
  namespace: string | null = null,
): DynamicToolCallParams {
  return {
    threadId: "thread-execution",
    turnId: "turn-1",
    callId: "call-1",
    namespace,
    tool,
    arguments: argumentsValue,
  };
}

describe("Minecraft dynamic tools", () => {
  it("exposes reads, chat, and bounded queue controls without direct physical actions", () => {
    const harness = createToolRegistryHarness();
    const dynamicTools = createMinecraftDynamicTools(harness.dependencies);

    expect(dynamicTools.specs.map((spec) => spec.name)).toEqual(MINECRAFT_EXECUTION_TOOL_NAMES);
    expect(dynamicTools.specs.map((spec) => spec.name)).toEqual(
      expect.arrayContaining([
        "minecraft_inspect_block",
        "minecraft_find_blocks",
        "minecraft_get_furnace_state",
      ]),
    );
    expect(dynamicTools.specs.map((spec) => spec.name)).not.toContain("minecraft_move_to");
    expect(dynamicTools.specs.map((spec) => spec.name)).not.toEqual(
      expect.arrayContaining(["minecraft_fish", "minecraft_till_soil", "minecraft_sleep_in_bed"]),
    );
    const enqueue = dynamicTools.specs.find(
      (spec) => spec.type === "function" && spec.name === "minecraft_enqueue_actions",
    );
    expect(enqueue).toMatchObject({
      type: "function",
      name: "minecraft_enqueue_actions",
      deferLoading: false,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["actions", "turnLease"],
      },
    });
  });

  it("executes a valid queue call through the safe tool registry", async () => {
    const harness = createToolRegistryHarness();
    const dynamicTools = createMinecraftDynamicTools(harness.dependencies);

    await expect(
      dynamicTools.call(
        callParams("minecraft_enqueue_actions", {
          actions: [{ kind: "jump", summary: "跳一下" }],
          turnLease: harness.turnLease,
        }),
      ),
    ).resolves.toMatchObject({ success: true });
    expect(harness.actionQueue.snapshot().items).toMatchObject([
      { kind: "jump", status: "waiting" },
    ]);
    expect(harness.budget.snapshot()).toMatchObject({ totalCalls: 1 });
  });

  it("executes bounded observation calls through the safe tool registry", async () => {
    const harness = createToolRegistryHarness();
    harness.minecraft.findBlocksResult = { blocks: [], truncated: false };
    const dynamicTools = createMinecraftDynamicTools(harness.dependencies);

    await expect(
      dynamicTools.call(
        callParams("minecraft_find_blocks", {
          tag: "water",
          maxDistance: 16,
          maxResults: 8,
          turnLease: harness.turnLease,
        }),
      ),
    ).resolves.toEqual({
      contentItems: [{ type: "inputText", text: '{"blocks":[],"truncated":false}' }],
      success: true,
    });
    expect(harness.minecraft.calls).toContainEqual({
      method: "findBlocks",
      args: [{ tag: "water", maxDistance: 16, maxResults: 8 }],
    });
  });

  it("rejects malformed arguments before they reach Minecraft", async () => {
    const harness = createToolRegistryHarness();
    const dynamicTools = createMinecraftDynamicTools(harness.dependencies);

    await expect(
      dynamicTools.call(
        callParams("minecraft_enqueue_actions", {
          actions: [{ kind: "jump", summary: "跳一下", unexpected: true }],
          turnLease: harness.turnLease,
        }),
      ),
    ).resolves.toEqual({
      contentItems: [{ type: "inputText", text: '{"error":"invalid Minecraft tool arguments"}' }],
      success: false,
    });
    expect(harness.minecraft.calls).toEqual([]);
    expect(harness.budget.snapshot()).toMatchObject({ totalCalls: 0 });
  });

  it("rejects unknown or namespaced calls without executing anything", async () => {
    const harness = createToolRegistryHarness();
    const dynamicTools = createMinecraftDynamicTools(harness.dependencies);

    const expected = {
      contentItems: [{ type: "inputText", text: '{"error":"Minecraft tool is unavailable"}' }],
      success: false,
    };
    await expect(dynamicTools.call(callParams("shell", {}))).resolves.toEqual(expected);
    await expect(
      dynamicTools.call(callParams("minecraft_enqueue_actions", {}, "mcp__minecraft")),
    ).resolves.toEqual(expected);
    await expect(
      dynamicTools.call(
        callParams("minecraft_move_to", { x: 1, y: 64, z: 1, turnLease: harness.turnLease }),
      ),
    ).resolves.toEqual(expected);
    expect(harness.minecraft.calls).toEqual([]);
  });
});
