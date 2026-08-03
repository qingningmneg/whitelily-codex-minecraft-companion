# Minecraft Action Workspace Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让正式安装版自动部署受版本管理的 Codex 工作区，并在创建 AI 线程前通过真实 MCP `tools/list` 验证全部 Minecraft 动作工具，使“查看位置”“走到我身边”“砍树”等请求能够产生真实、安全、可审计的工具调用。

**Architecture:** 构建阶段把 `AGENTS.md`、`.codex/config.toml` 和内容清单装入同一个 Electron resources；Electron 主进程在启动 child supervisor 前通过 `WorkspaceProvisioner` 原子安装到 `%LOCALAPPDATA%\WhiteLily\codex-workspace`；核心运行时连接 Minecraft、启动本地 MCP、使用独立 SDK client 校验精确工具清单，只有动作能力进入 `ready` 才启动 Codex/Companion。失败状态通过稳定错误码和脱敏诊断暴露，不把消息交给模型猜测。

**Tech Stack:** TypeScript 7、Node.js 24 文件系统原语、Electron 43、PowerShell 打包链、`@modelcontextprotocol/sdk`、Mineflayer、Vitest、electron-builder/NSIS。

## Global Constraints

- 只部署应用自带的三个受管文件；不得把用户记忆、游戏存档、凭据、日志或聊天复制到工作区。
- 所有资源路径必须约束在只读安装 resources 或 WhiteLily data root 内；拒绝链接、路径逃逸、额外文件和远程 MCP URL。
- 健康检查只调用 `tools/list`，不执行任何 Minecraft 工具，不消耗回合预算。
- 发现工具缺失、工具多出、端口冲突、超时或工作区损坏时，Codex/Companion 均不得启动。
- 保持现有动作安全预算、主人身份、世界边界、危险动作确认和审计规则不变。
- 本计划最后把模型热切换与动作工作区两条线一起打入 **一个** `WhiteLily-0.2.0-beta.2-windows-x64-setup.exe`；不得生成两个功能安装包。
- 每个实现任务先写失败测试并确认失败原因，再写最小实现。

---

## Task 1: Build and attest the managed Codex workspace resource

**Files:**

- Modify: `codex-workspace/AGENTS.md`
- Modify: `codex-workspace/.codex/config.toml`
- Create: `scripts/build-codex-workspace.mjs`
- Modify: `scripts/prepare-electron-bundle.ps1`
- Modify: `packaging/electron/runtime-manifest.json`
- Modify: `packaging/electron/after-pack.cjs`
- Modify: `apps/desktop/package.json`
- Modify: `tests/integration/electronBundle.test.ts`

- [ ] **Step 1: Add failing deterministic bundle tests**

Tests must require these exact loose resources:

```text
codex-workspace/AGENTS.md
codex-workspace/.codex/config.toml
codex-workspace/workspace-manifest.json
```

They must reject: a missing payload, an extra workspace file, `../` or absolute manifest paths, a symlink/reparse point, a non-loopback MCP URL, a changed payload hash, and a workspace manifest absent from the outer runtime manifest.

- [ ] **Step 2: Run the bundle tests and confirm resources are absent**

Run: `npm test -- tests/integration/electronBundle.test.ts`

Expected: FAIL because the prepared bundle and Electron `extraResources` do not contain `codex-workspace`.

- [ ] **Step 3: Normalize the two source payloads**

Ensure `AGENTS.md` is UTF-8 without BOM and contains the correct Chinese persona name `白百合`, not mojibake. Keep the restrictions explicit: only `minecraft_` tools, no shell/file/credential access, no bypassing safety or confirmation.

Keep the TOML exact and local:

```toml
[mcp_servers.minecraft]
url = "http://127.0.0.1:32123/mcp"
```

- [ ] **Step 4: Implement deterministic workspace staging**

`scripts/build-codex-workspace.mjs` must accept source and staging roots, verify both are contained real directories, copy only the two allowlisted payloads, compute lowercase SHA-256, and write the manifest from computed bytes:

```js
const files = await Promise.all(
  [".codex/config.toml", "AGENTS.md"].map(async (portablePath) => {
    const bytes = await readFile(resolveContained(stagingRoot, portablePath));
    return {
      path: portablePath,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }),
);
await writeFile(
  join(stagingRoot, "workspace-manifest.json"),
  `${JSON.stringify({ schemaVersion: 1, contentVersion: "1", files }, null, 2)}\n`,
  "utf8",
);
```

