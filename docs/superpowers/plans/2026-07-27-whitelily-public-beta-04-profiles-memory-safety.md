# WhiteLily Public Beta 04 Profiles, Memory, and Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add editable companion profiles, three behavior modes, scoped memory with atomic migration and rollback, stable local-world authorization, and user-configurable safety presets including explicitly enabled per-world high-risk behavior.

**Architecture:** Keep data in versioned JSON documents under one local application data root. Node owns schema, atomic writes, migrations, profiles, memory, policy, and audit decisions; Rust obtains canonical Windows directory identity without reading world contents. Safety authorization remains outside prompts and is checked at every tool boundary.

**Tech Stack:** TypeScript, Zod, Node.js atomic filesystem APIs, Tauri 2, Rust Windows file APIs, React, Vitest, Cargo test

## Global Constraints

- Plans 01-03 must be merged and green before this plan begins.
- Execute in a fresh worktree created with `superpowers:using-git-worktrees`.
- WhiteLily is the product name; the in-game companion name is user-editable.
- Persona text can affect expression and preference only; it cannot alter authorization, safety, budgets, world binding, or stop behavior.
- Behavior modes are `companion`, `balanced`, and `active`; `balanced` is the default.
- Safety presets are `conservative`, `standard`, and `high_risk`; `standard` is the default for verified versions and `conservative` is forced for unverified versions.
- Memory scopes are `global`, `world`, and `layered`; `layered` is the default.
- High-risk authorization persists only for one unambiguously bound local world.
- WhiteLily asks the user to attest to a backup but never creates, reads, validates, restores, or manages backups.
- High-risk authorization cannot be enabled by Minecraft chat, persona text, or the model.
- Task hard limits from Plan 01 remain immutable.
- No raw chat transcript or hidden model reasoning is stored as memory.
- Migrations are atomic and rollback-capable.
- Use test-driven development and frequent commits.

---

### Task 1: Add a versioned atomic local document store

**Files:**

- Create: `src/storage/atomicJsonFile.ts`
- Create: `src/storage/documentStore.ts`
- Create: `src/storage/storagePaths.ts`
- Create: `src/storage/schemas.ts`
- Create: `tests/unit/atomicJsonFile.test.ts`
- Create: `tests/unit/documentStore.test.ts`
- Modify: `src/app.ts`
- Modify: `tests/integration/app.test.ts`

**Interfaces:**

- Produces:

```ts
export interface VersionedDocument<T> {
  schemaVersion: number;
  updatedAt: string;
  data: T;
}

export interface DocumentDefinition<T> {
  name: string;
  currentVersion: number;
  schema: z.ZodType<T>;
  initial: () => T;
  migrate: (document: unknown) => VersionedDocument<T>;
}

export class DocumentStore<T> {
  read(): Promise<VersionedDocument<T>>;
  update(change: (current: Readonly<T>) => T): Promise<VersionedDocument<T>>;
  replace(data: T): Promise<VersionedDocument<T>>;
}
```

- [ ] **Step 1: Write failing atomicity and corruption tests**

Test:

