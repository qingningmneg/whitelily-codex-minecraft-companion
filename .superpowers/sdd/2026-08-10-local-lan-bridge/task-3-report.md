# Task 3 Evidence Report: Fabric Authorization, Presence, and Profile API

## Status and scope

- Status: `DONE_WITH_CONCERNS`
- Commit: `22485aa` (`feat: authorize one local integrated-server profile`)
- Base supplied for the task: `60c215018bdc95251a8100860c17117cdd8daa93`
- Implemented only `subprojects/whitelily-avatar/bridge-fabric/src/main`, its Task 3 tests, and `subprojects/whitelily-avatar/build.gradle.kts`.
- No plan/specification files, Task 2 sources/tests, Minecraft/PCL2 processes, Java game processes, UI, or worlds were changed or controlled.
- Exact staged scope was inspected with `git diff --cached --name-status`; `git diff --cached --check` passed before commit.

## Test-driven development evidence

All Gradle invocations below explicitly used JDK 21 at `C:\Program Files\Android\openjdk\jdk-21.0.8`.

### Initial authorization and presence slice

1. Tests were created first for the pure handshake/login selector and real temporary-filesystem presence publisher.
2. RED command:

   `gradlew.bat :bridge-fabric:test --tests io.github.whitelily.bridge.BridgeLoginSelectorTest --tests io.github.whitelily.bridge.BridgePresencePublisherTest --console=plain`

   Result: `compileTestJava` failed with 26 missing-symbol errors because the Task 3 production classes did not exist.
3. Minimal production was added. The first presence GREEN attempt exposed a real write-loop defect: recreating the `ByteBuffer` each iteration caused an unbounded temporary write. Only the task-owned Gradle/test PIDs were stopped; the exact JUnit temporary artifact was path/content checked and removed. A two-second timeout regression was added before fixing the loop to reuse one buffer.
4. GREEN result: 12 tests, 0 failures/errors, 2 symbolic-link privilege skips.

### Registry, JAR, endpoint, and lifecycle slices

- Registry/JAR tests were written before their production. RED: 19 missing-symbol compiler errors.
- Registry minimum GREEN: 2 tests passed.
- JAR contract RED: 1 runtime failure because the metadata/artifact entries were not yet present; after resources/build wiring it passed against the real remapped ZIP.
- Local-port behavior test RED: 5 method-signature mismatch compiler errors; implementation then used the actual connection channel local port.
- Pending approval lifecycle tests were added before implementation. RED: 6 missing `PendingProfileApprovalSlot` symbols. GREEN after a connection-local, one-time pending marker and `PlayerList.placeNewPlayer` TAIL activation.
- Current-integrated-server identity tests were added first. RED: 6 missing `isApprovedProfileForCurrentServer` symbols. GREEN after public reads were bound by object identity to `Minecraft.getInstance().getSingleplayerServer()` and also required the stored server's `isPublished()` predicate.
- Final presence-replacement test RED: `NoSuchFieldException: beforePresenceIdentityHook`. GREEN after retaining the original temporary-file identity for validation, cleanup, and returned ownership.
- Replacement-directory test RED: `NoSuchFieldException: beforeLinkIdentityHook`. GREEN after revalidating directory/temp/target identities and removing cleanup that could act without the original ownership identity.

## Authorization and lifecycle behavior

- Handshake parsing accepts only login intention, loopback remote, `127.0.0.1\0WL1\0`, and one 43-character canonical base64url nonce representing 32 bytes.
- Candidate proof state is atomic, taken once, and redacted from rendering.
- Login falls through to vanilla for ordinary hostname, remote source, wrong literal username, dedicated server, local/published/handshake port mismatch, expired proof, or consumed proof.
- The accepted row sets literal `WhiteLily`, uses `UUIDUtil.createOfflinePlayerUUID("WhiteLily")`, invokes vanilla `startClientVerification`, and cancels only that hello call.
- Approval is not published during hello. A one-time marker remains private to that `Connection` and becomes visible only after successful `PlayerList.placeNewPlayer` completion.
- Reads require the fixed UUID/name, exact current integrated-server object, and a still-published server. Player removal and server stop revoke only the owning server's approval.

## Real 1.21.5 mapping and bytecode evidence

The implementation compiled against Loom 1.10.5 with official Minecraft 1.21.5 mappings. Inspection of the real mapped client/server JAR established:

