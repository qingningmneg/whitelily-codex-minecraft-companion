import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { validConfig } from "../support/appHarness.js";

interface RuntimeManifest {
  schemaVersion: 1;
  productVersion: string;
  target: { platform: "win32"; arch: "x64" };
  versions: {
    electron: string;
    electronBuilder: string;
    codex: string;
    codexNative: string;
  };
  paths: {
    childEntry: string;
    codexPackage: string;
    codexNativePackage: string;
    codexExecutable: string;
    licenses: string;
  };
  allowlist: {
    exactFiles: Array<{
      source: string;
      target: string | null;
      bytes: number;
      sha256: string;
    }>;
    requiredFiles: string[];
    executableFiles: string[];
  };
  managedWorkspace?: {
    root: string;
    manifest: string;
    payloads: string[];
    mcpUrl: string;
  };
  policySha256?: string;
  resources?: Array<{ path: string; bytes: number; sha256: string }>;
}

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const sourceManifestPath = join(repositoryRoot, "packaging", "electron", "runtime-manifest.json");
const bundleRoot = join(repositoryRoot, "build", "electron-bundle");
const bundleManifestPath = join(bundleRoot, "runtime-manifest.json");
const prepareScriptPath = join(repositoryRoot, "scripts", "prepare-electron-bundle.ps1");
const workspaceBuilderPath = join(repositoryRoot, "scripts", "build-codex-workspace.mjs");
const workspaceBundleRoot = join(bundleRoot, "codex-workspace");
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const asar = require("@electron/asar") as {
  createPackage: (source: string, destination: string) => Promise<void>;
};
const verifier = require(join(repositoryRoot, "packaging", "electron", "after-pack.cjs")) as {
  verifyResourceDirectory?: (resources: string, sourceManifest: string) => Promise<void>;
  materializePreparedNodeModulesAndVerify?: (
    context: { appOutDir: string },
    preparedBundleRoot: string,
    sourceManifestPath?: string,
  ) => Promise<void>;
};
const desktopAsarPolicy = {
  packageJson: {
    name: "@whitelily/desktop",
    productName: "WhiteLily",
    version: "0.2.0-beta.1",
    main: "dist/main/main.js",
  },
  mappings: [
    { resourceRoot: "desktop/main", asarRoot: "dist/main" },
    { resourceRoot: "desktop/preload", asarRoot: "dist/preload" },
    { resourceRoot: "desktop/renderer", asarRoot: "dist-renderer" },
  ],
};