- Missing file returns a fresh initial document without writing until the first update.
- Concurrent updates serialize by canonical path.
- A temp-file write followed by rename produces valid JSON.
- An injected rename failure removes only the temp file.
- Invalid `settings.json` is preserved with an ISO-derived name such as `settings.corrupt-20260727T142530000Z.json`.
- The original invalid file is never overwritten until recovery succeeds.
- Paths resolve under the injected application data root and reject `..`.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm test -- tests/unit/atomicJsonFile.test.ts tests/unit/documentStore.test.ts
```

Expected: FAIL because storage modules do not exist.

- [ ] **Step 3: Implement atomic file primitives**

Use `mkdir`, `open` with exclusive temp names, `writeFile`, `sync`, `rename`, and best-effort temp cleanup. Serialize operations with a per-canonical-path promise queue. Never follow a caller-provided path outside the configured data root.

- [ ] **Step 4: Implement versioned documents**

Validate after every migration and before every write. Deep-clone returned data with `structuredClone`. Timestamps use injected `now()` and ISO-8601 UTC. Unknown schema versions fail with `document schema is newer than this application`.

- [ ] **Step 5: Adopt the configured application data root**

Extend `AppPaths` to accept one `dataRoot` supplied by desktop/CLI composition and derive config, memory, snapshots, logs, and diagnostics under it. Keep current CLI paths mapped to the same interfaces for backward compatibility.

- [ ] **Step 6: Run storage and app tests**

```powershell
npm test -- tests/unit/atomicJsonFile.test.ts tests/unit/documentStore.test.ts tests/integration/app.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/storage src/app.ts tests/unit/atomicJsonFile.test.ts tests/unit/documentStore.test.ts tests/integration/app.test.ts
git commit -m "feat: add versioned atomic local storage"
```

### Task 2: Implement companion profiles and editable behavior modes

**Files:**

- Create: `src/profile/profileSchema.ts`
- Create: `src/profile/profileStore.ts`
- Create: `src/profile/behaviorPolicy.ts`
- Create: `tests/unit/profileStore.test.ts`
- Create: `tests/unit/behaviorPolicy.test.ts`
- Modify: `src/mode/modeManager.ts`
- Modify: `src/companion/promptBuilder.ts`
- Modify: `tests/unit/modeManager.test.ts`
- Modify: `tests/unit/promptBuilder.test.ts`

**Interfaces:**

- Produces:

```ts
export type BehaviorMode = "companion" | "balanced" | "active";

export interface CompanionProfile {
  id: string;
  displayName: string;
  ownerFormOfAddress: string;
  language: "zh-CN" | "en";
  tone: string;
  proactiveTopics: string[];
  avoidedTopics: string[];
  personaPrompt: string;
  behaviorMode: BehaviorMode;
  behaviorSettings: Record<BehaviorMode, BehaviorSettings>;
  modelSelection: ModelSelection;
}

export interface BehaviorSettings {
  proactiveChat: boolean;
  proactiveSuggestions: boolean;
  lowRiskMicroActions: boolean;
  minimumIdleMinutes: number;
}
```

- [ ] **Step 1: Write failing profile validation tests**

Test:

- Default profile uses display name `WhiteLily`, language `zh-CN`, mode `balanced`, and automatic model.
- Display name is 1-16 printable Minecraft-safe characters.
- Persona prompt is at most 4,000 Unicode code points.
- Topic arrays contain at most 32 entries, each at most 80 code points.
- `minimumIdleMinutes` is an integer from 1 to 120.
- Changing mode does not change safety preset or budgets.
- Updating one profile never mutates another returned object.

- [ ] **Step 2: Run focused tests and confirm failure**

```powershell
npm test -- tests/unit/profileStore.test.ts tests/unit/behaviorPolicy.test.ts
```

Expected: FAIL because profile modules do not exist.

- [ ] **Step 3: Implement profile schema and store**

Use UUID profile IDs, strict schemas, one active profile ID, and atomic updates through `DocumentStore`. Reject duplicate display names case-insensitively.

- [ ] **Step 4: Implement behavior policy**

Rules:

- `companion`: no unsolicited game action.
- `balanced`: proactive chat and suggestions; no unsolicited block/entity mutation.
- `active`: may start low-risk micro-actions only when no task is active, owner is online, compatibility is verified, and safety preset allows the action.
- All modes forbid unsolicited high-risk actions and large projects.

- [ ] **Step 5: Update prompt construction**

Add a `profile` object to `CompanionTurnInput`. Place immutable safety instructions before a clearly delimited `UNTRUSTED_PERSONA` JSON value. Do not concatenate persona text as system-like instructions.

```ts
const personaEnvelope = stableJson({
  displayName: profile.displayName,
  language: profile.language,
  tone: profile.tone,
  personaPrompt: profile.personaPrompt,
});
```

- [ ] **Step 6: Run profile, mode, prompt, and companion tests**

```powershell
npm test -- tests/unit/profileStore.test.ts tests/unit/behaviorPolicy.test.ts tests/unit/modeManager.test.ts tests/unit/promptBuilder.test.ts tests/integration/companionService.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/profile src/mode/modeManager.ts src/companion/promptBuilder.ts tests/unit/profileStore.test.ts tests/unit/behaviorPolicy.test.ts tests/unit/modeManager.test.ts tests/unit/promptBuilder.test.ts tests/integration/companionService.test.ts
git commit -m "feat: add editable companion profiles"
```

### Task 3: Add scoped memory, editing, and rollback migration

**Files:**

- Create: `src/memory/scopedMemoryStore.ts`
- Create: `src/memory/memoryMigration.ts`
- Create: `src/memory/memoryDeduplication.ts`
- Create: `tests/unit/scopedMemoryStore.test.ts`
- Create: `tests/unit/memoryMigration.test.ts`
- Modify: `src/memory/memoryStore.ts`
- Modify: `tests/unit/memoryStore.test.ts`
- Modify: `src/companion/companionService.ts`

**Interfaces:**

- Produces:

```ts
export type MemoryScopeMode = "global" | "world" | "layered";

