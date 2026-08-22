import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const verifier = resolve(import.meta.dirname, "..", "..", "scripts", "verify-product-versions.mjs");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("product version preparation gate", () => {
  it("accepts one exact version across root, desktop, and runtime sources", async () => {
    const root = await fixture();
    await expect(execFileAsync(process.execPath, [verifier, root])).resolves.toMatchObject({
      stdout: "0.2.0-beta.2\n",
    });
  });

  it.each([
    ["root", { root: "0.2.0-beta.3" }],
    ["desktop", { desktop: "0.2.0-beta.3" }],
    ["runtime", { runtime: "0.2.0-beta.3" }],
  ] as const)("rejects a %s version mismatch", async (_label, versions) => {
    const root = await fixture(versions);
    await expect(execFileAsync(process.execPath, [verifier, root])).rejects.toMatchObject({
      stderr: expect.stringMatching(/PRODUCT_VERSION_MISMATCH/u),
    });
  });
});

async function fixture(
  versions: { root?: string; desktop?: string; runtime?: string } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "whitelily-version-gate-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "apps", "desktop"), { recursive: true });
  await mkdir(join(root, "packaging", "electron"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ version: versions.root ?? "0.2.0-beta.2" }),
  );
  await writeFile(
    join(root, "apps", "desktop", "package.json"),
    JSON.stringify({ version: versions.desktop ?? "0.2.0-beta.2" }),
  );
  await writeFile(
    join(root, "packaging", "electron", "runtime-manifest.json"),
    JSON.stringify({ productVersion: versions.runtime ?? "0.2.0-beta.2" }),
  );
  return root;
}
