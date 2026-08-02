import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const packageScript = join(repositoryRoot, "scripts", "package-installer.ps1");
const releaseScript = join(repositoryRoot, "scripts", "package-release.ps1");
const inspectScript = join(repositoryRoot, "scripts", "inspect-installer.ps1");
const lifecycleScript = join(repositoryRoot, "scripts", "test-installer.ps1");
const version = "0.2.0-beta.1";
const installerName = `WhiteLily-${version}-windows-x64-setup.exe`;
const temporaryRoots: string[] = [];
const require = createRequire(import.meta.url);
const asar = require("@electron/asar") as {
  createPackage: (source: string, destination: string) => Promise<void>;
};
let sevenZipPath = "";
let makeNsisPath = "";
let makeNsisEnvironment: NodeJS.ProcessEnv = process.env;

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface FixtureOptions {
  omitRequiredResource?: boolean;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): CommandResult {
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    windowsHide: true,
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
  };
}

function runPowerShell(
  scriptPath: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): CommandResult {
  return run(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    options,
  );
}

async function runEmbeddedWinTrustVerifier(targetPath: string): Promise<CommandResult> {
  const root = await createTemporaryRoot("whitelily-wintrust-");
  const harnessPath = join(root, "verify-wintrust.ps1");
  await writeFile(
    harnessPath,
    [
      "param(",
      "    [Parameter(Mandatory = $true)][string]$InspectScript,",
      "    [Parameter(Mandatory = $true)][string]$TargetPath",
      ")",
      "$scriptText = [System.IO.File]::ReadAllText($InspectScript)",
      "$match = [regex]::Match($scriptText, \"(?s)Add-Type -TypeDefinition @'\\r?\\n(?<code>.*?)\\r?\\n'@\")",
      "if (-not $match.Success) { throw 'EMBEDDED_WINTRUST_SOURCE_MISSING' }",
      "Add-Type -TypeDefinition $match.Groups['code'].Value",
      "$result = [WhiteLily.Installer.WinTrustVerifier]::Verify($TargetPath)",
      "[Console]::Out.WriteLine($result.Status)",
      "",
    ].join("\r\n"),
    "utf8",
  );
  return runPowerShell(harnessPath, ["-InspectScript", inspectScript, "-TargetPath", targetPath]);
}