export interface ScopedMemoryRecord extends MemoryRecord {
  scope: "global" | "world";
  worldId: string | null;
  pinned: boolean;
  updatedAt: string;
}

export interface MemoryMigrationPreview {
  migrationId: string;
  from: MemoryScopeMode;
  to: MemoryScopeMode;
  creates: number;
  updates: number;
  merges: Array<{ keptId: number; removedIds: number[] }>;
  snapshotPath: string;
}
```

- `ScopedMemoryStore.add`, `update`, `forget`, `pin`, `search`, `listForContext`, and `export`.
- `MemoryMigration.preview(target, worldId)` and `commit(migrationId)`.

- [ ] **Step 1: Write failing scope and editing tests**

Test:

- Global mode returns only global memories.
- World mode returns only the current world.
- Layered mode returns pinned global entries first, then world entries, with duplicate summaries merged.
- Manual add/edit/delete/pin validates sensitive data exactly like automatic memory.
- Automatic memory cannot set `pinned`.
- A missing world ID fails for world/layered writes.

- [ ] **Step 2: Write failing migration tests**

Test:

- Preview writes an immutable snapshot before proposing changes.
- Preview does not mutate live memory.
- Commit requires the exact migration ID and unchanged source document revision.
- Injected write failure restores the snapshot.
- A successful commit leaves the snapshot available for manual rollback.
- Legacy `memory.json` records migrate to global scope once with IDs preserved.

- [ ] **Step 3: Run focused tests and confirm failure**

```powershell
npm test -- tests/unit/scopedMemoryStore.test.ts tests/unit/memoryMigration.test.ts
```

Expected: FAIL because scoped memory modules do not exist.

- [ ] **Step 4: Implement deterministic deduplication**

Normalize NFKC, lowercase, and alphanumeric characters. Treat exact normalized summaries as duplicates; for summaries of at least 16 characters, use the existing trigram-overlap threshold of 0.85. Keep pinned over unpinned, then higher importance, then older creation time, then lower stable ID.

- [ ] **Step 5: Implement preview, atomic commit, and rollback**

Snapshot the complete memory document and next-ID state under `data/migration-snapshots/${migrationId}/`. Write a manifest containing SHA-256 hashes. On commit, verify hashes and source revision, write one new document atomically, and never delete the snapshot automatically during Public Beta.

- [ ] **Step 6: Integrate context selection**

`CompanionService` asks `listForContext({ mode, worldId, limit: 8 })`. Manual edits become visible on the next turn. A mode change invalidates the active turn but does not disconnect Minecraft.

- [ ] **Step 7: Run all memory and companion tests**

```powershell
npm test -- tests/unit/memoryStore.test.ts tests/unit/scopedMemoryStore.test.ts tests/unit/memoryMigration.test.ts tests/integration/companionService.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/memory src/companion/companionService.ts tests/unit/memoryStore.test.ts tests/unit/scopedMemoryStore.test.ts tests/unit/memoryMigration.test.ts tests/integration/companionService.test.ts
git commit -m "feat: add scoped editable companion memory"
```

### Task 4: Bind persistent authorization to one Windows save directory identity

**Files:**

- Create: `apps/desktop/src-tauri/src/world_identity.rs`
- Create: `apps/desktop/src-tauri/tests/world_identity.rs`
- Create: `src/world/worldIdentity.ts`
- Create: `src/world/worldProfileStore.ts`
- Create: `src/safety/safetyProfile.ts`
- Create: `tests/unit/worldProfileStore.test.ts`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `apps/desktop/src-tauri/src/protocol.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**

