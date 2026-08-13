# WhiteLily Persistent Application Exit Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one accessible, always-available “Quit WhiteLily” control that invokes the existing `ApplicationLifecycle.quit()` through a zero-argument, opaque IPC boundary.

**Architecture:** A small renderer component appears in both App top-level phases and calls a frozen preload API with no payload. The main-process IPC handler validates zero input and delegates to a callback captured from the one `ApplicationLifecycle` already created by `startElectronComposition`; it never creates a second lifecycle or calls process-management APIs directly.

**Tech Stack:** React 19, TypeScript, Electron IPC/preload, Vitest, Testing Library, Prettier.

## Global Constraints

- The control must be reachable in both Onboarding and main phases and expose native button semantics.
- `quitApplication(): Promise<void>` accepts no renderer payload and offers no force, PID, path, mode, or timeout option.
- The new main-process handler may only delegate to the existing `ApplicationLifecycle.quit()` path.
- Underlying failures must become one fixed opaque renderer error without `cause` or raw message propagation.
- Title-bar close-to-tray behavior remains unchanged.
- No new process termination, Restart Manager, coordinate, keyboard, Minecraft, LAN, or component-management capability is introduced.
- All implementation follows RED → GREEN → refactor; no test is added after production behavior.

---

### Task 1: Zero-argument preload API and IPC handler

**Files:**
- Modify: `apps/desktop/src/desktopApi.ts`
- Modify: `apps/desktop/src/desktopApi.task5.test.ts`
- Modify: `apps/desktop/src-main/ipcRegistry.ts`
- Modify: `apps/desktop/src-main/ipcRegistry.test.ts`

**Interfaces:**
- Produces: `WHITE_LILY_IPC_CHANNELS.quitApplication = "whitelily:quit-application"`.
- Produces: `WhiteLilyDesktopApi.quitApplication(): Promise<void>`.
- Consumes in IPC: `IpcRegistryOptions.requestApplicationQuit?: () => Promise<void>`.
- Produces renderer failure: fixed `Error("WhiteLily application quit failed")` with no cause.

- [ ] **Step 1: Write failing preload API tests**

Add tests that call the wished-for method and assert the exact transport call and zero-argument rejection:

```ts
const api = createWhiteLilyApi(transport);
await expect(api.quitApplication()).resolves.toBeUndefined();
expect(invoke).toHaveBeenCalledWith(WHITE_LILY_IPC_CHANNELS.quitApplication);
expect(Object.isFrozen(api)).toBe(true);
await expect(
  (api.quitApplication as (...args: unknown[]) => Promise<void>)("force"),
).rejects.toThrow("Desktop API does not accept input");
```

- [ ] **Step 2: Run the preload test and verify RED**

Run:

```powershell
npx vitest run apps/desktop/src/desktopApi.task5.test.ts
```

Expected: FAIL because `quitApplication` and its channel do not exist.

- [ ] **Step 3: Implement the minimal preload API**

Add the fixed channel, interface method, and frozen implementation:

```ts
quitApplication: async (...args: readonly unknown[]) => {
  validateNoDesktopApiInput(args);
  await transport.invoke(WHITE_LILY_IPC_CHANNELS.quitApplication);
},
```

- [ ] **Step 4: Run the preload test and verify GREEN**

Run the same Vitest command. Expected: all tests in the file pass with zero failures.

- [ ] **Step 5: Write failing IPC registry tests**

Extend the registry harness with a controlled callback and assert:

```ts
let quitCalls = 0;
const requestApplicationQuit = async (): Promise<void> => {
  quitCalls += 1;
};
await expect(harness.invoke(WHITE_LILY_IPC_CHANNELS.quitApplication)).resolves.toBeUndefined();
expect(quitCalls).toBe(1);
await expect(
  harness.invoke(WHITE_LILY_IPC_CHANNELS.quitApplication, { force: true }),
).rejects.toThrow("IPC input is not allowed");
expect(quitCalls).toBe(1);
```

Add a rejection sentinel and prove it is not leaked:

