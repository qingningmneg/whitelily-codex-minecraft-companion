# WhiteLily Public Beta 01 Core Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the existing CLI runtime into bounded session, task, chat, and Minecraft units while adding the immutable task lease and Public Beta hard limits without changing the current supported user flow.

**Architecture:** Keep the existing TypeScript application and public ports, but move task authorization and budgets into a dedicated `TaskController`, command/owner routing into `ChatRouter`, and connection ownership into `SessionCoordinator`. Preserve `CompanionService` as the orchestration facade until later desktop plans replace its startup assumptions.

**Tech Stack:** TypeScript 7, Node.js 24, Zod 4, Vitest 4, Mineflayer 4, Codex app-server, MCP SDK

## Global Constraints

- Execute this plan in a fresh worktree created with `superpowers:using-git-worktrees`; do not execute it in the current dirty `codex/fix-windows-ci` worktree.
- First integrate or otherwise preserve the reviewed Windows CI fix in `tests/integration/windowsScripts.test.ts` and `tests/support/windowsScriptHarness.ts`.
- Windows 10/11 x64 is the target platform.
- Minecraft connections remain restricted to `127.0.0.1`.
- ChatGPT login is the only model authentication route; API Key fallback remains forbidden.
- The program hard limits are exactly 64 tool calls, 256 block changes, 1,024 blocks of horizontal travel, 10 minutes, and 8 dangerous operations per task.
- At most one task may be active.
- Unknown or ambiguous state fails closed.
- `!stop`, desktop emergency stop, disconnect, world change, model loss, and process exit invalidate the current lease.
- Existing public behavior and tests must remain passing after every task.
- Use test-driven development: add a failing test, observe the intended failure, make the smallest implementation, rerun focused tests, then run the related suite.

---

### Task 1: Add task-level leases and immutable hard limits

**Files:**

- Create: `src/safety/taskBudget.ts`
- Create: `tests/unit/taskBudget.test.ts`
- Modify: `src/mcp/toolBudget.ts`
- Modify: `tests/unit/toolBudget.test.ts`

**Interfaces:**

- Produces:
  - `HARD_TASK_LIMITS: TaskLimits`
  - `TaskControllerBudget.begin(requested?: Partial<TaskLimits>): TaskLease`
  - `TaskControllerBudget.consume(input: TaskConsumption): TaskBudgetDecision`
  - `TaskControllerBudget.invalidate(reason: TaskStopReason): void`
  - `TaskControllerBudget.snapshot(): TaskBudgetSnapshot`
- Compatibility: `TurnToolBudget` remains exported during this plan and delegates call counting to a task budget owned by the companion runtime.

- [ ] **Step 1: Write failing hard-limit and lease tests**

