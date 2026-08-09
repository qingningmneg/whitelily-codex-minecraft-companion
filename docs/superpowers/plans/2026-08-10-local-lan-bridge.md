# WhiteLily Local LAN Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Fabric 1.21.5 bridge that authorizes only one explicitly confirmed local WhiteLily connection, install it safely into a verified PCL2 instance, optionally install the existing WhiteLily Avatar pack, and pass the complete desktop/installer/real-game release gates.

**Architecture:** The desktop core issues a fresh 256-bit file-backed proof for every Mineflayer attempt and sends it through `fakeHost`. A client-only Fabric module validates and atomically consumes that proof, then bypasses online authentication only for the matching loopback `WhiteLily` listener in the current integrated server. Electron main owns all instance discovery and component file writes; renderer sees only opaque candidate IDs and bounded status enums.

**Tech Stack:** TypeScript 7, Node.js 24, Electron 43, React 19, Mineflayer 4.37.1, Fabric Loader 0.16.14, Fabric Loom 1.10.5, Minecraft Java 1.21.5 official Mojang mappings, Java 21, JUnit 5, Vitest, Gradle, PowerShell/NSIS, electron-builder 26.15.3.

## Global Constraints

- Support exactly Windows x64, Minecraft Java `1.21.5`, Fabric Loader `>=0.16.14`, and same-machine `127.0.0.1` integrated LAN worlds.
- Never read, copy, log, export, or reuse PCL2/Microsoft/Minecraft credentials or access tokens.
- Never change global online authentication, `online-mode`, whitelist, scoreboard/team, or persistent world data.
- A Bridge approval requires integrated server + loopback source + exact current port + exact username `WhiteLily` + unexpired 256-bit proof + successful one-time atomic consumption.
- Renderer input may contain only opaque IDs and bounded enum choices; no renderer path, PID, command line, URL, shell, script, hash, or filename becomes authority.
- Installing components never starts, clicks, closes, or restarts PCL2/Minecraft. A component written after Java start produces `restart_required`.
- Manage only fixed manifest-bound JARs in the exact verified gameDir `mods` child. Reject links, reparse aliases, path escape, unknown same-name files, non-Fabric instances, and identity races.
- Functional Bridge is required for official-auth LAN. Avatar is optional and depends on Bridge + Fabric API `0.128.2+1.21.5` + GeckoLib `5.1.0`.
- All public errors are fixed codes; nonce, request path, gameDir, port, PID, usernames other than literal `WhiteLily`, raw kick/error text, and account data never enter logs or diagnostics.
- Every behavior change follows RED -> verify RED -> minimal GREEN -> verify GREEN -> scoped review -> commit.
- Do not touch any existing Minecraft world. Real validation uses only the already-created disposable WhiteLily acceptance world and rechecks all other world identities before and after.

---

## File Structure

### Node bridge proof boundary

- Create `src/minecraft/bridgeProofIssuer.ts`: strict request schema, trusted request directory, atomic issue/cleanup, fixed `fakeHost` encoder.
- Create `tests/unit/bridgeProofIssuer.test.ts`: real temporary-directory behavior, secret redaction, retries, links, bounds, and cleanup.
- Modify `src/minecraft/mineflayerConnection.ts`: asynchronous per-attempt preparation and exact cleanup ownership.
- Modify `src/minecraft/mineflayerAdapter.ts`: production issuer injection from the WhiteLily data root.
- Modify `src/app.ts`: pass `paths.dataRoot` into the adapter composition.

### Fabric Bridge module

- Create `subprojects/whitelily-avatar/bridge-fabric/`: independent Fabric module source, resources, and JUnit tests.
- Modify `subprojects/whitelily-avatar/settings.gradle.kts`: include `bridge-fabric`.
- Modify `subprojects/whitelily-avatar/build.gradle.kts`: reproducible bridge build and shared Java/Loom configuration.
- Create Java units under `io.github.whitelily.bridge`: request parser/store, authorization policy, presence publisher, approved-profile registry, mixins, and public read-only API.

### Desktop component authority

