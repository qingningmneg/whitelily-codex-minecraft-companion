# Cold Model Runtime Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the first unprewarmed desktop `start_runtime` resolve the live ChatGPT model while continuing to reject any real account-generation change.

**Architecture:** Keep `ModelCatalog` as the model authority. Make the live-model fetch return the account generation established after its initial signed-in read, then require that exact generation through preference reads and state application; this distinguishes the fetch's own cold `signed_out` to `signed_in` discovery from a later authority change.

**Tech Stack:** TypeScript 7, Vitest 4, `AccountService`, `ModelCatalog`.

## Global Constraints

- Do not touch PCL2, Java, Minecraft, or any Minecraft world.
- Do not send chat, tools, or game actions.
- Preserve ChatGPT-account and model-generation fail-closed behavior.
- Implement no production change unless the cold-start regression test fails for the expected generation mismatch.
- Keep the historical Mineflayer protocol fix separate.

---

### Task 1: Reproduce the cold account-generation transition

**Files:**
- Modify: `tests/unit/modelCatalog.test.ts`

**Interfaces:**
- Consumes: `AccountService.getAccount()`, `ModelCatalog.resolveRuntimeSelection()`.
- Produces: a regression proving the first model resolution works without `get_account` or `list_models` prewarming.

- [x] **Step 1: Write the failing service-level test**

Create a real `AccountService` whose port begins unread, returns one ChatGPT account, and pair it with a real `ModelCatalog` whose service returns one default live model. Call only `resolveRuntimeSelection()` and expect that model and its service-provided reasoning effort.

- [x] **Step 2: Run the exact test to verify RED**

Run: `npx vitest run tests/unit/modelCatalog.test.ts -t "resolves the first runtime model without account or catalog prewarming" --maxWorkers=1`

Expected: FAIL with `ChatGPT authentication is required`, after the real `AccountService` publishes its first signed-in snapshot and increments the catalog generation.

### Task 2: Carry the established generation with fetched models

**Files:**
- Modify: `src/codex/modelCatalog.ts`
- Test: `tests/unit/modelCatalog.test.ts`

**Interfaces:**
- Consumes: the generation captured by `#fetchModels()` immediately after its initial signed-in assertion.
- Produces: normalized models plus the exact account generation that authorized them.

- [x] **Step 1: Implement the minimal authority-token change**

Return `{ normalized, accountGeneration }` from `#fetchModels()`. Use `accountGeneration` in `#refresh`, `#prepare`, and `migrateLegacyPreference` for all later `#assertCurrentAccount` and durable-update checks. Do not cache failed responses and do not retry authentication or model failures.

- [x] **Step 2: Run the exact test to verify GREEN**

Run: `npx vitest run tests/unit/modelCatalog.test.ts -t "resolves the first runtime model without account or catalog prewarming" --maxWorkers=1`

Expected: PASS.

- [x] **Step 3: Verify generation fail-closed regression**

Run: `npx vitest run tests/unit/modelCatalog.test.ts -t "fails a catalog race closed when the account logs out" --maxWorkers=1`

Expected: PASS.

### Task 3: Verify and commit the isolated fix

**Files:**
- Modify: `src/codex/modelCatalog.ts`
- Modify: `tests/unit/modelCatalog.test.ts`
- Modify: `docs/superpowers/plans/2026-08-10-cold-model-runtime-selection.md`

**Interfaces:**
- Consumes: the focused RED/GREEN evidence.
- Produces: one reviewable commit limited to the plan, regression, and model-authority fix.

- [x] **Step 1: Run relevant tests and gates**

Run the full model-catalog, account, child-server, runtime-facade, and desktop-supervisor tests; then run root and desktop typechecks, builds, formatting checks, and `git diff --check`.

- [x] **Step 2: Audit the staged scope**

Stage only the three files listed above and verify `git diff --cached --name-only` exactly matches them. Leave all concurrent Onboarding and WorldBinding work untouched.

- [x] **Step 3: Commit**

```bash
git commit -m "fix: resolve cold model authority"
```