```ts
import { describe, expect, it } from "vitest";
import {
  HARD_TASK_LIMITS,
  TaskControllerBudget,
  type TaskLimits,
} from "../../src/safety/taskBudget.js";

describe("TaskControllerBudget", () => {
  it("clamps every requested value to the immutable hard limit", () => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    budget.begin({
      maxToolCalls: 999,
      maxBlockChanges: 999,
      maxHorizontalTravel: 999_999,
      maxDurationMs: 999_999_999,
      maxDangerousOperations: 999,
    });
    expect(budget.snapshot().limits).toEqual(HARD_TASK_LIMITS);
  });

  it("invalidates the lease and refuses all later calls", () => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    const lease = budget.begin();
    budget.invalidate("emergency_stop");
    expect(budget.consume({ lease, kind: "say", now: 1 })).toEqual({
      ok: false,
      reason: "task lease is invalid",
    });
  });

  it("enforces tool calls independently", () => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    const lease = budget.begin();
    for (let index = 0; index < 64; index += 1) {
      expect(budget.consume({ lease, kind: "say", now: 1 }).ok).toBe(true);
    }
    expect(budget.consume({ lease, kind: "say", now: 1 }).ok).toBe(false);
  });

  it.each([
    [
      "block changes",
      { kind: "dig_block", blockChanges: 256, horizontalTravel: 0, dangerousOperations: 0 },
      { kind: "dig_block", blockChanges: 1, horizontalTravel: 0, dangerousOperations: 0 },
    ],
    [
      "horizontal travel",
      { kind: "move_to", blockChanges: 0, horizontalTravel: 1_024, dangerousOperations: 0 },
      { kind: "move_to", blockChanges: 0, horizontalTravel: 1, dangerousOperations: 0 },
    ],
    [
      "dangerous operations",
      { kind: "place_block", blockChanges: 0, horizontalTravel: 0, dangerousOperations: 8 },
      { kind: "place_block", blockChanges: 0, horizontalTravel: 0, dangerousOperations: 1 },
    ],
  ] as const)("enforces %s independently", (_name, allowed, overflow) => {
    const budget = new TaskControllerBudget({ now: () => 0 });
    const lease = budget.begin();
    expect(budget.consume({ lease, now: 1, ...allowed }).ok).toBe(true);
    expect(budget.consume({ lease, now: 1, ...overflow })).toEqual({
      ok: false,
      reason: "task budget exhausted",
    });
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run:

```powershell
npm test -- tests/unit/taskBudget.test.ts
```

Expected: FAIL because `src/safety/taskBudget.ts` does not exist.

- [ ] **Step 3: Implement the task budget types and clamped limits**

```ts
export interface TaskLimits {
  maxToolCalls: number;
  maxBlockChanges: number;
  maxHorizontalTravel: number;
  maxDurationMs: number;
  maxDangerousOperations: number;
}

export const HARD_TASK_LIMITS: Readonly<TaskLimits> = Object.freeze({
  maxToolCalls: 64,
  maxBlockChanges: 256,
  maxHorizontalTravel: 1_024,
  maxDurationMs: 10 * 60 * 1_000,
  maxDangerousOperations: 8,
});

export type TaskStopReason =
  | "completed"
  | "failed"
  | "timeout"
  | "budget_exhausted"
  | "owner_stop"
  | "emergency_stop"
  | "disconnect"
  | "world_changed"
  | "model_unavailable"
  | "process_exit";

export interface TaskLease {
  id: string;
  startedAt: number;
}

export interface TaskConsumption {
  lease: TaskLease;
  kind: string;
  now: number;
  blockChanges?: number;
  horizontalTravel?: number;
  dangerousOperations?: number;
}

export type TaskBudgetDecision =
  | { ok: true; snapshot: TaskBudgetSnapshot }
  | {
      ok: false;
      reason:
        | "task lease is invalid"
        | "task duration exhausted"
        | "task budget exhausted";
    };

export interface TaskBudgetSnapshot {
  active: boolean;
  stopReason: TaskStopReason | null;
  limits: TaskLimits;
  toolCalls: number;
  blockChanges: number;
  horizontalTravel: number;
  dangerousOperations: number;
  startedAt: number | null;
}
```

Implement `TaskControllerBudget` with constructor dependencies `{ now?: () => number; randomId?: () => string }`, a cryptographically random default lease ID, one active task, non-negative finite counters, elapsed-time checks before each call, requested-limit clamping, and immutable snapshot copies. A rejected consumption must not increment any counter.

- [ ] **Step 4: Adapt `TurnToolBudget` without changing its public tests**

Construct it with a `TaskControllerBudget`, pass the active task lease into `begin()`, and keep the current per-turn lease. `consume()` must require both leases internally and return the existing error strings to current callers.

```ts
constructor(private readonly taskBudget = new TaskControllerBudget()) {}

begin(taskLease?: TaskLease): string {
  this.taskLease = taskLease ?? this.taskBudget.begin();
  // keep the existing turn lease behavior
}
```

- [ ] **Step 5: Run budget tests**

Run:

```powershell
npm test -- tests/unit/taskBudget.test.ts tests/unit/toolBudget.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run typecheck and commit**

Run:

```powershell
npm run typecheck
git add src/safety/taskBudget.ts src/mcp/toolBudget.ts tests/unit/taskBudget.test.ts tests/unit/toolBudget.test.ts
git commit -m "feat: add task-level safety budgets"
```