- Modify `apps/desktop/src-main/discovery/lanDetector.ts`: main-only non-consuming candidate revalidation.
- Refactor `apps/desktop/src-main/discovery/worldBindingAuthority.ts`: share exact Java identity/gameDir derivation between world bind and component inspection.
- Create `apps/desktop/src-main/minecraftComponents.ts`: manifest-bound status/install/remove operations.
- Create `apps/desktop/src-main/minecraftComponents.test.ts`: real temporary instance and race/link/conflict tests.
- Modify `apps/desktop/src-main/main.ts`, `ipcRegistry.ts`, and their tests: production manager composition and fixed IPC handlers.

### Renderer and preferences

- Modify `apps/desktop/src/desktopApi.ts` and preload IPC declarations: bounded component status/options/results.
- Modify `apps/desktop/src/pages/OnboardingPage.tsx` and tests: candidate component gate before confirmation.
- Modify `apps/desktop/src/pages/SettingsPage.tsx` and tests: detect current candidate, install/update/remove exact components.
- Modify `apps/desktop/src/i18n/zh-CN.ts`, `en.ts`, and `messageKeys.ts`: Chinese-first fixed copy and stable codes.
- Create `apps/desktop/src-main/minecraftComponentPreferences.ts`: persisted installer defaults that users may later change.

### Avatar and package resources

- Modify Avatar identity/runtime classes to require Bridge-approved UUID rather than a scoreboard/team marker.
- Modify Gradle staging tasks, `scripts/prepare-electron-bundle.ps1`, `packaging/electron/runtime-manifest.json`, `apps/desktop/package.json`, and installer inspection tests.
- Modify `packaging/nsis/installer.nsh`: optional Bridge/Avatar defaults without guessing gameDir.
- Add exact third-party license/notice files.

---

### Task 1: Node One-Time Bridge Proof Issuer

**Files:**
- Create: `src/minecraft/bridgeProofIssuer.ts`
- Test: `tests/unit/bridgeProofIssuer.test.ts`

**Interfaces:**
- Produces:

```ts
export interface BridgeAttemptProof {
  readonly fakeHost: string;
  close(): Promise<void>;
}

export interface BridgeProofIssuer {
  issue(port: number): Promise<BridgeAttemptProof>;
  close(): Promise<void>;
}

export function createBridgeProofIssuer(options: {
  dataRoot: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}): BridgeProofIssuer;
```

- Request JSON is exactly:

```ts
interface BridgeRequestDocument {
  schemaVersion: 1;
  username: "WhiteLily";
  port: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}
```

- Request filename is `sha256(nonce).json`; `fakeHost` is `127.0.0.1\0WL1\0${nonce}`; nonce is 43 base64url characters from 32 random bytes; TTL is 30,000 ms.

- [ ] **Step 1: Write failing real-filesystem tests**

```ts
it("issues one bounded atomic proof without exposing it in the object shape", async () => {
  const issuer = createBridgeProofIssuer({ dataRoot, now: () => 1_000, randomBytes: () => Buffer.alloc(32, 7) });
  const proof = await issuer.issue(49_152);
  expect(proof.fakeHost).toBe(`127.0.0.1\0WL1\0${Buffer.alloc(32, 7).toString("base64url")}`);
  expect(Object.keys(proof).sort()).toEqual(["close", "fakeHost"]);
  expect(await readOnlyRequestDocuments(dataRoot)).toEqual([{
    schemaVersion: 1,
    username: "WhiteLily",
    port: 49_152,
    issuedAt: 1_000,
    expiresAt: 31_000,
    nonce: Buffer.alloc(32, 7).toString("base64url"),
  }]);
});
```

