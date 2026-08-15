# AI 动作队列与生活能力实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 WhiteLily 使用 AI 动态生成的私有动作队列完成烤鱼、面包与种植、动态建房和睡觉，并能被主人消息立即中断。

**Architecture:** 新建与模型规划解耦的 `CompanionActionQueue` 和队列执行器，所有物理动作继续经过现有任务租约、安全、预算和 `ActionExecutor`。意图模型负责语义判断，执行模型负责观察、入队和失败后的重新规划；桌面运行时快照只公开经过脱敏的队列投影。

**Tech Stack:** TypeScript 7、Node.js 24、Vitest 4、Zod 4、Mineflayer 4.37、Electron、React、现有 `DocumentStore` 与桌面 JSON 协议。

## Global Constraints

- 不得加入固定食物任务宏、固定食物制作脚本或固定房屋蓝图。
- 主人发来任何新消息时，必须在意图模型完成分类前暂停队列并中止当前物理动作。
- `stop_task` 清空当前任务队列；帮助请求抢占并保留旧队列，帮助结束后只能经过重新观察和重新规划恢复。
- 每个任务最多拥有 256 个等待中或执行中的物理动作；建房任务最多改动 256 个方块。
- 第一次新建小麦农田需要自然语言询问；30 秒无回复或明确拒绝时，本次改为寻找现成成熟小麦。
- 主人同意一次后，小麦种植权限跨位置、跨世界长期有效，不得重复询问；主人可通过自然语言撤销。
- 队列在普通 Minecraft 聊天中不可见，只能通过脱敏桌面诊断投影和结构化日志查看。
- 不实现坐下；不开放通用“使用手持物品”、命令、脚本、任意代码或 NBT 工具。
- 所有物理动作继续复用现有任务租约、动作白名单、安全引擎、确认机制、预算、可信快照和审计。
- 精确动作不得在重启、断线、主人变化或世界变化后盲目恢复。

---

### Task 1: 建立私有动作队列领域模型

**Files:**
- Create: `src/actions/actionQueue.ts`
- Create: `tests/unit/actionQueue.test.ts`

**Interfaces:**
- Consumes: `GameAction`、`TaskLease`。
- Produces: `CompanionActionQueue`、`QueueExecutionItem`、`QueueItemSnapshot`、`ActionQueueSnapshot`、`ActionQueueEvent`、`QueueAdmission`、`PermissionQueueAdmission`。

- [ ] **Step 1: 写队列生命周期失败测试**

```ts
it("keeps FIFO order and exposes only sanitized queue summaries", () => {
  const queue = new CompanionActionQueue({ createId: sequenceIds(), now: () => 100 });
  queue.enqueue(admission({ action: { kind: "jump" }, summary: "跳一下" }));
  queue.enqueue(admission({ action: { kind: "wait", milliseconds: 500 }, summary: "短暂等待" }));

  expect(queue.snapshot().items.map(({ status, summary }) => ({ status, summary }))).toEqual([
    { status: "waiting", summary: "跳一下" },
    { status: "waiting", summary: "短暂等待" },
  ]);
  expect(JSON.stringify(queue.snapshot())).not.toContain("task-secret");
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `npx vitest run tests/unit/actionQueue.test.ts`

Expected: FAIL，提示无法导入 `src/actions/actionQueue.ts`。

- [ ] **Step 3: 实现最小队列状态机**

```ts
export type QueueItemStatus =
  | "waiting"
  | "running"
  | "suspended"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled";

export interface QueueAdmission {
  readonly taskLease: TaskLease;
  readonly worldGeneration: number;
  readonly action: GameAction;
  readonly summary: string;
  readonly trustedObservationKey: string;
}

export interface PermissionQueueAdmission {
  readonly taskLease: TaskLease;
  readonly worldGeneration: number;
  readonly permission: "wheat_farming";
  readonly summary: string;
}

export interface QueueItemSnapshot {
  readonly index: number;
  readonly kind: GameAction["kind"] | "wheat_farming_permission";
  readonly summary: string;
  readonly status: QueueItemStatus;
  readonly retryCount: number;
  readonly enqueuedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly reason?: string;
}

export interface ActionQueueSnapshot {
  readonly items: readonly QueueItemSnapshot[];
}

export type ActionQueueEvent = {
  readonly kind: "item_changed";
  readonly item: QueueItemSnapshot;
};

export interface QueueExecutionItem {
  readonly id: string;
  readonly taskLease: TaskLease;
  readonly worldGeneration: number;
  readonly action: GameAction;
}

export class CompanionActionQueue {
  enqueue(input: QueueAdmission): QueueItemSnapshot;
  beginPermissionWait(input: PermissionQueueAdmission): QueueItemSnapshot;
  resolvePermission(id: string, taskLease: TaskLease, result: "completed" | "cancelled", reason: string): void;
  claimNext(taskLease: TaskLease, worldGeneration: number): QueueExecutionItem | undefined;
  recordTransportRetry(id: string, taskLease: TaskLease, worldGeneration: number): void;
  complete(id: string, taskLease: TaskLease, worldGeneration: number): void;
  fail(id: string, taskLease: TaskLease, worldGeneration: number, reason: string): void;
  suspendTask(taskLease: TaskLease, reason: string): void;
  resumeTaskAfterReplan(taskLease: TaskLease, worldGeneration: number): void;
  cancelWaiting(taskLease: TaskLease, reason: string): void;
  cancelTask(taskLease: TaskLease, reason: string): void;
  snapshot(): ActionQueueSnapshot;
  subscribe(listener: (event: ActionQueueEvent) => void): () => void;
}
```

实现时保存完整 `GameAction` 只供 `claimNext()` 返回给受信执行器；`snapshot()` 只返回动作种类、受限摘要、状态、重试次数、规范 ISO 格式的 `enqueuedAt`/`startedAt`/`endedAt` 和受限原因，不返回租约 ID、观察键或完整动作参数。摘要按 Unicode 字符截断到 160 字符，原因截断到 240 字符。权限等待项永远不会被 `claimNext()` 当作物理动作取出。

- [ ] **Step 4: 增加边界测试并跑绿**

补充测试：同一任务 256 个活动项成功、第 257 项返回 `queue capacity exhausted`、另一个任务仍有独立容量、非法状态转换失败、不同任务租约不能操作彼此队列、世界代次不匹配时 `claimNext()` 取消过期项、权限等待项可见但不可执行、订阅者异常不影响状态提交。

Run: `npx vitest run tests/unit/actionQueue.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/actions/actionQueue.ts tests/unit/actionQueue.test.ts
git commit -m "feat: add private companion action queue"
```

### Task 2: 用可中断执行器消费队列

**Files:**
- Create: `src/actions/queuedActionRunner.ts`
- Create: `tests/unit/queuedActionRunner.test.ts`
- Modify: `src/actions/actionExecutor.ts`
- Modify: `tests/unit/actionExecutor.test.ts`

**Interfaces:**
- Consumes: `CompanionActionQueue`、`ActionExecutor.execute(action, context)`、`SafetyContext`。
- Produces: `QueuedActionRunner.start()`、`suspend()`、`resumeAfterReplan()`、`cancelTask()`、`waitForIdle()`、`subscribe()` 与 `QueueRunnerEvent`。

- [ ] **Step 1: 写“暂停必须先中止当前动作”失败测试**

```ts
it("aborts the running action before marking the task suspended", async () => {
  const harness = createQueuedActionRunnerHarness();
  harness.enqueue({ kind: "wait", milliseconds: 10_000 });
  await harness.untilRunning();

  harness.runner.suspend(harness.taskLease, "owner_message");

  await expect(harness.untilIdle()).resolves.toBeUndefined();
  expect(harness.abortObserved).toBe(true);
  expect(harness.queue.snapshot().items[0]?.status).toBe("suspended");
});
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/unit/queuedActionRunner.test.ts tests/unit/actionExecutor.test.ts`

Expected: FAIL，缺少 `QueuedActionRunner`。

- [ ] **Step 3: 实现单消费者循环和取消栅栏**

```ts
export type QueueRunnerEvent =
  | { readonly kind: "batch_completed"; readonly taskLease: TaskLease }
  | { readonly kind: "action_failed"; readonly taskLease: TaskLease; readonly reason: string }
  | { readonly kind: "world_stale"; readonly taskLease: TaskLease }
  | { readonly kind: "budget_boundary"; readonly taskLease: TaskLease; readonly reason: string };