- Produces:

```ts
export interface WorldIdentity {
  canonicalSavePath: string;
  canonicalInstancePath: string;
  volumeSerialNumber: string;
  directoryFileId: string;
}

export type SafetyPreset = "conservative" | "standard" | "high_risk";

export interface WorldProfile {
  id: string;
  label: string;
  identity: WorldIdentity;
  ownerUsername: string;
  safetyPreset: SafetyPreset;
  backupAttestedAt: string | null;
  highRiskEnabled: boolean;
}
```

- Rust command `select_and_identify_save_directory(sessionId)`. Rust requires the current confirmed LAN session, resolves its internally retained Java PID/listener mapping, derives the Minecraft `--gameDir` when available, and opens the native directory picker at that instance's `saves` directory. The WebView cannot supply an arbitrary path.

- [ ] **Step 1: Write failing Rust identity tests**

Using a temporary directory:

- The same directory returns the same volume serial and file ID.
- A copied directory returns a different identity.
- A symlink/junction is canonicalized before identity.
- A nonexistent path and a regular file are rejected.
- No file inside the selected directory is opened.

- [ ] **Step 2: Write failing Node world-profile tests**

Test:

- All four identity fields must match.
- Path comparison is Windows case-insensitive after canonicalization.
- A changed instance path fails binding.
- No stable file ID means high-risk is unavailable.
- Owner username matches Minecraft Java rules and is exact-case for command authority.

- [ ] **Step 3: Run focused tests and confirm failure**

```powershell
npm run desktop:rust:test
npm test -- tests/unit/worldProfileStore.test.ts
```

Expected: FAIL because world identity modules do not exist.

- [ ] **Step 4: Implement Windows directory identity**

Open only the directory handle with `FILE_READ_ATTRIBUTES | FILE_FLAG_BACKUP_SEMANTICS`, call the Windows file-information API, return canonical path, volume serial, and 128-bit file ID as uppercase fixed-width hex, then close the handle. Do not enumerate files or read `level.dat`.

- [ ] **Step 5: Implement world profile persistence**

Use `DocumentStore`. Generate a UUID on first binding, require desktop-originated identity input, and expose `matchIdentity(candidate): WorldProfile | null`. Never accept a world ID from Minecraft chat or model output as authorization.

- [ ] **Step 6: Run tests and commit**

```powershell
npm run desktop:rust:test
npm test -- tests/unit/worldProfileStore.test.ts tests/unit/desktopProtocol.test.ts
git add apps/desktop/src-tauri/src/world_identity.rs apps/desktop/src-tauri/tests/world_identity.rs apps/desktop/src-tauri/src/protocol.rs apps/desktop/src-tauri/src/lib.rs src/world/worldIdentity.ts src/world/worldProfileStore.ts src/safety/safetyProfile.ts src/desktop/desktopProtocol.ts tests/unit/worldProfileStore.test.ts tests/unit/desktopProtocol.test.ts
git commit -m "feat: bind authorization to a local world"
```

### Task 5: Implement safety presets and explicit high-risk authorization

**Files:**

- Modify: `src/safety/safetyProfile.ts`
- Create: `src/safety/worldAuthorization.ts`
- Create: `src/safety/dangerousPermit.ts`
- Create: `tests/unit/safetyProfile.test.ts`
- Create: `tests/unit/worldAuthorization.test.ts`
- Modify: `src/safety/safetyEngine.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/mcp/toolRegistry.ts`
- Modify: `src/minecraft/minecraftPort.ts`
- Modify: `src/minecraft/mineflayerAdapter.ts`
- Modify: `src/minecraft/fakeMinecraftPort.ts`
- Modify: `src/actions/actionExecutor.ts`
- Modify: `tests/unit/safetyEngine.test.ts`
- Modify: `tests/unit/toolRegistry.test.ts`
- Modify: `tests/unit/actionExecutor.test.ts`
- Modify: `tests/integration/mineflayerAdapter.test.ts`
- Modify: `tests/integration/companionService.test.ts`
- Modify: `tests/e2e/companion.e2e.test.ts`
- Modify: `tests/types/gameAction.type-test.ts`