Sort paths ordinally. The manifest must not hash itself.

- [ ] **Step 5: Include the staged workspace in the reviewed outer manifest**

Add a reviewed `managedWorkspace` policy to `packaging/electron/runtime-manifest.json`, call the builder from `prepare-electron-bundle.ps1`, include all three paths in `requiredFiles`, and add this single `extraResources` entry:

```json
{
  "from": "../../build/electron-bundle/codex-workspace",
  "to": "codex-workspace",
  "filter": ["**/*"]
}
```

The existing outer resource enumeration will bind `workspace-manifest.json` and both payloads by byte count and SHA-256.

- [ ] **Step 6: Extend after-pack exact verification**

Validate the inner manifest, exact directory entries and loopback URL after Electron has assembled `resources`. Do not trust only the source tree or only `extraResources` configuration.

- [ ] **Step 7: Run bundle verification**

Run: `npm run desktop:prepare`

Expected: PASS and `build/electron-bundle/codex-workspace` contains exactly the three files.

Run: `npm test -- tests/integration/electronBundle.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add codex-workspace scripts/build-codex-workspace.mjs scripts/prepare-electron-bundle.ps1 packaging/electron/runtime-manifest.json packaging/electron/after-pack.cjs apps/desktop/package.json tests/integration/electronBundle.test.ts
git commit -m "build: bundle managed codex workspace"
```

---

## Task 2: Atomically provision the workspace before the child process

**Files:**

- Create: `apps/desktop/src-main/codexWorkspaceProvisioner.ts`
- Create: `apps/desktop/src-main/codexWorkspaceProvisioner.test.ts`
- Modify: `apps/desktop/src-main/main.ts`
- Modify: `apps/desktop/src-main/mainLifecycle.test.ts`
- Modify: `apps/desktop/src-main/codexResources.test.ts`

- [ ] **Step 1: Write provisioner failure and rollback tests**

Use real temporary directories and cover:

- empty data root -> complete first install;
- same contentVersion -> idempotent verified result, no staging/backup residue;
- old managed version -> complete replacement;
- modified managed file -> repaired from resources;
- copy or verification failure -> prior directory restored;
- invalid manifest, hash, extra file, link or path escape -> stable failure;
- source outside resource root or target outside data root -> rejected before mutation.

- [ ] **Step 2: Run the focused tests**

Run: `npm run desktop:test -- --run apps/desktop/src-main/codexWorkspaceProvisioner.test.ts`

Expected: FAIL because the provisioner module does not exist.

- [ ] **Step 3: Implement the public result and error contract**

```ts
export interface WorkspaceProvisionResult {
  readonly contentVersion: string;
  readonly installed: boolean;
  readonly repaired: boolean;
  readonly targetDirectory: string;
}

export class WorkspaceProvisionError extends Error {
  readonly code:
    | "WORKSPACE_RESOURCE_INVALID"
    | "WORKSPACE_DEPLOY_FAILED"
    | "WORKSPACE_ROLLBACK_FAILED";
}
```

`provisionCodexWorkspace({ resourceDirectory, dataRoot })` must validate with `lstat`/`realpath`, create a uniquely named staging directory directly under data root, copy only manifest entries, re-hash the copies, rename current target to a same-root backup, rename staging to target, verify again, then remove backup. On failure, restore backup before throwing.

- [ ] **Step 4: Add a testable resource resolver**

Development resolves to repository `codex-workspace`; packaged mode resolves to `process.resourcesPath/codex-workspace`. Return both workspace root and manifest path, following the existing `resolveDesktopCodexResources` pattern.

- [ ] **Step 5: Run provisioning before supervisor creation**

Extend `ElectronPrimaryOptions` with:

```ts
prepareSupervisor(paths: TPaths, localAppData: string): Promise<void>;
```

`startElectronPrimary` must await it before `createSupervisor`. `runElectronMain` calls the provisioner there. If it fails, the existing deterministic startup failure path shows the local error and no child process starts.

