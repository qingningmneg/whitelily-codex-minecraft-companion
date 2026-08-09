import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const productVersion = "0.2.0-beta.2";
const packageSourceCommit = "d9379d5671153d0ab7aa0067125370656a7ee743";
const lifecycleValidationCommit = "0c45623fcbe7345fc9fe484a56dfb36f7cc0c68f";
const installerName = `WhiteLily-${productVersion}-windows-x64-setup.exe`;
const lifecycleName = `WhiteLily-${productVersion}-windows-x64-installer-lifecycle.json`;
const canonicalLifecyclePath = `build/electron-installer/${lifecycleName}`;
const canonicalCandidatePath = `build/electron-installer/${installerName}`;
const attestationPath =
  "docs/release-evidence/WhiteLily-0.2.0-beta.2-installer-lifecycle.attestation.json";
const baselineVersion = "0.2.0-beta.1";
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

function fail(code) {
  throw new Error(code);
}

function requiredObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function requiredString(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

function equal(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function exactStages(actual, code) {
  if (!Array.isArray(actual) || actual.length !== stages.length) fail(code);
  for (let index = 0; index < stages.length; index += 1) {
    if (actual[index] !== stages[index]) fail(code);
  }
}

async function json(path, code) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(code);
  }
}

async function ordinaryFile(path, code) {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail(code);
  }
  if (!entry.isFile() || entry.isSymbolicLink()) fail(code);
  return entry;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function relative(root, path) {
  const expected = resolve(root, path);
  if (!expected.startsWith(`${root}\\`) && !expected.startsWith(`${root}/`)) {
    fail("ATTESTATION_PATH_ESCAPE");
  }
  return expected;
}

function checkAttestation(attestation, baseline) {
  const value = requiredObject(attestation, "ATTESTATION_OBJECT_REQUIRED");
  equal(value.attestationSchemaVersion, 1, "ATTESTATION_SCHEMA_INVALID");
  equal(value.productVersion, productVersion, "ATTESTATION_VERSION_INVALID");
  equal(value.packageSourceCommit, packageSourceCommit, "ATTESTATION_PACKAGE_COMMIT_INVALID");
  equal(
    value.lifecycleValidationCommit,
    lifecycleValidationCommit,
    "ATTESTATION_VALIDATION_COMMIT_INVALID",
  );
  equal(value.canonicalLifecyclePath, canonicalLifecyclePath, "ATTESTATION_LIFECYCLE_PATH_INVALID");
  if (
    !/^[0-9a-f]{64}$/u.test(
      requiredString(value.lifecycleSha256, "ATTESTATION_LIFECYCLE_HASH_INVALID"),
    )
  ) {
    fail("ATTESTATION_LIFECYCLE_HASH_INVALID");
  }
  if (
    Number.isNaN(
      Date.parse(requiredString(value.hostPersistedLastWriteTimeUtc, "ATTESTATION_TIME_INVALID")),
    )
  ) {
    fail("ATTESTATION_TIME_INVALID");
  }
  const candidate = requiredObject(value.candidate, "ATTESTATION_CANDIDATE_INVALID");
  equal(candidate.filename, installerName, "ATTESTATION_CANDIDATE_PATH_INVALID");
  if (!Number.isSafeInteger(candidate.bytes) || candidate.bytes <= 0)
    fail("ATTESTATION_CANDIDATE_INVALID");
  if (!/^[0-9a-f]{64}$/u.test(requiredString(candidate.sha256, "ATTESTATION_CANDIDATE_INVALID"))) {
    fail("ATTESTATION_CANDIDATE_INVALID");
  }
  equal(candidate.signature, "unsigned", "ATTESTATION_CANDIDATE_INVALID");
  const publicBaseline = requiredObject(value.publicBaseline, "ATTESTATION_BASELINE_INVALID");
  equal(publicBaseline.releaseTag, baseline.releaseTag, "ATTESTATION_BASELINE_INVALID");
  equal(publicBaseline.filename, baseline.assetName, "ATTESTATION_BASELINE_INVALID");
  equal(publicBaseline.bytes, baseline.bytes, "ATTESTATION_BASELINE_INVALID");
  equal(publicBaseline.sha256, baseline.sha256, "ATTESTATION_BASELINE_INVALID");
  const lifecycle = requiredObject(value.lifecycle, "ATTESTATION_LIFECYCLE_INVALID");
  equal(lifecycle.schemaVersion, 2, "ATTESTATION_LIFECYCLE_INVALID");
  equal(lifecycle.success, true, "ATTESTATION_LIFECYCLE_INVALID");
  equal(lifecycle.stageCount, stages.length, "ATTESTATION_LIFECYCLE_INVALID");
  exactStages(lifecycle.stages, "ATTESTATION_LIFECYCLE_INVALID");
  equal(lifecycle.candidateSha256, candidate.sha256, "ATTESTATION_LIFECYCLE_INVALID");
  equal(
    lifecycle.controllerObservedCandidateSha256,
    candidate.sha256,
    "ATTESTATION_LIFECYCLE_INVALID",
  );
  equal(lifecycle.baselineSha256, baseline.sha256, "ATTESTATION_LIFECYCLE_INVALID");
  equal(
    lifecycle.controllerObservedBaselineSha256,
    baseline.sha256,
    "ATTESTATION_LIFECYCLE_INVALID",
  );
  equal(lifecycle.controllerSid, "S-1-5-18", "ATTESTATION_LIFECYCLE_INVALID");
  equal(lifecycle.candidateReportWriteDenied, true, "ATTESTATION_LIFECYCLE_INVALID");
  equal(lifecycle.managedWorkspaceResources, 3, "ATTESTATION_LIFECYCLE_INVALID");
  const residue = requiredObject(value.zeroResidue, "ATTESTATION_RESIDUE_INVALID");
  for (const field of [
    "windowsSandbox",
    "windowsSandboxServer",
    "windowsSandboxRemoteSession",
    "sandboxMappings",
  ]) {
    equal(residue[field], 0, "ATTESTATION_RESIDUE_INVALID");
  }
  const serialized = JSON.stringify(value);
  if (
    /candidate(?:Sid|User|Username)|\b(?:pid|processId)\b|S-1-5-21-|[A-Z]:\\|\/Users\//iu.test(
      serialized,
    )
  ) {
    fail("ATTESTATION_PRIVACY_INVALID");
  }
  return value;
}

