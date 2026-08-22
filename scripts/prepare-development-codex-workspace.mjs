import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManagedWorkspace } from "./build-codex-workspace.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEVELOPMENT_WORKSPACE_PATH = join("build", "desktop-development", "codex-workspace");

async function prepareDevelopmentCodexWorkspace(rootArgument = repositoryRoot) {
  const root = resolve(rootArgument);
  const source = join(root, "codex-workspace");
  const target = join(root, DEVELOPMENT_WORKSPACE_PATH);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".codex-workspace-staging-"));
  const backup = join(parent, ".codex-workspace-previous");
  let targetMoved = false;
  try {
    await buildManagedWorkspace(source, staging);
    await rm(backup, { recursive: true, force: true });
    try {
      await rename(target, backup);
      targetMoved = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (targetMoved) await rename(backup, target).catch(() => undefined);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function isNotFound(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    await prepareDevelopmentCodexWorkspace();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "development workspace build failed"}\n`,
    );
    process.exitCode = 1;
  }
}

export { DEVELOPMENT_WORKSPACE_PATH, prepareDevelopmentCodexWorkspace };