Add separate cases for invalid ports, non-absolute/escaped data roots, parent/file symlinks or Windows junctions, duplicate nonce collision, target replacement between open and rename, `close()` idempotence, issuer-wide close, stale-file bounded cleanup, and error strings/JSON serialization that contain none of the nonce or absolute root.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/unit/bridgeProofIssuer.test.ts --maxWorkers=1`

Expected: FAIL because `bridgeProofIssuer.ts` does not exist.

- [ ] **Step 3: Implement the minimal issuer**

Use `mkdir`, `lstat`, `realpath`, `open("wx", 0o600)`, `FileHandle.sync`, `rename`, and before/after directory/file identity checks. Serialize with `JSON.stringify(document) + "\n"`; reject files larger than 4,096 bytes. Cleanup uses only issuer-owned exact absolute paths and never recursive deletion or globbing.

- [ ] **Step 4: Run GREEN and mutation checks**

Run: `npx vitest run tests/unit/bridgeProofIssuer.test.ts --maxWorkers=1`

Then temporarily mutate TTL, hash-derived filename, or `wx` to an unsafe open in the test branch and confirm at least one test fails; restore immediately.

- [ ] **Step 5: Commit**

```powershell
git add -- src/minecraft/bridgeProofIssuer.ts tests/unit/bridgeProofIssuer.test.ts
git commit -m "feat: issue one-time local bridge proofs"
```

### Task 2: Fabric Bridge Proof Policy and Atomic Store

**Files:**
- Modify: `subprojects/whitelily-avatar/settings.gradle.kts`
- Modify: `subprojects/whitelily-avatar/build.gradle.kts`
- Create: `subprojects/whitelily-avatar/bridge-fabric/src/main/java/io/github/whitelily/bridge/BridgeRequest.java`
- Create: `subprojects/whitelily-avatar/bridge-fabric/src/main/java/io/github/whitelily/bridge/BridgeProofStore.java`
- Create: `subprojects/whitelily-avatar/bridge-fabric/src/main/java/io/github/whitelily/bridge/BridgeAuthorizationPolicy.java`
- Create tests in the corresponding `src/test/java` package.

**Interfaces:**

```java
public record BridgeRequest(
    int schemaVersion,
    String username,
    int port,
    long issuedAt,
    long expiresAt,
    String nonce) {}

public record BridgeAuthorizationContext(
    boolean integratedServer,
    boolean loopbackRemote,
    int handshakePort,
    int publishedPort,
    String username,
    long now) {}

public final class BridgeProofStore {
  public Optional<BridgeRequest> consume(
      String nonce, BridgeAuthorizationContext context);
}
```

- [ ] **Step 1: Write RED policy matrix**

Use literal fixtures. The only accepted row is integrated=true, loopback=true, handshakePort=publishedPort=request.port=49152, username/request username=`WhiteLily`, `issuedAt <= now < expiresAt`, 43-character base64url nonce, schema 1. Every single-field mutation returns empty.

- [ ] **Step 2: Write RED real-store tests**

Create ordinary request files and assert exactly one of two concurrent consumers succeeds. Add duplicate JSON keys, BOM, malformed UTF-8, empty/over-4096 bytes, mismatched digest filename, symlink/junction request, linked parent, expired record, non-atomic move failure, and second consumption.

- [ ] **Step 3: Run RED**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :bridge-fabric:test`

Expected: FAIL because the module and classes do not exist.

- [ ] **Step 4: Implement minimal strict parser/store/policy**

Use a strict UTF-8 `CharsetDecoder` with malformed/unmappable reporting; reject UTF-8/UTF-16 BOMs. Parse one top-level object with Gson `JsonReader`, explicitly count keys case-sensitively, reject duplicate/unknown/missing keys, and read at most 4,096 bytes from one stable `FileChannel` opened with `READ` and `LinkOption.NOFOLLOW_LINKS`. Recheck `BasicFileAttributes.fileKey`, size, regular-file, and non-symbolic-link before atomic move. Move to a fixed sibling consumed name with `ATOMIC_MOVE`; approve only after the move succeeds, then delete that exact consumed file in `finally`.

- [ ] **Step 5: Run GREEN**

Run the Task 2 command and require every policy/store test to pass on Windows.

- [ ] **Step 6: Commit**

```powershell
git add -- subprojects/whitelily-avatar/settings.gradle.kts subprojects/whitelily-avatar/build.gradle.kts subprojects/whitelily-avatar/bridge-fabric
git commit -m "feat: validate local Fabric bridge proofs"
```

### Task 3: Fabric Handshake/Login Mixins, Presence, and Approved Profile API

**Files:**
- Create Bridge main classes, mixins, `fabric.mod.json`, and mixin config under `bridge-fabric/src/main`.
- Extend Bridge JUnit tests.
- Modify `subprojects/whitelily-avatar/build.gradle.kts` for reproducible JARs.

**Interfaces:**

```java
public final class WhiteLilyBridge {
  public static boolean isApprovedProfile(UUID profileId, String profileName);
}

interface BridgeConnectionAccess {
  void whitelily$setHandshakeProof(String nonce, int port);
  Optional<HandshakeProof> whitelily$takeHandshakeProof();
}
```