Retain the verified `WorkspaceProvisionResult` until supervisor construction and pass only its bounded `contentVersion` to the child as `WHITELILY_WORKSPACE_VERSION`. The child must reject a missing or malformed version in packaged mode; it must never trust a renderer-supplied workspace version.

- [ ] **Step 6: Run main-process tests**

Run: `npm run desktop:test -- --run apps/desktop/src-main/codexWorkspaceProvisioner.test.ts apps/desktop/src-main/mainLifecycle.test.ts apps/desktop/src-main/codexResources.test.ts`

Expected: PASS and the order assertion is `prepare workspace -> create supervisor -> start composition`.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-main/codexWorkspaceProvisioner.ts apps/desktop/src-main/codexWorkspaceProvisioner.test.ts apps/desktop/src-main/main.ts apps/desktop/src-main/mainLifecycle.test.ts apps/desktop/src-main/codexResources.test.ts
git commit -m "feat: provision codex workspace atomically"
```

---

## Task 3: Verify the exact Minecraft MCP tool catalog with an independent client

**Files:**

- Modify: `src/mcp/toolRegistry.ts`
- Create: `src/mcp/mcpReadiness.ts`
- Create: `tests/unit/mcpReadiness.test.ts`
- Modify: `tests/integration/mcpServer.test.ts`

- [ ] **Step 1: Export the single canonical tool-name allowlist**

Refactor registry construction so registration and readiness share one source:

```ts
export const MINECRAFT_TOOL_NAMES = Object.freeze([
  "minecraft_get_state",
  "minecraft_find_block",
  "minecraft_say",
  "minecraft_move_to",
  "minecraft_follow_owner",
  "minecraft_look_at",
  "minecraft_jump",
  "minecraft_dig_block",
  "minecraft_place_block",
  "minecraft_craft_item",
  "minecraft_smelt_item",
  "minecraft_collect_dropped",
  "minecraft_equip_item",
  "minecraft_attack_hostile",
  "minecraft_wait",
] as const);
```

Add a test that `Object.keys(createToolRegistry(dependencies)).sort()` exactly equals the sorted constant.

- [ ] **Step 2: Write failing readiness tests**

Cover exact success, one missing tool, one extra tool, duplicate names, non-`minecraft_` name, connection failure, timeout, and abort. Assert no registry `execute` function is called.

- [ ] **Step 3: Run the focused tests**

Run: `npm test -- tests/unit/mcpReadiness.test.ts tests/integration/mcpServer.test.ts`

Expected: FAIL because there is no production readiness client.

- [ ] **Step 4: Implement the SDK client probe**

Expose:

```ts
export interface McpReadinessSnapshot {
  readonly state: "ready" | "failed";
  readonly listening: boolean;
  readonly discoveredToolCount: number;
  readonly errorCode: McpReadinessErrorCode | null;
}