export class QueuedActionRunner {
  start(): void;
  suspend(taskLease: TaskLease, reason: string): void;
  resumeAfterReplan(taskLease: TaskLease, worldGeneration: number): void;
  cancelTask(taskLease: TaskLease, reason: string): void;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: QueueRunnerEvent) => void): () => void;
}
```

每次通过 `claimNext()` 取出动作时创建新的 `AbortController` 和运行代次。暂停或取消先增加代次并调用 `ActionExecutor.stopAll()`，再提交队列状态；旧 Promise 完成时只有代次仍匹配才能提交结果。一次传输级重试只允许在 `ActionResult.status === "failed"` 且执行器明确返回 `worldMutated: false` 时发生，并删除 `ActionExecutor` 现有的隐式移动/跟随重试，避免双重重试。`QueueRunnerEvent` 精确区分 `batch_completed`、`action_failed`、`world_stale` 和 `budget_boundary`，供执行模型重新观察和规划。

- [ ] **Step 4: 验证取消、失败和迟到回调**

补充测试：FIFO 消费、失败后停止本批并发出 `action_failed`、一次允许重试、发生世界改动时不重试、世界代次变化发出 `world_stale`、预算边界发出 `budget_boundary`、敌对危险/死亡/断线/主人变化取消活动工作、取消后迟到成功不能复活、不同租约隔离、未经过新观察和重新规划不能恢复 suspended 项、`waitForIdle()` 在清理结束后才完成。

Run: `npx vitest run tests/unit/queuedActionRunner.test.ts tests/unit/actionExecutor.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/actions/queuedActionRunner.ts src/actions/actionExecutor.ts tests/unit/queuedActionRunner.test.ts tests/unit/actionExecutor.test.ts
git commit -m "feat: execute queued Minecraft actions safely"
```

### Task 3: 在意图判断前抢占当前动作

**Files:**
- Modify: `src/app.ts`
- Modify: `src/companion/companionService.ts`
- Modify: `src/companion/intentRouter.ts`
- Modify: `tests/unit/intentRouter.test.ts`
- Modify: `tests/integration/companionService.test.ts`
- Modify: `tests/integration/app.test.ts`
- Modify: `tests/support/companionHarness.ts`

**Interfaces:**
- Consumes: `QueuedActionRunner.suspend()` 与 `CompanionActionQueue`。
- Produces: 新意图种类 `priority_task`，用于临时帮助并保留旧任务；普通 `replace_task` 仍取消旧任务。

- [ ] **Step 1: 写主人消息即时暂停失败测试**

```ts
it("suspends physical work before the owner intent turn resolves", async () => {
  const value = await harness({ deferredIntentTurns: [1], activeMinecraftWait: true });
  await value.start();
  await startPlayerTurn(value, "继续挖矿");
  await value.untilMinecraftWait();

  await value.emitOwnerText("今天天气怎么样？");

  expect(value.queueEvents.at(-1)?.status).toBe("suspended");
  expect(value.codex.pendingIntentTurns()).toBe(1);
});
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/unit/intentRouter.test.ts tests/integration/companionService.test.ts`

Expected: FAIL，消息进入意图模型时动作仍在运行，且 schema 不接受 `priority_task`。

- [ ] **Step 3: 扩展意图 schema 并接入抢占**

```ts
type OwnerIntentDecision =
  | ExistingOwnerIntentDecision
  | {
      kind: "priority_task";
      naturalReply: string | null;
      task: ValidatedTaskRequest;
      memoryCandidates: readonly IntentMemoryCandidate[];
    };
