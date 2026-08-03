# Model Preference Persistence and Hot Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 WhiteLily 的模型与推理强度选择由后台唯一持久化，并在游戏连接保持不变的前提下无感切换正在使用的 ChatGPT 模型。

**Architecture:** `ModelPreferenceStore` 保存唯一权威选择；`ModelCatalog` 负责实时目录验证、一次性旧偏好迁移和两阶段提交；`DesktopChildServer` 串行编排运行时切换与持久化提交；`CompanionService` 在同一个 Codex app-server 内先创建新线程对、提交偏好、原子替换，再归档旧线程。主动切换事件与模型失效事件彻底分离。

**Tech Stack:** TypeScript 7、Zod、现有 `DocumentStore`、Codex app-server JSON-RPC、Vitest、React 19、Electron 43。

## Global Constraints

- 本计划不得断开 Mineflayer、LAN authority、world binding、owner identity、memory scope 或安全配置。
- 模型切换只替换 Codex intent/execution 线程；不重启 MCP，不重建整个 `RuntimeFacade`。
- 任何验证、建线程或持久化失败都必须保留唯一可用的旧线程对和旧偏好。
- 主动切换不得发布 `connection_invalidated` 或 `model_unavailable`。
- 本计划完成后只运行测试和构建，不单独制作安装包；统一安装包在 Minecraft 动作工作区计划完成后生成一次。
- 每个实现任务严格遵循红—绿—重构：先新增失败测试，确认失败原因正确，再写最小实现。

---

## Task 1: Add the persistent model preference document

**Files:**

- Create: `src/codex/modelPreferenceStore.ts`
- Create: `tests/unit/modelPreferenceStore.test.ts`
- Modify: `src/desktop/childMain.ts`

- [ ] **Step 1: Write failing tests for defaults, persistence, migration, and conflicts**

测试必须覆盖：首次读取得到 automatic + `legacyMigrationCompleted: false`；有效旧 UI 值优先于 legacy config；无效旧 UI 值回退到有效 config；两者无效则 automatic；迁移只执行一次；旧 revision 更新被 `DOCUMENT_CONFLICT` 拒绝；重建 store 后值仍存在。

```ts
const first = await store.read();
expect(first).toMatchObject({
  revision: 0,
  value: { selection: { mode: "automatic" }, legacyMigrationCompleted: false },
});

const migrated = await store.migrateLegacyOnce(first.revision, {
  ui: { mode: "explicit", modelId: "gpt-5.5", reasoningEffort: "low" },
  config: { mode: "explicit", modelId: "gpt-5.4", reasoningEffort: "medium" },
  validate: async (candidate) => candidate.modelId === "gpt-5.5",
});
expect(migrated.value.selection).toMatchObject({ modelId: "gpt-5.5" });
expect(migrated.value.legacyMigrationCompleted).toBe(true);
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `npm test -- tests/unit/modelPreferenceStore.test.ts`

Expected: FAIL because `src/codex/modelPreferenceStore.ts` does not exist.

- [ ] **Step 3: Implement the versioned document store**

Implement an exact schema and immutable public types:

```ts
export const persistedModelPreferenceSchema = z.object({
  selection: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("automatic") }).strict(),
    z.object({
      mode: z.literal("explicit"),
      modelId: z.string().regex(MODEL_ID_PATTERN),
      reasoningEffort: z.string().regex(REASONING_EFFORT_PATTERN),
    }).strict(),
  ]),
  legacyMigrationCompleted: z.boolean(),
}).strict();

export class ModelPreferenceStore {
  read(): Promise<DocumentEnvelope<PersistedModelPreference>>;
  replace(expectedRevision: number, value: PersistedModelPreference):
    Promise<DocumentEnvelope<PersistedModelPreference>>;
  migrateLegacyOnce(expectedRevision: number, input: LegacyMigrationInput):
    Promise<DocumentEnvelope<PersistedModelPreference>>;
}
```

文件固定为 `config/model-preference.json`，`schemaVersion` 为 1。迁移选择顺序必须在 store 内明确表达为 `valid UI -> valid config -> automatic`；当文档已迁移或 revision 不匹配时不得静默覆盖。

- [ ] **Step 4: Wire the store into default child services**

在 `createDefaultDesktopChildServices` 中先解析 `paths`，再读取 legacy config 的 `preferredModel` 与 `reasoningEffort`，用 `paths.config` 的父级配置目录创建 store，最后把 store 与 legacy config candidate 注入 `ModelCatalog`。不得从 renderer 路径直接读写该文件。

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- tests/unit/modelPreferenceStore.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/codex/modelPreferenceStore.ts src/desktop/childMain.ts tests/unit/modelPreferenceStore.test.ts
git commit -m "feat: persist model preference authority"
```

