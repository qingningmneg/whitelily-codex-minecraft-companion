import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FAILURE = "component staging failed";
const CLEANUP_SCHEMA = 2;
const MAX_CLEANUP_JOURNALS = 8;
const MAX_CLEANUP_JOURNAL_BYTES = 64 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 180 &&
    basename(name) === name &&
    name !== "." &&
    name !== ".."
  );
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function ordinaryDirectory(path) {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(FAILURE);
  return stats;
}

async function assertDirectoryIdentity(path, expected) {
  const current = await ordinaryDirectory(path);
  if (!sameIdentity(current, expected)) throw new Error(FAILURE);
}

async function removePreparedEmptyDestination(path, parent, parentIdentity) {
  const before = await ordinaryDirectory(path);
  if ((await readdir(path)).length !== 0) throw new Error(FAILURE);
  await assertDirectoryIdentity(parent, parentIdentity);
  await assertDirectoryIdentity(path, before);
  await rmdir(path);
  await assertDirectoryIdentity(parent, parentIdentity);
}

async function ensureOrdinaryParent(path) {
  try {
    return await ordinaryDirectory(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const grandparent = dirname(path);
  const grandparentIdentity = await ordinaryDirectory(grandparent);
  await mkdir(path);
  await assertDirectoryIdentity(grandparent, grandparentIdentity);
  return ordinaryDirectory(path);
}

async function ordinaryFile(path) {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(FAILURE);
  return stats;
}

async function readVerifiedSource(file, expectedIdentity) {
  if (typeof file.contentBase64 === "string") {
    if (file.source !== undefined || expectedIdentity !== undefined) throw new Error(FAILURE);
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (bytes.toString("base64") !== file.contentBase64) throw new Error(FAILURE);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(FAILURE);
    return { bytes, identity: undefined };
  }
  const before = await ordinaryFile(file.source);
  if (expectedIdentity && !sameIdentity(before, expectedIdentity)) throw new Error(FAILURE);
  const handle = await open(file.source, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) throw new Error(FAILURE);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await ordinaryFile(file.source);
    if (!sameIdentity(opened, after) || !sameIdentity(after, pathAfter)) throw new Error(FAILURE);
    if (
      bytes.length !== file.bytes ||
      sha256(bytes) !== file.sha256 ||
      (expectedIdentity && !sameIdentity(pathAfter, expectedIdentity))
    ) {
      throw new Error(FAILURE);
    }
    return { bytes, identity: pathAfter };
  } finally {
    await handle.close();
  }
}

async function inspectExactPack(directory, expectedNames, expectedFiles) {
  const directoryIdentity = await ordinaryDirectory(directory);
  const names = (await readdir(directory)).sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(FAILURE);
  }
  const files = new Map();
  for (const name of names) {
    const path = join(directory, name);
    const stats = await ordinaryFile(path);
    const handle = await open(path, "r");
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameIdentity(stats, opened)) throw new Error(FAILURE);
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      const pathAfter = await ordinaryFile(path);
      if (!sameIdentity(opened, after) || !sameIdentity(after, pathAfter)) {
        throw new Error(FAILURE);
      }
      const expected = expectedFiles?.get(name);
      if (expected) {
        const expectedLength = Buffer.isBuffer(expected.bytes)
          ? expected.bytes.length
          : expected.bytes;
        if (bytes.length !== expectedLength || sha256(bytes) !== expected.hash) {
          throw new Error(FAILURE);
        }
      }
      files.set(name, { identity: pathAfter, hash: sha256(bytes), bytes });
    } finally {
      await handle.close();
    }
  }
  const directoryAfter = await ordinaryDirectory(directory);
  if (!sameIdentity(directoryIdentity, directoryAfter)) throw new Error(FAILURE);
  return { directoryIdentity, files };
}

async function assertSnapshot(directory, snapshot, expectedNames) {
  const current = await inspectExactPack(directory, expectedNames);
  if (!sameIdentity(current.directoryIdentity, snapshot.directoryIdentity))
    throw new Error(FAILURE);
  for (const name of expectedNames) {
    const before = snapshot.files.get(name);
    const after = current.files.get(name);
    if (!sameIdentity(before.identity, after.identity) || before.hash !== after.hash) {
      throw new Error(FAILURE);
    }
  }
}

