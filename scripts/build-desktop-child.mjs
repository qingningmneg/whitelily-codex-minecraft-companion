import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configuredOutput = process.env.WHITELILY_DESKTOP_CHILD_OUT_DIR;
const outputRoot = configuredOutput ?? join(repositoryRoot, "dist");

if (!isAbsolute(outputRoot)) {
  throw new Error("desktop child output root must be absolute");
}

const tscEntry = resolve(dirname(require.resolve("typescript")), "..", "bin", "tsc");
await run(process.execPath, [
  tscEntry,
  "-p",
  join(repositoryRoot, "tsconfig.desktop-child.json"),
  "--outDir",
  outputRoot,
]);
await access(join(outputRoot, "src", "desktop", "childMain.js"));

function run(executable, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`desktop child build failed (${code ?? signal ?? "unknown"})`));
    });
  });
}
