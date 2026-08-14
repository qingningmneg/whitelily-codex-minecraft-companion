# Codex HTTP Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WhiteLily's ChatGPT-authenticated Codex turns use HTTPS immediately instead of waiting for failed WebSocket retries.

**Architecture:** Add a fixed, private HTTP-only model-provider override to the Codex app-server spawn arguments. Preserve the verified executable, controlled environment, stdio JSON-RPC transport, model selection, and ChatGPT authentication.

**Tech Stack:** TypeScript 7, Node.js 24 child processes, Codex CLI 0.145.0, Vitest 4.

## Global Constraints

- Do not write or change the user's global Codex configuration.
- Do not enable API-key authentication or billing.
- Do not change Minecraft transport behavior.
- Keep Windows `.cmd` arguments free of whitespace-sensitive provider values.

---

### Task 1: Force HTTP for the private Codex app-server

**Files:**
- Modify: `tests/unit/jsonRpcProcess.test.ts:29-271`
- Modify: `src/codex/jsonRpcProcess.ts:162-207`

**Interfaces:**
- Consumes: `createCodexAppServerSpawnSpec(platform, launch, environment)`.
- Produces: the same `CodexSpawnSpec` shape with HTTP-provider `-c` arguments before `app-server --listen stdio://`.

- [ ] **Step 1: Write the failing test**

Define this expected argument prefix in `tests/unit/jsonRpcProcess.test.ts` and require it in both spawn-spec assertions:

```ts
const httpProviderArgs = [
  "-c",
  'model_provider="whitelily_openai_http"',
  "-c",
  'model_providers.whitelily_openai_http.name="WhiteLilyHTTP"',
  "-c",
  'model_providers.whitelily_openai_http.base_url="https://chatgpt.com/backend-api/codex"',
  "-c",
  'model_providers.whitelily_openai_http.wire_api="responses"',
  "-c",
  "model_providers.whitelily_openai_http.requires_openai_auth=true",
  "-c",
  "model_providers.whitelily_openai_http.supports_websockets=false",
] as const;
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- tests/unit/jsonRpcProcess.test.ts`

Expected: FAIL because the current spawn specification starts directly with `app-server` and lacks `whitelily_openai_http`.

- [ ] **Step 3: Implement the minimal argument prefix**

Add the equivalent immutable provider argument list in `src/codex/jsonRpcProcess.ts` and spread it before `"app-server", "--listen", "stdio://"` inside `createCodexAppServerSpawnSpec`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/unit/jsonRpcProcess.test.ts`

Expected: every test in the file passes.

- [ ] **Step 5: Run proportional regression checks**

Run: `npm test -- tests/unit/jsonRpcProcess.test.ts tests/integration/appServerClient.test.ts tests/integration/app.test.ts`

Run: `npm run typecheck`

Expected: all selected tests and type checking pass.

- [ ] **Step 6: Build, install, and verify the running application**

Run the existing desktop child/bundle packaging flow, back up the installed resource being replaced, install the verified build, and restart only WhiteLily. Confirm the bot rejoins the current LAN world and a new owner message receives a response without WebSocket timeout/retry log entries.

- [ ] **Step 7: Commit the cohesive fix**

Stage the two implementation files, the existing intent-routing files, and these design/plan documents. Commit with: `fix: route WhiteLily Codex turns over HTTP`.
