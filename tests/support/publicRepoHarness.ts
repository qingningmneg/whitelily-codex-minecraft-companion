import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const publicOverlay = [
  ".gitattributes",
  ".gitignore",
  ".github",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "NOTICE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "scripts",
  "tests",
];

export interface PublicRepoCandidate {
  commitCount: number;
  remotes: string[];
  files: string[];
}

export interface ReleasePackage {
  hasChecksum: boolean;
  stagingRemoved: boolean;
  entries: string[];
  rawEntries: string[];
  hasUntrackedCredential: boolean;
  dirtyHeadMismatchRejected: boolean;
  checksumMatches: boolean;
  firstHash: string;
  secondHash: string;
  readmeLocalLinks: string[];
  missingReadmeLocalLinks: string[];
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
  });
  return stdout;
}

async function commandFails(command: string, args: string[], cwd: string): Promise<boolean> {
  try {
    await run(command, args, cwd);
    return false;
  } catch {
    return true;
  }
}

const powershellArguments = (script: string, extra: string[] = []) => [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  script,
  ...extra,
];

export async function runPublicRepoPreparation(options: {
  initializeFreshHistory: boolean;
}): Promise<PublicRepoCandidate> {
  const fixture = await mkdtemp(join(tmpdir(), "whitelily-public-repo-"));
  const releaseDirectory = join(fixture, "release");
  try {
    await mkdir(releaseDirectory, { recursive: true });
    const archive = join(releaseDirectory, "source.zip");
    await run("git", ["archive", "--format=zip", "-o", archive, "HEAD"], repositoryRoot);
    await run("tar", ["-xf", archive, "-C", fixture], fixture);
    for (const item of publicOverlay) {
      await cp(join(repositoryRoot, item), join(fixture, item), { recursive: true, force: true });
    }
    const workspaceConfig = join(fixture, "codex-workspace", ".codex", "config.toml");
    await writeFile(
      workspaceConfig,
      (await readFile(workspaceConfig, "utf8")).replaceAll("\r\n", "\n"),
      "utf8",
    );
    await run("git", ["init", "-b", "main"], fixture);
    await run("git", ["config", "core.autocrlf", "false"], fixture);
    await run("git", ["add", "."], fixture);
    await run(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
      fixture,
    );

    const argumentsList = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(fixture, "scripts", "prepare-public-repo.ps1"),
    ];
    if (options.initializeFreshHistory) {
      argumentsList.push("-InitializeFreshHistory");
    }
    await run("powershell", argumentsList, fixture);

    const candidate = join(fixture, "release", "public-repo");
    const commitCount = Number.parseInt(
      (await run("git", ["rev-list", "--count", "HEAD"], candidate)).trim(),
      10,
    );
    const remotes = (await run("git", ["remote"], candidate))
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    const files = (await run("git", ["ls-files"], candidate))
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.replaceAll("\\", "/"));
    return { commitCount, remotes, files };
  } finally {
    if (basename(fixture).startsWith("whitelily-public-repo-")) {
      await rm(fixture, { recursive: true, force: true });
    }
  }
}