- [ ] **Step 1: RED mixin-selection tests**

Test the pure adapter used by the mixin: ordinary hostname, remote socket, wrong username, dedicated server, wrong current port, expired proof, and already-consumed proof all select `VANILLA`; the complete local integrated row selects `BRIDGE_OFFLINE_PROFILE` exactly once.

- [ ] **Step 2: RED presence tests**

Presence filename is `${pid}.json`; document is schema 1 with exact PID, process start epoch ms, Minecraft `1.21.5`, Bridge `0.1.0`, and `writtenAt`. Reject links/overwrites, write atomically, and delete only the exact owned ordinary file at shutdown.

- [ ] **Step 3: Implement mixins**

- `ServerHandshakePacketListenerImpl.handleIntention`: parse only `127.0.0.1\0WL1\0` plus a 43-character base64url nonce; attach candidate proof only for a loopback `Connection`.
- `ServerLoginPacketListenerImpl.handleHello`: verify literal `WhiteLily`, `IntegratedServer`, exact local/published/handshake port and consumed request; set the requested username and invoke vanilla `startClientVerification(UUIDUtil.createOfflinePlayerUUID("WhiteLily"))`; cancel only this hello call.
- `Connection` mixin stores and atomically takes one proof.
- A server-stop hook clears the process-local approved-profile registry. Registry membership is scoped to the current integrated server object and fixed offline UUID.

- [ ] **Step 4: Compile against real 1.21.5 mappings**

Run:

```powershell
subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :bridge-fabric:check :bridge-fabric:remapJar
```

Expected: JUnit green, mixin refmap generated, and one reproducible `whitelily-bridge-fabric-1.21.5-0.1.0.jar`.

- [ ] **Step 5: Inspect the built JAR**

Open it as ZIP in a test and require exact `fabric.mod.json`, mixin config, refmap, license, Bridge classes, Minecraft `=1.21.5`, Fabric Loader `>=0.16.14`, and no Fabric API/GeckoLib dependency.

- [ ] **Step 6: Commit**

```powershell
git add -- subprojects/whitelily-avatar/bridge-fabric subprojects/whitelily-avatar/build.gradle.kts
git commit -m "feat: authorize one local integrated-server profile"
```

### Task 4: Main-Process Candidate Component Authority

**Files:**
- Modify: `apps/desktop/src-main/discovery/lanDetector.ts`
- Modify: `apps/desktop/src-main/discovery/lanDetector.test.ts`
- Modify: `apps/desktop/src-main/discovery/worldBindingAuthority.ts`
- Modify: `apps/desktop/src-main/discovery/worldBindingAuthority.test.ts`
- Create: `apps/desktop/src-main/minecraftComponents.ts`
- Test: `apps/desktop/src-main/minecraftComponents.test.ts`

**Interfaces:**

```ts
export type MinecraftComponentId = "bridge" | "avatar";
export type MinecraftComponentState =
  | "bridge_not_installed"
  | "bridge_restart_required"
  | "bridge_not_active"
  | "bridge_version_unsupported"
  | "bridge_file_conflict"
  | "avatar_not_installed"
  | "avatar_restart_required"
  | "ready";

export interface MinecraftComponentStatus {
  readonly state: MinecraftComponentState;
  readonly bridgeInstalled: boolean;
  readonly bridgeActive: boolean;
  readonly avatarInstalled: boolean;
  readonly restartRequired: boolean;
}

export interface MinecraftComponentManager {
  status(candidateId: string): Promise<MinecraftComponentStatus>;
  install(candidateId: string, selection: readonly MinecraftComponentId[]): Promise<MinecraftComponentStatus>;
  remove(candidateId: string, selection: readonly MinecraftComponentId[]): Promise<MinecraftComponentStatus>;
}
```

- [ ] **Step 1: RED non-consuming candidate authority tests**

Assert component inspection re-probes the same PID/start time/port/version before and after gameDir resolution, does not consume or retain a LAN confirmation proof, and fails on PID reuse, command-line change, listener change, candidate expiry, non-Java executable, non-Fabric argv, or version metadata mismatch.

- [ ] **Step 2: RED real-directory component tests**

