import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { request } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { WorldSnapshot } from "../../src/domain/types.js";
import { startMcpServer, type RunningMcpServer } from "../../src/mcp/mcpServer.js";
import { createToolRegistryHarness } from "../support/toolRegistryHarness.js";

interface RawResponse {
  status: number;
  body: string;
}

async function connectClient(
  client: Client,
  transport: StreamableHTTPClientTransport,
): Promise<void> {
  // @ts-expect-error SDK 1.29 transport declaration is incompatible with exactOptionalPropertyTypes
  await client.connect(transport);
}

function rawPost(
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const target = new URL(url);
    const call = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    call.once("error", reject);
    call.end(payload);
  });
}

function rawHttp(port: number, requestText: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.end(requestText));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      const response = Buffer.concat(chunks).toString("utf8");
      const [head, body = ""] = response.split("\r\n\r\n", 2);
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head ?? "")?.[1] ?? 0);
      resolve({ status, body });
    });
  });
}

function beginSlowJsonPost(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.once("connect", () => {
      const partialBody = '{"jsonrpc":"2.0"';
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 4096\r\nConnection: keep-alive\r\n\r\n${partialBody}`,
      );
      resolve(socket);
    });
  });
}

describe("loopback MCP server", () => {
  const running: RunningMcpServer[] = [];

  afterEach(async () => {
    await Promise.all(running.splice(0).map((server) => server.stop()));
  });

  it("serves the reviewed registry over a real stateless MCP client", async () => {
    const harness = createToolRegistryHarness();
    const server = await startMcpServer({
      host: "127.0.0.1",
      port: 0,
      dependencies: harness.dependencies,
    });
    running.push(server);
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    const client = new Client({ name: "test-client", version: "1.0.0" });
    try {
      await connectClient(client, transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("minecraft_get_state");

      const result = await client.callTool({
        name: "minecraft_say",
        arguments: { message: "/op WhiteLily", turnLease: harness.turnLease },
      });
      expect(result).toMatchObject({ isError: true });
      expect(harness.budget.snapshot().totalCalls).toBe(0);
      expect(harness.minecraft.chatLog).toEqual([]);
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("shares and replaces trusted snapshots across stateless MCP requests", async () => {
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
    const server = await startMcpServer({ host: "127.0.0.1", port: 0, dependencies });
    running.push(server);
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    const client = new Client({ name: "snapshot-client", version: "1.0.0" });
    try {
      await connectClient(client, transport);
      await client.callTool({
        name: "minecraft_get_state",
        arguments: { turnLease: harness.turnLease },
      });
      await expect(
        client.callTool({
          name: "minecraft_collect_dropped",
          arguments: { entityId: 7, turnLease: harness.turnLease },
        }),
      ).resolves.toMatchObject({
        content: [{ text: '{"status":"completed"}' }],
      });

      harness.minecraft.world.nearbyEntities = [];
      await client.callTool({
        name: "minecraft_get_state",
        arguments: { turnLease: harness.turnLease },
      });
      await expect(
        client.callTool({
          name: "minecraft_collect_dropped",
          arguments: { entityId: 7, turnLease: harness.turnLease },
        }),
      ).resolves.toMatchObject({ isError: true });
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("rejects hostile origin and host headers before MCP dispatch", async () => {
    const harness = createToolRegistryHarness();
    const server = await startMcpServer({
      host: "127.0.0.1",
      port: 0,
      dependencies: harness.dependencies,
    });
    running.push(server);

    const origin = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.invalid" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const host = await rawPost(server.url, { host: "evil.invalid" });
    const wrongPort = await rawPost(server.url, { host: "127.0.0.1:1" }, "x".repeat(65 * 1024));

    expect(origin.status).toBe(403);
    expect(host.status).toBe(403);
    expect(wrongPort.status).toBe(403);
    expect(harness.minecraft.calls).toEqual([]);
  });

  it("rejects malformed and oversized valid-host bodies without dispatching a tool", async () => {
    const harness = createToolRegistryHarness();
    const server = await startMcpServer({
      host: "127.0.0.1",
      port: 0,
      dependencies: harness.dependencies,
    });
    running.push(server);
    const host = `127.0.0.1:${server.port}`;

    const malformed = await rawPost(server.url, { host }, "{");
    const oversized = await rawPost(server.url, { host }, "x".repeat(65 * 1024));

    expect(malformed).toMatchObject({ status: 400, body: "invalid JSON" });
    expect(oversized).toMatchObject({ status: 413, body: "request too large" });
    expect(malformed.body + oversized.body).not.toMatch(/<html|stack|mcp/i);
    expect(harness.minecraft.calls).toEqual([]);
  });

  it("rejects repeated Host headers before parsing the body", async () => {
    const harness = createToolRegistryHarness();
    const server = await startMcpServer({
      host: "127.0.0.1",
      port: 0,
      dependencies: harness.dependencies,
    });
    running.push(server);
    const body = "x".repeat(65 * 1024);

    const response = await rawHttp(
      server.port,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nHost: evil.invalid\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );

    expect(response.status).toBe(403);
    expect(harness.minecraft.calls).toEqual([]);
  });

  it("stops idempotently and releases the bound port", async () => {
    const harness = createToolRegistryHarness();
    const server = await startMcpServer({
      host: "127.0.0.1",
      port: 0,
      dependencies: harness.dependencies,
    });

    await Promise.all([server.stop(), server.stop()]);
    const replacement = await startMcpServer({
      host: "127.0.0.1",
      port: server.port,
      dependencies: harness.dependencies,
    });
    await replacement.stop();
  });

  it("waits for an active stateless transport to close during stop", async () => {
    const harness = createToolRegistryHarness();
    let actionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      actionStarted = resolve;
    });
    harness.minecraft.wait = (_milliseconds, signal) =>
      new Promise<void>((_resolve, reject) => {
        actionStarted();
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    const server = await startMcpServer({
      host: "127.0.0.1",
      port: 0,
      dependencies: harness.dependencies,
    });
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    const client = new Client({ name: "test-client", version: "1.0.0" });
    try {
      await connectClient(client, transport);
      const inFlight = client.callTool({
        name: "minecraft_wait",
        arguments: { milliseconds: 10_000, turnLease: harness.turnLease },
      });
      void inFlight.catch(() => undefined);
      await started;

      await server.stop();
      const replacement = await startMcpServer({
        host: "127.0.0.1",
        port: server.port,
        dependencies: harness.dependencies,
      });
      await replacement.stop();
      harness.executor.stopAll();
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("drains a legal slow body during stop without late MCP dispatch", async () => {
    const harness = createToolRegistryHarness();
    const server = await startMcpServer({
      host: "127.0.0.1",
      port: 0,
      dependencies: harness.dependencies,
    });
    const slowSocket = await beginSlowJsonPost(server.port);
    try {
      await server.stop();
      const replacement = await startMcpServer({
        host: "127.0.0.1",
        port: server.port,
        dependencies: harness.dependencies,
      });
      await replacement.stop();
      expect(harness.minecraft.calls).toEqual([]);
    } finally {
      slowSocket.destroy();
    }
  });
});
