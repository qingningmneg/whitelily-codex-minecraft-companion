# Minecraft Version Probe Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify Minecraft Java 1.21.5 when PCL2 uses a custom instance identifier, without trusting display names or command-line substrings.

**Architecture:** The fixed Windows probe will split the Java command line with Windows argv semantics, bind the exact `--version` instance identifier to the matching version JAR entry in the exact classpath argument, and read the adjacent bounded, ordinary JSON metadata file through a stable handle. It publishes `1.21.5` only when the metadata `id` matches the instance identifier and a custom instance's `clientVersion` is exactly `1.21.5`; standard `id: "1.21.5"` metadata may omit `clientVersion`, but a present value must still match. Malformed, conflicting, linked, oversized, ambiguous, or duplicate evidence remains `null`.

**Tech Stack:** TypeScript, Vitest, Windows PowerShell 5.1, Win32 `CommandLineToArgvW`.

## Global Constraints

- Preserve fail-closed behavior: only exact Minecraft Java `1.21.5` is supported.
- Never publish command lines, filesystem paths, instance identifiers, usernames, or tokens.
- Do not inspect or modify a running PCL2/Minecraft process, any world save, installer, or ignored acceptance evidence.
- Parse argv using Windows command-line semantics; do not infer the version from an arbitrary substring or window title.

---

### Task 1: Custom-instance metadata evidence

**Files:**
- Modify: `apps/desktop/src-main/discovery/fixedWindowsProbe.ts`
- Test: `apps/desktop/src-main/discovery/lanDetector.test.ts`

**Interfaces:**
- Consumes: `Win32_Process.CommandLine` and the process's exact Java classpath/version arguments.
- Produces: the existing `JavaListenerProbeRecord.version` value, either `"1.21.5"` or `null`.

- [x] **Step 1: Write the failing tests**

  Execute the real fixed PowerShell probe against controlled process/listener fixtures. Cover a custom instance identifier whose adjacent JSON says `clientVersion: "1.21.5"`, plus missing metadata, wrong client version, metadata ID mismatch, substring lookalikes, conflicting or duplicate arguments, quoted paths, traversal, reparse points, and oversized JSON.

- [x] **Step 2: Run tests to verify RED**

  Run `npm test --workspace @whitelily/desktop -- --run src-main/discovery/lanDetector.test.ts --no-file-parallelism` and confirm the custom-instance case reports `null` before production changes.

- [x] **Step 3: Write the minimal implementation**

  Add fixed `CommandLineToArgvW` interop and local PowerShell helpers that accept exactly one `--version` token and one exact classpath option, locate exactly one absolute `versions/<id>/<id>.jar` entry, reject unsafe identifiers or reparse chains, and parse a bounded adjacent JSON file. Require exact matching `id` and `clientVersion` fields before publishing `1.21.5`.

- [x] **Step 4: Run tests to verify GREEN**

  Re-run the focused probe tests, then the desktop suite. Run root tests, `npm run format:check`, `npm run typecheck`, and `npm run desktop:build`.

- [x] **Step 5: Review and prepare the commit**

  Inspect the final diff for secret/path disclosure and fail-open branches, obtain an independent review, then commit only the plan, production probe, and focused tests.