---

## Task 2: Make ModelCatalog migration-aware and split model events

**Files:**

- Modify: `src/codex/modelCatalog.ts`
- Modify: `tests/unit/modelCatalog.test.ts`
- Modify: `src/desktop/childServer.ts`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `tests/integration/desktopChildServer.test.ts`
- Modify: `tests/unit/desktopProtocol.test.ts`

- [ ] **Step 1: Replace invalidation-only tests with explicit event tests**

Add assertions for these exact events:

```ts
export type ModelCatalogEvent =
  | { readonly kind: "selection_changed"; readonly selection: ModelSelection }
  | { readonly kind: "selection_invalidated"; readonly reason: "model_unavailable" | "account_lost" };
```

Tests must prove that a valid explicit selection produces only `selection_changed`, while catalog disappearance and logout produce only `selection_invalidated`.

- [ ] **Step 2: Add failing two-phase selection tests**

Define and test this boundary:

```ts
export interface PreparedModelSelection {
  readonly preferenceRevision: number;
  readonly requested: ModelSelectionInput;
  readonly resolved: ResolvedModelSelection;
}

prepareSelection(input: ModelSelectionInput): Promise<PreparedModelSelection>;
commitSelection(prepared: PreparedModelSelection): Promise<ModelSelection>;
```

`prepareSelection` may refresh and validate but must not mutate memory, persist, or emit. `commitSelection` must compare the captured revision, persist, update the in-memory selection, and emit one `selection_changed` only when the effective selection changed.

- [ ] **Step 3: Run focused tests and confirm current invalidation behavior fails them**

Run: `npm test -- tests/unit/modelCatalog.test.ts`

Expected: FAIL because valid `selectModel` currently calls the invalidation listener and there is no two-phase API.

- [ ] **Step 4: Implement catalog initialization, migration, and event separation**

Extend `ModelCatalogSnapshot` with backend migration state:

```ts
export interface ModelCatalogSnapshot {
  models: readonly AvailableModel[];
  selection: ModelSelection;
  legacyMigrationCompleted: boolean;
}
```

Add `migrateLegacyPreference(candidate: ModelSelectionInput | null)`. It must validate candidates against the live directory, delegate the one-time compare-and-replace to `ModelPreferenceStore`, and return the refreshed snapshot. On future calls, it returns the existing backend value without applying the candidate.

Keep `selectModel` as a convenience for the stopped-runtime path by implementing it as `prepareSelection` followed by `commitSelection`. Replace `subscribeInvalidation` with `subscribe(listener: (event: ModelCatalogEvent) => void)`.

Update the strict desktop Zod schema in the same step so `list_models` can carry `legacyMigrationCompleted` without an intermediate protocol failure.

- [ ] **Step 5: Change child containment to react only to true invalidation**

Update `DesktopChildModelCatalog` and the child server subscription:

```ts
models.subscribe((event) => {
  if (event.kind !== "selection_invalidated") return;
  void containModelAuthorityLoss(event.reason);
});
```

A `selection_changed` event must update model state through the normal runtime result, never through `#invalidateConnectionAuthority`.

- [ ] **Step 6: Run catalog and child tests**

Run: `npm test -- tests/unit/modelCatalog.test.ts tests/integration/desktopChildServer.test.ts tests/unit/desktopProtocol.test.ts`

Expected: PASS, including explicit proof that `select_model` does not emit `connection_invalidated`.

- [ ] **Step 7: Commit**

```bash
git add src/codex/modelCatalog.ts src/desktop/childServer.ts src/desktop/desktopProtocol.ts tests/unit/modelCatalog.test.ts tests/integration/desktopChildServer.test.ts tests/unit/desktopProtocol.test.ts
git commit -m "fix: separate model changes from invalidation"
```

