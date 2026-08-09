import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const verifier = resolve(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "verify-installer-lifecycle-attestation.mjs",
);
const roots: string[] = [];
const productVersion = "0.2.0-beta.2";
const candidateName = `WhiteLily-${productVersion}-windows-x64-setup.exe`;
const lifecycleName = `WhiteLily-${productVersion}-windows-x64-installer-lifecycle.json`;
const baseline = {
  version: "0.2.0-beta.1",
  releaseTag: "v0.2.0-beta.1",
  assetName: "WhiteLily-0.2.0-beta.1-windows-x64-setup.exe",
  bytes: 7,
  sha256: "b".repeat(64),
};
const stages = [
  "controller_identity_verified",
  "isolated_path",
  "hashes_verified",
  "candidate_write_denied",
  "clean_installed",
  "clean_workspace_verified",
  "clean_delete_data",
  "beta1_installed",
  "beta1_data_root_prepared",
  "beta1_upgraded",
  "workspace_repaired",
  "keep_data",
  "reinstalled",
  "delete_data",
  "candidate_principal_removed",
];

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function run(root: string) {
  return spawnSync(process.execPath, [verifier, "--repo-root", root], {
    cwd: root,
    encoding: "utf8",
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture(options: { localArtifacts?: boolean } = {}): Promise<{
  root: string;
  attestationPath: string;
  lifecyclePath: string;
  candidatePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "whitelily-attestation-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, "apps", "desktop"), { recursive: true }),
    mkdir(join(root, "packaging", "electron"), { recursive: true }),
    mkdir(join(root, "docs", "release-evidence"), { recursive: true }),
    mkdir(join(root, "build", "electron-installer"), { recursive: true }),
  ]);
  await Promise.all([
    writeJson(join(root, "package.json"), { version: productVersion }),
    writeJson(join(root, "apps", "desktop", "package.json"), { version: productVersion }),
    writeJson(join(root, "packaging", "electron", "runtime-manifest.json"), {
      productVersion,
    }),
    writeJson(join(root, "packaging", "electron", "public-installer-baselines.json"), {
      schemaVersion: 1,
      baselines: [baseline],
    }),
  ]);
  const candidatePath = join(root, "build", "electron-installer", candidateName);
  const lifecyclePath = join(root, "build", "electron-installer", lifecycleName);
  const candidate = Buffer.from("fixture-candidate");
  const lifecycle = {
    schemaVersion: 2,
    success: true,
    stages,
    installerSha256: sha256(candidate),
    controllerObservedInstallerSha256: sha256(candidate),
    baselineInstallerSha256: baseline.sha256,
    controllerObservedBaselineInstallerSha256: baseline.sha256,
    controllerSid: "S-1-5-18",
    candidateReportWriteDenied: true,
    managedWorkspaceResources: 3,
  };
  const lifecycleText = `${JSON.stringify(lifecycle)}\n`;
  const attestationPath = join(
    root,
    "docs",
    "release-evidence",
    "WhiteLily-0.2.0-beta.2-installer-lifecycle.attestation.json",
  );
  await writeJson(attestationPath, {
    attestationSchemaVersion: 1,
    productVersion,
    packageSourceCommit: "d9379d5671153d0ab7aa0067125370656a7ee743",
    lifecycleValidationCommit: "0c45623fcbe7345fc9fe484a56dfb36f7cc0c68f",
    canonicalLifecyclePath: `build/electron-installer/${lifecycleName}`,
    lifecycleSha256: sha256(lifecycleText),
    hostPersistedLastWriteTimeUtc: "2026-08-09T11:50:46.5851270Z",
    candidate: {
      filename: candidateName,
      bytes: candidate.length,
      sha256: sha256(candidate),
      signature: "unsigned",
    },
    publicBaseline: {
      releaseTag: baseline.releaseTag,
      filename: baseline.assetName,
      bytes: baseline.bytes,
      sha256: baseline.sha256,
    },
    lifecycle: {
      schemaVersion: 2,
      success: true,
      stageCount: stages.length,
      stages,
      candidateSha256: sha256(candidate),
      controllerObservedCandidateSha256: sha256(candidate),
      baselineSha256: baseline.sha256,
      controllerObservedBaselineSha256: baseline.sha256,
      controllerSid: "S-1-5-18",
      candidateReportWriteDenied: true,
      managedWorkspaceResources: 3,
    },
    zeroResidue: {
      windowsSandbox: 0,
      windowsSandboxServer: 0,
      windowsSandboxRemoteSession: 0,
      sandboxMappings: 0,
    },
  });
  if (options.localArtifacts !== false) {
    await Promise.all([
      writeFile(candidatePath, candidate),
      writeFile(lifecyclePath, lifecycleText),
    ]);
    const writtenLifecycle = await readFile(lifecyclePath);
    await mutateAttestation(attestationPath, (attestation) => {
      attestation.lifecycleSha256 = sha256(writtenLifecycle);
    });
  }
  return { root, attestationPath, lifecyclePath, candidatePath };
}

async function mutateAttestation(path: string, mutate: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeJson(path, value);
}

async function mutateLifecycle(
  fixtureRoot: Awaited<ReturnType<typeof fixture>>,
  mutate: (value: Record<string, unknown>) => void,
) {
  const lifecycle = JSON.parse(await readFile(fixtureRoot.lifecyclePath, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(lifecycle);
  const text = `${JSON.stringify(lifecycle)}\n`;
  await writeFile(fixtureRoot.lifecyclePath, text, "utf8");
  await mutateAttestation(fixtureRoot.attestationPath, (attestation) => {
    attestation.lifecycleSha256 = sha256(text);
  });
}

afterAll(async () => {
  await Promise.all(
    roots.map(async (root) =>
      (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("installer lifecycle attestation verifier", () => {
  it("accepts a complete ordinary-file fixture and clean checkout fixture", async () => {
    const full = await fixture();
    const fullResult = run(full.root);
    expect(fullResult.status, `${fullResult.stdout}\n${fullResult.stderr}`).toBe(0);
    const clean = await fixture({ localArtifacts: false });
    const cleanResult = run(clean.root);
    expect(cleanResult.status, `${cleanResult.stdout}\n${cleanResult.stderr}`).toBe(0);
  });

  it("rejects non-canonical lifecycle paths", async () => {
    for (const path of [
      "C:\\Users\\example\\lifecycle.json",
      "build/electron-installer/../../package.json",
      "build/electron-installer/wrong.json",
    ]) {
      const value = await fixture({ localArtifacts: false });
      await mutateAttestation(value.attestationPath, (attestation) => {
        attestation.canonicalLifecyclePath = path;
      });
      expect(run(value.root).status).not.toBe(0);
    }
  });

  it("rejects lifecycle field mutations even when their file hash is refreshed", async () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => (value.schemaVersion = 1),
      (value) => (value.success = false),
      (value) => (value.stages = [...stages].reverse()),
      (value) => (value.installerSha256 = "0".repeat(64)),
      (value) => (value.controllerObservedInstallerSha256 = "0".repeat(64)),
      (value) => (value.baselineInstallerSha256 = "0".repeat(64)),
      (value) => (value.controllerObservedBaselineInstallerSha256 = "0".repeat(64)),
      (value) => (value.managedWorkspaceResources = 2),
      (value) => (value.controllerSid = "S-1-5-21-1"),
      (value) => (value.candidateReportWriteDenied = false),
    ];
    for (const mutate of mutations) {
      const value = await fixture();
      await mutateLifecycle(value, mutate);
      expect(run(value.root).status).not.toBe(0);
    }
  });

  it("rejects local candidate and lifecycle links when the platform permits link fixtures", async () => {
    for (const property of ["candidatePath", "lifecyclePath"] as const) {
      const value = await fixture();
      const original = value[property];
      const target = `${original}.target`;
      await rename(original, target);
      try {
        await symlink(target, original, "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      expect(run(value.root).status).not.toBe(0);
    }
  });

  it("rejects a tampered public-baseline hash without local build artifacts", async () => {
    const value = await fixture({ localArtifacts: false });
    await mutateAttestation(value.attestationPath, (attestation) => {
      (attestation.publicBaseline as Record<string, unknown>).sha256 = "0".repeat(64);
    });
    expect(run(value.root).status).not.toBe(0);
  });
});
