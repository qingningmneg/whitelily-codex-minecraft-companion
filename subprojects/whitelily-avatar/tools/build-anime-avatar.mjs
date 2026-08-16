import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_BLENDER_VERSION = "4.5.3";
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const avatarRoot = path.resolve(toolDirectory, "..");
const blenderTools = path.join(toolDirectory, "blender");
const sourceRoot = path.join(avatarRoot, "assets", "source");
const blendFile = path.join(avatarRoot, "assets", "blender", "whitelily-anime-avatar.blend");
const generatedDirectory = path.join(avatarRoot, "build", "anime-avatar");

function buildError(code) {
  return new Error(code);
}

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, arguments_, { shell: false, windowsHide: true });
    let output = "";
    process.stdout.on("data", (chunk) => {
      output += chunk;
    });
    process.stderr.on("data", (chunk) => {
      output += chunk;
    });
    process.on("error", () => reject(buildError("BLENDER_EXECUTABLE_NOT_FOUND")));
    process.on("close", (code) => {
      if (code === 0) resolve(output);
      else {
        const match = output.match(/\b(?:AVATAR|BLENDER)_[A-Z_]+\b/);
        reject(buildError(match?.[0] ?? "AVATAR_BLENDER_COMMAND_FAILED"));
      }
    });
  });
}

export async function buildAnimeAvatar({
  blenderVersion,
  blenderPath,
  outputDirectory,
  renderPreviews = false,
  verifyOnly = false,
} = {}) {
  if (blenderVersion !== undefined && blenderVersion !== REQUIRED_BLENDER_VERSION) {
    throw buildError("BLENDER_VERSION_MISMATCH");
  }
  if (verifyOnly) return { version: REQUIRED_BLENDER_VERSION };
  const executable = blenderPath ?? process.env.WHITELILY_BLENDER_PATH ?? process.env.BLENDER_PATH ?? "blender";
  const versionOutput = await run(executable, ["--version"]);
  if (!new RegExp(`^Blender ${REQUIRED_BLENDER_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`, "m").test(versionOutput)) {
    throw buildError("BLENDER_VERSION_MISMATCH");
  }
  await run(executable, [
    "--background",
    "--python-exit-code", "12",
    blendFile,
    "--python", path.join(blenderTools, "validate_avatar.py"),
    "--", "--source-root", sourceRoot,
  ]);
  if (outputDirectory) {
    await run(executable, [
      "--background",
      "--python-exit-code", "12",
      blendFile,
      "--python", path.join(blenderTools, "validate_avatar.py"),
      "--", "--source-root", sourceRoot,
      "--output-dir", outputDirectory,
      ...(renderPreviews ? ["--render-previews"] : []),
    ]);
  }
  return { version: REQUIRED_BLENDER_VERSION, executable };
}

async function publishBootstrapMarker() {
  const generatedParent = path.dirname(generatedDirectory);
  await mkdir(generatedParent, { recursive: true });
  const stage = await mkdtemp(path.join(generatedParent, ".anime-avatar-stage-"));
  const previous = path.join(
    generatedParent,
    `.anime-avatar-previous-${process.pid}-${Date.now()}`,
  );
  let movedCurrent = false;
  try {
    await buildAnimeAvatar({ outputDirectory: stage, renderPreviews: true });
    await writeFile(path.join(stage, "build.json"), JSON.stringify({ artStage: "bootstrap", publishable: false }, null, 2) + "\n", "utf8");
    try {
      await rename(generatedDirectory, previous);
      movedCurrent = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(stage, generatedDirectory);
  } catch (error) {
    if (movedCurrent) await rename(previous, generatedDirectory);
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  if (movedCurrent) await rm(previous, { recursive: true, force: true });
}

async function main() {
  const arguments_ = new Set(process.argv.slice(2));
  const verify = arguments_.has("--verify");
  const exportRequested = arguments_.has("--export");
  const previewsRequested = arguments_.has("--render-previews");
  if (!verify && !exportRequested && !previewsRequested) throw buildError("AVATAR_BUILD_ARGUMENTS_INVALID");
  if (exportRequested || previewsRequested) await publishBootstrapMarker();
  else await buildAnimeAvatar();
  console.log("AVATAR_ART_STAGE=bootstrap");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
