# WhiteLily Public Beta 03 Onboarding and Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the five-step first-run flow, ChatGPT login and live model selection, generic PCL2 discovery, loopback Minecraft LAN detection, user connection confirmation, and bounded same-session reconnection.

**Architecture:** Extend the desktop protocol to v2. Codex authentication and Minecraft protocol probing remain in the Node Sidecar; native Windows process, shortcut, listener, browser-open, and file-picker operations remain in Rust. A dedicated `SessionCoordinator` owns LAN candidate state and never connects before desktop confirmation.

**Tech Stack:** TypeScript, Zod, Codex app-server v2 methods, Minecraft protocol, Tauri 2, Rust `windows` crate, React, Vitest, Cargo test

## Global Constraints

- Plans 01 and 02 must be merged and green before this plan begins.
- Execute in a fresh worktree created with `superpowers:using-git-worktrees`.
- Authentication uses `account/login/start` with `{ type: "chatgpt" }` only.
- API Key, Bedrock, token injection, and environment-key fallback remain rejected.
- Models are populated from the signed-in account's live `model/list`; model IDs are not hardcoded.
- Only Java/Javaw listening ports discovered on the local Windows host become probe candidates.
- Probes connect to `127.0.0.1` only; do not scan an address range or arbitrary port range.
- Every new LAN session requires one desktop confirmation.
- The same session may reconnect for at most 60 seconds; a changed PID, port, protocol, or server identity requires a new confirmation.
- Experimental Minecraft versions start in conservative safety mode.
- Unknown protocol data fails closed.
- Use test-driven development and frequent focused commits.

---

### Task 1: Return complete live Codex model descriptors

**Files:**

- Modify: `src/codex/codexPort.ts`
- Modify: `src/codex/appServerClient.ts`
- Modify: `src/codex/modelSelector.ts`
- Create: `src/codex/modelAvailabilityService.ts`
- Modify: `tests/integration/appServerClient.test.ts`
- Modify: `tests/unit/modelSelector.test.ts`
- Create: `tests/unit/modelAvailabilityService.test.ts`
- Modify: `tests/support/companionHarness.ts`
- Modify: `tests/support/appHarness.ts`

**Interfaces:**

- Produces:
  - `CodexModelDescriptor`
  - `CodexPort.listModels(): Promise<CodexModelDescriptor[]>`
  - `selectModel(models, selection): SelectedModel`
  - `ModelAvailabilityService.refresh(selection): Promise<ModelAvailabilityResult>`

```ts
export interface CodexModelDescriptor {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{
    reasoningEffort: ReasoningEffort;
    description: string;
  }>;
  defaultReasoningEffort: ReasoningEffort;
}

export type ModelSelection =
  | { kind: "automatic" }
  | { kind: "exact"; model: string; reasoningEffort: ReasoningEffort | "automatic" };

export interface SelectedModel {
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface ModelAvailabilityResult {
  selection: ModelSelection;
  selected: SelectedModel;
  fallbackReason: "selected_model_unavailable" | "reasoning_effort_unavailable" | null;
}
```

- [ ] **Step 1: Replace string-only expectations with failing descriptor tests**

Add an app-server test whose first page contains a visible default model and a hidden model and whose second page contains another visible model. Assert all fields are preserved and the hidden item remains available to the policy layer for filtering.

Add selector tests:

```ts
expect(selectModel(models, { kind: "automatic" })).toEqual({
  model: "default-model",
  reasoningEffort: "medium",
});

expect(() =>
  selectModel(models, {
    kind: "exact",
    model: "missing",
    reasoningEffort: "automatic",
  }),
).toThrow("selected Codex model is unavailable");

const result = await availability.refresh({
  kind: "exact",
  model: "removed-model",
  reasoningEffort: "high",
});
expect(result).toEqual({
  selection: { kind: "automatic" },
  selected: { model: "default-model", reasoningEffort: "medium" },
  fallbackReason: "selected_model_unavailable",
});
expect(taskStops).toEqual(["model_unavailable"]);
```

- [ ] **Step 2: Run focused tests and confirm type/test failure**

```powershell
npm test -- tests/integration/appServerClient.test.ts tests/unit/modelSelector.test.ts tests/unit/modelAvailabilityService.test.ts
```

Expected: FAIL because `listModels()` still returns strings.

- [ ] **Step 3: Map the generated app-server model type**

Return every model-list property needed by the UI and selector, clone nested arrays, follow opaque cursors exactly as today, reject repeated cursors, and keep the 100-page bound.

- [ ] **Step 4: Implement selection without hardcoded model IDs**