---

## Task 3: Add safe Codex thread retirement

**Files:**

- Modify: `src/codex/codexPort.ts`
- Modify: `src/codex/appServerClient.ts`
- Modify: `tests/integration/appServerClient.test.ts`
- Modify: `tests/support/companionHarness.ts`

- [ ] **Step 1: Write failing archive tests**

Add `closeThread(threadId: string): Promise<void>` to the fake port first, then test that the production client sends exactly:

```json
{"method":"thread/archive","params":{"threadId":"thread-2"}}
```

The test must also assert that the per-thread reasoning effort entry is removed after success and retained/retriable after an RPC failure.

- [ ] **Step 2: Run the focused test**

Run: `npm test -- tests/integration/appServerClient.test.ts`

Expected: FAIL because `CodexPort.closeThread` is absent.

- [ ] **Step 3: Implement the archive operation**

Use generated `ThreadArchiveParams` and `ThreadArchiveResponse`; do not add an untyped JSON-RPC call.

```ts
async closeThread(threadId: string): Promise<void> {
  await this.requireRpc().request<ThreadArchiveResponse>("thread/archive", { threadId });
  this.reasoningEfforts.delete(threadId);
}
```

Do not close the entire app-server and do not set `hasGameThreads` false merely because one thread was archived.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- tests/integration/appServerClient.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codex/codexPort.ts src/codex/appServerClient.ts tests/integration/appServerClient.test.ts tests/support/companionHarness.ts
git commit -m "feat: retire individual codex threads"
```

---

## Task 4: Implement atomic CompanionService model switching

**Files:**

- Modify: `src/safety/taskBudget.ts`
- Modify: `src/companion/taskController.ts`
- Modify: `src/companion/companionService.ts`
- Modify: `tests/unit/taskBudget.test.ts`
- Modify: `tests/unit/taskController.test.ts`
- Modify: `tests/integration/companionService.test.ts`
- Modify: `tests/support/companionHarness.ts`

- [ ] **Step 1: Add `model_changed` as a task-only stop reason**

Append `"model_changed"` to `TaskStopReason` and to every exhaustive validation set. Test that it terminates the active task, revokes the current turn lease, emits the final audit record, and does not imply connection loss.

- [ ] **Step 2: Write failing switch success and rollback tests**

Cover all of the following:

- Terra -> Luna creates two Luna threads before retiring either Terra thread.
- An active task stops with `model_changed` and its old tool lease becomes invalid.
- `commitPreference` runs after both new threads exist but before the thread IDs are swapped.
- Second new-thread creation failure archives the first new thread and preserves both old threads.
- Persistence failure archives both new threads and preserves both old threads.
- Old-thread archive failure logs a redacted diagnostic after the new pair is authoritative; it does not roll back to dual authority.
- Two rapid calls are serialized, and the final successful request is the effective model.

- [ ] **Step 3: Run the focused integration test**

Run: `npm test -- tests/integration/companionService.test.ts`

Expected: FAIL because there is no `switchModel` boundary and thread creation mutates instance fields too early.

- [ ] **Step 4: Refactor thread creation to stage local values**

Replace `createThreadPair` with a side-effect-free staging helper:

```ts
interface CodexThreadPair {
  readonly intentThreadId: string;
  readonly executionThreadId: string;
}

