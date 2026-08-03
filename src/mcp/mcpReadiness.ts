import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type McpReadinessErrorCode =
  | "connection_failed"
  | "timeout"
  | "aborted"
  | "missing_tools"
  | "extra_tools"
  | "duplicate_tools"
  | "invalid_tool_name";

export interface McpReadinessSnapshot {
  readonly state: "ready" | "failed";
  readonly listening: boolean;
  readonly discoveredToolCount: number;
  readonly errorCode: McpReadinessErrorCode | null;
}

interface VerifyMinecraftMcpOptions {
  readonly url: string;
  readonly expectedToolNames: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

function failed(
  errorCode: McpReadinessErrorCode,
  listening: boolean,
  discoveredToolCount = 0,
): McpReadinessSnapshot {
  return { state: "failed", listening, discoveredToolCount, errorCode };
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function catalogFailure(
  discoveredNames: readonly string[],
  expectedNames: readonly string[],
): McpReadinessErrorCode | null {
  const discovered = [...discoveredNames].sort(compareOrdinal);
  const expected = [...expectedNames].sort(compareOrdinal);
  if (new Set(discovered).size !== discovered.length) return "duplicate_tools";
  if (discovered.some((name) => !name.startsWith("minecraft_"))) return "invalid_tool_name";
  const discoveredSet = new Set(discovered);
  const expectedSet = new Set(expected);
  if (expected.some((name) => !discoveredSet.has(name))) return "missing_tools";
  if (discovered.some((name) => !expectedSet.has(name))) return "extra_tools";
  return null;
}

export async function verifyMinecraftMcp(
  options: VerifyMinecraftMcpOptions,
): Promise<McpReadinessSnapshot> {
  const controller = new AbortController();
  let abortCause: "timeout" | "external" | undefined = options.signal?.aborted
    ? "external"
    : undefined;
  let listening = false;
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;
  const onAbort = (): void => {
    if (abortCause !== undefined) return;
    abortCause = "external";
    controller.abort();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (abortCause === "external") controller.abort();
  const timeout = setTimeout(
    () => {
      if (abortCause !== undefined) return;
      abortCause = "timeout";
      controller.abort();
    },
    Math.max(0, options.timeoutMs),
  );

  try {
    transport = new StreamableHTTPClientTransport(new URL(options.url));
    client = new Client({ name: "whitelily-mcp-readiness", version: "1.0.0" });
    // SDK 1.29 transport declarations conflict with exactOptionalPropertyTypes.
    // @ts-expect-error The runtime transport implements the Client Transport contract.
    await client.connect(transport, { signal: controller.signal });
    listening = true;
    const listed = await client.listTools(undefined, { signal: controller.signal });
    const names = listed.tools.map((tool) => tool.name);
    const errorCode = catalogFailure(names, options.expectedToolNames);
    if (errorCode !== null) return failed(errorCode, true, names.length);
    return {
      state: "ready",
      listening: true,
      discoveredToolCount: names.length,
      errorCode: null,
    };
  } catch {
    if (abortCause === "external") return failed("aborted", listening);
    if (abortCause === "timeout") return failed("timeout", listening);
    return failed("connection_failed", listening);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    if (client !== undefined) await Promise.allSettled([client.close()]);
    if (transport !== undefined) await Promise.allSettled([transport.close()]);
  }
}