- Automatic: choose the first non-hidden `isDefault` model; if none, choose the first non-hidden model.
- Exact: require a non-hidden exact model ID.
- Automatic reasoning: use the selected descriptor's default.
- Exact reasoning: require membership in `supportedReasoningEfforts`.
- An empty visible list throws `no visible Codex model is available`.

- [ ] **Step 5: Implement model availability reconciliation**

`ModelAvailabilityService` fetches the live list and reconciles the stored selection. If an exact model or reasoning effort disappears, it synchronously calls the injected `stopCurrentTask("model_unavailable")`, persists `{ kind: "automatic" }`, selects the current visible default, and emits a user-visible fallback event. It never continues or replays the interrupted turn.

- [ ] **Step 6: Update harnesses and run all Codex/companion tests**

```powershell
npm test -- tests/integration/appServerClient.test.ts tests/unit/modelSelector.test.ts tests/unit/modelAvailabilityService.test.ts tests/integration/companionService.test.ts tests/integration/app.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/codex/codexPort.ts src/codex/appServerClient.ts src/codex/modelSelector.ts src/codex/modelAvailabilityService.ts tests/integration/appServerClient.test.ts tests/unit/modelSelector.test.ts tests/unit/modelAvailabilityService.test.ts tests/support/companionHarness.ts tests/support/appHarness.ts tests/integration/companionService.test.ts tests/integration/app.test.ts
git commit -m "feat: select from live Codex model metadata"
```

### Task 2: Add ChatGPT account login lifecycle

**Files:**

- Create: `src/codex/accountPort.ts`
- Create: `src/codex/accountService.ts`
- Create: `tests/integration/accountService.test.ts`
- Modify: `src/codex/appServerClient.ts`
- Modify: `src/codex/codexPort.ts`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `apps/desktop/src-tauri/src/protocol.rs`
- Add: `protocol/desktop/v2/auth-start.json`
- Add: `protocol/desktop/v2/auth-status.json`

**Interfaces:**

- Produces:
  - `AccountSnapshot = { state: "signed_out" | "login_pending" | "signed_in"; emailHint?: string; planType?: string }`
  - `AccountService.status(): Promise<AccountSnapshot>`
  - `AccountService.beginChatGptLogin(): Promise<{ loginId: string; authUrl: string }>`
  - `AccountService.cancelLogin(loginId: string): Promise<void>`
  - `AccountService.logout(): Promise<void>`

- [ ] **Step 1: Write failing account-service tests**

```ts
it("starts only the ChatGPT browser login method", async () => {
  const harness = createAccountHarness();
  const login = harness.service.beginChatGptLogin();
  expect(await harness.nextRpc()).toEqual({
    method: "account/login/start",
    params: {
      type: "chatgpt",
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
      appBrand: "codex",
    },
  });
  harness.respond({ type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/x" });
  await expect(login).resolves.toEqual({
    loginId: "login-1",
    authUrl: "https://auth.openai.com/x",
  });
});

it.each(["apiKey", "amazonBedrock", "chatgptAuthTokens"])(
  "rejects an unexpected %s response",
  async (type) => {
    const harness = createAccountHarness();
    const login = harness.service.beginChatGptLogin();
    await harness.nextRpc();
    harness.respond({ type });
    await expect(login).rejects.toThrow("ChatGPT browser login was not started");
  },
);
```

- [ ] **Step 2: Run the test and confirm failure**

```powershell
npm test -- tests/integration/accountService.test.ts
```

Expected: FAIL because `AccountService` does not exist.

- [ ] **Step 3: Implement account app-server methods**

Use only generated v2 `account/read`, `account/login/start`, `account/login/cancel`, and `account/logout` requests. Subscribe to `account/login/completed` and `account/updated`; never accept or expose auth tokens.

Validate `authUrl` with `new URL()` and require HTTPS. The hostname must equal `openai.com` or `chatgpt.com`, or end with `.openai.com` or `.chatgpt.com`; suffix checks must include the leading dot to reject lookalike domains. Pass the complete validated URL to Rust for opening, but never write its query or fragment to logs.

- [ ] **Step 4: Add protocol v2 account commands and events**

Add:

- `get_account_status`
- `begin_chatgpt_login`
- `cancel_chatgpt_login`
- `logout_chatgpt`
- `refresh_models`

The Sidecar accepts v1 and v2 envelopes during this plan; the desktop sends v2. Unknown login methods remain schema-invalid.

- [ ] **Step 5: Run account, protocol, and Codex tests**

