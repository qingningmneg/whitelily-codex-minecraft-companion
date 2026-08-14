import * as z from "zod/v4";
import {
  createToolRegistry,
  MINECRAFT_TOOL_NAMES,
  type MinecraftToolName,
  type ToolDefinition,
  type ToolRegistryDependencies,
} from "../mcp/toolRegistry.js";
import type { JsonValue } from "./generated/serde_json/JsonValue.js";
import type { DynamicToolCallParams } from "./generated/v2/DynamicToolCallParams.js";
import type { DynamicToolCallResponse } from "./generated/v2/DynamicToolCallResponse.js";
import type { DynamicToolSpec } from "./generated/v2/DynamicToolSpec.js";

export interface MinecraftDynamicTools {
  readonly specs: readonly DynamicToolSpec[];
  call(params: DynamicToolCallParams): Promise<DynamicToolCallResponse>;
}

function failure(message: string): DynamicToolCallResponse {
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify({ error: message }) }],
    success: false,
  };
}

function isMinecraftToolName(value: string): value is MinecraftToolName {
  return (MINECRAFT_TOOL_NAMES as readonly string[]).includes(value);
}

export function createMinecraftDynamicTools(
  dependencies: ToolRegistryDependencies,
): MinecraftDynamicTools {
  const registry = createToolRegistry(dependencies) as unknown as Record<
    MinecraftToolName,
    ToolDefinition<unknown>
  >;
  const specs = Object.freeze(
    MINECRAFT_TOOL_NAMES.map((name): DynamicToolSpec => {
      const tool = registry[name];
      return Object.freeze({
        type: "function" as const,
        name,
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.schema) as unknown as JsonValue,
        deferLoading: false,
      });
    }),
  );

  return Object.freeze({
    specs,
    async call(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
      if (params.namespace !== null || !isMinecraftToolName(params.tool)) {
        return failure("Minecraft tool is unavailable");
      }
      const tool = registry[params.tool];
      const parsed = tool.schema.safeParse(params.arguments);
      if (!parsed.success) return failure("invalid Minecraft tool arguments");
      try {
        const result = await tool.execute(parsed.data);
        return {
          contentItems: [{ type: "inputText", text: result.text }],
          success: result.isError !== true,
        };
      } catch {
        return failure("Minecraft tool execution failed");
      }
    },
  });
}