**Interfaces:**

- Consumes: `SafetyPreset` and `WorldIdentity` from Task 4, plus `TaskLimits` from Plan 01.
- Produces:

```ts
export interface SafetyProfile {
  preset: SafetyPreset;
  limits: TaskLimits;
  blockConfirmationThreshold: number;
  travelConfirmationDistance: number;
}

export interface WorldAuthorizationSnapshot {
  worldId: string;
  preset: SafetyPreset;
  highRiskAuthorized: boolean;
  backupAttestedAt: string | null;
}
```

- Adds `GameAction` variant `{ kind: "attack_entity"; entityId: number }`.
- `DangerousPermit` is constructed only by `WorldAuthorization`.

- [ ] **Step 1: Write failing preset validation tests**

Test:

- Requested budgets clamp to Plan 01 hard limits.
- Experimental compatibility can select only conservative.
- Standard preserves current confirmation behavior.
- High-risk cannot enable without matching world identity and non-null backup attestation.
- Enabling via owner chat, model text, or persona input has no API path and fails schema validation.
- Disabling high-risk is always allowed.

- [ ] **Step 2: Write failing dangerous action tests**

Test:

- TNT/lava/fire, spawn-radius mutation, and attacks on player/villager/pet deny without a valid permit.
- Exact bound-world high-risk authorization allows them without per-action confirmation.
- The ninth dangerous operation fails at the immutable budget.
- A copied/moved world identity invalidates the permit.
- `!stop`, disconnect, model loss, and emergency stop invalidate the permit's task lease.
- Trusted snapshot entity type, not the model's label, determines attack risk.

- [ ] **Step 3: Run focused tests and confirm failure**

```powershell
npm test -- tests/unit/safetyProfile.test.ts tests/unit/worldAuthorization.test.ts tests/unit/safetyEngine.test.ts tests/unit/toolRegistry.test.ts
```

Expected: FAIL because safety profile and authorization modules do not exist.

- [ ] **Step 4: Implement preset validation and world authorization**

High-risk enable input must be:

```ts
{
  worldIdentity: WorldIdentity;
  backupAttestation: {
    accepted: true;
    textVersion: 1;
  };
}
```

The service resolves the stored world profile, records `acceptedAt` from its injected trusted clock, and returns a branded `DangerousPermit` tied to `worldId` and task lease. It does not accept a client timestamp and does not inspect a backup path.

- [ ] **Step 5: Add trusted generic entity attacks**

Expose `minecraft_attack_entity` with only `{ entityId, taskLease }`. Resolve the entity from the latest trusted snapshot, classify its actual kind, apply authorization/budget, then dispatch. Keep `minecraft_attack_hostile` as a compatibility alias until all prompts/tests migrate.

- [ ] **Step 6: Gate Mineflayer defense-in-depth with the permit**

Dangerous item placement and protected entity attack require the branded permit passed through `ActionExecutor`; calls without it reject even if another caller bypasses `SafetyEngine`.

- [ ] **Step 7: Run complete safety and game suites**