```powershell
npm test -- tests/integration/accountService.test.ts tests/unit/desktopProtocol.test.ts tests/integration/appServerClient.test.ts
npm run desktop:rust:test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/codex/accountPort.ts src/codex/accountService.ts src/codex/appServerClient.ts src/codex/codexPort.ts src/desktop/desktopProtocol.ts apps/desktop/src-tauri/src/protocol.rs protocol/desktop/v2 tests/integration/accountService.test.ts tests/unit/desktopProtocol.test.ts
git commit -m "feat: add ChatGPT browser login lifecycle"
```

### Task 3: Discover PCL2 without controlling it

**Files:**

- Create: `apps/desktop/src-tauri/src/pcl_discovery.rs`
- Create: `apps/desktop/src-tauri/src/windows_shortcut.rs`
- Create: `apps/desktop/src-tauri/tests/pcl_discovery.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/protocol.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/Cargo.lock`
- Modify: `src/desktop/desktopProtocol.ts`

**Interfaces:**

- Produces:

```rust
struct PclCandidate {
    id: String,
    path: String,
    source: PclCandidateSource, // running_process | start_menu | desktop | manual
    file_version: Option<String>,
}
```

- Tauri commands:
  - `discover_pcl2`
  - `select_pcl2_executable`.

- [ ] **Step 1: Write failing candidate normalization tests**

Use temporary fake shortcut and executable metadata adapters. Assert:

- Running process wins over shortcut duplicates.
- Paths are canonicalized case-insensitively.
- A shortcut with arguments returns only its executable target.
- A renamed executable with the verified product name `Plain Craft Launcher 2` is accepted.
- A manually selected executable without that verified product name is rejected.

- [ ] **Step 2: Run Cargo tests and confirm failure**

```powershell
npm run desktop:rust:test
```

Expected: FAIL because PCL discovery modules do not exist.

- [ ] **Step 3: Implement read-only discovery**

Check, in order:

1. Running process executable paths whose file product name is Plain Craft Launcher 2.
2. Current-user and all-user Start Menu `.lnk` targets.
3. Current-user Desktop `.lnk` targets.

Use Windows APIs for process image path, Shell Link resolution, and version resources. Do not launch, inject, focus, click, or modify PCL2.

Generate `id` as a process-local opaque identifier and retain the canonical-path mapping in Rust. Later commands accept this identifier, not a WebView-supplied executable or instance path.

- [ ] **Step 4: Implement native manual selection**

Open a native file dialog rooted at no privileged path, accept one `.exe`, validate canonical path and the file-version product name `Plain Craft Launcher 2`, and return only the validated candidate. Do not require a particular filename. The WebView never receives arbitrary directory-enumeration capability.

- [ ] **Step 5: Add protocol DTOs and run tests**

```powershell
npm run desktop:rust:test
npm test -- tests/unit/desktopProtocol.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/desktop/src-tauri/src/pcl_discovery.rs apps/desktop/src-tauri/src/windows_shortcut.rs apps/desktop/src-tauri/tests/pcl_discovery.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/protocol.rs apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock src/desktop/desktopProtocol.ts tests/unit/desktopProtocol.test.ts
git commit -m "feat: discover local PCL2 installations"
```

### Task 4: Enumerate Java listeners and probe loopback Minecraft

**Files:**

- Create: `apps/desktop/src-tauri/src/java_listeners.rs`
- Create: `apps/desktop/src-tauri/tests/java_listeners.rs`
- Create: `src/minecraft/lanProbe.ts`
- Create: `src/minecraft/compatibilityManifest.ts`
- Create: `tests/unit/lanProbe.test.ts`
- Create: `tests/unit/compatibilityManifest.test.ts`
- Create: `config/minecraft-compatibility.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `apps/desktop/src-tauri/src/protocol.rs`

**Interfaces:**

- Produces:

```ts
export interface ListenerCandidate {
  pid: number;
  processName: "java.exe" | "javaw.exe";
  port: number;
}

export interface LanCandidate {
  sessionId: string;
  listenerId: string;
  pid: number;
  port: number;
  protocolVersion: number;
  minecraftVersion: string;
  description: string;
  compatibility: "verified" | "experimental" | "unsupported";
}
```

- [ ] **Step 1: Write failing Rust listener filtering tests**

Feed synthetic TCP table rows and process names. Assert only listening TCP ports owned by `java.exe` or `javaw.exe`, with ports 1-65535, survive. Wildcard listeners are allowed as candidates but are represented only by PID and port.

- [ ] **Step 2: Write failing Node probe tests**

```ts
it("always probes a candidate through 127.0.0.1", async () => {
  const ping = vi.fn().mockResolvedValue(serverStatus);
  await probeLanCandidate({ pid: 42, processName: "javaw.exe", port: 51234 }, { ping });
  expect(ping).toHaveBeenCalledWith({ host: "127.0.0.1", port: 51234, closeTimeout: 2_000 });
});

