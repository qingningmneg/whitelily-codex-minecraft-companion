import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  provisionCodexWorkspace,
  WorkspaceProvisionError,
  type WorkspaceProvisionFileOperations,
} from "./codexWorkspaceProvisioner.js";

const CONFIG = '[mcp_servers.minecraft]\nurl = "http://127.0.0.1:32123/mcp"\n';
const AGENTS = "Use only minecraft_ tools.\n";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface Fixture {
  root: string;
  dataRoot: string;
  resourceDirectory: string;
  targetDirectory: string;
}

interface WorkspaceManifest {
  schemaVersion: 1;
  contentVersion: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

function resource(path: string, contents: string | Buffer) {
  const bytes = Buffer.from(contents);
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function manifest(
  contentVersion: string,
  payloads: { config?: string; agents?: string } = {},
): WorkspaceManifest {
  const config = payloads.config ?? CONFIG;
  const agents = payloads.agents ?? AGENTS;
  return {
    schemaVersion: 1,
    contentVersion,
    files: [resource(".codex/config.toml", config), resource("AGENTS.md", agents)],
  };
}

async function writeTree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [portablePath, contents] of Object.entries(files)) {
    const path = resolve(root, ...portablePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

async function writeResource(
  resourceDirectory: string,
  options: {
    contentVersion?: string;
    config?: string;
    agents?: string;
    manifestOverride?: unknown;
    extra?: Record<string, string>;
  } = {},
): Promise<void> {
  const config = options.config ?? CONFIG;
  const agents = options.agents ?? AGENTS;
  await writeTree(resourceDirectory, {
    ".codex/config.toml": config,
    "AGENTS.md": agents,
    "workspace-manifest.json": `${JSON.stringify(
      options.manifestOverride ?? manifest(options.contentVersion ?? "1", { config, agents }),
      null,
      2,
    )}\n`,
    ...options.extra,
  });
}

async function createFixture(options: Parameters<typeof writeResource>[1] = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "whitelily-provisioner-"));
  temporaryRoots.push(root);
  const dataRoot = join(root, "data");
  const resourceDirectory = join(root, "resources", "codex-workspace");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(resourceDirectory, { recursive: true });
  await writeResource(resourceDirectory, options);
  return {
    root,
    dataRoot,
    resourceDirectory,
    targetDirectory: join(dataRoot, "codex-workspace"),
  };
}

async function residueNames(dataRoot: string): Promise<string[]> {
  return (await readdir(dataRoot))
    .filter(
      (name) =>
        name.startsWith(".codex-workspace-staging-") || name.startsWith(".codex-workspace-backup-"),
    )
    .sort();
}

function actualOperations(
  overrides: Partial<WorkspaceProvisionFileOperations> = {},
): WorkspaceProvisionFileOperations {
  return {
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    ...overrides,
  };
}

describe("provisionCodexWorkspace", () => {
  it("installs the complete attested workspace into an empty data root", async () => {
    const fixture = await createFixture();

    await expect(
      provisionCodexWorkspace({
        resourceDirectory: fixture.resourceDirectory,
        dataRoot: fixture.dataRoot,
      }),
    ).resolves.toEqual({
      contentVersion: "1",
      installed: true,
      repaired: false,
      targetDirectory: resolve(fixture.targetDirectory),
    });
    await expect(readFile(join(fixture.targetDirectory, "AGENTS.md"), "utf8")).resolves.toBe(
      AGENTS,
    );
    await expect(
      readFile(join(fixture.targetDirectory, ".codex", "config.toml"), "utf8"),
    ).resolves.toBe(CONFIG);
    await expect(
      readFile(join(fixture.targetDirectory, "workspace-manifest.json"), "utf8"),
    ).resolves.toContain('"contentVersion": "1"');
    await expect(residueNames(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("returns a verified idempotent result without staging or backup residue", async () => {
    const fixture = await createFixture();
    await provisionCodexWorkspace(fixture);

    await expect(provisionCodexWorkspace(fixture)).resolves.toEqual({
      contentVersion: "1",
      installed: false,
      repaired: false,
      targetDirectory: resolve(fixture.targetDirectory),
    });
    await expect(residueNames(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("atomically replaces a valid older managed content version", async () => {
    const fixture = await createFixture({ contentVersion: "old", agents: "old agents\n" });
    await provisionCodexWorkspace(fixture);
    await rm(fixture.resourceDirectory, { recursive: true });
    await mkdir(fixture.resourceDirectory, { recursive: true });
    await writeResource(fixture.resourceDirectory, { contentVersion: "2", agents: AGENTS });

    await expect(provisionCodexWorkspace(fixture)).resolves.toEqual({
      contentVersion: "2",
      installed: true,
      repaired: false,
      targetDirectory: resolve(fixture.targetDirectory),
    });
    await expect(readFile(join(fixture.targetDirectory, "AGENTS.md"), "utf8")).resolves.toBe(
      AGENTS,
    );
    await expect(residueNames(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("repairs a modified managed file from the attested resources", async () => {
    const fixture = await createFixture();
    await provisionCodexWorkspace(fixture);
    await writeFile(join(fixture.targetDirectory, "AGENTS.md"), "modified by user\n");

    await expect(provisionCodexWorkspace(fixture)).resolves.toEqual({
      contentVersion: "1",
      installed: true,
      repaired: true,
      targetDirectory: resolve(fixture.targetDirectory),
    });
    await expect(readFile(join(fixture.targetDirectory, "AGENTS.md"), "utf8")).resolves.toBe(
      AGENTS,
    );
  });

  it("leaves the prior workspace in place when copying the candidate fails", async () => {
    const fixture = await createFixture({ contentVersion: "old", agents: "old agents\n" });
    await provisionCodexWorkspace(fixture);
    await rm(fixture.resourceDirectory, { recursive: true });
    await mkdir(fixture.resourceDirectory, { recursive: true });
    await writeResource(fixture.resourceDirectory, { contentVersion: "2" });
    const operations = actualOperations({
      copyFile: async () => {
        throw new Error("injected copy failure");
      },
    });

    await expect(provisionCodexWorkspace(fixture, operations)).rejects.toMatchObject({
      name: "WorkspaceProvisionError",
      code: "WORKSPACE_DEPLOY_FAILED",
    });
    await expect(readFile(join(fixture.targetDirectory, "AGENTS.md"), "utf8")).resolves.toBe(
      "old agents\n",
    );
    await expect(residueNames(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("restores the prior workspace when final installed-byte verification fails", async () => {
    const fixture = await createFixture({ contentVersion: "old", agents: "old agents\n" });
    await provisionCodexWorkspace(fixture);
    await rm(fixture.resourceDirectory, { recursive: true });
    await mkdir(fixture.resourceDirectory, { recursive: true });
    await writeResource(fixture.resourceDirectory, { contentVersion: "2" });
    let candidatePublished = false;
    const operations = actualOperations({
      rename: async (source, destination) => {
        await rename(source, destination);
        if (basename(source).startsWith(".codex-workspace-staging-")) candidatePublished = true;
      },
      readFile: async (path) => {
        if (candidatePublished && resolve(path).startsWith(resolve(fixture.targetDirectory))) {
          throw new Error("injected installed verification failure");
        }
        return readFile(path);
      },
    });

    await expect(provisionCodexWorkspace(fixture, operations)).rejects.toMatchObject({
      name: "WorkspaceProvisionError",
      code: "WORKSPACE_DEPLOY_FAILED",
    });
    await expect(readFile(join(fixture.targetDirectory, "AGENTS.md"), "utf8")).resolves.toBe(
      "old agents\n",
    );
    await expect(residueNames(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("keeps the verified new target when post-commit backup cleanup partially fails", async () => {
    const fixture = await createFixture({
      contentVersion: "old",
      config: "old config\n",
      agents: "old agents\n",
    });
    await provisionCodexWorkspace(fixture);
    await rm(fixture.resourceDirectory, { recursive: true });
    await mkdir(fixture.resourceDirectory, { recursive: true });
    await writeResource(fixture.resourceDirectory, { contentVersion: "2" });
    const diagnostics: string[] = [];
    const operations = actualOperations({
      rm: async (path, options) => {
        if (basename(path).startsWith(".codex-workspace-backup-")) {
          const backedUpWorkspace = (await readdir(path)).includes("codex-workspace")
            ? join(path, "codex-workspace")
            : path;
          await rm(join(backedUpWorkspace, ".codex"), { recursive: true, force: true });
          throw new Error("injected partial backup cleanup failure");
        }
        await rm(path, options);
      },
    });

    await expect(
      provisionCodexWorkspace(
        {
          ...fixture,
          diagnostic: (code: string) => diagnostics.push(code),
        },
        operations,
      ),
    ).resolves.toEqual({
      contentVersion: "2",
      installed: true,
      repaired: false,
      targetDirectory: resolve(fixture.targetDirectory),
    });
    await expect(readFile(join(fixture.targetDirectory, "AGENTS.md"), "utf8")).resolves.toBe(
      AGENTS,
    );
    await expect(
      readFile(join(fixture.targetDirectory, ".codex", "config.toml"), "utf8"),
    ).resolves.toBe(CONFIG);
    expect(diagnostics).toEqual(["WORKSPACE_BACKUP_CLEANUP_FAILED"]);
    await expect(residueNames(fixture.dataRoot)).resolves.toHaveLength(1);
  });

  it("reports a stable rollback failure when publishing and restoring both fail", async () => {
    const fixture = await createFixture({ contentVersion: "old", agents: "old agents\n" });
    await provisionCodexWorkspace(fixture);
    await rm(fixture.resourceDirectory, { recursive: true });
    await mkdir(fixture.resourceDirectory, { recursive: true });
    await writeResource(fixture.resourceDirectory, { contentVersion: "2" });
    const operations = actualOperations({
      rename: async (source, destination) => {
        const name = basename(source);
        if (
          name.startsWith(".codex-workspace-staging-") ||
          name.startsWith(".codex-workspace-backup-") ||
          basename(dirname(source)).startsWith(".codex-workspace-backup-")
        ) {
          throw new Error("injected rename failure");
        }
        await rename(source, destination);
      },
    });

    await expect(provisionCodexWorkspace(fixture, operations)).rejects.toMatchObject({
      name: "WorkspaceProvisionError",
      code: "WORKSPACE_ROLLBACK_FAILED",
    });
  });

  it("does not report deployment rollback success until the prior target identity is restored", async () => {
    const fixture = await createFixture({ contentVersion: "old", agents: "old agents\n" });
    await provisionCodexWorkspace(fixture);
    await rm(fixture.resourceDirectory, { recursive: true });
    await mkdir(fixture.resourceDirectory, { recursive: true });
    await writeResource(fixture.resourceDirectory, { contentVersion: "2" });
    const operations = actualOperations({
      rename: async (source, destination) => {
        if (basename(source).startsWith(".codex-workspace-staging-")) {
          throw new Error("injected publish failure");
        }
        if (basename(dirname(source)).startsWith(".codex-workspace-backup-")) {
          return;
        }
        await rename(source, destination);
      },
    });

    await expect(provisionCodexWorkspace(fixture, operations)).rejects.toMatchObject({
      name: "WorkspaceProvisionError",
      code: "WORKSPACE_ROLLBACK_FAILED",
    });
  });

  it.each([
    ["malformed JSON", "{not-json"],
    ["an unsupported schema", JSON.stringify({ ...manifest("1"), schemaVersion: 2 })],
    ["an unbounded content version", JSON.stringify(manifest("x".repeat(65)))],
  ])("rejects %s as a stable resource failure", async (_label, manifestText) => {
    const fixture = await createFixture();
    await writeFile(join(fixture.resourceDirectory, "workspace-manifest.json"), manifestText);

    const error = await provisionCodexWorkspace(fixture).catch((caught) => caught);

    expect(error).toBeInstanceOf(WorkspaceProvisionError);
    expect(error).toMatchObject({ code: "WORKSPACE_RESOURCE_INVALID" });
    await expect(readdir(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("rejects a manifest hash that does not attest the source bytes", async () => {
    const invalid = manifest("1");
    invalid.files[1] = { ...invalid.files[1]!, sha256: "0".repeat(64) };
    const fixture = await createFixture({ manifestOverride: invalid });

    await expect(provisionCodexWorkspace(fixture)).rejects.toMatchObject({
      code: "WORKSPACE_RESOURCE_INVALID",
    });
    await expect(readdir(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("rejects unexpected resource entries instead of copying them", async () => {
    const fixture = await createFixture({ extra: { "rogue.txt": "rogue" } });

    await expect(provisionCodexWorkspace(fixture)).rejects.toMatchObject({
      code: "WORKSPACE_RESOURCE_INVALID",
    });
    await expect(readdir(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("rejects a linked source payload that resolves outside the resource root", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside-source");
    await mkdir(outside);
    await writeFile(join(outside, "config.toml"), CONFIG);
    await rm(join(fixture.resourceDirectory, ".codex"), { recursive: true });
    await symlink(outside, join(fixture.resourceDirectory, ".codex"), "junction");

    await expect(provisionCodexWorkspace(fixture)).rejects.toMatchObject({
      code: "WORKSPACE_RESOURCE_INVALID",
    });
    await expect(readdir(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("rejects a manifest path escape before creating deployment residue", async () => {
    const fixture = await createFixture({
      manifestOverride: {
        schemaVersion: 1,
        contentVersion: "1",
        files: [resource("../outside.txt", "outside"), resource("AGENTS.md", AGENTS)],
      },
    });

    await expect(provisionCodexWorkspace(fixture)).rejects.toMatchObject({
      code: "WORKSPACE_RESOURCE_INVALID",
    });
    await expect(readdir(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("rejects an existing target link outside the data root before mutation", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "outside-target");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "untouched");
    await symlink(outside, fixture.targetDirectory, "junction");

    await expect(provisionCodexWorkspace(fixture)).rejects.toMatchObject({
      code: "WORKSPACE_RESOURCE_INVALID",
    });
    await expect(readFile(join(outside, "sentinel.txt"), "utf8")).resolves.toBe("untouched");
    await expect(residueNames(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("maps a target preflight race to the stable resource error before mutation", async () => {
    const fixture = await createFixture();
    let targetChecks = 0;
    const operations = actualOperations({
      lstat: async (path) => {
        if (resolve(path) === resolve(fixture.targetDirectory)) {
          targetChecks += 1;
          if (targetChecks === 2) throw new Error("injected target race");
        }
        return lstat(path);
      },
    });

    await expect(provisionCodexWorkspace(fixture, operations)).rejects.toMatchObject({
      name: "WorkspaceProvisionError",
      code: "WORKSPACE_RESOURCE_INVALID",
    });
    await expect(readdir(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("cleans an in-root staging directory when its post-create realpath check fails", async () => {
    const fixture = await createFixture();
    let createdStaging: string | undefined;
    const operations = actualOperations({
      mkdtemp: async (prefix) => {
        createdStaging = await mkdtemp(prefix);
        return createdStaging;
      },
      realpath: async (path) => {
        if (createdStaging !== undefined && resolve(path) === resolve(createdStaging)) {
          throw new Error("injected staging realpath failure");
        }
        return realpath(path);
      },
    });

    await expect(provisionCodexWorkspace(fixture, operations)).rejects.toMatchObject({
      code: "WORKSPACE_DEPLOY_FAILED",
    });
    await expect(residueNames(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("reports rollback failure when an invalid staging directory cannot be cleaned", async () => {
    const fixture = await createFixture();
    let createdStaging: string | undefined;
    const operations = actualOperations({
      mkdtemp: async (prefix) => {
        createdStaging = await mkdtemp(prefix);
        return createdStaging;
      },
      realpath: async (path) => {
        if (createdStaging !== undefined && resolve(path) === resolve(createdStaging)) {
          throw new Error("injected staging realpath failure");
        }
        return realpath(path);
      },
      rm: async (path, options) => {
        if (createdStaging !== undefined && resolve(path) === resolve(createdStaging)) {
          throw new Error("injected staging cleanup failure");
        }
        await rm(path, options);
      },
    });

    await expect(provisionCodexWorkspace(fixture, operations)).rejects.toMatchObject({
      code: "WORKSPACE_ROLLBACK_FAILED",
    });
    await expect(residueNames(fixture.dataRoot)).resolves.toHaveLength(1);
  });

  it("removes an outside directory returned by a broken staging creator", async () => {
    const fixture = await createFixture();
    let outsideStaging: string | undefined;
    const operations = actualOperations({
      mkdtemp: async (prefix) => {
        if (basename(prefix) === ".codex-workspace-staging-") {
          outsideStaging = await mkdtemp(join(fixture.root, "outside-staging-"));
          return outsideStaging;
        }
        return mkdtemp(prefix);
      },
    });

    await expect(provisionCodexWorkspace(fixture, operations)).rejects.toMatchObject({
      code: "WORKSPACE_DEPLOY_FAILED",
    });
    await expect(residueNames(fixture.dataRoot)).resolves.toEqual([]);
    expect(outsideStaging).toBeDefined();
    await expect(lstat(outsideStaging!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates the original data root identity immediately before staging mutation", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "replacement-root");
    await mkdir(outside);
    let dataRootRealpathChecks = 0;
    const operations = actualOperations({
      realpath: async (path) => {
        if (resolve(path) === resolve(fixture.dataRoot)) {
          dataRootRealpathChecks += 1;
          if (dataRootRealpathChecks === 2) return outside;
        }
        return realpath(path);
      },
    });

    await expect(provisionCodexWorkspace(fixture, operations)).rejects.toMatchObject({
      code: "WORKSPACE_DEPLOY_FAILED",
    });
    expect(dataRootRealpathChecks).toBeGreaterThanOrEqual(2);
    await expect(readdir(fixture.dataRoot)).resolves.toEqual([]);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("revalidates an initially absent target after staging creation and before copying", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.root, "raced-target");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "untouched");
    let copies = 0;
    const operations = actualOperations({
      mkdtemp: async (prefix) => {
        const staging = await mkdtemp(prefix);
        if (basename(prefix) === ".codex-workspace-staging-") {
          await symlink(outside, fixture.targetDirectory, "junction");
        }
        return staging;
      },
      copyFile: async (source, destination) => {
        copies += 1;
        await copyFile(source, destination);
      },
    });

    await expect(provisionCodexWorkspace(fixture, operations)).rejects.toMatchObject({
      code: "WORKSPACE_DEPLOY_FAILED",
    });
    expect(copies).toBe(0);
    await expect(readFile(join(outside, "sentinel.txt"), "utf8")).resolves.toBe("untouched");
    await expect(residueNames(fixture.dataRoot)).resolves.toEqual([]);
  });

  it("uses an exclusive same-root temporary reservation for the backup", async () => {
    const fixture = await createFixture({ contentVersion: "old", agents: "old agents\n" });
    await provisionCodexWorkspace(fixture);
    await rm(fixture.resourceDirectory, { recursive: true });
    await mkdir(fixture.resourceDirectory, { recursive: true });
    await writeResource(fixture.resourceDirectory, { contentVersion: "2" });
    const collision = join(fixture.dataRoot, ".codex-workspace-backup-collision");
    await mkdir(collision);
    await writeFile(join(collision, "sentinel.txt"), "untouched");
    let backupReservations = 0;
    const operations = actualOperations({
      mkdtemp: async (prefix) => {
        if (basename(prefix) === ".codex-workspace-backup-") backupReservations += 1;
        return mkdtemp(prefix);
      },
    });

    await expect(provisionCodexWorkspace(fixture, operations)).resolves.toMatchObject({
      contentVersion: "2",
      installed: true,
    });
    expect(backupReservations).toBe(1);
    await expect(readFile(join(collision, "sentinel.txt"), "utf8")).resolves.toBe("untouched");
  });
});
