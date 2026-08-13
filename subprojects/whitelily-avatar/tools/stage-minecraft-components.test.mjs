import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageComponentPack } from "./stage-minecraft-components.mjs";

const names = [
  "Fabric-API-LICENSE.txt",
  "GeckoLib-LICENSE.txt",
  "WhiteLily-LICENSE.txt",
  "WhiteLily-NOTICE.txt",
  "fabric-api-0.128.2+1.21.5.jar",
  "geckolib-fabric-1.21.5-5.1.0.jar",
  "minecraft-components-manifest.json",
  "whitelily-avatar-fabric-1.21.5-0.1.0.jar",
  "whitelily-bridge-fabric-1.21.5-0.1.1.jar",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function content(label, name) {
  return Buffer.from(`${label}:${name}\n`, "utf8");
}

async function spec(root, label) {
  const sources = join(root, `sources-${label}`);
  await mkdir(sources);
  const files = [];
  for (const name of names) {
    const bytes = content(label, name);
    const source = join(sources, name);
    await writeFile(source, bytes, { flag: "wx" });
    files.push({ name, source, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { files };
}

async function snapshot(directory) {
  const result = {};
  for (const name of names) {
    const path = join(directory, name);
    const stats = await lstat(path, { bigint: true });
    result[name] = {
      bytes: await readFile(path),
      dev: stats.dev,
      ino: stats.ino,
    };
  }
  return result;
}

function assertSameSnapshot(before, after) {
  assert.deepEqual(Object.keys(after).sort(), names);
  for (const name of names) {
    assert.deepEqual(after[name].bytes, before[name].bytes, name);
    assert.equal(after[name].dev, before[name].dev, name);
    assert.equal(after[name].ino, before[name].ino, name);
  }
}

async function assertNoTransactionResidue(root) {
  assert.deepEqual(
    (await readdir(root)).filter(
      (name) =>
        name.startsWith(".minecraft-components.candidate-") ||
        name.startsWith(".minecraft-components.backup-") ||
        name.startsWith(".minecraft-components.cleanup-"),
    ),
    [],
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "whitelily-stage-"));
  const destination = join(root, "minecraft-components");
  const oldSpecification = await spec(root, "old");
  await stageComponentPack(destination, oldSpecification);
  return {
    root,
    destination,
    before: await snapshot(destination),
    previousFiles: oldSpecification.files.map(({ name, bytes, sha256 }) => ({
      name,
      bytes,
      sha256,
    })),
  };
}

async function replacementSpec(root, label, previousFiles) {
  return { ...(await spec(root, label)), previousFiles };
}

function reviewedFiles(specification) {
  return specification.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
}

async function lockFileAgainstDeletion(path) {
  const script = [
    "$target = [Environment]::GetEnvironmentVariable('WHITELILY_LOCK_TARGET')",
    "$stream = [System.IO.File]::Open($target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)",
    "[Console]::Out.WriteLine('ready')",
    "[Console]::Out.Flush()",
    "[Console]::In.ReadLine() | Out-Null",
    "$stream.Dispose()",
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, WHITELILY_LOCK_TARGET: path },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((resolveReady, rejectReady) => {
    let output = "";
    child.once("error", rejectReady);
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("ready")) resolveReady();
    });
    child.once("exit", (code) => rejectReady(new Error(`lock helper exited ${code}: ${output}`)));
  });
  return async () => {
    child.stdin.end("\n");
    const code = await new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", resolveExit);
    });
    assert.equal(code, 0);
  };
}

async function crashAt(destination, replacement, crashBoundary) {
  const childProgram = `
    const [moduleUrl, destination, specification, crashBoundary] = process.argv.slice(1);
    const { stageComponentPack } = await import(moduleUrl);
    await stageComponentPack(destination, JSON.parse(specification), {
      onBoundary(boundary) {
        if (boundary === crashBoundary) process.exit(73);
      },
    });
  `;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      childProgram,
      new URL("./stage-minecraft-components.mjs", import.meta.url).href,
      destination,
      JSON.stringify(replacement),
      crashBoundary,
    ],
    { stdio: "ignore" },
  );
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  assert.equal(exitCode, 73);
}