it("marks an understood unverified protocol experimental", async () => {
  const candidate = await probeWithManifest({ supportedByProtocol: true, verified: false });
  expect(candidate.compatibility).toBe("experimental");
});
```

- [ ] **Step 3: Run focused tests and confirm failure**

```powershell
npm run desktop:rust:test
npm test -- tests/unit/lanProbe.test.ts tests/unit/compatibilityManifest.test.ts
```

Expected: FAIL because listener and probe modules do not exist.

- [ ] **Step 4: Implement native listener enumeration**

Use the Windows extended TCP table API to map listening sockets to PIDs and query process base names. Never return a remote address or accept a requested PID/port from the WebView.

- [ ] **Step 5: Implement bounded Minecraft status probing**

Add `minecraft-protocol` as an exact direct dependency. Probe only Rust-produced candidates, with a 2-second timeout, response-size bounds, sanitized MOTD text, and no automatic Mineflayer connection.

Rust assigns an opaque `listenerId` and retains its PID/listener mapping. Build `sessionId` as SHA-256 over the local tuple `listenerId\0pid\0port\0protocolVersion\0normalizedDescription`; do not include secrets.

- [ ] **Step 6: Implement the release compatibility manifest reader**

Schema:

```json
{
  "schemaVersion": 1,
  "verified": [
    {
      "minecraftVersion": "1.21.5",
      "protocolVersion": 770,
      "testedAt": "2026-07-27",
      "result": "pass"
    }
  ]
}
```

Reject duplicate protocol/version pairs, invalid dates, unknown fields, and manifests with fewer than one row during development. Plan 05 raises the release gate to at least three verified rows.

- [ ] **Step 7: Run tests and commit**

```powershell
npm run desktop:rust:test
npm test -- tests/unit/lanProbe.test.ts tests/unit/compatibilityManifest.test.ts
npm run typecheck
git add apps/desktop/src-tauri/src/java_listeners.rs apps/desktop/src-tauri/tests/java_listeners.rs src/minecraft/lanProbe.ts src/minecraft/compatibilityManifest.ts tests/unit/lanProbe.test.ts tests/unit/compatibilityManifest.test.ts config/minecraft-compatibility.json package.json package-lock.json src/desktop/desktopProtocol.ts apps/desktop/src-tauri/src/protocol.rs
git commit -m "feat: detect local Minecraft LAN candidates"
```

### Task 5: Implement confirmation and 60-second reconnect state

**Files:**

- Create: `src/session/sessionCoordinator.ts`
- Create: `src/session/sessionIdentity.ts`
- Create: `tests/unit/sessionCoordinator.test.ts`
- Create: `tests/support/sessionHarness.ts`
- Modify: `src/runtime/runtimeFacade.ts`
- Modify: `src/codex/modelAvailabilityService.ts`
- Modify: `src/desktop/sidecarServer.ts`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `apps/desktop/src-tauri/src/protocol.rs`

**Interfaces:**

- Produces:

```ts
type SessionState =
  | { kind: "idle" }
  | { kind: "detected"; candidate: LanCandidate }
  | { kind: "awaiting_confirmation"; candidate: LanCandidate }
  | { kind: "connecting"; sessionId: string }
  | { kind: "connected"; sessionId: string }
  | { kind: "reconnecting"; sessionId: string; deadline: string }
  | { kind: "stopped"; reason: string };

class SessionCoordinator {
  observe(candidates: readonly LanCandidate[]): Promise<void>;
  confirm(sessionId: string): Promise<void>;
  ignore(sessionId: string): void;
  onDisconnect(sessionId: string): void;
  stop(): Promise<void>;
  snapshot(): SessionState;
}
```

- [ ] **Step 1: Write the failing state-machine tests**

Test:

- Detection does not call `minecraft.connect()`.
- Exact desktop confirmation calls connect once.
- Confirmation for a stale session ID is rejected.
- Same identity reconnects during the 60-second window.
- Changed PID, port, protocol, or description produces `awaiting_confirmation`.
- Reconnect expiry returns to idle.
- Disconnect invalidates the task before scheduling reconnect.
- Experimental candidates force conservative safety mode.
- A model fallback while connected stops the task, keeps the world connected for new chat, and does not replay the interrupted request.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm test -- tests/unit/sessionCoordinator.test.ts
```

Expected: FAIL because `SessionCoordinator` does not exist.