async function readManifest(path: string): Promise<RuntimeManifest> {
  return JSON.parse(await readFile(path, "utf8")) as RuntimeManifest;
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
      else throw new Error(`unexpected bundle link: ${relative(root, path)}`);
    }
  };
  await visit(root);
  return files.sort();
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function resource(path: string, bytes: Buffer): { path: string; bytes: number; sha256: string } {
  return {
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function writeTree(root: string, files: Record<string, Buffer | string>): Promise<void> {
  for (const [portablePath, contents] of Object.entries(files)) {
    const path = resolve(root, ...portablePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

const workspaceConfig = '[mcp_servers.minecraft]\nurl = "http://127.0.0.1:32123/mcp"\n';
const workspaceAgents = [
  "# codex-workspace/AGENTS.md",
  "",
  "You are the conversational and planning brain for the Minecraft companion 白百合.",
  "",
  "- Use only tools whose names start with `minecraft_` for game actions.",
  "- Do not run shell commands, edit files, write scripts, or inspect credentials.",
  "- Never attempt to bypass a denied or confirmation-required action.",
  "- Return concise Chinese chat suitable for Minecraft.",
  "- Do not add a `[白百合]` prefix.",
  "- Stop after the player-facing response and any necessary bounded tool calls.",
  "",
].join("\n");
const workspacePayloadPaths = [".codex/config.toml", "AGENTS.md"] as const;
const workspaceLoosePaths = [
  "codex-workspace/.codex/config.toml",
  "codex-workspace/AGENTS.md",
  "codex-workspace/workspace-manifest.json",
] as const;

function workspaceInnerManifest(
  payloads: Record<(typeof workspacePayloadPaths)[number], Buffer | string> = {
    ".codex/config.toml": workspaceConfig,
    "AGENTS.md": workspaceAgents,
  },
): {
  schemaVersion: 1;
  contentVersion: "1";
  files: Array<{ path: string; bytes: number; sha256: string }>;
} {
  return {
    schemaVersion: 1,
    contentVersion: "1",
    files: workspacePayloadPaths.map((path) => resource(path, Buffer.from(payloads[path]))),
  };
}

async function runWorkspaceBuilder(sourceRoot: string, stagingRoot: string): Promise<void> {
  await execFileAsync(process.execPath, [workspaceBuilderPath, sourceRoot, stagingRoot], {
    cwd: repositoryRoot,
    windowsHide: true,
  });
}

async function createWorkspaceSource(root: string): Promise<string> {
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  await writeTree(sourceRoot, {
    ".codex/config.toml": workspaceConfig,
    "AGENTS.md": workspaceAgents,
  });
  return sourceRoot;
}

async function createManagedWorkspaceVerifierFixture(options?: {
  payloads?: Partial<Record<(typeof workspacePayloadPaths)[number], Buffer | string>>;
  innerManifest?: Record<string, unknown>;
  extraFiles?: Record<string, Buffer | string>;
  omitActual?: string;
  omitOuter?: string;
  extraOuter?: Array<{ path: string; bytes: number; sha256: string }>;
}): Promise<{ root: string; resources: string; sourcePath: string }> {
  const payloads = {
    ".codex/config.toml": workspaceConfig,
    "AGENTS.md": workspaceAgents,
    ...options?.payloads,
  };
  const innerManifest = options?.innerManifest ?? workspaceInnerManifest(payloads);
  const workspaceFiles: Record<string, Buffer | string> = {
    "codex-workspace/.codex/config.toml": payloads[".codex/config.toml"],
    "codex-workspace/AGENTS.md": payloads["AGENTS.md"],
    "codex-workspace/workspace-manifest.json": `${JSON.stringify(innerManifest, null, 2)}\n`,
    ...options?.extraFiles,
  };
  if (options?.omitActual !== undefined) delete workspaceFiles[options.omitActual];
  const root = await mkdtemp(join(tmpdir(), "whitelily-managed-workspace-"));
  const resources = join(root, "resources");
  const asarSource = join(root, "asar-source");
  await mkdir(resources);
  await mkdir(asarSource);
  await writeTree(resources, workspaceFiles);
  await writeTree(asarSource, {
    "package.json": JSON.stringify(desktopAsarPolicy.packageJson),
  });
  await asar.createPackage(asarSource, join(resources, "app.asar"));

  const sourceManifest = {
    schemaVersion: 1,
    productVersion: "0.2.0-beta.1",
    managedWorkspace: {
      root: "codex-workspace",
      manifest: "codex-workspace/workspace-manifest.json",
      payloads: [...workspacePayloadPaths],
      mcpUrl: "http://127.0.0.1:32123/mcp",
    },
    allowlist: {
      requiredFiles: [...workspaceLoosePaths],
      executableFiles: [],
      scriptFiles: [],
      afterPackFiles: ["app.asar"],
    },
  };
  const sourcePath = join(root, "source-manifest.json");
  await writeFile(sourcePath, JSON.stringify(sourceManifest));
  const resourcesManifest = Object.entries(workspaceFiles)
    .filter(([path]) => path !== options?.omitOuter)
    .map(([path, contents]) => resource(path, Buffer.from(contents)));
  resourcesManifest.push(...(options?.extraOuter ?? []));
  await writeFile(
    join(resources, "runtime-manifest.json"),
    JSON.stringify({
      ...sourceManifest,
      policySha256: await sha256(sourcePath),
      resources: resourcesManifest,
    }),
  );
  return { root, resources, sourcePath };
}

async function createVerifierFixture(options?: {
  expectedDesktop?: Record<string, Buffer | string>;
  packagedDesktop?: Record<string, Buffer | string>;
  packageJson?: Record<string, unknown>;
}): Promise<{ root: string; resources: string; sourcePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "whitelily-after-pack-"));
  const resources = join(root, "resources");
  const asarSource = join(root, "asar-source");
  await mkdir(resources);
  await mkdir(asarSource);
  const expectedDesktop = options?.expectedDesktop ?? {};
  const packagedDesktop = options?.packagedDesktop ?? expectedDesktop;
  const sourceManifest = {
    schemaVersion: 1,
    productVersion: "0.2.0-beta.1",
    desktopAsar: desktopAsarPolicy,
    allowlist: {
      requiredFiles: Object.keys(expectedDesktop),
      executableFiles: [],
      scriptFiles: [],
      afterPackFiles: ["app.asar"],
    },
  };
  const sourcePath = join(root, "source-manifest.json");
  await writeFile(sourcePath, JSON.stringify(sourceManifest));
  await writeTree(asarSource, {
    "package.json": JSON.stringify(options?.packageJson ?? desktopAsarPolicy.packageJson),
    ...Object.fromEntries(
      Object.entries(packagedDesktop).map(([path, contents]) => [
        path
          .replace(/^desktop\/main\//u, "dist/main/")
          .replace(/^desktop\/preload\//u, "dist/preload/")
          .replace(/^desktop\/renderer\//u, "dist-renderer/"),
        contents,
      ]),
    ),
  });
  await asar.createPackage(asarSource, join(resources, "app.asar"));
  await writeFile(
    join(resources, "runtime-manifest.json"),
    JSON.stringify({
      ...sourceManifest,
      policySha256: await sha256(sourcePath),
      resources: Object.entries(expectedDesktop).map(([path, contents]) =>
        resource(path, Buffer.from(contents)),
      ),
    }),
  );
  return { root, resources, sourcePath };
}

async function createMaterializationFixture(options?: {
  declaredDependencies?: Record<string, Buffer | string>;
  preparedDependencies?: Record<string, Buffer | string>;
}): Promise<{
  root: string;
  appOutDir: string;
  preparedBundleRoot: string;
  preparedNodeModules: string;
  targetNodeModules: string;
  sourcePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "whitelily-materialize-"));
  const appOutDir = join(root, "app-out");
  const resources = join(appOutDir, "resources");
  const preparedBundleRoot = join(root, "prepared");
  const preparedNodeModules = join(preparedBundleRoot, "core", "node_modules");
  const targetNodeModules = join(resources, "core", "node_modules");
  const asarSource = join(root, "asar-source");
  const declaredDependencies = options?.declaredDependencies ?? {
    "core/node_modules/example/index.js": "reviewed dependency",
  };
  const preparedDependencies = options?.preparedDependencies ?? declaredDependencies;
  const sourceManifest = {
    schemaVersion: 1,
    productVersion: "0.2.0-beta.1",
    allowlist: {
      requiredFiles: Object.keys(declaredDependencies),
      executableFiles: [],
      scriptFiles: [],
      afterPackFiles: ["app.asar"],
    },
  };
  const sourcePath = join(root, "source-manifest.json");
  await mkdir(resources, { recursive: true });
  await mkdir(preparedNodeModules, { recursive: true });
  await mkdir(asarSource);
  await writeFile(sourcePath, JSON.stringify(sourceManifest));
  await writeTree(preparedBundleRoot, preparedDependencies);
  await writeTree(asarSource, {
    "package.json": JSON.stringify(desktopAsarPolicy.packageJson),
  });
  await asar.createPackage(asarSource, join(resources, "app.asar"));
  const embeddedManifest = JSON.stringify({
    ...sourceManifest,
    policySha256: await sha256(sourcePath),
    resources: Object.entries(declaredDependencies).map(([path, contents]) =>
      resource(path, Buffer.from(contents)),
    ),
  });
  await writeFile(join(preparedBundleRoot, "runtime-manifest.json"), embeddedManifest);
  await writeFile(join(resources, "runtime-manifest.json"), embeddedManifest);
  return {
    root,
    appOutDir,
    preparedBundleRoot,
    preparedNodeModules,
    targetNodeModules,
    sourcePath,
  };
}

describe("deterministic Electron resources", () => {
  it("stages exactly the two reviewed workspace payloads and a deterministic manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-workspace-builder-"));
    try {
      const sourceRoot = await createWorkspaceSource(root);
      const stagingA = join(root, "staging-a");
      const stagingB = join(root, "staging-b");
      await mkdir(stagingA);
      await mkdir(stagingB);

      await runWorkspaceBuilder(sourceRoot, stagingA);
      await runWorkspaceBuilder(sourceRoot, stagingB);

      expect(await filesUnder(stagingA)).toEqual([
        ".codex/config.toml",
        "AGENTS.md",
        "workspace-manifest.json",
      ]);
      const manifestText = await readFile(join(stagingA, "workspace-manifest.json"), "utf8");
      expect(manifestText).toBe(`${JSON.stringify(workspaceInnerManifest(), null, 2)}\n`);
      expect(await readFile(join(stagingB, "workspace-manifest.json"), "utf8")).toBe(manifestText);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a workspace source with a missing reviewed payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-workspace-builder-"));
    try {
      const sourceRoot = await createWorkspaceSource(root);
      const stagingRoot = join(root, "staging");
      await mkdir(stagingRoot);
      await rm(join(sourceRoot, "AGENTS.md"));

      await expect(runWorkspaceBuilder(sourceRoot, stagingRoot)).rejects.toThrow(
        /missing.*AGENTS|AGENTS.*missing/iu,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a workspace source with an extra file", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-workspace-builder-"));
    try {
      const sourceRoot = await createWorkspaceSource(root);
      const stagingRoot = join(root, "staging");
      await mkdir(stagingRoot);
      await writeFile(join(sourceRoot, "rogue.txt"), "rogue");

      await expect(runWorkspaceBuilder(sourceRoot, stagingRoot)).rejects.toThrow(
        /unexpected|allowlist|extra/iu,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink or reparse point in the workspace source", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-workspace-builder-"));
    try {
      const sourceRoot = await createWorkspaceSource(root);
      const stagingRoot = join(root, "staging");
      const outside = join(root, "outside-codex");
      await mkdir(stagingRoot);
      await mkdir(outside);
      await writeFile(join(outside, "config.toml"), workspaceConfig);
      await rm(join(sourceRoot, ".codex"), { recursive: true, force: true });
      await symlink(outside, join(sourceRoot, ".codex"), "junction");

      await expect(runWorkspaceBuilder(sourceRoot, stagingRoot)).rejects.toThrow(
        /link|reparse|real file/iu,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing managed workspace payload after packing", async () => {
    const fixture = await createManagedWorkspaceVerifierFixture({
      omitActual: "codex-workspace/AGENTS.md",
    });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/workspace|AGENTS|required|missing/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an extra file in the managed workspace after packing", async () => {
    const fixture = await createManagedWorkspaceVerifierFixture({
      extraFiles: { "codex-workspace/rogue.txt": "rogue" },
    });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/workspace|unexpected|extra/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["../AGENTS.md", "C:/AGENTS.md"])(
    "rejects the unsafe managed workspace manifest path %s",
    async (unsafePath) => {
      const innerManifest = workspaceInnerManifest();
      innerManifest.files[1] = { ...innerManifest.files[1]!, path: unsafePath };
      const fixture = await createManagedWorkspaceVerifierFixture({ innerManifest });
      try {
        await expect(
          verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
        ).rejects.toThrow(/workspace|manifest|path|absolute|escape/iu);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a non-loopback Minecraft MCP URL after packing", async () => {
    const unsafeConfig = '[mcp_servers.minecraft]\nurl = "http://0.0.0.0:32123/mcp"\n';
    const payloads = {
      ".codex/config.toml": unsafeConfig,
      "AGENTS.md": workspaceAgents,
    };
    const fixture = await createManagedWorkspaceVerifierFixture({
      payloads,
      innerManifest: workspaceInnerManifest(payloads),
    });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/workspace|loopback|127\.0\.0\.1|MCP/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a managed workspace payload hash changed inside its manifest", async () => {
    const innerManifest = workspaceInnerManifest();
    innerManifest.files[1] = { ...innerManifest.files[1]!, sha256: "0".repeat(64) };
    const fixture = await createManagedWorkspaceVerifierFixture({ innerManifest });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/workspace|hash|SHA-256/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a link or reparse point in the managed workspace after packing", async () => {
    const fixture = await createManagedWorkspaceVerifierFixture();
    try {
      const codexPath = join(fixture.resources, "codex-workspace", ".codex");
      const outside = join(fixture.root, "outside-codex");
      await mkdir(outside);
      await writeFile(join(outside, "config.toml"), workspaceConfig);
      await rm(codexPath, { recursive: true, force: true });
      await symlink(outside, codexPath, "junction");

      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/workspace|link|reparse|runtime resources/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a workspace manifest omitted from the outer runtime manifest", async () => {
    const fixture = await createManagedWorkspaceVerifierFixture({
      omitOuter: "codex-workspace/workspace-manifest.json",
    });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/outer|runtime|manifest|required|unexpected/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an uppercase outer-manifest alias of a managed workspace payload", async () => {
    const fixture = await createManagedWorkspaceVerifierFixture({
      extraOuter: [resource("CODEX-WORKSPACE/AGENTS.md", Buffer.from(workspaceAgents))],
    });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/alias|canonical|case|duplicate/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("recognizes a case-insensitive workspace prefix but rejects non-exact path spelling", async () => {
    const fixture = await createManagedWorkspaceVerifierFixture({
      omitOuter: "codex-workspace/AGENTS.md",
      extraOuter: [resource("CODEX-WORKSPACE/AGENTS.md", Buffer.from(workspaceAgents))],
    });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/alias|canonical|exact spelling/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    "codex-workspace/AGENTS.md.",
    "codex-workspace/AGENTS.md ",
    "codex-workspace/AGENTS.md:stream",
  ])("rejects the noncanonical Windows outer-manifest path %s", async (path) => {
    const fixture = await createManagedWorkspaceVerifierFixture({
      extraOuter: [resource(path, Buffer.from(workspaceAgents))],
    });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/Windows|canonical|colon|trailing|path is invalid/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reviews one exact managed workspace policy and one Electron extraResources entry", async () => {
    const manifest = await readManifest(sourceManifestPath);
    const desktopPackage = JSON.parse(
      await readFile(join(repositoryRoot, "apps", "desktop", "package.json"), "utf8"),
    ) as {
      build?: { extraResources?: Array<Record<string, unknown>> };
    };

    expect(manifest.managedWorkspace).toEqual({
      root: "codex-workspace",
      manifest: "codex-workspace/workspace-manifest.json",
      payloads: [".codex/config.toml", "AGENTS.md"],
      mcpUrl: "http://127.0.0.1:32123/mcp",
    });
    expect(
      manifest.allowlist.requiredFiles
        .filter((path) => path.toLowerCase().startsWith("codex-workspace/"))
        .sort(),
    ).toEqual([...workspaceLoosePaths].sort());
    expect(
      desktopPackage.build?.extraResources?.filter((entry) => entry.to === "codex-workspace"),
    ).toEqual([
      {
        from: "../../build/electron-bundle/codex-workspace",
        to: "codex-workspace",
        filter: ["**/*"],
      },
    ]);
  });

  it("prepares exactly the three managed workspace loose resources", async () => {
    expect(await filesUnder(workspaceBundleRoot)).toEqual([
      ".codex/config.toml",
      "AGENTS.md",
      "workspace-manifest.json",
    ]);
    const innerManifest = JSON.parse(
      await readFile(join(workspaceBundleRoot, "workspace-manifest.json"), "utf8"),
    ) as ReturnType<typeof workspaceInnerManifest>;
    expect(innerManifest).toEqual(workspaceInnerManifest());
    const outerManifest = await readManifest(bundleManifestPath);
    const outerPaths = new Set(outerManifest.resources?.map((entry) => entry.path));
    expect(workspaceLoosePaths.every((path) => outerPaths.has(path))).toBe(true);
  });

  it("computes SHA-256 without depending on the optional Get-FileHash cmdlet", async () => {
    const script = await readFile(prepareScriptPath, "utf8");

    expect(script).not.toMatch(/\bGet-FileHash\b/u);
    expect(script).toMatch(/System\.Security\.Cryptography\.SHA256/u);
  });

  it("binds after-pack verification to required helpers even if the generated list omits one", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-after-pack-"));
    try {
      const resources = join(root, "resources");
      await mkdir(resources);
      const sourceManifest = {
        schemaVersion: 1,
        productVersion: "0.2.0-beta.1",
        desktopAsar: desktopAsarPolicy,
        allowlist: {
          requiredFiles: [
            {
              path: "codex/native/vendor/x86_64-pc-windows-msvc/bin/codex-code-mode-host.exe",
              bytes: 6,
              sha256: createHash("sha256").update("helper").digest("hex"),
            },
          ],
          executableFiles: [
            "codex/native/vendor/x86_64-pc-windows-msvc/bin/codex-code-mode-host.exe",
          ],
          scriptFiles: [],
          afterPackFiles: ["app.asar"],
        },
      };
      const sourcePath = join(root, "source-manifest.json");
      await writeFile(sourcePath, JSON.stringify(sourceManifest));
      const asarSource = join(root, "asar-source");
      await mkdir(asarSource);
      await writeTree(asarSource, {
        "package.json": JSON.stringify(desktopAsarPolicy.packageJson),
      });
      await asar.createPackage(asarSource, join(resources, "app.asar"));
      await writeFile(
        join(resources, "runtime-manifest.json"),
        JSON.stringify({
          ...sourceManifest,
          policySha256: await sha256(sourcePath),
          resources: [],
        }),
      );
      expect(verifier.verifyResourceDirectory).toBeTypeOf("function");
      await expect(verifier.verifyResourceDirectory?.(resources, sourcePath)).rejects.toThrow(
        /required|missing/iu,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a resource executable that is absent from the reviewed allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-after-pack-"));
    try {
      const resources = join(root, "resources");
      await mkdir(resources);
      const sourceManifest = {
        schemaVersion: 1,
        productVersion: "0.2.0-beta.1",
        desktopAsar: desktopAsarPolicy,
        allowlist: {
          requiredFiles: [],
          executableFiles: [],
          scriptFiles: [],
          afterPackFiles: ["app.asar"],
        },
      };
      const sourcePath = join(root, "source-manifest.json");
      await writeFile(sourcePath, JSON.stringify(sourceManifest));
      const asarSource = join(root, "asar-source");
      await mkdir(asarSource);
      await writeTree(asarSource, {
        "package.json": JSON.stringify(desktopAsarPolicy.packageJson),
      });
      await asar.createPackage(asarSource, join(resources, "app.asar"));
      await writeFile(join(resources, "rogue.exe"), "rogue");
      await writeFile(
        join(resources, "runtime-manifest.json"),
        JSON.stringify({
          ...sourceManifest,
          policySha256: await sha256(sourcePath),
          resources: [],
        }),
      );
      expect(verifier.verifyResourceDirectory).toBeTypeOf("function");
      await expect(verifier.verifyResourceDirectory?.(resources, sourcePath)).rejects.toThrow(
        /allowlist|unexpected/iu,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts the exact reviewed desktop files from app.asar", async () => {
    const fixture = await createVerifierFixture({
      expectedDesktop: {
        "desktop/main/main.js": "main",
        "desktop/preload/preload.cjs": "preload",
        "desktop/renderer/index.html": "<main>WhiteLily</main>",
      },
    });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).resolves.toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects modified desktop bytes read from app.asar", async () => {
    const fixture = await createVerifierFixture({
      expectedDesktop: { "desktop/main/main.js": "trusted" },
      packagedDesktop: { "desktop/main/main.js": "altered" },
    });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/hash|size/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a missing desktop entry in app.asar", async () => {
    const fixture = await createVerifierFixture({
      expectedDesktop: {
        "desktop/main/main.js": "main",
        "desktop/preload/preload.cjs": "preload",
      },
      packagedDesktop: { "desktop/main/main.js": "main" },
    });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/asar|entry|missing/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an undeclared desktop entry in app.asar", async () => {
    const fixture = await createVerifierFixture({
      expectedDesktop: { "desktop/main/main.js": "main" },
      packagedDesktop: {
        "desktop/main/main.js": "main",
        "desktop/main/rogue.js": "rogue",
      },
    });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/asar|entry|unexpected/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an app.asar package identity that differs from reviewed product metadata", async () => {
    const fixture = await createVerifierFixture({
      packageJson: {
        ...desktopAsarPolicy.packageJson,
        main: "rogue.js",
      },
    });
    try {
      await expect(
        verifier.verifyResourceDirectory?.(fixture.resources, fixture.sourcePath),
      ).rejects.toThrow(/asar|package|main|identity/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("materializes only reviewed prepared node_modules before strict final verification", async () => {
    const fixture = await createMaterializationFixture();
    try {
      expect(verifier.materializePreparedNodeModulesAndVerify).toBeTypeOf("function");
      await verifier.materializePreparedNodeModulesAndVerify?.(
        { appOutDir: fixture.appOutDir },
        fixture.preparedBundleRoot,
        fixture.sourcePath,
      );

      expect(await filesUnder(fixture.targetNodeModules)).toEqual(["example/index.js"]);
      expect(await readFile(join(fixture.targetNodeModules, "example", "index.js"), "utf8")).toBe(
        "reviewed dependency",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses to hide an unexpected existing target dependency", async () => {
    const fixture = await createMaterializationFixture();
    try {
      await writeTree(fixture.targetNodeModules, { "rogue.js": "rogue" });

      await expect(
        verifier.materializePreparedNodeModulesAndVerify?.(
          { appOutDir: fixture.appOutDir },
          fixture.preparedBundleRoot,
          fixture.sourcePath,
        ),
      ).rejects.toThrow(/target|non-empty|unexpected/iu);
      expect(await readFile(join(fixture.targetNodeModules, "rogue.js"), "utf8")).toBe("rogue");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an undeclared file in prepared node_modules", async () => {
    const fixture = await createMaterializationFixture({
      preparedDependencies: {
        "core/node_modules/example/index.js": "reviewed dependency",
        "core/node_modules/example/rogue.js": "rogue",
      },
    });
    try {
      await expect(
        verifier.materializePreparedNodeModulesAndVerify?.(
          { appOutDir: fixture.appOutDir },
          fixture.preparedBundleRoot,
          fixture.sourcePath,
        ),
      ).rejects.toThrow(/prepared|unexpected|allowlist/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a junction in prepared node_modules", async () => {
    const fixture = await createMaterializationFixture();
    try {
      const outside = join(fixture.root, "outside-source");
      await mkdir(outside);
      await symlink(outside, join(fixture.preparedNodeModules, "linked"), "junction");

      await expect(
        verifier.materializePreparedNodeModulesAndVerify?.(
          { appOutDir: fixture.appOutDir },
          fixture.preparedBundleRoot,
          fixture.sourcePath,
        ),
      ).rejects.toThrow(/link|junction|reparse/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a junction at the target node_modules path", async () => {
    const fixture = await createMaterializationFixture();
    try {
      const outside = join(fixture.root, "outside-target");
      await mkdir(join(fixture.appOutDir, "resources", "core"), { recursive: true });
      await mkdir(outside);
      await symlink(outside, fixture.targetNodeModules, "junction");

      await expect(
        verifier.materializePreparedNodeModulesAndVerify?.(
          { appOutDir: fixture.appOutDir },
          fixture.preparedBundleRoot,
          fixture.sourcePath,
        ),
      ).rejects.toThrow(/target|link|junction|reparse/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a prepared manifest dependency path that escapes node_modules", async () => {
    const fixture = await createMaterializationFixture({
      declaredDependencies: {
        "core/node_modules/../escape.js": "escape",
      },
    });
    try {
      await expect(
        verifier.materializePreparedNodeModulesAndVerify?.(
          { appOutDir: fixture.appOutDir },
          fixture.preparedBundleRoot,
          fixture.sourcePath,
        ),
      ).rejects.toThrow(/escape|invalid|path/iu);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a prepared dependency Windows alias before materializing target files", async () => {
    const dependencyBytes = Buffer.from("reviewed dependency");
    const fixture = await createMaterializationFixture({
      declaredDependencies: {
        "core/node_modules/example/index.js": dependencyBytes,
        "CORE/NODE_MODULES/EXAMPLE/INDEX.JS": dependencyBytes,
      },
      preparedDependencies: {
        "core/node_modules/example/index.js": dependencyBytes,
      },
    });
    try {
      await expect(
        verifier.materializePreparedNodeModulesAndVerify?.(
          { appOutDir: fixture.appOutDir },
          fixture.preparedBundleRoot,
          fixture.sourcePath,
        ),
      ).rejects.toThrow(/alias|case|duplicate|canonical/iu);
      await expect(stat(fixture.targetNodeModules)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("pins the release, Electron, builder, and Windows x64 Codex package versions", async () => {
    const manifest = await readManifest(sourceManifestPath);

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      productVersion: "0.2.0-beta.1",
      target: { platform: "win32", arch: "x64" },
      versions: {
        electron: "43.2.0",
        electronBuilder: "26.15.3",
        codex: "0.145.0",
        codexNative: "0.145.0-win32-x64",
      },
      paths: {
        childEntry: "core/childMain.js",
        codexPackage: "codex/package",
        codexNativePackage: "codex/native",
        codexExecutable: "codex/native/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        licenses: "licenses",
      },
    });
    expect(manifest.allowlist.executableFiles).toEqual([
      "codex/native/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
      "codex/native/vendor/x86_64-pc-windows-msvc/bin/codex-code-mode-host.exe",
      "codex/native/vendor/x86_64-pc-windows-msvc/codex-path/rg.exe",
      "codex/native/vendor/x86_64-pc-windows-msvc/codex-resources/codex-command-runner.exe",
      "codex/native/vendor/x86_64-pc-windows-msvc/codex-resources/codex-windows-sandbox-setup.exe",
    ]);
    expect(
      manifest.allowlist.exactFiles.every(
        (entry) =>
          Number.isSafeInteger(entry.bytes) &&
          entry.bytes > 0 &&
          /^[a-f0-9]{64}$/u.test(entry.sha256),
      ),
    ).toBe(true);
  });

  it("records a matching SHA-256 and byte length for every prepared resource", async () => {
    const manifest = await readManifest(bundleManifestPath);
    const resourcePaths = manifest.resources?.map((entry) => entry.path) ?? [];
    const actualFiles = (await filesUnder(bundleRoot)).filter(
      (path) => path !== "runtime-manifest.json",
    );

    expect(new Set(resourcePaths).size).toBe(resourcePaths.length);
    expect([...resourcePaths].sort()).toEqual(actualFiles);
    for (const resource of manifest.resources ?? []) {
      const absolutePath = resolve(bundleRoot, ...resource.path.split("/"));
      expect(relative(bundleRoot, absolutePath).startsWith("..")).toBe(false);
      expect(resource.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(resource.bytes).toBe((await stat(absolutePath)).size);
      expect(resource.sha256).toBe(await sha256(absolutePath));
    }
  }, 60_000);

  it("contains the native Codex executable, app resources, child runtime, and notices", async () => {
    const manifest = await readManifest(bundleManifestPath);
    const required = [
      manifest.paths.childEntry,
      `${manifest.paths.codexPackage}/package.json`,
      `${manifest.paths.codexNativePackage}/package.json`,
      manifest.paths.codexExecutable,
      "desktop/main/main.js",
      "desktop/preload/preload.cjs",
      "desktop/renderer/index.html",
      `${manifest.paths.licenses}/WhiteLily-LICENSE.txt`,
      `${manifest.paths.licenses}/WhiteLily-NOTICE.txt`,
      `${manifest.paths.licenses}/OpenAI-Codex-NOTICE.txt`,
    ];

    const paths = new Set(manifest.resources?.map((entry) => entry.path));
    expect(required.every((path) => paths.has(path))).toBe(true);
  });

  it("starts the prepared child with pinned Electron, becomes ready, and exits on stdin EOF", async () => {
    const manifest = await readManifest(bundleManifestPath);
    const childEntry = resolve(bundleRoot, ...manifest.paths.childEntry.split("/"));
    const electronExecutable = require("electron") as string;
    const root = await mkdtemp(join(tmpdir(), "whitelily-electron-child-"));
    const configPath = join(root, "config.toml");
    await writeFile(configPath, validConfig, "utf8");

    try {
      const result = await new Promise<{
        code: number | null;
        stderr: string;
        ready: boolean;
      }>((resolveResult, reject) => {
        const child = spawn(electronExecutable, [childEntry, configPath, "0"], {
          cwd: root,
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            NODE_NO_WARNINGS: "1",
            PATH: "",
            Path: "",
            SYSTEMROOT: process.env.SYSTEMROOT,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            WHITELILY_DATA_ROOT: root,
            WHITELILY_CODEX_RESOURCE_ROOT: bundleRoot,
            WHITELILY_CODEX_MANIFEST: bundleManifestPath,
            WHITELILY_CODEX_LAYOUT: "packaged",
          },
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        let stderr = "";
        let stdout = "";
        let ready = false;
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error(`prepared Electron child did not become ready: ${stderr}`));
        }, 15_000);
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          const lines = stdout.split("\n");
          stdout = lines.pop() ?? "";
          for (const line of lines) {
            const message = JSON.parse(line) as { id?: string; ok?: boolean };
            if (message.id === "bundle_probe" && message.ok === true) {
              ready = true;
              child.stdin.end();
            }
          }
        });
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timeout);
          resolveResult({ code, stderr, ready });
        });
        child.stdin.write(
          `${JSON.stringify({
            version: 1,
            id: "bundle_probe",
            command: { kind: "get_status" },
          })}\n`,
        );
      });

      expect(result).toEqual({ code: 0, stderr: "", ready: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