async function removeOwnedDirectory(directory, directoryIdentity, ownedFiles) {
  const currentDirectory = await ordinaryDirectory(directory);
  if (!sameIdentity(currentDirectory, directoryIdentity)) throw new Error(FAILURE);
  const names = (await readdir(directory)).sort();
  const expectedNames = [...ownedFiles.keys()].sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(FAILURE);
  }
  for (const name of expectedNames) {
    const path = join(directory, name);
    const expected = ownedFiles.get(name);
    const current = await ordinaryFile(path);
    if (!sameIdentity(current, expected.identity)) throw new Error(FAILURE);
    await unlink(path);
  }
  const after = await ordinaryDirectory(directory);
  if (!sameIdentity(after, directoryIdentity) || (await readdir(directory)).length !== 0) {
    throw new Error(FAILURE);
  }
  await rmdir(directory);
}

function identityDocument(identity) {
  return { dev: identity.dev.toString(), ino: identity.ino.toString() };
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function normalizedIdentity(value) {
  if (
    !exactKeys(value, ["dev", "ino"]) ||
    typeof value.dev !== "string" ||
    typeof value.ino !== "string" ||
    !/^[0-9]{1,32}$/.test(value.dev) ||
    !/^[0-9]{1,32}$/.test(value.ino)
  ) {
    throw new Error(FAILURE);
  }
  return {
    document: { dev: value.dev, ino: value.ino },
    identity: { dev: BigInt(value.dev), ino: BigInt(value.ino) },
  };
}

function snapshotFilesDocument(snapshot) {
  return [...snapshot.files]
    .sort(([left], [right]) => compareNames(left, right))
    .map(([name, file]) => ({
      name,
      dev: file.identity.dev.toString(),
      ino: file.identity.ino.toString(),
      bytes: Buffer.isBuffer(file.bytes) ? file.bytes.length : file.bytes,
      sha256: file.hash,
    }));
}

function snapshotRecord(snapshot) {
  return {
    directoryIdentity: snapshot.directoryIdentity,
    files: new Map(
      [...snapshot.files].map(([name, file]) => [
        name,
        {
          identity: file.identity,
          bytes: Buffer.isBuffer(file.bytes) ? file.bytes.length : file.bytes,
          hash: file.hash,
        },
      ]),
    ),
  };
}

function cleanupJournalDocument(
  base,
  transactionId,
  backup,
  candidate,
  journalIdentity,
  previous,
  created,
) {
  return {
    schema: CLEANUP_SCHEMA,
    transactionId,
    destination: base,
    backup: basename(backup),
    candidate: basename(candidate),
    journal: identityDocument(journalIdentity),
    previousDirectory: identityDocument(previous.directoryIdentity),
    previousFiles: snapshotFilesDocument(previous),
    candidateDirectory: identityDocument(created.directoryIdentity),
    candidateFiles: snapshotFilesDocument(created),
  };
}

function normalizeSnapshotFiles(value) {
  if (!Array.isArray(value) || value.length !== 9) throw new Error(FAILURE);
  const names = value.map((file) => file?.name);
  if (
    names.some((name) => !validName(name)) ||
    new Set(names).size !== names.length ||
    names.some((name, index) => index > 0 && name <= names[index - 1])
  ) {
    throw new Error(FAILURE);
  }
  const files = new Map();
  const documents = [];
  for (const file of value) {
    if (
      !exactKeys(file, ["name", "dev", "ino", "bytes", "sha256"]) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error(FAILURE);
    }
    const identity = normalizedIdentity({ dev: file.dev, ino: file.ino });
    files.set(file.name, {
      identity: identity.identity,
      bytes: file.bytes,
      hash: file.sha256,
    });
    documents.push({
      name: file.name,
      dev: identity.document.dev,
      ino: identity.document.ino,
      bytes: file.bytes,
      sha256: file.sha256,
    });
  }
  return { names, files, documents };
}

function normalizeCleanupJournal(value, base, transactionId) {
  if (
    !exactKeys(value, [
      "schema",
      "transactionId",
      "destination",
      "backup",
      "candidate",
      "journal",
      "previousDirectory",
      "previousFiles",
      "candidateDirectory",
      "candidateFiles",
    ]) ||
    value.schema !== CLEANUP_SCHEMA ||
    value.transactionId !== transactionId ||
    value.destination !== base ||
    value.backup !== `.${base}.backup-${transactionId}` ||
    value.candidate !== `.${base}.candidate-${transactionId}`
  ) {
    throw new Error(FAILURE);
  }
  const journal = normalizedIdentity(value.journal);
  const previousDirectory = normalizedIdentity(value.previousDirectory);
  const candidateDirectory = normalizedIdentity(value.candidateDirectory);
  const previousFiles = normalizeSnapshotFiles(value.previousFiles);
  const candidateFiles = normalizeSnapshotFiles(value.candidateFiles);
  if (previousFiles.names.some((name, index) => name !== candidateFiles.names[index])) {
    throw new Error(FAILURE);
  }
  const document = {
    schema: CLEANUP_SCHEMA,
    transactionId,
    destination: base,
    backup: value.backup,
    candidate: value.candidate,
    journal: journal.document,
    previousDirectory: previousDirectory.document,
    previousFiles: previousFiles.documents,
    candidateDirectory: candidateDirectory.document,
    candidateFiles: candidateFiles.documents,
  };
  return {
    canonical: `${JSON.stringify(document)}\n`,
    journalIdentity: journal.identity,
    previousRecord: {
      directoryIdentity: previousDirectory.identity,
      files: previousFiles.files,
    },
    candidateRecord: {
      directoryIdentity: candidateDirectory.identity,
      files: candidateFiles.files,
    },
  };
}

async function removeOwnedFile(path, identity) {
  const current = await ordinaryFile(path);
  if (!sameIdentity(current, identity)) throw new Error(FAILURE);
  await unlink(path);
}

async function createCleanupJournal(
  path,
  base,
  transactionId,
  backup,
  candidate,
  previous,
  created,
  hooks,
) {
  const handle = await (hooks?.openCleanupJournal ?? open)(path, "wx", 0o600);
  let opened;
  let pathIdentity;
  let result;
  let failed = false;
  try {
    opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.size !== 0n) throw new Error(FAILURE);
    pathIdentity = await ordinaryFile(path);
    if (!sameIdentity(opened, pathIdentity)) throw new Error(FAILURE);
    const document = cleanupJournalDocument(
      base,
      transactionId,
      backup,
      candidate,
      pathIdentity,
      previous,
      created,
    );
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
    if (bytes.length > MAX_CLEANUP_JOURNAL_BYTES) throw new Error(FAILURE);
    await boundary(hooks, "beforeCleanupJournalWrite");
    await handle.writeFile(bytes);
    await boundary(hooks, "afterCleanupJournalWrite");
    await boundary(hooks, "beforeCleanupJournalSync");
    await handle.sync();
    await boundary(hooks, "afterCleanupJournalSync");
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(opened, after) || after.size !== BigInt(bytes.length)) {
      throw new Error(FAILURE);
    }
    result = {
      path,
      identity: pathIdentity,
      record: {
        previousRecord: snapshotRecord(previous),
        candidateRecord: snapshotRecord(created),
      },
    };
  } catch {
    failed = true;
  }
  try {
    await handle.close();
  } catch {
    failed = true;
  }
  if (!failed && opened) {
    try {
      const afterClose = await ordinaryFile(path);
      if (!sameIdentity(opened, afterClose)) failed = true;
    } catch {
      failed = true;
    }
  }
  if (failed || !result) {
    if (opened && (await pathExists(path))) {
      try {
        await removeOwnedFile(path, opened);
      } catch {
        throw new Error(FAILURE);
      }
    }
    throw new Error(FAILURE);
  }
  return result;
}