test("publishes one exact nine-file pack without transaction residue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "minecraft-components");

  const result = await stageComponentPack(destination, await spec(root, "new"));

  assert.deepEqual(result, { state: "published", cleanupPending: false });
  assert.deepEqual((await readdir(destination)).sort(), names);
  await assertNoTransactionResidue(root);
});

test("syncs and closes every exclusively-created candidate file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "minecraft-components");
  let syncs = 0;
  let closes = 0;

  await stageComponentPack(destination, await spec(root, "durable"), {
    async openCandidateFile(...arguments_) {
      const handle = await open(...arguments_);
      return {
        stat: (...arguments_) => handle.stat(...arguments_),
        writeFile: (...arguments_) => handle.writeFile(...arguments_),
        async sync() {
          syncs += 1;
          return handle.sync();
        },
        async close() {
          closes += 1;
          return handle.close();
        },
      };
    },
  });

  assert.equal(syncs, names.length);
  assert.equal(closes, names.length);
});

test("creates one fixed ordinary staging parent after all sources validate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "missing-build", "minecraft-components");

  await stageComponentPack(destination, await spec(root, "new-parent"));

  assert.deepEqual((await readdir(destination)).sort(), names);
});

test("removes only an attested Gradle-prepared empty output after sources validate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "minecraft-components");
  await mkdir(destination);
  const before = await lstat(destination, { bigint: true });

  const result = await stageComponentPack(destination, await spec(root, "gradle-prepared"), {
    allowPreparedEmptyDestination: true,
  });

  assert.deepEqual(result, { state: "published", cleanupPending: false });
  const after = await lstat(destination, { bigint: true });
  assert.notEqual(after.ino, before.ino);
  assert.deepEqual((await readdir(destination)).sort(), names);
});

test("an attested empty output remains untouched when source validation fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "minecraft-components");
  await mkdir(destination);
  const before = await lstat(destination, { bigint: true });
  const invalid = await spec(root, "invalid-gradle-prepared");
  await writeFile(invalid.files[0].source, "invalid source");

  await assert.rejects(
    stageComponentPack(destination, invalid, { allowPreparedEmptyDestination: true }),
    /component staging failed/,
  );

  const after = await lstat(destination, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.deepEqual(await readdir(destination), []);
});

test("an unapproved or nonempty output collision is preserved", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "whitelily-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "minecraft-components");
  await mkdir(destination);
  const before = await lstat(destination, { bigint: true });
  const replacement = await spec(root, "output-collision");

  await assert.rejects(stageComponentPack(destination, replacement), /component staging failed/);
  assert.equal((await lstat(destination, { bigint: true })).ino, before.ino);
  await writeFile(join(destination, "foreign.txt"), "foreign", { flag: "wx" });
  await assert.rejects(
    stageComponentPack(destination, replacement, { allowPreparedEmptyDestination: true }),
    /component staging failed/,
  );
  assert.equal((await lstat(destination, { bigint: true })).ino, before.ino);
  assert.equal(await readFile(join(destination, "foreign.txt"), "utf8"), "foreign");
});

for (const boundary of [
  ...names.flatMap((name) => [
    `beforeWrite:${name}`,
    `afterWrite:${name}`,
    `beforeSync:${name}`,
    `afterSync:${name}`,
  ]),
  "beforePublishBackup",
  "afterPublishBackup",
  "beforePublishCandidate",
  "afterPublishCandidate",
  "beforeFinalValidation",
  "beforeCleanupJournalWrite",
  "afterCleanupJournalWrite",
  "beforeCleanupJournalSync",
  "afterCleanupJournalSync",
]) {
  test(`rolls back the exact prior pack when ${boundary} fails`, async (t) => {
    const { root, destination, before, previousFiles } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const replacement = await replacementSpec(
      root,
      `new-${boundary.replaceAll(":", "-")}`,
      previousFiles,
    );

    await assert.rejects(
      stageComponentPack(destination, replacement, {
        onBoundary(current) {
          if (current === boundary) throw new Error("injected staging failure");
        },
      }),
      /component staging failed/,
    );

    assertSameSnapshot(before, await snapshot(destination));
    await assertNoTransactionResidue(root);
  });
}