```

收到已认证主人消息时，先记录当前任务租约并调用队列运行器 `suspend(..., "owner_message")`，再启动意图回合。`priority_task` 把旧任务和旧队列放入仅内存的 suspended stack；优先任务完成后，取消旧的精确动作，使用新世界快照启动旧目标的新执行回合，禁止直接继续旧坐标动作。`createApp` 在本任务实例化并注入一个共享 queue/runner，使生产运行时和测试使用同一抢占路径。

- [ ] **Step 4: 验证 stop、聊天、帮助和替换**

补充测试：

- `stop_task` 清空当前及 suspended stack；
- 聊天结束后只通过重新规划恢复；
- “先来帮我一下”由模型输出 `priority_task`，新任务先执行 `follow_owner`，旧队列保留；
- 帮助完成后旧目标获得新执行回合；
- `replace_task` 不保留旧任务；
- `clarify` 在主人补充关键信息前保持旧队列暂停；
- 已可执行的自然语言任务不会反问“要聊天还是要做事”；
- stale intent 不能恢复已停止队列。

Run: `npx vitest run tests/unit/intentRouter.test.ts tests/integration/companionService.test.ts tests/integration/app.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/app.ts src/companion/companionService.ts src/companion/intentRouter.ts tests/unit/intentRouter.test.ts tests/integration/companionService.test.ts tests/integration/app.test.ts tests/support/companionHarness.ts
git commit -m "feat: preempt companion work on owner messages"
```

### Task 4: 给 AI 提供严格的队列操作工具

**Files:**
- Create: `src/mcp/queuedActionSchema.ts`
- Modify: `src/actions/actionQueue.ts`
- Modify: `src/app.ts`
- Modify: `src/mcp/toolRegistry.ts`
- Modify: `src/mcp/toolBudget.ts`
- Modify: `src/codex/minecraftDynamicTools.ts`
- Modify: `tests/unit/actionQueue.test.ts`
- Modify: `tests/integration/app.test.ts`
- Modify: `tests/unit/toolRegistry.test.ts`
- Modify: `tests/unit/minecraftDynamicTools.test.ts`
- Modify: `tests/integration/appServerClient.test.ts`

**Interfaces:**
- Consumes: 所有允许排队的 `GameAction`、活动 `turnLease`、`CompanionActionQueue`。
- Produces: `minecraft_enqueue_actions`、`minecraft_get_action_queue`、`minecraft_cancel_queued_actions`。

- [ ] **Step 1: 写严格 schema 失败测试**

```ts
it("accepts an explicit bounded action list and rejects executable payloads", () => {
  expect(() =>
    tools.minecraft_enqueue_actions.schema.parse(
      leased(harness, { actions: [{ kind: "jump", summary: "跳一下" }] }),
    ),
  ).not.toThrow();
  expect(() =>
    tools.minecraft_enqueue_actions.schema.parse(
      leased(harness, { actions: [{ kind: "shell", command: "dir" }] }),
    ),
  ).toThrow();
});
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/unit/actionQueue.test.ts tests/unit/toolRegistry.test.ts tests/unit/minecraftDynamicTools.test.ts tests/integration/appServerClient.test.ts tests/integration/app.test.ts`

Expected: FAIL，工具不存在。

- [ ] **Step 3: 实现判别联合与队列工具**

```ts
export const queuedActionSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move_to"), x: coordinate, y: coordinate, z: coordinate, summary }),
  z.object({ kind: z.literal("follow_owner"), distance: z.number().int().min(2).max(16), summary }),
  z.object({ kind: z.literal("look_at"), x: coordinate, y: coordinate, z: coordinate, summary }),
  z.object({ kind: z.literal("jump"), summary }),
  z.object({ kind: z.literal("dig_block"), x: coordinate, y: coordinate, z: coordinate, blockName: identifier, summary }),
  z.object({ kind: z.literal("place_block"), x: coordinate, y: coordinate, z: coordinate, blockName: identifier, summary }),
  z.object({ kind: z.literal("craft_item"), itemName: identifier, count, summary }),
  z.object({ kind: z.literal("smelt_item"), itemName: identifier, count, summary }),
  z.object({ kind: z.literal("collect_dropped"), entityId: z.number().int().nonnegative(), summary }),
  z.object({ kind: z.literal("equip_item"), itemName: identifier, destination: z.enum(["hand", "head", "torso", "legs", "feet"]), summary }),
  z.object({ kind: z.literal("attack_hostile"), entityId: z.number().int().nonnegative(), summary }),
  z.object({ kind: z.literal("wait"), milliseconds: z.number().int().min(100).max(10_000), summary }),
]);
```

`minecraft_enqueue_actions` 最多接受 64 个显式动作，一次调用只计一次模型工具调用；每个物理动作仍分别接受动作白名单和物理预算校验。工具从受信世界快照生成 `trustedObservationKey`，模型不能提供或覆盖它；同一任务、同一规范化动作参数、同一观察键和同一规范化失败原因最多允许 AI 重新入队两次，第三次原子拒绝，只有动作参数或可信观察实际变化才重置该限制。队列快照返回脱敏投影；取消工具只能取消同一任务租约的等待项。

执行线程的模型工具目录只暴露读取类工具、`minecraft_enqueue_actions`、`minecraft_get_action_queue` 和 `minecraft_cancel_queued_actions`；现有 `minecraft_move_to`、`minecraft_dig_block` 等直接物理工具不再暴露给执行模型，但继续由队列运行器通过 `ActionExecutor` 内部调用。`minecraft_say` 保留为非物理对话输出。意图线程仍然没有任何队列或物理动作工具。

- [ ] **Step 4: 验证动态工具边界**

补充测试：未知字段拒绝、未知动作拒绝、超过 64 项拒绝、同一任务队列超过 256 拒绝、动作不在当前 allowlist 时整批原子拒绝、无效租约拒绝、直接物理工具不再出现在 execution 模型目录、intent 线程没有队列工具、同一错误和观察下第三次语义重入队失败、观察或参数变化后可以提交。

Run: `npx vitest run tests/unit/toolRegistry.test.ts tests/unit/minecraftDynamicTools.test.ts tests/integration/appServerClient.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/actions/actionQueue.ts src/app.ts src/mcp/queuedActionSchema.ts src/mcp/toolRegistry.ts src/mcp/toolBudget.ts src/codex/minecraftDynamicTools.ts tests/unit/actionQueue.test.ts tests/unit/toolRegistry.test.ts tests/unit/minecraftDynamicTools.test.ts tests/integration/appServerClient.test.ts tests/integration/app.test.ts
git commit -m "feat: let the model manage a bounded action queue"
```

### Task 5: 在运行时和桌面控制台显示脱敏队列

**Files:**
- Modify: `src/app.ts`
- Modify: `src/runtime/runtimeEvents.ts`
- Modify: `src/runtime/runtimeFacade.ts`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `src/desktop/childServer.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/desktopApi.ts`
- Modify: `apps/desktop/src/i18n/messageKeys.ts`
- Modify: `apps/desktop/src/i18n/en.ts`
- Modify: `apps/desktop/src/i18n/zh-CN.ts`
- Modify: `apps/desktop/src/pages/DiagnosticsPage.tsx`
- Modify: `apps/desktop/src/pages/DiagnosticsPage.test.tsx`
- Modify: `apps/desktop/src/App.task5.test.tsx`
- Modify: `tests/integration/app.test.ts`
- Modify: `tests/integration/runtimeFacade.test.ts`
- Modify: `tests/unit/desktopProtocol.test.ts`
- Modify: `tests/integration/desktopChildServer.test.ts`

**Interfaces:**
- Consumes: `ActionQueueSnapshot` 与当前 `PublicTaskSnapshot.goal`。
- Produces: `RuntimeSnapshot.actionQueue` 和诊断页“AI 动作队列”区域。

- [ ] **Step 1: 写协议脱敏失败测试**

```ts
it("round-trips a bounded queue projection without authority fields", () => {
  const snapshot = runtimeSnapshot({
    actionQueue: {
      goal: "制作面包",
      items: [{ index: 1, kind: "find_blocks", summary: "寻找成熟小麦", status: "waiting", retryCount: 0 }],
    },
  });
  const parsed = runtimeSnapshotSchema.parse(snapshot);
  expect(parsed.actionQueue.items[0]?.summary).toBe("寻找成熟小麦");
  expect(JSON.stringify(parsed.actionQueue)).not.toContain("lease");
});
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/integration/app.test.ts tests/integration/runtimeFacade.test.ts tests/unit/desktopProtocol.test.ts tests/integration/desktopChildServer.test.ts apps/desktop/src/App.task5.test.tsx apps/desktop/src/pages/DiagnosticsPage.test.tsx`

Expected: FAIL，`RuntimeSnapshot` 不含 `actionQueue`。

- [ ] **Step 3: 扩展运行时投影和 UI**

```ts
export interface RuntimeActionQueueProjection {
  readonly goal: string | null;
  readonly items: readonly {
    index: number;
    kind: string;
    summary: string;
    status: QueueItemStatus;
    retryCount: number;
    enqueuedAt: string;
    startedAt?: string;
    endedAt?: string;
    reason?: string;
  }[];
}
```

协议限制目标 160 字符、kind 64 字符、summary 160 字符、reason 240 字符、三个时间字段必须是规范 ISO 时间、最多 256 项；严格拒绝额外字段。`RuntimeEventPayload` 增加严格的 `action_queue` 事件。诊断页通过 `status()` 和 `subscribeRuntime()` 读取运行时投影，以表格展示顺序、动作、摘要、状态、入队/开始/结束时间、重试和原因，不抓取日志文件，也不增加聊天输出；`App.tsx` 向该页传入完整桌面 API，所有列名和状态补齐中英文文案。

`src/app.ts` 订阅队列事件并用现有 `SafeLogger` 写入 `action_queue_item_changed` 结构化日志；字段白名单只有顺序、kind、受限摘要、状态、重试次数、三个时间和受限原因，不记录租约、观察键、完整动作参数、主人原文或模型提示。日志失败只进入现有受控健康路径，不能改变队列状态。

- [ ] **Step 4: 验证 UI 与终止快照**

补充测试：运行中更新、停止后显示 cancelled、`waiting_permission` 可见、终止运行时不暴露活动权限、child server 只转发严格投影、结构化日志没有租约/坐标/主人原文、UI 空状态、256 项渲染边界、英文和中文标签、卸载页面后取消 runtime 订阅。

Run: `npx vitest run tests/integration/app.test.ts tests/integration/runtimeFacade.test.ts tests/unit/desktopProtocol.test.ts tests/integration/desktopChildServer.test.ts apps/desktop/src/App.task5.test.tsx apps/desktop/src/pages/DiagnosticsPage.test.tsx`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/app.ts src/runtime/runtimeEvents.ts src/runtime/runtimeFacade.ts src/desktop/desktopProtocol.ts src/desktop/childServer.ts apps/desktop/src/App.tsx apps/desktop/src/desktopApi.ts apps/desktop/src/i18n/messageKeys.ts apps/desktop/src/i18n/en.ts apps/desktop/src/i18n/zh-CN.ts apps/desktop/src/pages/DiagnosticsPage.tsx apps/desktop/src/pages/DiagnosticsPage.test.tsx apps/desktop/src/App.task5.test.tsx tests/integration/app.test.ts tests/integration/runtimeFacade.test.ts tests/unit/desktopProtocol.test.ts tests/integration/desktopChildServer.test.ts
git commit -m "feat: expose sanitized AI queue diagnostics"
```

