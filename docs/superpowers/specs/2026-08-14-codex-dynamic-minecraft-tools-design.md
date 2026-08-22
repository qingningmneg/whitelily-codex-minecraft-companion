# Codex Dynamic Minecraft Tools Design

## Problem

WhiteLily already classifies ordinary conversation as chat and clear Minecraft commands as tasks. In the live Codex 0.145.0 runtime, however, deferred MCP discovery returns the Minecraft namespace without adding the discovered tools to the following Responses request. The model emits a Minecraft call, but app-server never dispatches it or returns a tool result, so the execution turn hangs even though the local MCP service is healthy.

## Decision

WhiteLily will register the existing Minecraft tool registry as app-server `dynamicTools` on execution threads. Intent-classification threads will receive no dynamic tools. The model can therefore call a Minecraft action directly after deciding that a message is a task, without relying on Codex 0.145.0's broken deferred MCP loading path.

The dynamic tool adapter is transport-only. It must reuse `createToolRegistry` for schema validation, turn-lease validation, action authorization, budget consumption, safety checks, confirmation handling, and execution. It must not call Mineflayer or `ActionExecutor` directly.

## Components

### JSON-RPC server request handling

`JsonRpcProcess` currently supports client requests, responses, and server notifications. It will also recognize server requests containing both `id` and `method`, invoke one registered asynchronous request handler, and send a matching result or a sanitized JSON-RPC error. Server request IDs may be strings or numbers and are independent from WhiteLily's numeric outbound request IDs.

### Dynamic Minecraft tool adapter

A focused adapter will convert every definition from `createToolRegistry` into a non-deferred top-level dynamic function specification. Zod schemas will be converted to JSON Schema for app-server. Incoming calls must use a null namespace, a known Minecraft tool name, an object argument, and a tool-enabled thread. The adapter will parse the argument with the original Zod schema before calling the original registry definition.

Tool results map to `DynamicToolCallResponse`: one `inputText` content item and `success` equal to the inverse of `isError`. Unknown, malformed, unauthorized, or failed calls return a bounded generic failure result without leaking internal errors.

### Thread isolation

`CodexPort.startThread` will explicitly declare whether the new thread needs Minecraft tools. `CompanionService` will start the intent thread without tools and the execution thread with them. `CodexAppServerClient` will place `dynamicTools` only on the execution thread's `thread/start` request and track the returned thread ID as tool-enabled until archive or shutdown.

### Prompt behavior

Execution prompts will instruct the model to call an authorized `minecraft_*` tool directly. They will no longer require `tool_search`, because dynamic functions are present in the turn's tool list. Conversation behavior remains unchanged: the intent router chooses chat or execution without asking the owner to choose a mode.

## Safety and Failure Handling

- Dynamic tools never appear on the intent thread.
- A server tool request for any non-tool-enabled thread is rejected.
- Every call still requires the opaque live `turnLease` already embedded in the execution prompt.
- Existing action allowlists, per-turn budgets, task limits, world authority, safety gates, and confirmations remain authoritative.
- Tool errors are returned to the model as unsuccessful tool results so it can stop or explain the failure instead of hanging.
- Transport shutdown rejects outstanding client requests and ignores late server-tool completions after the process has stopped.

## Verification

- Unit tests cover inbound JSON-RPC request/result/error behavior and string request IDs.
- Adapter tests cover schema generation, successful execution through the real registry, invalid arguments, unknown tools, and unauthorized threads.
- App-server integration tests prove that only the execution thread receives `dynamicTools` and that `item/tool/call` receives a response.
- Companion tests prove the intent/execution thread capability split.
- Prompt tests prove task execution no longer depends on `tool_search`.
- Full tests, type checking, desktop preparation, installed-runtime hashes, logs, and live Minecraft chat/action behavior are verified before completion.