async function readCleanupJournal(path, base, transactionId) {
  const before = await ordinaryFile(path);
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      !sameIdentity(before, opened) ||
      opened.size < 1n ||
      opened.size > BigInt(MAX_CLEANUP_JOURNAL_BYTES)
    ) {
      throw new Error(FAILURE);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await ordinaryFile(path);
    if (!sameIdentity(opened, after) || !sameIdentity(after, pathAfter)) {
      throw new Error(FAILURE);
    }
    let text;
    let value;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      value = JSON.parse(text);
    } catch {
      throw new Error(FAILURE);
    }
    const normalized = normalizeCleanupJournal(value, base, transactionId);
    if (text !== normalized.canonical || !sameIdentity(pathAfter, normalized.journalIdentity)) {
      throw new Error(FAILURE);
    }
    return { ...normalized, path };
  } finally {
    await handle.close();
  }
}

function cleanupProbeName(index) {
  return `.cleanup-probe-${index.toString().padStart(2, "0")}`;
}

async function verifyOwnedCleanupFile(path, expected) {
  await readVerifiedSource(
    { source: path, bytes: expected.bytes, sha256: expected.hash },
    expected.identity,
  );
}

async function cleanupOwnedBackup(backup, record, hooks) {
  const currentDirectory = await ordinaryDirectory(backup);
  if (!sameIdentity(currentDirectory, record.directoryIdentity)) throw new Error(FAILURE);
  const expected = [...record.files].sort(([left], [right]) => compareNames(left, right));
  const actualNames = new Set(await readdir(backup));
  const remaining = [];
  for (let index = 0; index < expected.length; index++) {
    const [name, file] = expected[index];
    const probe = cleanupProbeName(index);
    const hasName = actualNames.has(name);
    const hasProbe = actualNames.has(probe);
    if (hasName && hasProbe) throw new Error(FAILURE);
    if (!hasName && !hasProbe) continue;
    const currentName = hasName ? name : probe;
    await verifyOwnedCleanupFile(join(backup, currentName), file);
    remaining.push({ name, probe, currentName, file });
  }
  if (actualNames.size !== remaining.length) throw new Error(FAILURE);
  await assertDirectoryIdentity(backup, record.directoryIdentity);

  for (const item of remaining) {
    await boundary(hooks, `beforeCleanupBackup:${item.name}`);
    let currentName = item.currentName;
    if (currentName === item.probe) {
      if (await pathExists(join(backup, item.name))) throw new Error(FAILURE);
      await rename(join(backup, item.probe), join(backup, item.name));
      await verifyOwnedCleanupFile(join(backup, item.name), item.file);
      currentName = item.name;
    }
    await verifyOwnedCleanupFile(join(backup, currentName), item.file);
    await rename(join(backup, item.name), join(backup, item.probe));
    await verifyOwnedCleanupFile(join(backup, item.probe), item.file);
    await rename(join(backup, item.probe), join(backup, item.name));
    await verifyOwnedCleanupFile(join(backup, item.name), item.file);
  }

  for (const item of remaining) {
    await boundary(hooks, `beforeCleanupUnlink:${item.name}`);
    await verifyOwnedCleanupFile(join(backup, item.name), item.file);
    await unlink(join(backup, item.name));
  }
  await assertDirectoryIdentity(backup, record.directoryIdentity);
  if ((await readdir(backup)).length !== 0) throw new Error(FAILURE);
  await rmdir(backup);
}