Use actual temporary `gameDir/mods` directories and small hand-built JAR ZIP fixtures. Cover clean install, idempotent exact hash, known prior WhiteLily update, unknown same-name conflict, removal, missing target, gameDir/mods/file link or junction, parent identity change, temp-file collision, write/rename failure, current Java start before/after JAR mtime, missing/wrong presence, and renderer-style path-shaped candidate IDs.

- [ ] **Step 3: Run RED**

Run:

```powershell
npx vitest run apps/desktop/src-main/discovery/lanDetector.test.ts apps/desktop/src-main/discovery/worldBindingAuthority.test.ts apps/desktop/src-main/minecraftComponents.test.ts --maxWorkers=1
```

- [ ] **Step 4: Refactor authority once, without weakening world bind**

Add a main-only `inspectCandidate(candidateId)` that returns an immutable internal `LanObservation` after same-observation reprobe. Extract `WorldBindingAuthority.resolveJavaInstance(observation)` so both `redeem(proof)` and component inspection perform the same double Java snapshot comparison and canonical gameDir validation. Do not add path/PID to public `LanCandidate` or `ConfirmedLanSession`.

- [ ] **Step 5: Implement manifest-bound manager**

Read only the packaged component manifest supplied by main composition. Parse JAR `fabric.mod.json` from a bounded ZIP reader. Use ordinary non-link directories whose `lstat` dev/ino and canonical realpath are unchanged before/after; write a same-directory fixed-format temporary file with `open("wx")`, sync, close, atomic rename, and target identity/hash recheck. For an update, first move a verified prior WhiteLily JAR to the same-directory fixed `.whitelily-disabled` backup name, install the new target, then unlink only that verified backup; on failure restore it before returning. Never recursively delete. Remove only a fixed filename whose embedded mod ID and hash are in the current/prior reviewed allowlist.

- [ ] **Step 6: Run GREEN and existing world-authority suites**

Run Task 4 command plus:

```powershell
npx vitest run apps/desktop/src-main/ipcPrivateWorldE2e.test.ts tests/unit/worldProfileStore.test.ts --maxWorkers=1
```

- [ ] **Step 7: Commit**

```powershell
git add -- apps/desktop/src-main/discovery/lanDetector.ts apps/desktop/src-main/discovery/lanDetector.test.ts apps/desktop/src-main/discovery/worldBindingAuthority.ts apps/desktop/src-main/discovery/worldBindingAuthority.test.ts apps/desktop/src-main/minecraftComponents.ts apps/desktop/src-main/minecraftComponents.test.ts
git commit -m "feat: manage verified PCL2 instance components"
```

### Task 5: Component IPC, Onboarding, Settings, and Installer Defaults

**Files:**
- Modify: `apps/desktop/src-main/main.ts`, `ipcRegistry.ts`, and tests.
- Modify: preload channel declarations/tests.
- Modify: `apps/desktop/src/desktopApi.ts` and tests.
- Modify: `apps/desktop/src/pages/OnboardingPage.tsx`, `SettingsPage.tsx`, and tests.
- Modify: `apps/desktop/src/i18n/zh-CN.ts`, `en.ts`, `messageKeys.ts`.
- Create: `apps/desktop/src-main/minecraftComponentPreferences.ts` and tests.

**Interfaces:**

```ts
getMinecraftComponentStatus(candidateId: string): Promise<MinecraftComponentStatus>;
installMinecraftComponents(candidateId: string, selection: readonly MinecraftComponentId[]): Promise<MinecraftComponentStatus>;
removeMinecraftComponents(candidateId: string, selection: readonly MinecraftComponentId[]): Promise<MinecraftComponentStatus>;
```

- [ ] **Step 1: RED preload/IPC authority tests**

Assert the three channels accept exactly one opaque ID plus a duplicate-free ordered subset of `bridge|avatar`; reject paths, extra keys, empty/oversized IDs, arbitrary strings, more than two values, and malformed manager results. Confirm main, not renderer, supplies the manager and resource manifest.

- [ ] **Step 2: RED Onboarding tests**

Required behavior: detected candidate automatically gets status; `ready` preserves the explicit confirm button; missing Bridge shows checked Bridge and checked Avatar options plus “安装到此 PCL2 实例”; install success shows restart-required and disables confirm; no status/install path auto-confirms or calls start; candidate expiry cancels late status/install results with the existing generation fence.

- [ ] **Step 3: RED Settings tests**