export async function verifyMinecraftMcp(options: {
  url: string;
  expectedToolNames: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<McpReadinessSnapshot>;
```

Use `Client` plus `StreamableHTTPClientTransport`, call `client.listTools()`, compare ordinally sorted exact names, close client/transport in `finally`, and throw only stable local errors without response bodies or credentials.

- [ ] **Step 5: Run MCP tests**

Run: `npm test -- tests/unit/mcpReadiness.test.ts tests/integration/mcpServer.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/toolRegistry.ts src/mcp/mcpReadiness.ts tests/unit/mcpReadiness.test.ts tests/integration/mcpServer.test.ts
git commit -m "feat: verify minecraft mcp tool catalog"
```

---

## Task 4: Gate Codex startup on connected Minecraft and ready actions

**Files:**

- Modify: `src/app.ts`
- Modify: `src/mcp/mcpServer.ts`
- Modify: `src/runtime/runtimeEvents.ts`
- Modify: `src/runtime/runtimeFacade.ts`
- Modify: `src/companion/companionService.ts`
- Modify: `src/desktop/childServer.ts`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `tests/integration/app.test.ts`
- Modify: `tests/integration/mcpServer.test.ts`
- Modify: `tests/integration/companionService.test.ts`
- Modify: `tests/integration/desktopChildServer.test.ts`
- Modify: `tests/integration/runtimeFacade.test.ts`
- Modify: `tests/unit/desktopProtocol.test.ts`
- Modify: `tests/integration/releaseReadiness.test.ts`

- [ ] **Step 1: Write failing lifecycle-order tests**

Change expected startup order to:

```text
minecraft.connect
mcp.start
mcp.tools/list verified
codex.assertChatGptLogin
codex.start
codex.listModels
companion.start
```

Add separate failures for port conflict, probe timeout, missing tool and extra tool. Every failure must assert `codex.startCalls === 0`, no Codex threads, no accepted task, and deterministic reverse cleanup.

- [ ] **Step 2: Add the internal action capability state**

Use this exact union:

```ts
export type ActionCapabilitySnapshot =
  | { readonly state: "starting"; readonly workspaceVersion: string }
  | {
      readonly state: "ready";
      readonly workspaceVersion: string;
      readonly mcpListening: true;
      readonly discoveredToolCount: number;
    }
  | {
      readonly state: "failed";
      readonly workspaceVersion: string | null;
      readonly mcpListening: boolean;
      readonly discoveredToolCount: number;
      readonly errorCode: string;
    };
```

`McpLifecycle.start()` sets starting, starts the server, runs the independent probe, and publishes ready only after exact comparison. On probe failure it stops the server, publishes failed, and throws a stable `ActionCapabilityError`.

Extend `RunningMcpServer` with a `closed: Promise<void>` signal. `McpLifecycle` must distinguish its own intentional stop from an unexpected server close; an unexpected close after readiness publishes `failed` and reports `RuntimeAuthorityLoss { reason: "action_unavailable" }`. `CompanionService` then stops the active task, revokes its tool lease, interrupts the turn, and refuses new task dispatch while chat/task threads are no longer trusted. The child recovery path preserves LAN/world authority and creates a fresh runtime on retry.

- [ ] **Step 3: Run app tests and confirm Codex currently starts without the gate**

Run: `npm test -- tests/integration/app.test.ts tests/integration/releaseReadiness.test.ts`

Expected: FAIL on lifecycle order/readiness assertions.

- [ ] **Step 4: Reorder startup and preserve reverse cleanup**

In `WhiteLilyAppLifecycle`, connect Minecraft first, then start/verify MCP, then authenticate/start Codex, then start Companion. Update attempted phase bookkeeping so cancellation at every boundary cleans only attempted components in reverse order.

- [ ] **Step 5: Surface action state through runtime snapshots**

Add a nullable `actions` field to `RuntimeSnapshot` and a typed `actions` runtime event. Keep it null while idle, publish starting/ready/failed transitions, and update the Zod desktop protocol. A model hot switch reuses the existing ready snapshot and must not return it to starting.

Before `RuntimeFacade.switchModel` delegates to Companion, require the current action snapshot to be `ready`; this is the explicit boundary between this subsystem and model hot switching.

- [ ] **Step 6: Run runtime/protocol tests**

Run: `npm test -- tests/integration/app.test.ts tests/integration/mcpServer.test.ts tests/integration/companionService.test.ts tests/integration/desktopChildServer.test.ts tests/integration/runtimeFacade.test.ts tests/unit/desktopProtocol.test.ts tests/integration/releaseReadiness.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app.ts src/mcp/mcpServer.ts src/runtime/runtimeEvents.ts src/runtime/runtimeFacade.ts src/companion/companionService.ts src/desktop/childServer.ts src/desktop/desktopProtocol.ts tests/integration/app.test.ts tests/integration/mcpServer.test.ts tests/integration/companionService.test.ts tests/integration/desktopChildServer.test.ts tests/integration/runtimeFacade.test.ts tests/unit/desktopProtocol.test.ts tests/integration/releaseReadiness.test.ts
git commit -m "feat: gate ai startup on action readiness"
```

---

## Task 5: Show stable local recovery and diagnostic information

**Files:**

- Modify: `src/diagnostics/diagnosticManifest.ts`
- Modify: `src/diagnostics/diagnosticExporter.ts`
- Modify: `src/desktop/childMain.ts`
- Modify: `src/desktop/childServer.ts`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `apps/desktop/src/pages/DiagnosticsPage.tsx`
- Modify: `apps/desktop/src/pages/DiagnosticsPage.test.tsx`
- Modify: `apps/desktop/src/pages/OnboardingPage.tsx`
- Modify: `apps/desktop/src/pages/OnboardingPage.test.tsx`
- Modify: `apps/desktop/src/i18n/zh-CN.ts`
- Modify: `apps/desktop/src/i18n/en.ts`
- Modify: `tests/unit/diagnosticExporter.test.ts`

- [ ] **Step 1: Write failing UI and diagnostic tests**

Require Chinese-first local messages for:

- `WORKSPACE_RESOURCE_INVALID`: 安装资源损坏，建议重新安装 WhiteLily；
- `WORKSPACE_DEPLOY_FAILED`: 工作区修复失败，建议关闭相关占用后重试；
- `MCP_PORT_UNAVAILABLE`: 本地动作端口被占用；
- `MCP_TOOL_CATALOG_INVALID`: Minecraft 动作组件不完整；
- `MCP_READINESS_TIMEOUT`: Minecraft 动作组件响应超时。

Tests must prove the raw MCP response, file content, absolute user path, chat and credentials never appear in renderer errors or diagnostic metadata.

- [ ] **Step 2: Add bounded diagnostics metadata**

Extend diagnostic metadata with only:

```ts
actionCapability: {
  workspaceVersion: string | null;
  state: "starting" | "ready" | "failed";
  mcpListening: boolean;
  discoveredToolCount: number;
  errorCode: string | null;
}
```

Change `DesktopChildDiagnostics.preview` to accept the child server's current bounded `RuntimeSnapshot["actions"]`. `DesktopChildServer` supplies that snapshot when handling `preview_diagnostics`, and `DiagnosticExporter` serializes the five allowlisted fields above. This avoids a second mutable health store and ensures the preview matches the same revision shown by `get_status`.

Snapshot the value when `preview()` is called; do not capture full tool schemas, payloads, paths, model prompts, or server response bodies.

- [ ] **Step 3: Route startup failure to recovery UI without model execution**

Map stable codes in onboarding/Home recovery. Preserve the confirmed LAN/world data when only action readiness fails. Retry must create a fresh runtime and rerun provisioning/readiness; it must not ask the AI to diagnose its own missing tools.

- [ ] **Step 4: Render action health on DiagnosticsPage**

Show workspace content version, state, listening yes/no, discovered count and localized error code. Keep the existing preview-before-export privacy boundary.

- [ ] **Step 5: Run diagnostic and renderer tests**

Run: `npm test -- tests/unit/diagnosticExporter.test.ts tests/integration/desktopChildServer.test.ts`

Expected: PASS.

Run: `npm run desktop:test -- --run apps/desktop/src/pages/DiagnosticsPage.test.tsx apps/desktop/src/pages/OnboardingPage.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/diagnostics src/desktop apps/desktop/src/pages/DiagnosticsPage.tsx apps/desktop/src/pages/DiagnosticsPage.test.tsx apps/desktop/src/pages/OnboardingPage.tsx apps/desktop/src/pages/OnboardingPage.test.tsx apps/desktop/src/i18n tests/unit/diagnosticExporter.test.ts tests/integration/desktopChildServer.test.ts
git commit -m "feat: expose action readiness diagnostics"
```

---

## Task 6: Prove real tool discovery and task containment

**Files:**

- Modify: `tests/integration/companionService.test.ts`
- Modify: `tests/integration/app.test.ts`
- Modify: `tests/e2e/companion.e2e.test.ts`
- Modify: `tests/integration/releaseReadiness.test.ts`
- Modify: `docs/testing/windows-smoke-test.md`

- [ ] **Step 1: Add an end-to-end tool discovery test**

Start the real local MCP server and a real Codex app-server test transport configured through a provisioned temporary workspace. Assert both intent and execution threads are created only after `tools/list` succeeds and that the workspace cwd contains the attested `AGENTS.md` and `.codex/config.toml`.

- [ ] **Step 2: Add action outcome tests**

For “查看一下你现在的位置”, require at least one `minecraft_get_state` call and `toolCalls >= 1`. For “走到我身边来”, require `minecraft_follow_owner` or a bounded `minecraft_move_to`, a corresponding executor result, and matching budget/audit counts. Do not assert natural-language wording beyond existing safety requirements.

- [ ] **Step 3: Add mid-task failure containment**

Simulate MCP loss after a task lease is active. Assert the task terminates as failed, the lease is revoked, subsequent tool calls are rejected, no model turn continues pretending the action succeeded, and Minecraft remains under the existing safe lifecycle.

- [ ] **Step 4: Run the focused integration/e2e tests**

Run: `npm test -- tests/integration/app.test.ts tests/integration/companionService.test.ts tests/e2e/companion.e2e.test.ts tests/integration/releaseReadiness.test.ts`

Expected: PASS with a non-zero tool count in the action path.

- [ ] **Step 5: Update the smoke checklist**

Document exact local verification: installed workspace files, port 32123 ownership, action readiness fields, `toolCalls >= 1`, actual follow movement, budget audit, restart, and rollback evidence. Keep Minecraft 1.21.5 and a disposable LAN world as the supported test target.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/companionService.test.ts tests/integration/app.test.ts tests/e2e/companion.e2e.test.ts tests/integration/releaseReadiness.test.ts docs/testing/windows-smoke-test.md
git commit -m "test: prove installed minecraft action path"
```

---

## Task 7: Build, inspect, install, and smoke-test the single combined installer

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `apps/desktop/package.json`
- Modify: `packaging/electron/runtime-manifest.json`
- Modify: `scripts/inspect-installer.ps1`
- Modify: `scripts/test-installer.ps1`
- Modify: `README.md`
- Modify: `docs/windows-installation.md`

- [ ] **Step 1: Add installer assertions before changing the version**

Extend installer inspection/test scripts to require all three managed workspace resources, verify the nested and outer hashes, install over an existing beta.1 data root, confirm workspace upgrade/repair, and confirm exactly one WhiteLily product/uninstall entry. The test must fail against the current beta.1 installer.

- [ ] **Step 2: Bump the product once to `0.2.0-beta.2`**

Update root package, desktop package, lockfile workspace versions and runtime manifest together. Do not change the stable appId, NSIS guid, install scope or data-root location, so beta.2 upgrades beta.1 rather than installing beside it.

- [ ] **Step 3: Run complete verification before packaging**

Run: `npm run format:check`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm test`

Expected: PASS.

Run: `npm run desktop:test`

Expected: PASS.

Run: `npm run desktop:build`

Expected: PASS.

- [ ] **Step 4: Produce the one combined installer**

Run: `npm run desktop:package`

Expected: exactly one new artifact at `build/electron-installer/WhiteLily-0.2.0-beta.2-windows-x64-setup.exe` plus normal builder metadata; no separate model or action installer.

- [ ] **Step 5: Inspect and lifecycle-test the installer**

Run: `npm run desktop:inspect-installer -- -ExpectedVersion 0.2.0-beta.2`

Expected: PASS, including exact workspace resources and hashes.

Run: `npm run desktop:test-installer -- -ExpectedVersion 0.2.0-beta.2`

Expected: PASS for clean install, beta.1 upgrade, launch, data preservation, uninstall and reinstall.

- [ ] **Step 6: Perform the real disposable-world acceptance**

Install beta.2, launch WhiteLily, sign in, connect a Minecraft Java 1.21.5 LAN world, and verify:

1. `%LOCALAPPDATA%\WhiteLily\codex-workspace` has the attested three files.
2. Diagnostics shows action capability ready and 15 discovered tools.
3. “查看一下你现在的位置” records at least one tool call.
4. “走到我身边来” moves WhiteLily and records the bounded movement budget.
5. Terra -> Luna hot switch keeps the Minecraft session ID unchanged and the next action still calls a tool.
6. Restart preserves Luna and reprovisions/verifies the same workspace.

- [ ] **Step 7: Update Chinese-first release documentation**

Document one installer, supported environment, automatic managed-workspace repair, stable recovery errors, model hot switching, known beta limits and uninstall data behavior. Keep English after the complete Chinese section.

- [ ] **Step 8: Commit the combined release state**

```bash
git add package.json package-lock.json apps/desktop/package.json packaging/electron/runtime-manifest.json scripts/inspect-installer.ps1 scripts/test-installer.ps1 README.md docs/windows-installation.md
git commit -m "release: package WhiteLily beta 2"
```

- [ ] **Step 9: Final verification record**

Record installer SHA-256, byte size, test command results, installed application version, action tool count and the unchanged session ID from the model switch. Only after this evidence exists may the branch be merged and the single beta.2 installer be published.