private async startThreadPair(selection: ResolvedModelSelection): Promise<CodexThreadPair>;
private async retireThreadPair(pair: CodexThreadPair): Promise<void>;
```

If execution-thread creation fails, archive the already-created intent thread before rethrowing.

- [ ] **Step 5: Implement the serialized atomic switch**

Expose:

```ts
switchModel(
  selection: ResolvedModelSelection,
  commitPreference: () => Promise<void>,
): Promise<void>;
```

The operation must run on a dedicated `modelSwitchTail`, check that the service is running and Codex is healthy, stop the active task with `model_changed`, invalidate/interrupt active turns, stage the pair, commit the preference, atomically assign both thread IDs plus model and reasoning effort, then retire the old pair. Chat and task dispatch must read a complete pair captured after the tail boundary; no turn may mix old intent with new execution.

- [ ] **Step 6: Run all affected tests**

Run: `npm test -- tests/unit/taskBudget.test.ts tests/unit/taskController.test.ts tests/integration/companionService.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/safety/taskBudget.ts src/companion/taskController.ts src/companion/companionService.ts tests/unit/taskBudget.test.ts tests/unit/taskController.test.ts tests/integration/companionService.test.ts tests/support/companionHarness.ts
git commit -m "feat: hot switch companion model threads"
```

---

## Task 5: Orchestrate two-phase switching through the runtime and child protocol

**Files:**

- Modify: `src/runtime/runtimeFacade.ts`
- Modify: `src/runtime/runtimeEvents.ts`
- Modify: `src/app.ts`
- Modify: `src/desktop/childServer.ts`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `tests/integration/runtimeFacade.test.ts`
- Modify: `tests/integration/app.test.ts`
- Modify: `tests/integration/desktopChildServer.test.ts`
- Modify: `tests/unit/desktopProtocol.test.ts`

- [ ] **Step 1: Write the runtime contract tests**

Add this public boundary to `DesktopChildRuntime` and `RuntimeFacade`:

```ts
switchModel(
  selection: ResolvedModelSelection,
  commitPreference: () => Promise<void>,
): Promise<void>;
```

Tests must prove the runtime snapshot changes only `codex.model`, preserves `minecraft.sessionId`, keeps lifecycle `running`, and emits no connection invalidation.

- [ ] **Step 2: Write child orchestration tests**

For a running runtime, assert exact order:

```text
catalog.prepareSelection
runtime.switchModel
catalog.commitSelection (inside runtime callback)
select_model response
```

For an idle runtime, `select_model` may prepare and commit directly. A stale prepared revision must return the stable model operation error and leave runtime/catalog unchanged.

- [ ] **Step 3: Run tests and observe the missing runtime method**

Run: `npm test -- tests/integration/runtimeFacade.test.ts tests/integration/desktopChildServer.test.ts`

Expected: FAIL because model changes currently mutate the catalog and trigger connection containment.

- [ ] **Step 4: Implement runtime delegation and snapshot publication**

Add `switchModel` to `ManagedCompanion`, `AppRuntime`, and `RuntimeFacadeDependencies`. `RuntimeFacade.switchModel` must accept calls only while running, await the companion operation, then publish `codex: { state: "ready", model: selection.modelId }` using the existing revision/event machinery.

- [ ] **Step 5: Implement child command serialization**

Route `select_model` through one `#modelSelectionTail`. Capture the prepared catalog revision, call `runtime.switchModel(prepared.resolved, () => models.commitSelection(prepared))`, and return the committed selection. Suppress late results from a stopped/replaced runtime using the existing replacement generation.

- [ ] **Step 6: Preserve true invalidation containment**

Keep the existing `model_unavailable` path for an explicit model that disappears or an account that becomes invalid. It may stop AI authority, but must preserve the confirmed LAN and world binding so recovery routes to login/model recovery rather than the full first-run flow.

- [ ] **Step 7: Run the affected integration suite**

Run: `npm test -- tests/integration/runtimeFacade.test.ts tests/integration/app.test.ts tests/integration/desktopChildServer.test.ts tests/unit/desktopProtocol.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/runtimeFacade.ts src/runtime/runtimeEvents.ts src/app.ts src/desktop/childServer.ts src/desktop/desktopProtocol.ts tests/integration/runtimeFacade.test.ts tests/integration/app.test.ts tests/integration/desktopChildServer.test.ts tests/unit/desktopProtocol.test.ts
git commit -m "feat: orchestrate live model switching"
```

---

## Task 6: Migrate renderer preference authority and expose switch progress

**Files:**

- Modify: `apps/desktop/src/desktopApi.ts`
- Modify: `apps/desktop/src-main/ipcRegistry.ts`
- Modify: `apps/desktop/src-main/preload.ts`
- Modify: `apps/desktop/src/pages/OnboardingPage.tsx`
- Modify: `apps/desktop/src/pages/ModelPage.tsx`
- Modify: `apps/desktop/src/pages/HomePage.tsx`
- Modify: `apps/desktop/src/i18n/zh-CN.ts`
- Modify: `apps/desktop/src/i18n/en.ts`
- Modify: `src/desktop/childServer.ts`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `apps/desktop/src/pages/OnboardingPage.test.tsx`
- Modify: `apps/desktop/src/pages/ModelPage.test.tsx`
- Modify: `apps/desktop/src/pages/HomePage.test.tsx`
- Modify: `apps/desktop/src-main/ipcRegistry.test.ts`
- Modify: `tests/integration/desktopChildServer.test.ts`
- Modify: `tests/unit/desktopProtocol.test.ts`

