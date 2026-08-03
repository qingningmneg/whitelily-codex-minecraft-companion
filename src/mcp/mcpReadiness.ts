import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type McpReadinessErrorCode =
  | "invalid_url"
  | "invalid_timeout"
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

// A loopback readiness check must either complete or fail within 30 seconds.
const MAX_LOCAL_READINESS_TIMEOUT_MS = 30_000;

class ReadinessClient extends Client {
  #closePromise: Promise<void> | undefined;

  override close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closePromise = super.close();
      void this.#closePromise.catch(() => undefined);
    }
    return this.#closePromise;
  }
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

function localMcpEndpoint(rawUrl: string): URL | undefined {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/mcp$/.exec(rawUrl);
  if (match === null) return undefined;
  const port = Number(match[1]);
  if (!Number.isSafeInteger(port) || port > 65_535 || port === 80) return undefined;
  return new URL(rawUrl);
}

async function containCleanup(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // Readiness cleanup is best effort and must not replace the probe result.
  }
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
  const endpoint = localMcpEndpoint(options.url);
  if (endpoint === undefined) return failed("invalid_url", false);
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_LOCAL_READINESS_TIMEOUT_MS
  ) {
    return failed("invalid_timeout", false);
  }
  const controller = new AbortController();
  let abortCause: "timeout" | "external" | undefined = options.signal?.aborted
    ? "external"
    : undefined;
  let listening = false;
  let client: ReadinessClient | undefined;
  let transport: StreamableHTTPClientTransport | undefined;
  const onAbort = (): void => {
    if (abortCause !== undefined) return;
    abortCause = "external";
    controller.abort();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (abortCause === "external") controller.abort();
  const timeout = setTimeout(() => {
    if (abortCause !== undefined) return;
    abortCause = "timeout";
    controller.abort();
  }, options.timeoutMs);

  try {
    transport = new StreamableHTTPClientTransport(endpoint);
    client = new ReadinessClient({ name: "whitelily-mcp-readiness", version: "1.0.0" });
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
    const ownedClient = client;
    const unownedTransport = transport;
    if (ownedClient !== undefined) await containCleanup(() => ownedClient.close());
    else if (unownedTransport !== undefined) await containCleanup(() => unownedTransport.close());
  }
}