### Task 6: 扩展生活与观察动作接口

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/actions/actionExecutor.ts`
- Modify: `src/minecraft/minecraftPort.ts`
- Modify: `src/minecraft/fakeMinecraftPort.ts`
- Modify: `src/minecraft/mineflayerAdapter.ts`
- Modify: `tests/unit/toolBudget.test.ts`
- Modify: `tests/unit/actionExecutor.test.ts`

**Interfaces:**
- Produces new `GameAction` kinds: `fish`、`consume_item`、`sleep_in_bed`、`wake_up`、`till_soil`、`plant_crop`、`harvest_crop`。
- Produces read models: `InspectedBlock`、`BlockSearchQuery`、`BlockSearchResult`、`FurnaceSnapshot`。

- [ ] **Step 1: 写类型清单与预算失败测试**

```ts
expect(GAME_ACTION_KINDS).toContain("fish");
expect(GAME_ACTION_KINDS).toContain("consume_item");
expect(GAME_ACTION_KINDS).toContain("sleep_in_bed");
expect(TOOL_ACTION_KINDS).toContain("inspect_block");
expect(TOOL_ACTION_KINDS).toContain("find_blocks");
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/unit/toolBudget.test.ts tests/integration/mineflayerAdapter.test.ts`

Expected: FAIL，动作种类不存在。

- [ ] **Step 3: 定义窄用途接口**

```ts
export interface InspectedBlock {
  readonly name: string;
  readonly position: Vec3;
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}

export interface BlockSearchQuery {
  readonly names?: readonly string[];
  readonly tag?: "bed" | "water" | "mature_wheat";
  readonly maxDistance: number;
  readonly maxResults: number;
}

export interface BlockSearchResult {
  readonly blocks: readonly InspectedBlock[];
  readonly truncated: boolean;
}

export interface InventoryDelta {
  readonly added: readonly { readonly name: string; readonly count: number }[];
  readonly removed: readonly { readonly name: string; readonly count: number }[];
}

export interface FoodDelta {
  readonly healthBefore: number;
  readonly healthAfter: number;
  readonly foodBefore: number;
  readonly foodAfter: number;
}

export interface FurnaceSnapshot {
  readonly position: Vec3;
  readonly input: { readonly name: string; readonly count: number } | null;
  readonly fuel: { readonly name: string; readonly count: number } | null;
  readonly output: { readonly name: string; readonly count: number } | null;
  readonly progress: number;
}

export interface MinecraftPort {
  inspectBlock(position: Vec3): Promise<InspectedBlock | null>;
  findBlocks(query: BlockSearchQuery): Promise<BlockSearchResult>;
  fish(signal: AbortSignal): Promise<InventoryDelta>;
  consumeItem(itemName: string, signal: AbortSignal): Promise<FoodDelta>;
  sleepInBed(position: Vec3, signal: AbortSignal): Promise<void>;
  wakeUp(signal: AbortSignal): Promise<void>;
  tillSoil(position: Vec3, signal: AbortSignal): Promise<void>;
  plantCrop(position: Vec3, seedName: "wheat_seeds", signal: AbortSignal): Promise<void>;
  harvestCrop(position: Vec3, cropName: "wheat", signal: AbortSignal): Promise<void>;
  furnaceSnapshot(position: Vec3): Promise<FurnaceSnapshot>;
}
```

所有数组最多 32 项，物品/方块名最多 64 字符，属性最多 16 个，字符串属性最多 64 字符；`progress` 必须为 0..1 的有限数。Task 6 同时给 `ActionExecutor` 增加新 `GameAction` 到对应 `MinecraftPort` 方法的穷尽分派，并先在 `MineflayerAdapter` 增加明确抛出 `living action is not implemented` 的失败关闭方法，使接口和 `npm run typecheck` 在本任务结束时完整；Task 7 和 Task 8 再按红灯测试逐个替换为真实实现。

- [ ] **Step 4: 更新 fake 并验证所有动作可被穷举**

Fake 必须记录方法调用、支持 AbortSignal、返回不可变副本。补充类型穷尽测试，保证 `GAME_ACTION_KINDS`、`TOOL_ACTION_KINDS`、风险分类和执行器 switch 没有遗漏。

Run: `npx vitest run tests/unit/toolBudget.test.ts tests/unit/actionExecutor.test.ts tests/integration/mineflayerAdapter.test.ts && npm run typecheck`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/domain/types.ts src/actions/actionExecutor.ts src/minecraft/minecraftPort.ts src/minecraft/fakeMinecraftPort.ts src/minecraft/mineflayerAdapter.ts tests/unit/toolBudget.test.ts tests/unit/actionExecutor.test.ts
git commit -m "feat: define bounded living action interfaces"
```

### Task 7: 实现钓鱼、进食、睡觉和窄范围观察

**Files:**
- Modify: `src/minecraft/mineflayerAdapter.ts`
- Modify: `src/minecraft/mineflayerObservation.ts`
- Modify: `tests/integration/mineflayerAdapter.test.ts`

**Interfaces:**
- Consumes: Mineflayer `bot.fish()`、`bot.consume()`、`bot.sleep()`、`bot.wake()`、方块注册表。
- Produces: Task 6 定义的钓鱼、进食、睡眠、检查和查找实现。

- [ ] **Step 1: 写中断清理失败测试**

```ts
it("retracts fishing and rejects late completion after abort", async () => {
  const value = createAdapterHarness({ fishPending: true });
  const controller = new AbortController();
  const fishing = value.adapter.fish(controller.signal);

  controller.abort();

  await expect(fishing).rejects.toThrow("aborted");
  expect(value.bot.deactivateItem).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/integration/mineflayerAdapter.test.ts`