- [ ] **Step 1: Write failing renderer tests**

Tests must prove:

- On first upgrade only, the old `modelPreference` from `whitelily.onboarding.v1` is submitted as a migration candidate.
- After migration, localStorage contains only `version`, `locale`, and `progressHint`.
- A stale old localStorage model cannot overwrite a backend selection after restart.
- ModelPage disables Apply and shows “正在切换” while pending.
- Success is rendered from the backend-confirmed result: `已切换到 {model} · {effort}`.
- Failure restores the previous confirmed selection and exposes a retryable, localized error.
- HomePage updates the model card from the runtime event without navigating to onboarding.

- [ ] **Step 2: Run desktop tests and confirm current storage behavior fails**

Run: `npm run desktop:test -- --run apps/desktop/src/pages/OnboardingPage.test.tsx apps/desktop/src/pages/ModelPage.test.tsx apps/desktop/src/pages/HomePage.test.tsx`

Expected: FAIL because onboarding localStorage is still a model authority and ModelPage has no pending confirmation state.

- [ ] **Step 3: Add the migration IPC/API command**

Expose a single typed method end to end:

```ts
migrateModelPreference(candidate: ModelSelectionInput | null): Promise<ModelCatalogSnapshot>;
```

Use a dedicated IPC channel and child command; validate the candidate with the same Zod schema as `select_model`. Do not send raw localStorage JSON across IPC.

- [ ] **Step 4: Remove renderer model authority**

Bump the onboarding storage shape, read the previous version only long enough to extract a bounded `ModelSelectionInput`, submit it if `legacyMigrationCompleted` is false, then rewrite storage without a model field. Thereafter `listModels()` and runtime events are the only displayed authority.

- [ ] **Step 5: Implement pending/success/failure UI states**

Keep the page mounted during switching. Disable duplicate submit until the promise settles. On success, replace the confirmed selection with the returned value; on failure, leave the previous confirmed selection selected. Add Chinese-first and English fallback strings.

- [ ] **Step 6: Run desktop and protocol tests**

Run: `npm run desktop:test`

Expected: PASS.

Run: `npm test -- tests/unit/desktopProtocol.test.ts tests/integration/desktopChildServer.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src apps/desktop/src-main src/desktop tests/unit/desktopProtocol.test.ts tests/integration/desktopChildServer.test.ts
git commit -m "feat: expose persistent model switching in desktop"
```

---

## Task 7: Verify the model subsystem without producing an installer

**Files:**

- Modify if needed: `docs/windows-installation.md`
- Modify if needed: `README.md`

- [ ] **Step 1: Run focused model regression tests**

Run: `npm test -- tests/unit/modelPreferenceStore.test.ts tests/unit/modelCatalog.test.ts tests/integration/appServerClient.test.ts tests/integration/companionService.test.ts tests/integration/runtimeFacade.test.ts tests/integration/desktopChildServer.test.ts`

Expected: PASS.

- [ ] **Step 2: Run full static and automated verification**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run desktop:build`

Expected: PASS.

Run: `npm test`

Expected: PASS.

Run: `npm run desktop:test`

Expected: PASS.

- [ ] **Step 3: Record manual development-build acceptance**

With a disposable Minecraft 1.21.5 LAN world connected, verify Terra -> Luna -> Terra. Record the runtime snapshot before and after each switch and confirm `minecraft.sessionId`, world binding, owner and LAN authority are identical. Restart the desktop child and then the desktop app; confirm the final backend selection survives both.

- [ ] **Step 4: Commit only documentation/test adjustments**

```bash
git add README.md docs/windows-installation.md
git commit -m "docs: document persistent model switching"
```

Skip this commit when neither file changed. Do not run `desktop:package` in this plan.