Expected: typecheck passes and the commit contains only the four listed files.

### Task 2: Centralize dangerous-action classification

**Files:**

- Create: `src/safety/actionRisk.ts`
- Create: `tests/unit/actionRisk.test.ts`
- Modify: `src/safety/safetyEngine.ts`
- Modify: `src/minecraft/mineflayerAdapter.ts`
- Modify: `src/mcp/toolBudget.ts`
- Modify: `src/mcp/toolRegistry.ts`
- Test: `tests/unit/safetyEngine.test.ts`
- Test: `tests/integration/mineflayerAdapter.test.ts`
- Test: `tests/unit/toolBudget.test.ts`

**Interfaces:**

- Consumes: `TaskConsumption.dangerousOperations` from Task 1.
- Produces:
  - `canonicalMinecraftName(name: string): string`
  - `classifyActionRisk(action: GameAction, context: SafetyContext): ActionRisk`
  - `ActionRisk = { level: "low" | "standard" | "dangerous"; dangerousOperations: 0 | 1; reason?: string }`

- [ ] **Step 1: Write failing classification tests**

```ts
describe("classifyActionRisk", () => {
  it.each(["tnt", "minecraft:lava_bucket", "fire", "flint_and_steel"])(
    "classifies %s as dangerous",
    (blockName) => {
      expect(
        classifyActionRisk(
          { kind: "place_block", position: { x: 1, y: 64, z: 1 }, blockName },
          { owner: { x: 0, y: 64, z: 0 } },
        ),
      ).toMatchObject({ level: "dangerous", dangerousOperations: 1 });
    },
  );

  it("classifies a protected target attack as dangerous", () => {
    expect(
      classifyActionRisk(
        { kind: "attack_hostile", entityId: 7 },
        { owner: { x: 0, y: 64, z: 0 }, protectedTarget: "pet" },
      ),
    ).toMatchObject({ level: "dangerous", dangerousOperations: 1 });
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
npm test -- tests/unit/actionRisk.test.ts
```

Expected: FAIL because `actionRisk.ts` does not exist.

- [ ] **Step 3: Implement one canonical risk classifier**

Move the duplicated dangerous item set and namespace normalization out of `SafetyEngine` and `MineflayerAdapter`. Keep Mineflayer's defense-in-depth rejection for the current conservative runtime, but make it call `classifyActionRisk()` rather than maintaining a second list.

```ts
export function classifyActionRisk(action: GameAction, context: SafetyContext): ActionRisk {
  if (isDangerousItemAction(action) || context.protectedTarget) {
    return {
      level: "dangerous",
      dangerousOperations: 1,
      reason: "action requires explicit world high-risk authorization",
    };
  }
  return { level: "standard", dangerousOperations: 0 };
}
```

- [ ] **Step 4: Route registry budget consumption through the classifier**

Extend `TurnToolBudget.consume()` with a narrow optional trusted-consumption input and forward
`dangerousOperations` to `TaskControllerBudget.consume()`. In `createToolRegistry`, build the
trusted action context first, classify it, and include `dangerousOperations` in task consumption
before dispatch. Never accept a model-provided risk flag.

- [ ] **Step 5: Run safety and adapter tests**

Run:

```powershell
npm test -- tests/unit/actionRisk.test.ts tests/unit/safetyEngine.test.ts tests/integration/mineflayerAdapter.test.ts tests/unit/toolRegistry.test.ts
```

Expected: PASS with existing permanent denials unchanged.

- [ ] **Step 6: Commit**

```powershell
git add src/safety/actionRisk.ts src/safety/safetyEngine.ts src/minecraft/mineflayerAdapter.ts src/mcp/toolBudget.ts src/mcp/toolRegistry.ts tests/unit/actionRisk.test.ts tests/unit/safetyEngine.test.ts tests/integration/mineflayerAdapter.test.ts tests/unit/toolBudget.test.ts tests/unit/toolRegistry.test.ts
git commit -m "refactor: centralize Minecraft action risk"
```