test("late foreign destination entry is preserved and prevents publication", async (t) => {
  const { root, destination, before, previousFiles } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const replacement = await replacementSpec(root, "new-foreign", previousFiles);
  const foreign = join(destination, "foreign.jar");

  await assert.rejects(
    stageComponentPack(destination, replacement, {
      async onBoundary(boundary) {
        if (boundary === "beforePublishBackup") {
          await writeFile(foreign, "foreign", { flag: "wx" });
        }
      },
    }),
    /component staging failed/,
  );

  assertSameSnapshot(before, await snapshot(destination));
  assert.equal(await readFile(foreign, "utf8"), "foreign");
  await assertNoTransactionResidue(root);
});

test("rejects a pre-existing candidate or backup collision without touching the pack", async (t) => {
  const { root, destination, before, previousFiles } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".minecraft-components.candidate-collision"));

  await assert.rejects(
    stageComponentPack(destination, await replacementSpec(root, "new-collision", previousFiles), {
      transactionId: "collision",
    }),
    /component staging failed/,
  );

  assertSameSnapshot(before, await snapshot(destination));
});

test("rejects a raced source replacement before publication", async (t) => {
  const { root, destination, before, previousFiles } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const replacement = await replacementSpec(root, "new-source-race", previousFiles);
  const raced = replacement.files[4];

  await assert.rejects(
    stageComponentPack(destination, replacement, {
      async onBoundary(boundary) {
        if (boundary === `beforeWrite:${raced.name}`) {
          const handle = await open(raced.source, "w");
          await handle.writeFile("raced");
          await handle.close();
        }
      },
    }),
    /component staging failed/,
  );

  assertSameSnapshot(before, await snapshot(destination));
  await assertNoTransactionResidue(root);
});

for (const crashBoundary of [
  `afterWrite:${names[4]}`,
  "afterPublishBackup",
  "afterPublishCandidate",
]) {
  test(`an actual process failure at ${crashBoundary} preserves all prior file identities`, async (t) => {
    const { root, destination, before, previousFiles } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await crashAt(
      destination,
      await replacementSpec(root, `crash-${crashBoundary.replaceAll(":", "-")}`, previousFiles),
      crashBoundary,
    );

    const backupName = (await readdir(root)).find((name) =>
      name.startsWith(".minecraft-components.backup-"),
    );
    const previousLocation = backupName ? join(root, backupName) : destination;
    assertSameSnapshot(before, await snapshot(previousLocation));
  });
}

test("rejects unknown same-name prior files before creating a candidate", async (t) => {
  const { root, destination, before } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    stageComponentPack(destination, await spec(root, "unreviewed-replacement")),
    /component staging failed/,
  );

  assertSameSnapshot(before, await snapshot(destination));
  await assertNoTransactionResidue(root);
});

test(
  "a locked final backup entry cannot turn a committed publication into a reported failure",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { root, destination, before, previousFiles } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const transactionId = "cleanup-lock";
    const replacement = await replacementSpec(root, "new-cleanup-lock", previousFiles);
    let releaseLock;
    let publication;

    try {
      publication = await stageComponentPack(destination, replacement, {
        transactionId,
        async onBoundary(boundary) {
          if (boundary === "afterPublishCandidate") {
            releaseLock = await lockFileAgainstDeletion(
              join(root, `.minecraft-components.backup-${transactionId}`, names.at(-1)),
            );
          }
        },
      });
    } finally {
      await releaseLock?.();
    }

    assert.deepEqual(publication, { state: "published", cleanupPending: true });
    for (const name of names) {
      assert.deepEqual(await readFile(join(destination, name)), content("new-cleanup-lock", name));
    }
    assert.ok(
      (await readdir(root)).some((name) => name.startsWith(".minecraft-components.backup-")),
      "the locked owned residue remains recoverable",
    );
    assertSameSnapshot(
      before,
      await snapshot(join(root, `.minecraft-components.backup-${transactionId}`)),
    );

    const recovered = await stageComponentPack(
      destination,
      await replacementSpec(root, "after-cleanup-recovery", reviewedFiles(replacement)),
    );
    assert.deepEqual(recovered, { state: "published", cleanupPending: false });
    await assertNoTransactionResidue(root);
  },
);

