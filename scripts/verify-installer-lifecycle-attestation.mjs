import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

const productVersion = "0.2.0-beta.2";
const packageSourceCommit = "3df657bdbc30889aead3722edfddaff0fb3ae55d";
const lifecycleValidationCommit = "3df657bdbc30889aead3722edfddaff0fb3ae55d";
const candidateBytes = 229_360_405;
const candidateSha256 = "1a45c4e7aa4e52fc7fc73b078bd6a9ae63331c1825ead8445762ee040b09678a";
const lifecycleBytes = 1_129;
const lifecycleSha256 = "435527808c0dd101967bc8aa77a1218caec5d2dad367a1f72203418b67a79094";
const hostPersistedLastWriteTimeUtc = "2026-08-13T23:31:20.8672623Z";
const maxAttestationBytes = 32_768;
const maxJsonDepth = 32;
const maxJsonValues = 4_096;
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

function exactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length) fail(code);
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] !== required[index]) fail(code);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
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

function parseStrictJson(text, code) {
  let position = 0;
  let values = 0;
  const whitespace = /[\u0009\u000a\u000d\u0020]/u;

  function skipWhitespace() {
    while (position < text.length && whitespace.test(text[position])) position += 1;
  }

  function parseString() {
    if (text[position] !== '"') fail(code);
    const start = position;
    position += 1;
    while (position < text.length) {
      const current = text.charCodeAt(position);
      if (current === 0x22) {
        position += 1;
        try {
          return JSON.parse(text.slice(start, position));
        } catch {
          fail(code);
        }
      }
      if (current < 0x20) fail(code);
      if (current === 0x5c) {
        position += 1;
        if (position >= text.length) fail(code);
        const escape = text[position];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(position + 1, position + 5))) fail(code);
          position += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) fail(code);
      }
      position += 1;
    }
    fail(code);
  }

  function parseValue(depth) {
    values += 1;
    if (values > maxJsonValues || depth > maxJsonDepth) fail(code);
    skipWhitespace();
    const current = text[position];
    if (current === "{") {
      position += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[position] === "}") {
        position += 1;
        return;
      }
      while (position < text.length) {
        skipWhitespace();
        const key = parseString();
        const keyIdentity = key.toLowerCase();
        if (keys.has(keyIdentity)) fail(code);
        keys.add(keyIdentity);
        skipWhitespace();
        if (text[position] !== ":") fail(code);
        position += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[position] === "}") {
          position += 1;
          return;
        }
        if (text[position] !== ",") fail(code);
        position += 1;
      }
      fail(code);
    }
    if (current === "[") {
      position += 1;
      skipWhitespace();
      if (text[position] === "]") {
        position += 1;
        return;
      }
      while (position < text.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (text[position] === "]") {
          position += 1;
          return;
        }
        if (text[position] !== ",") fail(code);
        position += 1;
      }
      fail(code);
    }
    if (current === '"') {
      parseString();
      return;
    }
    const token = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/u.exec(
      text.slice(position),
    )?.[0];
    if (token === undefined) fail(code);
    position += token.length;
  }

  parseValue(0);
  skipWhitespace();
  if (position !== text.length) fail(code);
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

