import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import express from "express";
import type { ErrorRequestHandler } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createToolRegistry, type ToolRegistryDependencies } from "./toolRegistry.js";

export interface StartMcpServerOptions {
  host: "127.0.0.1";
  port?: number;
  dependencies: ToolRegistryDependencies;
}

export interface RunningMcpServer {
  host: "127.0.0.1";
  port: number;
  url: string;
  closed: Promise<void>;
  stop(): Promise<void>;
}

interface ActiveRequest {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  close(): Promise<void>;
}

function createServerForRequest(dependencies: ToolRegistryDependencies): McpServer {
  const server = new McpServer({ name: "whitelily-minecraft", version: "0.1.1" });
  for (const [name, tool] of Object.entries(createToolRegistry(dependencies))) {
    server.registerTool(
      name,
      { description: tool.description, inputSchema: tool.schema },
      async (input: unknown) => {
        try {
          const result = await tool.execute(input as never);
          return {
            content: [{ type: "text" as const, text: result.text }],
            isError: result.isError ?? false,
          };
        } catch {
          return {
            content: [{ type: "text" as const, text: '{"error":"tool execution failed"}' }],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
        reject(error);
      else resolve();
    });
  });
}

export async function startMcpServer(options: StartMcpServerOptions): Promise<RunningMcpServer> {
  const { host, dependencies } = options;
  if (host !== "127.0.0.1") throw new Error("MCP server must bind to 127.0.0.1");

  const app = express();
  const active = new Set<ActiveRequest>();
  const sockets = new Set<Socket>();
  let port = 0;
  let isStopping = false;
  let stopping: Promise<void> | undefined;

  app.use((request, response, next) => {
    const expectedHost = `127.0.0.1:${port}`;
    const hostHeaders = request.rawHeaders.reduce<string[]>((hosts, value, index, rawHeaders) => {
      if (index % 2 === 0 && value.toLowerCase() === "host")
        hosts.push(rawHeaders[index + 1] ?? "");
      return hosts;
    }, []);
    if (
      request.headers.origin !== undefined ||
      hostHeaders.length !== 1 ||
      hostHeaders[0] !== expectedHost
    ) {
      response.status(403).type("text/plain").send("forbidden");
      return;
    }
    if (request.method !== "POST" || request.path !== "/mcp") {
      response.status(404).type("text/plain").send("not found");
      return;
    }
    if (isStopping) {
      response.status(503).type("text/plain").send("unavailable");
      return;
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.post("/mcp", async (request, response) => {
    if (isStopping) {
      response.status(503).type("text/plain").send("unavailable");
      return;
    }
    const server = createServerForRequest(dependencies);
    // SDK 1.29 supports stateless mode with an explicit undefined generator, but its
    // declaration is not compatible with exactOptionalPropertyTypes.
    // @ts-expect-error SDK 1.29 stateless transport declaration omits undefined
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let closePromise: Promise<void> | undefined;
    const activeRequest: ActiveRequest = {
      server,
      transport,
      close(): Promise<void> {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          await Promise.allSettled([transport.close(), server.close()]);
          active.delete(activeRequest);
        })();
        return closePromise;
      },
    };
    active.add(activeRequest);
    response.once("close", () => void activeRequest.close());
    try {
      // @ts-expect-error SDK 1.29 transport declaration is incompatible with exactOptionalPropertyTypes
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      await activeRequest.close();
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
  const bodyErrorHandler: ErrorRequestHandler = (error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const status =
      typeof error === "object" && error !== null && "status" in error && error.status === 413
        ? 413
        : 400;
    response
      .status(status)
      .type("text/plain")
      .send(status === 413 ? "request too large" : "invalid JSON");
  };
  app.use(bodyErrorHandler);

  const httpServer = createServer(app);
  const closed = new Promise<void>((resolve) => {
    httpServer.once("close", resolve);
  });
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(options.port ?? 32123, host);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(httpServer);
    throw new Error("MCP server did not expose a TCP address");
  }
  port = address.port;

  return {
    host,
    port,
    url: `http://${host}:${port}/mcp`,
    closed,
    stop(): Promise<void> {
      if (stopping) return stopping;
      isStopping = true;
      stopping = (async () => {
        const listenerClosed = closeHttpServer(httpServer);
        for (const socket of sockets) socket.destroy();
        while (active.size > 0) {
          await Promise.allSettled([...active].map((request) => request.close()));
        }
        await listenerClosed;
      })();
      return stopping;
    },
  };
}