function runChecked(
  command: string,
  args: string[],
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): void {
  const result = run(command, args, {
    cwd: cwd ?? process.cwd(),
    env: environment ?? process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function createTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function createDelegatingSandboxLauncher(root: string): Promise<string> {
  const system32 = join(root, "System32");
  const sourcePath = join(root, "FakeWindowsSandbox.cs");
  const compilerPath = join(root, "compile-fake-sandbox.ps1");
  const executablePath = join(system32, "WindowsSandbox.exe");
  await mkdir(system32, { recursive: true });
  await writeFile(
    sourcePath,
    String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Xml.Linq;

public static class FakeWindowsSandbox {
    private static string Quote(string value) {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    public static int Main(string[] args) {
        try {
            if (args.Length == 4 && StringComparer.Ordinal.Equals(args[0], "--worker")) {
                Thread.Sleep(5000);
                var report = "{\"schemaVersion\":1,\"installerSha256\":\"" + args[3] +
                    "\",\"success\":true,\"stages\":[\"isolated_path\",\"hash_verified\",\"installed\",\"launched_without_system_tooling\",\"keep_data\",\"reinstalled\",\"delete_data\"],\"error\":null}\n";
                var holdMilliseconds = 0;
                Int32.TryParse(
                    Environment.GetEnvironmentVariable("WHITELILY_FAKE_SANDBOX_HOLD_MS"),
                    out holdMilliseconds
                );
                using (var mappingLock = holdMilliseconds > 0
                    ? new FileStream(
                        Path.Combine(args[2], "guest-lifecycle.ps1"),
                        FileMode.Open,
                        FileAccess.Read,
                        FileShare.Read
                    )
                    : null) {
                    File.WriteAllText(Path.Combine(args[2], "sandbox-result.json"), report);
                    if (holdMilliseconds > 0) {
                        Thread.Sleep(holdMilliseconds);
                    }
                }
                return 0;
            }

            var configuration = XDocument.Load(args[0]);
            var reportRoot = configuration
                .Descendants("MappedFolder")
                .Select(folder => (string)folder.Element("HostFolder"))
                .Last();
            var command = configuration.Descendants("Command").Single().Value;
            var hash = Regex.Match(
                command,
                "-InstallerSha256 \\\"(?<hash>[0-9a-f]{64})\\\"",
                RegexOptions.CultureInvariant
            ).Groups["hash"].Value;
            if (String.IsNullOrWhiteSpace(reportRoot) || hash.Length != 64) {
                return 2;
            }
            var capturePath = Environment.GetEnvironmentVariable(
                "WHITELILY_FAKE_SANDBOX_CAPTURE_GUEST"
            );
            if (!String.IsNullOrWhiteSpace(capturePath)) {
                File.Copy(
                    Path.Combine(reportRoot, "guest-lifecycle.ps1"),
                    capturePath,
                    true
                );
            }

            var executable = Path.Combine(
                Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName),
                "WindowsSandboxRemoteSession.exe"
            );
            Process.Start(new ProcessStartInfo {
                FileName = executable,
                Arguments = "--worker " + Quote(args[0]) + " " + Quote(reportRoot) + " " + hash,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            });
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(error);
            return 1;
        }
    }
}
`,
    "utf8",
  );
  await writeFile(
    compilerPath,
    [
      "param(",
      "    [Parameter(Mandatory = $true)][string]$SourcePath,",
      "    [Parameter(Mandatory = $true)][string]$OutputPath",
      ")",
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -TypeDefinition ([IO.File]::ReadAllText($SourcePath)) -Language CSharp -ReferencedAssemblies @('System.Xml.dll', 'System.Xml.Linq.dll') -OutputAssembly $OutputPath -OutputType ConsoleApplication",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const compile = runPowerShell(compilerPath, [
    "-SourcePath",
    sourcePath,
    "-OutputPath",
    executablePath,
  ]);
  if (compile.status !== 0) {
    throw new Error(
      `could not compile fake Sandbox launcher:\n${compile.stdout}\n${compile.stderr}`,
    );
  }
  await copyFile(executablePath, join(system32, "WindowsSandboxRemoteSession.exe"));
  return executablePath;
}

async function writeFixtureFile(root: string, portablePath: string, value: string): Promise<void> {
  const path = join(root, ...portablePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function createInstallerFixture(
  repository: string,
  options: FixtureOptions = {},
): Promise<string> {
  const work = await createTemporaryRoot("whitelily-installer-archive-");
  const appRoot = join(work, "app");
  const resourcesRoot = join(appRoot, "resources");
  const requiredFiles = [
    "core/childMain.js",
    "desktop/main/main.js",
    "desktop/preload/preload.cjs",
    "desktop/renderer/index.html",
    "codex/native/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    "licenses/WhiteLily-LICENSE.txt",
  ];
  const looseFiles = new Map<string, string>([
    ["core/childMain.js", "fixture child"],
    ["codex/native/vendor/x86_64-pc-windows-msvc/bin/codex.exe", "fixture bundled codex"],
    ["licenses/WhiteLily-LICENSE.txt", "fixture license"],
  ]);
  const desktopFiles = new Map<string, string>([
    ["desktop/main/main.js", "fixture main"],
    ["desktop/preload/preload.cjs", "fixture preload"],
    ["desktop/renderer/index.html", "fixture renderer"],
  ]);
  if (options.omitRequiredResource) {
    looseFiles.delete("codex/native/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
  }

  for (const [portablePath, value] of looseFiles) {
    await writeFixtureFile(resourcesRoot, portablePath, value);
  }
  const asarSource = join(work, "asar-source");
  await writeFixtureFile(
    asarSource,
    "package.json",
    `${JSON.stringify({
      name: "@whitelily/desktop",
      productName: "WhiteLily",
      version,
      main: "dist/main/main.js",
    })}\n`,
  );
  for (const [portablePath, value] of desktopFiles) {
    const asarPath = portablePath
      .replace(/^desktop\/main\//u, "dist/main/")
      .replace(/^desktop\/preload\//u, "dist/preload/")
      .replace(/^desktop\/renderer\//u, "dist-renderer/");
    await writeFixtureFile(asarSource, asarPath, value);
  }
  await asar.createPackage(asarSource, join(resourcesRoot, "app.asar"));

  const sourceManifest = {
    schemaVersion: 1,
    productVersion: version,
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
    allowlist: {
      generatedRoots: [],
      productionDependencies: {
        sourceRoot: "node_modules",
        targetRoot: "core/node_modules",
        graph: "package-lock.json",
        excludedPackages: [],
        forbiddenExtensions: [],
      },
      exactFiles: [],
      generatedFiles: [],
      requiredFiles,
      executableFiles: ["codex/native/vendor/x86_64-pc-windows-msvc/bin/codex.exe"],
      scriptFiles: [],
      afterPackFiles: ["app.asar"],
    },
  };
  const sourceManifestPath = join(repository, "packaging", "electron", "runtime-manifest.json");
  await mkdir(dirname(sourceManifestPath), { recursive: true });
  const sourceBytes = `${JSON.stringify(sourceManifest, null, 2)}\n`;
  await writeFile(sourceManifestPath, sourceBytes, "utf8");

  const resources = [...looseFiles.entries(), ...desktopFiles.entries()].map(([path, value]) => ({
    path,
    bytes: Buffer.byteLength(value),
    sha256: createHash("sha256").update(value).digest("hex"),
  }));
  const runtimeManifest = {
    ...sourceManifest,
    policySha256: createHash("sha256").update(sourceBytes).digest("hex"),
    resources,
  };
  await writeFile(
    join(resourcesRoot, "runtime-manifest.json"),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    "utf8",
  );

  const innerArchive = join(work, "app-64.7z");
  runChecked(sevenZipPath, ["a", "-t7z", innerArchive, ".", "-mx=1"], appRoot);
  const installer = join(repository, "fixture", installerName);
  await mkdir(dirname(installer), { recursive: true });
  const nsisScript = join(work, "fixture.nsi");
  await writeFile(
    nsisScript,
    [
      "Unicode true",
      'Name "WhiteLily installer fixture"',
      `OutFile "${installer}"`,
      "RequestExecutionLevel user",
      "SilentInstall silent",
      "SetCompress off",
      "Section",
      '  SetOutPath "$PLUGINSDIR"',
      `  File "/oname=app-64.7z" "${innerArchive}"`,
      "SectionEnd",
      "",
    ].join("\r\n"),
    "utf8",
  );
  runChecked(makeNsisPath, ["/V1", nsisScript], work, makeNsisEnvironment);
  return installer;
}

async function createRepositoryFixture(options: FixtureOptions = {}): Promise<{
  root: string;
  installer: string;
  environment: NodeJS.ProcessEnv;
}> {
  const root = await createTemporaryRoot("whitelily-installer-repo-");
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(packageScript, join(root, "scripts", "package-installer.ps1"));
  await copyFile(inspectScript, join(root, "scripts", "inspect-installer.ps1"));
  await copyFile(lifecycleScript, join(root, "scripts", "test-installer.ps1"));
  await mkdir(join(root, "packaging", "electron"), { recursive: true });
  await copyFile(
    join(repositoryRoot, "packaging", "electron", "after-pack.cjs"),
    join(root, "packaging", "electron", "after-pack.cjs"),
  );
  const productionPackage = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
  };
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        version,
        private: true,
        scripts: {
          "desktop:package:builder": productionPackage.scripts?.["desktop:package:builder"] ?? "",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await mkdir(join(root, "apps", "desktop"), { recursive: true });
  await writeFile(
    join(root, "apps", "desktop", "package.json"),
    `${JSON.stringify({ name: "@whitelily/desktop", version, private: true }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(root, ".gitignore"), "build/\nrelease/\n", "utf8");
  await writeFile(join(root, "tracked.txt"), "clean\n", "utf8");
  const installer = await createInstallerFixture(root, options);

  const tools = join(root, "fixture-tools");
  await mkdir(tools, { recursive: true });
  await writeFile(
    join(tools, "npm.cmd"),
    '@echo off\r\n"%WHITELILY_TEST_NODE%" "%~dp0fake-npm.mjs" %*\r\n',
    "utf8",
  );
  await writeFile(
    join(tools, "fake-npm.mjs"),
    [
      'import { copyFile, mkdir, readFile } from "node:fs/promises";',
      'import { dirname } from "node:path";',
      "const args = process.argv.slice(2);",
      'const invocation = args.join(" ");',
      'if (invocation === "run desktop:package:builder") {',
      '  const packageJson = JSON.parse(await readFile("package.json", "utf8"));',
      "  if (",
      '    packageJson.scripts["desktop:package:builder"] !==',
      '    "node ./node_modules/electron-builder/cli.js --projectDir ./apps/desktop --win nsis --x64 --publish never"',
      "  ) {",
      "    process.exitCode = 42;",
      "  } else {",
      "  await mkdir(dirname(process.env.WHITELILY_TEST_BUILD_OUTPUT), { recursive: true });",
      "  await copyFile(",
      "    process.env.WHITELILY_TEST_INSTALLER_SOURCE,",
      "    process.env.WHITELILY_TEST_BUILD_OUTPUT,",
      "  );",
      "  }",
      "} else if (",
      '  invocation !== "run desktop:prepare" &&',
      '  invocation !== "run desktop:build"',
      ") {",
      "  process.exitCode = 41;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  runChecked("git", ["init", "--quiet"], root);
  runChecked("git", ["config", "user.email", "installer-test@example.invalid"], root);
  runChecked("git", ["config", "user.name", "Installer Test"], root);
  runChecked("git", ["add", "."], root);
  runChecked("git", ["commit", "--quiet", "-m", "fixture"], root);

  return {
    root,
    installer,
    environment: {
      ...process.env,
      PATH: `${tools};${process.env.PATH ?? ""}`,
      Path: `${tools};${process.env.Path ?? process.env.PATH ?? ""}`,
      ELECTRON_BUILDER_7ZIP_PATH: sevenZipPath,
      WHITELILY_TEST_NODE: process.execPath,
      WHITELILY_TEST_INSTALLER_SOURCE: installer,
      WHITELILY_TEST_BUILD_OUTPUT: join(root, "build", "electron-installer", installerName),
      NODE_PATH: join(repositoryRoot, "node_modules"),
    },
  };
}

beforeAll(() => {
  const result = run(process.execPath, [
    "-e",
    "require('app-builder-lib/out/toolsets/7zip.js').getPath7za().then(p=>console.log(p)).catch(e=>{console.error(e);process.exit(1)})",
  ]);
  if (result.status !== 0) {
    throw new Error(`could not resolve pinned electron-builder 7-Zip: ${result.stderr}`);
  }
  sevenZipPath =
    result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z]:\\/u.test(line))
      .at(-1) ?? "";
  if (sevenZipPath.length === 0) {
    throw new Error(`pinned electron-builder 7-Zip path missing: ${result.stdout}`);
  }

  const nsisResult = run(process.execPath, [
    "-e",
    "require('app-builder-lib/out/toolsets/windows.js').getMakeNsisPath(undefined,undefined).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exit(1)})",
  ]);
  if (nsisResult.status !== 0) {
    throw new Error(`could not resolve pinned electron-builder NSIS: ${nsisResult.stderr}`);
  }
  const nsisLine = nsisResult.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .at(-1);
  if (!nsisLine) {
    throw new Error(`pinned electron-builder NSIS path missing: ${nsisResult.stdout}`);
  }
  const nsis = JSON.parse(nsisLine) as {
    path: string;
    env?: Record<string, string>;
  };
  makeNsisPath = nsis.path;
  makeNsisEnvironment = { ...process.env, ...nsis.env };
});

afterAll(async () => {
  for (const root of temporaryRoots.reverse()) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("WhiteLily installer packaging scripts", () => {
  it("computes release hashes without depending on the optional Get-FileHash cmdlet", async () => {
    for (const scriptPath of [releaseScript, inspectScript, lifecycleScript]) {
      const script = await readFile(scriptPath, "utf8");
      expect(script).not.toMatch(/\bGet-FileHash\b/u);
      expect(script).toMatch(/System\.Security\.Cryptography\.SHA256/u);
    }
  });

  it("verifies Authenticode without the optional PowerShell security module", async () => {
    const script = await readFile(inspectScript, "utf8");

    expect(script).not.toMatch(/\bGet-AuthenticodeSignature\b/u);
    expect(script).toMatch(/WinVerifyTrust/u);
    expect(script).toMatch(/TRUST_E_NOSIGNATURE/u);
  });

  it("accepts an executable with an embedded Authenticode signature", async () => {
    const result = await runEmbeddedWinTrustVerifier(process.execPath);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("0");
  });

  it("rejects a non-canonical semantic version before invoking the build", async () => {
    const fixture = await createRepositoryFixture();
    const result = runPowerShell(
      join(fixture.root, "scripts", "package-installer.ps1"),
      ["-Version", "01.2.3"],
      { cwd: fixture.root, env: fixture.environment },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("INVALID_SEMANTIC_VERSION");
    await expect(readdir(join(fixture.root, "release"))).rejects.toThrow();
  });

  it("rejects a numeric prerelease identifier with a leading zero", async () => {
    const fixture = await createRepositoryFixture();
    const result = runPowerShell(
      join(fixture.root, "scripts", "package-installer.ps1"),
      ["-Version", "1.2.3-01"],
      { cwd: fixture.root, env: fixture.environment },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("INVALID_SEMANTIC_VERSION");
    await expect(readdir(join(fixture.root, "release"))).rejects.toThrow();
  });

  it("requires an exact clean tracked tree", async () => {
    const fixture = await createRepositoryFixture();
    await writeFile(join(fixture.root, "tracked.txt"), "dirty\n", "utf8");
    const result = runPowerShell(
      join(fixture.root, "scripts", "package-installer.ps1"),
      ["-Version", version],
      { cwd: fixture.root, env: fixture.environment },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("CLEAN_TRACKED_TREE_REQUIRED");
    await expect(readdir(join(fixture.root, "release"))).rejects.toThrow();
  });

  it("rejects an escaped release root without deleting any external file", async () => {
    const fixture = await createRepositoryFixture();
    const outside = await createTemporaryRoot("whitelily-installer-outside-");
    const sentinel = join(outside, "keep-me.txt");
    await writeFile(sentinel, "preserve", "utf8");
    const result = runPowerShell(
      join(fixture.root, "scripts", "package-installer.ps1"),
      ["-Version", version, "-ReleaseRoot", outside],
      { cwd: fixture.root, env: fixture.environment },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("UNSAFE_RELEASE_ROOT");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve");
  });

  it("writes only the exact installer, lowercase SHA-256, and Authenticode status", async () => {
    const fixture = await createRepositoryFixture();
    const result = runPowerShell(
      join(fixture.root, "scripts", "package-installer.ps1"),
      ["-Version", version],
      { cwd: fixture.root, env: fixture.environment, timeout: 120_000 },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const releaseRoot = join(fixture.root, "release");
    expect((await readdir(releaseRoot)).sort()).toEqual(
      [installerName, `${installerName}.sha256`, `${installerName}.signing-status.txt`].sort(),
    );
    const installer = join(releaseRoot, installerName);
    const hash = createHash("sha256")
      .update(await readFile(installer))
      .digest("hex");
    expect(await readFile(`${installer}.sha256`, "utf8")).toBe(`${hash}  ${installerName}\n`);
    expect(await readFile(`${installer}.signing-status.txt`, "utf8")).toBe("unsigned\n");
  }, 180_000);
});

describe("WhiteLily installer inspection", () => {
  it("rejects an archive that omits a reviewed required bundled resource", async () => {
    const fixture = await createRepositoryFixture({ omitRequiredResource: true });
    const result = runPowerShell(
      join(fixture.root, "scripts", "inspect-installer.ps1"),
      ["-InstallerPath", fixture.installer, "-ExpectedVersion", version],
      { cwd: fixture.root, env: fixture.environment },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("INSTALLER_RESOURCE_MISSING");
  });
});

describe("WhiteLily isolated installer lifecycle", () => {
  it("waits for a delegated Sandbox session after the launcher exits successfully", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = join(fixture.root, "release", installerName);
    await mkdir(dirname(releaseInstaller), { recursive: true });
    await copyFile(fixture.installer, releaseInstaller);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    await createDelegatingSandboxLauncher(fakeWindowsRoot);

    const result = runPowerShell(
      join(fixture.root, "scripts", "test-installer.ps1"),
      ["-InstallerPath", releaseInstaller],
      {
        cwd: fixture.root,
        env: {
          ...fixture.environment,
          WINDIR: fakeWindowsRoot,
        },
        timeout: 120_000,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(
      await readFile(
        join(fixture.root, "release", `WhiteLily-${version}-windows-x64-installer-lifecycle.json`),
        "utf8",
      ),
    ) as { success?: boolean; stages?: string[] };
    expect(report).toMatchObject({
      success: true,
      stages: [
        "isolated_path",
        "hash_verified",
        "installed",
        "launched_without_system_tooling",
        "keep_data",
        "reinstalled",
        "delete_data",
      ],
    });
  }, 180_000);

  it("waits for the Sandbox mapping to close before removing lifecycle artifacts", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = join(fixture.root, "release", installerName);
    await mkdir(dirname(releaseInstaller), { recursive: true });
    await copyFile(fixture.installer, releaseInstaller);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    await createDelegatingSandboxLauncher(fakeWindowsRoot);

    const result = runPowerShell(
      join(fixture.root, "scripts", "test-installer.ps1"),
      ["-InstallerPath", releaseInstaller],
      {
        cwd: fixture.root,
        env: {
          ...fixture.environment,
          WINDIR: fakeWindowsRoot,
          WHITELILY_FAKE_SANDBOX_HOLD_MS: "5000",
        },
        timeout: 120_000,
      },
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 6000));

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    await expect(readdir(join(fixture.root, "build"))).resolves.not.toContainEqual(
      expect.stringMatching(/^installer-sandbox-/u),
    );
  }, 180_000);

  it("closes the remote Sandbox session bound to the lifecycle configuration", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = join(fixture.root, "release", installerName);
    await mkdir(dirname(releaseInstaller), { recursive: true });
    await copyFile(fixture.installer, releaseInstaller);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    await createDelegatingSandboxLauncher(fakeWindowsRoot);

    const result = runPowerShell(
      join(fixture.root, "scripts", "test-installer.ps1"),
      ["-InstallerPath", releaseInstaller],
      {
        cwd: fixture.root,
        env: {
          ...fixture.environment,
          WINDIR: fakeWindowsRoot,
          WHITELILY_FAKE_SANDBOX_HOLD_MS: "35000",
        },
        timeout: 120_000,
      },
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 6000));

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    await expect(readdir(join(fixture.root, "build"))).resolves.not.toContainEqual(
      expect.stringMatching(/^installer-sandbox-/u),
    );
  }, 180_000);

  it("embeds a working SHA-256 verifier in the guest lifecycle script", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = join(fixture.root, "release", installerName);
    await mkdir(dirname(releaseInstaller), { recursive: true });
    await copyFile(fixture.installer, releaseInstaller);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    await createDelegatingSandboxLauncher(fakeWindowsRoot);
    const capturedGuest = join(fixture.root, "captured-guest-lifecycle.ps1");
    const result = runPowerShell(
      join(fixture.root, "scripts", "test-installer.ps1"),
      ["-InstallerPath", releaseInstaller],
      {
        cwd: fixture.root,
        env: {
          ...fixture.environment,
          WINDIR: fakeWindowsRoot,
          WHITELILY_FAKE_SANDBOX_CAPTURE_GUEST: capturedGuest,
        },
        timeout: 120_000,
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const target = join(fixture.root, "hash-probe.txt");
    const expectedHash = createHash("sha256").update("guest hash probe\n").digest("hex");
    await writeFile(target, "guest hash probe\n", "utf8");
    const harness = join(fixture.root, "verify-guest-hash.ps1");
    await writeFile(
      harness,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$GuestScript,",
        "    [Parameter(Mandatory = $true)][string]$Target",
        ")",
        "$ErrorActionPreference = 'Stop'",
        "$tokens = $null",
        "$errors = $null",
        "$ast = [Management.Automation.Language.Parser]::ParseFile($GuestScript, [ref]$tokens, [ref]$errors)",
        "if ($errors.Count -ne 0) { throw 'GUEST_SCRIPT_PARSE_FAILED' }",
        "$functionAst = $ast.Find({",
        "    param($node)",
        "    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and",
        "        $node.Name -eq 'Get-Sha256Hex'",
        "}, $true)",
        "if ($null -eq $functionAst) { throw 'GUEST_SHA256_FUNCTION_MISSING' }",
        "Invoke-Expression $functionAst.Extent.Text",
        "[Console]::Out.WriteLine((Get-Sha256Hex $Target))",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const verification = runPowerShell(harness, ["-GuestScript", capturedGuest, "-Target", target]);

    expect(verification.status, `${verification.stdout}\n${verification.stderr}`).toBe(0);
    expect(verification.stdout.trim()).toBe(expectedHash);
  }, 180_000);

  it("discovers the delegated NSIS uninstaller process after its launcher exits", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = join(fixture.root, "release", installerName);
    await mkdir(dirname(releaseInstaller), { recursive: true });
    await copyFile(fixture.installer, releaseInstaller);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    await createDelegatingSandboxLauncher(fakeWindowsRoot);
    const capturedGuest = join(fixture.root, "captured-guest-lifecycle.ps1");
    const lifecycle = runPowerShell(
      join(fixture.root, "scripts", "test-installer.ps1"),
      ["-InstallerPath", releaseInstaller],
      {
        cwd: fixture.root,
        env: {
          ...fixture.environment,
          WINDIR: fakeWindowsRoot,
          WHITELILY_FAKE_SANDBOX_CAPTURE_GUEST: capturedGuest,
        },
        timeout: 120_000,
      },
    );
    expect(lifecycle.status, `${lifecycle.stdout}\n${lifecycle.stderr}`).toBe(0);

    const childScript = join(fixture.root, "delegated-uninstaller-child.ps1");
    await writeFile(
      childScript,
      ["param([Parameter(Mandatory = $true)][string]$Marker)", "Start-Sleep -Seconds 30", ""].join(
        "\r\n",
      ),
      "utf8",
    );
    const launcherScript = join(fixture.root, "delegating-uninstaller-launcher.ps1");
    await writeFile(
      launcherScript,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$ProgramRoot,",
        "    [Parameter(Mandatory = $true)][string]$ChildScript",
        ")",
        "$marker = '_?=' + $ProgramRoot.TrimEnd('\\') + '\\'",
        "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
        "Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-File', $ChildScript, '-Marker', $marker) -WindowStyle Hidden",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const harness = join(fixture.root, "verify-uninstaller-process.ps1");
    await writeFile(
      harness,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$GuestScript,",
        "    [Parameter(Mandatory = $true)][string]$LauncherScript,",
        "    [Parameter(Mandatory = $true)][string]$ChildScript,",
        "    [Parameter(Mandatory = $true)][string]$ProgramRoot",
        ")",
        "$ErrorActionPreference = 'Stop'",
        "$tokens = $null",
        "$errors = $null",
        "$ast = [Management.Automation.Language.Parser]::ParseFile($GuestScript, [ref]$tokens, [ref]$errors)",
        "$functionAst = $ast.Find({",
        "    param($node)",
        "    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and",
        "        $node.Name -eq 'Get-UninstallerUiProcessIds'",
        "}, $true)",
        "if ($null -eq $functionAst) { throw 'UNINSTALLER_PROCESS_DISCOVERY_MISSING' }",
        "Invoke-Expression $functionAst.Extent.Text",
        "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
        "$launcher = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-File', $LauncherScript, '-ProgramRoot', $ProgramRoot, '-ChildScript', $ChildScript) -PassThru",
        "$launcher.WaitForExit()",
        "$deadline = [DateTime]::UtcNow.AddSeconds(10)",
        "$childPid = $null",
        "do {",
        "    $childPid = @(",
        "        Get-UninstallerUiProcessIds -LauncherPid $launcher.Id -ProgramRoot $ProgramRoot |",
        "            Where-Object { $_ -ne $launcher.Id }",
        "    ) | Select-Object -First 1",
        "    if ($null -ne $childPid) { break }",
        "    Start-Sleep -Milliseconds 100",
        "} while ([DateTime]::UtcNow -lt $deadline)",
        "if ($null -eq $childPid) { throw 'DELEGATED_UNINSTALLER_PROCESS_NOT_FOUND' }",
        "try {",
        "    [Console]::Out.WriteLine([int]$childPid)",
        "} finally {",
        "    Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue",
        "}",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const verification = runPowerShell(harness, [
      "-GuestScript",
      capturedGuest,
      "-LauncherScript",
      launcherScript,
      "-ChildScript",
      childScript,
      "-ProgramRoot",
      fixture.root,
    ]);

    expect(verification.status, `${verification.stdout}\n${verification.stderr}`).toBe(0);
    expect(Number(verification.stdout.trim())).toBeGreaterThan(0);
  }, 180_000);

  it("advances every NSIS uninstaller page until the delegated process exits", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = join(fixture.root, "release", installerName);
    await mkdir(dirname(releaseInstaller), { recursive: true });
    await copyFile(fixture.installer, releaseInstaller);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    await createDelegatingSandboxLauncher(fakeWindowsRoot);
    const capturedGuest = join(fixture.root, "captured-guest-lifecycle.ps1");
    const lifecycle = runPowerShell(
      join(fixture.root, "scripts", "test-installer.ps1"),
      ["-InstallerPath", releaseInstaller],
      {
        cwd: fixture.root,
        env: {
          ...fixture.environment,
          WINDIR: fakeWindowsRoot,
          WHITELILY_FAKE_SANDBOX_CAPTURE_GUEST: capturedGuest,
        },
        timeout: 120_000,
      },
    );
    expect(lifecycle.status, `${lifecycle.stdout}\n${lifecycle.stderr}`).toBe(0);

    const wizardSource = join(fixture.root, "FakeUninstallerWizard.cs");
    const wizardExecutable = join(fixture.root, "FakeUninstallerWizard.exe");
    await writeFile(
      wizardSource,
      String.raw`
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class FakeUninstallerWizard {
    [DllImport("user32.dll")]
    private static extern int SetWindowLong(IntPtr handle, int index, int value);

    [STAThread]
    public static void Main() {
        Application.EnableVisualStyles();
        var form = new Form {
            Text = "Fake WhiteLily Uninstaller",
            ClientSize = new Size(420, 180),
        };
        var button = new Button {
            Text = "Next",
            Location = new Point(300, 120),
            Size = new Size(90, 30),
        };
        var clicks = 0;
        button.Click += (_, __) => {
            clicks += 1;
            button.Text = clicks < 2 ? "Next" : "Finish";
            if (clicks >= 3) {
                form.Close();
            }
        };
        form.Controls.Add(button);
        form.Shown += (_, __) => SetWindowLong(button.Handle, -12, 1);
        Application.Run(form);
    }
}
`,
      "utf8",
    );
    const compileWizard = join(fixture.root, "compile-fake-wizard.ps1");
    await writeFile(
      compileWizard,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$SourcePath,",
        "    [Parameter(Mandatory = $true)][string]$OutputPath",
        ")",
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -TypeDefinition ([IO.File]::ReadAllText($SourcePath)) -Language CSharp -ReferencedAssemblies @('System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll') -OutputAssembly $OutputPath -OutputType WindowsApplication",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const compilation = runPowerShell(compileWizard, [
      "-SourcePath",
      wizardSource,
      "-OutputPath",
      wizardExecutable,
    ]);
    expect(compilation.status, `${compilation.stdout}\n${compilation.stderr}`).toBe(0);

    const harness = join(fixture.root, "verify-uninstaller-completion.ps1");
    await writeFile(
      harness,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$GuestScript,",
        "    [Parameter(Mandatory = $true)][string]$WizardExecutable",
        ")",
        "$ErrorActionPreference = 'Stop'",
        "$scriptText = [IO.File]::ReadAllText($GuestScript)",
        "$typeMatch = [regex]::Match($scriptText, '(?s)Add-Type -TypeDefinition @\"\\r?\\n(?<code>.*?)\\r?\\n\"@')",
        "if (-not $typeMatch.Success) { throw 'INSTALLER_UI_TYPE_MISSING' }",
        "Add-Type -TypeDefinition $typeMatch.Groups['code'].Value",
        "$tokens = $null",
        "$errors = $null",
        "$ast = [Management.Automation.Language.Parser]::ParseFile($GuestScript, [ref]$tokens, [ref]$errors)",
        "$functionAst = $ast.Find({",
        "    param($node)",
        "    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and",
        "        $node.Name -eq 'Complete-UninstallerUi'",
        "}, $true)",
        "if ($null -eq $functionAst) { throw 'UNINSTALLER_UI_COMPLETION_MISSING' }",
        "Invoke-Expression $functionAst.Extent.Text",
        "$wizard = Start-Process -FilePath $WizardExecutable -PassThru",
        "try {",
        "    $exitCode = Complete-UninstallerUi -UiProcessId $wizard.Id -TimeoutMilliseconds 10000",
        "    [Console]::Out.WriteLine($exitCode)",
        "} finally {",
        "    if (-not $wizard.HasExited) { Stop-Process -Id $wizard.Id -Force }",
        "}",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const verification = runPowerShell(harness, [
      "-GuestScript",
      capturedGuest,
      "-WizardExecutable",
      wizardExecutable,
    ]);

    expect(verification.status, `${verification.stdout}\n${verification.stderr}`).toBe(0);
    expect(verification.stdout.trim()).toBe("0");
  }, 180_000);

  it("fails closed when Windows Sandbox is unavailable and never falls back to this profile", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = join(fixture.root, "release", installerName);
    await mkdir(dirname(releaseInstaller), { recursive: true });
    await copyFile(fixture.installer, releaseInstaller);
    const result = runPowerShell(
      join(fixture.root, "scripts", "test-installer.ps1"),
      ["-InstallerPath", releaseInstaller],
      {
        cwd: fixture.root,
        env: {
          ...fixture.environment,
          WHITELILY_FORCE_SANDBOX_UNAVAILABLE: "1",
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("WINDOWS_SANDBOX_REQUIRED");
    expect(await readdir(join(fixture.root, "release"))).toEqual([installerName]);
  });
});
