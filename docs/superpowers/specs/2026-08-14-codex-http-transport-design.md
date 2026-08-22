# Codex HTTP Transport Design

## Problem

WhiteLily receives Minecraft owner chat and eventually writes the model reply back to the game, but the first model turn after startup waits about 100 seconds. Codex 0.145.0 attempts a Responses WebSocket prewarm and five stream retries on this network before falling back to HTTPS. The same ChatGPT-authenticated request completes in about seven seconds when the active provider declares that WebSockets are unsupported.

## Decision

WhiteLily will launch its private Codex app-server with a dedicated provider named `whitelily_openai_http`. The provider uses `https://chatgpt.com/backend-api/codex`, the Responses wire API, existing OpenAI authentication, and `supports_websockets=false`.

The provider override is supplied only to WhiteLily's app-server process. It is not written into the user's global Codex configuration and does not affect login-status checks or other Codex installations.

## Data Flow

1. WhiteLily constructs the verified bundled Codex launch specification.
2. The launch specification prepends the private provider overrides that select and define `whitelily_openai_http`, plus the process-local Minecraft MCP URL.
3. Codex app-server starts on its existing stdio JSON-RPC transport.
4. Model requests use HTTPS immediately while Minecraft chat and JSON-RPC behavior remain unchanged.
5. When the game runtime starts after an account/model session has already created app-server, WhiteLily calls `config/mcpServer/reload` after the local MCP readiness check so that the existing process observes the newly available endpoint.

## Minecraft Tool Delivery

Codex 0.145.0 can discover the deferred Minecraft MCP namespace without placing the discovered functions in the following Responses request. In that failure mode the model emits a Minecraft call, but app-server never dispatches the call or returns a result, leaving the execution turn waiting even though MCP readiness is healthy.

WhiteLily therefore does not rely on deferred MCP loading for game execution. It converts the same reviewed Minecraft `ToolRegistry` definitions into non-deferred app-server `dynamicTools` on the execution thread only. The intent-classification thread receives no action tools. Incoming `item/tool/call` requests are routed back through the existing registry, preserving schema validation, live turn leases, task and turn budgets, safety checks, confirmations, and `ActionExecutor`. The process-local MCP endpoint and reload remain available for readiness and compatibility, but they are not an alternate way around those controls.

## Safety and Compatibility

- Continue stripping API-key environment variables and using the verified bundled executable.
- Continue requiring ChatGPT/OpenAI authentication; do not enable API-key billing.
- Use argument values without spaces so the existing Windows `.cmd` wrapper remains unambiguous.
- Keep the app-server stdio transport unchanged; upstream model requests use HTTP and inbound dynamic-tool calls use the same bidirectional JSON-RPC connection.
- Never expose Minecraft dynamic tools to the intent-classification thread.
- Never invoke Mineflayer or `ActionExecutor` directly from the dynamic-tool adapter.

## Verification

- Unit tests assert the full provider override for both the Windows `.cmd` wrapper and the verified native executable.
- Type checking and the relevant Codex process tests must pass.
- A real request using the same provider must complete over HTTP.
- Integration tests must prove MCP reload, execution-only dynamic-tool registration, and a matching response to app-server `item/tool/call` requests.
- After installing and restarting WhiteLily, logs must show a normal reply without WebSocket prewarm timeout/retry messages.