```ts
requestApplicationQuit: async () => {
  throw new Error("sentinel PID=1234 C:\\private\\raw.log");
},
```

Assert the rejection equals `WhiteLily application quit failed`, excludes `sentinel`, `1234`, and `private`, and has no `cause`. After calling registry cleanup, assert the channel handler has been removed.

- [ ] **Step 6: Run the IPC test and verify RED**

Run:

```powershell
npx vitest run apps/desktop/src-main/ipcRegistry.test.ts
```

Expected: FAIL because the registry option and handler do not exist.

- [ ] **Step 7: Implement the minimal IPC handler**

Add the optional callback to `IpcRegistryOptions`, register a zero-input handler only when it is present, and mask errors:

```ts
if (options.requestApplicationQuit) {
  options.ipcMain.handle(
    WHITE_LILY_IPC_CHANNELS.quitApplication,
    async (_event, ...args) => {
      validateNoIpcInput(args);
      try {
        await options.requestApplicationQuit?.();
      } catch {
        throw new Error("WhiteLily application quit failed");
      }
    },
  );
  registeredChannels.push(WHITE_LILY_IPC_CHANNELS.quitApplication);
}
```

- [ ] **Step 8: Run both focused files and verify GREEN**

Run:

```powershell
npx vitest run apps/desktop/src/desktopApi.task5.test.ts apps/desktop/src-main/ipcRegistry.test.ts
```

Expected: both files pass; no sentinel or raw path is printed.

---

### Task 2: Wire IPC to the single existing lifecycle

**Files:**
- Modify: `apps/desktop/src-main/main.ts`
- Modify: `apps/desktop/src-main/mainLifecycle.test.ts`

**Interfaces:**
- Consumes: `requestApplicationQuit(): Promise<void>` from Task 1.
- Produces: `ElectronStartupOptions.registerIpc(window, lifecycle)` so composition provides the already-created lifecycle instance.
- Preserves: tray and `before-quit` continue to use that same instance.

- [ ] **Step 1: Write the failing composition test**

Create a lifecycle test fixture that captures the callback passed into the IPC registration layer, invokes it twice concurrently, and asserts the existing lifecycle owns the operation:

```ts
let requestApplicationQuit: (() => Promise<void>) | undefined;
registerIpc: (_window, lifecycle) => {
  requestApplicationQuit = () => lifecycle.quit();
  return () => undefined;
},
```

Assert `supervisor.shutdown` and `app.quit` retain the existing lifecycle’s exact-once/idempotent behavior. Add a source guard that the production `requestApplicationQuit` callback contains `lifecycle.quit()` and no direct `app.quit()`, `process.kill`, or `forceTerminate` call.

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run:

```powershell
npx vitest run apps/desktop/src-main/mainLifecycle.test.ts
```

Expected: TypeScript/test failure because `registerIpc` receives only `window`.

- [ ] **Step 3: Implement the lifecycle composition change**

Change the startup port to:

```ts
registerIpc(window: TWindow, lifecycle: ApplicationLifecycle): () => void;
```

Call `options.registerIpc(mainWindow, lifecycle)` in `startElectronComposition`. In `runElectronMain`, pass exactly:

```ts
requestApplicationQuit: () => lifecycle.quit(),
```

to `registerIpcHandlers`. Do not create another lifecycle and do not change `ApplicationLifecycle` itself.

- [ ] **Step 4: Run lifecycle and IPC tests and verify GREEN**

Run:

```powershell
npx vitest run apps/desktop/src-main/mainLifecycle.test.ts apps/desktop/src-main/ipcRegistry.test.ts
```

Expected: both files pass, including exact-once and fixed-error assertions.

---

### Task 3: Always-visible accessible quit control

**Files:**
- Create: `apps/desktop/src/components/ApplicationExitButton.tsx`
- Create: `apps/desktop/src/components/ApplicationExitButton.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.task5.test.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/i18n/messageKeys.ts`
- Modify: `apps/desktop/src/i18n/zh-CN.ts`
- Modify: `apps/desktop/src/i18n/en.ts`
- Modify: `apps/desktop/src/i18n/i18n.test.ts`

