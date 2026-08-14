import { describe, expect, it } from "vitest";
import { MINECRAFT_TOOL_NAMES } from "../../src/mcp/toolRegistry.js";
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
  it("exposes every reviewed Minecraft action as a non-deferred top-level function", () => {
    const harness = createToolRegistryHarness();
    const dynamicTools = createMinecraftDynamicTools(harness.dependencies);

    expect(dynamicTools.specs.map((spec) => spec.name)).toEqual(MINECRAFT_TOOL_NAMES);
    const followOwner = dynamicTools.specs.find(
      (spec) => spec.type === "function" && spec.name === "minecraft_follow_owner",
    );
    expect(followOwner).toMatchObject({
      type: "function",
      name: "minecraft_follow_owner",
      deferLoading: false,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["distance", "turnLease"],
        properties: {
          distance: { type: "integer", minimum: 2, maximum: 16 },
          turnLease: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
        },
      },
    });
  });

  it("executes a valid call through the existing safe tool registry", async () => {
    const harness = createToolRegistryHarness();
    harness.minecraft.world.ownerPosition = { x: 4, y: 64, z: 3 };
    const dynamicTools = createMinecraftDynamicTools(harness.dependencies);

    await expect(
      dynamicTools.call(
        callParams("minecraft_follow_owner", { distance: 3, turnLease: harness.turnLease }),
      ),
    ).resolves.toEqual({
      contentItems: [{ type: "inputText", text: '{"status":"completed"}' }],
      success: true,
    });
    expect(harness.minecraft.calls).toContainEqual({
      method: "followOwner",
      args: ["TestOwner", 3],
    });
    expect(harness.budget.snapshot()).toMatchObject({ totalCalls: 1 });
  });

  it("rejects malformed arguments before they reach Minecraft", async () => {
    const harness = createToolRegistryHarness();
    const dynamicTools = createMinecraftDynamicTools(harness.dependencies);

    await expect(
      dynamicTools.call(
        callParams("minecraft_follow_owner", {
          distance: 1,
          turnLease: harness.turnLease,
          unexpected: true,
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
      dynamicTools.call(callParams("minecraft_follow_owner", {}, "mcp__minecraft")),
    ).resolves.toEqual(expected);
    expect(harness.minecraft.calls).toEqual([]);
  });
});
