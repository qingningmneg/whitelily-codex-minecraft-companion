# Task 3 report — secure 64×64 Minecraft skin import

## Implementation

- Replaced the legacy GLB/VRM importer with `AvatarModelImporter.importSkin`, which consumes absolute `skinSourcePath`, optional absolute `portraitSourcePath`, `displayName`, and `armModel: "slim" | "wide"` and returns a schema-validated `AvatarAppearanceRecord`.
- Added one shared PNG validation implementation. `subprojects/whitelily-avatar/tools/validate-assets.mjs` now exports the existing bounded chunk/CRC/IHDR/IDAT/inflate parser; `pngImageValidator.ts` supplies Electron-facing stable error codes and Minecraft-specific constraints. No second PNG decoder is maintained.
- Skin constraints: complete 64×64 8-bit RGBA PNG, bounded to 8 MiB source/compressed data, exact decompressed scanline length, checked filters and CRCs, and all required base UV pixels opaque.
- Portrait constraints: complete 8-bit RGBA PNG, dimensions 1×1 through 4096×4096, 8 MiB maximum source/compressed data, exact decompressed scanline length, checked filters and CRCs.
- Added deterministic local fallback preview generation from the validated skin through the shared skin-front-preview renderer. It writes `preview.png` only if `portraitSourcePath` is absent; a supplied portrait is written only as `portrait.png`.
- Added `readVerifiedAvatarFile` to the existing verified reader. It rejects direct and ancestor links/reparse points, snapshots the opened handle before/after bounded reads, rejects extra bytes/growth and metadata drift, and is used for both picker sources.
- Import order is: stable bounded read → PNG validation → digest → create exclusive staging files → create fallback preview if necessary → digest reread → directory rename to `user/<uuid>` → `catalog.appendImported`. Failed staging/rename/catalog operations remove only the owned staging or just-published directory.
- Raised catalog managed-file read bounds to 8 MiB, matching the importer’s accepted PNG limit.
- Added `AVATAR_SKIN_INVALID` and `AVATAR_PORTRAIT_INVALID` to the renderer-safe API error allowlist.

## Files changed

- `apps/desktop/src-main/avatar/pngImageValidator.ts`
- `apps/desktop/src-main/avatar/pngImageValidator.test.ts`
- `apps/desktop/src-main/avatar/avatarModelImporter.ts`
- `apps/desktop/src-main/avatar/avatarModelImporter.test.ts`
- `apps/desktop/src-main/avatar/avatarModelPaths.ts`
- `apps/desktop/src-main/avatar/verifiedAvatarResourceReader.ts`
- `apps/desktop/src-main/avatar/verifiedAvatarResourceReader.test.ts`
- `apps/desktop/src-main/avatar/avatarModelCatalog.ts`
- `apps/desktop/src-main/avatar/avatarModelCatalog.test.ts`
- `apps/desktop/src/desktopApi.ts`
- `subprojects/whitelily-avatar/tools/validate-assets.mjs`
- `subprojects/whitelily-avatar/tools/validate-assets.d.mts`

## TDD evidence

### RED

1. `npm run test --workspace @whitelily/desktop -- src-main/avatar/pngImageValidator.test.ts src-main/avatar/avatarModelImporter.test.ts`
   - Validator suite failed to resolve missing `./pngImageValidator.js`.
   - Existing GLB importer tests were red against the migrated strict appearance record.
2. After replacing the importer test with the new contract:
   `npm run test --workspace @whitelily/desktop -- src-main/avatar/pngImageValidator.test.ts src-main/avatar/avatarModelImporter.test.ts`
   - 6 importer tests failed with `TypeError: ...importSkin is not a function`.
3. `npm run test --workspace @whitelily/desktop -- src-main/avatar/verifiedAvatarResourceReader.test.ts`
   - New picker-source growth/swap test failed with `TypeError: readVerifiedAvatarFile is not a function`.
4. The new ancestor-link test then failed because the source reader resolved `Buffer[115,107,105,110]` instead of rejecting the linked path.
5. `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarModelCatalog.test.ts`
   - The 3 MiB portrait test failed with `AVATAR_MODEL_FILE_INVALID`, demonstrating the obsolete 2 MiB catalog bound.

### GREEN

`npm run test --workspace @whitelily/desktop -- src-main/avatar/pngImageValidator.test.ts src-main/avatar/avatarModelImporter.test.ts src-main/avatar/avatarModelCatalog.test.ts src-main/avatar/verifiedAvatarResourceReader.test.ts`

Output: `Test Files  4 passed (4)` and `Tests  25 passed (25)`.

`node subprojects/whitelily-avatar/tools/validate-assets.mjs`

Output: `WhiteLily native skin asset validation passed.`

`npx prettier --check ...task-3 changed files...`

Output: `All matched files use Prettier code style!`

## Security and atomicity review

