import assert from "node:assert/strict";
import test from "node:test";

import { buildAnimeAvatar } from "./build-anime-avatar.mjs";

test("refuses a Blender version other than 4.5.3", async () => {
  await assert.rejects(
    buildAnimeAvatar({ blenderVersion: "4.5.2" }),
    /BLENDER_VERSION_MISMATCH/,
  );
});
