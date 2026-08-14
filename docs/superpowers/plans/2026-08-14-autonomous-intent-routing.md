# Autonomous Intent Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WhiteLily directly execute clear Minecraft action requests, chat naturally for conversational messages, and clarify only genuinely missing execution-critical information.

**Architecture:** Keep the existing model-based semantic router and strict JSON decision schema. Add one focused decision-policy block to the generated owner-intent prompt, backed by a prompt-contract regression test and a live end-to-end check.

**Tech Stack:** TypeScript 7, Vitest 4, Zod 4, Electron desktop bundle, Mineflayer.

## Global Constraints

- Do not hard-code Chinese command matching or add a second classifier.
- Do not change task budgets, decision schemas, Minecraft tools, or transport behavior.
- `clarify` is allowed only when an execution-critical value cannot be inferred safely.
- Clear action requests must not require confirmation or a chat-versus-action choice.

---

### Task 1: Add the autonomous intent policy

**Files:**
- Modify: `tests/unit/intentRouter.test.ts`
- Modify: `src/companion/intentRouter.ts`

**Interfaces:**
- Consumes: `buildOwnerIntentTurn(input: OwnerIntentContext): string`
- Produces: the same function signature with an expanded semantic decision contract in its returned prompt

- [ ] **Step 1: Write the failing regression test**

Add a `buildOwnerIntentTurn` test that builds both inactive-task and active-task prompts and asserts that the prompt contract:

```ts
it("states when to act, chat, or request missing execution details", () => {
  const prompt = intentTurn();

  expect(prompt).toContain("Prefer a task decision when the owner reasonably requests an observable in-world action");
  expect(prompt).toContain("Do not ask whether the owner wants to chat or take action");
  expect(prompt).toContain("Use chat for conversation");
  expect(prompt).toContain("Use clarify only when execution-critical information");
  expect(prompt).toContain('"Come to me." -> start_task');
  expect(prompt).toContain('"Good morning." -> chat');
  expect(prompt).toContain('"Put it there."');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npx vitest run tests/unit/intentRouter.test.ts
```

Expected: the new test fails because the generated prompt does not yet contain the decision policy.

- [ ] **Step 3: Implement the smallest prompt change**

Add a private `ownerIntentDecisionPolicyPrompt` string in `src/companion/intentRouter.ts` and include it once in `buildOwnerIntentTurn()` before the schema contract. It must state the selected policy and include the four semantic examples from the design without changing parsing or execution code.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
npx vitest run tests/unit/intentRouter.test.ts tests/integration/companionService.test.ts
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 5: Run type checks**

Run:

```powershell
npm run typecheck
npm run typecheck --workspace @whitelily/desktop
```

Expected: both commands exit 0.

### Task 2: Prepare, install, and validate the desktop runtime

**Files:**
- Generated: `packaging/electron/core/companion/intentRouter.js`
- Generated: `packaging/electron/runtime-manifest.json`
- Installed runtime under `%LOCALAPPDATA%\\Programs\\WhiteLily` or the currently detected WhiteLily installation root

**Interfaces:**
- Consumes: the verified TypeScript intent policy
- Produces: a locally installed desktop runtime whose bundled core contains that policy

- [ ] **Step 1: Prepare the Electron bundle with Java 21**

Set `JAVA_HOME` and prepend `bin` from `C:\\Users\\Admin\\AppData\\Roaming\\.minecraft\\runtime\\java-runtime-delta`, then run `npm run desktop:prepare`.

- [ ] **Step 2: Validate generated artifacts**

Verify the compiled `packaging/electron/core/companion/intentRouter.js` contains the policy and run the focused electron-bundle/runtime-manifest tests used by the repository.

- [ ] **Step 3: Back up and install**

Detect the active WhiteLily installation and data roots, create a timestamped backup under `%LOCALAPPDATA%\\WhiteLily\\updates`, close only WhiteLily, and replace only the prepared application runtime files. Do not restart Minecraft.

- [ ] **Step 4: Restart and reconnect WhiteLily**

Launch WhiteLily, wait for the desktop UI to become ready, and reconnect it to the already running Minecraft world.

- [ ] **Step 5: Perform the live regression check**

Send `来我身边` in Minecraft. Confirm logs show a `start_task` (or semantically correct task continuation/replacement if a task is active), a movement attempt, and no “聊天还是做事” question. Also send a normal conversational message and confirm it receives a chat reply without movement.

- [ ] **Step 6: Commit the verified fix**

Stage only the design, plan, intent-router source, regression test, and required generated manifest/bundle artifacts, then commit with:

```powershell
git commit -m "fix: make owner intent routing autonomous"
```