- `ServerHandshakePacketListenerImpl.handleIntention(Lnet/minecraft/network/protocol/handshake/ClientIntentionPacket;)V`
- `ServerLoginPacketListenerImpl.handleHello(Lnet/minecraft/network/protocol/login/ServerboundHelloPacket;)V`
- `ServerLoginPacketListenerImpl.startClientVerification(Lcom/mojang/authlib/GameProfile;)V`
- `IntegratedServer.isPublished()Z`
- `IntegratedServer.getPort()I`
- `MinecraftServer.stopServer()V`
- `PlayerList.placeNewPlayer(Lnet/minecraft/network/Connection;Lnet/minecraft/server/level/ServerPlayer;Lnet/minecraft/server/network/CommonListenerCookie;)V`
- `PlayerList.remove(Lnet/minecraft/server/level/ServerPlayer;)V`
- `UUIDUtil.createOfflinePlayerUUID(Ljava/lang/String;)Ljava/util/UUID;`

`handleHello` contains `startClientVerification` calls at bytecode offsets 76 and 154. To avoid an ordinal-dependent injection, the login adapter injects at cancellable `HEAD` using the complete `handleHello` descriptor and directly calls the shadowed vanilla verification method only for an approved bridge row. Handshake uses full-descriptor `HEAD`; lifecycle uses full-descriptor `TAIL` for completed placement and `HEAD` for removal/stop.

The built refmap was opened from the real JAR and asserted exactly:

- handshake: `Lnet/minecraft/class_3246;method_12576(Lnet/minecraft/class_2889;)V`
- login: `Lnet/minecraft/class_3248;method_12641(Lnet/minecraft/class_2915;)V`
- stop: `Lnet/minecraft/server/MinecraftServer;method_3782()V`
- place player: `Lnet/minecraft/class_3324;method_14570(Lnet/minecraft/class_2535;Lnet/minecraft/class_3222;Lnet/minecraft/class_8792;)V`
- remove player: `Lnet/minecraft/class_3324;method_14611(Lnet/minecraft/class_3222;)V`

Inspection also confirmed `IntegratedServer.stopServer()` invokes the superclass `MinecraftServer.stopServer()` at bytecode offset 1, so the superclass stop hook covers the integrated server.

## Final verification

Exact required command:

`subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :bridge-fabric:check :bridge-fabric:remapJar --console=plain`

Result: `BUILD SUCCESSFUL`; 47 tests, 0 failures, 0 errors, 3 skipped. The skips are Windows symbolic-link privilege gates. Windows junction/reparse-point rejection tests ran and passed, including the presence-directory junction test and Task 2 request-root junction/reparse tests.

Dependency inspection:

`gradlew.bat :bridge-fabric:dependencies --configuration modImplementation --console=plain`

Result: only `net.fabricmc:fabric-loader:0.16.14`; no Fabric API or GeckoLib.

JAR inspection test opened the output as ZIP and checked the exact filename, metadata key sets and non-duplicate arrays, client-only environment, Fabric Loader/Minecraft constraints, mixin config, exact mapped refmap descriptors, license bytes, required Bridge classes, and absence of Fabric API/GeckoLib entries.

Final artifact:

- Filename: `whitelily-bridge-fabric-1.21.5-0.1.0.jar`
- Size: 42,658 bytes
- ZIP entries: 35
- SHA-256: `C16DA392FE08708FD7133CC2C13332249A66C29F9984BB2638F9C7D4872A334B`
- Reproducibility: two independent `:bridge-fabric:clean :bridge-fabric:remapJar` builds produced the identical SHA-256 above.

## Review and concerns

- Read-only code review initially identified premature approval publication and foreign-replacement presence cleanup. Both received failing regression tests and fixes. Follow-up review reported no remaining Critical or Important issues and `Ready: Yes`.
- Concern: 3 symbolic-link tests were skipped because this Windows account lacks symbolic-link privilege. Equivalent active junction/reparse tests passed, but the skipped symbolic-link paths were not executable in this environment.
- Per task prohibition, no Minecraft runtime was launched; evidence is from pure behavior tests, real filesystem tests, official 1.21.5 compilation/mappings, refmap/JAR inspection, and reproducible builds.

## Fix round 1/5: exact handle cleanup and complete JAR contract