Expected: FAIL，接口方法尚未实现。

- [ ] **Step 3: 实现 Mineflayer 窄动作**

钓鱼前验证手中为 `fishing_rod`，并用可信方块搜索确认可到达范围内存在适合抛竿的水面；记录背包前后受限差值，并在 abort cleanup 中调用 `deactivateItem()`。进食只接受注册表中 `foodPoints > 0` 且背包真实存在的物品，返回进食前后的生命和饥饿差值。睡眠校验目标方块 `bot.isABed(block)`、未占用、可到达且当前时间允许睡觉；`wakeUp()` 在未睡眠时成功返回，abort 时在已睡眠状态调用 `wake()`。方块状态只返回布尔、有限数字和短字符串属性；搜索最多 32 个结果、最大距离 64，按距离和坐标稳定排序并报告 `truncated`。

- [ ] **Step 4: 覆盖成功和错误边界**

补充测试：缺鱼竿、不可食用物、床占用、白天不能睡、主人消息唤醒、未知方块、搜索标签白名单、搜索结果排序和数量限制、断线期间所有动作失败关闭。

Run: `npx vitest run tests/integration/mineflayerAdapter.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/minecraft/mineflayerAdapter.ts src/minecraft/mineflayerObservation.ts tests/integration/mineflayerAdapter.test.ts
git commit -m "feat: add fishing eating sleeping and block inspection"
```

### Task 8: 实现安全种植、工作台合成和熔炉恢复

**Files:**
- Modify: `src/minecraft/mineflayerAdapter.ts`
- Modify: `src/safety/actionRisk.ts`
- Modify: `src/safety/safetyEngine.ts`
- Modify: `tests/integration/mineflayerAdapter.test.ts`
- Modify: `tests/unit/safetyEngine.test.ts`

**Interfaces:**
- Consumes: Task 6 的作物与熔炉接口。
- Produces: 成熟小麦收割、耕地、播种、自动选择可信工作台、可观察且可中断的熔炉状态，以及 `SafetyContext.wheatFarmingAllowed: boolean`。

- [ ] **Step 1: 写成熟作物与工作台失败测试**

```ts
it("refuses immature wheat and crafts table recipes at a trusted nearby table", async () => {
  await expect(adapter.harvestCrop(wheat({ age: 6 }).position, "wheat", signal)).rejects.toThrow(
    "crop is not mature",
  );
  await adapter.craftItem("bread", 1, signal);
  expect(bot.craft).toHaveBeenCalledWith(expect.anything(), 1, craftingTableBlock);
});
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/integration/mineflayerAdapter.test.ts tests/unit/safetyEngine.test.ts`

Expected: FAIL，作物动作不存在且合成仍传入 `null` 工作台。

- [ ] **Step 3: 实现窄用途世界改动**

`harvestCrop` 只接受 `wheat` 且要求 `age === maxAge`；`tillSoil` 只接受 `dirt` 或 `grass_block`、上方为空且手中可用锄头；`plantCrop` 只接受 `wheat_seeds`、可信 `farmland`、上方为空且当前光照满足小麦存活。三者都使用当前运行代次和 abort cleanup；`SafetyContext.wheatFarmingAllowed` 缺失或 false 时，`till_soil` 和 `plant_crop` 永久拒绝，队列入队与真正执行各读取一次最新上下文。适配器本身不能把缺失权限转换成通用物品使用。

`craftItem` 先尝试背包 2×2 配方，再寻找 16 格内工作台并查询 table recipe；没有工作台时返回明确错误供 AI 重新规划。熔炉中断后关闭窗口但不假定槽位为空；`furnaceSnapshot` 返回受限输入、燃料、输出和进度，后续 `smeltItem` 能继续属于 WhiteLily 当前任务的兼容槽位。

- [ ] **Step 4: 验证安全与恢复**

补充测试：未成熟作物不变、已有非小麦设施不改、非耕地不能播种、种子不足、工具缺失、工作台太远、熔炉含不兼容物品、熔炉中断后状态可读、兼容部分熔炼继续、取消时窗口关闭。

Run: `npx vitest run tests/integration/mineflayerAdapter.test.ts tests/unit/safetyEngine.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/minecraft/mineflayerAdapter.ts src/safety/actionRisk.ts src/safety/safetyEngine.ts tests/integration/mineflayerAdapter.test.ts tests/unit/safetyEngine.test.ts
git commit -m "feat: add safe crops stations and furnace recovery"
```

### Task 9: 注册生活队列动作与即时观察工具

**Files:**
- Modify: `src/actions/actionExecutor.ts`
- Modify: `src/mcp/queuedActionSchema.ts`
- Modify: `src/mcp/toolRegistry.ts`
- Modify: `src/mcp/toolBudget.ts`
- Modify: `tests/unit/actionExecutor.test.ts`
- Modify: `tests/unit/toolRegistry.test.ts`
- Modify: `tests/unit/minecraftDynamicTools.test.ts`

**Interfaces:**
- Produces immediate read tools: `minecraft_inspect_block`、`minecraft_find_blocks`、`minecraft_get_furnace_state`。
- Extends `minecraft_enqueue_actions` with physical kinds: `fish`、`consume_item`、`sleep_in_bed`、`wake_up`、`till_soil`、`plant_crop`、`harvest_crop`。

- [ ] **Step 1: 写工具目录失败测试**

```ts
expect(MINECRAFT_TOOL_NAMES).toEqual(
  expect.arrayContaining(["minecraft_inspect_block", "minecraft_find_blocks", "minecraft_get_furnace_state"]),
);
expect(MINECRAFT_TOOL_NAMES).not.toEqual(
  expect.arrayContaining(["minecraft_fish", "minecraft_till_soil", "minecraft_sleep_in_bed"]),
);
expect(() =>
  tools.minecraft_enqueue_actions.schema.parse(
    leased(harness, { actions: [{ kind: "plant_crop", x: 1, y: 64, z: 1, seedName: "carrot", summary: "种胡萝卜" }] }),
  ),
).toThrow();
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/unit/actionExecutor.test.ts tests/unit/toolRegistry.test.ts tests/unit/minecraftDynamicTools.test.ts`

Expected: FAIL，新工具不存在。

- [ ] **Step 3: 实现工具 schema、预算和执行分派**

所有坐标使用 finite number；物品标识沿用现有 64 字符 identifier；`find_blocks` 的 names 为 1..8 个精确标识或单个允许标签，结果 1..32，距离 1..64；种植只允许 `wheat_seeds`；收割只允许 `wheat`。作物改动每次消耗一个 block change；首次耕地计入危险操作分类，但不能绕过农田权限。读取工具立即执行且不能修改世界；其余新动作只能作为 `minecraft_enqueue_actions` 的判别联合成员进入队列，绝不注册同名直接物理 MCP 工具。`ActionExecutor` 在本任务补齐每种新动作的超时、取消结果和 `worldMutated` 证据；失败时默认 `worldMutated: true`，只有适配器明确证明背包、方块、实体和姿态都没有变化时才返回 false。

- [ ] **Step 4: 验证错误和授权**