```powershell
npm test -- tests/unit/safetyProfile.test.ts tests/unit/worldAuthorization.test.ts tests/unit/safetyEngine.test.ts tests/unit/toolRegistry.test.ts tests/unit/actionExecutor.test.ts tests/integration/mineflayerAdapter.test.ts tests/integration/companionService.test.ts tests/e2e/companion.e2e.test.ts tests/types/gameAction.type-test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/safety/safetyProfile.ts src/safety/worldAuthorization.ts src/safety/dangerousPermit.ts src/safety/safetyEngine.ts src/domain/types.ts src/mcp/toolRegistry.ts src/minecraft/minecraftPort.ts src/minecraft/mineflayerAdapter.ts src/minecraft/fakeMinecraftPort.ts src/actions/actionExecutor.ts tests/unit/safetyProfile.test.ts tests/unit/worldAuthorization.test.ts tests/unit/safetyEngine.test.ts tests/unit/toolRegistry.test.ts tests/unit/actionExecutor.test.ts tests/integration/mineflayerAdapter.test.ts tests/integration/companionService.test.ts tests/e2e/companion.e2e.test.ts tests/types/gameAction.type-test.ts
git commit -m "feat: add per-world high-risk authorization"
```

Before committing, inspect `git diff --cached --name-only` and ensure the staged list exactly matches the paths in the command.

### Task 6: Build persona, memory, world, model, and safety settings pages

**Files:**

- Create: `apps/desktop/src/pages/PersonaPage.tsx`
- Create: `apps/desktop/src/pages/MemoryPage.tsx`
- Create: `apps/desktop/src/pages/WorldSafetyPage.tsx`
- Create: `apps/desktop/src/pages/ModelPage.tsx`
- Create: matching `*.test.tsx` files
- Create: `apps/desktop/src/components/SafetyBudgetEditor.tsx`
- Create: `apps/desktop/src/components/MemoryMigrationPreview.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/runtimeClient.ts`
- Modify: `apps/desktop/src/styles.css`
- Modify: `src/desktop/desktopProtocol.ts`
- Modify: `src/desktop/sidecarServer.ts`
- Modify: `apps/desktop/src-tauri/src/protocol.rs`

**Interfaces:**

- Adds protocol v2 CRUD commands for profile, memory, world profile, model selection, and safety profile.
- All writes require an optimistic document revision.

- [ ] **Step 1: Write failing UI tests**

Test:

- Persona page exposes guided fields plus a collapsed advanced prompt.
- All three behavior modes are editable and switchable at any time.
- Model page shows live account models and supported reasoning efforts.
- Memory page supports add/edit/delete/pin/search/export.
- Changing memory scope displays migration preview counts before commit.
- High-risk enable is unavailable without a bound world.
- Enabling high-risk requires the exact backup-attestation checkbox text and a desktop save-directory selection.
- Hard-limit input values cannot exceed constants and display the cap.
- High-risk mode never appears in tray quick actions.

- [ ] **Step 2: Run desktop tests and confirm failure**

```powershell
npm run desktop:test
```

Expected: FAIL because settings pages do not exist.

- [ ] **Step 3: Add strict protocol commands**

Use distinct commands, not a generic settings patch:

- `read_profile`, `update_profile`
- `list_memories`, `add_memory`, `update_memory`, `delete_memory`, `pin_memory`
- `preview_memory_scope_change`, `commit_memory_scope_change`, `rollback_memory_migration`
- `read_world_profile`, `bind_world`, `update_safety_profile`, `disable_high_risk`
- `read_model_selection`, `update_model_selection`

Every update includes `{ revision, value }`; stale revisions return `DOCUMENT_CONFLICT`.

- [ ] **Step 4: Implement pages and conflict handling**

Keep unsaved edits locally. On `DOCUMENT_CONFLICT`, reload server state, show which fields changed, and require the user to reapply edits. Never silently overwrite.

- [ ] **Step 5: Run frontend and backend integration tests**

```powershell
npm run desktop:test
npm run desktop:build
npm test -- tests/integration/sidecarServer.test.ts tests/integration/companionService.test.ts
npm run desktop:rust:test
```

Expected: PASS.

- [ ] **Step 6: Run full verification and commit**

```powershell
npm run format:check
npm run typecheck
npm test
npm run build
npm run desktop:test
npm run desktop:build
npm run desktop:rust:test
git add apps/desktop/src src/desktop/desktopProtocol.ts src/desktop/sidecarServer.ts apps/desktop/src-tauri/src/protocol.rs tests/integration/sidecarServer.test.ts
git commit -m "feat: add companion profile and safety settings"
```
