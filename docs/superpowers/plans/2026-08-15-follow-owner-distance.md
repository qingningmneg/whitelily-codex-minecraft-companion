# Follow Owner Distance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `maxHorizontalTravel` from being misused as `minecraft_follow_owner.distance` for “come to me” requests.

**Architecture:** Preserve the strict tool schema and safety engine. Clarify the model-visible semantic contract at both prompt construction and dynamic tool discovery, then verify the packaged runtime against the live Minecraft world.

**Tech Stack:** TypeScript 7, Zod 4, Vitest 4, Electron, Mineflayer

## Global Constraints

- `minecraft_follow_owner.distance` remains an integer from 2 through 16.
- Default the following gap to `2` only when the owner does not specify another valid gap.
- Never copy `maxHorizontalTravel` into the following-gap argument.
- Do not clamp or coerce invalid tool arguments.
- Do not close Minecraft during build, install, or verification.

---

### Task 1: Lock the model-visible following-gap contract

**Files:**
- Modify: `tests/unit/promptBuilder.test.ts`
- Modify: `tests/unit/minecraftDynamicTools.test.ts`
- Modify: `src/companion/promptBuilder.ts`
- Modify: `src/mcp/toolRegistry.ts`

**Interfaces:**
- Consumes: `buildCompanionTaskExecutionTurn(input)` and `createMinecraftDynamicTools(dependencies)`
- Produces: an execution prompt and dynamic tool specification that define `distance` as a 2–16 block owner gap, defaulting to 2 for an unspecified “come to me” request

- [ ] **Step 1: Write failing regression tests**

```ts
expect(prompt).toContain("For minecraft_follow_owner, distance is the desired gap from the owner")
expect(prompt).toContain("use distance 2")
expect(prompt).toContain("Never copy maxHorizontalTravel into distance")
expect(followOwner?.description).toContain("Use 2 when the owner asks WhiteLily to come beside them")
```

- [ ] **Step 2: Verify the tests fail for the missing semantic contract**

Run: `npm test -- tests/unit/promptBuilder.test.ts tests/unit/minecraftDynamicTools.test.ts`

Expected: both new assertions fail because the guidance is absent.

- [ ] **Step 3: Implement the minimal contract clarification**

Add the following execution instruction:

```ts
"For minecraft_follow_owner, distance is the desired gap from the owner in blocks (integer 2 through 16), not a travel budget; when the owner asks WhiteLily to come beside them without specifying a gap, use distance 2. Never copy maxHorizontalTravel into distance."
```

Update the tool description to express the same rule without changing its schema or executor.

- [ ] **Step 4: Verify the focused tests pass**

Run: `npm test -- tests/unit/promptBuilder.test.ts tests/unit/minecraftDynamicTools.test.ts`

Expected: all focused tests pass with zero failures.

### Task 2: Verify, package, install, and exercise the fix

**Files:**
- Verify: `src/companion/promptBuilder.ts`
- Verify: `src/mcp/toolRegistry.ts`
- Verify: `tests/unit/promptBuilder.test.ts`
- Verify: `tests/unit/minecraftDynamicTools.test.ts`

**Interfaces:**
- Consumes: the clarified prompt and tool description from Task 1
- Produces: a packaged and locally installed WhiteLily runtime validated in the existing Minecraft world

- [ ] **Step 1: Run affected automated verification**

Run: `npm test -- tests/unit/promptBuilder.test.ts tests/unit/minecraftDynamicTools.test.ts tests/unit/toolRegistry.test.ts tests/integration/companionService.test.ts`

Run: `npm run typecheck`

Run: `npx prettier --check src/companion/promptBuilder.ts src/mcp/toolRegistry.ts tests/unit/promptBuilder.test.ts tests/unit/minecraftDynamicTools.test.ts`

Expected: all commands exit 0.

- [ ] **Step 2: Prepare and install the desktop runtime**

Run: `npm run desktop:prepare`

Install the generated `build/electron-bundle/core` using the existing recoverable Windows update flow while preserving the running Minecraft process.

Expected: installed `resources/core` matches the prepared core for the changed compiled files and runtime manifest.

- [ ] **Step 3: Run the live Minecraft regression**

From owner `new_Lemon`, send `到我身边来` and inspect the new Codex session plus Minecraft log.

Expected: `minecraft_follow_owner` receives `distance: 2`, succeeds, and WhiteLily approaches the owner without `invalid Minecraft tool arguments`.

- [ ] **Step 4: Commit the verified implementation**

```text
fix: disambiguate follow-owner distance
```

