import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyMinecraftMcp, type McpReadinessSnapshot } from "../../src/mcp/mcpReadiness.js";

const EXPECTED_TOOL_NAMES = [
  "minecraft_get_state",
  "minecraft_find_block",
  "minecraft_say",
  "minecraft_move_to",
  "minecraft_follow_owner",
  "minecraft_look_at",
  "minecraft_jump",
  "minecraft_dig_block",
  "minecraft_place_block",
  "minecraft_craft_item",
  "minecraft_smelt_item",
  "minecraft_collect_dropped",
  "minecraft_equip_item",
  "minecraft_attack_hostile",
  "minecraft_wait",
] as const;

interface EndpointOptions {
  readonly toolNames?: readonly string[];
  readonly failInitializeBody?: string;
  readonly hangOnList?: boolean;
  readonly onList?: () => void;
}

interface ScriptedEndpoint {
  readonly url: string;
  readonly methodCounts: ReadonlyMap<string, number>;
  stop(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("error", reject);
    request.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(response: ServerResponse, payload: unknown): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

async function startScriptedEndpoint(options: EndpointOptions = {}): Promise<ScriptedEndpoint> {
  const counts = new Map<string, number>();
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.statusCode = 405;
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const message = await readJson(request);
    const method = typeof message.method === "string" ? message.method : "unknown";
    counts.set(method, (counts.get(method) ?? 0) + 1);
    if (method === "notifications/initialized") {
      response.statusCode = 202;
      response.end();
      return;
    }
    if (method === "initialize") {
      if (options.failInitializeBody !== undefined) {
        response.statusCode = 500;
        response.setHeader("content-type", "text/plain");
        response.end(options.failInitializeBody);
        return;
      }
      const params = message.params as { protocolVersion?: unknown } | undefined;
      sendJson(response, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "readiness-fixture", version: "1.0.0" },
        },
      });
      return;
    }
    if (method === "tools/list") {
      options.onList?.();
      if (options.hangOnList === true) return;
      sendJson(response, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: (options.toolNames ?? EXPECTED_TOOL_NAMES).map((name) => ({
            name,
            description: "fixture tool",
            inputSchema: { type: "object" },
          })),
        },
      });
      return;
    }
    response.statusCode = 500;
    response.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not listen");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    methodCounts: counts,
    async stop(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

const endpoints: ScriptedEndpoint[] = [];

async function endpoint(options: EndpointOptions = {}): Promise<ScriptedEndpoint> {
  const value = await startScriptedEndpoint(options);
  endpoints.push(value);
  return value;
}

async function verify(
  value: ScriptedEndpoint,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<McpReadinessSnapshot> {
  const probe = {
    url: value.url,
    expectedToolNames: EXPECTED_TOOL_NAMES,
    timeoutMs: options.timeoutMs ?? 1_000,
  };
  return options.signal === undefined
    ? verifyMinecraftMcp(probe)
    : verifyMinecraftMcp({ ...probe, signal: options.signal });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(endpoints.splice(0).map((value) => value.stop()));
});

describe("Minecraft MCP readiness", () => {
  it("rejects every non-canonical endpoint before SDK connection or network I/O", async () => {
    const value = await endpoint();
    const port = new URL(value.url).port;
    const connect = vi.spyOn(Client.prototype, "connect");
    const invalidUrls = [
      "not-a-url",
      `https://127.0.0.1:${port}/mcp`,
      `http://localhost:${port}/mcp`,
      `http://[::1]:${port}/mcp`,
      `http://user:password@127.0.0.1:${port}/mcp`,
      `http://127.0.0.1:${port}/mcp?token=secret`,
      `http://127.0.0.1:${port}/mcp#fragment`,
      `http://127.0.0.1:${port}/other`,
      "http://127.0.0.1/mcp",
      "http://127.0.0.1:80/mcp",
      "http://127.0.0.1:0/mcp",
      "http://127.0.0.1:65536/mcp",
      `http://2130706433:${port}/mcp`,
      `http://127.0.0.1:0${port}/mcp`,
    ];

    for (const url of invalidUrls) {
      await expect(
        verifyMinecraftMcp({
          url,
          expectedToolNames: EXPECTED_TOOL_NAMES,
          timeoutMs: 1_000,
        }),
      ).resolves.toEqual({
        state: "failed",
        listening: false,
        discoveredToolCount: 0,
        errorCode: "invalid_url",
      });
    }
    expect(connect).not.toHaveBeenCalled();
    expect([...value.methodCounts.values()]).toEqual([]);
  });

  it("rejects invalid timeout boundaries before timers, SDK connection, or network I/O", async () => {
    const value = await endpoint();
    const connect = vi.spyOn(Client.prototype, "connect");
    const setTimeoutCall = vi.spyOn(globalThis, "setTimeout");
    const invalidTimeouts = [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      30_001,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
    ];

    for (const timeoutMs of invalidTimeouts) {
      await expect(
        verifyMinecraftMcp({
          url: value.url,
          expectedToolNames: EXPECTED_TOOL_NAMES,
          timeoutMs,
        }),
      ).resolves.toEqual({
        state: "failed",
        listening: false,
        discoveredToolCount: 0,
        errorCode: "invalid_timeout",
      });
    }
    expect(setTimeoutCall).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect([...value.methodCounts.values()]).toEqual([]);
  });

  it("accepts the documented 30-second local readiness timeout ceiling", async () => {
    const value = await endpoint();

    await expect(verify(value, { timeoutMs: 30_000 })).resolves.toMatchObject({
      state: "ready",
      errorCode: null,
    });
  });

  it("accepts exactly the expected Minecraft catalog without calling a tool", async () => {
    const value = await endpoint();

    await expect(verify(value)).resolves.toEqual({
      state: "ready",
      listening: true,
      discoveredToolCount: 15,
      errorCode: null,
    });
    expect(value.methodCounts.get("tools/list")).toBe(1);
    expect(value.methodCounts.get("tools/call") ?? 0).toBe(0);
  });

  it("rejects a catalog with one missing tool", async () => {
    const value = await endpoint({ toolNames: EXPECTED_TOOL_NAMES.slice(1) });

    await expect(verify(value)).resolves.toEqual({
      state: "failed",
      listening: true,
      discoveredToolCount: 14,
      errorCode: "missing_tools",
    });
  });

  it("rejects a catalog with one extra tool", async () => {
    const value = await endpoint({ toolNames: [...EXPECTED_TOOL_NAMES, "minecraft_unreviewed"] });

    await expect(verify(value)).resolves.toEqual({
      state: "failed",
      listening: true,
      discoveredToolCount: 16,
      errorCode: "extra_tools",
    });
  });

  it("rejects duplicate tool names", async () => {
    const value = await endpoint({
      toolNames: [...EXPECTED_TOOL_NAMES, "minecraft_get_state"],
    });

    await expect(verify(value)).resolves.toEqual({
      state: "failed",
      listening: true,
      discoveredToolCount: 16,
      errorCode: "duplicate_tools",
    });
  });

  it("rejects a non-Minecraft tool name before catalog comparison", async () => {
    const value = await endpoint({ toolNames: [...EXPECTED_TOOL_NAMES, "shell_execute"] });

    await expect(verify(value)).resolves.toEqual({
      state: "failed",
      listening: true,
      discoveredToolCount: 16,
      errorCode: "invalid_tool_name",
    });
  });

  it("redacts connection response bodies into a local error code", async () => {
    const value = await endpoint({ failInitializeBody: "server-secret-body" });
    const clientClose = vi.spyOn(Client.prototype, "close");
    const transportClose = vi.spyOn(StreamableHTTPClientTransport.prototype, "close");

    const result = await verifyMinecraftMcp({
      url: value.url,
      expectedToolNames: EXPECTED_TOOL_NAMES,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      state: "failed",
      listening: false,
      discoveredToolCount: 0,
      errorCode: "connection_failed",
    });
    expect(JSON.stringify(result)).not.toContain("server-secret-body");
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(transportClose).toHaveBeenCalledTimes(1);
  });

  it("times out a connected server that does not return tools", async () => {
    const value = await endpoint({ hangOnList: true });

    await expect(verify(value, { timeoutMs: 50 })).resolves.toEqual({
      state: "failed",
      listening: true,
      discoveredToolCount: 0,
      errorCode: "timeout",
    });
  });

  it("honors an external abort while listing tools", async () => {
    let listStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      listStarted = resolve;
    });
    const value = await endpoint({ hangOnList: true, onList: listStarted });
    const controller = new AbortController();
    const pending = verify(value, { signal: controller.signal });
    await started;

    controller.abort();

    await expect(pending).resolves.toEqual({
      state: "failed",
      listening: true,
      discoveredToolCount: 0,
      errorCode: "aborted",
    });
  });

  it("keeps the first timeout cause when an external abort follows in the same turn", async () => {
    let listStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      listStarted = resolve;
    });
    const value = await endpoint({ hangOnList: true, onList: listStarted });
    const controller = new AbortController();
    vi.useFakeTimers();
    const pending = verify(value, { timeoutMs: 50, signal: controller.signal });
    await started;

    vi.advanceTimersByTime(50);
    controller.abort();

    await expect(pending).resolves.toMatchObject({ errorCode: "timeout" });
  });

  it("closes both independently created SDK resources after probing", async () => {
    const clientClose = vi.spyOn(Client.prototype, "close");
    const transportClose = vi.spyOn(StreamableHTTPClientTransport.prototype, "close");
    const value = await endpoint();

    await verify(value);

    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(transportClose).toHaveBeenCalledTimes(1);
  });

  it("contains a client cleanup rejection without changing a ready snapshot", async () => {
    const clientClose = vi
      .spyOn(Client.prototype, "close")
      .mockRejectedValue(new Error("cleanup-secret"));
    const transportClose = vi.spyOn(StreamableHTTPClientTransport.prototype, "close");
    const value = await endpoint();

    await expect(verify(value)).resolves.toEqual({
      state: "ready",
      listening: true,
      discoveredToolCount: 15,
      errorCode: null,
    });
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(transportClose).not.toHaveBeenCalled();
  });

  it("contains cleanup rejection without replacing the first timeout cause", async () => {
    const clientClose = vi
      .spyOn(Client.prototype, "close")
      .mockRejectedValue(new Error("cleanup-secret"));
    const transportClose = vi.spyOn(StreamableHTTPClientTransport.prototype, "close");
    const value = await endpoint({ hangOnList: true });

    await expect(verify(value, { timeoutMs: 50 })).resolves.toMatchObject({
      state: "failed",
      errorCode: "timeout",
    });
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(transportClose).not.toHaveBeenCalled();
  });
});
