import assert from "node:assert/strict";
import test from "node:test";

import {
  bodyHighValidationArguments,
  buildAnimeAvatar,
} from "./build-anime-avatar.mjs";

test("refuses a Blender version other than 4.5.3", async () => {
  await assert.rejects(
    buildAnimeAvatar({ blenderVersion: "4.5.2" }),
    /BLENDER_VERSION_MISMATCH/,
  );
});

test("body-high stage uses the fixed blend, contract, baseline, and review directory", () => {
  assert.deepEqual(bodyHighValidationArguments("C:\\repo"), [
    "--background",
    "--python-exit-code", "12",
    "C:\\repo\\subprojects\\whitelily-avatar\\assets\\blender\\whitelily-anime-avatar.blend",
    "--python", "C:\\repo\\subprojects\\whitelily-avatar\\tools\\blender\\validate_silhouette.py",
    "--",
    "--baseline", "C:\\repo\\subprojects\\whitelily-avatar\\assets\\measurements\\base-silhouette.json",
    "--output-dir", "C:\\repo\\subprojects\\whitelily-avatar\\assets\\review\\body-high",
  ]);
});