**Interfaces:**
- Consumes: `api.quitApplication(): Promise<void>` from Task 1.
- Produces: `ApplicationExitButton({ api, locale })`.
- Produces i18n keys: `app.quit`, `app.quitting`, `app.quitFailed`.

- [ ] **Step 1: Write the failing component tests**

Test a real button with an accessible name, exact-once click, busy state, and fixed failure recovery:

```tsx
render(<ApplicationExitButton api={api} locale="zh-CN" />);
const button = screen.getByRole("button", { name: "退出 WhiteLily" });
await user.click(button);
expect(api.quitApplication).toHaveBeenCalledTimes(1);
expect(button).toBeDisabled();
```

For rejection, settle the Promise and assert the button is enabled again and `role="status"` contains only the localized fixed `app.quitFailed` text, never the sentinel rejection message.

- [ ] **Step 2: Run the component test and verify RED**

Run:

```powershell
npx vitest run apps/desktop/src/components/ApplicationExitButton.test.tsx
```

Expected: FAIL because the component and i18n keys do not exist.

- [ ] **Step 3: Implement the minimal component**

Use local busy/error state and guard state updates after unmount:

```tsx
export function ApplicationExitButton({ api, locale }: Props) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);
  const quit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await api.quitApplication();
    } catch {
      if (mounted.current) {
        setBusy(false);
        setFailed(true);
      }
    }
  };
  // render native button and fixed status text
}
```

- [ ] **Step 4: Run the component tests and verify GREEN**

Run the same focused command. Expected: all component cases pass.

- [ ] **Step 5: Write failing App reachability tests**

In `App.task5.test.tsx`, assert one and only one `Quit WhiteLily` button appears during checking, Onboarding, and main. Assert the Onboarding button is inside `.onboarding-topbar`, while the main button is inside an app-level chrome element and remains present after navigation to Settings.

- [ ] **Step 6: Run App/i18n tests and verify RED**

Run:

```powershell
npx vitest run apps/desktop/src/App.task5.test.tsx apps/desktop/src/i18n/i18n.test.ts
```

Expected: FAIL because App does not render the component and the message catalogs lack the keys.

- [ ] **Step 7: Integrate the component and styles**

Render `ApplicationExitButton` in the Onboarding topbar and in a new main app chrome sibling of `Sidebar`. Add restrained styles that preserve existing responsive behavior, visible focus, and disabled state. Add exact Chinese and English strings:

```ts
"app.quit": "退出 WhiteLily",
"app.quitting": "正在退出…",
"app.quitFailed": "无法退出 WhiteLily，请重试。",
```

```ts
"app.quit": "Quit WhiteLily",
"app.quitting": "Quitting…",
"app.quitFailed": "WhiteLily could not quit. Please try again.",
```

- [ ] **Step 8: Run renderer tests and verify GREEN**

Run:

```powershell
npx vitest run apps/desktop/src/components/ApplicationExitButton.test.tsx apps/desktop/src/App.task5.test.tsx apps/desktop/src/i18n/i18n.test.ts apps/desktop/src/desktopApi.task5.test.ts
```

Expected: all focused renderer tests pass with no console warnings.

---

### Task 4: Preload bundle and regression verification

**Files:**
- Modify only if RED requires it: `apps/desktop/src-main/preloadBundle.test.ts`
- Verify: all files changed in Tasks 1–3

**Interfaces:**
- Consumes all production interfaces from Tasks 1–3.
- Produces no new behavior; this task verifies the packaged preload and repository gates.

- [ ] **Step 1: Run the preload bundle test**

Run:

```powershell
npx vitest run apps/desktop/src-main/preloadBundle.test.ts
```

Expected: PASS and bundled preload exposes `quitApplication` through the frozen API. If the test lacks a surface assertion, first add that assertion, observe RED, then make the minimal build/test fixture update needed for GREEN.

- [ ] **Step 2: Run desktop typecheck**

Run:

```powershell
npm --prefix apps/desktop run typecheck
```

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 3: Run focused implementation tests**

Run:

```powershell
npx vitest run apps/desktop/src/desktopApi.task5.test.ts apps/desktop/src-main/ipcRegistry.test.ts apps/desktop/src-main/mainLifecycle.test.ts apps/desktop/src/components/ApplicationExitButton.test.tsx apps/desktop/src/App.task5.test.tsx apps/desktop/src/i18n/i18n.test.ts apps/desktop/src-main/preloadBundle.test.ts
```

Expected: all files pass, zero failed tests.

- [ ] **Step 4: Run formatting checks**

Run:

```powershell
npx prettier --check apps/desktop/src/desktopApi.ts apps/desktop/src/desktopApi.task5.test.ts apps/desktop/src-main/ipcRegistry.ts apps/desktop/src-main/ipcRegistry.test.ts apps/desktop/src-main/main.ts apps/desktop/src-main/mainLifecycle.test.ts apps/desktop/src/components/ApplicationExitButton.tsx apps/desktop/src/components/ApplicationExitButton.test.tsx apps/desktop/src/App.tsx apps/desktop/src/App.task5.test.tsx apps/desktop/src/styles.css apps/desktop/src/i18n/messageKeys.ts apps/desktop/src/i18n/zh-CN.ts apps/desktop/src/i18n/en.ts apps/desktop/src/i18n/i18n.test.ts
```

Expected: all listed files conform to Prettier.

- [ ] **Step 5: Run desktop and root full suites**

Run:

```powershell
npm --prefix apps/desktop test -- --run
npm test -- --run
npm run typecheck
npm run format:check
```

Expected: every command exits 0; only the repository’s existing explicitly documented privilege skip may remain.

- [ ] **Step 6: Review and commit the implementation**

Inspect `git diff --check`, `git diff --stat`, and the complete diff. Confirm there are no unrelated changes or generated residue, then commit:

```powershell
git add -- apps/desktop/src apps/desktop/src-main
git commit -m "feat: add persistent application exit control"
```

---

### Task 5: Package and host acceptance continuation

**Files:**
- Generated artifact: `release/WhiteLily-0.2.0-beta.2-windows-x64-setup.exe`
- Update after accepted run: tracked installer attestation files selected by the existing release-readiness workflow

**Interfaces:**
- Consumes the committed exit-control implementation.
- Produces a newly inspected installer and lifecycle report before host upgrade.

- [ ] **Step 1: Repackage from a clean tracked HEAD**

Run the existing package workflow with the reviewed Java 21 environment:

```powershell
npm run desktop:package
npm run desktop:inspect-installer
```

Expected: both commands exit 0; inspector reports the expected component/resource counts and no transaction residue.

- [ ] **Step 2: Run the real Sandbox lifecycle**

Run the production interface with the exact new installer path:

```powershell
npm run desktop:test-installer -- -InstallerPath release\WhiteLily-0.2.0-beta.2-windows-x64-setup.exe
```

Expected: exact lifecycle success, candidate and baseline hashes verified, final Sandbox cleanup zero.

- [ ] **Step 3: Reattest the superseding artifact**

Update the existing four tracked attestation files with the new candidate byte count, SHA-256, lifecycle report byte count/SHA/time, and current commit. Run focused attestation/release tests, direct verifier, format, typecheck, and full root suite before committing the attestation-only change.

- [ ] **Step 4: Exercise the new control on the host**

Before host upgrade, require the existing Minecraft/PCL/world/data fence. Invoke the unique semantic `Quit WhiteLily` button once via UI Automation. Accept only WhiteLily process count 0 with PCL/Minecraft identities, listener category, protected worlds, target world, mods, preferences, and candidate unchanged.

- [ ] **Step 5: Upgrade and resume Task 9**

Run the new installer through its normal current-user upgrade path, verify installed resources and user data, launch WhiteLily normally, and continue the already documented component-install and direct-world acceptance plan. Do not treat this feature task as completing the remaining Minecraft component/chat/model/failure-recovery checks.