- [ ] **Step 3: Implement the pure state machine**

Inject clock, timers, Minecraft connect/disconnect, task stop, and event publishing. Serialize state transitions through one promise tail. Clone candidates on input/output. Ignore duplicate observations of the current state.

- [ ] **Step 4: Extend desktop protocol v2**

Add:

- `list_lan_candidates`
- `confirm_lan_connection`
- `ignore_lan_candidate`
- `disconnect_current_world`

Publish `lan_candidate_detected`, `session_state_changed`, and `compatibility_warning` events.

- [ ] **Step 5: Integrate with `RuntimeFacade`**

Runtime startup now starts Codex/account services and detection readiness without connecting Minecraft. `SessionCoordinator.confirm()` creates the game runtime for the selected candidate.

- [ ] **Step 6: Run session, app, and Sidecar tests**

```powershell
npm test -- tests/unit/sessionCoordinator.test.ts tests/integration/runtimeFacade.test.ts tests/integration/sidecarServer.test.ts tests/integration/app.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/session/sessionCoordinator.ts src/session/sessionIdentity.ts tests/unit/sessionCoordinator.test.ts tests/support/sessionHarness.ts src/runtime/runtimeFacade.ts src/codex/modelAvailabilityService.ts src/desktop/sidecarServer.ts src/desktop/desktopProtocol.ts apps/desktop/src-tauri/src/protocol.rs tests/integration/runtimeFacade.test.ts tests/integration/sidecarServer.test.ts tests/integration/app.test.ts
git commit -m "feat: confirm and reconnect local LAN sessions"
```

### Task 6: Build the five-step onboarding UI

**Files:**

- Create: `apps/desktop/src/pages/OnboardingPage.tsx`
- Create: `apps/desktop/src/pages/OnboardingPage.test.tsx`
- Create: `apps/desktop/src/onboarding/onboardingState.ts`
- Create: `apps/desktop/src/onboarding/onboardingState.test.ts`
- Create: `apps/desktop/src/components/ModelPicker.tsx`
- Create: `apps/desktop/src/components/LanCandidateCard.tsx`
- Modify: `apps/desktop/src/runtimeClient.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**

- Produces `OnboardingState` with steps:
  - `installation`
  - `chatgpt_model`
  - `persona`
  - `safety_world`
  - `connection_test`.

- [ ] **Step 1: Write failing reducer and page tests**

Test:

- Steps cannot be skipped before their required completion state.
- Refreshing models preserves an available exact selection.
- A disappeared exact model visibly selects automatic and displays the fallback reason.
- Login opens only the validated `authUrl` returned through Rust.
- PCL2 absence is advisory and does not block the LAN test.
- Connection button is disabled until a live candidate exists.
- Experimental candidates show the conservative-mode warning.
- Closing and reopening resumes the last completed step.

- [ ] **Step 2: Run desktop tests and confirm failure**

```powershell
npm run desktop:test
```

Expected: FAIL because onboarding components do not exist.

- [ ] **Step 3: Implement onboarding state and typed client methods**

Persist only non-secret progress and user selections through the later settings interface stub. Keep auth state owned by Codex. Model picker renders app-server display names/descriptions and only supported reasoning efforts.

- [ ] **Step 4: Implement the approved layout**

Use the approved left-side five-step navigation and right-side content. The final connection test instructs the user to:

1. Start PCL2 manually.
2. Enter a singleplayer world.
3. Open to LAN.
4. Select the detected candidate and confirm.

Do not add a “Launch PCL2” button.

- [ ] **Step 5: Run frontend, Node, and Rust verification**

```powershell
npm run desktop:test
npm run desktop:build
npm test
npm run typecheck
npm run desktop:rust:test
```

Expected: all commands pass.

- [ ] **Step 6: Perform a real local smoke test**

With a disposable PCL2 world:

- Complete ChatGPT browser login.
- Confirm that only account-visible models appear.
- Open LAN and confirm the detected candidate.
- Verify the bot joins only after confirmation.
- Disconnect/reopen the same session inside 60 seconds and observe automatic reconnect.
- Restart Minecraft and verify a new confirmation is required.

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop/src/pages/OnboardingPage.tsx apps/desktop/src/pages/OnboardingPage.test.tsx apps/desktop/src/onboarding apps/desktop/src/components/ModelPicker.tsx apps/desktop/src/components/LanCandidateCard.tsx apps/desktop/src/runtimeClient.ts apps/desktop/src/App.tsx apps/desktop/src/styles.css
git commit -m "feat: add ChatGPT and LAN onboarding"
```