Settings performs a fresh candidate detection, never reuses a stale path, supports Bridge-only, Bridge+Avatar, update, and safe remove. Removing Bridge automatically includes Avatar because Avatar depends on it; removing Avatar alone preserves Bridge. UI displays only PCL2/Minecraft/component names and fixed states, never a path/port/PID/hash.

- [ ] **Step 4: Implement fixed preferences**

Persist schema 1 at `config/minecraft-components.json` under WhiteLily data root:

```json
{"schemaVersion":1,"bridgeEnabled":true,"avatarEnabled":true}
```

Use the existing atomic JSON/document-store pattern. Installer defaults initialize only when the file is absent; later installs/upgrades never overwrite user changes.

- [ ] **Step 5: Implement UI and stable copy**

Chinese copy leads, English mirrors it. Add fixed codes from the design and a clear statement that mods apply to the current PCL2 instance, require Fabric 1.21.5 and a game restart, and do not alter old worlds. Keep explicit LAN confirmation as a separate button after `ready`.

- [ ] **Step 6: Run GREEN**

Run:

```powershell
npx vitest run apps/desktop/src-main/ipcRegistry.test.ts apps/desktop/src/pages/OnboardingPage.test.tsx apps/desktop/src/pages/SettingsPage.test.tsx apps/desktop/src/desktopApi.test.ts --maxWorkers=1
```

- [ ] **Step 7: Commit**

Stage only the Task 5 files and commit `feat: install Minecraft components from the desktop`.

### Task 6: Mineflayer Per-Attempt Proof Integration and Stable Recovery

**Files:**
- Modify: `src/minecraft/mineflayerConnection.ts`
- Modify: `src/minecraft/mineflayerAdapter.ts`
- Modify: `src/app.ts`
- Modify related unit/integration tests.
- Modify child/runtime error mapping and Onboarding fixed-code mapping tests.

**Interfaces:**

Add to `MineflayerConnectionDependencies`:

```ts
prepareAttempt(port: number): Promise<BridgeAttemptProof>;
```

`createBot` receives `fakeHost: string`. Each attempt owns one proof and closes it on spawn, setup throw, error, kicked, end, stop, timeout, retry transition, or terminal fence.

- [ ] **Step 1: RED connection-state tests**

Cover delayed preparation, stop while preparation is pending, stale preparation completion, createBot throw, pre-spawn kicked/error/end, full retry sequence, connected disconnect, terminal fence, and duplicate callbacks. Assert every attempt gets a different literal fakeHost, exactly one `close`, no bot before preparation, and no later attempt reuses a proof.

- [ ] **Step 2: RED composition and public-error tests**

Assert production `MineflayerAdapter` receives `paths.dataRoot`; a Bridge preparation failure maps to `MINECRAFT_BRIDGE_REQUIRED`; five proof-backed login rejections exhaust to `MINECRAFT_BRIDGE_REJECTED`; neither error exposes raw kick text, nonce, request path, port, or data root. Diagnostics must show `failed` with the stable code rather than `starting` with null error.

- [ ] **Step 3: Implement minimal async attempt generation**

Use an incrementing attempt generation. Await `prepareAttempt`; recheck lifecycle/generation before `createBot`; stale completions close their own proof. Assign bot and proof atomically in the active generation; one cleanup helper takes and closes the active proof so crossed `error`/`kicked`/`end` cannot double-close or double-retry.

- [ ] **Step 4: Run GREEN**

Run focused Mineflayer, adapter, app, runtime facade, child server, diagnostics, and Onboarding suites with `--maxWorkers=1`.

- [ ] **Step 5: Review and commit**

Obtain independent review of state-machine races and secret redaction, fix all Important findings, then commit `feat: authenticate local Mineflayer bridge attempts`.

### Task 7: Bridge-Bound WhiteLily Avatar Pack

**Files:**
- Modify Avatar identity snapshots/matcher/runtime/tests.
- Modify Avatar `fabric.mod.json` and Gradle dependencies.
- Add Bridge API dependency tests.
- Add reproducible component staging task and license inputs.

**Interfaces:**

`PlayerIdentitySnapshot` gains `boolean bridgeApproved`. `WhiteLilyIdentityMatcher` returns `FULL` only when profile name is literal `WhiteLily`, player is not local, world session matches, and `WhiteLilyBridge.isApprovedProfile(uuid, name)` is true. Scoreboard/team text is not an authority input.

