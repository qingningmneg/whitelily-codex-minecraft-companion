# WhiteLily Public Beta 02 Desktop Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a launchable Tauri 2 desktop control center that supervises the compiled Node runtime Sidecar through a versioned stdio protocol and always exposes a native emergency stop.

**Architecture:** Add an npm workspace for a React/Vite WebView and a Rust Tauri host. The WebView can invoke only named Tauri commands; Rust owns the Sidecar process and communicates with it over newline-delimited JSON on inherited stdio. The Sidecar wraps the `RuntimeFacade` created in Plan 01.

**Tech Stack:** Tauri 2, Rust stable MSVC toolchain, React, TypeScript, Vite, Zod, Node.js 24, Vitest, Cargo test

## Global Constraints

- Plan 01 must be merged and green before this plan begins.
- Execute in a fresh worktree created with `superpowers:using-git-worktrees`.
- Windows 10/11 x64 is the target platform.
- The WebView receives no arbitrary filesystem, process, Shell, Codex, or Minecraft capability.
- Rust ↔ Node uses child-process stdio; do not add a desktop HTTP control port.
- Rust is the single-instance owner and final emergency-stop authority.
- The Sidecar must never write protocol-external text to stdout; diagnostics go to stderr or local structured logs.
- Node.js and Codex executables are bundled later in Plan 05; development may resolve them from explicit test paths only.
- All npm dependencies must be saved exactly and committed in `package-lock.json`; all Rust dependencies must be committed in `Cargo.lock`.
- Existing Node CLI behavior and tests remain passing.
- Use test-driven development and commit after every independently reviewable task.

---

### Task 1: Add the desktop workspace and reproducible Tauri scaffold

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/src/main.tsx`
- Create: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/styles.css`
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/Cargo.lock`
- Create: `apps/desktop/src-tauri/build.rs`
- Create: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src-tauri/capabilities/default.json`
- Create: `apps/desktop/src-tauri/src/main.rs`
- Create: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `.gitignore`

**Interfaces:**

- Produces root scripts:
  - `desktop:dev`
  - `desktop:build`
  - `desktop:test`
  - `desktop:rust:test`
- Produces npm workspace `@whitelily/desktop`.

- [ ] **Step 1: Add a failing foundation test**

Create `apps/desktop/src/foundation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import desktopPackage from "../package.json";

describe("desktop foundation", () => {
  it("uses the WhiteLily product identity", () => {
    expect(desktopPackage.name).toBe("@whitelily/desktop");
    expect(desktopPackage.private).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and confirm the workspace is missing**

Run:

```powershell
npm test -- apps/desktop/src/foundation.test.ts
```

Expected: FAIL because the desktop workspace does not exist.

- [ ] **Step 3: Create the workspace package and install exact dependencies**

Start `apps/desktop/package.json` with:

```json
{
  "name": "@whitelily/desktop",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "tauri": "tauri"
  }
}
```

Add `"workspaces": ["apps/desktop"]` to the root package. Install the current Tauri 2, React, Vite, and Vitest releases with exact npm versions:

```powershell
npm install --workspace @whitelily/desktop --save-exact react react-dom @tauri-apps/api
npm install --workspace @whitelily/desktop --save-dev --save-exact @tauri-apps/cli @vitejs/plugin-react vite vitest typescript @types/react @types/react-dom
```

Do not use caret or tilde ranges.

- [ ] **Step 4: Create the minimal Rust host**

Use a Tauri 2 `lib.rs` entry:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to run WhiteLily desktop");
}
```

Set product name `WhiteLily`, identifier `io.github.qingningmneg.whitelily`, Windows targets, CSP, development URL, frontend distribution path, and one main window in `tauri.conf.json`.

- [ ] **Step 5: Deny unused WebView capabilities**

`capabilities/default.json` must use `"windows": ["main"]` and `"permissions": ["core:default"]` only. Do not grant shell, filesystem, process, updater, HTTP, opener, or dialog plugins in this task.

- [ ] **Step 6: Add root scripts and run both builds**

Root scripts:

```json
{
  "desktop:dev": "npm run dev --workspace @whitelily/desktop",
  "desktop:build": "npm run build --workspace @whitelily/desktop",
  "desktop:test": "npm run test --workspace @whitelily/desktop",
  "desktop:rust:test": "cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml"
}
```

Run:

```powershell
npm run desktop:test
npm run desktop:build
npm run desktop:rust:test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add package.json package-lock.json .gitignore apps/desktop
git commit -m "feat: scaffold the Tauri desktop control center"
```

### Task 2: Define and test the versioned desktop protocol

**Files:**