test("a partial committed cleanup is recovered on the next run", async (t) => {
  const { root, destination, previousFiles } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const replacement = await replacementSpec(root, "partial-cleanup", previousFiles);
  const result = await stageComponentPack(destination, replacement, {
    transactionId: "partial-cleanup",
    onBoundary(boundary) {
      if (boundary === `beforeCleanupUnlink:${names.at(-1)}`) {
        throw new Error("injected post-commit cleanup failure");
      }
    },
  });

  assert.deepEqual(result, { state: "published", cleanupPending: true });
  assert.ok(
    (await readdir(root)).some((name) => name.startsWith(".minecraft-components.cleanup-")),
  );
  const recovered = await stageComponentPack(
    destination,
    await replacementSpec(root, "after-partial-cleanup", reviewedFiles(replacement)),
  );
  assert.deepEqual(recovered, { state: "published", cleanupPending: false });
  await assertNoTransactionResidue(root);
});

test("an actual process exit after publication is recovered by the next reviewed run", async (t) => {
  const { root, destination, previousFiles } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const replacement = await replacementSpec(root, "crash-recovery", previousFiles);
  await crashAt(destination, replacement, "afterPublishCandidate");

  const recovered = await stageComponentPack(
    destination,
    await replacementSpec(root, "after-crash-recovery", reviewedFiles(replacement)),
  );

  assert.deepEqual(recovered, { state: "published", cleanupPending: false });
  await assertNoTransactionResidue(root);
});

for (const crashBoundary of ["afterCleanupJournalSync", "afterPublishBackup"]) {
  test(`a later failure restores the prior pack after process exit at ${crashBoundary}`, async (t) => {
    const { root, destination, before, previousFiles } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await crashAt(
      destination,
      await replacementSpec(root, `restore-${crashBoundary}`, previousFiles),
      crashBoundary,
    );

    await assert.rejects(
      stageComponentPack(
        destination,
        await replacementSpec(root, `later-failure-${crashBoundary}`, previousFiles),
        {
          onBoundary(boundary) {
            if (boundary === `beforeWrite:${names[0]}`) {
              throw new Error("injected later failure");
            }
          },
        },
      ),
      /component staging failed/,
    );

    assertSameSnapshot(before, await snapshot(destination));
    await assertNoTransactionResidue(root);
  });
}

test(
  "a raced hard-link replacement in the committed backup is preserved and blocks recovery",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { root, destination, previousFiles } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const replacement = await replacementSpec(root, "foreign-backup", previousFiles);
    const transactionId = "foreign-backup";
    const foreignSource = join(root, "foreign-backup-source.bin");
    const outsideSentinel = join(root, "outside-sentinel.bin");
    await writeFile(foreignSource, content("old", names[0]), { flag: "wx" });
    await writeFile(outsideSentinel, "outside", { flag: "wx" });
    const foreignPath = join(root, `.minecraft-components.backup-${transactionId}`, names[0]);

    const result = await stageComponentPack(destination, replacement, {
      transactionId,
      async onBoundary(boundary) {
        if (boundary === `beforeCleanupBackup:${names[0]}`) {
          await unlink(foreignPath);
          await link(foreignSource, foreignPath);
        }
      },
    });

    assert.deepEqual(result, { state: "published", cleanupPending: true });
    const beforeRecovery = await snapshot(destination);
    const foreignIdentity = await lstat(foreignSource, { bigint: true });
    const racedIdentity = await lstat(foreignPath, { bigint: true });
    assert.equal(racedIdentity.ino, foreignIdentity.ino);
    await assert.rejects(
      stageComponentPack(
        destination,
        await replacementSpec(root, "blocked-by-foreign-backup", reviewedFiles(replacement)),
      ),
      /component staging failed/,
    );
    assertSameSnapshot(beforeRecovery, await snapshot(destination));
    assert.equal((await lstat(foreignPath, { bigint: true })).ino, foreignIdentity.ino);
    assert.deepEqual(await readFile(foreignPath), content("old", names[0]));
    assert.equal(await readFile(outsideSentinel, "utf8"), "outside");
  },
);