### Task 3: Extract owner chat and local-command routing

**Files:**

- Create: `src/companion/chatRouter.ts`
- Create: `tests/unit/chatRouter.test.ts`
- Modify: `src/app.ts`
- Modify: `src/companion/companionService.ts`
- Modify: `tests/integration/companionService.test.ts`
- Modify: `tests/support/companionHarness.ts`

**Interfaces:**

- Consumes: existing `parseLocalCommand(input: string): LocalCommand | null`.
- Produces:
  - `ChatRoute = { kind: "ignore" } | { kind: "command"; command: LocalCommand } | { kind: "owner_text"; text: string }`
  - `ChatRouter.route(event: MinecraftEvent): ChatRoute`
  - `ChatRouter` constructor input `{ ownerUsername: string; maxMessageLength: number }`

- [ ] **Step 1: Write failing routing tests**

```ts
describe("ChatRouter", () => {
  const router = new ChatRouter({ ownerUsername: "TestOwner", maxMessageLength: 4_000 });

  it("ignores another player's management command", () => {
    expect(
      router.route({ kind: "chat", username: "Visitor", message: "!stop" }),
    ).toEqual({ kind: "ignore" });
  });

  it("returns a parsed owner command", () => {
    expect(
      router.route({ kind: "chat", username: "TestOwner", message: "!status" }),
    ).toMatchObject({ kind: "command" });
  });

  it("bounds owner text by Unicode code points", () => {
    expect(
      router.route({ kind: "chat", username: "TestOwner", message: "🌸".repeat(5_000) }),
    ).toEqual({ kind: "owner_text", text: "🌸".repeat(4_000) });
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
npm test -- tests/unit/chatRouter.test.ts
```

Expected: FAIL because `ChatRouter` does not exist.

- [ ] **Step 3: Implement `ChatRouter`**

The router must ignore non-chat events, require an exact case-sensitive owner username, parse commands before returning owner text, normalize CR/LF to spaces, and bound by Unicode code points.

- [ ] **Step 4: Replace `CompanionService.handleEvent` chat branching**

Inject `ChatRouter` through `CompanionServiceDependencies`. Construct it in the production
composition root and companion test harness. Preserve death, outage, reconnect, and action-result
handling in `CompanionService`; only owner chat classification moves.

```ts
const route = this.dependencies.chatRouter.route(event);
if (route.kind === "ignore") return;
if (route.kind === "command") {
  await this.handleCommand(route.command);
  return;
}
this.onOwnerMessage(route.text);
```

- [ ] **Step 5: Run command and companion tests**

Run:

```powershell
npm test -- tests/unit/chatRouter.test.ts tests/unit/commandParser.test.ts tests/integration/companionService.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/app.ts src/companion/chatRouter.ts src/companion/companionService.ts tests/unit/chatRouter.test.ts tests/integration/companionService.test.ts tests/support/companionHarness.ts
git commit -m "refactor: isolate owner chat routing"
```

### Task 4: Add the single-active-task controller

**Files:**

- Create: `src/companion/taskController.ts`
- Create: `tests/unit/taskController.test.ts`
- Modify: `src/app.ts`
- Modify: `src/companion/companionService.ts`
- Modify: `src/actions/actionExecutor.ts`
- Modify: `tests/support/companionHarness.ts`
- Test: `tests/integration/companionService.test.ts`
- Test: `tests/unit/actionExecutor.test.ts`

**Interfaces:**

- Consumes: `TaskControllerBudget`, `TaskLimits`, and `TaskStopReason` from Task 1.
- Produces:
  - `TaskDisclosure = { goal: string; expectedActions: string[]; limits: TaskLimits; stopCondition: string }`
  - `ActiveTask = { id: string; lease: TaskLease; disclosure: TaskDisclosure; startedAt: string }`
  - `TaskController.start(disclosure: TaskDisclosure, requested?: Partial<TaskLimits>): ActiveTask`
  - `TaskController.consume(input: Omit<TaskConsumption, "lease"> & { leaseId: string }): TaskBudgetDecision`
  - `TaskController.stop(reason: TaskStopReason): void`
  - `TaskController.current(): ActiveTask | null`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