补充测试：读取工具不在任务白名单、stale turnLease、非法标签、超大搜索、未观察坐标、种植权限缺失、取消中的队列结果、直接 `minecraft_fish`/`minecraft_till_soil` 工具不存在、ActionExecutor 每个新 kind 的分派、timeout 与世界改动证据。

Run: `npx vitest run tests/unit/actionExecutor.test.ts tests/unit/toolRegistry.test.ts tests/unit/minecraftDynamicTools.test.ts tests/integration/appServerClient.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/actions/actionExecutor.ts src/mcp/queuedActionSchema.ts src/mcp/toolRegistry.ts src/mcp/toolBudget.ts tests/unit/actionExecutor.test.ts tests/unit/toolRegistry.test.ts tests/unit/minecraftDynamicTools.test.ts tests/integration/appServerClient.test.ts
git commit -m "feat: add bounded living queue actions and observations"
```

### Task 10: 持久化全局小麦种植权限

**Files:**
- Create: `src/profile/farmingPreferenceStore.ts`
- Create: `tests/unit/farmingPreferenceStore.test.ts`
- Modify: `src/app.ts`
- Modify: `src/desktop/childMain.ts`
- Modify: `tests/integration/app.test.ts`
- Modify: `tests/integration/desktopChildServer.test.ts`

**Interfaces:**
- Produces: `FarmingPreferenceStore.read()`、`setAllowed()`、`setDenied()`，状态为 `"unknown" | "allowed" | "denied"`。
- Storage path: `config/farming-preference.json`，主人级全局文件，不包含 world ID。
- Application projection: app 启动时先读取 store，并把当前 `status === "allowed"` 注入每次新建的 `SafetyContext.wheatFarmingAllowed`；写入成功后原子更新内存投影。

- [ ] **Step 1: 写跨世界持久化失败测试**

```ts
it("keeps one approval across locations and worlds", async () => {
  const store = new FarmingPreferenceStore({ rootDirectory });
  await store.setAllowed(0);
  const restarted = new FarmingPreferenceStore({ rootDirectory });

  expect((await restarted.read()).value.status).toBe("allowed");
});
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/unit/farmingPreferenceStore.test.ts tests/integration/app.test.ts`

Expected: FAIL，store 不存在。

- [ ] **Step 3: 使用 DocumentStore 实现修订保护**

```ts
export const farmingPreferenceSchema = z
  .object({
    status: z.enum(["unknown", "allowed", "denied"]),
    updatedAt: z.string().datetime(),
  })
  .strict();
```

沿用 `ModelPreferenceStore` 的 `DocumentStore` 模式、严格 schema、revision CAS 和原子 JSON 写入。文件中不保存世界、坐标、主人聊天原文或租约。

- [ ] **Step 4: 验证迁移与组合**

补充测试：缺失文件默认为 unknown、损坏文件失败关闭、并发 revision 冲突、allowed 跨重启、denied 跨重启、app/desktop child 使用同一路径。

Run: `npx vitest run tests/unit/farmingPreferenceStore.test.ts tests/integration/app.test.ts tests/integration/desktopChildServer.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/profile/farmingPreferenceStore.ts tests/unit/farmingPreferenceStore.test.ts src/app.ts src/desktop/childMain.ts tests/integration/app.test.ts tests/integration/desktopChildServer.test.ts
git commit -m "feat: persist global wheat farming permission"
```

### Task 11: 实现自然语言种植许可与 30 秒回退

**Files:**
- Create: `src/companion/farmingPermissionCoordinator.ts`
- Create: `tests/unit/farmingPermissionCoordinator.test.ts`
- Modify: `src/companion/intentRouter.ts`
- Modify: `src/companion/companionService.ts`
- Modify: `src/companion/promptBuilder.ts`
- Modify: `tests/unit/intentRouter.test.ts`
- Modify: `tests/unit/promptBuilder.test.ts`
- Modify: `tests/integration/companionService.test.ts`

**Interfaces:**
- Produces intent kinds: `grant_farming_permission`、`deny_farming_permission`、`revoke_farming_permission`。
- Produces coordinator result: `"allowed" | "denied" | "timeout" | "cancelled"`。
- Consumes: `CompanionActionQueue.beginPermissionWait()` 与 `resolvePermission()`，让诊断中的许可项处于 `waiting_permission`。

- [ ] **Step 1: 写许可超时失败测试**

```ts
it("falls back after 30 seconds without changing land", async () => {
  vi.useFakeTimers();
  const value = await harness({ farmingPreference: "unknown" });
  await value.requestFarmingPermission(candidatePlot);

  await vi.advanceTimersByTimeAsync(30_000);

  expect(value.permissionResult).toBe("timeout");
  expect(value.minecraft.calls).not.toContainEqual(expect.objectContaining({ method: "tillSoil" }));
  expect(value.executionPrompts.at(-1)).toContain("寻找现成的成熟小麦");
});
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/unit/farmingPermissionCoordinator.test.ts tests/unit/intentRouter.test.ts tests/unit/promptBuilder.test.ts tests/integration/companionService.test.ts`

Expected: FAIL，协调器和许可意图不存在。

- [ ] **Step 3: 实现单一活动许可票据**

```ts
export interface FarmingPermissionRequest {
  readonly plotSummary: string;
  readonly requestedAt: number;
}

export class FarmingPermissionCoordinator {
  request(input: FarmingPermissionRequest): Promise<FarmingPermissionResult>;
  resolve(result: "allowed" | "denied"): void;
  cancel(reason: string): void;
}
```

服务只发送自然句“我可以在这里种小麦吗？”，不发送票据 ID 或坐标，同时创建一个不可执行的 `waiting_permission` 队列项。pending 时意图 prompt 明确要求把主人自然回答分类为 grant/deny；等待期间其他可逆或不改动土地的队列动作可以继续，但 `till_soil` 和 `plant_crop` 入队失败。allowed 写入全局 store、结束许可项并永不因换世界重问；denied/timeout 结束许可项并唤醒 AI，附加“不得新建农田，寻找现成成熟小麦”约束。revoke 立即写 denied，并取消等待或排队中的 till/plant；主人随后用明确自然语言重新授权时可恢复 `allowed`，不要求当时必须存在 pending 票据。

- [ ] **Step 4: 验证一次授权和撤销**

补充测试：30 秒边界、停止取消 timer、同一时刻只有一个票据、诊断项从 `waiting_permission` 进入终止状态、等待期间可继续观察但不能耕地/播种、allowed 后新世界不询问、普通“可以”只在 pending 时解释为许可、拒绝无土地改动、撤销取消排队种植、撤销后明确重新授权恢复 allowed、迟到回复不复活过期票据。

Run: `npx vitest run tests/unit/farmingPermissionCoordinator.test.ts tests/unit/intentRouter.test.ts tests/unit/promptBuilder.test.ts tests/integration/companionService.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/companion/farmingPermissionCoordinator.ts tests/unit/farmingPermissionCoordinator.test.ts src/companion/intentRouter.ts src/companion/companionService.ts src/companion/promptBuilder.ts tests/unit/intentRouter.test.ts tests/unit/promptBuilder.test.ts tests/integration/companionService.test.ts
git commit -m "feat: add conversational wheat farming permission"
```

### Task 12: 让 AI 动态规划烤鱼、面包和作物复查