async function finishCleanupJournal(journal, backup, hooks) {
  const previousRecord = journal.record?.previousRecord ?? journal.previousRecord;
  if (await pathExists(backup)) {
    await cleanupOwnedBackup(backup, previousRecord, hooks);
  }
  await removeOwnedFile(journal.path, journal.identity ?? journal.journalIdentity);
}

async function snapshotMatches(directory, record) {
  try {
    await assertSnapshot(directory, record, [...record.files.keys()].sort());
    return true;
  } catch {
    return false;
  }
}

async function recoverCleanupJournal(parent, base, parentIdentity, transactionId, journal) {
  const destination = join(parent, base);
  const backup = join(parent, `.${base}.backup-${transactionId}`);
  const candidate = join(parent, `.${base}.candidate-${transactionId}`);
  const destinationExists = await pathExists(destination);
  const backupExists = await pathExists(backup);
  const candidateExists = await pathExists(candidate);
  const destinationIsPrevious =
    destinationExists && (await snapshotMatches(destination, journal.previousRecord));
  const destinationIsCandidate =
    destinationExists && (await snapshotMatches(destination, journal.candidateRecord));

  await assertDirectoryIdentity(parent, parentIdentity);
  if (destinationIsCandidate) {
    if (candidateExists) throw new Error(FAILURE);
    await finishCleanupJournal(journal, backup);
    await assertSnapshot(
      destination,
      journal.candidateRecord,
      [...journal.candidateRecord.files.keys()].sort(),
    );
    return;
  }

  if (destinationIsPrevious) {
    if (backupExists) throw new Error(FAILURE);
    if (candidateExists) {
      await cleanupOwnedBackup(candidate, journal.candidateRecord);
    }
    await assertSnapshot(
      destination,
      journal.previousRecord,
      [...journal.previousRecord.files.keys()].sort(),
    );
    await removeOwnedFile(journal.path, journal.journalIdentity);
    return;
  }

  if (!destinationExists && backupExists) {
    const previousNames = [...journal.previousRecord.files.keys()].sort();
    await assertSnapshot(backup, journal.previousRecord, previousNames);
    if (candidateExists) {
      await assertSnapshot(
        candidate,
        journal.candidateRecord,
        [...journal.candidateRecord.files.keys()].sort(),
      );
    }
    await assertDirectoryIdentity(parent, parentIdentity);
    await rename(backup, destination);
    await assertDirectoryIdentity(parent, parentIdentity);
    await assertSnapshot(destination, journal.previousRecord, previousNames);
    if (candidateExists) {
      await cleanupOwnedBackup(candidate, journal.candidateRecord);
    }
    await assertSnapshot(destination, journal.previousRecord, previousNames);
    await removeOwnedFile(journal.path, journal.journalIdentity);
    return;
  }

  throw new Error(FAILURE);
}