- [ ] **Step 1: RED identity tests**

Require no render for remote server `WhiteLily`, wrong UUID, stale integrated session, local player, missing Bridge, or a profile approved in another integrated-server object. Require full base/armor render only for the Bridge-approved current profile.

- [ ] **Step 2: Implement the read-only Bridge API use**

Declare `whitelily_bridge >=0.1.0` in Avatar `depends`. Replace team-based full authorization with Bridge approval. Keep the existing renderer failure containment and six material themes; remove any code/test implying a scoreboard write is needed.

- [ ] **Step 3: Build and test all mod artifacts**

Run `:bridge-fabric:check :mod-fabric:check :bridge-fabric:remapJar :mod-fabric:remapJar`. Require deterministic rerun hashes. Stage exact Bridge, Avatar, Fabric API, GeckoLib and license files into `build/minecraft-components` with fixed portable names.

- [ ] **Step 4: Add actual JAR boundary tests**

Inspect all four JARs as ZIPs, confirm IDs/versions/dependencies, reject duplicate mod IDs and unexpected executables/scripts/native libraries, and confirm Avatar resources include the six reviewed themes.

- [ ] **Step 5: Commit**

Commit only Avatar/Gradle/staging/license changes as `feat: bind the WhiteLily avatar to bridge identity`.

### Task 8: Installer, Runtime Manifest, Inspect, and Sandbox Lifecycle

**Files:**
- Modify: `scripts/prepare-electron-bundle.ps1`
- Modify: `packaging/electron/runtime-manifest.json`
- Modify: `apps/desktop/package.json`
- Modify: `packaging/nsis/installer.nsh`
- Modify: `scripts/inspect-installer.ps1`, `scripts/test-installer.ps1`
- Modify related integration tests and Windows install docs/security notices.

- [ ] **Step 1: RED deterministic bundle tests**

Require `desktop:prepare` to build/stage components before exact-file validation; runtime manifest and generated resource manifest must list each JAR/license with exact bytes/SHA-256. Tamper, remove, link, add an unreviewed JAR, or change Gradle output hash and require preparation/inspect to fail.

- [ ] **Step 2: RED NSIS behavior tests**

Assisted install shows default-checked Bridge and Avatar choices. Silent install defaults both true. Existing `config/minecraft-components.json` survives upgrade unchanged. Fresh install writes the exact schema once. Uninstall Keep Data preserves it; Delete Data removes it with the rest of WhiteLily data. Installer still uses fixed per-user root and no elevation.

- [ ] **Step 3: Implement packaging inputs**

Run the Gradle staging task before `Assert-ReviewedFile`. Add staged JARs/licenses as tracked policy `exactFiles` and bundle them to `minecraft-components`. Add that directory to Electron `extraResources`, `paths`, `requiredFiles`, and inspector resource verification. Do not add JAR to executable/script allowlists.

- [ ] **Step 4: Implement NSIS component defaults**

Use `nsDialogs` checkboxes on assisted install. In `customInstall`, create the fixed WhiteLily config directory and write the exact one-line UTF-8-no-BOM JSON only if absent. Silent mode sets both enabled. Do not search for PCL2 or write any Minecraft file from NSIS.

- [ ] **Step 5: Run automated release gates**

Run, in order:

```powershell
npm run format:check
npm run typecheck
npm run typecheck --workspace @whitelily/desktop
npx vitest run --maxWorkers=1
npm test --workspace @whitelily/desktop -- --maxWorkers=1
npm run build
npm run desktop:build
npm run desktop:prepare
npm run desktop:package -- -Version 0.2.0-beta.2
```

Then run fresh installer inspect, all installerScripts, outer/embedded PowerShell parsers, and the real official-beta1-to-new-beta2 15-stage Windows Sandbox lifecycle. Require zero Sandbox processes/mappings afterward and update the tracked public attestation to the new candidate/report hashes.

- [ ] **Step 6: Update Chinese-first docs**

Update README, Windows install guides, security status, smoke checklist and roadmap. State Fabric-only 1.21.5 support, instance-level installation, restart requirement, unsigned status/hash verification, Bridge security boundary, optional Avatar dependencies, and no credential/global-auth bypass.

