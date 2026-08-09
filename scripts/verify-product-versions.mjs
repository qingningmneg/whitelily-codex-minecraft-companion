import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const SEMANTIC_VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9][0-9]*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

async function verifyProductVersions(rootArgument) {
  if (typeof rootArgument !== "string" || rootArgument.length === 0) {
    throw new Error("PRODUCT_VERSION_ROOT_REQUIRED");
  }
  const root = resolve(rootArgument);
  const [rootPackage, desktopPackage, runtimeManifest] = await Promise.all([
    readJson(resolve(root, "package.json")),
    readJson(resolve(root, "apps", "desktop", "package.json")),
    readJson(resolve(root, "packaging", "electron", "runtime-manifest.json")),
  ]);
  const versions = [rootPackage.version, desktopPackage.version, runtimeManifest.productVersion];
  if (
    versions.some((version) => typeof version !== "string" || !SEMANTIC_VERSION.test(version)) ||
    versions.some((version) => version !== versions[0])
  ) {
    throw new Error("PRODUCT_VERSION_MISMATCH");
  }
  return versions[0];
}

async function readJson(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PRODUCT_VERSION_MISMATCH");
  }
  return value;
}

try {
  const version = await verifyProductVersions(process.argv[2]);
  process.stdout.write(`${version}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "PRODUCT_VERSION_MISMATCH"}\n`);
  process.exitCode = 1;
}

export { verifyProductVersions };