async function recoverCleanupJournals(parent, base, parentIdentity) {
  const prefix = `.${base}.cleanup-`;
  const candidates = (await readdir(parent)).filter((name) => name.startsWith(prefix)).sort();
  if (candidates.length > MAX_CLEANUP_JOURNALS) throw new Error(FAILURE);
  for (const name of candidates) {
    if (!name.endsWith(".json")) throw new Error(FAILURE);
    const transactionId = name.slice(prefix.length, -".json".length);
    if (!/^[a-z0-9-]{1,64}$/.test(transactionId)) throw new Error(FAILURE);
    await assertDirectoryIdentity(parent, parentIdentity);
    const journal = await readCleanupJournal(join(parent, name), base, transactionId);
    await recoverCleanupJournal(parent, base, parentIdentity, transactionId, journal);
    await assertDirectoryIdentity(parent, parentIdentity);
  }
}

async function boundary(hooks, name) {
  await hooks?.onBoundary?.(name);
}

async function createCandidate(candidate, files, hooks) {
  await mkdir(candidate);
  const directoryIdentity = await ordinaryDirectory(candidate);
  const owned = new Map();
  try {
    for (const file of files) {
      await boundary(hooks, `beforeWrite:${file.name}`);
      const source = await readVerifiedSource(file, file.identity);
      const path = join(candidate, file.name);
      const handle = await (hooks?.openCandidateFile ?? open)(path, "wx", 0o600);
      let opened;
      try {
        opened = await handle.stat({ bigint: true });
        if (!opened.isFile()) throw new Error(FAILURE);
        const pathIdentity = await ordinaryFile(path);
        if (!sameIdentity(opened, pathIdentity)) throw new Error(FAILURE);
        owned.set(file.name, { identity: pathIdentity, bytes: Buffer.alloc(0), hash: "" });
        await handle.writeFile(source.bytes);
        await boundary(hooks, `afterWrite:${file.name}`);
        await boundary(hooks, `beforeSync:${file.name}`);
        await handle.sync();
        await boundary(hooks, `afterSync:${file.name}`);
        const after = await handle.stat({ bigint: true });
        if (!sameIdentity(opened, after) || after.size !== BigInt(source.bytes.length)) {
          throw new Error(FAILURE);
        }
      } finally {
        await handle.close();
      }
      const pathIdentity = await ordinaryFile(path);
      if (!sameIdentity(opened, pathIdentity)) throw new Error(FAILURE);
      const verified = await readVerifiedSource(
        { source: path, bytes: source.bytes.length, sha256: sha256(source.bytes) },
        pathIdentity,
      );
      owned.set(file.name, {
        identity: verified.identity,
        bytes: verified.bytes,
        hash: sha256(verified.bytes),
      });
    }
    const directoryAfter = await ordinaryDirectory(candidate);
    if (!sameIdentity(directoryIdentity, directoryAfter)) throw new Error(FAILURE);
    return { directoryIdentity, files: owned };
  } catch {
    await removeOwnedDirectory(candidate, directoryIdentity, owned);
    throw new Error(FAILURE);
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function restorePrevious({ destination, candidate, backup, previous, created }) {
  if (created && (await pathExists(destination))) {
    const current = await inspectExactPack(
      destination,
      [...created.files.keys()].sort(),
      new Map([...created.files].map(([name, value]) => [name, value])),
    );
    if (!sameIdentity(current.directoryIdentity, created.directoryIdentity))
      throw new Error(FAILURE);
    await rename(destination, candidate);
  }
  if (previous && (await pathExists(backup))) {
    if (await pathExists(destination)) throw new Error(FAILURE);
    await assertSnapshot(backup, previous, [...previous.files.keys()].sort());
    await rename(backup, destination);
    await assertSnapshot(destination, previous, [...previous.files.keys()].sort());
  }
}

export async function stageComponentPack(destinationInput, specification, hooks = {}) {
  const destination = resolve(destinationInput);
  const parent = dirname(destination);
  const base = basename(destination);
  const transactionId = hooks.transactionId ?? randomUUID();
  const candidate = join(parent, `.${base}.candidate-${transactionId}`);
  const backup = join(parent, `.${base}.backup-${transactionId}`);
  const cleanupJournal = join(parent, `.${base}.cleanup-${transactionId}.json`);
  let created;
  let previous;
  let journal;
  let backupPublished = false;
  let candidatePublished = false;
  let committed = false;
  try {
    if (
      !specification ||
      !Array.isArray(specification.files) ||
      specification.files.length !== 9 ||
      !validName(base) ||
      !/^[a-z0-9-]{1,64}$/.test(transactionId)
    ) {
      throw new Error(FAILURE);
    }
    const names = specification.files.map((file) => file.name);
    const expectedNames = [...names].sort();
    if (
      new Set(names).size !== names.length ||
      names.some((name) => !validName(name)) ||
      specification.files.some(
        (file) =>
          (typeof file.source !== "string" && typeof file.contentBase64 !== "string") ||
          (typeof file.source === "string" && typeof file.contentBase64 === "string") ||
          !Number.isSafeInteger(file.bytes) ||
          file.bytes < 1 ||
          !/^[a-f0-9]{64}$/.test(file.sha256),
      )
    ) {
      throw new Error(FAILURE);
    }
    const previousDescriptors = specification.previousFiles ?? specification.files;
    const previousNames = previousDescriptors.map((file) => file.name).sort();
    if (
      previousDescriptors.length !== 9 ||
      new Set(previousNames).size !== previousNames.length ||
      previousNames.some((name) => !validName(name)) ||
      previousDescriptors.some(
        (file) =>
          !Number.isSafeInteger(file.bytes) ||
          file.bytes < 1 ||
          !/^[a-f0-9]{64}$/.test(file.sha256),
      )
    ) {
      throw new Error(FAILURE);
    }
    const acceptedPrevious = new Map(
      previousDescriptors.map((file) => [file.name, { bytes: file.bytes, hash: file.sha256 }]),
    );
    const prepared = [];
    for (const file of specification.files) {
      const verified = await readVerifiedSource(file);
      prepared.push({ ...file, identity: verified.identity });
    }
    const parentIdentity = await ensureOrdinaryParent(parent);
    if (await pathExists(candidate)) throw new Error(FAILURE);
    if (await pathExists(backup)) throw new Error(FAILURE);
    if (await pathExists(cleanupJournal)) throw new Error(FAILURE);
    await assertDirectoryIdentity(parent, parentIdentity);
    if (hooks.allowPreparedEmptyDestination === true && (await pathExists(destination))) {
      await removePreparedEmptyDestination(destination, parent, parentIdentity);
    }
    await recoverCleanupJournals(parent, base, parentIdentity);
    await assertDirectoryIdentity(parent, parentIdentity);
    if (await pathExists(destination)) {
      previous = await inspectExactPack(destination, previousNames, acceptedPrevious);
    }
    await assertDirectoryIdentity(parent, parentIdentity);
    created = await createCandidate(candidate, prepared, hooks);
    await inspectExactPack(
      candidate,
      expectedNames,
      new Map([...created.files].map(([name, value]) => [name, value])),
    );
    if (previous) {
      journal = await createCleanupJournal(
        cleanupJournal,
        base,
        transactionId,
        backup,
        candidate,
        previous,
        created,
        hooks,
      );
      await boundary(hooks, "beforePublishBackup");
      await assertDirectoryIdentity(parent, parentIdentity);
      await assertSnapshot(destination, previous, previousNames);
      await rename(destination, backup);
      backupPublished = true;
      await assertDirectoryIdentity(parent, parentIdentity);
      await assertSnapshot(backup, previous, previousNames);
      await boundary(hooks, "afterPublishBackup");
    }
    await boundary(hooks, "beforePublishCandidate");
    await assertDirectoryIdentity(parent, parentIdentity);
    if (await pathExists(destination)) throw new Error(FAILURE);
    const candidateBefore = await ordinaryDirectory(candidate);
    if (!sameIdentity(candidateBefore, created.directoryIdentity)) throw new Error(FAILURE);
    await rename(candidate, destination);
    candidatePublished = true;
    await assertDirectoryIdentity(parent, parentIdentity);
    const destinationAfter = await ordinaryDirectory(destination);
    if (!sameIdentity(destinationAfter, created.directoryIdentity)) throw new Error(FAILURE);
    await boundary(hooks, "afterPublishCandidate");
    await boundary(hooks, "beforeFinalValidation");
    await inspectExactPack(
      destination,
      expectedNames,
      new Map([...created.files].map(([name, value]) => [name, value])),
    );
    committed = true;
    let cleanupPending = false;
    if (backupPublished) {
      try {
        await finishCleanupJournal(journal, backup, hooks);
        backupPublished = false;
        journal = undefined;
      } catch {
        cleanupPending = true;
      }
    }
    return { state: "published", cleanupPending };
  } catch {
    if (!committed) {
      try {
        await restorePrevious({
          destination,
          candidate,
          backup,
          previous,
          created: candidatePublished ? created : null,
        });
        candidatePublished = false;
        backupPublished = false;
        if (journal && (await pathExists(journal.path))) {
          await removeOwnedFile(journal.path, journal.identity);
          journal = undefined;
        }
      } catch {
        throw new Error(FAILURE);
      }
    }
    throw new Error(FAILURE);
  } finally {
    if (!candidatePublished && created && (await pathExists(candidate))) {
      try {
        await removeOwnedDirectory(candidate, created.directoryIdentity, created.files);
      } catch {
        if (!committed) throw new Error(FAILURE);
      }
    }
  }
}

async function cli() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  await stageComponentPack(request.destination, request.specification, {
    allowPreparedEmptyDestination: request.allowPreparedEmptyDestination === true,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  cli().catch(() => {
    process.stderr.write(`${FAILURE}\n`);
    process.exitCode = 1;
  });
}
