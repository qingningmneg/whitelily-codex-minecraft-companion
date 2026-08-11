import { createHash } from "node:crypto";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const packageScript = join(repositoryRoot, "scripts", "package-installer.ps1");
const releaseScript = join(repositoryRoot, "scripts", "package-release.ps1");
const inspectScript = join(repositoryRoot, "scripts", "inspect-installer.ps1");
const lifecycleScript = join(repositoryRoot, "scripts", "test-installer.ps1");
const installedComponentVerifier = join(
  repositoryRoot,
  "scripts",
  "minecraft-component-resource-verifier.ps1",
);
const componentPreferenceValidator = join(
  repositoryRoot,
  "packaging",
  "nsis",
  "validate-minecraft-component-preferences.ps1",
);
const version = "0.2.0-beta.2";
const baselineVersion = "0.2.0-beta.1";
const installerName = `WhiteLily-${version}-windows-x64-setup.exe`;
const baselineInstallerName = `WhiteLily-${baselineVersion}-windows-x64-setup.exe`;
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
  coordinatedComponentRewrite?: boolean;
  sourceComponentPinMismatch?: boolean;
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
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Xml.Linq;

public static class FakeWindowsSandbox {
    private static string Quote(string value) {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static string JsonEscape(string value) {
        return value
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\r", "\\r")
            .Replace("\n", "\\n");
    }

    private static string HmacSha256(string payload, string keyHex) {
        var key = Enumerable.Range(0, keyHex.Length / 2)
            .Select(index => Convert.ToByte(keyHex.Substring(index * 2, 2), 16))
            .ToArray();
        using (var hmac = new HMACSHA256(key)) {
            return BitConverter.ToString(hmac.ComputeHash(Encoding.UTF8.GetBytes(payload)))
                .Replace("-", "")
                .ToLowerInvariant();
        }
    }

    public static int Main(string[] args) {
        try {
            if (args.Length == 1 && StringComparer.Ordinal.Equals(args[0], "--sleeper")) {
                Thread.Sleep(30000);
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
            var expectedVersion = Regex.Match(
                command,
                "-ExpectedVersion \\\"(?<version>[^\\\"]+)\\\"",
                RegexOptions.CultureInvariant
            ).Groups["version"].Value;
            var baselineHash = Regex.Match(
                command,
                "-BaselineInstallerSha256 \\\"(?<hash>[0-9a-f]{64})\\\"",
                RegexOptions.CultureInvariant
            ).Groups["hash"].Value;
            if (
                String.IsNullOrWhiteSpace(reportRoot) ||
                hash.Length != 64 ||
                String.IsNullOrWhiteSpace(expectedVersion) ||
                baselineHash.Length != 64
            ) {
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

            if (StringComparer.Ordinal.Equals(
                Environment.GetEnvironmentVariable("WHITELILY_FAKE_SANDBOX_FORGE_ONLY"),
                "1"
            )) {
                var buildRoot = Directory.GetParent(Directory.GetParent(reportRoot).FullName).FullName;
                File.WriteAllText(
                    Path.Combine(buildRoot, "candidate-forged-result.json"),
                    "AccessDenied: candidate could not create the trusted SYSTEM report\n"
                );
                File.WriteAllText(
                    Path.Combine(reportRoot, "sandbox-result.json"),
                    "{\"forged\":true}\n"
                );
                return 0;
            }

            Thread.Sleep(5000);
            var requestedError = Environment.GetEnvironmentVariable(
                "WHITELILY_FAKE_SANDBOX_REPORT_ERROR"
            );
            var stages = "[\"controller_identity_verified\",\"isolated_path\",\"hashes_verified\",\"candidate_write_denied\",\"clean_installed\",\"clean_workspace_verified\",\"clean_delete_data\",\"beta1_installed\",\"beta1_data_root_prepared\",\"beta1_upgraded\",\"workspace_repaired\",\"keep_data\",\"reinstalled\",\"delete_data\",\"candidate_principal_removed\"]";
            var report = String.IsNullOrWhiteSpace(requestedError)
                ? "{\"schemaVersion\":2,\"controllerSid\":\"S-1-5-18\",\"candidateSid\":\"S-1-5-21-1-2-3-1001\",\"candidateReportWriteDenied\":true,\"installerSha256\":\"" + hash +
                    "\",\"controllerObservedInstallerSha256\":\"" + hash +
                    "\",\"expectedVersion\":\"" + expectedVersion +
                    "\",\"baselineInstallerSha256\":\"" + baselineHash +
                    "\",\"controllerObservedBaselineInstallerSha256\":\"" + baselineHash +
                    "\",\"installedVersion\":\"" + expectedVersion +
                    "\",\"managedWorkspaceResources\":3,\"minecraftComponentResources\":9,\"componentPreferencesFresh\":true,\"componentPreferencesUpgradePreserved\":true,\"componentPreferencesKeepPreserved\":true,\"success\":true,\"stages\":" + stages + ",\"error\":null}\n"
                : "{\"schemaVersion\":2,\"controllerSid\":\"S-1-5-18\",\"candidateSid\":\"S-1-5-21-1-2-3-1001\",\"candidateReportWriteDenied\":true,\"installerSha256\":\"" + hash +
                    "\",\"controllerObservedInstallerSha256\":\"" + hash +
                    "\",\"expectedVersion\":\"" + expectedVersion +
                    "\",\"baselineInstallerSha256\":\"" + baselineHash +
                    "\",\"controllerObservedBaselineInstallerSha256\":\"" + baselineHash +
                    "\",\"installedVersion\":null,\"managedWorkspaceResources\":0,\"minecraftComponentResources\":0,\"componentPreferencesFresh\":false,\"componentPreferencesUpgradePreserved\":false,\"componentPreferencesKeepPreserved\":false,\"success\":false,\"stages\":[],\"error\":\"" + requestedError + "\"}";
            report = report.TrimEnd('\r', '\n');
            var keyHex = File.ReadAllText(Path.Combine(reportRoot, "bootstrap-secret.txt")).Trim();
            var envelope = "{\"transportSchemaVersion\":1,\"payload\":\"" + JsonEscape(report) +
                "\",\"hmacSha256\":\"" + HmacSha256(report, keyHex) + "\"}\n";
            var holdMilliseconds = 0;
            Int32.TryParse(
                Environment.GetEnvironmentVariable("WHITELILY_FAKE_SANDBOX_HOLD_MS"),
                out holdMilliseconds
            );
            using (var mappingLock = holdMilliseconds > 0
                ? new FileStream(
                    Path.Combine(reportRoot, "guest-lifecycle.ps1"),
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read
                )
                : null) {
                var guardPath = Path.Combine(reportRoot, "shutdown-guard.lock");
                FileStream shutdownGuard = null;
                if (!File.Exists(guardPath)) {
                    shutdownGuard = new FileStream(
                        guardPath,
                        FileMode.CreateNew,
                        FileAccess.ReadWrite,
                        FileShare.None
                    );
                }
                try {
                    File.WriteAllText(Path.Combine(reportRoot, "sandbox-result.json"), envelope);
                } finally {
                    if (shutdownGuard != null) {
                        shutdownGuard.Dispose();
                    }
                }
                if (holdMilliseconds > 0) {
                    Thread.Sleep(holdMilliseconds);
                }
            }
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

async function startShutdownGuardHolder(
  repository: string,
  holdMilliseconds: number,
): Promise<{ holder: ReturnType<typeof spawn>; readyPath: string }> {
  const holderScript = join(repository, `hold-shutdown-guard-${holdMilliseconds}.ps1`);
  const readyPath = join(repository, `shutdown-guard-${holdMilliseconds}.ready`);
  await writeFile(
    holderScript,
    [
      "param(",
      "    [Parameter(Mandatory = $true)][string]$BuildRoot,",
      "    [Parameter(Mandatory = $true)][string]$ReadyPath,",
      "    [Parameter(Mandatory = $true)][int]$HoldMilliseconds",
      ")",
      "$ErrorActionPreference = 'Stop'",
      "$deadline = [DateTime]::UtcNow.AddSeconds(30)",
      "$guardPath = $null",
      "do {",
      "    $sandboxRoot = Get-ChildItem -LiteralPath $BuildRoot -Directory -Filter 'installer-sandbox-*' -ErrorAction SilentlyContinue | Select-Object -First 1",
      "    if ($null -ne $sandboxRoot) {",
      "        $reportRoot = Join-Path $sandboxRoot.FullName 'report'",
      "        if (Test-Path -LiteralPath $reportRoot -PathType Container) {",
      "            $guardPath = Join-Path $reportRoot 'shutdown-guard.lock'",
      "            break",
      "        }",
      "    }",
      "    Start-Sleep -Milliseconds 50",
      "} while ([DateTime]::UtcNow -lt $deadline)",
      "if ($null -eq $guardPath) { throw 'GUARD_PATH_NOT_FOUND' }",
      "$stream = [IO.File]::Open($guardPath, 'CreateNew', 'ReadWrite', 'None')",
      "try {",
      "    [IO.File]::WriteAllText($ReadyPath, $guardPath)",
      "    Start-Sleep -Milliseconds $HoldMilliseconds",
      "} finally { $stream.Dispose() }",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const holder = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      holderScript,
      "-BuildRoot",
      join(repository, "build"),
      "-ReadyPath",
      readyPath,
      "-HoldMilliseconds",
      String(holdMilliseconds),
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  return { holder, readyPath };
}

async function writeFixtureFile(root: string, portablePath: string, value: string): Promise<void> {
  const path = join(root, ...portablePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

async function createInstalledComponentFixture(): Promise<{
  root: string;
  programRoot: string;
  componentRoot: string;
  runtimePath: string;
  policyPath: string;
  harnessPath: string;
  paths: string[];
}> {
  const root = await createTemporaryRoot("whitelily-installed-components-");
  const programRoot = join(root, "WhiteLily");
  const resources = join(programRoot, "resources");
  const componentRoot = join(resources, "minecraft-components");
  const policyPath = join(root, "policy.json");
  const harnessPath = join(root, "verify.ps1");
  const paths = [
    "fabric-api-0.128.2+1.21.5.jar",
    "Fabric-API-LICENSE.txt",
    "geckolib-fabric-1.21.5-5.1.0.jar",
    "GeckoLib-LICENSE.txt",
    "minecraft-components-manifest.json",
    "whitelily-avatar-fabric-1.21.5-0.1.0.jar",
    "whitelily-bridge-fabric-1.21.5-0.1.0.jar",
    "WhiteLily-LICENSE.txt",
    "WhiteLily-NOTICE.txt",
  ];
  await mkdir(componentRoot, { recursive: true });
  const files = [];
  for (const name of paths) {
    const bytes = Buffer.from(`reviewed:${name}`, "utf8");
    await writeFile(join(componentRoot, name), bytes);
    files.push({
      name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const resourcesManifest = files.map(({ name, bytes, sha256 }) => ({
    path: `minecraft-components/${name}`,
    bytes,
    sha256,
  }));
  const runtimePath = join(resources, "runtime-manifest.json");
  await writeFile(
    runtimePath,
    JSON.stringify({
      paths: { minecraftComponents: "minecraft-components" },
      allowlist: {
        exactFiles: resourcesManifest.map(({ path, bytes, sha256 }) => ({
          source: `build/${path}`,
          target: path,
          bytes,
          sha256,
        })),
        requiredFiles: resourcesManifest.map(({ path }) => path),
        executableFiles: [],
        scriptFiles: [],
      },
      resources: resourcesManifest,
    }),
  );
  await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, files }));
  await writeFile(
    harnessPath,
    [
      "param([string]$Verifier,[string]$ProgramRoot,[string]$PolicyPath)",
      "$ErrorActionPreference='Stop'",
      ". $Verifier",
      "$policy=Get-Content -LiteralPath $PolicyPath -Raw -Encoding UTF8 | ConvertFrom-Json",
      "$count=Assert-ReviewedMinecraftComponentResources -ProgramRoot $ProgramRoot -ReviewedFiles @($policy.files)",
      "[Console]::Out.Write([string]$count)",
      "",
    ].join("\r\n"),
  );
  return { root, programRoot, componentRoot, runtimePath, policyPath, harnessPath, paths };
}

function runInstalledComponentVerifier(
  fixture: Awaited<ReturnType<typeof createInstalledComponentFixture>>,
): CommandResult {
  return runPowerShell(
    fixture.harnessPath,
    [
      "-Verifier",
      installedComponentVerifier,
      "-ProgramRoot",
      fixture.programRoot,
      "-PolicyPath",
      fixture.policyPath,
    ],
    { timeout: 15_000 },
  );
}

async function createInstallerFixture(
  repository: string,
  options: FixtureOptions = {},
): Promise<string> {
  const work = await createTemporaryRoot("whitelily-installer-archive-");
  const appRoot = join(work, "app");
  const resourcesRoot = join(appRoot, "resources");
  const requiredFiles = [
    "codex-workspace/.codex/config.toml",
    "codex-workspace/AGENTS.md",
    "codex-workspace/workspace-manifest.json",
    "core/childMain.js",
    "desktop/main/main.js",
    "desktop/preload/preload.cjs",
    "desktop/renderer/index.html",
    "codex/native/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    "licenses/WhiteLily-LICENSE.txt",
  ];
  const componentPaths = [
    "minecraft-components/fabric-api-0.128.2+1.21.5.jar",
    "minecraft-components/Fabric-API-LICENSE.txt",
    "minecraft-components/geckolib-fabric-1.21.5-5.1.0.jar",
    "minecraft-components/GeckoLib-LICENSE.txt",
    "minecraft-components/minecraft-components-manifest.json",
    "minecraft-components/whitelily-avatar-fabric-1.21.5-0.1.0.jar",
    "minecraft-components/whitelily-bridge-fabric-1.21.5-0.1.0.jar",
    "minecraft-components/WhiteLily-LICENSE.txt",
    "minecraft-components/WhiteLily-NOTICE.txt",
  ];
  requiredFiles.push(...componentPaths);
  const workspacePayloads = new Map<string, string>([
    [".codex/config.toml", '[mcp_servers.minecraft]\nurl = "http://127.0.0.1:32123/mcp"\n'],
    ["AGENTS.md", "# 白百合测试动作工作区\n"],
  ]);
  const workspaceManifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      contentVersion: "1",
      files: [...workspacePayloads].map(([path, value]) => ({
        path,
        bytes: Buffer.byteLength(value),
        sha256: createHash("sha256").update(value).digest("hex"),
      })),
    },
    null,
    2,
  )}\n`;
  const reviewedComponentValues = new Map(
    componentPaths.map((path) => [path, `fixture:${path}`] as const),
  );
  const looseFiles = new Map<string, string>([
    ["codex-workspace/.codex/config.toml", workspacePayloads.get(".codex/config.toml") ?? ""],
    ["codex-workspace/AGENTS.md", workspacePayloads.get("AGENTS.md") ?? ""],
    ["codex-workspace/workspace-manifest.json", workspaceManifest],
    ["core/childMain.js", "fixture child"],
    ["codex/native/vendor/x86_64-pc-windows-msvc/bin/codex.exe", "fixture bundled codex"],
    ["licenses/WhiteLily-LICENSE.txt", "fixture license"],
    ...reviewedComponentValues,
  ]);
  if (options.coordinatedComponentRewrite) {
    looseFiles.set(componentPaths[0]!, "coordinated packaged component replacement");
  }
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
      minecraftComponents: "minecraft-components",
    },
    managedWorkspace: {
      root: "codex-workspace",
      manifest: "codex-workspace/workspace-manifest.json",
      payloads: [".codex/config.toml", "AGENTS.md"],
      mcpUrl: "http://127.0.0.1:32123/mcp",
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
      exactFiles: componentPaths.map((target, index) => {
        const value = looseFiles.get(target) ?? "";
        return {
          source: `build/${target}`,
          target,
          bytes: Buffer.byteLength(value),
          sha256:
            options.sourceComponentPinMismatch && index === 0
              ? "0".repeat(64)
              : createHash("sha256").update(value).digest("hex"),
        };
      }),
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
  await writeFile(
    join(repository, "packaging", "electron", "minecraft-component-pack.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        files: componentPaths.map((target) => {
          const value = reviewedComponentValues.get(target) ?? "";
          return {
            name: target.slice("minecraft-components/".length),
            bytes: Buffer.byteLength(value),
            sha256: createHash("sha256").update(value).digest("hex"),
          };
        }),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

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
  baselineInstaller: string;
  environment: NodeJS.ProcessEnv;
}> {
  const root = await createTemporaryRoot("whitelily-installer-repo-");
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(packageScript, join(root, "scripts", "package-installer.ps1"));
  await copyFile(inspectScript, join(root, "scripts", "inspect-installer.ps1"));
  await copyFile(lifecycleScript, join(root, "scripts", "test-installer.ps1"));
  await copyFile(
    installedComponentVerifier,
    join(root, "scripts", "minecraft-component-resource-verifier.ps1"),
  );
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
  const baselineInstaller = join(root, "fixture", baselineInstallerName);
  await writeFile(baselineInstaller, "fixture beta.1 baseline installer\n", "utf8");
  const baselineContents = await readFile(baselineInstaller);
  await writeFile(
    join(root, "packaging", "electron", "public-installer-baselines.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        baselines: [
          {
            version: baselineVersion,
            releaseTag: "v0.2.0-beta.1",
            assetName: baselineInstallerName,
            bytes: baselineContents.length,
            sha256: createHash("sha256").update(baselineContents).digest("hex"),
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

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
    baselineInstaller,
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

async function stageLifecycleInstallers(fixture: {
  root: string;
  installer: string;
  baselineInstaller: string;
}): Promise<string> {
  const releaseRoot = join(fixture.root, "release");
  await mkdir(releaseRoot, { recursive: true });
  const releaseInstaller = join(releaseRoot, installerName);
  await Promise.all([
    copyFile(fixture.installer, releaseInstaller),
    copyFile(fixture.baselineInstaller, join(releaseRoot, baselineInstallerName)),
  ]);
  return releaseInstaller;
}

async function createNsisComponentPreferenceFixture(): Promise<{
  root: string;
  installer: string;
  dataRoot: string;
  preferences: string;
  modePath: string;
  hookPath: string;
  lastErrorPath: string;
  aclSddlPath: string;
  attackResultPath: string;
  tempPathRecord: string;
  hardlinkPeerPath: string;
  relocatedTempPath: string;
}> {
  const root = await createTemporaryRoot("whitelily-nsis-components-");
  const installer = join(root, "component-preferences.exe");
  const dataRoot = join(root, "data");
  const preferences = join(dataRoot, "config", "minecraft-components.json");
  const modePath = join(root, "mode.txt");
  const lastErrorPath = join(root, "last-error.txt");
  const aclSddlPath = join(root, "config-acl.sddl");
  const attackResultPath = join(root, "attack-result.txt");
  const tempPathRecord = join(root, "temp-path.txt");
  const hardlinkPeerPath = join(root, "hardlink-peer.json");
  const relocatedTempPath = join(root, "relocated-temp.json");
  const hookPath = join(root, "hook.ps1");
  const validatorPath = join(root, "validate-minecraft-component-preferences.ps1");
  await writeFile(
    hookPath,
    [
      "param([string]$Phase,[string]$ModePath,[string]$TargetPath,[string]$TempPath,[string]$Root)",
      "$ErrorActionPreference='Stop'",
      "$mode=if(Test-Path -LiteralPath $ModePath){(Get-Content -LiteralPath $ModePath -Raw).Trim()}else{'fresh'}",
      '$valid=\'{"schemaVersion":1,"bridgeEnabled":false,"avatarEnabled":false}\'',
      '$pretty="{`r`n  `"avatarEnabled`": true,`r`n  `"schemaVersion`": 1,`r`n  `"bridgeEnabled`": false`r`n}`r`n"',
      "if($Phase -eq 'restore-acl') {$config=Split-Path -Parent $TargetPath; $sddlPath=Join-Path $Root 'config-acl.sddl'; $acl=Get-Acl -LiteralPath $config; $acl.SetSecurityDescriptorSddlForm([IO.File]::ReadAllText($sddlPath)); Set-Acl -LiteralPath $config -AclObject $acl; exit}",
      "if($Phase -eq 'before-publish') {",
      "  [IO.File]::WriteAllText((Join-Path $Root 'temp-path.txt'),$TempPath)",
      "  if($mode -in @('collision-valid','race-replacement','temp-replacement-before-cleanup')) {[IO.File]::WriteAllText($TargetPath,$valid,[Text.UTF8Encoding]::new($false))}",
      "  elseif($mode -eq 'collision-valid-pretty') {[IO.File]::WriteAllText($TargetPath,$pretty,[Text.UTF8Encoding]::new($false))}",
      "  elseif($mode -eq 'collision-malformed') {[IO.File]::WriteAllText($TargetPath,'malformed',[Text.UTF8Encoding]::new($false))}",
      "  elseif($mode -eq 'collision-reparse') {$outside=Join-Path $Root 'outside'; New-Item -ItemType Directory -Path $outside -Force|Out-Null; New-Item -ItemType Junction -Path $TargetPath -Target $outside|Out-Null}",
      "  elseif($mode -eq 'collision-hardlink') {$peer=Join-Path $Root 'hardlink-peer.json'; [IO.File]::WriteAllText($peer,$valid,[Text.UTF8Encoding]::new($false)); New-Item -ItemType HardLink -Path $TargetPath -Target $peer|Out-Null}",
      "  elseif($mode -eq 'missing-temp-noncollision') {Remove-Item -LiteralPath $TempPath -Force}",
      "  elseif($mode -eq 'access-denied') {$config=Split-Path -Parent $TargetPath; $sddlPath=Join-Path $Root 'config-acl.sddl'; $acl=Get-Acl -LiteralPath $config; [IO.File]::WriteAllText($sddlPath,$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::CreateFiles,[Security.AccessControl.AccessControlType]::Deny); [void]$acl.AddAccessRule($rule); Set-Acl -LiteralPath $config -AclObject $acl}",
      "  elseif($mode -eq 'temp-replacement-before-publish') {try {Move-Item -LiteralPath $TempPath -Destination (Join-Path $Root 'relocated-temp.json'); [IO.File]::WriteAllText($TempPath,$valid,[Text.UTF8Encoding]::new($false)); [IO.File]::WriteAllText((Join-Path $Root 'attack-result.txt'),'replaced')} catch {[IO.File]::WriteAllText((Join-Path $Root 'attack-result.txt'),'blocked')}}",
      "  elseif($mode -eq 'temp-hardlink-before-publish') {New-Item -ItemType HardLink -Path (Join-Path $Root 'hardlink-peer.json') -Target $TempPath|Out-Null}",
      "}",
      "if($Phase -eq 'before-winner-validation' -and $mode -eq 'race-replacement') {[IO.File]::WriteAllText($TargetPath,'replaced',[Text.UTF8Encoding]::new($false))}",
      "if($Phase -eq 'before-temp-cleanup' -and $mode -eq 'temp-replacement-before-cleanup') {try {Move-Item -LiteralPath $TempPath -Destination (Join-Path $Root 'relocated-temp.json'); [IO.File]::WriteAllText($TempPath,$pretty,[Text.UTF8Encoding]::new($false)); [IO.File]::WriteAllText((Join-Path $Root 'attack-result.txt'),'replaced')} catch {[IO.File]::WriteAllText((Join-Path $Root 'attack-result.txt'),'blocked')}}",
      "if($Phase -eq 'before-temp-cleanup' -and $mode -eq 'cleanup-lock') {",
      "  throw 'forced owned-cleanup transition failure'",
      "}",
      "",
    ].join("\r\n"),
  );
  const invokeHook = (phase: string) =>
    [
      "$testRoot=[Environment]::GetEnvironmentVariable('WHITELILY_COMPONENT_TEST_ROOT')",
      "$testModePath=[Environment]::GetEnvironmentVariable('WHITELILY_COMPONENT_TEST_MODE_PATH')",
      `& (Join-Path $testRoot 'hook.ps1') -Phase '${phase}' -ModePath $testModePath -TargetPath $target -TempPath $owned.Path -Root $testRoot`,
      "if(-not $?) {throw 'component preference test hook failed'}",
    ].join("\r\n        ");
  let validatorSource = await readFile(componentPreferenceValidator, "utf8");
  validatorSource = validatorSource
    .replace("# WHITELILY_TEST_BEFORE_PUBLISH", invokeHook("before-publish"))
    .replace(
      "# WHITELILY_TEST_AFTER_PUBLISH",
      [
        "if(-not $publication.Published){",
        "    $testRoot=[Environment]::GetEnvironmentVariable('WHITELILY_COMPONENT_TEST_ROOT')",
        "    [IO.File]::WriteAllText((Join-Path $testRoot 'last-error.txt'),[string]$publication.ErrorCode)",
        "}",
      ].join("\r\n        "),
    )
    .replace("# WHITELILY_TEST_BEFORE_WINNER_CLEANUP", invokeHook("before-winner-validation"))
    .replace("# WHITELILY_TEST_BEFORE_OWNED_CLEANUP", invokeHook("before-temp-cleanup"));
  expect(validatorSource).not.toContain("# WHITELILY_TEST_");
  await writeFile(validatorPath, validatorSource, "utf8");
  const projectDir = join(repositoryRoot, "apps", "desktop");
  const nsisPath = join(root, "fixture.nsi");
  await writeFile(
    nsisPath,
    [
      "Unicode true",
      `!define PROJECT_DIR "${projectDir}"`,
      '!define WHITELILY_COMPONENT_DATA_ROOT "$EXEDIR\\data"',
      "!define WHITELILY_COMPONENT_TEST_HOOKS",
      `!define WHITELILY_COMPONENT_VALIDATOR_SOURCE "${validatorPath}"`,
      `!include "${join(repositoryRoot, "packaging", "nsis", "installer.nsh")}"`,
      'Name "WhiteLily component preference fixture"',
      `OutFile "${installer}"`,
      "RequestExecutionLevel user",
      "SilentInstall silent",
      "Section",
      "  !insertmacro customInit",
      "  !insertmacro customInstall",
      "SectionEnd",
      "",
    ].join("\r\n"),
  );
  const compilation = run(makeNsisPath, ["/V2", nsisPath], {
    cwd: root,
    env: makeNsisEnvironment,
    timeout: 60_000,
  });
  expect(compilation.status, `${compilation.stdout}\n${compilation.stderr}`).toBe(0);
  return {
    root,
    installer,
    dataRoot,
    preferences,
    modePath,
    hookPath,
    lastErrorPath,
    aclSddlPath,
    attackResultPath,
    tempPathRecord,
    hardlinkPeerPath,
    relocatedTempPath,
  };
}

async function runNsisComponentPreferenceFixture(
  fixture: Awaited<ReturnType<typeof createNsisComponentPreferenceFixture>>,
  mode: string,
): Promise<CommandResult> {
  await Promise.all([
    rm(fixture.attackResultPath, { force: true }),
    rm(fixture.tempPathRecord, { force: true }),
    rm(fixture.hardlinkPeerPath, { force: true }),
    rm(fixture.relocatedTempPath, { force: true }),
  ]);
  await writeFile(fixture.modePath, mode, "utf8");
  await rm(fixture.lastErrorPath, { force: true });
  return run(fixture.installer, ["/S"], {
    cwd: fixture.root,
    timeout: 15_000,
    env: {
      ...process.env,
      WHITELILY_COMPONENT_TEST_ROOT: fixture.root,
      WHITELILY_COMPONENT_TEST_MODE_PATH: fixture.modePath,
    },
  });
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
  it("rejects a valid hard-linked component preference without changing its external peer", async () => {
    const root = await createTemporaryRoot("whitelily-preference-hardlink-");
    const peer = join(root, "external-peer.json");
    const target = join(root, "minecraft-components.json");
    const bytes = '{"schemaVersion":1,"bridgeEnabled":false,"avatarEnabled":true}';
    await writeFile(peer, bytes, "utf8");
    await link(peer, target);
    const before = await lstat(peer, { bigint: true });

    const result = runPowerShell(componentPreferenceValidator, [], {
      env: { ...process.env, WHITELILY_COMPONENT_PREFERENCES_PATH: target },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await expect(readFile(peer, "utf8")).resolves.toBe(bytes);
    await expect(readFile(target, "utf8")).resolves.toBe(bytes);
    const after = await lstat(peer, { bigint: true });
    expect({ dev: after.dev, ino: after.ino, nlink: after.nlink }).toEqual({
      dev: before.dev,
      ino: before.ino,
      nlink: 2n,
    });
  });

  it("fails closed when an opened component preference path changes identity", async () => {
    const root = await createTemporaryRoot("whitelily-preference-identity-");
    const target = join(root, "minecraft-components.json");
    const original = join(root, "opened-original.json");
    const marker = join(root, "opened.marker");
    const first = '{"schemaVersion":1,"bridgeEnabled":true,"avatarEnabled":false}';
    const replacement = '{"schemaVersion":1,"bridgeEnabled":false,"avatarEnabled":true}';
    await writeFile(target, first, "utf8");
    const validatorPath = join(root, "identity-validator.ps1");
    const source = (await readFile(componentPreferenceValidator, "utf8"))
      .replace("FILE_SHARE_READ, // WHITELILY_TEST_EXISTING_SHARE", "0x00000007,")
      .replace(
        "// WHITELILY_TEST_AFTER_EXISTING_OPEN",
        [
          'string marker = Environment.GetEnvironmentVariable("WHITELILY_COMPONENT_TEST_OPEN_MARKER");',
          'File.WriteAllText(marker, "opened");',
          "System.Threading.Thread.Sleep(1000);",
        ].join("\n                "),
      );
    expect(source).not.toContain("WHITELILY_TEST_EXISTING_SHARE");
    expect(source).not.toContain("WHITELILY_TEST_AFTER_EXISTING_OPEN");
    await writeFile(validatorPath, source, "utf8");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", validatorPath],
      {
        env: {
          ...process.env,
          WHITELILY_COMPONENT_PREFERENCES_PATH: target,
          WHITELILY_COMPONENT_TEST_OPEN_MARKER: marker,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const exit = new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", resolveExit);
    });
    try {
      await vi.waitFor(async () => expect(readFile(marker, "utf8")).resolves.toBe("opened"), {
        timeout: 10_000,
        interval: 25,
      });
      await rename(target, original);
      await writeFile(target, replacement, "utf8");
      const status = await exit;
      expect(status).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      await expect(readFile(original, "utf8")).resolves.toBe(first);
      await expect(readFile(target, "utf8")).resolves.toBe(replacement);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it("executes no-clobber component preference publication across collision and cleanup boundaries", async () => {
    const fixture = await createNsisComponentPreferenceFixture();
    const enabled = '{"schemaVersion":1,"bridgeEnabled":true,"avatarEnabled":true}';
    const disabled = '{"schemaVersion":1,"bridgeEnabled":false,"avatarEnabled":false}';

    let result = await runNsisComponentPreferenceFixture(fixture, "fresh");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    await expect(readFile(fixture.preferences, "utf8")).resolves.toBe(enabled);
    expect(await readdir(dirname(fixture.preferences))).toEqual(["minecraft-components.json"]);

    await rm(fixture.dataRoot, { recursive: true, force: true });
    await mkdir(dirname(fixture.preferences), { recursive: true });
    await writeFile(fixture.preferences, disabled);
    result = await runNsisComponentPreferenceFixture(fixture, "upgrade");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    await expect(readFile(fixture.preferences, "utf8")).resolves.toBe(disabled);

    const validExistingPreferences = [
      '{"schemaVersion":1,"bridgeEnabled":false,"avatarEnabled":true}',
      '{\n  "avatarEnabled": false,\n  "bridgeEnabled": true,\n  "schemaVersion": 1\n}\n',
    ];
    for (const existing of validExistingPreferences) {
      await rm(fixture.dataRoot, { recursive: true, force: true });
      await mkdir(dirname(fixture.preferences), { recursive: true });
      await writeFile(fixture.preferences, existing);
      result = await runNsisComponentPreferenceFixture(fixture, "upgrade");
      expect(result.status, `${existing}\n${result.stdout}\n${result.stderr}`).toBe(0);
      await expect(readFile(fixture.preferences, "utf8")).resolves.toBe(existing);
    }

    const invalidExistingPreferences = [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(enabled)]),
      Buffer.from(
        '{"schemaVersion":1,"schemaVersion":1,"bridgeEnabled":true,"avatarEnabled":true}',
      ),
      Buffer.from(
        '{"SchemaVersion":1,"schemaVersion":1,"bridgeEnabled":true,"avatarEnabled":true}',
      ),
      Buffer.from('{"schemaVersion":1,"bridgeEnabled":true,"avatarEnabled":true,"extra":false}'),
      Buffer.from('{"schemaVersion":1,"bridgeEnabled":true}'),
      Buffer.from('{"schemaVersion":1,"bridgeEnabled":"true","avatarEnabled":true}'),
      Buffer.from('{"schemaVersion":1,"bridgeEnabled":true,"avatarEnabled":true,}'),
      Buffer.from("malformed"),
      Buffer.alloc(4097, 0x20),
    ];
    for (const existing of invalidExistingPreferences) {
      await rm(fixture.dataRoot, { recursive: true, force: true });
      await mkdir(dirname(fixture.preferences), { recursive: true });
      await writeFile(fixture.preferences, existing);
      result = await runNsisComponentPreferenceFixture(fixture, "upgrade");
      expect(result.status, "invalid preference timed out").not.toBeNull();
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      await expect(readFile(fixture.preferences)).resolves.toEqual(existing);
    }

    await rm(fixture.dataRoot, { recursive: true, force: true });
    result = await runNsisComponentPreferenceFixture(fixture, "collision-valid");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    await expect(readFile(fixture.preferences, "utf8")).resolves.toBe(disabled);
    expect(await readdir(dirname(fixture.preferences))).toEqual(["minecraft-components.json"]);

    await rm(fixture.dataRoot, { recursive: true, force: true });
    result = await runNsisComponentPreferenceFixture(fixture, "collision-valid-pretty");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    await expect(readFile(fixture.preferences, "utf8")).resolves.toContain('"avatarEnabled": true');

    await rm(fixture.dataRoot, { recursive: true, force: true });
    const existingHardlinkPeer = join(fixture.root, "existing-hardlink-peer.json");
    await rm(existingHardlinkPeer, { force: true });
    await mkdir(dirname(fixture.preferences), { recursive: true });
    await writeFile(existingHardlinkPeer, disabled, "utf8");
    await link(existingHardlinkPeer, fixture.preferences);
    const existingPeerBefore = await lstat(existingHardlinkPeer, { bigint: true });
    result = await runNsisComponentPreferenceFixture(fixture, "upgrade-hardlink");
    expect(result.status, "existing hardlink timed out").not.toBeNull();
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    await expect(readFile(existingHardlinkPeer, "utf8")).resolves.toBe(disabled);
    await expect(readFile(fixture.preferences, "utf8")).resolves.toBe(disabled);
    const existingPeerAfter = await lstat(existingHardlinkPeer, { bigint: true });
    expect({ dev: existingPeerAfter.dev, ino: existingPeerAfter.ino }).toEqual({
      dev: existingPeerBefore.dev,
      ino: existingPeerBefore.ino,
    });

    await rm(fixture.dataRoot, { recursive: true, force: true });
    result = await runNsisComponentPreferenceFixture(fixture, "collision-hardlink");
    expect(result.status, "collision hardlink timed out").not.toBeNull();
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    await expect(readFile(fixture.hardlinkPeerPath, "utf8")).resolves.toBe(disabled);
    await expect(readFile(fixture.preferences, "utf8")).resolves.toBe(disabled);
    const [collisionPeer, collisionTarget] = await Promise.all([
      lstat(fixture.hardlinkPeerPath, { bigint: true }),
      lstat(fixture.preferences, { bigint: true }),
    ]);
    expect({
      dev: collisionTarget.dev,
      ino: collisionTarget.ino,
      nlink: collisionTarget.nlink,
    }).toEqual({ dev: collisionPeer.dev, ino: collisionPeer.ino, nlink: 2n });

    await rm(fixture.dataRoot, { recursive: true, force: true });
    result = await runNsisComponentPreferenceFixture(fixture, "temp-replacement-before-publish");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    await expect(readFile(fixture.attackResultPath, "utf8")).resolves.toBe("blocked");
    await expect(readFile(fixture.preferences, "utf8")).resolves.toBe(enabled);
    const publicationTemp = await readFile(fixture.tempPathRecord, "utf8");
    await expect(readFile(publicationTemp)).rejects.toThrow();
    await expect(readFile(fixture.relocatedTempPath)).rejects.toThrow();

    await rm(fixture.dataRoot, { recursive: true, force: true });
    result = await runNsisComponentPreferenceFixture(fixture, "temp-hardlink-before-publish");
    expect(result.status, "temp hardlink attack timed out").not.toBeNull();
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    await expect(readFile(fixture.preferences)).rejects.toThrow();
    await expect(readFile(fixture.hardlinkPeerPath, "utf8")).resolves.toBe(enabled);
    await expect(lstat(fixture.hardlinkPeerPath, { bigint: true })).resolves.toMatchObject({
      nlink: 1n,
    });
    const hardlinkedTemp = await readFile(fixture.tempPathRecord, "utf8");
    await expect(readFile(hardlinkedTemp)).rejects.toThrow();

    await rm(fixture.dataRoot, { recursive: true, force: true });
    result = await runNsisComponentPreferenceFixture(fixture, "temp-replacement-before-cleanup");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    await expect(readFile(fixture.attackResultPath, "utf8")).resolves.toBe("blocked");
    await expect(readFile(fixture.preferences, "utf8")).resolves.toBe(disabled);
    const collisionTemp = await readFile(fixture.tempPathRecord, "utf8");
    await expect(readFile(collisionTemp)).rejects.toThrow();
    await expect(readFile(fixture.relocatedTempPath)).rejects.toThrow();

    for (const mode of [
      "collision-malformed",
      "collision-reparse",
      "missing-temp-noncollision",
      "race-replacement",
    ]) {
      await rm(fixture.dataRoot, { recursive: true, force: true });
      result = await runNsisComponentPreferenceFixture(fixture, mode);
      expect(result.status, `${mode} timed out`).not.toBeNull();
      expect(result.status, `${mode}\n${result.stdout}\n${result.stderr}`).not.toBe(0);
    }

    await rm(fixture.dataRoot, { recursive: true, force: true });
    try {
      result = await runNsisComponentPreferenceFixture(fixture, "access-denied");
      expect(result.status, "access-denied timed out").not.toBeNull();
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      const lastError = Number((await readFile(fixture.lastErrorPath, "utf8")).trim());
      expect(lastError).toBe(5);
      await expect(readFile(fixture.preferences)).rejects.toThrow();
    } finally {
      const restore = runPowerShell(fixture.hookPath, [
        "-Phase",
        "restore-acl",
        "-ModePath",
        fixture.modePath,
        "-TargetPath",
        fixture.preferences,
        "-TempPath",
        "unused",
        "-Root",
        fixture.root,
      ]);
      expect(restore.status, `${restore.stdout}\n${restore.stderr}`).toBe(0);
    }
    expect(await readdir(dirname(fixture.preferences))).toEqual([]);

    await rm(fixture.dataRoot, { recursive: true, force: true });
    const outsideConfig = join(fixture.root, "outside-config");
    const outsidePreferences = join(outsideConfig, "minecraft-components.json");
    await mkdir(outsideConfig, { recursive: true });
    await writeFile(outsidePreferences, disabled);
    await mkdir(fixture.dataRoot, { recursive: true });
    await symlink(outsideConfig, dirname(fixture.preferences), "junction");
    result = await runNsisComponentPreferenceFixture(fixture, "upgrade");
    expect(result.status, "reparse config parent timed out").not.toBeNull();
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    await expect(readFile(outsidePreferences, "utf8")).resolves.toBe(disabled);
    await rm(dirname(fixture.preferences), { force: true });

    await rm(fixture.dataRoot, { recursive: true, force: true });
    result = await runNsisComponentPreferenceFixture(fixture, "cleanup-lock");
    expect(result.status, "cleanup-lock timed out").not.toBeNull();
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    await expect(readFile(fixture.preferences, "utf8")).resolves.toBe(enabled);
    expect(await readdir(dirname(fixture.preferences))).toEqual(["minecraft-components.json"]);
  }, 120_000);

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
  }, 20_000);

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
  it("verifies the exact reviewed Minecraft component directory separately", async () => {
    const source = await readFile(inspectScript, "utf8");

    expect(source).toContain("$sourceManifest.paths.minecraftComponents");
    expect(source).toContain("INSTALLER_MINECRAFT_COMPONENT_RESOURCES_INVALID");
    expect(source).toMatch(/\$minecraftComponentResources\.Count\s+-ne\s+9/u);
    expect(source).toContain("minecraftComponentResourcesVerified");
    expect(source).toMatch(/executableFiles[\s\S]*?minecraftComponentPrefix/iu);
    expect(source).toMatch(/scriptFiles[\s\S]*?minecraftComponentPrefix/iu);
  });

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

  it("binds packaged component descriptors and bytes to the independent reviewed policy", async () => {
    const baseline = await createRepositoryFixture();
    const baselineResult = runPowerShell(
      join(baseline.root, "scripts", "inspect-installer.ps1"),
      ["-InstallerPath", baseline.installer, "-ExpectedVersion", version],
      { cwd: baseline.root, env: baseline.environment, timeout: 120_000 },
    );
    expect(baselineResult.status, `${baselineResult.stdout}\n${baselineResult.stderr}`).toBe(0);

    for (const options of [
      { coordinatedComponentRewrite: true },
      { sourceComponentPinMismatch: true },
    ]) {
      const fixture = await createRepositoryFixture(options);
      const result = runPowerShell(
        join(fixture.root, "scripts", "inspect-installer.ps1"),
        ["-InstallerPath", fixture.installer, "-ExpectedVersion", version],
        { cwd: fixture.root, env: fixture.environment, timeout: 120_000 },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/MINECRAFT_COMPONENT|component|pin/iu);
    }
  }, 180_000);
});

describe("WhiteLily isolated installer lifecycle", () => {
  it("binds installed component descriptors and bytes to reviewed pins and rejects set/link drift", async () => {
    const baseline = await createInstalledComponentFixture();
    const baselineResult = runInstalledComponentVerifier(baseline);
    expect(baselineResult.status, `${baselineResult.stdout}\n${baselineResult.stderr}`).toBe(0);
    expect(baselineResult.stdout).toBe("9");

    const coordinated = await createInstalledComponentFixture();
    const replacement = Buffer.from("coordinated installed replacement", "utf8");
    await writeFile(join(coordinated.componentRoot, coordinated.paths[0]!), replacement);
    const coordinatedRuntime = JSON.parse(await readFile(coordinated.runtimePath, "utf8")) as {
      resources: Array<{ path: string; bytes: number; sha256: string }>;
    };
    coordinatedRuntime.resources[0]!.bytes = replacement.length;
    coordinatedRuntime.resources[0]!.sha256 = createHash("sha256")
      .update(replacement)
      .digest("hex");
    await writeFile(coordinated.runtimePath, JSON.stringify(coordinatedRuntime));

    const missing = await createInstalledComponentFixture();
    await rm(join(missing.componentRoot, missing.paths[0]!));

    const hardLinked = await createInstalledComponentFixture();
    const hardLinkedComponent = join(hardLinked.componentRoot, hardLinked.paths[0]!);
    const hardLinkPeer = join(hardLinked.root, "foreign-component-peer.jar");
    await link(hardLinkedComponent, hardLinkPeer);

    const embeddedPinDrift = await createInstalledComponentFixture();
    const driftedRuntime = JSON.parse(await readFile(embeddedPinDrift.runtimePath, "utf8")) as {
      allowlist: { exactFiles: Array<{ sha256: string }> };
    };
    driftedRuntime.allowlist.exactFiles[0]!.sha256 = "0".repeat(64);
    await writeFile(embeddedPinDrift.runtimePath, JSON.stringify(driftedRuntime));

    const extra = await createInstalledComponentFixture();
    await writeFile(join(extra.componentRoot, "unreviewed.jar"), "unreviewed");

    const linked = await createInstalledComponentFixture();
    const outside = join(linked.root, "outside-components");
    await rename(linked.componentRoot, outside);
    await symlink(outside, linked.componentRoot, "junction");

    for (const fixture of [coordinated, embeddedPinDrift, missing, hardLinked, extra, linked]) {
      const result = runInstalledComponentVerifier(fixture);
      expect(result.status).not.toBe(0);
    }
    await expect(readFile(hardLinkPeer)).resolves.toEqual(await readFile(hardLinkedComponent));
  }, 60_000);

  it("verifies packaged components and absent-only component preferences across the 15 stages", async () => {
    const source = await readFile(lifecycleScript, "utf8");

    expect(source).toContain("__WHITELILY_REVIEWED_COMPONENT_VERIFIER__");
    expect(source).toContain("Assert-ReviewedMinecraftComponentResources");
    expect(source).toContain("minecraftComponentResources");
    expect(source).toContain("componentPreferencesFresh");
    expect(source).toContain("componentPreferencesUpgradePreserved");
    expect(source).toContain("componentPreferencesKeepPreserved");
    expect(source).toContain('{"schemaVersion":1,"bridgeEnabled":true,"avatarEnabled":true}');
    expect(source).toContain('{"schemaVersion":1,"bridgeEnabled":false,"avatarEnabled":false}');
    expect(source.match(/Assert-ExactComponentPreferences/gu)).toHaveLength(5);
    expect(source).toMatch(/\[int\]\$report\.minecraftComponentResources\s+-ne\s+9/u);
    expect(source).toMatch(/\$report\.componentPreferencesFresh\s+-ne\s+\$true/u);
    expect(source).toMatch(/\$report\.componentPreferencesUpgradePreserved\s+-ne\s+\$true/u);
    expect(source).toMatch(/\$report\.componentPreferencesKeepPreserved\s+-ne\s+\$true/u);
  });

  it("separates a SYSTEM-owned trusted controller from the standard candidate user", async () => {
    const source = await readFile(lifecycleScript, "utf8");

    expect(source).toContain("S-1-5-18");
    expect(source).toMatch(/New-LocalUser|\bnet\.exe\b/u);
    expect(source).toMatch(/-UserId\s+['"]SYSTEM['"]/u);
    expect(source).toContain("candidateReportWriteDenied");
    expect(source).toContain("controllerSid");
    expect(source).toContain("candidateSid");
    expect(source).toContain("Registry::HKEY_USERS");
    expect(source).toMatch(/icacls\.exe/u);
    expect(source).toContain("candidate user creation failed with exit code");
    expect(source).toContain("$previousErrorActionPreference = $ErrorActionPreference");
    expect(source).toContain("$ErrorActionPreference = 'Continue'");
    expect(source).toContain("$ErrorActionPreference = $previousErrorActionPreference");
  });

  it("uses a noninteractive legacy-compatible password for the disposable candidate user", async () => {
    const source = await readFile(lifecycleScript, "utf8");

    expect(source).toContain("[Guid]::NewGuid().ToString('N').Substring(0, 11)");
    expect(source).toContain("$candidatePassword = 'WL!'");
  });

  it("runs candidate operations through a trusted interactive broker instead of using credentials from SYSTEM", async () => {
    const source = await readFile(lifecycleScript, "utf8");

    expect(source).not.toContain("WhiteLilyCandidateOperation-");
    expect(source).not.toContain("-Credential $script:CandidateCredential");
    expect(source).toContain("function Invoke-CandidateBroker");
    expect(source).toContain("candidate broker must not run as SYSTEM");
    expect(source).toContain("-Credential $CandidateCredential");
    expect(source).toContain("-LoadUserProfile");
    expect(source).toContain("$request.controllerSid");
    expect(source).toContain("candidate request was not issued by SYSTEM");
    expect(source).toContain("$response.brokerSid");
    expect(source).toContain("candidate process principal mismatch");
    expect(source).toContain("if ($Mode -eq 'Candidate') { exit 92 }");
  });

  it("accepts only a host-keyed envelope for the SYSTEM lifecycle report transport", async () => {
    const source = await readFile(lifecycleScript, "utf8");

    expect(source).toContain("$trustedControlRoot = 'C:\\ProgramData\\WhiteLilyLifecycle'");
    expect(source).toContain("bootstrap-secret.txt");
    expect(source).toContain(
      "Remove-Item -LiteralPath 'C:\\WhiteLilyReport\\bootstrap-secret.txt' -Force",
    );
    expect(source).toContain("HMACSHA256");
    expect(source).toContain("transportSchemaVersion");
    expect(source).toContain("SANDBOX_LIFECYCLE_UNTRUSTED_REPORT");
    expect(source).toContain("Get-TrustedSandboxEnvelope");
  });

  it("resolves candidate per-user installation and data beneath the candidate LocalAppData profile", async () => {
    const source = await readFile(lifecycleScript, "utf8");
    const forgeProof = source.indexOf("$result.stages.Add('candidate_write_denied')");
    const refreshedProfile = source.indexOf(
      "$profileRoot = Get-CandidateProfileRoot -Sid $script:CandidateSid",
      forgeProof,
    );

    expect(source).toContain("Join-Path $profileRoot 'AppData\\Local'");
    expect(forgeProof).toBeGreaterThan(-1);
    expect(refreshedProfile).toBeGreaterThan(forgeProof);
  });

  it("retries candidate registry hive unload within a bounded deadline", async () => {
    const source = await readFile(lifecycleScript, "utf8");

    expect(source).toContain("$unloadDeadline = [DateTime]::UtcNow.AddSeconds(30)");
    expect(source).toContain("while ([DateTime]::UtcNow -lt $unloadDeadline)");
    expect(source).toContain("candidate user registry hive remained mounted after bounded unload");
  });

  it("rejects a candidate-forged lifecycle result when the trusted SYSTEM report is absent", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
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
          WHITELILY_FAKE_SANDBOX_FORGE_ONLY: "1",
          WHITELILY_SANDBOX_TIMEOUT_SECONDS: "2",
        },
        timeout: 120_000,
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("SANDBOX_LIFECYCLE_REPORT_MISSING");
    await expect(
      readFile(join(fixture.root, "build", "candidate-forged-result.json"), "utf8"),
    ).resolves.toContain("AccessDenied");
    await expect(
      readFile(
        join(fixture.root, "release", `WhiteLily-${version}-windows-x64-installer-lifecycle.json`),
        "utf8",
      ),
    ).rejects.toThrow();
  }, 180_000);

  it("preserves a contaminated mapped tree without following a junction outside it", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    await createDelegatingSandboxLauncher(fakeWindowsRoot);
    const externalRoot = await createTemporaryRoot("whitelily-external-sentinel-");
    const sentinel = join(externalRoot, "keep-me.txt");
    await writeFile(sentinel, "preserve\n", "utf8");
    const contaminatorScript = join(fixture.root, "create-mapped-junction.ps1");
    const contaminatorReady = join(fixture.root, "mapped-junction.ready");
    await writeFile(
      contaminatorScript,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$BuildRoot,",
        "    [Parameter(Mandatory = $true)][string]$TargetRoot,",
        "    [Parameter(Mandatory = $true)][string]$ReadyPath",
        ")",
        "$ErrorActionPreference = 'Stop'",
        "$deadline = [DateTime]::UtcNow.AddSeconds(30)",
        "$junctionPath = $null",
        "do {",
        "    $sandboxRoot = Get-ChildItem -LiteralPath $BuildRoot -Directory -Filter 'installer-sandbox-*' -ErrorAction SilentlyContinue | Select-Object -First 1",
        "    if ($null -ne $sandboxRoot) {",
        "        $reportRoot = Join-Path $sandboxRoot.FullName 'report'",
        "        if (Test-Path -LiteralPath $reportRoot -PathType Container) {",
        "            $junctionPath = Join-Path $reportRoot 'candidate-junction'",
        "            New-Item -ItemType Junction -Path $junctionPath -Target $TargetRoot | Out-Null",
        "            break",
        "        }",
        "    }",
        "    Start-Sleep -Milliseconds 50",
        "} while ([DateTime]::UtcNow -lt $deadline)",
        "if ($null -eq $junctionPath) { throw 'JUNCTION_TARGET_NOT_FOUND' }",
        "[IO.File]::WriteAllText($ReadyPath, $junctionPath)",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const contaminator = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        contaminatorScript,
        "-BuildRoot",
        join(fixture.root, "build"),
        "-TargetRoot",
        externalRoot,
        "-ReadyPath",
        contaminatorReady,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    let result: CommandResult;
    try {
      result = runPowerShell(
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
    } finally {
      contaminator.kill();
    }

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("SANDBOX_MAPPING_CONTAMINATED");
    await expect(readFile(contaminatorReady, "utf8")).resolves.toContain("candidate-junction");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve\n");
    const retained = (await readdir(join(fixture.root, "build"))).filter((entry) =>
      entry.startsWith("installer-sandbox-"),
    );
    expect(retained).toHaveLength(1);
  }, 180_000);

  it("does not enumerate or terminate WindowsSandboxRemoteSession processes", async () => {
    const source = await readFile(lifecycleScript, "utf8");

    expect(source).not.toContain("WindowsSandboxRemoteSession.exe");
    expect(source).not.toMatch(/\$sandboxProcess\.Kill\(/u);
  });

  it("embeds the file attribute authority in the guest scope that calls it", async () => {
    const root = await createTemporaryRoot("whitelily-guest-scope-");
    const ordinaryFile = join(root, "ordinary.txt");
    const harness = join(root, "verify-guest-helper-scope.ps1");
    await writeFile(ordinaryFile, "ordinary\n", "utf8");
    await writeFile(
      harness,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$LifecycleScript,",
        "    [Parameter(Mandatory = $true)][string]$OrdinaryFile",
        ")",
        "$ErrorActionPreference = 'Stop'",
        "$scriptText = [IO.File]::ReadAllText($LifecycleScript)",
        "$guestMatch = [regex]::Match($scriptText, \"(?s)\\$guestScript = @'\\r?\\n(?<guest>.*?)\\r?\\n'@\")",
        "if (-not $guestMatch.Success) { throw 'GUEST_SCRIPT_MISSING' }",
        "$tokens = $null",
        "$errors = $null",
        "$ast = [Management.Automation.Language.Parser]::ParseInput($guestMatch.Groups['guest'].Value, [ref]$tokens, [ref]$errors)",
        "if ($errors.Count -ne 0) { throw 'GUEST_SCRIPT_INVALID' }",
        "$definitions = @($ast.FindAll({",
        "    param($node)",
        "    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and",
        "        $node.Name -eq 'Test-FileSystemEntryHasAttribute'",
        "}, $true))",
        "$calls = @($ast.FindAll({",
        "    param($node)",
        "    $node -is [Management.Automation.Language.CommandAst] -and",
        "        $node.GetCommandName() -eq 'Test-FileSystemEntryHasAttribute'",
        "}, $true))",
        "if ($definitions.Count -ne 1 -or $calls.Count -lt 1) { throw 'GUEST_ATTRIBUTE_AUTHORITY_MISSING' }",
        "Invoke-Expression $definitions[0].Extent.Text",
        "$entry = Get-Item -LiteralPath $OrdinaryFile -Force",
        "if (Test-FileSystemEntryHasAttribute -Entry $entry -Attribute ([IO.FileAttributes]::ReparsePoint)) { throw 'ORDINARY_FILE_REJECTED' }",
        '[Console]::Out.WriteLine(\'{"status":"ok"}\')',
        "",
      ].join("\r\n"),
      "utf8",
    );

    const result = runPowerShell(harness, [
      "-LifecycleScript",
      lifecycleScript,
      "-OrdinaryFile",
      ordinaryFile,
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe('{"status":"ok"}');
    expect(result.stderr).toBe("");
  });

  it("fails removal proof when any installed program artifact remains", async () => {
    const root = await createTemporaryRoot("whitelily-removal-proof-");
    const programRoot = join(root, "Programs", "WhiteLily");
    const dataRoot = join(root, "WhiteLilyData");
    await mkdir(programRoot, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await writeFile(join(programRoot, "WhiteLily.exe"), "residual", "utf8");
    const harness = join(root, "verify-removal-proof.ps1");
    await writeFile(
      harness,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$LifecycleScript,",
        "    [Parameter(Mandatory = $true)][string]$ProgramRoot,",
        "    [Parameter(Mandatory = $true)][string]$DataRoot",
        ")",
        "$ErrorActionPreference = 'Stop'",
        "$scriptText = [IO.File]::ReadAllText($LifecycleScript)",
        "$guestMatch = [regex]::Match($scriptText, \"(?s)\\$guestScript = @'\\r?\\n(?<guest>.*?)\\r?\\n'@\")",
        "if (-not $guestMatch.Success) { throw 'GUEST_SCRIPT_MISSING' }",
        "$tokens = $null",
        "$errors = $null",
        "$ast = [Management.Automation.Language.Parser]::ParseInput($guestMatch.Groups['guest'].Value, [ref]$tokens, [ref]$errors)",
        "$functionAst = $ast.Find({",
        "    param($node)",
        "    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and",
        "        $node.Name -eq 'Assert-WhiteLilyRemovalState'",
        "}, $true)",
        "if ($null -eq $functionAst) { throw 'REMOVAL_PROOF_MISSING' }",
        "Invoke-Expression $functionAst.Extent.Text",
        "try {",
        "    Assert-WhiteLilyRemovalState -ProgramRoot $ProgramRoot -DataRoot $DataRoot -ProductEntryCount 0 -KeepData $true -TimeoutMilliseconds 250",
        "    throw 'RESIDUAL_WAS_ACCEPTED'",
        "} catch {",
        "    if ($_.Exception.Message -eq 'RESIDUAL_WAS_ACCEPTED') { throw }",
        "    [Console]::Out.WriteLine($_.Exception.Message)",
        "}",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const result = runPowerShell(harness, [
      "-LifecycleScript",
      lifecycleScript,
      "-ProgramRoot",
      programRoot,
      "-DataRoot",
      dataRoot,
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("WhiteLily program artifacts remained after uninstall");
  });

  it("requires a real WhiteLily window and rejects any Error window from the app process", async () => {
    const root = await createTemporaryRoot("whitelily-smoke-window-");
    const sourcePath = join(root, "SmokeWindowFixture.cs");
    const compilerPath = join(root, "compile-smoke-window.ps1");
    const fixturePath = join(root, "SmokeWindowFixture.exe");
    await writeFile(
      sourcePath,
      String.raw`
using System;
using System.Windows.Forms;

public static class SmokeWindowFixture {
    [STAThread]
    public static int Main(string[] args) {
        var mode = args.Length == 0 ? "white" : args[0];
        if (StringComparer.Ordinal.Equals(mode, "exit")) return 0;
        Application.EnableVisualStyles();
        var main = new Form {
            Text = StringComparer.Ordinal.Equals(mode, "error")
                ? "Error"
                : StringComparer.Ordinal.Equals(mode, "blank") ? "" : "WhiteLily",
            Width = 320,
            Height = 200,
            ShowInTaskbar = true
        };
        Form error = null;
        if (StringComparer.Ordinal.Equals(mode, "both")) {
            main.Shown += (sender, eventArgs) => {
                error = new Form { Text = "Error", Width = 240, Height = 120 };
                error.Show(main);
            };
        }
        Application.Run(main);
        if (error != null) error.Dispose();
        return 0;
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
        "Add-Type -TypeDefinition ([IO.File]::ReadAllText($SourcePath)) -Language CSharp -ReferencedAssemblies @('System.Windows.Forms.dll', 'System.Drawing.dll') -OutputAssembly $OutputPath -OutputType WindowsApplication",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const compilation = runPowerShell(compilerPath, [
      "-SourcePath",
      sourcePath,
      "-OutputPath",
      fixturePath,
    ]);
    expect(compilation.status, `${compilation.stdout}\n${compilation.stderr}`).toBe(0);

    const harness = join(root, "verify-smoke-window.ps1");
    await writeFile(
      harness,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$LifecycleScript,",
        "    [Parameter(Mandatory = $true)][string]$FixturePath",
        ")",
        "$ErrorActionPreference = 'Stop'",
        "$scriptText = [IO.File]::ReadAllText($LifecycleScript)",
        "$guestMatch = [regex]::Match($scriptText, \"(?s)\\$guestScript = @'\\r?\\n(?<guest>.*?)\\r?\\n'@\")",
        "if (-not $guestMatch.Success) { throw 'GUEST_SCRIPT_MISSING' }",
        "$guestText = $guestMatch.Groups['guest'].Value",
        "$typeMatch = [regex]::Match($guestText, '(?s)Add-Type -TypeDefinition @\"\\r?\\n(?<code>.*?public static class WhiteLilySmokeWindows.*?)\\r?\\n\"@')",
        "if (-not $typeMatch.Success) { throw 'SMOKE_WINDOW_ENUMERATOR_MISSING' }",
        "Add-Type -TypeDefinition $typeMatch.Groups['code'].Value",
        "$tokens = $null",
        "$errors = $null",
        "$ast = [Management.Automation.Language.Parser]::ParseInput($guestText, [ref]$tokens, [ref]$errors)",
        "$functionAst = $ast.Find({",
        "    param($node)",
        "    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and",
        "        $node.Name -eq 'Wait-WhiteLilyMainWindow'",
        "}, $true)",
        "if ($null -eq $functionAst) { throw 'SMOKE_WINDOW_WAIT_MISSING' }",
        "Invoke-Expression $functionAst.Extent.Text",
        "function Invoke-WindowCase {",
        "    param([string]$Mode, [int]$TimeoutMilliseconds)",
        "    $process = Start-Process -FilePath $FixturePath -ArgumentList @($Mode) -PassThru",
        "    try {",
        "        Wait-WhiteLilyMainWindow $process -TimeoutMilliseconds $TimeoutMilliseconds",
        "        return 'success'",
        "    } catch {",
        "        return $_.Exception.Message",
        "    } finally {",
        "        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }",
        "        $process.Dispose()",
        "    }",
        "}",
        "$results = [ordered]@{",
        "    white = Invoke-WindowCase 'white' 3000",
        "    error = Invoke-WindowCase 'error' 3000",
        "    both = Invoke-WindowCase 'both' 3000",
        "    exit = Invoke-WindowCase 'exit' 3000",
        "    blank = Invoke-WindowCase 'blank' 500",
        "}",
        "$results | ConvertTo-Json -Compress",
        "",
      ].join("\r\n"),
      "utf8",
    );

    const verification = runPowerShell(harness, [
      "-LifecycleScript",
      lifecycleScript,
      "-FixturePath",
      fixturePath,
    ]);
    expect(verification.status, `${verification.stdout}\n${verification.stderr}`).toBe(0);
    expect(JSON.parse(verification.stdout)).toEqual({
      white: "success",
      error: "installer smoke application displayed an error window",
      both: "installer smoke application displayed an error window",
      exit: "installer smoke application exited before opening its main window: 0",
      blank: "installer smoke application did not open the WhiteLily main window",
    });
  }, 180_000);

  it("tracks only the exact WindowsSandbox process returned by Start-Process", async () => {
    const source = await readFile(lifecycleScript, "utf8");

    expect(source).toContain("$sandboxProcess.HasExited -and $sandboxProcess.ExitCode -ne 0");
    expect(source).toContain("$allowSandboxCleanup");
    expect(source).not.toMatch(/Get-CimInstance[\s\S]*WindowsSandboxRemoteSession/u);
    expect(source).not.toMatch(/\$sandboxProcess\.Kill\(/u);
  });

  it("accepts only the trusted controller report after the exact Sandbox process exits", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
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
      ],
    });
  }, 180_000);

  it("waits for the Sandbox mapping to close before removing lifecycle artifacts", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    await createDelegatingSandboxLauncher(fakeWindowsRoot);
    const lockerScript = join(fixture.root, "hold-sandbox-mapping.ps1");
    const lockerReady = join(fixture.root, "sandbox-mapping-lock.ready");
    await writeFile(
      lockerScript,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$BuildRoot,",
        "    [Parameter(Mandatory = $true)][string]$ReadyPath",
        ")",
        "$ErrorActionPreference = 'Stop'",
        "$deadline = [DateTime]::UtcNow.AddSeconds(30)",
        "$target = $null",
        "do {",
        "    $target = Get-ChildItem -LiteralPath $BuildRoot -File -Recurse -Filter 'guest-lifecycle.ps1' -ErrorAction SilentlyContinue | Select-Object -First 1",
        "    if ($null -ne $target) { break }",
        "    Start-Sleep -Milliseconds 50",
        "} while ([DateTime]::UtcNow -lt $deadline)",
        "if ($null -eq $target) { throw 'LOCK_TARGET_NOT_FOUND' }",
        "$stream = [IO.File]::Open($target.FullName, 'Open', 'Read', 'Read')",
        "try {",
        "    [IO.File]::WriteAllText($ReadyPath, $target.FullName)",
        "    Start-Sleep -Seconds 12",
        "} finally { $stream.Dispose() }",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const locker = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        lockerScript,
        "-BuildRoot",
        join(fixture.root, "build"),
        "-ReadyPath",
        lockerReady,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    let result: CommandResult;
    try {
      result = runPowerShell(
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
    } finally {
      locker.kill();
    }

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    await expect(readFile(lockerReady, "utf8")).resolves.toContain("guest-lifecycle.ps1");
    await expect(readdir(join(fixture.root, "build"))).resolves.not.toContainEqual(
      expect.stringMatching(/^installer-sandbox-/u),
    );
  }, 180_000);

  it("retries non-recursive removal while an empty mapped report directory is still open", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    await createDelegatingSandboxLauncher(fakeWindowsRoot);
    const lockerScript = join(fixture.root, "hold-report-directory.ps1");
    const lockerReady = join(fixture.root, "report-directory-lock.ready");
    await writeFile(
      lockerScript,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$BuildRoot,",
        "    [Parameter(Mandatory = $true)][string]$ReadyPath",
        ")",
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -TypeDefinition @'",
        "using System;",
        "using System.ComponentModel;",
        "using System.Runtime.InteropServices;",
        "using Microsoft.Win32.SafeHandles;",
        "public static class DirectoryLock {",
        '    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
        "    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);",
        "    public static SafeFileHandle Open(string path) {",
        "        var handle = CreateFileW(path, 1, 3, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);",
        "        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());",
        "        return handle;",
        "    }",
        "}",
        "'@",
        "$deadline = [DateTime]::UtcNow.AddSeconds(30)",
        "$reportRoot = $null",
        "do {",
        "    $sandboxRoot = Get-ChildItem -LiteralPath $BuildRoot -Directory -Filter 'installer-sandbox-*' -ErrorAction SilentlyContinue | Select-Object -First 1",
        "    if ($null -ne $sandboxRoot) {",
        "        $candidate = Join-Path $sandboxRoot.FullName 'report'",
        "        if (Test-Path -LiteralPath $candidate -PathType Container) { $reportRoot = $candidate; break }",
        "    }",
        "    Start-Sleep -Milliseconds 50",
        "} while ([DateTime]::UtcNow -lt $deadline)",
        "if ($null -eq $reportRoot) { throw 'REPORT_DIRECTORY_NOT_FOUND' }",
        "$handle = [DirectoryLock]::Open($reportRoot)",
        "try {",
        "    [IO.File]::WriteAllText($ReadyPath, $reportRoot)",
        "    Start-Sleep -Seconds 12",
        "} finally { $handle.Dispose() }",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const locker = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        lockerScript,
        "-BuildRoot",
        join(fixture.root, "build"),
        "-ReadyPath",
        lockerReady,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    const startedAt = Date.now();
    let result: CommandResult;
    try {
      result = runPowerShell(
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
    } finally {
      locker.kill();
    }

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(11_500);
    await expect(readFile(lockerReady, "utf8")).resolves.toContain("report");
    await expect(readdir(join(fixture.root, "build"))).resolves.not.toContainEqual(
      expect.stringMatching(/^installer-sandbox-/u),
    );
  }, 180_000);

  it("fails closed when the exact Sandbox launcher exits before the shutdown guard releases", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    await createDelegatingSandboxLauncher(fakeWindowsRoot);
    const { holder, readyPath } = await startShutdownGuardHolder(fixture.root, 15_000);
    let result: CommandResult;
    try {
      result = runPowerShell(
        join(fixture.root, "scripts", "test-installer.ps1"),
        ["-InstallerPath", releaseInstaller],
        {
          cwd: fixture.root,
          env: {
            ...fixture.environment,
            WINDIR: fakeWindowsRoot,
            WHITELILY_SHUTDOWN_GUARD_TIMEOUT_SECONDS: "2",
          },
          timeout: 120_000,
        },
      );
    } finally {
      holder.kill();
    }

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("SANDBOX_SHUTDOWN_GUARD_TIMEOUT");
    await expect(readFile(readyPath, "utf8")).resolves.toContain("shutdown-guard.lock");
    const retained = (await readdir(join(fixture.root, "build"))).filter((entry) =>
      entry.startsWith("installer-sandbox-"),
    );
    expect(retained).toHaveLength(1);
  }, 180_000);

  it("waits for a released shutdown guard after the exact Sandbox launcher exits", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    await createDelegatingSandboxLauncher(fakeWindowsRoot);
    const { holder, readyPath } = await startShutdownGuardHolder(fixture.root, 8_000);
    const startedAt = Date.now();
    let result: CommandResult;
    try {
      result = runPowerShell(
        join(fixture.root, "scripts", "test-installer.ps1"),
        ["-InstallerPath", releaseInstaller],
        {
          cwd: fixture.root,
          env: {
            ...fixture.environment,
            WINDIR: fakeWindowsRoot,
            WHITELILY_SHUTDOWN_GUARD_TIMEOUT_SECONDS: "20",
          },
          timeout: 120_000,
        },
      );
    } finally {
      holder.kill();
    }

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(7_500);
    await expect(readFile(readyPath, "utf8")).resolves.toContain("shutdown-guard.lock");
    await expect(readdir(join(fixture.root, "build"))).resolves.not.toContainEqual(
      expect.stringMatching(/^installer-sandbox-/u),
    );
  }, 180_000);

  it("waits for the exact Sandbox process to release its mapped files", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
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

  it("does not terminate an unrelated same-name Sandbox session process", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    const sandboxLauncher = await createDelegatingSandboxLauncher(fakeWindowsRoot);
    const unrelatedRoot = await createTemporaryRoot("whitelily-unrelated-sandbox-");
    const unrelatedReportRoot = join(unrelatedRoot, "report");
    const unrelatedConfiguration = join(unrelatedRoot, "Unrelated.wsb");
    await mkdir(unrelatedReportRoot, { recursive: true });
    await writeFile(join(unrelatedReportRoot, "guest-lifecycle.ps1"), "# unrelated\n", "utf8");
    await writeFile(unrelatedConfiguration, "<Configuration />\n", "utf8");
    const identityScript = join(unrelatedRoot, "get-process-identity.ps1");
    await writeFile(
      identityScript,
      [
        "param([Parameter(Mandatory = $true)][int]$ProcessId)",
        "$ErrorActionPreference = 'Stop'",
        "$deadline = [DateTime]::UtcNow.AddSeconds(5)",
        "$current = $null",
        "do {",
        '    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop',
        "    if ($null -ne $current) { break }",
        "    Start-Sleep -Milliseconds 50",
        "} while ([DateTime]::UtcNow -lt $deadline)",
        "if ($null -eq $current) { throw 'PROCESS_NOT_FOUND' }",
        "[pscustomobject]@{",
        "    ProcessId = [int]$current.ProcessId",
        "    Name = [string]$current.Name",
        "    CreationDate = $current.CreationDate",
        "    ExecutablePath = [string]$current.ExecutablePath",
        "    CommandLine = [string]$current.CommandLine",
        "} | ConvertTo-Json -Compress",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const unrelated = spawn(
      join(dirname(sandboxLauncher), "WindowsSandboxRemoteSession.exe"),
      ["--sleeper"],
      {
        env: {
          ...fixture.environment,
          WHITELILY_FAKE_SANDBOX_HOLD_MS: "30000",
        },
        windowsHide: true,
        stdio: "ignore",
      },
    );

    try {
      const initialIdentityResult = runPowerShell(identityScript, [
        "-ProcessId",
        String(unrelated.pid),
      ]);
      expect(
        initialIdentityResult.status,
        `${initialIdentityResult.stdout}\n${initialIdentityResult.stderr}`,
      ).toBe(0);
      const initialIdentity = JSON.parse(initialIdentityResult.stdout) as Record<string, unknown>;
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
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      const currentIdentityResult = runPowerShell(identityScript, [
        "-ProcessId",
        String(unrelated.pid),
      ]);
      expect(
        currentIdentityResult.status,
        `${currentIdentityResult.stdout}\n${currentIdentityResult.stderr}`,
      ).toBe(0);
      expect(JSON.parse(currentIdentityResult.stdout)).toEqual(initialIdentity);
    } finally {
      unrelated.kill();
    }
  }, 180_000);

  it("preserves the guest lifecycle error when mapped-folder cleanup also fails", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
    const fakeWindowsRoot = await createTemporaryRoot("whitelily-fake-windows-");
    await createDelegatingSandboxLauncher(fakeWindowsRoot);
    const lockerScript = join(fixture.root, "hold-sandbox-artifact.ps1");
    const lockerReady = join(fixture.root, "sandbox-artifact-lock.ready");
    await writeFile(
      lockerScript,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$BuildRoot,",
        "    [Parameter(Mandatory = $true)][string]$ReadyPath",
        ")",
        "$ErrorActionPreference = 'Stop'",
        "$deadline = [DateTime]::UtcNow.AddSeconds(30)",
        "$target = $null",
        "do {",
        "    $target = Get-ChildItem -LiteralPath $BuildRoot -File -Recurse -Filter 'guest-lifecycle.ps1' -ErrorAction SilentlyContinue | Select-Object -First 1",
        "    if ($null -ne $target) { break }",
        "    Start-Sleep -Milliseconds 50",
        "} while ([DateTime]::UtcNow -lt $deadline)",
        "if ($null -eq $target) { throw 'LOCK_TARGET_NOT_FOUND' }",
        "$stream = [IO.File]::Open($target.FullName, 'Open', 'Read', 'Read')",
        "try {",
        "    [IO.File]::WriteAllText($ReadyPath, $target.FullName)",
        "    Start-Sleep -Seconds 45",
        "} finally { $stream.Dispose() }",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const locker = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        lockerScript,
        "-BuildRoot",
        join(fixture.root, "build"),
        "-ReadyPath",
        lockerReady,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    let result: CommandResult;
    try {
      result = runPowerShell(
        join(fixture.root, "scripts", "test-installer.ps1"),
        ["-InstallerPath", releaseInstaller, "-WarningAction", "Stop"],
        {
          cwd: fixture.root,
          env: {
            ...fixture.environment,
            WINDIR: fakeWindowsRoot,
            WHITELILY_FAKE_SANDBOX_REPORT_ERROR: "forced guest failure",
          },
          timeout: 120_000,
        },
      );
    } finally {
      locker.kill();
    }

    expect(result.status).not.toBe(0);
    await expect(readFile(lockerReady, "utf8")).resolves.toContain("guest-lifecycle.ps1");
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "SANDBOX_LIFECYCLE_FAILED: forced guest failure",
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain("SANDBOX_CLEANUP_FAILED:");
  }, 180_000);

  it("persists a trusted SYSTEM failure report for diagnosis", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
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
          WHITELILY_FAKE_SANDBOX_REPORT_ERROR: "forced trusted failure",
        },
        timeout: 120_000,
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "SANDBOX_LIFECYCLE_FAILED: forced trusted failure",
    );
    const persisted = JSON.parse(
      await readFile(
        join(fixture.root, "release", `WhiteLily-${version}-windows-x64-installer-lifecycle.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.controllerSid).toBe("S-1-5-18");
    expect(persisted.success).toBe(false);
    expect(persisted.error).toBe("forced trusted failure");
  }, 180_000);

  it("embeds a working SHA-256 verifier in the guest lifecycle script", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
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
    const guestSource = await readFile(capturedGuest, "utf8");
    expect(guestSource).toContain("function Wait-WhiteLilyMainWindow");
    expect(guestSource).toContain("Wait-WhiteLilyMainWindow $applicationProcess");

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

  it("discovers the delegated NSIS uninstaller process by its _?= marker", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
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
    const intermediaryScript = join(fixture.root, "delegating-uninstaller-intermediary.ps1");
    await writeFile(
      intermediaryScript,
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
    await writeFile(
      launcherScript,
      [
        "param(",
        "    [Parameter(Mandatory = $true)][string]$ProgramRoot,",
        "    [Parameter(Mandatory = $true)][string]$ChildScript,",
        "    [Parameter(Mandatory = $true)][string]$IntermediaryScript",
        ")",
        "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
        "$intermediary = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-File', $IntermediaryScript, '-ProgramRoot', $ProgramRoot, '-ChildScript', $ChildScript) -PassThru -WindowStyle Hidden",
        "$intermediary.WaitForExit()",
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
        "    [Parameter(Mandatory = $true)][string]$IntermediaryScript,",
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
        "$launcher = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-File', $LauncherScript, '-ProgramRoot', $ProgramRoot, '-ChildScript', $ChildScript, '-IntermediaryScript', $IntermediaryScript) -PassThru",
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
        '$child = Get-CimInstance Win32_Process -Filter "ProcessId = $childPid"',
        "if ([int]$child.ParentProcessId -eq $launcher.Id) { throw 'MARKER_FALLBACK_NOT_EXERCISED' }",
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
      "-IntermediaryScript",
      intermediaryScript,
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
    const releaseInstaller = await stageLifecycleInstallers(fixture);
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
        "$typeMatches = @([regex]::Matches($scriptText, '(?s)Add-Type -TypeDefinition @\"\\r?\\n(?<code>.*?)\\r?\\n\"@') | Where-Object { $_.Groups['code'].Value.Contains('class WhiteLilyInstallerUi') })",
        "if ($typeMatches.Count -ne 1) { throw 'INSTALLER_UI_TYPE_MISSING' }",
        "Add-Type -TypeDefinition $typeMatches[0].Groups['code'].Value",
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

  it("rejects a beta.1 baseline that diverges from the public release contract before Sandbox", async () => {
    const fixture = await createRepositoryFixture();
    const publicBaselineContract = join(
      fixture.root,
      "packaging",
      "electron",
      "public-installer-baselines.json",
    );
    await writeFile(
      publicBaselineContract,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          baselines: [
            {
              version: baselineVersion,
              releaseTag: "v0.2.0-beta.1",
              assetName: baselineInstallerName,
              bytes: 226_359_624,
              sha256: "e3ba23e37d62eee8697c7a3af94206357acf3bae0755a61e8b92702aa60a8cd4",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const releaseInstaller = await stageLifecycleInstallers(fixture);

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
    expect(`${result.stdout}\n${result.stderr}`).toContain("BETA1_PUBLIC_BASELINE_REQUIRED");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("WINDOWS_SANDBOX_REQUIRED");
  });

  it("fails closed when Windows Sandbox is unavailable and never falls back to this profile", async () => {
    const fixture = await createRepositoryFixture();
    const releaseInstaller = await stageLifecycleInstallers(fixture);
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
    expect((await readdir(join(fixture.root, "release"))).sort()).toEqual(
      [baselineInstallerName, installerName].sort(),
    );
  });
});