export async function runReleasePackage(version: string): Promise<ReleasePackage> {
  const fixture = await mkdtemp(join(tmpdir(), "whitelily-release-package-"));
  const releaseDirectory = join(fixture, "release");
  try {
    await mkdir(join(fixture, "scripts"), { recursive: true });
    await mkdir(join(fixture, "docs"), { recursive: true });
    await mkdir(join(fixture, "src"), { recursive: true });
    await cp(
      join(repositoryRoot, "scripts", "release-check.ps1"),
      join(fixture, "scripts", "release-check.ps1"),
    );
    await cp(
      join(repositoryRoot, "scripts", "package-release.ps1"),
      join(fixture, "scripts", "package-release.ps1"),
    );
    await cp(
      join(repositoryRoot, "scripts", "release-path-safety.ps1"),
      join(fixture, "scripts", "release-path-safety.ps1"),
    );
    await cp(
      join(repositoryRoot, "docs", "windows-smoke-test.md"),
      join(fixture, "docs", "windows-smoke-test.md"),
    );
    await cp(
      join(repositoryRoot, "docs", "installation-windows.zh-CN.md"),
      join(fixture, "docs", "installation-windows.zh-CN.md"),
    );
    await cp(
      join(repositoryRoot, "docs", "runtime-architecture.md"),
      join(fixture, "docs", "runtime-architecture.md"),
    );
    for (const file of [
      "README.md",
      "README.zh-CN.md",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "LICENSE",
      "NOTICE",
      "CHANGELOG.md",
    ]) {
      await cp(join(repositoryRoot, file), join(fixture, file));
    }
    await cp(join(repositoryRoot, "config.example.toml"), join(fixture, "config.example.toml"));
    await writeFile(join(fixture, "src", "index.txt"), "fixture runtime source\n", "utf8");
    await writeFile(
      join(fixture, "package.json"),
      '{\n  "name": "whitelily-release-fixture",\n  "version": "0.1.0",\n  "private": true,\n  "scripts": {\n    "format:check": "node -e \\\"\\\"",\n    "typecheck": "node -e \\\"\\\"",\n    "test": "node -e \\\"\\\" --",\n    "build": "node -e \\\"\\\""\n  }\n}\n',
      "utf8",
    );
    await writeFile(
      join(fixture, "package-lock.json"),
      '{\n  "name": "whitelily-release-fixture",\n  "version": "0.1.0",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "whitelily-release-fixture",\n      "version": "0.1.0"\n    }\n  }\n}\n',
      "utf8",
    );
    await run("git", ["init", "-b", "main"], fixture);
    await run("git", ["config", "core.autocrlf", "false"], fixture);
    await run("git", ["add", "."], fixture);
    await run(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
      fixture,
    );
    const credentialName = ["local", "credential"].join("-");
    await writeFile(
      join(fixture, "src", `${credentialName}.txt`),
      "untracked release fixture credential\n",
      "utf8",
    );
    const committedSecret = ["sk", "committed", "head", "fixture", "credential", "1234567890"].join(
      "-",
    );
    await writeFile(join(fixture, "src", "head-only.txt"), committedSecret, "utf8");
    await run("git", ["add", "src/head-only.txt"], fixture);
    await run(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "add committed-only secret",
      ],
      fixture,
    );
    await rm(join(fixture, "src", "head-only.txt"));
    const dirtyHeadMismatchRejected = await commandFails(
      "powershell",
      powershellArguments(join(fixture, "scripts", "package-release.ps1"), ["-Version", "0.0.9"]),
      fixture,
    );
    const rejectedArtifact = join(releaseDirectory, "whitelily-0.0.9-windows-x64.zip");
    const rejectedArtifactExists = await stat(rejectedArtifact)
      .then(() => true)
      .catch(() => false);
    if (!dirtyHeadMismatchRejected || rejectedArtifactExists) {
      throw new Error("Package accepted a dirty HEAD/worktree mismatch.");
    }
    await run("git", ["restore", "src/head-only.txt"], fixture);
    await run("git", ["reset", "--hard", "HEAD~1"], fixture);
    await run(
      "powershell",
      powershellArguments(join(fixture, "scripts", "package-release.ps1"), ["-Version", version]),
      fixture,
    );
    const zip = join(releaseDirectory, `whitelily-${version}-windows-x64.zip`);
    await access(zip);
    await access(`${zip}.sha256`);
    const firstHash = createHash("sha256")
      .update(await readFile(zip))
      .digest("hex");
    const rawEntries = (await run("tar", ["-tf", zip], fixture))
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const entries = rawEntries.map((entry) => entry.replaceAll("\\", "/"));
    const entrySet = new Set(entries);
    const readmeLocalLinks: string[] = [];
    for (const readme of ["README.md", "README.zh-CN.md"]) {
      const packagedReadme = await run("tar", ["-xOf", zip, readme], fixture);
      for (const match of packagedReadme.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
        const rawTarget = match[1]!.trim().replace(/^<|>$/gu, "");
        if (rawTarget.startsWith("#") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rawTarget)) {
          continue;
        }
        const withoutFragment = rawTarget.split("#", 1)[0]!;
        if (!withoutFragment) continue;
        readmeLocalLinks.push(posix.normalize(posix.join(posix.dirname(readme), withoutFragment)));
      }
    }
    const uniqueReadmeLocalLinks = [...new Set(readmeLocalLinks)].sort();
    const missingReadmeLocalLinks = uniqueReadmeLocalLinks.filter(
      (target) => !entrySet.has(target),
    );
    const credentialEntry = `src/${credentialName}.txt`;
    const hasUntrackedCredential = entries.includes(credentialEntry);
    const checksum = (await readFile(`${zip}.sha256`, "utf8")).trim().split(/\s+/)[0];
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2200));
    await run(
      "powershell",
      powershellArguments(join(fixture, "scripts", "package-release.ps1"), ["-Version", version]),
      fixture,
    );
    const secondHash = createHash("sha256")
      .update(await readFile(zip))
      .digest("hex");
    const stagingRemoved = await stat(join(releaseDirectory, `whitelily-${version}`))
      .then(() => false)
      .catch(() => true);
    return {
      hasChecksum: true,
      stagingRemoved,
      entries,
      rawEntries,
      hasUntrackedCredential,
      dirtyHeadMismatchRejected,
      checksumMatches: checksum === firstHash,
      firstHash,
      secondHash,
      readmeLocalLinks: uniqueReadmeLocalLinks,
      missingReadmeLocalLinks,
    };
  } finally {
    if (basename(fixture).startsWith("whitelily-release-package-")) {
      await rm(fixture, { recursive: true, force: true });
    }
  }
}