async function strictAttestationJson(path, code) {
  let before;
  try {
    before = await lstat(path);
    const canonical = await realpath(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > maxAttestationBytes ||
      !samePath(path, canonical)
    ) {
      fail(code);
    }
  } catch {
    fail(code);
  }
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    fail(code);
  }
  let bytes;
  let readFailed = false;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size < 1 ||
      opened.size > maxAttestationBytes ||
      opened.size !== before.size ||
      !sameIdentity(before, opened)
    ) {
      fail(code);
    }
    bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead < 1) fail(code);
      offset += bytesRead;
    }
    const eof = Buffer.allocUnsafe(1);
    const { bytesRead: eofBytesRead } = await handle.read(eof, 0, 1, null);
    if (eofBytesRead !== 0) fail(code);
    const afterHandle = await handle.stat();
    const afterPath = await lstat(path);
    const afterCanonical = await realpath(path);
    if (
      !afterHandle.isFile() ||
      afterHandle.nlink !== 1 ||
      afterHandle.size !== opened.size ||
      !sameIdentity(opened, afterHandle) ||
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      afterPath.nlink !== 1 ||
      afterPath.size !== opened.size ||
      !sameIdentity(afterHandle, afterPath) ||
      !samePath(path, afterCanonical)
    ) {
      fail(code);
    }
  } catch {
    readFailed = true;
  } finally {
    try {
      await handle.close();
    } catch {
      readFailed = true;
    }
  }
  if (readFailed || bytes === undefined) fail(code);
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail(code);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
  return parseStrictJson(text, code);
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
  exactKeys(
    value,
    [
      "attestationSchemaVersion",
      "productVersion",
      "packageSourceCommit",
      "lifecycleValidationCommit",
      "canonicalLifecyclePath",
      "lifecycleSha256",
      "hostPersistedLastWriteTimeUtc",
      "candidate",
      "publicBaseline",
      "lifecycle",
      "zeroResidue",
    ],
    "ATTESTATION_FIELDS_INVALID",
  );
  equal(value.attestationSchemaVersion, 1, "ATTESTATION_SCHEMA_INVALID");
  equal(value.productVersion, productVersion, "ATTESTATION_VERSION_INVALID");
  equal(value.packageSourceCommit, packageSourceCommit, "ATTESTATION_PACKAGE_COMMIT_INVALID");
  equal(
    value.lifecycleValidationCommit,
    lifecycleValidationCommit,
    "ATTESTATION_VALIDATION_COMMIT_INVALID",
  );
  equal(value.canonicalLifecyclePath, canonicalLifecyclePath, "ATTESTATION_LIFECYCLE_PATH_INVALID");
  equal(value.lifecycleSha256, lifecycleSha256, "ATTESTATION_LIFECYCLE_HASH_INVALID");
  equal(
    value.hostPersistedLastWriteTimeUtc,
    hostPersistedLastWriteTimeUtc,
    "ATTESTATION_TIME_INVALID",
  );
  const candidate = requiredObject(value.candidate, "ATTESTATION_CANDIDATE_INVALID");
  exactKeys(
    candidate,
    ["filename", "bytes", "sha256", "signature", "authenticodeStatus"],
    "ATTESTATION_CANDIDATE_INVALID",
  );
  equal(candidate.filename, installerName, "ATTESTATION_CANDIDATE_PATH_INVALID");
  if (!Number.isSafeInteger(candidate.bytes) || candidate.bytes <= 0)
    fail("ATTESTATION_CANDIDATE_INVALID");
  equal(candidate.bytes, candidateBytes, "ATTESTATION_CANDIDATE_INVALID");
  if (!/^[0-9a-f]{64}$/u.test(requiredString(candidate.sha256, "ATTESTATION_CANDIDATE_INVALID"))) {
    fail("ATTESTATION_CANDIDATE_INVALID");
  }
  equal(candidate.sha256, candidateSha256, "ATTESTATION_CANDIDATE_INVALID");
  equal(candidate.signature, "unsigned", "ATTESTATION_CANDIDATE_INVALID");
  equal(candidate.authenticodeStatus, "NotSigned", "ATTESTATION_CANDIDATE_INVALID");
  const publicBaseline = requiredObject(value.publicBaseline, "ATTESTATION_BASELINE_INVALID");
  exactKeys(
    publicBaseline,
    ["releaseTag", "filename", "bytes", "sha256"],
    "ATTESTATION_BASELINE_INVALID",
  );
  equal(publicBaseline.releaseTag, baseline.releaseTag, "ATTESTATION_BASELINE_INVALID");
  equal(publicBaseline.filename, baseline.assetName, "ATTESTATION_BASELINE_INVALID");
  equal(publicBaseline.bytes, baseline.bytes, "ATTESTATION_BASELINE_INVALID");
  equal(publicBaseline.sha256, baseline.sha256, "ATTESTATION_BASELINE_INVALID");
  const lifecycle = requiredObject(value.lifecycle, "ATTESTATION_LIFECYCLE_INVALID");
  exactKeys(
    lifecycle,
    [
      "schemaVersion",
      "success",
      "stageCount",
      "stages",
      "candidateSha256",
      "controllerObservedCandidateSha256",
      "baselineSha256",
      "controllerObservedBaselineSha256",
      "controllerSid",
      "candidateReportWriteDenied",
      "managedWorkspaceResources",
      "minecraftComponentResources",
      "componentPreferencesFresh",
      "componentPreferencesUpgradePreserved",
      "componentPreferencesKeepPreserved",
    ],
    "ATTESTATION_LIFECYCLE_INVALID",
  );
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
  equal(lifecycle.minecraftComponentResources, 9, "ATTESTATION_LIFECYCLE_INVALID");
  equal(lifecycle.componentPreferencesFresh, true, "ATTESTATION_LIFECYCLE_INVALID");
  equal(lifecycle.componentPreferencesUpgradePreserved, true, "ATTESTATION_LIFECYCLE_INVALID");
  equal(lifecycle.componentPreferencesKeepPreserved, true, "ATTESTATION_LIFECYCLE_INVALID");
  const residue = requiredObject(value.zeroResidue, "ATTESTATION_RESIDUE_INVALID");
  exactKeys(
    residue,
    [
      "trackedWindowsSandbox",
      "sandboxMappings",
      "sandboxRoots",
      "lifecycleHivePresent",
      "candidatePrincipalPresent",
      "remoteSessionEnumeration",
    ],
    "ATTESTATION_RESIDUE_INVALID",
  );
  equal(residue.trackedWindowsSandbox, 0, "ATTESTATION_RESIDUE_INVALID");
  equal(residue.sandboxMappings, 0, "ATTESTATION_RESIDUE_INVALID");
  equal(residue.sandboxRoots, 0, "ATTESTATION_RESIDUE_INVALID");
  equal(residue.lifecycleHivePresent, false, "ATTESTATION_RESIDUE_INVALID");
  equal(residue.candidatePrincipalPresent, false, "ATTESTATION_RESIDUE_INVALID");
  equal(residue.remoteSessionEnumeration, "not-performed", "ATTESTATION_RESIDUE_INVALID");
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
  if (lifecycleEntry.size !== lifecycleBytes) fail("LIFECYCLE_ARTIFACT_BYTES_INVALID");
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
  equal(lifecycle.minecraftComponentResources, 9, "LIFECYCLE_ARTIFACT_FIELDS_INVALID");
  equal(lifecycle.componentPreferencesFresh, true, "LIFECYCLE_ARTIFACT_FIELDS_INVALID");
  equal(lifecycle.componentPreferencesUpgradePreserved, true, "LIFECYCLE_ARTIFACT_FIELDS_INVALID");
  equal(lifecycle.componentPreferencesKeepPreserved, true, "LIFECYCLE_ARTIFACT_FIELDS_INVALID");
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
  await strictAttestationJson(relative(repoRoot, attestationPath), "ATTESTATION_REQUIRED"),
  baselines[0],
);
const localArtifactCheck = await verifyLocalArtifacts(repoRoot, attestation);
process.stdout.write(`${JSON.stringify({ productVersion, localArtifactCheck })}\n`);