- [ ] **Step 7: Commit and independent release-candidate review**

Split product/package changes from attestation-only changes. Obtain independent high-intensity review of installer inputs, JAR provenance/licenses, Sandbox report, public privacy, and attestation binding.

### Task 9: Real Disposable-World Acceptance and Release

**Files:**
- Write ignored redacted evidence under `build/manual-acceptance-bridge/`.
- Update tracked release evidence only with public-safe aggregate hashes/status.
- No existing world file may be edited by the task.

- [ ] **Step 1: Establish safety baselines**

Require tracked clean, exact installed/candidate hashes, exact PCL2/Fabric/Java 1.21.5 process identities, and hash/file-identity/mtime baselines for every non-test world. Keep screenshots cropped to WhiteLily/Minecraft controls; immediately delete any image containing username, port, chat, endpoint, or local path.

- [ ] **Step 2: Install the component pack through WhiteLily**

Use the detected opaque candidate and the real component UI. Install Bridge + Avatar into the disposable instance, verify only fixed JARs changed, then normally exit/restart PCL2/Minecraft. Do not directly copy a JAR during acceptance.

- [ ] **Step 3: Verify discovery and explicit authority**

Open only the disposable world to LAN. Require automatic candidate discovery without manual refresh, correct 1.21.5/presence state, no auto-confirm, and one explicit confirm. Verify one stable WhiteLily player joins and Avatar renders only that Bridge-approved profile.

- [ ] **Step 4: Verify chat and action semantics**

- `你好呀` remains chat and uses no Minecraft action tool.
- `查看一下你现在的位置` calls `minecraft_get_state` and answers from tool state.
- `走到我身边来` executes movement directly without a redundant “是否执行” prompt.
- A TNT/destructive request enters confirmation-required state; with no confirmation, no tool mutates the world.
- Task disclosure remains invisible in normal chat.

- [ ] **Step 5: Verify model/runtime lifecycle**

Switch Terra -> Luna in the same Minecraft session, confirm actions remain ready, restart child/app and confirm selection persists. Stop the task and verify pending action leases, MCP authority and tool access are revoked while normal shutdown leaves no stale running UI.

- [ ] **Step 6: Verify fail-closed Bridge behavior**

Stop WhiteLily, remove/disable only the managed Bridge through the UI, restart the disposable instance, and confirm WhiteLily reports `bridge_not_installed`/`bridge_not_active` before Mineflayer. Reinstall, restart and confirm recovery. Do not test by disabling global authentication.

- [ ] **Step 7: Final safety and privacy checks**

Normally exit WhiteLily, Minecraft and PCL2. Require exact task processes zero, test-world-only changes, all non-test world baselines unchanged, no retained sensitive screenshot, and privacy scan zero for absolute paths, PIDs, ports, owner/account identifiers, nonce/token material, and raw errors.

- [ ] **Step 8: Finish and publish**

Run the final release verifier and `git diff --check`, ensure tracked clean, then use `superpowers:finishing-a-development-branch` and the GitHub publish workflow to push the branch, open/review the PR, merge, tag `v0.2.0-beta.2`, and publish one prerelease installer plus SHA-256/signing-status/attestation assets. Verify the GitHub landing page is Chinese-first with English afterward and that the release asset hash equals the locally accepted candidate.

---

## Plan Self-Review

- Spec coverage: proof, per-listener authorization, presence, component management, installer choice, Avatar trust, packaging, Sandbox, real actions and release each have a task.
- Scope: tasks are ordered by dependency; Avatar is a separate reviewed task but uses the Bridge API from Task 3.
- Authority: no renderer-controlled path/process/material appears in any public interface.
- Failure behavior: missing/inactive/rejected Bridge has a bounded stable code; child generation invalidation remains a prerequisite from the already-reviewed desktop fix.
- Type consistency: `MinecraftComponentId`, `MinecraftComponentStatus`, `BridgeAttemptProof`, and `WhiteLilyBridge.isApprovedProfile` are defined once and reused by later tasks.
- Placeholder scan: artifact versions are fixed at Bridge/Avatar `0.1.0`, Minecraft `1.21.5`, Fabric Loader `0.16.14`, Fabric API `0.128.2+1.21.5`, GeckoLib `5.1.0`, and desktop `0.2.0-beta.2`.
