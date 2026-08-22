# Codex Dynamic Minecraft Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make clear Minecraft commands execute immediately while ordinary messages remain natural chat, without relying on Codex 0.145.0 deferred MCP tool loading.

**Architecture:** Add bidirectional request handling to the existing stdio JSON-RPC transport, adapt the existing safe `ToolRegistry` to app-server dynamic functions, and grant those functions only to the execution thread. Keep intent routing, turn leases, action budgets, safety checks, and Mineflayer execution unchanged.

**Tech Stack:** TypeScript 7, Node.js 24, Codex app-server 0.145.0 experimental protocol, Zod 4, Vitest 4.

## Global Constraints

- Do not expose Minecraft tools to the intent-classification thread.
- Do not bypass `createToolRegistry`, `TurnToolBudget`, `TaskController`, `SafetyEngine`, or `ActionExecutor`.
- Do not require `tool_search` before a Minecraft action.
- Do not ask the owner whether a message is chat or a task.
- Do not close Minecraft during installation or runtime verification.

---

### Task 1: Handle app-server initiated JSON-RPC requests

**Files:**
- Modify: `tests/unit/jsonRpcProcess.test.ts`
- Modify: `src/codex/jsonRpcProcess.ts`

**Interfaces:**
- Consumes: `{ id: string | number, method: string, params: unknown }` from app-server.
- Produces: `JsonRpcProcess.onRequest(handler)` and a matching `{ id, result }` or `{ id, error }` line.

- [ ] **Step 1: Write failing tests**

Add tests that register an async handler, inject `item/tool/call` with a string ID, and assert the exact matching result. Add error cases for an unhandled method and a throwing handler.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- tests/unit/jsonRpcProcess.test.ts`

Expected: FAIL because `JsonRpcProcess` has no server request handler and discards the request as an unknown response.

- [ ] **Step 3: Implement the minimal handler path**

Extend `JsonRpcMessage` request/response IDs to `string | number`, add a single asynchronous request listener, route messages with both `method` and `id` before response matching, and send bounded standard errors without including exception text.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/unit/jsonRpcProcess.test.ts`

Expected: all tests pass.

---

### Task 2: Adapt the safe Minecraft registry to dynamic tools

**Files:**
- Create: `src/codex/minecraftDynamicTools.ts`
- Create: `tests/unit/minecraftDynamicTools.test.ts`

**Interfaces:**
- Consumes: `ToolRegistryDependencies` and `DynamicToolCallParams`.
- Produces: `MinecraftDynamicTools` with immutable `specs` and `call(params, authorizedThreadIds)` returning `DynamicToolCallResponse`.

- [ ] **Step 1: Write failing adapter tests**

Use `createToolRegistryHarness` to assert that `minecraft_follow_owner` is exposed as a non-deferred top-level function, malformed arguments fail before execution, a valid live lease reaches the original registry, and unknown/unauthorized calls fail safely.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- tests/unit/minecraftDynamicTools.test.ts`

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement the minimal adapter**

Build definitions from `createToolRegistry`, convert each schema with `z.toJSONSchema`, parse with the original schema, call the original definition, and map its text/error flag to the dynamic response type.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/unit/minecraftDynamicTools.test.ts tests/unit/toolRegistry.test.ts`

Expected: all tests pass.

---

### Task 3: Register tools only on the execution thread

**Files:**
- Modify: `src/codex/generated/v2/ThreadStartParams.ts`
- Modify: `src/codex/codexPort.ts`
- Modify: `src/codex/appServerClient.ts`
- Modify: `src/companion/companionService.ts`
- Modify: `src/app.ts`
- Modify: `tests/integration/appServerClient.test.ts`
- Modify: `tests/integration/companionService.test.ts`
- Modify: `tests/integration/app.test.ts`

**Interfaces:**
- Consumes: `startThread({ ..., toolAccess: "none" | "minecraft" })` and `MinecraftDynamicTools`.
- Produces: `dynamicTools` only in the execution `thread/start`; handled `item/tool/call` responses only for returned tool-enabled thread IDs.

- [ ] **Step 1: Write failing thread-isolation tests**

Assert that the first companion thread request omits `dynamicTools`, the second includes all Minecraft specs, and a server request for the execution thread returns the adapter result while the intent thread is rejected.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- tests/integration/appServerClient.test.ts tests/integration/companionService.test.ts tests/integration/app.test.ts`

Expected: FAIL because thread capability selection and app-server request wiring do not exist.

- [ ] **Step 3: Implement the minimal composition**

Enable the app-server experimental API capability, add `dynamicTools` to the local generated thread-start binding, pass the adapter into `CodexAppServerClient`, register its JSON-RPC request handler, track tool-enabled thread IDs, and assign capabilities in `CompanionService.startThreadPair`.

- [ ] **Step 4: Verify GREEN**

Run the same three focused test files and `npm run typecheck`.

Expected: all tests and type checking pass.

---

### Task 4: Make task prompts call dynamic actions directly

**Files:**
- Modify: `src/companion/promptBuilder.ts`
- Modify: `codex-workspace/AGENTS.md`
- Modify: `tests/unit/promptBuilder.test.ts`

**Interfaces:**
- Consumes: the existing authorized action list and opaque `turnLease`.
- Produces: execution instructions that call an authorized `minecraft_*` tool directly and never insert `tool_search` into the action path.

- [ ] **Step 1: Write failing prompt tests**

Assert that a task prompt says to call the authorized Minecraft tool directly, does not require `tool_search`, and still forbids unauthorized actions and lease disclosure.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- tests/unit/promptBuilder.test.ts`

Expected: FAIL because the current prompt requires `tool_search`.

- [ ] **Step 3: Apply the minimal prompt change**

Replace deferred-search sequencing with direct dynamic-tool sequencing in both runtime prompt construction and the packaged workspace policy.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/unit/promptBuilder.test.ts tests/unit/intentRouter.test.ts`

Expected: all tests pass.

---

### Task 5: Verify, install, exercise, and publish

**Files:**
- Modify as required by verified build manifests only.

**Interfaces:**
- Produces: a tested desktop bundle, matching installed files, live chat/action evidence, one cohesive commit, and a pushed branch.

- [ ] **Step 1: Run repository verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run desktop:prepare`

Expected: all commands exit 0.

- [ ] **Step 2: Inspect the complete diff**

Run: `git diff --check`

Run: `git diff --stat`

Review every changed file for thread isolation, safe error handling, and preservation of unrelated work.

- [ ] **Step 3: Install and restart WhiteLily only**

Back up each installed resource whose hash changes, copy the prepared bundle files, verify source/build/install hashes, terminate the stuck WhiteLily process tree, and launch the installed application. Leave Minecraft running.

- [ ] **Step 4: Perform live acceptance checks**

Send an ordinary greeting and verify WhiteLily replies without movement. Send `来我身边` and verify logs contain a completed `minecraft_follow_owner` call, tool-call count increases, and WhiteLily moves toward the owner without asking whether to chat or act.

- [ ] **Step 5: Commit and push**

Stage the cohesive routing, transport, prompt, tests, design, and plan changes. Commit with `fix: execute Minecraft actions through dynamic tools`, then push `codex/whitelily-electron-desktop` to the configured GitHub remote.