describe("TaskController", () => {
  it("allows only one active task", () => {
    const controller = new TaskController();
    controller.start(disclosure);
    expect(() => controller.start(disclosure)).toThrow("a task is already active");
  });

  it.each(["emergency_stop", "disconnect", "world_changed", "model_unavailable"] as const)(
    "invalidates tool work on %s",
    (reason) => {
      const controller = new TaskController();
      const task = controller.start(disclosure);
      controller.stop(reason);
      expect(
        controller.consume({ leaseId: task.lease.id, kind: "say", now: Date.now() }),
      ).toEqual({ ok: false, reason: "task lease is invalid" });
    },
  );
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
npm test -- tests/unit/taskController.test.ts
```

Expected: FAIL because `TaskController` does not exist.

- [ ] **Step 3: Implement the controller**

Use `TaskControllerBudget` as the only mutable budget source. Clone disclosures on input/output, reject empty goals and stop conditions, reject more than 16 expected action labels, and append an audit callback for `task_started` and `task_stopped`.

- [ ] **Step 4: Integrate task start and stop with companion turns**

For owner text and autonomous microtasks:

- Construct one shared `TaskControllerBudget`, `TaskController`, and `TurnToolBudget` in the
  production composition root and test harness; inject the controller into `CompanionService` and
  its stop callback into `ActionExecutor`.
- Create one disclosure before the Codex turn.
- Send a concise disclosure to Minecraft chat before actions can run.
- Attach the task lease ID to the prompt.
- Stop the task on completed/failed/interrupted turn.
- Call `taskController.stop("owner_stop")` before executor cancellation in `!stop`.
- Call `taskController.stop("disconnect")` on outage.

Do not yet unlock high-risk actions; Task 2's current conservative denials remain.

- [ ] **Step 5: Make `ActionExecutor.stopAll()` invalidate current task first**

Add an injected callback:

```ts
constructor(
  minecraft: MinecraftPort,
  safety: ActionSafety,
  confirmations: ConfirmationStore,
  ownerUsername: string,
  private readonly beforeStopAll: () => void = () => undefined,
) {}
```

Call `beforeStopAll()` synchronously at the start of `stopAll()`.

- [ ] **Step 6: Run task, executor, and companion tests**

Run:

```powershell
npm test -- tests/unit/taskController.test.ts tests/unit/actionExecutor.test.ts tests/integration/companionService.test.ts
```

Expected: PASS and existing `!stop` tests still observe action cancellation.

- [ ] **Step 7: Commit**

```powershell
git add src/app.ts src/companion/taskController.ts src/companion/companionService.ts src/actions/actionExecutor.ts tests/unit/taskController.test.ts tests/unit/actionExecutor.test.ts tests/integration/companionService.test.ts tests/support/companionHarness.ts
git commit -m "feat: control one bounded companion task"
```

### Task 5: Separate Minecraft connection lifecycle from action primitives

**Files:**

- Create: `src/minecraft/mineflayerConnection.ts`
- Create: `src/minecraft/mineflayerObservation.ts`
- Create: `tests/unit/mineflayerConnection.test.ts`
- Modify: `src/minecraft/mineflayerAdapter.ts`
- Modify: `tests/integration/mineflayerAdapter.test.ts`

**Interfaces:**

- Produces:
  - `MineflayerConnection` for create/attach/retry/disconnect/event subscription.
  - `createWorldSnapshot(bot: Bot, ownerUsername: string, tracking: EntityTracking): WorldSnapshot`.
- Preserves: the existing `MinecraftPort` interface and `MineflayerAdapter` public methods.

- [ ] **Step 1: Write failing lifecycle state tests**

```ts
describe("MineflayerConnection", () => {
  it("emits one outage and retries with the bounded delay sequence", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    const events: string[] = [];
    connection.onEvent((event) => events.push(event.kind));
    await connection.connect();
    harness.end("socket closed");
    harness.end("duplicate");
    expect(events).toEqual(["connected", "outage"]);
    expect(harness.scheduledDelays()).toEqual([1_000]);
  });

  it("cancels every retry and active operation on disconnect", async () => {
    const harness = createMineflayerConnectionHarness();
    const connection = new MineflayerConnection(harness.dependencies);
    await connection.connect();
    harness.end("socket closed");
    await connection.disconnect();
    expect(harness.pendingTimers()).toBe(0);
    expect(connection.state()).toBe("stopped");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
npm test -- tests/unit/mineflayerConnection.test.ts
```

Expected: FAIL because the connection module and harness do not exist.

- [ ] **Step 3: Move connection state without altering action methods**

Move bot creation, handler attachment/detachment, retry timer, connection promise, outage deduplication, and safe bot shutdown into `MineflayerConnection`. Inject Mineflayer's `createBot`, timer functions, and delay sequence so unit tests use no real socket.

- [ ] **Step 4: Move snapshot projection into a pure module**

`createWorldSnapshot` must bound inventory to 36 items, entities to 64, known hostiles to 64, and return fresh objects. Keep entity authorization sets owned by the adapter and pass them as read-only tracking input.

- [ ] **Step 5: Make `MineflayerAdapter` a facade**

The adapter keeps action primitives such as `moveTo`, `digBlock`, and `craftItem`, delegates lifecycle to `MineflayerConnection`, and delegates snapshot shaping to `createWorldSnapshot`.

- [ ] **Step 6: Run adapter and app lifecycle tests**

Run:

```powershell
npm test -- tests/unit/mineflayerConnection.test.ts tests/integration/mineflayerAdapter.test.ts tests/integration/app.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/minecraft/mineflayerConnection.ts src/minecraft/mineflayerObservation.ts src/minecraft/mineflayerAdapter.ts tests/unit/mineflayerConnection.test.ts tests/integration/mineflayerAdapter.test.ts
git commit -m "refactor: split Mineflayer lifecycle and observation"
```

### Task 6: Introduce the reusable runtime facade

**Files:**

- Create: `src/runtime/runtimeFacade.ts`
- Create: `src/runtime/runtimeEvents.ts`
- Create: `tests/integration/runtimeFacade.test.ts`
- Modify: `src/app.ts`
- Modify: `src/index.ts`
- Modify: `tests/integration/app.test.ts`
- Modify: `tests/e2e/companion.e2e.test.ts`

**Interfaces:**

- Produces:
  - `RuntimeCommand = { kind: "start" } | { kind: "stop"; reason: TaskStopReason } | { kind: "status" }`
  - `RuntimeEvent` discriminated union for lifecycle, task, Minecraft, Codex, and error state.
  - `RuntimeFacade.start(): Promise<void>`
  - `RuntimeFacade.stop(reason: TaskStopReason): Promise<void>`
  - `RuntimeFacade.subscribe(listener: (event: RuntimeEvent) => void): () => void`
  - `RuntimeFacade.snapshot(): RuntimeSnapshot`

```ts
export interface RuntimeSnapshot {
  lifecycle: "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";
  minecraft: {
    state: "disconnected" | "connecting" | "connected" | "reconnecting";
    sessionId: string | null;
  };
  codex: {
    state: "stopped" | "starting" | "ready" | "failed";
    model: string | null;
  };
  task: PublicTaskSnapshot | null;
  lastError: { code: string; message: string } | null;
}

export interface PublicTaskSnapshot {
  id: string;
  disclosure: TaskDisclosure;
  startedAt: string;
  budget: TaskBudgetSnapshot;
}

export type RuntimeEvent =
  | { kind: "lifecycle"; state: RuntimeSnapshot["lifecycle"] }
  | { kind: "minecraft"; state: RuntimeSnapshot["minecraft"] }
  | { kind: "codex"; state: RuntimeSnapshot["codex"] }
  | { kind: "task"; task: PublicTaskSnapshot | null }
  | { kind: "error"; error: { code: string; message: string } };
```

`RuntimeFacade` maps `ActiveTask` to `PublicTaskSnapshot`; it never exposes the task lease ID to desktop subscribers or protocol consumers.
- Preserves: `createApp()` and current CLI entry point.

- [ ] **Step 1: Write failing facade lifecycle tests**

```ts
describe("RuntimeFacade", () => {
  it("publishes ordered startup and stop state", async () => {
    const harness = createRuntimeFacadeHarness();
    const states: string[] = [];
    harness.runtime.subscribe((event) => {
      if (event.kind === "lifecycle") states.push(event.state);
    });
    await harness.runtime.start();
    await harness.runtime.stop("owner_stop");
    expect(states).toEqual(["starting", "running", "stopping", "stopped"]);
  });

  it("stops the task before executor and Minecraft cleanup", async () => {
    const harness = createRuntimeFacadeHarness();
    await harness.runtime.start();
    await harness.runtime.stop("emergency_stop");
    expect(harness.cleanupOrder()).toEqual([
      "task",
      "executor",
      "minecraft",
      "codex",
      "mcp",
    ]);
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```powershell
npm test -- tests/integration/runtimeFacade.test.ts
```

Expected: FAIL because `RuntimeFacade` does not exist.

- [ ] **Step 3: Implement the facade around current composition**

Wrap `WhiteLilyAppLifecycle` rather than duplicate it. Publish immutable snapshots, isolate listener exceptions, make `start()`/`stop()` idempotent, and ensure a terminal stop cannot be followed by an implicit restart.

- [ ] **Step 4: Route CLI startup through the facade**

`src/index.ts` should compose the runtime, subscribe for safe logging, start it, and translate SIGINT/SIGTERM into `stop("process_exit")`.

- [ ] **Step 5: Run full Node verification**

Run:

```powershell
npm run format:check
npm run typecheck
npm test
npm run build
```

Expected: all commands pass and the existing test count does not decrease.

- [ ] **Step 6: Run the Windows release check**

Run:

```powershell
./scripts/release-check.ps1 -SkipInstall
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/runtime/runtimeFacade.ts src/runtime/runtimeEvents.ts src/app.ts src/index.ts tests/integration/runtimeFacade.test.ts tests/integration/app.test.ts tests/e2e/companion.e2e.test.ts
git commit -m "refactor: expose a reusable companion runtime"
```

### Task 7: Document the new runtime boundary

**Files:**

- Create: `docs/runtime-architecture.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Test: `tests/integration/releaseReadiness.test.ts`

**Interfaces:**

- Documents the stable interfaces produced by Tasks 1-6 for the desktop plan.

- [ ] **Step 1: Extend the release-readiness test**

Add assertions that `docs/runtime-architecture.md` exists and contains the literal headings `RuntimeFacade`, `TaskController`, `ChatRouter`, `MineflayerConnection`, and `Emergency stop order`.

- [ ] **Step 2: Run the test and confirm failure**

Run:

```powershell
npm test -- tests/integration/releaseReadiness.test.ts
```

Expected: FAIL because the document does not exist.

- [ ] **Step 3: Write the runtime architecture document**

Document:

- Each unit's responsibility and dependency direction.
- The exact stop order.
- Task hard limits.
- Why `MinecraftPort` remains the public game boundary.
- Which APIs the later desktop Sidecar may call.
- A Mermaid lifecycle diagram using the states from `RuntimeFacade`.

- [ ] **Step 4: Link the document from both READMEs**

Add one short “Architecture / 架构” link without changing current installation claims.

- [ ] **Step 5: Run final verification**

Run:

```powershell
npm run format:check
npm run typecheck
npm test
npm run build
./scripts/release-check.ps1 -SkipInstall
```

Expected: all commands pass.

- [ ] **Step 6: Commit**

```powershell
git add docs/runtime-architecture.md README.md README.zh-CN.md tests/integration/releaseReadiness.test.ts
git commit -m "docs: define the reusable runtime boundary"
```