Independent review found that path validation followed by `Files.delete` still had a replacement race, especially because the Windows JDK intentionally returns `null` from `BasicFileAttributes.fileKey()`. It also found that the JAR test asserted only a required subset rather than the complete artifact.

### Presence cleanup RED/GREEN

- A real Windows filesystem test was added first. It installs a replacement from a deterministic hook immediately before cleanup and requires the replacement to survive while the moved owned object disappears.
- RED command: `gradlew.bat :bridge-fabric:test --tests io.github.whitelily.bridge.BridgePresencePublisherTest.handleCoupledClosePreservesAReplacementInstalledAtTheDeleteBoundary --console=plain`.
- RED result: 1 test failed with `NoSuchFieldException: beforeOwnedHandleCloseHook`.
- Root-cause characterization confirmed that public Windows `BasicFileAttributes.fileKey()` is always unavailable in this JDK and that path deletion cannot couple its earlier identity check to the unlink operation.
- The fix uses Minecraft 1.21.5's existing JNA 5.15.0 runtime classpath without adding or embedding a dependency. `WindowsOwnedFile` calls `CreateFileW` with `CREATE_NEW`, non-following flags, controlled sharing, write and delete access. The same unique `HANDLE` writes and flushes the complete document, reads stable `FILE_ID_INFO`, remains live across the temporary-to-presence rename, receives `FileDispositionInfo` at cleanup, and is then closed on every success/failure path.
- Current path and directory checks use native volume/file IDs and fail closed when a stable native identity cannot be obtained. Non-Windows hosts return no publisher.
- The deterministic close-boundary replacement, ordinary collision, normal zero-residue close, final publication replacement, and hook-exception cleanup all run against the real Windows filesystem. The native handle also blocks the attempted directory rename; the test confirms the hook ran, publication failed closed, and the owned file left zero residue.
- GREEN focused result: presence publisher suite 9 tests, 0 failures/errors, 2 symbolic-link privilege skips.

### Exact JAR contract RED/GREEN

- Two mutation tests were added before the exact assertion helper: one embeds `com/sun/jna/Native.class`; the other adds an unexpected `main` entrypoint.
- RED command: `gradlew.bat :bridge-fabric:test --tests io.github.whitelily.bridge.BridgeJarContractTest --console=plain`.
- RED result: `compileTestJava` failed with 2 missing `BridgeJarContractAssertions` symbols.
- The exact contract now asserts all 37 allowed ZIP entries and the exact entry count, including every authorization, selector, registry, presence, mixin, native-owner, metadata, refmap, manifest, and license entry. No extra resources/classes or duplicate entries can pass.
- Metadata checks cover every top-level value including name `WhiteLily Bridge`, exact top-level and nested key sets, the sole client entrypoint, exact mixin list, and exact dependency keys/constraints.
- Mixin/refmap checks cover exact owner/method key sets and all five mapped descriptors recorded above; the `data.named:intermediary` map must equal the main mappings map.
- Explicit forbidden rules reject embedded JNA, Fabric packages/API, Mixin, Gson, GeckoLib, or nested JARs. The embedded-JNA mutation is verified to fail specifically with the forbidden-package assertion.
- GREEN focused result: combined presence and JAR contract suites passed.

### Fix-round final evidence