async function verifyLocalArtifacts(root, attestation) {
  const lifecyclePath = relative(root, canonicalLifecyclePath);
  const candidatePath = relative(root, canonicalCandidatePath);
  const [lifecycleEntry, candidateEntry] = await Promise.all([
    ordinaryFile(lifecyclePath, "LIFECYCLE_ARTIFACT_INVALID"),
    ordinaryFile(candidatePath, "CANDIDATE_ARTIFACT_INVALID"),
  ]);
  if (!lifecycleEntry && !candidateEntry) return "skipped";
  if (!lifecycleEntry || !candidateEntry) fail("LOCAL_ARTIFACT_PAIR_REQUIRED");
  if (candidateEntry.size !== attestation.candidate.bytes) fail("CANDIDATE_ARTIFACT_BYTES_INVALID");
  if ((await sha256File(candidatePath)) !== attestation.candidate.sha256)
    fail("CANDIDATE_ARTIFACT_HASH_INVALID");
  if ((await sha256File(lifecyclePath)) !== attestation.lifecycleSha256)
    fail("LIFECYCLE_ARTIFACT_HASH_INVALID");
  const lifecycle = requiredObject(
    await json(lifecyclePath, "LIFECYCLE_ARTIFACT_JSON_INVALID"),
    "LIFECYCLE_ARTIFACT_JSON_INVALID",
  );
  equal(lifecycle.schemaVersion, 2, "LIFECYCLE_ARTIFACT_FIELDS_INVALID");
  equal(lifecycle.success, true, "LIFECYCLE_ARTIFACT_FIELDS_INVALID");
  exactStages(lifecycle.stages, "LIFECYCLE_ARTIFACT_FIELDS_INVALID");
  equal(
    lifecycle.installerSha256,
    attestation.candidate.sha256,
    "LIFECYCLE_ARTIFACT_FIELDS_INVALID",
  );
  equal(
    lifecycle.controllerObservedInstallerSha256,
    attestation.candidate.sha256,
    "LIFECYCLE_ARTIFACT_FIELDS_INVALID",
  );
  equal(
    lifecycle.baselineInstallerSha256,
    attestation.publicBaseline.sha256,
    "LIFECYCLE_ARTIFACT_FIELDS_INVALID",
  );
  equal(
    lifecycle.controllerObservedBaselineInstallerSha256,
    attestation.publicBaseline.sha256,
    "LIFECYCLE_ARTIFACT_FIELDS_INVALID",
  );
  equal(lifecycle.controllerSid, "S-1-5-18", "LIFECYCLE_ARTIFACT_FIELDS_INVALID");
  equal(lifecycle.candidateReportWriteDenied, true, "LIFECYCLE_ARTIFACT_FIELDS_INVALID");
  equal(lifecycle.managedWorkspaceResources, 3, "LIFECYCLE_ARTIFACT_FIELDS_INVALID");
  return "verified";
}

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--repo-root");
if (rootIndex < 0 || rootIndex + 1 !== args.length - 1) fail("REPO_ROOT_REQUIRED");
const repoRoot = resolve(args[rootIndex + 1]);
const rootPackage = await json(relative(repoRoot, "package.json"), "ROOT_PACKAGE_REQUIRED");
const desktopPackage = await json(
  relative(repoRoot, "apps/desktop/package.json"),
  "DESKTOP_PACKAGE_REQUIRED",
);
const runtimeManifest = await json(
  relative(repoRoot, "packaging/electron/runtime-manifest.json"),
  "RUNTIME_MANIFEST_REQUIRED",
);
equal(rootPackage.version, productVersion, "PRODUCT_VERSION_INVALID");
equal(desktopPackage.version, productVersion, "PRODUCT_VERSION_INVALID");
equal(runtimeManifest.productVersion, productVersion, "PRODUCT_VERSION_INVALID");
const baselineContract = requiredObject(
  await json(
    relative(repoRoot, "packaging/electron/public-installer-baselines.json"),
    "BASELINE_CONTRACT_REQUIRED",
  ),
  "BASELINE_CONTRACT_REQUIRED",
);
if (baselineContract.schemaVersion !== 1 || !Array.isArray(baselineContract.baselines))
  fail("BASELINE_CONTRACT_INVALID");
const baselines = baselineContract.baselines.filter((entry) => entry?.version === baselineVersion);
if (baselines.length !== 1) fail("BASELINE_CONTRACT_INVALID");
const attestation = checkAttestation(
  await json(relative(repoRoot, attestationPath), "ATTESTATION_REQUIRED"),
  baselines[0],
);
const localArtifactCheck = await verifyLocalArtifacts(repoRoot, attestation);
process.stdout.write(`${JSON.stringify({ productVersion, localArtifactCheck })}\n`);