async function createScanFixture(prefix: string): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(fixture, "scripts"), { recursive: true });
  await mkdir(join(fixture, "src"), { recursive: true });
  await cp(
    join(repositoryRoot, "scripts", "release-check.ps1"),
    join(fixture, "scripts", "release-check.ps1"),
  );
  await cp(
    join(repositoryRoot, "scripts", "prepare-public-repo.ps1"),
    join(fixture, "scripts", "prepare-public-repo.ps1"),
  );
  await writeFile(join(fixture, "src", "safe.txt"), "safe fixture\n", "utf8");
  await run("git", ["init", "-b", "main"], fixture);
  await run("git", ["config", "core.autocrlf", "false"], fixture);
  return fixture;
}

async function commitFixture(fixture: string): Promise<void> {
  await run("git", ["add", "."], fixture);
  await run(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    fixture,
  );
}

async function scanFails(fixture: string): Promise<boolean> {
  return commandFails(
    "powershell",
    powershellArguments(join(fixture, "scripts", "release-check.ps1"), ["-ScanOnly"]),
    fixture,
  );
}

export async function runReleaseSecurityRegressions(): Promise<{
  dirtyHeadExportRejected: boolean;
  utf16LeRejected: boolean;
  utf16BeRejected: boolean;
  escapedOwnerRejected: boolean;
  escapedBackslashLowerOwnerRejected: boolean;
  escapedBackslashUpperOwnerRejected: boolean;
  malformedOwnerRejected: boolean;
  sourceOwnerCandidateRejected: boolean;
}> {
  const fixtures: string[] = [];
  try {
    const dirty = await createScanFixture("whitelily-dirty-head-");
    fixtures.push(dirty);
    const secret = ["sk", "release", "head", "fixture", "credential", "1234567890"].join("-");
    await writeFile(join(dirty, "src", "head-only.txt"), secret, "utf8");
    await commitFixture(dirty);
    await rm(join(dirty, "src", "head-only.txt"));
    const dirtyHeadExportRejected = await commandFails(
      "powershell",
      powershellArguments(join(dirty, "scripts", "prepare-public-repo.ps1")),
      dirty,
    );

    const utf16Le = await createScanFixture("whitelily-utf16-le-");
    fixtures.push(utf16Le);
    await writeFile(
      join(utf16Le, "src", "encoded.txt"),
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(
          ["sk", "utf16", "fixture", "credential", "1234567890"].join("-") + "\n",
          "utf16le",
        ),
      ]),
    );
    await commitFixture(utf16Le);
    const utf16LeRejected = await scanFails(utf16Le);

    const utf16Be = await createScanFixture("whitelily-utf16-be-");
    fixtures.push(utf16Be);
    const beText = ["sk", "utf16", "fixture", "credential", "1234567890"].join("-") + "\n";
    const beBytes = Buffer.alloc(beText.length * 2 + 2);
    beBytes[0] = 0xfe;
    beBytes[1] = 0xff;
    for (let index = 0; index < beText.length; index += 1)
      beBytes.writeUInt16BE(beText.charCodeAt(index), index * 2 + 2);
    await writeFile(join(utf16Be, "src", "encoded.txt"), beBytes);
    await commitFixture(utf16Be);
    const utf16BeRejected = await scanFails(utf16Be);

    const escapedOwner = await createScanFixture("whitelily-owner-escaped-");
    fixtures.push(escapedOwner);
    await writeFile(join(escapedOwner, "src", "owner.txt"), "Lily☃\n", "utf8");
    await commitFixture(escapedOwner);
    await writeFile(join(escapedOwner, "config.toml"), 'owner_username = "Lily\\u2603"\n', "utf8");
    const escapedOwnerRejected = await scanFails(escapedOwner);

    const escapedBackslashLowerOwner = await createScanFixture("whitelily-owner-lower-");
    fixtures.push(escapedBackslashLowerOwner);
    await writeFile(join(escapedBackslashLowerOwner, "src", "owner.txt"), "Lily\\u2603\n", "utf8");
    await commitFixture(escapedBackslashLowerOwner);
    await writeFile(
      join(escapedBackslashLowerOwner, "config.toml"),
      'owner_username = "Lily\\\\u2603"\n',
      "utf8",
    );
    const escapedBackslashLowerOwnerRejected = await scanFails(escapedBackslashLowerOwner);

    const escapedBackslashUpperOwner = await createScanFixture("whitelily-owner-upper-");
    fixtures.push(escapedBackslashUpperOwner);
    await writeFile(
      join(escapedBackslashUpperOwner, "src", "owner.txt"),
      "Lily\\U0001F98A\n",
      "utf8",
    );
    await commitFixture(escapedBackslashUpperOwner);
    await writeFile(
      join(escapedBackslashUpperOwner, "config.toml"),
      'owner_username = "Lily\\\\U0001F98A"\n',
      "utf8",
    );
    const escapedBackslashUpperOwnerRejected = await scanFails(escapedBackslashUpperOwner);

    const malformedOwner = await createScanFixture("whitelily-owner-malformed-");
    fixtures.push(malformedOwner);
    await commitFixture(malformedOwner);
    await writeFile(
      join(malformedOwner, "config.toml"),
      "owner_username = not-a-toml-string\n",
      "utf8",
    );
    const malformedOwnerRejected = await scanFails(malformedOwner);

    const sourceOwnerCandidate = await createScanFixture("whitelily-owner-candidate-");
    fixtures.push(sourceOwnerCandidate);
    const sourceOwner = "CandidateFixtureOwner";
    await writeFile(
      join(sourceOwnerCandidate, "src", "owner.txt"),
      `tracked identity ${sourceOwner}\n`,
      "utf8",
    );
    await commitFixture(sourceOwnerCandidate);
    await writeFile(
      join(sourceOwnerCandidate, "config.toml"),
      `[minecraft]\nowner_username = "${sourceOwner}"\n`,
      "utf8",
    );
    const sourceOwnerCandidateRejected = await commandFails(
      "powershell",
      powershellArguments(join(sourceOwnerCandidate, "scripts", "prepare-public-repo.ps1"), [
        "-InitializeFreshHistory",
      ]),
      sourceOwnerCandidate,
    );

    return {
      dirtyHeadExportRejected,
      utf16LeRejected,
      utf16BeRejected,
      escapedOwnerRejected,
      escapedBackslashLowerOwnerRejected,
      escapedBackslashUpperOwnerRejected,
      malformedOwnerRejected,
      sourceOwnerCandidateRejected,
    };
  } finally {
    await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
  }
}

