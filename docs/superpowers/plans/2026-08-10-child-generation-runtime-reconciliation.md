# Child Generation Runtime Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revoke renderer-visible runtime authority when a running desktop child terminates, so a restarted idle child cannot leave Home displaying a stale connected state.

**Architecture:** Keep `ChildSupervisor` as the generation and runtime-revision authority. After it has exposed a non-terminal runtime snapshot, quarantine or unexpected termination publishes one strict `connection_invalidated` event with the next revision before scheduling the replacement child; the replacement is seeded above that revision and receives neither a replayed `start_runtime` nor connection proof. Existing IPC validation and renderer invalidation routing consume the event unchanged.

**Tech Stack:** TypeScript, Electron IPC boundary, React, Vitest.

## Global Constraints

- Do not start, stop, or otherwise touch WhiteLily, PCL2, Java, Minecraft, bots, or worlds.
- Do not send IPC, network traffic, chat, tools, or game actions during implementation or verification.
- Preserve strict desktop protocol validation and globally monotonic runtime revisions.
- Never replay `start_runtime` or confirmed-connection authority after child restart.
- Publish at most one synthetic invalidation for a terminated generation and none after an already authoritative terminal invalidation.

---

### Task 1: Reproduce stale runtime authority

**Files:**
- Modify: `apps/desktop/src-main/childSupervisor.test.ts`

**Interfaces:**
- Consumes: `ChildSupervisor.request`, `ChildSupervisor.subscribe`, crash/restart harness.
- Produces: a regression proving running generation 1 emits one terminal invalidation and generation 2 answers a fresh idle status above it.

- [x] **Step 1: Write the failing restart test**
- [x] **Step 2: Run the exact test and verify it fails because no invalidation is published**

### Task 2: Publish one authoritative generation-loss event

**Files:**
- Modify: `apps/desktop/src-main/childSupervisor.ts`
- Test: `apps/desktop/src-main/childSupervisor.test.ts`

**Interfaces:**
- Consumes: correlated runtime snapshots and the supervisor runtime revision high-water mark.
- Produces: one strict `connection_invalidated` event with `reason: "runtime_failed"`, an authority-free terminal snapshot, and the terminated child generation context.

- [x] **Step 1: Track whether a child exposed non-terminal runtime authority**
- [x] **Step 2: On quarantine or unexpected termination, reserve the next revision and publish invalidation before restart**
- [x] **Step 3: Verify restart, late old event, multiple subscriber, no-duplicate, no-replay, and fresh-status cases**

### Task 3: Verify existing IPC and renderer reconciliation

**Files:**
- Modify only if a failing behavior requires it: `apps/desktop/src-main/ipcRegistry.test.ts`
- Modify only if a failing behavior requires it: `apps/desktop/src/pages/HomePage.test.tsx`
- Modify only if a failing behavior requires it: `apps/desktop/src/App.task5.test.tsx`

**Interfaces:**
- Consumes: the strict connection invalidation already supported by preload and renderer.
- Produces: proof that IPC publishes the synthetic event and Home/App cannot remain connected after it, while stale old events/responses cannot restore authority.

- [x] **Step 1: Run the focused IPC and renderer regressions**
- [x] **Step 2: Add only missing cross-boundary coverage revealed by failures**

### Task 4: Verify, independently review, and commit

**Files:**
- Modify: only the plan, supervisor source, and regression tests required above.

**Interfaces:**
- Consumes: focused RED/GREEN evidence.
- Produces: one reviewable commit with no external-process side effects.

- [x] **Step 1: Run ChildSupervisor, IPC, App/Home, desktop full, format, type, and build gates**
- [ ] **Step 2: Request an independent read-only review and resolve all Critical/Important findings**
- [ ] **Step 3: Stage exactly this task's files and commit**