- Create: `src/desktop/desktopProtocol.ts`
- Create: `tests/unit/desktopProtocol.test.ts`
- Create: `protocol/desktop/v1/request-status.json`
- Create: `protocol/desktop/v1/response-status.json`
- Create: `protocol/desktop/v1/event-lifecycle.json`
- Create: `apps/desktop/src-tauri/src/protocol.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**

- Produces:
  - `DESKTOP_PROTOCOL_VERSION = 1`
  - `DesktopRequest`
  - `DesktopResponse`
  - `DesktopEvent`
  - `parseDesktopRequest(value: unknown): DesktopRequest`
  - `parseDesktopResponse(value: unknown): DesktopResponse`
  - matching Rust `serde` enums and structs.

- [ ] **Step 1: Write failing TypeScript fixture tests**

```ts
describe("desktop protocol v1", () => {
  it("accepts the committed request fixture", async () => {
    const fixture = JSON.parse(
      await readFile("protocol/desktop/v1/request-status.json", "utf8"),
    );
    expect(parseDesktopRequest(fixture)).toEqual({
      version: 1,
      id: "req-1",
      command: { kind: "get_status" },
    });
  });

  it("rejects unknown commands and fields", () => {
    expect(() =>
      parseDesktopRequest({
        version: 1,
        id: "req-1",
        command: { kind: "run_shell", text: "whoami" },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```powershell
npm test -- tests/unit/desktopProtocol.test.ts
```

Expected: FAIL because the protocol module does not exist.

- [ ] **Step 3: Implement strict Zod envelopes**

Requests are exactly:

```ts
type DesktopCommand =
  | { kind: "get_status" }
  | { kind: "start_runtime" }
  | { kind: "stop_runtime"; reason: "owner_stop" | "process_exit" }
  | { kind: "emergency_stop" };
```

Responses are exactly:

```ts
type DesktopResponse =
  | { version: 1; id: string; ok: true; result: RuntimeSnapshot }
  | { version: 1; id: string; ok: false; error: { code: string; message: string } };
```

Events wrap the `RuntimeEvent` union from Plan 01. Every object schema is `.strict()`, IDs are 1-64 safe ASCII characters, and input lines are capped at 1 MiB.

- [ ] **Step 4: Implement matching Rust Serde types**

Use `#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]` for commands and events. Add Rust tests that deserialize every committed fixture and reject `run_shell`.

- [ ] **Step 5: Run both protocol test suites**

Run:

```powershell
npm test -- tests/unit/desktopProtocol.test.ts
npm run desktop:rust:test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/desktop/desktopProtocol.ts tests/unit/desktopProtocol.test.ts protocol/desktop apps/desktop/src-tauri/src/protocol.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: define the desktop sidecar protocol"
```

### Task 3: Build the Node Sidecar protocol server

**Files:**

- Create: `src/desktop/sidecarServer.ts`
- Create: `src/desktop/sidecarMain.ts`
- Create: `tests/integration/sidecarServer.test.ts`
- Create: `tests/support/sidecarHarness.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Interfaces:**

- Consumes: `RuntimeFacade` and desktop protocol from Plans 01 and 02.
- Produces:
  - `SidecarServer.start(): void`
  - `SidecarServer.stop(): Promise<void>`
  - executable build entry `dist/src/desktop/sidecarMain.js`.

- [ ] **Step 1: Write failing protocol lifecycle tests**

```ts
describe("SidecarServer", () => {
  it("answers status and publishes lifecycle events", async () => {
    const harness = createSidecarHarness();
    harness.send({ version: 1, id: "1", command: { kind: "start_runtime" } });
    await expect(harness.nextResponse()).resolves.toMatchObject({ id: "1", ok: true });
    await expect(harness.nextEvent()).resolves.toMatchObject({
      event: { kind: "lifecycle", state: "running" },
    });
  });

  it("executes emergency stop before acknowledging", async () => {
    const harness = createSidecarHarness();
    harness.send({ version: 1, id: "2", command: { kind: "emergency_stop" } });
    await harness.nextResponse();
    expect(harness.runtime.stopReasons()).toEqual(["emergency_stop"]);
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```powershell
npm test -- tests/integration/sidecarServer.test.ts
```

Expected: FAIL because `SidecarServer` does not exist.

- [ ] **Step 3: Implement bounded NDJSON input**

Read stdin incrementally, reject a line over 1 MiB without buffering the remainder, parse one request at a time, and serialize writes through one output queue. Protocol responses and events go to stdout; safe logs go to stderr.

- [ ] **Step 4: Implement command dispatch**

Map only the four v1 commands to `RuntimeFacade`. Convert thrown errors to stable codes:

- `INVALID_REQUEST`
- `RUNTIME_START_FAILED`
- `RUNTIME_STOP_FAILED`
- `EMERGENCY_STOP_FAILED`
- `INTERNAL_ERROR`

Never include stack traces or filesystem paths in protocol responses.

- [ ] **Step 5: Add a production Sidecar entry**

`sidecarMain.ts` composes the runtime from `createApp`, creates the facade, starts the server, and translates stdin EOF/SIGTERM into `stop("process_exit")`.

- [ ] **Step 6: Run integration and build checks**

Run:

```powershell
npm test -- tests/integration/sidecarServer.test.ts
npm run typecheck
npm run build
node dist/src/desktop/sidecarMain.js < $null
```

Expected: tests and build pass; the final command exits cleanly without stdout noise.

- [ ] **Step 7: Commit**

```powershell
git add src/desktop/sidecarServer.ts src/desktop/sidecarMain.ts tests/integration/sidecarServer.test.ts tests/support/sidecarHarness.ts package.json tsconfig.json
git commit -m "feat: expose the runtime through a bounded sidecar"
```

### Task 4: Supervise the Sidecar from Rust

**Files:**

- Create: `apps/desktop/src-tauri/src/sidecar.rs`
- Create: `apps/desktop/src-tauri/src/state.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/Cargo.lock`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`

**Interfaces:**

- Produces:
  - `SidecarSupervisor::start()`
  - `SidecarSupervisor::request(command, timeout)`
  - `SidecarSupervisor::emergency_stop()`
  - `SidecarSupervisor::shutdown()`
  - `RestartPolicy` with delays `[1_000, 2_000, 4_000]` ms and at most three attempts per application run.
  - Tauri commands `get_runtime_status`, `start_runtime`, `stop_runtime`, `emergency_stop`.

- [ ] **Step 1: Write failing Rust supervisor tests**

```rust
#[tokio::test]
async fn rejects_a_second_live_sidecar() {
    let harness = SupervisorHarness::new();
    let supervisor = harness.supervisor();
    supervisor.start().await.unwrap();
    let error = supervisor.start().await.unwrap_err();
    assert_eq!(error.code(), "SIDECAR_ALREADY_RUNNING");
}

#[tokio::test]
async fn kills_the_child_when_emergency_ack_times_out() {
    let harness = SupervisorHarness::with_hung_sidecar();
    let supervisor = harness.supervisor();
    supervisor.start().await.unwrap();
    supervisor.emergency_stop().await.unwrap();
    assert!(harness.child_was_killed());
}

#[tokio::test]
async fn retries_three_times_without_resuming_the_old_task() {
    let harness = SupervisorHarness::with_crashing_sidecar();
    let supervisor = harness.supervisor();
    supervisor.start().await.unwrap();
    harness.fire_all_restart_timers().await;
    assert_eq!(harness.restart_delays(), vec![1_000, 2_000, 4_000]);
    assert_eq!(harness.start_commands_after_restart(), 0);
    assert_eq!(supervisor.state().await, SupervisorState::Failed);
}
```

- [ ] **Step 2: Run Cargo tests and confirm failure**

Run:

```powershell
npm run desktop:rust:test
```

Expected: FAIL because `SidecarSupervisor` does not exist.

- [ ] **Step 3: Implement child supervision**

Use `tauri-plugin-shell` only inside Rust to spawn the configured external binary. Capture stdin/stdout/stderr separately, parse only protocol stdout, cap lines at 1 MiB, and route stderr to the local logger. Maintain a request map by ID and fail every pending request on child exit.

On an unexpected child exit, publish the crash, wait 1, 2, then 4 seconds, and start a clean Sidecar at most three times in the current application run. A restarted Sidecar remains idle and never receives `start_runtime` automatically, so an unfinished game task cannot resume. An intentional stop, emergency stop, or application quit disables restart.

- [ ] **Step 4: Implement bounded emergency stop**

Send `emergency_stop`, wait at most 1,500 ms for the response, then kill the child if no acknowledgement arrives. Always clear supervisor state and emit a desktop `runtime-event` with stopped/error status.

- [ ] **Step 5: Register only four Tauri commands**

```rust
.invoke_handler(tauri::generate_handler![
    get_runtime_status,
    start_runtime,
    stop_runtime,
    emergency_stop
])
```

Each command accepts no path, executable, URL, arbitrary JSON method name, or shell text.

- [ ] **Step 6: Run Rust tests and a development smoke start**

Run:

```powershell
npm run desktop:rust:test
npm run build
npm run desktop:dev
```

Expected: Cargo tests pass and the development window opens without capability warnings.

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop/src-tauri/src/sidecar.rs apps/desktop/src-tauri/src/state.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/tauri.conf.json
git commit -m "feat: supervise the WhiteLily sidecar"
```

### Task 5: Implement the approved control-center home

**Files:**

- Create: `apps/desktop/src/runtimeClient.ts`
- Create: `apps/desktop/src/runtimeClient.test.ts`
- Create: `apps/desktop/src/components/Sidebar.tsx`
- Create: `apps/desktop/src/components/StatusCard.tsx`
- Create: `apps/desktop/src/pages/HomePage.tsx`
- Create: `apps/desktop/src/pages/HomePage.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: four Rust Tauri commands and `runtime-event`.
- Produces:
  - `RuntimeClient.status()`
  - `RuntimeClient.start()`
  - `RuntimeClient.stop()`
  - `RuntimeClient.emergencyStop()`
  - `RuntimeClient.subscribe(listener)`.

- [ ] **Step 1: Install exact UI test dependencies**

```powershell
npm install --workspace @whitelily/desktop --save-dev --save-exact @testing-library/react @testing-library/user-event jsdom
```

- [ ] **Step 2: Write failing home-page tests**

```tsx
it("shows world, companion, model, safety, and emergency state", () => {
  render(<HomePage snapshot={connectedSnapshot} onEmergencyStop={vi.fn()} />);
  expect(screen.getByText("当前世界")).toBeVisible();
  expect(screen.getByText("伙伴状态")).toBeVisible();
  expect(screen.getByText("AI 模型")).toBeVisible();
  expect(screen.getByText("安全状态")).toBeVisible();
  expect(screen.getByRole("button", { name: "紧急停止" })).toBeVisible();
});

it("requires one deliberate click but no confirmation dialog for emergency stop", async () => {
  const stop = vi.fn();
  render(<HomePage snapshot={connectedSnapshot} onEmergencyStop={stop} />);
  await userEvent.click(screen.getByRole("button", { name: "紧急停止" }));
  expect(stop).toHaveBeenCalledOnce();
});
```

- [ ] **Step 3: Run the desktop tests and confirm failure**

Run:

```powershell
npm run desktop:test
```

Expected: FAIL because `HomePage` does not exist.

- [ ] **Step 4: Implement the approved information hierarchy**

Create sidebar items for Home, Persona, Memory, Worlds & Safety, AI Model, Diagnostics & Audit, and Settings. Home renders current world/compatibility, connection state, companion/mode/model/memory scope, safety mode/task/budget, recent activity, and a visually dominant emergency-stop button.

Do not add high-risk mode to any quick action.

- [ ] **Step 5: Implement a typed Tauri client**

Centralize all `invoke` and `listen` calls in `runtimeClient.ts`. Validate event payloads with the protocol schema before updating React state. Invalid events become a visible local error and are not merged into state.

- [ ] **Step 6: Run UI tests and production frontend build**

Run:

```powershell
npm run desktop:test
npm run desktop:build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop/src apps/desktop/package.json package-lock.json
git commit -m "feat: add the desktop control-center home"
```

### Task 6: Add tray, single-instance behavior, and native stop integration

**Files:**

- Create: `apps/desktop/src-tauri/src/tray.rs`
- Create: `apps/desktop/src-tauri/src/single_instance.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/Cargo.lock`
- Create: `apps/desktop/src-tauri/tests/desktop_lifecycle.rs`
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**

- Produces tray actions:
  - `open_control_center`
  - `connect_or_disconnect`
  - `toggle_proactive_messages`
  - `emergency_stop`
  - `quit`.

- [ ] **Step 1: Write failing Rust menu and single-instance tests**

Test that the tray model contains exactly the five allowed actions and never contains `enable_high_risk`. Test that a second-instance callback focuses the existing main window and does not spawn another Sidecar.

- [ ] **Step 2: Run Cargo tests and confirm failure**

Run:

```powershell
npm run desktop:rust:test
```

Expected: FAIL because tray and single-instance modules do not exist.

- [ ] **Step 3: Implement the tray menu**

Use Tauri's native tray API. Route emergency stop directly to `SidecarSupervisor::emergency_stop`; do not open a WebView confirmation. `quit` must await bounded shutdown and then terminate the application.

- [ ] **Step 4: Implement single-instance focus**

Add the official Tauri single-instance plugin, keep it registered before other plugins, and show/focus the existing window on a second launch. Never forward arbitrary second-instance command-line arguments to the Sidecar.

- [ ] **Step 5: Run full desktop and Node verification**

Run:

```powershell
npm run format:check
npm run typecheck
npm test
npm run build
npm run desktop:test
npm run desktop:build
npm run desktop:rust:test
```

Expected: all commands pass.

- [ ] **Step 6: Perform a manual desktop smoke test**

Run:

```powershell
npm run desktop:dev
```

Verify:

- One main window opens.
- A second launch focuses the first.
- Tray “Open” restores the window.
- Tray “Emergency stop” stops the Sidecar even after using the test-only hung-sidecar fixture.
- Tray “Quit” leaves no Sidecar process.

- [ ] **Step 7: Commit**

```powershell
git add apps/desktop/src-tauri apps/desktop/src/App.tsx
git commit -m "feat: add native tray and emergency controls"
```
