# WorldBindingAuthority CJK PowerShell Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a real CJK `--gameDir` exactly across the Windows PowerShell 5.1 process boundary and fail closed on non-UTF-8 output.

**Architecture:** Keep the existing Java PID/session revalidation and filesystem canonicalization unchanged. Make the fixed PowerShell command emit UTF-8 explicitly, collect stdout as bytes, decode with a fatal UTF-8 decoder, and parse the same bounded snapshot schema.

**Tech Stack:** TypeScript, Node.js child processes/filesystem, Windows PowerShell 5.1, Vitest.

## Global Constraints

- Do not touch PCL2, Java, Minecraft, any world, installed packages, or ignored acceptance evidence.
- Preserve Java process identity revalidation, `realpath`, directory validation, and fail-closed behavior.
- Modify and commit only the exact WorldBindingAuthority production/test files and this plan.
- Do not include concurrent Onboarding changes.

---

### Task 1: Reproduce the CJK boundary failure

**Files:**
- Modify: `apps/desktop/src-main/discovery/worldBindingAuthority.test.ts`
- Modify: `apps/desktop/src-main/discovery/worldBindingAuthority.ts`

**Interfaces:**
- Consumes: `readJavaProcessSnapshot(pid)` and `resolveJavaGameDirectory(snapshot)` from the production module.
- Produces: a Windows-only regression test that launches a disposable Node process with a real CJK `--gameDir`, reads it through production PowerShell, and canonicalizes the path.

- [ ] **Step 1: Export the two existing internal functions without changing behavior**

Export `readJavaProcessSnapshot` and `resolveJavaGameDirectory` so the regression test exercises the actual production boundary and canonicalization.

- [ ] **Step 2: Write the failing integration test**

Create a temporary directory whose name contains `白百合`, launch a disposable Node process with `--gameDir <that directory>`, call `readJavaProcessSnapshot(child.pid)`, and assert `resolveJavaGameDirectory(snapshot)` equals the independently obtained `realpath` value.

- [ ] **Step 3: Run the focused test and verify RED**

Run: `npm test -- apps/desktop/src-main/discovery/worldBindingAuthority.test.ts`

Expected: on Windows PowerShell 5.1, the CJK path is decoded with replacement characters and `realpath` rejects with `ENOENT`.

### Task 2: Emit and decode UTF-8 safely

**Files:**
- Modify: `apps/desktop/src-main/discovery/worldBindingAuthority.ts`
- Modify: `apps/desktop/src-main/discovery/worldBindingAuthority.test.ts`

**Interfaces:**
- Consumes: raw PowerShell stdout bytes.
- Produces: `parseJavaProcessSnapshotOutput(output)` using fatal UTF-8 decoding and the existing snapshot schema.

- [ ] **Step 1: Add the invalid-byte RED test**

Pass an invalid UTF-8 byte sequence to `parseJavaProcessSnapshotOutput` and assert it throws the stable bounded encoding error.

- [ ] **Step 2: Verify the new test is RED**

Run the focused Vitest file and confirm the parser is absent or does not yet reject invalid bytes.

- [ ] **Step 3: Implement the minimum fix**

Prepend the fixed PowerShell script with a no-BOM UTF-8 `Console.OutputEncoding`/`$OutputEncoding` setup, request `Buffer` output from `execFile`, decode with `TextDecoder("utf-8", { fatal: true })`, then apply the existing structural validation.

- [ ] **Step 4: Verify GREEN**

Run the focused test and confirm both the real CJK path and invalid-byte cases pass.

### Task 3: Verify, review, and commit

**Files:**
- Verify only the three files listed in this plan.

**Interfaces:**
- Consumes: repository test/build scripts.
- Produces: a reviewed commit containing no concurrent changes.

- [ ] **Step 1: Run focused and related desktop tests**

Run the WorldBindingAuthority test, the private-world IPC test, and desktop tests.

- [ ] **Step 2: Run full quality gates**

Run root tests, typecheck, format check, root build, and desktop build.

- [ ] **Step 3: Request independent review**

Provide the exact diff and requirements to a reviewer; address all Critical/Important findings.

- [ ] **Step 4: Stage and commit exact files**

Stage only `worldBindingAuthority.ts`, `worldBindingAuthority.test.ts`, and this plan; verify staged diff excludes the concurrent Onboarding files; commit with a focused fix message.