export async function runReleaseJunctionRegressions(): Promise<{
  prepareRejectedWithoutExternalMutation: boolean;
  packageRejectedWithoutExternalMutation: boolean;
  payloadRejectedWithoutExternalMutation: boolean;
}> {
  const fixture = await mkdtemp(join(tmpdir(), "whitelily-release-junction-"));
  const external = await mkdtemp(join(tmpdir(), "whitelily-release-external-"));
  const releaseLink = join(fixture, "release");
  const payloadLink = join(fixture, "payload", "linked-directory");
  try {
    await mkdir(join(fixture, "scripts"), { recursive: true });
    await mkdir(join(fixture, "docs"), { recursive: true });
    await mkdir(join(fixture, "src"), { recursive: true });
    for (const script of [
      "prepare-public-repo.ps1",
      "package-release.ps1",
      "release-check.ps1",
      "release-path-safety.ps1",
    ]) {
      const source = join(repositoryRoot, "scripts", script);
      if (
        await stat(source)
          .then(() => true)
          .catch(() => false)
      ) {
        await cp(source, join(fixture, "scripts", script));
      }
    }
    await cp(
      join(repositoryRoot, "docs", "windows-smoke-test.md"),
      join(fixture, "docs", "windows-smoke-test.md"),
    );
    await cp(join(repositoryRoot, "config.example.toml"), join(fixture, "config.example.toml"));
    await writeFile(join(fixture, "src", "safe.txt"), "safe fixture\n", "utf8");
    await writeFile(
      join(fixture, "package.json"),
      '{\n  "name": "whitelily-junction-fixture",\n  "version": "0.1.0",\n  "private": true,\n  "scripts": {\n    "format:check": "node -e \\\"\\\"",\n    "typecheck": "node -e \\\"\\\"",\n    "test": "node -e \\\"\\\" --",\n    "build": "node -e \\\"\\\""\n  }\n}\n',
      "utf8",
    );
    await writeFile(
      join(fixture, "package-lock.json"),
      '{\n  "name": "whitelily-junction-fixture",\n  "version": "0.1.0",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "whitelily-junction-fixture",\n      "version": "0.1.0"\n    }\n  }\n}\n',
      "utf8",
    );
    await run("git", ["init", "-b", "main"], fixture);
    await run("git", ["config", "core.autocrlf", "false"], fixture);
    await commitFixture(fixture);

    const payload = join(fixture, "payload");
    const payloadTarget = join(external, "payload-target");
    const payloadSentinel = join(payloadTarget, "outside-sentinel.txt");
    await mkdir(payload, { recursive: true });
    await mkdir(payloadTarget, { recursive: true });
    await writeFile(payloadSentinel, "must survive\n", "utf8");
    await symlink(payloadTarget, payloadLink, "junction");
    const payloadRejected = await commandFails(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `. '${join(fixture, "scripts", "release-path-safety.ps1").replaceAll("'", "''")}'; Get-SafePayloadFiles '${payload.replaceAll("'", "''")}' | Out-Null`,
      ],
      fixture,
    );
    const payloadSentinelSurvived = await stat(payloadSentinel)
      .then(() => true)
      .catch(() => false);

    const prepareTarget = join(external, "public-repo");
    const prepareSentinel = join(prepareTarget, "outside-sentinel.txt");
    await mkdir(prepareTarget, { recursive: true });
    await writeFile(prepareSentinel, "must survive\n", "utf8");
    await symlink(external, releaseLink, "junction");
    const prepareRejected = await commandFails(
      "powershell",
      powershellArguments(join(fixture, "scripts", "prepare-public-repo.ps1")),
      fixture,
    );
    const prepareSentinelSurvived = await stat(prepareSentinel)
      .then(() => true)
      .catch(() => false);

    const packageTargets = ["whitelily-9.9.9", "whitelily-9.9.9-export", "whitelily-9.9.9-verify"];
    const packageSentinels: string[] = [];
    for (const target of packageTargets) {
      const sentinel = join(external, target, "outside-sentinel.txt");
      await mkdir(join(external, target), { recursive: true });
      await writeFile(sentinel, "must survive\n", "utf8");
      packageSentinels.push(sentinel);
    }
    const packageRejected = await commandFails(
      "powershell",
      powershellArguments(join(fixture, "scripts", "package-release.ps1"), ["-Version", "9.9.9"]),
      fixture,
    );
    const packageSentinelsSurvived = (
      await Promise.all(
        packageSentinels.map((sentinel) =>
          stat(sentinel)
            .then(() => true)
            .catch(() => false),
        ),
      )
    ).every(Boolean);

    return {
      prepareRejectedWithoutExternalMutation: prepareRejected && prepareSentinelSurvived,
      packageRejectedWithoutExternalMutation: packageRejected && packageSentinelsSurvived,
      payloadRejectedWithoutExternalMutation: payloadRejected && payloadSentinelSurvived,
    };
  } finally {
    await unlink(releaseLink).catch(() => undefined);
    await unlink(payloadLink).catch(() => undefined);
    await rm(fixture, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
}
