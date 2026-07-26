# Runtime architecture

This document defines the stable runtime boundary used by the CLI today and reserved for a later desktop sidecar. It describes existing behavior; it does not change installation, release, compatibility, or feature commitments.

## RuntimeFacade

`RuntimeFacade` is the public runtime boundary. It owns the externally visible lifecycle, the public `start()`, `stop(reason)`, `subscribe(listener)`, and `snapshot()` surface, and the translation from internal state to safe runtime events and snapshots. A later desktop sidecar may call **only** these four operations: `start`, `stop(reason)`, `subscribe`, and `snapshot`. It must not access `ActionExecutor`, `TaskController`, `TurnToolBudget`, or Mineflayer directly.

RuntimeFacade depends inward on `WhiteLilyAppLifecycle` for component lifecycle ownership, on `TaskController` for task state and invalidation, and on Minecraft and Codex observers for public state. No lower layer depends on RuntimeFacade. `WhiteLilyAppLifecycle` remains the sole component cleanup executor: RuntimeFacade asks it to stop, but does not clean up its components itself.

`start()` coalesces concurrent starts and is idempotent while running. `stop(reason)` coalesces concurrent stops and is idempotent after `stopped` or `failed`. A stopped or failed facade is terminal: it cannot restart; create a new runtime instance. Startup or stop failure moves the facade to `failed`, and unknown task or Minecraft state fails closed in the public state rather than exposing untrusted data.

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> starting: start()
  idle --> stopping: stop(reason)
  starting --> running: lifecycle start succeeds
  starting --> stopping: stop(reason)
  starting --> failed: start failure
  running --> stopping: stop(reason)
  stopping --> stopped: stop succeeds
  stopping --> failed: stop failure
  failed --> [*]: terminal; no restart
  stopped --> [*]: terminal; no restart