**Files:**
- Create: `src/companion/farmObservationScheduler.ts`
- Create: `tests/unit/farmObservationScheduler.test.ts`
- Modify: `src/companion/promptBuilder.ts`
- Modify: `src/companion/companionService.ts`
- Modify: `tests/unit/promptBuilder.test.ts`
- Modify: `tests/integration/companionService.test.ts`

**Interfaces:**
- Produces: `FarmObservationScheduler.schedule()`、`cancelWorld()`、`due()`。
- Prompt output: 当前目标、可信状态、队列快照、可用通用工具和“不得使用固定步骤”的约束。

- [ ] **Step 1: 写“不同背包产生不同队列”失败测试**

```ts
it("gives the model live alternatives instead of a cooked-fish macro", () => {
  const prompt = buildCompanionTaskExecutionTurn(inputWithInventory(["furnace", "coal"]));
  expect(prompt).toContain("根据实时背包和世界状态决定下一组动作");
  expect(prompt).not.toContain("制作鱼竿 -> 钓鱼 -> 挖八块圆石");
  expect(prompt).toContain("minecraft_enqueue_actions");
});
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/unit/promptBuilder.test.ts tests/unit/farmObservationScheduler.test.ts tests/integration/companionService.test.ts`

Expected: FAIL，prompt 和调度器尚不存在。

- [ ] **Step 3: 实现动态规划上下文和非阻塞作物检查**

执行 prompt 提供：

- 当前队列脱敏状态；
- 当前背包、附近水、工作台、熔炉、成熟小麦和床；
- 新生活工具说明；
- 一次最多入队 64 个动作；
- 每批结束或失败后先观察再规划；
- `batch_completed`、`action_failed`、`world_stale`、许可完成/超时和预算边界事件都会开启新的执行回合；
- 禁止假定材料存在、禁止叙述队列、禁止固定食物步骤。

`FarmObservationScheduler` 只保存世界生成、受限位置、最早检查时间和目的 `wheat_maturity`。到期后发出观察事件，不直接收割；由 AI 观察并决定。

- [ ] **Step 4: 验证适应性和停止**

集成测试用不同起始背包模拟：

- 已有熟鱼时不钓鱼；
- 已有生鱼和熔炉时不制作鱼竿；
- 缺熔炉时 AI 可选择采矿/合成/放置；
- 已有小麦时不申请种地；
- 权限 timeout 后只允许 find/harvest 现成小麦；
- 作物等待不占用物理队列；
- world_changed 取消旧农田检查。
- 已可由可信观察和工具执行的任务直接规划，不反问主人要聊天还是做事。

Run: `npx vitest run tests/unit/promptBuilder.test.ts tests/unit/farmObservationScheduler.test.ts tests/integration/companionService.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/companion/farmObservationScheduler.ts tests/unit/farmObservationScheduler.test.ts src/companion/promptBuilder.ts src/companion/companionService.ts tests/unit/promptBuilder.test.ts tests/integration/companionService.test.ts
git commit -m "feat: let AI adapt food and farming plans"
```

### Task 13: 校验并执行 AI 生成的房屋方块计划

**Files:**
- Create: `src/actions/blockPlanValidator.ts`
- Create: `tests/unit/blockPlanValidator.test.ts`
- Modify: `src/mcp/queuedActionSchema.ts`
- Modify: `src/mcp/toolRegistry.ts`
- Modify: `src/companion/promptBuilder.ts`
- Modify: `tests/unit/toolRegistry.test.ts`
- Modify: `tests/unit/promptBuilder.test.ts`
- Modify: `tests/integration/companionService.test.ts`

**Interfaces:**
- Consumes: AI 生成的显式 `dig_block` / `place_block` 列表、可信快照、安全上下文、任务预算。
- Produces: `validateBlockPlan(input): BlockPlanDecision`，整批通过或整批拒绝。

- [ ] **Step 1: 写危险材料与碰撞失败测试**

```ts
it("rejects dangerous materials and owner collisions atomically", () => {
  expect(
    validateBlockPlan(plan([{ kind: "place_block", blockName: "tnt", x: 2, y: 64, z: 2 }])),
  ).toEqual({ ok: false, reason: "dangerous block material" });
  expect(
    validateBlockPlan(plan([{ kind: "place_block", blockName: "oak_planks", ...ownerPosition }])),
  ).toEqual({ ok: false, reason: "plan collides with owner" });
});
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/unit/blockPlanValidator.test.ts tests/unit/toolRegistry.test.ts tests/unit/promptBuilder.test.ts tests/integration/companionService.test.ts`

Expected: FAIL，validator 不存在。

- [ ] **Step 3: 实现整批静态校验**

校验以下规则：最多 256 次方块改动；坐标有限且位于当前授权范围；材料不在 `command_block`、TNT、火、岩浆、传送门和危险变体集合；不与主人或可信可见玩家占用格碰撞；不越过 spawn 保护边界；同一坐标不能被重复放置；支持方块顺序必须可满足；动作种类和材料在任务 allowlist 内。

prompt 只给房屋结果约束：小型封闭、安全入口、照明、工作区、资源允许时两张床；明确禁止固定蓝图，要求 AI 提交自己生成的坐标和材料计划。

- [ ] **Step 4: 验证动态计划与中断**

补充测试：平坦/坡地生成不同模型输出、材料替换、计划超预算整批拒绝、执行中地形变化使后续失败并触发重新规划、停止保留已完成方块且取消剩余项、不得自动回滚。

Run: `npx vitest run tests/unit/blockPlanValidator.test.ts tests/unit/toolRegistry.test.ts tests/unit/promptBuilder.test.ts tests/integration/companionService.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/actions/blockPlanValidator.ts tests/unit/blockPlanValidator.test.ts src/mcp/queuedActionSchema.ts src/mcp/toolRegistry.ts src/companion/promptBuilder.ts tests/unit/toolRegistry.test.ts tests/unit/promptBuilder.test.ts tests/integration/companionService.test.ts
git commit -m "feat: validate AI generated house plans"
```

### Task 14: 持久化目标而不是陈旧物理动作

**Files:**
- Create: `src/companion/actionQueueStateStore.ts`
- Create: `tests/unit/actionQueueStateStore.test.ts`
- Modify: `src/companion/companionService.ts`
- Modify: `src/app.ts`
- Modify: `src/desktop/childMain.ts`
- Modify: `tests/integration/companionService.test.ts`
- Modify: `tests/integration/app.test.ts`
- Modify: `tests/integration/desktopChildServer.test.ts`

**Interfaces:**
- Produces: `ActionQueueStateStore.read()` 与 `replace(expectedRevision, value)`。
- Stores: 高层目标摘要、没有动作参数的脱敏队列生命周期元数据、农田观察目标。
- Never stores: turnLease、taskLease ID、原始主人消息、活动动作完整参数。

- [ ] **Step 1: 写重启后不执行旧坐标失败测试**

```ts
it("recovers the goal but never replays persisted coordinates", async () => {
  await store.replace(0, {
    unfinishedGoal: "前往目标地点",
    queueItems: [
      {
        kind: "move_to",
        summary: "前往目标地点",
        status: "running",
        retryCount: 0,
        enqueuedAt: "2026-08-15T00:00:00.000Z",
        startedAt: "2026-08-15T00:00:01.000Z",
      },
    ],
    farmObservations: [],
  });
  const recovered = await restartCompanion();

  expect(recovered.executionPrompt).toContain("重新观察并规划");
  expect(recovered.minecraft.calls.filter((call) => call.method === "moveTo")).toEqual([]);
  expect(recovered.queue.items[0]?.status).toBe("cancelled");
});
```

