# WhiteLily Bilingual Repository Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GitHub repository home Chinese-first while preserving a complete, equivalent English reference and accurately describing the current v0.1.1 developer preview.

**Architecture:** `README.md` is the single source of truth, with complete Chinese content first and mirrored English content second. `README.zh-CN.md` becomes a short compatibility redirect so old links remain useful. GitHub About metadata uses one concise bilingual description and developer-focused topics.

**Tech Stack:** GitHub Flavored Markdown, GitHub repository metadata, existing PowerShell release validation.

## Global Constraints

- Describe only capabilities present in `main` at v0.1.1.
- Label the project as Public Beta / 开发中 and the ZIP as a developer preview, not a one-click installer.
- State that PCL2 remains user-controlled and WhiteLily connects only to loopback Minecraft LAN in the current release.
- Keep Chinese first and English second.
- Preserve all required installation, safety, privacy, authentication, and contribution links.

---

### Task 1: Replace the default repository README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: v0.1.1 release facts, runtime architecture, Windows installation guide, and five existing Public Beta plans.
- Produces: the default GitHub repository home and stable `#中文` / `#english` anchors.

- [x] **Step 1: Write the Chinese developer overview**

Include project positioning, current status, architecture, implemented capabilities, supported environment, quick start, commands, safety boundaries, verification, roadmap, documentation, contribution, and license.

- [x] **Step 2: Mirror the same content in English**

Keep section order, facts, limitations, commands, and links equivalent to the Chinese content.

- [x] **Step 3: Check formatting**

Run: `npx prettier --check README.md`

Expected: `README.md` uses Prettier code style.

### Task 2: Preserve the legacy Chinese README path

**Files:**
- Modify: `README.zh-CN.md`

**Interfaces:**
- Consumes: the explicit `#中文` and `#english` anchors from Task 1.
- Produces: a short redirect for existing links to `README.zh-CN.md`.

- [x] **Step 1: Replace duplicate Chinese content with redirect copy**

Link readers to `README.md#中文` and retain an English navigation link.

- [x] **Step 2: Check formatting and repository-local links**

Run: `npx prettier --check README.md README.zh-CN.md`

Run: `npm test -- tests/integration/releaseReadiness.test.ts --maxWorkers=1`

Expected: formatting passes and the release-readiness documentation bundle tests pass.

### Task 3: Publish and verify the repository home

**Files:**
- Modify: GitHub repository About description and topics.

**Interfaces:**
- Consumes: merged README content.
- Produces: the public GitHub repository home, bilingual About text, and searchable topics.

- [ ] **Step 1: Run full repository verification**

Run: `npm run format:check`

Run: `npm run typecheck`

Run: `npm test -- --maxWorkers=1`

Run: `npm run build`

Expected: all commands exit successfully and all 831 tests pass.

- [ ] **Step 2: Commit, push, and merge through a pull request**

Commit message: `docs: make repository home Chinese-first`

- [ ] **Step 3: Update GitHub About metadata**

Description:

`面向 PCL2 与 Minecraft Java 版的本地 AI 伙伴，基于 Codex 与 Mineflayer。Local AI companion for PCL2 and Minecraft Java Edition, powered by Codex and Mineflayer. Public Beta.`

Topics:

`minecraft`, `minecraft-java`, `pcl2`, `codex`, `mineflayer`, `ai-companion`, `typescript`, `windows`

- [ ] **Step 4: Read the merged README and repository metadata back from GitHub**

Expected: `main` begins with Chinese content, contains the English section, and GitHub reports the new description and topics.