```

Events are delivered FIFO. Listener reentrancy is isolated by queueing nested publications, and listener failures cannot alter the runtime lifecycle. `snapshot()` and event payloads are immutable, exact-shape public values: invalid or extra-shaped internal data is rejected rather than partially published. Public task identifiers are newly generated, safe IDs; task lease IDs never cross this boundary. Minecraft `sessionId` is `null` until a safe source exists.

## WhiteLilyAppLifecycle

`WhiteLilyAppLifecycle` owns startup and cleanup of the composed application. It starts MCP, Codex, Minecraft, then the companion; it owns reverse-order cleanup and continues cleanup when an earlier cleanup step fails. It is terminal after stopping or a failed startup, and it remains the only component cleanup executor.

Its dependencies point inward to the managed MCP, Codex, Minecraft, CompanionService, and ActionExecutor components. RuntimeFacade depends on this lifecycle; the lifecycle does not depend on RuntimeFacade.

## TaskController

`TaskController` owns one bounded task lease, validates the public task disclosure, starts and stops the task, records audit transitions, and invalidates its lease before downstream work can continue. It also owns the task deadline: deadlines fire independently of later tool calls, and production timer handles are unreferenced and cleared on every earlier terminal path. It depends on `TaskControllerBudget`; callers receive cloned task state rather than its mutable active state.

`TaskControllerBudget` owns task-wide accounting and invalidation. `TurnToolBudget` is per-Codex-turn accounting layered on that task budget: it authorizes individual tool calls only while the task lease remains valid. TurnToolBudget forwards task-wide tool-call, block-change, horizontal-travel, and classifier-derived dangerous-operation counts. Dig/place/travel counters also remain per-turn for safety context, but those counters do not substitute for task-wide enforcement. The registry charges one trusted block change for each dig or place before executor dispatch; move and follow distance comes from trusted Minecraft snapshots, never from model-supplied accounting values. Missing, malformed, or non-finite trusted positions fail closed without dispatch. These requested task limits can only lower the immutable program caps; they cannot raise them:

| Hard limit           | Immutable cap |
| -------------------- | ------------: |
| Tool calls           |            64 |
| Block changes        |           256 |
| Horizontal blocks    |         1,024 |
| Duration             |    10 minutes |
| Dangerous operations |    8 per task |

All five task-wide dimensions fail closed on exhaustion. A deadline or overflow revokes the task lease, records one terminal transition, fences and interrupts the Codex turn, cancels queued and in-flight actions, and clears pending confirmations. `TaskController`, `TaskControllerBudget`, and `TurnToolBudget` are internal safety controls, not desktop-sidecar APIs.

## ChatRouter

`ChatRouter` is a pure inbound-chat boundary used by `CompanionService`. It accepts only owner chat events, routes recognized local commands separately, and sanitizes and length-bounds owner text before Codex sees it. It depends on the command parser and `MinecraftEvent` type; it neither owns the Minecraft connection nor starts Codex work.

## MineflayerConnection

`MineflayerConnection` owns the Mineflayer bot connection state machine, event attachment, bounded retry handling, active-operation cancellation, and terminal disconnect. It binds observations and operations to the active bot/session generation and normalizes modern `worldState.name` and legacy flat `worldName` alongside the trusted Mineflayer dimension. Initial spawn, same-identity respawn, duplicates, and stale bots do not publish a world transition; a changed identity, or an unreadable identity on an active respawn signal, publishes one fail-closed `world_changed` event. `CompanionService` synchronously invalidates the task as `world_changed`, interrupts the turn, cancels actions and confirmations, stops the active mode, and persists the paused state. Its world invalidation latch survives outage, retry, and reconnect events; only an explicit owner resume or reset clears it.

`MineflayerAdapter` owns the concrete implementation of `MinecraftPort`: it translates the connection's Mineflayer events and bot operations into the safe port operations used by the rest of the application. Movement cancellation stops pathfinder and control states. Dig cancellation calls Mineflayer's `stopDigging`; a returned thenable is treated as the physical acknowledgement and is observed for both resolution and rejection. Movement and dig cancellation are bounded by a one-second physical acknowledgement window. When that window expires, or a primitive has no reliable fine-grained cancellation API, the adapter fences and disconnects the captured session and every post-await continuation rechecks the session generation. The physical transport close uses Mineflayer's public end operation, falls through only to installed protocol socket operations that actually exist, and enters terminal exhaustion with no retry if every close mechanism fails. `ActionExecutor` does not publish cancellation or timeout completion for active work until the adapter has acknowledged cancellation or established that fence; a terminal fence failure is reported as a failed action and later work cannot reach a bot primitive. `createWorldSnapshot` turns selected, bounded Mineflayer observation data into the `WorldSnapshot` consumed by the application; it is an adapter helper, not a public desktop API.

`MinecraftPort` remains the public game boundary for application code. `CompanionService`, `ActionExecutor`, safety context creation, and MCP tool registration depend on this port, never on Mineflayer types. This keeps game control testable and lets Mineflayer remain an implementation detail behind the port.

## Codex and MCP

`CompanionService` coordinates owner/autonomous work. It uses `ChatRouter`, `TaskController`, `TurnToolBudget`, `MinecraftPort`, `ActionExecutor`, memory/state, and the Codex port. Codex proposes tool work; MCP exposes the constrained tool registry. The registry validates tool schemas, obtains trusted context and risk classification, consumes `TurnToolBudget`, then dispatches to `ActionExecutor`. ActionExecutor performs SafetyEngine policy evaluation and invokes MinecraftPort. The MCP registry does not depend directly on TaskController. Codex and MCP do not bypass these boundaries.

Dependency direction is therefore: RuntimeFacade -> WhiteLilyAppLifecycle -> CompanionService/Codex/MCP/Minecraft composition; CompanionService -> TaskController and TurnToolBudget; MCP registry -> TurnToolBudget, trusted context/classification, and ActionExecutor (not TaskController); ActionExecutor -> SafetyEngine and MinecraftPort; MineflayerAdapter -> MineflayerConnection and `createWorldSnapshot`. The arrows always point toward lower-level implementation or policy boundaries, never back toward the facade.

## Emergency stop order

The public safety-critical stop order is **task -> executor -> Minecraft -> Codex -> MCP**.

1. RuntimeFacade first asks `TaskController` to invalidate the active task with the exact supplied stop reason.
2. `WhiteLilyAppLifecycle` then performs the existing CompanionService orchestration quiescence as part of lifecycle cleanup; it remains the sole component cleanup executor.
3. `ActionExecutor` aborts queued and active action work.
4. Minecraft disconnects through `MinecraftPort` and the Mineflayer adapter/connection.
5. Codex stops.
6. MCP stops.

This ordering removes task authority before action execution, then removes the game connection before shutting down reasoning and tool serving. Cleanup is best-effort per component so later safety steps still run if an earlier one reports an error; a failed stop is exposed as the terminal `failed` runtime state.
