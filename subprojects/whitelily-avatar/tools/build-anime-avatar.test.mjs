import assert from "node:assert/strict";
import test from "node:test";

import {
  bodyHighValidationArguments,
  buildAnimeAvatar,
  rigValidationArguments,
} from "./build-anime-avatar.mjs";

test("refuses a Blender version other than 4.5.3", async () => {
  await assert.rejects(buildAnimeAvatar({ blenderVersion: "4.5.2" }), /BLENDER_VERSION_MISMATCH/);
});

test("body-high stage uses the fixed blend, contract, baseline, and review directory", () => {
  assert.deepEqual(bodyHighValidationArguments("C:\\repo"), [
    "--background",
    "--python-exit-code",
    "12",
    "C:\\repo\\subprojects\\whitelily-avatar\\assets\\blender\\whitelily-anime-avatar.blend",
    "--python",
    "C:\\repo\\subprojects\\whitelily-avatar\\tools\\blender\\validate_silhouette.py",
    "--",
    "--baseline",
    "C:\\repo\\subprojects\\whitelily-avatar\\assets\\measurements\\base-silhouette.json",
    "--output-dir",
    "C:\\repo\\subprojects\\whitelily-avatar\\assets\\review\\body-high",
  ]);
});

test("rig stage uses the public contract and reproducible review directory", () => {
  assert.deepEqual(rigValidationArguments("C:\\repo"), [
    "--background",
    "--python-exit-code",
    "12",
    "C:\\repo\\subprojects\\whitelily-avatar\\assets\\blender\\whitelily-anime-avatar.blend",
    "--python",
    "C:\\repo\\subprojects\\whitelily-avatar\\tools\\blender\\validate_rig.py",
    "--",
    "--contract",
    "C:\\repo\\subprojects\\whitelily-avatar\\assets\\rig\\whitelily-humanoid-v1.json",
    "--output-dir",
    "C:\\repo\\subprojects\\whitelily-avatar\\build\\anime-avatar\\rig",
    "--render-previews",
  ]);
});

test("rig stage executes body-high precheck before the rig validator", async () => {
  const calls = [];
  const runCommand = async (command, arguments_) => {
    calls.push([command, arguments_]);
    return arguments_[0] === "--version" ? "Blender 4.5.3\n" : "";
  };

  await buildAnimeAvatar({
    blenderPath: "fake-blender",
    runCommand,
    stage: "rig",
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ["fake-blender", ["--version"]]);
  assert.match(calls[1][1].join(" "), /validate_avatar\.py .*--stage body-high/);
  assert.match(calls[2][1].join(" "), /validate_rig\.py .*--render-previews/);
});

test("rig stage stops before rig validation when body-high precheck fails", async () => {
  const calls = [];
  const runCommand = async (command, arguments_) => {
    calls.push([command, arguments_]);
    if (arguments_[0] === "--version") return "Blender 4.5.3\n";
    throw new Error("AVATAR_BODY_HIGH_PRECHECK_FAILED");
  };

  await assert.rejects(
    buildAnimeAvatar({
      blenderPath: "fake-blender",
      runCommand,
      stage: "rig",
    }),
    /AVATAR_BODY_HIGH_PRECHECK_FAILED/,
  );
  assert.equal(calls.length, 2);
});
