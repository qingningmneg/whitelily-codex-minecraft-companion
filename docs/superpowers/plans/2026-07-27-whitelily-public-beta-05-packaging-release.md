# WhiteLily Public Beta 05 Packaging and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the bilingual, privacy-preserving Windows product; bundle Node and Codex into an NSIS installer; validate real Minecraft compatibility; and publish a reproducible GitHub Public Beta release.

**Architecture:** Keep all user-facing copy in complete zh-CN/en catalogs, emit local structured logs and audit records, create diagnostics from an explicit whitelist, and perform update checks through the Node Sidecar. A deterministic packaging script assembles the pinned Node runtime, Codex CLI, compiled Sidecar, production dependencies, and Tauri shell before the release workflow creates installer, hashes, SBOM, and compatibility evidence.

**Tech Stack:** TypeScript, React, Tauri 2, Rust, NSIS, PowerShell, GitHub Actions, CycloneDX SBOM, Vitest, Cargo test

## Global Constraints

- Plans 01-04 must be merged and green before this plan begins.
- Execute in a fresh worktree created with `superpowers:using-git-worktrees`.
- Release target is Windows 10/11 x64.
- The installer must run on a machine with no preinstalled Node, npm, Git, or Codex.
- Installed executable dependencies are never downloaded at application runtime.
- Updates notify only; no background download or automatic install.
- No telemetry, remote configuration, automatic crash upload, or device identifier.
- Update metadata checks occur at most once per 24 hours and can be disabled.
- Diagnostic export is local, manually initiated, previewed, and whitelist-based.
- Diagnostic packages never contain saves, authentication files, complete chat, complete memories, or unredacted usernames/paths.
- At least three real Minecraft versions must pass the release matrix, covering 1.20.x and 1.21.x.
- Experimental versions always start conservative.
- Public Beta publishes installer, SHA-256, SBOM, license notices, compatibility manifest, release notes, and signing status.
- Use test-driven development and frequent focused commits.

---

### Task 1: Externalize all user-facing copy into complete bilingual catalogs

**Files:**

- Create: `src/i18n/messageKeys.ts`
- Create: `src/i18n/zh-CN.ts`
- Create: `src/i18n/en.ts`
- Create: `src/i18n/translator.ts`
- Create: `tests/unit/i18n.test.ts`
- Create: `apps/desktop/src/i18n.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/components/StatusCard.tsx`
- Modify: `apps/desktop/src/components/ModelPicker.tsx`
- Modify: `apps/desktop/src/components/LanCandidateCard.tsx`
- Modify: `apps/desktop/src/components/SafetyBudgetEditor.tsx`
- Modify: `apps/desktop/src/components/MemoryMigrationPreview.tsx`
- Modify: `apps/desktop/src/pages/HomePage.tsx`
- Modify: `apps/desktop/src/pages/OnboardingPage.tsx`
- Modify: `apps/desktop/src/pages/PersonaPage.tsx`
- Modify: `apps/desktop/src/pages/MemoryPage.tsx`
- Modify: `apps/desktop/src/pages/WorldSafetyPage.tsx`
- Modify: `apps/desktop/src/pages/ModelPage.tsx`
- Modify: `src/companion/promptBuilder.ts`
- Modify: `src/companion/companionService.ts`

**Interfaces:**

- Produces:
  - `Locale = "zh-CN" | "en"`
  - `MessageKey`
  - `translate(locale, key, params): string`
  - React `I18nProvider` and `useI18n()`.

- [ ] **Step 1: Write failing catalog-completeness tests**

```ts
describe("locale catalogs", () => {
  it("contains exactly the same keys in Chinese and English", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(zhCN)).toEqual([...MESSAGE_KEYS]);
  });

  it("fails when a required interpolation is missing", () => {
    expect(() =>
      translate("en", "session.detected", { version: "1.21.5" } as never),
    ).toThrow("missing message parameter: port");
  });
});
```