test("a raced cleanup-journal replacement is preserved after the pack commits", async (t) => {
  const { root, destination, previousFiles } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const transactionId = "foreign-journal";
  const replacement = await replacementSpec(root, "foreign-journal", previousFiles);
  const journal = join(root, `.minecraft-components.cleanup-${transactionId}.json`);
  let replaced = false;

  const result = await stageComponentPack(destination, replacement, {
    transactionId,
    async onBoundary(boundary) {
      if (!replaced && boundary === `beforeCleanupUnlink:${names.at(-1)}`) {
        await unlink(journal);
        await writeFile(journal, "foreign journal", { flag: "wx" });
        replaced = true;
      }
    },
  });

  assert.deepEqual(result, { state: "published", cleanupPending: true });
  assert.equal(await readFile(journal, "utf8"), "foreign journal");
  const beforeRecovery = await snapshot(destination);
  await assert.rejects(
    stageComponentPack(
      destination,
      await replacementSpec(root, "blocked-by-foreign-journal", reviewedFiles(replacement)),
    ),
    /component staging failed/,
  );
  assert.equal(await readFile(journal, "utf8"), "foreign journal");
  assertSameSnapshot(beforeRecovery, await snapshot(destination));
});

test("a raced foreign destination replacement is never deleted during rollback", async (t) => {
  const { root, destination, before, previousFiles } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const transactionId = "foreign-destination";
  const candidate = join(root, `.minecraft-components.candidate-${transactionId}`);
  const replacement = await replacementSpec(root, "foreign-destination", previousFiles);

  await assert.rejects(
    stageComponentPack(destination, replacement, {
      transactionId,
      async onBoundary(boundary) {
        if (boundary === "beforeFinalValidation") {
          await rename(destination, candidate);
          await mkdir(destination);
          await writeFile(join(destination, "foreign.txt"), "foreign destination", { flag: "wx" });
        }
      },
    }),
    /component staging failed/,
  );

  assert.equal(await readFile(join(destination, "foreign.txt"), "utf8"), "foreign destination");
  const backup = join(root, `.minecraft-components.backup-${transactionId}`);
  assertSameSnapshot(before, await snapshot(backup));
  assert.deepEqual((await readdir(candidate)).sort(), names);
});

test(
  "an ordinary Windows junction cannot become the staged destination",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-stage-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, "junction-target");
    await stageComponentPack(target, await spec(root, "junction-old"));
    const before = await snapshot(target);
    const destination = join(root, "minecraft-components");
    await symlink(target, destination, "junction");

    await assert.rejects(
      stageComponentPack(destination, await spec(root, "junction-new")),
      /component staging failed/,
    );
    assert.equal((await lstat(destination)).isSymbolicLink(), true);
    assertSameSnapshot(before, await snapshot(target));
  },
);

test(
  "a file symbolic link in the prior pack is rejected without touching its target",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { root, destination, previousFiles } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const linkedName = names[0];
    const target = join(root, "file-symlink-target.bin");
    await writeFile(target, content("old", linkedName), { flag: "wx" });
    await unlink(join(destination, linkedName));
    try {
      await symlink(target, join(destination, linkedName), "file");
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("Windows file symbolic-link privilege is unavailable");
        return;
      }
      throw error;
    }

    await assert.rejects(
      stageComponentPack(
        destination,
        await replacementSpec(root, "file-symlink-new", previousFiles),
      ),
      /component staging failed/,
    );
    assert.equal((await lstat(join(destination, linkedName))).isSymbolicLink(), true);
    assert.deepEqual(await readFile(target), content("old", linkedName));
  },
);