- Source data is never read with unbounded `readFile`; all user-selected paths use the verified handle reader and the 8 MiB cap.
- The reader catches direct/ancestor links, file replacement metadata drift, handle changes, and appended bytes.
- The PNG parser enforces signature, legal chunk structure/order, CRC, required IHDR, contiguous IDAT, exact IEND, 8-bit RGBA, maximum dimensions, bounded decompression, exact output length, and valid filters.
- Staging output uses exclusive creates; the input digest and fallback preview digest are reread before publication. Directory rename publishes the complete set atomically before the catalog is appended.
- Cleanup is constrained to the current UUID’s owned staging/managed directory. No active appearance or catalog entry changes until `appendImported` succeeds.
- Stable external error codes are `AVATAR_SKIN_INVALID`, `AVATAR_PORTRAIT_INVALID`, `AVATAR_DIGEST_MISMATCH`, and `AVATAR_IMPORT_FAILED`.

## Self-review and concerns

- The requested Task 5 composition-level picker does not exist in this revision. Per the scope ruling, I did not invent or wire it. Task 5 must call `importSkin` only after the skin picker has returned one `.png` path, offer an explicit portrait skip path, return `{ status: "cancelled" }` for cancellation of either picker without calling the importer, and never pass renderer filesystem paths over IPC.
- `apps/desktop` typecheck remains red on pre-existing migration work outside Task 3 (legacy `AvatarBoneMapping`/`AvatarModelListItem` references in preview, IPC, and Task 5 tests). A filtered rerun confirmed no diagnostics from Task 3 files. The focused Task 3 test suite is green.
- `validate-assets.mjs` was formatted while exporting the shared routines; its executable validation passed after the change.

## Fix Round 1

### Review findings resolved

- Added a narrow main-process-only `AvatarSkinImportPicker`. It opens a skin picker with an exact `.png` filter, then requires an explicit portrait choice (`pick`, `skip`, or `cancel`). Any picker/choice cancellation returns `{ status: "cancelled" }` and does not invoke the importer. The returned source paths remain inside this main-process abstraction; Task 5 retains composition and renderer subscription wiring.
- Hardened raw source validation before `resolve`: only non-NUL absolute filesystem paths with no `.`/`..` components are accepted, and URI-like values are rejected. The verified reader now snapshots identity and canonical path before opening, verifies the opened handle, and snapshots the path again after the bounded read to detect ancestor replacement/TOCTOU changes.
- Removed replace-capable directory publication. The importer exclusively reserves `user/<uuid>` with `mkdir`, creates each managed file with `wx`, verifies final digests, and never removes a destination it did not create. A pre-existing foreign directory, including an empty one, is therefore never clobbered or cleaned up.
- Reconciled catalog append errors conservatively. Following an append failure, `catalog.has(id)` distinguishes committed, uncommitted, and unknown outcomes. Committed assets are retained and returned successfully; uncommitted assets are cleaned; uncertain outcomes retain assets so a possibly catalog-referenced resource is never deleted.

### TDD evidence

#### RED

1. `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarSkinImportPicker.test.ts`
   - Failed because `./avatarSkinImportPicker.js` did not exist.
2. `npm run test --workspace @whitelily/desktop -- src-main/avatar/verifiedAvatarResourceReader.test.ts`
   - New raw traversal/URI and ancestor-swap tests failed: traversal was normalized before validation and post-open canonical identity was not checked.
3. `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarModelImporter.test.ts`
   - The post-commit reconciliation test rejected despite a catalog entry having been appended, and the pre-existing-target test observed a replace-capable rename attempt.
4. `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarModelCatalog.test.ts`
   - The injected error after the actual catalog JSON rename did not occur while the file IO seam was ignored.
5. `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarModelImporter.test.ts`
   - The unknown catalog-outcome test found `skin.png` deleted, proving the unsafe cleanup behavior.

#### GREEN

`npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarModelImporter.test.ts`

Output: `Test Files  1 passed (1)` and `Tests  15 passed (15)`.

`npm run test --workspace @whitelily/desktop -- src-main/avatar/pngImageValidator.test.ts src-main/avatar/avatarModelImporter.test.ts src-main/avatar/avatarModelCatalog.test.ts src-main/avatar/avatarSkinImportPicker.test.ts src-main/avatar/verifiedAvatarResourceReader.test.ts`

Output: `Test Files  5 passed (5)` and `Tests  39 passed (39)`.

`node subprojects/whitelily-avatar/tools/validate-assets.mjs`

Output: `WhiteLily native skin asset validation passed.`

### Fix Round 1 self-review

- Reviewed the direct picker-to-importer workflow: only the main process obtains source paths, cancellation takes the no-import branch, and portrait omission produces the existing fallback preview path.
- Reviewed publication ownership: a UUID collision/concurrent import produces a reservation failure for one caller; only the caller that created the directory can clean it.
- Reviewed the real Atomic JSON post-rename injection path: the catalog can be durably updated even though its append throws, and importer reconciliation recognizes that committed record.
- Task 5 still owns the final IPC composition/subscription integration. This round intentionally adds the narrow picker interface without modifying stale Task 5 UI types.
