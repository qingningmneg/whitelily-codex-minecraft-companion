# Codex HTTP Transport Design

## Problem

WhiteLily receives Minecraft owner chat and eventually writes the model reply back to the game, but the first model turn after startup waits about 100 seconds. Codex 0.145.0 attempts a Responses WebSocket prewarm and five stream retries on this network before falling back to HTTPS. The same ChatGPT-authenticated request completes in about seven seconds when the active provider declares that WebSockets are unsupported.

## Decision

WhiteLily will launch its private Codex app-server with a dedicated provider named `whitelily_openai_http`. The provider uses `https://chatgpt.com/backend-api/codex`, the Responses wire API, existing OpenAI authentication, and `supports_websockets=false`.

The provider override is supplied only to WhiteLily's app-server process. It is not written into the user's global Codex configuration and does not affect login-status checks or other Codex installations.

## Data Flow

1. WhiteLily constructs the verified bundled Codex launch specification.
2. The launch specification prepends six `-c` overrides that select and define `whitelily_openai_http`.
3. Codex app-server starts on its existing stdio JSON-RPC transport.
4. Model requests use HTTPS immediately while Minecraft chat and JSON-RPC behavior remain unchanged.

## Safety and Compatibility

- Continue stripping API-key environment variables and using the verified bundled executable.
- Continue requiring ChatGPT/OpenAI authentication; do not enable API-key billing.
- Use argument values without spaces so the existing Windows `.cmd` wrapper remains unambiguous.
- Keep the app-server stdio transport unchanged; only the upstream model transport changes.

## Verification

- Unit tests assert the full provider override for both the Windows `.cmd` wrapper and the verified native executable.
- Type checking and the relevant Codex process tests must pass.
- A real request using the same provider must complete over HTTP.
- After installing and restarting WhiteLily, logs must show a normal reply without WebSocket prewarm timeout/retry messages.
