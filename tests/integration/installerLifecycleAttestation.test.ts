import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
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
const packageSourceCommit = "ff0221d75b2f3d84729bd6eaf72950c5c3afd9f7";
const lifecycleValidationCommit = "ff0221d75b2f3d84729bd6eaf72950c5c3afd9f7";
const productionLifecycleSha256 =
  "a63b4bd676c9a2f90df648db62f618021b81e685afabcb5917260e94dd741873";
const productionLifecycleTimestamp = "2026-08-11T04:34:13.0331348Z";
const maxAttestationBytes = 32_768;
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
const fixtureVerifierByRoot = new Map<string, string>();

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function run(root: string, verifierPath = fixtureVerifierByRoot.get(root) ?? verifier) {
  return spawnSync(process.execPath, [verifierPath, "--repo-root", root], {
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
    minecraftComponentResources: 9,
    componentPreferencesFresh: true,
    componentPreferencesUpgradePreserved: true,
    componentPreferencesKeepPreserved: true,
  };
  const lifecycleText = `${JSON.stringify(lifecycle)}\n`;
  const fixtureLifecycleSha256 = sha256(lifecycleText);
  const fixtureLifecycleTimestamp = "2026-08-11T00:00:00.0000000Z";
  const fixtureVerifierPath = join(root, "verify-installer-lifecycle-attestation.mjs");
  const productionVerifierSource = await readFile(verifier, "utf8");
  const fixtureVerifierSource = productionVerifierSource
    .replace(
      `const lifecycleSha256 = "${productionLifecycleSha256}";`,
      `const lifecycleSha256 = "${fixtureLifecycleSha256}";`,
    )
    .replace(
      `const hostPersistedLastWriteTimeUtc = "${productionLifecycleTimestamp}";`,
      `const hostPersistedLastWriteTimeUtc = "${fixtureLifecycleTimestamp}";`,
    );
  if (fixtureVerifierSource === productionVerifierSource) {
    throw new Error("fixture verifier pins were not replaced");
  }
  await writeFile(fixtureVerifierPath, fixtureVerifierSource, "utf8");
  fixtureVerifierByRoot.set(root, fixtureVerifierPath);
  const attestationPath = join(
    root,
    "docs",
    "release-evidence",
    "WhiteLily-0.2.0-beta.2-installer-lifecycle.attestation.json",
  );
  await writeJson(attestationPath, {
    attestationSchemaVersion: 1,
    productVersion,
    packageSourceCommit,
    lifecycleValidationCommit,
    canonicalLifecyclePath: `build/electron-installer/${lifecycleName}`,
    lifecycleSha256: fixtureLifecycleSha256,
    hostPersistedLastWriteTimeUtc: fixtureLifecycleTimestamp,
    candidate: {
      filename: candidateName,
      bytes: candidate.length,
      sha256: sha256(candidate),
      signature: "unsigned",
      authenticodeStatus: "NotSigned",
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
      minecraftComponentResources: 9,
      componentPreferencesFresh: true,
      componentPreferencesUpgradePreserved: true,
      componentPreferencesKeepPreserved: true,
    },
    zeroResidue: {
      trackedWindowsSandbox: 0,
      sandboxMappings: 0,
      sandboxRoots: 0,
      lifecycleHivePresent: false,
      candidatePrincipalPresent: false,
      remoteSessionEnumeration: "not-performed",
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
  const fixtureVerifierPath = fixtureVerifierByRoot.get(fixtureRoot.root);
  if (fixtureVerifierPath === undefined) throw new Error("fixture verifier missing");
  const verifierSource = await readFile(fixtureVerifierPath, "utf8");
  const updatedVerifierSource = verifierSource.replace(
    /const lifecycleSha256 = "[0-9a-f]{64}";/u,
    `const lifecycleSha256 = "${sha256(text)}";`,
  );
  if (updatedVerifierSource === verifierSource)
    throw new Error("fixture verifier hash not updated");
  await writeFile(fixtureVerifierPath, updatedVerifierSource, "utf8");
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

  it("rejects exact lifecycle hash and timestamp drift without local artifacts", async () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => (value.lifecycleSha256 = "c".repeat(64)),
      (value) => (value.hostPersistedLastWriteTimeUtc = "2026-08-11T04:34:13.0331349Z"),
    ];
    for (const mutate of mutations) {
      const value = await fixture({ localArtifacts: false });
      await mutateAttestation(value.attestationPath, (attestation) => {
        attestation.lifecycleSha256 = productionLifecycleSha256;
        attestation.hostPersistedLastWriteTimeUtc = productionLifecycleTimestamp;
        mutate(attestation);
      });
      expect(run(value.root, verifier).status).not.toBe(0);
    }
  });

  it("rejects top-level and nested duplicate evidence keys in either order", async () => {
    for (const duplicate of [
      "top-valid-invalid",
      "top-invalid-valid",
      "nested-valid-invalid",
      "nested-invalid-valid",
    ]) {
      const value = await fixture({ localArtifacts: false });
      const attestation = JSON.parse(await readFile(value.attestationPath, "utf8")) as Record<
        string,
        unknown
      >;
      const compact = JSON.stringify(attestation);
      const validResidue = JSON.stringify(attestation.zeroResidue);
      const invalidResidue = JSON.stringify({
        ...(attestation.zeroResidue as Record<string, unknown>),
        sandboxMappings: 1,
      });
      let raw;
      if (duplicate === "top-valid-invalid") {
        raw = compact.replace(
          `"zeroResidue":${validResidue}`,
          `"zeroResidue":${validResidue},"zeroResidue":${invalidResidue}`,
        );
      } else if (duplicate === "top-invalid-valid") {
        raw = compact.replace(
          `"zeroResidue":${validResidue}`,
          `"zeroResidue":${invalidResidue},"zeroResidue":${validResidue}`,
        );
      } else if (duplicate === "nested-valid-invalid") {
        raw = compact.replace('"sandboxMappings":0', '"sandboxMappings":0,"sandboxMappings":1');
      } else {
        raw = compact.replace('"sandboxMappings":0', '"sandboxMappings":1,"sandboxMappings":0');
      }
      expect(raw).not.toBe(compact);
      await writeFile(value.attestationPath, `${raw}\n`, "utf8");
      expect(run(value.root).status).not.toBe(0);
    }
  });

  it("uses one bounded file handle instead of allocating an unbounded attestation", async () => {
    const source = await readFile(verifier, "utf8");
    const start = source.indexOf("async function strictAttestationJson");
    const end = source.indexOf("\nasync function ordinaryFile", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const strictReader = source.slice(start, end);
    expect(strictReader).not.toContain("readFile(path)");
    expect(strictReader).toContain('await open(path, "r")');
    expect(strictReader).toContain("await handle.stat()");
    expect(strictReader).toContain("await handle.read(");
    expect(strictReader).toContain("before.size > maxAttestationBytes");
    expect(strictReader).toContain("opened.size > maxAttestationBytes");
    expect(strictReader).toContain("await handle.read(eof, 0, 1, null)");
    expect(strictReader).toContain("eofBytesRead !== 0");
    expect(strictReader.indexOf("await handle.stat()")).toBeLessThan(
      strictReader.indexOf("Buffer.allocUnsafe"),
    );
  });

  it("enforces the attestation byte, encoding, depth, value, and EOF boundaries", async () => {
    const exact = await fixture({ localArtifacts: false });
    const compact = JSON.stringify(JSON.parse(await readFile(exact.attestationPath, "utf8")));
    const compactBytes = Buffer.from(compact, "utf8");
    expect(compactBytes.length).toBeLessThan(maxAttestationBytes);
    await writeFile(
      exact.attestationPath,
      Buffer.concat([compactBytes, Buffer.alloc(maxAttestationBytes - compactBytes.length, 0x20)]),
    );
    const exactResult = run(exact.root);
    expect(exactResult.status, `${exactResult.stdout}\n${exactResult.stderr}`).toBe(0);

    const invalidCases: Array<{
      name: string;
      bytes?: Buffer;
      sparseBytes?: number;
    }> = [
      { name: "empty", bytes: Buffer.alloc(0) },
      {
        name: "max-plus-one",
        bytes: Buffer.concat([
          compactBytes,
          Buffer.alloc(maxAttestationBytes + 1 - compactBytes.length, 0x20),
        ]),
      },
      { name: "large-sparse", sparseBytes: maxAttestationBytes * 1024 },
      { name: "bom", bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), compactBytes]) },
      { name: "invalid-utf8", bytes: Buffer.concat([Buffer.from([0xc3, 0x28]), compactBytes]) },
      { name: "depth-33", bytes: Buffer.from(`${"[".repeat(33)}0${"]".repeat(33)}`) },
      { name: "values-4097", bytes: Buffer.from(`[${Array(4_097).fill("null").join(",")}]`) },
      { name: "truncated", bytes: compactBytes.subarray(0, compactBytes.length - 1) },
      { name: "extra-byte", bytes: Buffer.concat([compactBytes, Buffer.from("x")]) },
    ];
    for (const invalid of invalidCases) {
      const value = await fixture({ localArtifacts: false });
      if (invalid.sparseBytes !== undefined) {
        await writeFile(value.attestationPath, Buffer.alloc(0));
        await truncate(value.attestationPath, invalid.sparseBytes);
      } else {
        await writeFile(value.attestationPath, invalid.bytes as Buffer);
      }
      const result = run(value.root);
      expect(result.status, `${invalid.name}\n${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("ATTESTATION_REQUIRED");
    }
  });

  it("keeps all attestation read requests within max plus one", async () => {
    for (const mode of ["exact", "large-sparse"]) {
      const value = await fixture({ localArtifacts: false });
      const fixtureVerifier = fixtureVerifierByRoot.get(value.root);
      if (fixtureVerifier === undefined) throw new Error("fixture verifier missing");
      const source = await readFile(fixtureVerifier, "utf8");
      const instrumented = source.replace(
        'handle = await open(path, "r");',
        [
          'const rawHandle = await open(path, "r");',
          "let requestedAttestationBytes = 0;",
          "handle = {",
          "  stat: (...args) => rawHandle.stat(...args),",
          "  close: (...args) => rawHandle.close(...args),",
          "  read: (buffer, offset, length, position) => {",
          "    requestedAttestationBytes += length;",
          "    if (requestedAttestationBytes > maxAttestationBytes + 1) throw new Error('ATTESTATION_READ_BUDGET_EXCEEDED');",
          "    return rawHandle.read(buffer, offset, length, position);",
          "  },",
          "};",
        ].join("\n"),
      );
      expect(instrumented).not.toBe(source);
      await writeFile(fixtureVerifier, instrumented, "utf8");
      if (mode === "exact") {
        const compact = JSON.stringify(JSON.parse(await readFile(value.attestationPath, "utf8")));
        const bytes = Buffer.from(compact, "utf8");
        await writeFile(
          value.attestationPath,
          Buffer.concat([bytes, Buffer.alloc(maxAttestationBytes - bytes.length, 0x20)]),
        );
      } else {
        await writeFile(value.attestationPath, Buffer.alloc(0));
        await truncate(value.attestationPath, maxAttestationBytes * 1024);
      }
      const result = run(value.root);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(
        "ATTESTATION_READ_BUDGET_EXCEEDED",
      );
      expect(result.status).toBe(mode === "exact" ? 0 : 1);
    }
  });

  it("rejects hard-linked and symbolic-link attestation leaves", async () => {
    const hardlink = await fixture({ localArtifacts: false });
    const hardlinkTarget = `${hardlink.attestationPath}.target`;
    await rename(hardlink.attestationPath, hardlinkTarget);
    await link(hardlinkTarget, hardlink.attestationPath);
    expect(run(hardlink.root).status).not.toBe(0);
    await expect(readFile(hardlinkTarget, "utf8")).resolves.toContain(packageSourceCommit);

    const symbolic = await fixture({ localArtifacts: false });
    const symbolicTarget = `${symbolic.attestationPath}.target`;
    await rename(symbolic.attestationPath, symbolicTarget);
    try {
      await symlink(symbolicTarget, symbolic.attestationPath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(run(symbolic.root).status).not.toBe(0);
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
      (value) => (value.minecraftComponentResources = 8),
      (value) => (value.componentPreferencesFresh = false),
      (value) => (value.componentPreferencesUpgradePreserved = false),
      (value) => (value.componentPreferencesKeepPreserved = false),
      (value) => (value.controllerSid = "S-1-5-21-1"),
      (value) => (value.candidateReportWriteDenied = false),
    ];
    for (const mutate of mutations) {
      const value = await fixture();
      await mutateLifecycle(value, mutate);
      expect(run(value.root).status).not.toBe(0);
    }
  });

  it("rejects public component, signature, and residue mutations", async () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => ((value.candidate as Record<string, unknown>).authenticodeStatus = "UnknownError"),
      (value) => ((value.lifecycle as Record<string, unknown>).minecraftComponentResources = 8),
      (value) => ((value.lifecycle as Record<string, unknown>).componentPreferencesFresh = false),
      (value) =>
        ((value.lifecycle as Record<string, unknown>).componentPreferencesUpgradePreserved = false),
      (value) =>
        ((value.lifecycle as Record<string, unknown>).componentPreferencesKeepPreserved = false),
      (value) => ((value.zeroResidue as Record<string, unknown>).trackedWindowsSandbox = 1),
      (value) => ((value.zeroResidue as Record<string, unknown>).sandboxMappings = 1),
      (value) => ((value.zeroResidue as Record<string, unknown>).sandboxRoots = 1),
      (value) => ((value.zeroResidue as Record<string, unknown>).lifecycleHivePresent = true),
      (value) => ((value.zeroResidue as Record<string, unknown>).candidatePrincipalPresent = true),
      (value) =>
        ((value.zeroResidue as Record<string, unknown>).remoteSessionEnumeration = "performed"),
      (value) => ((value.zeroResidue as Record<string, unknown>).windowsSandboxRemoteSession = 0),
      (value) => ((value.lifecycle as Record<string, unknown>).unreviewedField = true),
    ];
    for (const mutate of mutations) {
      const value = await fixture({ localArtifacts: false });
      await mutateAttestation(value.attestationPath, mutate);
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