Add a source scan that rejects visible string literals in page components except accessibility-neutral punctuation and test IDs.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm test -- tests/unit/i18n.test.ts
npm run desktop:test
```

Expected: FAIL because catalogs do not exist and pages contain inline copy.

- [ ] **Step 3: Implement typed catalogs**

Define all keys once in `MESSAGE_KEYS`. Each catalog is `satisfies Record<MessageKey, string>`. Interpolation accepts only declared parameters and HTML is never interpreted.

- [ ] **Step 4: Migrate desktop and Minecraft messages**

Move onboarding, home, settings, errors, compatibility warnings, high-risk attestation, tray labels, and diagnostic copy. Minecraft messages use the active companion profile language.

- [ ] **Step 5: Run all UI and companion tests**

```powershell
npm test -- tests/unit/i18n.test.ts tests/integration/companionService.test.ts
npm run desktop:test
npm run desktop:build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/i18n apps/desktop/src src/companion/promptBuilder.ts src/companion/companionService.ts tests/unit/i18n.test.ts tests/integration/companionService.test.ts
git commit -m "feat: add complete Chinese and English copy"
```

### Task 2: Add local audit records and whitelist-based diagnostic export

**Files:**

- Create: `src/logging/auditLogger.ts`
- Create: `src/diagnostics/diagnosticManifest.ts`
- Create: `src/diagnostics/diagnosticExporter.ts`
- Create: `tests/unit/auditLogger.test.ts`
- Create: `tests/unit/diagnosticExporter.test.ts`
- Modify: `src/logging/safeLogger.ts`
- Modify: `src/memory/redaction.ts`
- Modify: `src/runtime/runtimeFacade.ts`
- Modify: `src/safety/worldAuthorization.ts`
- Modify: `tests/unit/worldAuthorization.test.ts`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `src/desktop/sidecarServer.ts`
- Create: `apps/desktop/src/pages/DiagnosticsPage.tsx`
- Create: `apps/desktop/src/pages/DiagnosticsPage.test.tsx`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**

- Produces:

```ts
export interface AuditEvent {
  schemaVersion: 1;
  timestamp: string;
  kind:
    | "connection"
    | "task_started"
    | "task_stopped"
    | "action_allowed"
    | "action_denied"
    | "budget_exhausted"
    | "emergency_stop"
    | "settings_changed";
  worldIdHash?: string;
  taskId?: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface DiagnosticPreview {
  exportId: string;
  files: Array<{ logicalName: string; size: number; redactions: number }>;
  omitted: string[];
}
```

- [ ] **Step 1: Write failing audit and diagnostics tests**

Test:

- Audit logger appends one valid JSON object per line under a serialized queue.
- Owner username, Windows user path, IP, auth URL query, access token, email, raw chat, and memory summary are redacted.
- Preview lists only app version, OS summary, dependency versions, compatibility manifest, redacted app log, redacted audit log, and config schema summary.
- Export requires an unexpired `exportId` from preview.
- ZIP entry names are fixed logical names and contain no absolute paths.
- A symlink or unexpected file in the log directory is never included.
- No save, Codex auth, PCL2 account, complete profile, or memory file appears.
- A failed audit append makes `WorldAuthorization` reject high-risk enable and new dangerous permits until a successful health probe.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm test -- tests/unit/auditLogger.test.ts tests/unit/diagnosticExporter.test.ts
```

Expected: FAIL because audit and diagnostics modules do not exist.

- [ ] **Step 3: Implement structured audit**

Use an append-only file opened under the known log root, rotate at 10 MiB, retain five local files, and call the existing redaction layer on every string value. Hash world IDs with a per-install random salt stored in settings; never write the raw world path. Expose `AuditLogger.health(): "writable" | "failed"` and a bounded `probeHealth()` write/flush check. `WorldAuthorization` requires writable audit before enabling high risk or issuing a new dangerous permit.

- [ ] **Step 4: Implement preview and ZIP export**

Install an exact ZIP library:

```powershell
npm install --save-exact archiver
npm install --save-dev --save-exact @types/archiver
```

Generate all entries from in-memory redacted values or explicitly opened known files. Expire preview IDs after 10 minutes. Rust opens a native “Save As” dialog and passes one user-selected destination for this specific export command; Node writes through an already validated destination handle or Rust copies the completed temp ZIP.

- [ ] **Step 5: Add diagnostics UI**

Show local status, previewed file list, omitted categories, redaction counts, and a manual Export button. Do not add “Send” or upload.

- [ ] **Step 6: Run diagnostics, UI, and full redaction suites**

```powershell
npm test -- tests/unit/auditLogger.test.ts tests/unit/diagnosticExporter.test.ts tests/unit/safeLogger.test.ts tests/unit/redaction.test.ts tests/unit/worldAuthorization.test.ts
npm run desktop:test
npm run desktop:rust:test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/logging/auditLogger.ts src/logging/safeLogger.ts src/diagnostics/diagnosticManifest.ts src/diagnostics/diagnosticExporter.ts src/memory/redaction.ts src/runtime/runtimeFacade.ts src/safety/worldAuthorization.ts src/desktop/desktopProtocol.ts src/desktop/sidecarServer.ts apps/desktop/src/pages/DiagnosticsPage.tsx apps/desktop/src/pages/DiagnosticsPage.test.tsx apps/desktop/src-tauri/src/lib.rs package.json package-lock.json tests/unit/auditLogger.test.ts tests/unit/diagnosticExporter.test.ts tests/unit/worldAuthorization.test.ts
git commit -m "feat: add local audit and diagnostic export"
```

### Task 3: Add metadata-only GitHub update notifications

**Files:**

- Create: `src/update/updateChecker.ts`
- Create: `src/update/updateSchema.ts`
- Create: `tests/unit/updateChecker.test.ts`
- Modify: `src/storage/schemas.ts`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `src/desktop/sidecarServer.ts`
- Create: `apps/desktop/src/components/UpdateNotice.tsx`
- Create: `apps/desktop/src/components/UpdateNotice.test.tsx`

**Interfaces:**

- Produces:

```ts
export interface UpdateSnapshot {
  state: "disabled" | "current" | "available" | "error";
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  checkedAt?: string;
}

export class UpdateChecker {
  check(input: { force: boolean }): Promise<UpdateSnapshot>;
}
```

- [ ] **Step 1: Write failing update-policy tests**

Test:

- Disabled setting performs no fetch.
- A cached successful check younger than 24 hours performs no fetch unless `force`.
- Request URL is exactly the public latest-release endpoint for `qingningmneg/whitelily-codex-minecraft-companion`.
- Headers contain a static product/version User-Agent and optional ETag only.
- No install ID, world ID, model, PCL2 path, locale, or current-version query parameter is sent.
- Response body is capped at 256 KiB.
- Only HTTPS `github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/...` URLs are returned to the UI.
- Prerelease semantic versions are compared correctly.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm test -- tests/unit/updateChecker.test.ts
```

Expected: FAIL because update modules do not exist.

- [ ] **Step 3: Implement the checker**

Use injected `fetch`, clock, and settings store. Send `If-None-Match` when cached. Treat rate limit, offline, invalid JSON, unexpected URL, and oversized response as a local error without changing application behavior.

- [ ] **Step 4: Add UI notification only**

Show current/latest version and buttons for “Open release page” and “Dismiss”. Rust validates and opens the GitHub release URL in the system browser. Do not download an asset or invoke the installer.

- [ ] **Step 5: Run update and UI tests**

```powershell
npm test -- tests/unit/updateChecker.test.ts
npm run desktop:test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/update src/storage/schemas.ts src/desktop/desktopProtocol.ts src/desktop/sidecarServer.ts apps/desktop/src/components/UpdateNotice.tsx apps/desktop/src/components/UpdateNotice.test.tsx tests/unit/updateChecker.test.ts
git commit -m "feat: notify users about GitHub releases"
```

### Task 4: Assemble pinned Node and Codex runtime resources

**Files:**

- Create: `packaging/runtime-manifest.json`
- Create: `scripts/fetch-runtime.ps1`
- Create: `scripts/prepare-desktop-bundle.ps1`
- Create: `tests/integration/runtimeBundle.test.ts`
- Modify: `package.json`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `.gitignore`
- Modify: `NOTICE`

**Interfaces:**

- Produces staging tree:

```text
build/desktop-bundle/
  runtime/node.exe
  codex/
  sidecar/dist/
  sidecar/node_modules/
  licenses/
  runtime-manifest.json
```

- Produces scripts `runtime:fetch` and `desktop:prepare`.

- [ ] **Step 1: Write failing bundle-manifest tests**

Test:

- Manifest pins one Node 24 x64 Windows archive URL and SHA-256.
- Manifest pins the exact `@openai/codex` version from `package-lock.json`.
- Every runtime executable has a SHA-256 entry.
- Prepared bundle rejects a mismatched hash.
- Prepared bundle launches `node.exe sidecar/dist/src/desktop/sidecarMain.js` with an empty controlled environment and exits cleanly on stdin EOF.
- System `node`, `npm`, `codex`, and `PATH` are not needed by the launch test.

- [ ] **Step 2: Run focused test and confirm failure**

```powershell
npm test -- tests/integration/runtimeBundle.test.ts
```

Expected: FAIL because the runtime manifest and scripts do not exist.

- [ ] **Step 3: Create and verify the runtime manifest**

Resolve the current Node 24 LTS Windows x64 ZIP from the official Node distribution index, record its immutable versioned URL and published SHA-256 in `packaging/runtime-manifest.json`, and commit that exact data. Record the locked Codex package version and the relative executable path found inside the installed package.

`fetch-runtime.ps1` downloads only the manifest URL into `build/downloads`, verifies SHA-256 before extraction, and never executes downloaded content.

- [ ] **Step 4: Build the deterministic staging tree**

`prepare-desktop-bundle.ps1`:

1. Resolves and validates the absolute `build/desktop-bundle` target under the repository.
2. Creates a fresh staging sibling.
3. Runs root TypeScript build.
4. Runs `npm ci --omit=dev --ignore-scripts` into the staging Sidecar package.
5. Copies the verified Node runtime and locked Codex package.
6. Copies license files and manifest.
7. Renames the complete sibling into place atomically.

Do not delete or move a path before verifying it remains inside `build`.

- [ ] **Step 5: Configure Tauri resources**

List the prepared runtime, Codex, Sidecar, licenses, and manifest under `bundle.resources`. Rust resolves them through Tauri's resource directory and spawns only the exact bundled `node.exe` and Sidecar entry.

- [ ] **Step 6: Run bundle tests**

```powershell
npm run runtime:fetch
npm run desktop:prepare
npm test -- tests/integration/runtimeBundle.test.ts
```

Expected: PASS on Windows without resolving system Node for the child launch.

- [ ] **Step 7: Commit**

```powershell
git add packaging/runtime-manifest.json scripts/fetch-runtime.ps1 scripts/prepare-desktop-bundle.ps1 tests/integration/runtimeBundle.test.ts package.json apps/desktop/src-tauri/tauri.conf.json .gitignore NOTICE
git commit -m "build: bundle pinned Node and Codex runtimes"
```

### Task 5: Produce the NSIS installer and test install lifecycle

**Files:**

- Create: `packaging/nsis/installer-hooks.nsh`
- Create: `scripts/package-installer.ps1`
- Create: `scripts/test-installer.ps1`
- Create: `tests/integration/installerConfiguration.test.ts`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `package.json`
- Modify: `docs/installation-windows.zh-CN.md`
- Create: `docs/installation-windows.md`

**Interfaces:**

- Produces:
  - `release/WhiteLily-0.2.0-beta.1-windows-x64-setup.exe` for the first Public Beta
  - matching `.sha256`
  - installer lifecycle report JSON.

- [ ] **Step 1: Write failing installer configuration tests**

Assert:

- Bundle target is `nsis` and architecture x64.
- Install mode is per-user.
- Product ID and publisher are stable.
- WebView2 bootstrapper is included.
- Runtime resource paths exist before Tauri build.
- Uninstall hook offers explicit `Keep WhiteLily data` and `Delete WhiteLily data`.
- Silent uninstall defaults to keeping data.
- Installer never writes outside its program directory and `%LOCALAPPDATA%\WhiteLily`.

- [ ] **Step 2: Run focused test and confirm failure**

```powershell
npm test -- tests/integration/installerConfiguration.test.ts
```

Expected: FAIL because installer configuration is incomplete.

- [ ] **Step 3: Configure NSIS and data-choice hooks**

Use the approved product name and per-user program path. The uninstaller option must remove only the fully resolved `%LOCALAPPDATA%\WhiteLily` directory after validating its final path equals that exact target; never use a wildcard or unresolved environment variable.

- [ ] **Step 4: Implement packaging**

`package-installer.ps1` requires a semantic version argument such as `-Version 0.2.0-beta.1`, validates a clean prepared bundle, runs frontend/Rust production build, copies the NSIS result to the canonical release filename, calculates SHA-256, and writes signing status `signed` or `unsigned`.

- [ ] **Step 5: Implement isolated lifecycle smoke**

`test-installer.ps1` installs under a temporary test user/profile or Windows Sandbox, starts WhiteLily with system Node/Codex paths removed, verifies the window and bundled Sidecar, performs uninstall with keep-data, reinstalls, then performs uninstall with delete-data. It outputs machine-readable results and never targets the current user's real WhiteLily directory.

- [ ] **Step 6: Run installer checks**

```powershell
npm run desktop:prepare
npm run desktop:build
./scripts/package-installer.ps1 -Version 0.2.0-beta.1
./scripts/test-installer.ps1 -InstallerPath ./release/WhiteLily-0.2.0-beta.1-windows-x64-setup.exe
```

Expected: installer and lifecycle report pass.

- [ ] **Step 7: Commit**

```powershell
git add packaging/nsis scripts/package-installer.ps1 scripts/test-installer.ps1 tests/integration/installerConfiguration.test.ts apps/desktop/src-tauri/tauri.conf.json package.json docs/installation-windows.zh-CN.md docs/installation-windows.md
git commit -m "build: create the WhiteLily Windows installer"
```

### Task 6: Enforce the real Minecraft compatibility matrix

**Files:**

- Create: `scripts/compatibility-test.ps1`
- Create: `scripts/record-compatibility.ps1`
- Create: `tests/integration/compatibilityReleaseGate.test.ts`
- Modify: `config/minecraft-compatibility.json`
- Create: `compatibility-evidence/1.20.1-windows11.json`
- Create: `compatibility-evidence/1.21.1-windows11.json`
- Create: `compatibility-evidence/1.21.5-windows11.json`
- Create: `docs/minecraft-compatibility.md`
- Create: `docs/minecraft-compatibility.zh-CN.md`
- Modify: `docs/windows-smoke-test.md`

**Interfaces:**

- Produces one evidence file per test:

```json
{
  "schemaVersion": 1,
  "minecraftVersion": "1.21.5",
  "protocolVersion": 770,
  "testedAt": "2026-07-27T00:00:00.000Z",
  "windowsVersion": "Windows 11",
  "pclFileVersion": "2.12.8.2",
  "worldKind": "disposable",
  "checks": {
    "detect": "pass",
    "confirm": "pass",
    "chat": "pass",
    "observe": "pass",
    "move": "pass",
    "placeAndRestore": "pass",
    "reconnect": "pass",
    "emergencyStop": "pass"
  }
}
```

- [ ] **Step 1: Write failing release-gate tests**

Test:

- At least three verified rows exist.
- At least one row is 1.20.x and at least one is 1.21.x.
- Every verified row has a matching evidence file with all checks `pass`.
- Evidence world kind is `disposable`.
- Duplicate version/protocol rows fail.
- Unsupported and experimental versions never count toward the three.
- A 26.x row cannot be verified unless the bundled protocol dependency reports support and evidence passes.

- [ ] **Step 2: Run the gate and confirm failure**

```powershell
npm test -- tests/integration/compatibilityReleaseGate.test.ts
```

Expected: FAIL until three real evidence files exist.

- [ ] **Step 3: Implement the guided smoke harness**

`compatibility-test.ps1` verifies the application is a test build, displays each required action, records timestamps and app audit correlation IDs, and refuses to run if the selected world is marked non-disposable. It does not edit saves or create backups.

- [ ] **Step 4: Test the three initial release targets**

Using PCL2 and separate disposable worlds, run the complete harness for:

- Minecraft Java 1.20.1
- Minecraft Java 1.21.1
- Minecraft Java 1.21.5

If the bundled protocol dependency cannot connect to one target, record it as unsupported and replace it with another supported 1.20.x or 1.21.x version; never fabricate or manually edit a passing evidence file.

- [ ] **Step 5: Record verified results**

`record-compatibility.ps1` validates the evidence hash and app audit IDs, then updates `config/minecraft-compatibility.json`. Commit only evidence produced by the harness.

- [ ] **Step 6: Run the release gate**

```powershell
npm test -- tests/integration/compatibilityReleaseGate.test.ts
```

Expected: PASS with at least three real verified versions.

- [ ] **Step 7: Commit**

```powershell
git add scripts/compatibility-test.ps1 scripts/record-compatibility.ps1 tests/integration/compatibilityReleaseGate.test.ts config/minecraft-compatibility.json docs/minecraft-compatibility.md docs/minecraft-compatibility.zh-CN.md docs/windows-smoke-test.md compatibility-evidence
git commit -m "test: verify the Public Beta Minecraft matrix"
```

### Task 7: Build the Public Beta release pipeline and final acceptance run

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/release-check.ps1`
- Create: `scripts/generate-sbom.ps1`
- Create: `scripts/verify-release-assets.ps1`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`
- Modify: `SECURITY.md`
- Modify: `CONTRIBUTING.md`
- Modify: `tests/integration/releaseReadiness.test.ts`

**Interfaces:**

- Produces Public Beta assets:
  - installer `.exe`
  - installer `.sha256`
  - CycloneDX SBOM JSON
  - dependency license archive
  - compatibility manifest and evidence archive
  - signing status text
  - release notes.

- [ ] **Step 1: Extend release-readiness tests**

Assert:

- Both languages link installation, compatibility, privacy, diagnostics, and safety docs.
- Release workflow uploads every required asset.
- CI runs Node format/typecheck/test/build, desktop frontend tests/build, Cargo tests, Sidecar bundle test, and installer configuration test.
- Release job runs the real compatibility evidence gate before packaging.
- Release notes label the release as Beta and state LAN-only, Windows x64, no telemetry, manual updates, and unsigned status when applicable.

- [ ] **Step 2: Run focused test and confirm failure**

```powershell
npm test -- tests/integration/releaseReadiness.test.ts
```

Expected: FAIL until workflows and docs are updated.

- [ ] **Step 3: Add deterministic SBOM and asset verification**

Generate CycloneDX data for npm and Cargo lockfiles, merge them under one product component, and include bundled Node/Codex versions. `verify-release-assets.ps1` recalculates every SHA-256, validates filenames/version, opens the installer metadata, verifies required archives, and rejects an unreported signature state.

- [ ] **Step 4: Update CI**

Run:

```powershell
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
npm run desktop:test
npm run desktop:build
npm run desktop:rust:test
./scripts/release-check.ps1 -SkipInstall
```

Cache npm and Cargo separately. Do not cache prepared executable bundles without hash-keying the runtime manifest and both lockfiles.

- [ ] **Step 5: Update tag release workflow**

The release workflow prepares the runtime, verifies compatibility evidence, builds installer, optionally Authenticode-signs when the repository certificate secret is configured, emits signing status, generates SBOM/licenses, verifies assets, and creates a prerelease GitHub Release for tags matching `v*-beta.*`.

- [ ] **Step 6: Run the complete local acceptance suite**

```powershell
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
npm run desktop:test
npm run desktop:build
npm run desktop:rust:test
./scripts/release-check.ps1 -SkipInstall
npm run desktop:prepare
./scripts/package-installer.ps1 -Version 0.2.0-beta.1
./scripts/test-installer.ps1 -InstallerPath ./release/WhiteLily-0.2.0-beta.1-windows-x64-setup.exe
./scripts/generate-sbom.ps1 -Version 0.2.0-beta.1
./scripts/verify-release-assets.ps1 -Version 0.2.0-beta.1
```

Expected: every command passes.

- [ ] **Step 7: Perform Windows 10 and Windows 11 clean-VM acceptance**

On each OS:

- Install with no system Node/Codex.
- Complete ChatGPT login and model selection.
- Detect PCL2 in a non-default path.
- Open a disposable verified-version world to LAN.
- Confirm, chat, act, reconnect, and emergency-stop.
- Change persona and memory mode.
- Bind the world and perform the dedicated high-risk disposable-world test.
- Export diagnostics and inspect the preview/ZIP.
- Uninstall once preserving data and once deleting data.

Store the signed-off machine-readable reports as release evidence.

- [ ] **Step 8: Commit**

```powershell
git add .github/workflows/ci.yml .github/workflows/release.yml scripts/release-check.ps1 scripts/generate-sbom.ps1 scripts/verify-release-assets.ps1 README.md README.zh-CN.md CHANGELOG.md SECURITY.md CONTRIBUTING.md tests/integration/releaseReadiness.test.ts
git commit -m "release: prepare WhiteLily Public Beta"
```

- [ ] **Step 9: Tag and publish only after review approval**

After the release commit is reviewed and GitHub authentication is available:

```powershell
git tag -a v0.2.0-beta.1 -m "WhiteLily v0.2.0-beta.1"
git push origin HEAD
git push origin v0.2.0-beta.1
```

Expected: GitHub Actions creates a prerelease with all verified assets. Do not create or push the tag before the user approves the release candidate.