- [ ] **Step 2: 运行红灯**

Run: `npx vitest run tests/unit/actionQueueStateStore.test.ts tests/integration/companionService.test.ts tests/integration/app.test.ts tests/integration/desktopChildServer.test.ts`

Expected: FAIL，store 不存在。

- [ ] **Step 3: 实现严格持久化 schema**

使用 `DocumentStore`，只保存：

```ts
{
  unfinishedGoal: string | null;
  queueItems: Array<{
    kind: string;
    summary: string;
    status: "waiting" | "running" | "suspended" | "waiting_permission" | "completed" | "failed" | "cancelled";
    retryCount: number;
    enqueuedAt: string;
    startedAt?: string;
    endedAt?: string;
    reason?: string;
  }>;
  farmObservations: Array<{ worldId: string; x: number; y: number; z: number; notBefore: string }>;
}
```

持久化队列项从不包含坐标、entity ID、物品数量或其他 `GameAction` 参数。启动时把旧 `waiting`、`running`、`suspended` 和 `waiting_permission` 投影为 `cancelled:process_exit`，只把 `unfinishedGoal` 和新可信快照交给模型。world_changed 删除旧世界精确观察目标；全局 farming preference 位于单独 store，不删除。

- [ ] **Step 4: 验证隐私和生命周期**

补充测试：文件严格字段、坏文件失败关闭、无租约/无原始消息/无物理参数、restart/disconnect/world_changed/owner_changed 行为、活动状态在恢复时终止化、目标恢复需要主人和世界权限、持久化队列元数据长度上限。

Run: `npx vitest run tests/unit/actionQueueStateStore.test.ts tests/integration/companionService.test.ts tests/integration/app.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/companion/actionQueueStateStore.ts tests/unit/actionQueueStateStore.test.ts src/companion/companionService.ts src/app.ts src/desktop/childMain.ts tests/integration/companionService.test.ts tests/integration/app.test.ts tests/integration/desktopChildServer.test.ts
git commit -m "feat: persist safe companion goals and queue history"
```

### Task 15: 完成端到端、桌面打包和真实世界验收

**Files:**
- Modify: `src/app.ts`
- Modify: `src/desktop/childMain.ts`
- Modify: `tests/e2e/companion.e2e.test.ts`
- Modify: `tests/integration/app.test.ts`
- Modify: `tests/integration/desktopChildServer.test.ts`
- Modify: `tests/integration/electronBundle.test.ts`
- Modify: `docs/windows-smoke-test.md`
- Modify: `docs/runtime-architecture.md`

**Interfaces:**
- Validates: 从主人消息到意图、AI 入队、队列执行、控制台投影、停止/帮助、持久化和真实 Minecraft 行为的完整链路。

- [ ] **Step 1: 写端到端验收失败测试**

```ts
it("preempts a queued food task and later replans it after helping the owner", async () => {
  const value = await createCompanionHarness();
  await value.ownerSays("做一条烤鱼");
  await value.untilQueueContains("fish");

  await value.ownerSays("先来帮我一下");

  expect(value.queue.currentGoal).toBe("来到主人身边并等待");
  expect(value.suspendedGoals).toContain("做一条烤鱼");
  await value.finishPriorityTask();
  expect(value.executionPrompts.at(-1)).toContain("重新观察");
});
```

- [ ] **Step 2: 运行端到端红灯**

Run: `npx vitest run tests/e2e/companion.e2e.test.ts tests/integration/electronBundle.test.ts`

Expected: FAIL，完整链路尚未满足新验收。

- [ ] **Step 3: 补齐组合、文档和桌面资源**

在 `src/app.ts` 和 `src/desktop/childMain.ts` 组合 queue、runner、stores、permission coordinator、farm scheduler，并把运行时事件接入 `RuntimeFacade`。更新架构文档，说明私有队列、安全栅栏、全局种植权限和重启恢复规则。更新 Windows smoke test 的自然中文场景。

- [ ] **Step 4: 运行完整验证**

Run:

```powershell
npm test
npm run typecheck
npm run format:check
$taskMinecraft=(Get-CimInstance Win32_Process -Filter "Name = 'java.exe' OR Name = 'javaw.exe'" | Where-Object { $_.CommandLine -match 'net\.minecraft\.client\.main\.Main|net\.fabricmc\.loader\.impl\.launch\.knot\.KnotClient' } | Sort-Object CreationDate -Descending | Select-Object -First 1)
if ($null -eq $taskMinecraft -or [string]::IsNullOrWhiteSpace($taskMinecraft.ExecutablePath)) { throw 'running Minecraft Java process was not found' }
$javaExe=$taskMinecraft.ExecutablePath
$taskJavaHome=Split-Path -Parent (Split-Path -Parent $javaExe)
$env:JAVA_HOME=$taskJavaHome
$env:PATH=(Join-Path $taskJavaHome "bin")+';'+$env:PATH
npm run desktop:prepare
```

Expected: 所列 Vitest 全部通过；TypeScript 与 Prettier 退出码为 0；`desktop:prepare` 的 Gradle、核心、desktop child、Electron renderer/main/preload 全部成功。

- [ ] **Step 5: 安装并做真实 Minecraft 验收**

先确认 `build/electron-bundle/core` 和正在运行的单个 `WhiteLily.exe`。只停止 WhiteLily 桌面进程，不停止 Minecraft；把新 core 复制到同一 `resources` 目录下的唯一 staging 目录，逐文件计算 SHA-256，与构建产物完全一致后，把旧 `resources/core` 移到带 UTC 时间戳的备份目录，再把 staging 原子重命名为 `resources/core`。启动原来的 `WhiteLily.exe`；若健康检查失败，停止新 WhiteLily、把失败 core 移到唯一故障目录并将备份原子移回。不得删除备份或故障目录，直至真实验收全部通过。发布后再次逐文件比较已安装 core 和构建 core 的相对路径、字节数与 SHA-256。

依次验证：

1. “做一条烤鱼”产生私有动态队列并实际完成。
2. “做面包”在没有小麦时提出一次种植许可。
3. 30 秒无回复时不改地，改为寻找成熟小麦。
4. 同意种植一次后，换位置和换世界都不再询问。
5. “造一个小房子”由 AI 生成方块计划，控制台显示逐项状态。
6. “先停下来吧”立即中断并清空队列。
7. “先来帮我一下”立即抢占、来到主人身边，并在帮助结束后重新观察旧目标。
8. 夜晚睡觉后，主人发消息会立即醒来。
9. Minecraft 聊天不出现队列 ID、坐标、租约、计数或内部规划。

- [ ] **Step 6: 提交最终组合**

```powershell
git add src/app.ts src/desktop/childMain.ts tests/e2e/companion.e2e.test.ts tests/integration/app.test.ts tests/integration/desktopChildServer.test.ts tests/integration/electronBundle.test.ts docs/windows-smoke-test.md docs/runtime-architecture.md
git commit -m "feat: complete adaptive Minecraft living workflows"
```