- Commit: `2fc5ec4` (`fix: couple presence cleanup to its file handle`).
- Exact JDK 21 gate: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :bridge-fabric:check :bridge-fabric:remapJar --console=plain` -> `BUILD SUCCESSFUL`.
- Tests: 50 total, 0 failures, 0 errors, 3 Windows symbolic-link privilege skips; junction/reparse tests remain active and green.
- `modImplementation`: only `net.fabricmc:fabric-loader:0.16.14`.
- Final JAR: `whitelily-bridge-fabric-1.21.5-0.1.0.jar`, 45,783 bytes, 37 entries.
- SHA-256: `B4753E5333640640E6F3399582AA8E39FD96121CA2B5042446E7D8E895899459`.
- Two independent clean remap builds produced the identical SHA-256.
- Mixin mapping descriptors did not change in this fix round and remain exactly asserted in the artifact.
- `git diff --cached --check` passed and the commit contains only the five Task 3 presence/JAR source and test files.

## Remediation round 2 evidence (2026-08-10)

- Scope: Task 3 bridge-fabric production/tests only; no game, launcher, UI, or world process was launched or controlled.
- Windows proof hard-link RED: `gradlew.bat :bridge-fabric:test --tests io.github.whitelily.bridge.BridgeProofStoreTest.rejectsAPreexistingRetainedHardLinkWithoutConsumingTheProof --tests io.github.whitelily.bridge.BridgeProofStoreTest.rejectsASameSizeThreePathReplacementWithoutDeletingIt --console=plain` -> 2 tests, 2 `AssertionFailedError` failures.
- GREEN: full `BridgeProofStoreTest` -> 24 passed, 0 failed/errors, 1 existing symlink privilege skip. The store now fails closed on non-Windows, opens a non-reparse native handle, compares `FILE_ID_INFO`, requires exact native hard-link counts, and deletes only known names using handles coupled to each name.
- Canonical nonce RED: the new policy/selector/store alias cases failed 3/3. GREEN: a nonce must be 43 base64url characters, decode to exactly 32 bytes, and re-encode byte-for-byte identically.
- OS gate RED: non-Windows selector candidate test failed 1/1. GREEN 1/1 after selector/runtime/proof native Windows gates.
- Real 1.21.5 bytecode evidence: `ServerLoginPacketListenerImpl.handleHello` validates `state == HELLO` (bytecode 0–23), validates `StringUtil.isValidPlayerName` (24–37), then assigns `requestedUsername` (40–45). The mixin injects after that `PUTFIELD`, mapped in refmap as `Lnet/minecraft/class_3248;field_45028:Ljava/lang/String;`; it no longer cancels at HEAD. Bytecode contract test passed and asserts the state, invalid-name, and assignment ordering.
- Current-server regression passed: an approval for an old still-active server object does not authorize a distinct current server object; public read is routed through `Minecraft.getInstance().getSingleplayerServer()`.
- Terminal lifecycle GREEN: 4 focused observable cases (baseline/reject/disconnect/placement failure) pass. `Connection.disconnect(DisconnectionDetails)` HEAD clears both slots; real 1.21.5 `Connection.disconnect(Component)` delegates to it, including the configuration listener's caught placement-failure branch.
- Native owner GREEN: 2 focused tests confirm collision preserves the foreign file and normal close records successful `FileDispositionInfo` while leaving zero owned residue; close is in `finally` and has no path-delete fallback.
- JAR duplicate mutation confirmation: with the central-directory duplicate guard temporarily removed, the crafted duplicate-entry archive test unexpectedly passed (genuine mutation RED for the guard); after restoring a raw central-directory duplicate-name scan, focused duplicate plus terminal suite passed 5/5. Other JAR mutations cover generic extra/missing entry, Fabric dependency, license, manifest, mixin, refmap, and metadata mutations.
- Current full exact JDK 21 gate: `gradlew.bat :bridge-fabric:check :bridge-fabric:remapJar --console=plain` -> `BUILD SUCCESSFUL` (7 tasks).
- Fresh clean remap builds (twice) produced identical SHA-256 `BB083DC786A6AA80386BF0383C106643B22799C9F353BD8F2DC122A43E36DBF1` for `whitelily-bridge-fabric-1.21.5-0.1.0.jar`.

## Remediation round 3 evidence (2026-08-10)

- Status: `READY_FOR_REVIEW`; base `4e9f1deace6cbb5a50346edbc2a6d7643faf58e1`. The immutable remediation commit is reported in the Task 3 handoff because a commit cannot contain its own final hash.
- Scope remained Task 3 Bridge main/resources/tests plus the shared Avatar Gradle contract. No plan/specification, external game, launcher, UI, Java process, or world was changed or controlled.
- Native-handle ownership RED: focused real-Windows test `WindowsOwnedFileTest.proofOpenClosesItsNativeHandleWhenIdentityAcquisitionThrows` failed with `NoSuchFieldException: identityReader`, proving there was no deterministic failure seam. Root cause was that `WindowsProofHandle.open` acquired identity after `CreateFileW` without an accepted/ownership-transfer `finally`; an exception skipped `CloseHandle`.
- Native-handle GREEN: `open` now transfers the handle only after identity succeeds and closes it in `finally` on empty or exceptional identity acquisition. The seam-driven test captures the actual `HANDLE`, throws during identity acquisition, and proves the captured handle is invalid afterward. There is still no `WindowsOwnedFile` path-delete fallback.
- Hard-link Critical calibration: design §3.5 and the Task 2 plan explicitly exclude a same-user malicious process continuously racing every syscall and disclaim a guarantee after the penultimate unlink. Existing deterministic tests remain green for a pre-existing retained hard link and declared-hook three-name replacement. A new real-Windows characterization sets delete-pending on the same live `HANDLE`; native link count then fails closed, `Files.createLink` is rejected before final close, and the owned name disappears on close. No deterministic/pre-existing/declared-hook reproduction was found for the residual final link-count-to-disposition live-racer interval. This residual should be re-adjudicated against the stated boundary rather than described as an in-scope Critical.
- Exact-JAR RED: a timestamp-preserving reversed-entry archive was incorrectly accepted, and a dependency mutation could not reach its named semantic rejection because mutation helpers rewrote timestamps. Exact manifest bytes were not asserted.
- Exact-JAR GREEN: the contract asserts all entries in exact order, each exact timestamp, literal manifest bytes, exact license bytes, complete metadata/mixin/refmap values, raw central-directory uniqueness, and forbidden embedded packages. Isolated timestamp-preserving mutations reach named reasons for Fabric Loader dependency, order, timestamp, mixin content, refmap content, manifest, and license; generic extra/missing, forbidden dependency, and real duplicate mutations remain covered.
- Terminal-lifecycle RED/GREEN: the former four tests all called only `BridgeConnectionLifecycle.clear`. Replacement tests invoke the actual private `ConnectionMixin` injection callback and inspect compiled annotations plus real 1.21.5 bytecode. They prove login rejection delegates to `Connection.disconnect(Component)`, configuration rejection and the caught `placeNewPlayer` exception each reach a connection disconnect, `Component` delegates to `DisconnectionDetails`, and the mixin targets that exact overload at `HEAD`. Controlled mutations that omitted pending-slot clearing or changed the injection descriptor failed the focused suites 3/3 and 1/1 respectively; restored code passed. Reject, direct disconnect, and placement-throw clearing are explicit cases.
- Fresh exact JDK 21 gate: `gradlew.bat :bridge-fabric:check :bridge-fabric:remapJar --console=plain` -> `BUILD SUCCESSFUL`; 71 tests, 0 failures, 0 errors, 3 existing Windows symbolic-link privilege skips.
- `modImplementation` remains exactly `net.fabricmc:fabric-loader:0.16.14`; JNA is supplied only by the existing Minecraft runtime compile/runtime graph and the exact JAR contract rejects any embedded `com/sun/jna/` entry.
- Two independent `:bridge-fabric:clean :bridge-fabric:remapJar` builds produced identical `whitelily-bridge-fabric-1.21.5-0.1.0.jar`: 51,344 bytes, SHA-256 `21210D1D3E44B0EDBEF06807078501097BE55F522A48E31FA941F7024D4D8A54`.
- Remaining concern: the three symbolic-link tests are privilege-skipped on this Windows account; active junction/reparse tests remain green. The only native hard-link residual identified is the §3.5-excluded continuous same-user syscall racer described above.

## Remediation round 4 evidence (2026-08-10)

- Scope: only the Task 3 JAR/lifecycle regression tests and assertion helper; the §3.5-excluded same-user final-syscall race was not changed.
- Timezone RED: with the default timezone changed to `UTC`, the unchanged compliant JAR failed the prior `JarEntry.getTime()` check (`META-INF/MANIFEST.MF` expected `315504000000`, actual `315532800000`). This proved the check depended on the JVM default timezone rather than the archive.
- Timezone GREEN: the exact contract now reads each central-directory ZIP record and requires DOS modification time `0` and DOS date `0x0021` (1980-01-01), which are timezone-neutral archive bytes. The executable UTC regression accepts the unchanged artifact and rejects an isolated raw-DOS-time mutation of `fabric.mod.json` with the precise timestamp reason.
- Inherited-lifecycle RED: the new real-bytecode test initially failed to compile because the bytecode collector had no way to expose the `disconnect(DisconnectionDetails)` invokedynamic callback target. After adding that minimal collector support, GREEN inspection proves the inherited `ServerCommonPacketListenerImpl.disconnect(Component)` calls its inherited details overload, and the details overload's real callback invokes `Connection.disconnect(DisconnectionDetails)`. This closes the configuration-rejection chain in addition to the existing direct placement-failure and login paths.
