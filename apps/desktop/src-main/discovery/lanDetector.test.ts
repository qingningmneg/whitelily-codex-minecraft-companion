// @vitest-environment node

import { execFile as nodeExecFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  FIXED_JAVA_LISTENER_PROBE_SCRIPT,
  runFixedJavaListenerProbe,
  type ExecFilePort,
  type JavaListenerProbeRecord,
} from "./fixedWindowsProbe.js";
import { LanCandidateStore } from "./lanCandidateStore.js";
import { LanDetector, type ConfirmedConnectionProof } from "./lanDetector.js";

const fixturePath = fileURLToPath(
  new URL("../../../../tests/fixtures/discovery/java-listeners.json", import.meta.url),
);

async function loadFixture(): Promise<readonly JavaListenerProbeRecord[]> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as readonly JavaListenerProbeRecord[];
}

const trustedPowerShell = String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const execFile = promisify(nodeExecFile);

interface FixedProbeProcessFixture {
  readonly commandLine: string;
  readonly pid: number;
  readonly port: number;
}

function powershellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function runRealFixedJavaListenerProbeScript(
  root: string,
  processes: readonly FixedProbeProcessFixture[],
): Promise<readonly JavaListenerProbeRecord[]> {
  const processRecords = processes
    .map(
      ({ commandLine, pid }) => String.raw`[pscustomobject]@{
  ProcessId = ${pid}
  Name = 'javaw.exe'
  CreationDate = [datetimeoffset]::FromUnixTimeMilliseconds(${1785196800000 + pid})
  CommandLine = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellSingleQuoted(Buffer.from(commandLine, "utf8").toString("base64"))}))
}`,
    )
    .join(",\n");
  const listenerRecords = processes
    .map(
      ({ pid, port }) => String.raw`[pscustomobject]@{
  LocalAddress = '127.0.0.1'
  LocalPort = ${port}
  OwningProcess = ${pid}
}`,
    )
    .join(",\n");
  const wrapper = String.raw`function Get-CimInstance {
  param([string] $ClassName, [string] $Filter)
  @(
${processRecords}
  )
}
function Get-NetTCPConnection {
  param([string] $State)
  @(
${listenerRecords}
  )
}
${FIXED_JAVA_LISTENER_PROBE_SCRIPT}
`;
  const scriptPath = join(root, "run-fixed-java-listener-probe.ps1");
  await writeFile(scriptPath, wrapper, "utf8");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("SYSTEM_ROOT_UNAVAILABLE");
  const powershellPath = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const { stdout } = await execFile(
    powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { encoding: "utf8", maxBuffer: 1_048_576, timeout: 15_000, windowsHide: true },
  );
  return JSON.parse(stdout.trim() || "[]") as readonly JavaListenerProbeRecord[];
}

async function writeVersionFixture(
  root: string,
  instanceId: string,
  metadata: Readonly<Record<string, unknown>>,
): Promise<string> {
  const directory = join(root, "versions", instanceId);
  await mkdir(directory, { recursive: true });
  const jarPath = join(directory, `${instanceId}.jar`);
  await writeFile(jarPath, "fixture", "utf8");
  await writeFile(join(directory, `${instanceId}.json`), JSON.stringify(metadata), "utf8");
  return jarPath;
}

async function inspectVersionEvidenceHandleContract(
  root: string,
  jarPath: string,
  metadataPath: string,
): Promise<Readonly<Record<string, boolean>>> {
  const encodedJarPath = Buffer.from(jarPath, "utf8").toString("base64");
  const encodedMetadataPath = Buffer.from(metadataPath, "utf8").toString("base64");
  const wrapper = String.raw`function Get-CimInstance { @() }
function Get-NetTCPConnection { @() }
${FIXED_JAVA_LISTENER_PROBE_SCRIPT}
$jarPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedJarPath}'))
$metadataPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedMetadataPath}'))
$evidenceType = 'WhiteLilyVersionEvidence' -as [type]
$contract = [ordered]@{
  available = $null -ne $evidenceType
  deleteDeniedWhileEvidenceOpen = $false
  metadataReadFromEvidence = $false
  jarDeletableAfterDispose = $false
}
if ($null -ne $evidenceType) {
  $evidence = $evidenceType.GetMethod('Open').Invoke($null, @($jarPath, $metadataPath, [long]1048576))
  if ($null -ne $evidence) {
    try {
      try {
        [IO.File]::Delete($jarPath)
      } catch {
        $contract.deleteDeniedWhileEvidenceOpen = $true
      }
      $metadataJson = $evidenceType.GetMethod('ReadMetadataUtf8').Invoke($evidence, @())
      $metadata = $metadataJson | ConvertFrom-Json -ErrorAction Stop
      $contract.metadataReadFromEvidence = $metadata.id -ceq 'handle-contract'
    } finally {
      $evidence.Dispose()
    }
    try {
      [IO.File]::Delete($jarPath)
      $contract.jarDeletableAfterDispose = -not (Test-Path -LiteralPath $jarPath)
    } catch {
      $contract.jarDeletableAfterDispose = $false
    }
  }
}
[pscustomobject]$contract | ConvertTo-Json -Compress
`;
  const scriptPath = join(root, "inspect-version-evidence-handle.ps1");
  await writeFile(scriptPath, wrapper, "utf8");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("SYSTEM_ROOT_UNAVAILABLE");
  const powershellPath = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const { stdout } = await execFile(
    powershellPath,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { encoding: "utf8", maxBuffer: 1_048_576, timeout: 15_000, windowsHide: true },
  );
  const lines = stdout.trim().split(/\r?\n/u);
  return JSON.parse(lines.at(-1) ?? "{}") as Readonly<Record<string, boolean>>;
}

function minecraftCommandLine(instanceId: string, versionJarPath: string): string {
  return `"C:\\Program Files\\Java\\javaw.exe" -cp "C:\\libraries\\safe.jar;${versionJarPath}" net.minecraft.client.main.Main --version ${instanceId} --gameDir "C:\\Game Dir"`;
}

describe("fixed Java listener probe", () => {
  it("holds the version JAR handle until stable metadata reading completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-version-evidence-handle-"));
    try {
      const instanceId = "handle-contract";
      const jarPath = await writeVersionFixture(root, instanceId, {
        id: instanceId,
        clientVersion: "1.21.5",
      });
      const metadataPath = join(root, "versions", instanceId, `${instanceId}.json`);

      await expect(
        inspectVersionEvidenceHandleContract(root, jarPath, metadataPath),
      ).resolves.toEqual({
        available: true,
        deleteDeniedWhileEvidenceOpen: true,
        metadataReadFromEvidence: true,
        jarDeletableAfterDispose: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies a quoted custom PCL2 instance from its exact bounded version metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-version-probe-"));
    try {
      const instanceId = "白百合-生存-1";
      const versionJarPath = await writeVersionFixture(root, instanceId, {
        id: instanceId,
        clientVersion: "1.21.5",
        type: "release",
      });

      const records = await runRealFixedJavaListenerProbeScript(root, [
        {
          commandLine: minecraftCommandLine(instanceId, versionJarPath),
          pid: 4201,
          port: 51321,
        },
      ]);

      expect(records).toEqual([
        {
          localAddress: "127.0.0.1",
          localPort: 51321,
          pid: 4201,
          processName: "javaw.exe",
          processStartedAt: 1785196804201,
          version: "1.21.5",
        },
      ]);
      expect(JSON.stringify(records)).not.toMatch(/白百合-生存|Program Files|Game Dir/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for absent, conflicting, ambiguous, linked, oversized, and substring evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-version-probe-negative-"));
    try {
      const wrongVersionId = "wrong-version";
      const wrongVersionJar = await writeVersionFixture(root, wrongVersionId, {
        id: wrongVersionId,
        clientVersion: "1.21.4",
      });
      const mismatchedId = "mismatched-id";
      const mismatchedJar = await writeVersionFixture(root, mismatchedId, {
        id: "another-instance",
        clientVersion: "1.21.5",
      });
      const missingId = "missing-metadata";
      const missingDirectory = join(root, "versions", missingId);
      await mkdir(missingDirectory, { recursive: true });
      const missingJar = join(missingDirectory, `${missingId}.jar`);
      await writeFile(missingJar, "fixture", "utf8");
      const oversizedId = "oversized-metadata";
      const oversizedJar = await writeVersionFixture(root, oversizedId, {
        id: oversizedId,
        clientVersion: "1.21.5",
        padding: "x".repeat(1_048_576),
      });
      const duplicateId = "duplicate-argument";
      const duplicateJar = await writeVersionFixture(root, duplicateId, {
        id: duplicateId,
        clientVersion: "1.21.5",
      });
      const substringId = "substring-lookalike";
      const substringJar = await writeVersionFixture(root, substringId, {
        id: substringId,
        clientVersion: "1.21.50",
      });
      const duplicateMetadataId = "duplicate-metadata";
      const duplicateMetadataDirectory = join(root, "versions", duplicateMetadataId);
      await mkdir(duplicateMetadataDirectory, { recursive: true });
      const duplicateMetadataJar = join(duplicateMetadataDirectory, `${duplicateMetadataId}.jar`);
      await writeFile(duplicateMetadataJar, "fixture", "utf8");
      await writeFile(
        join(duplicateMetadataDirectory, `${duplicateMetadataId}.json`),
        `{"id":"wrong","id":"${duplicateMetadataId}","clientVersion":"1.21.4","clientVersion":"1.21.5"}`,
        "utf8",
      );
      const utf16MetadataId = "utf16-metadata";
      const utf16MetadataDirectory = join(root, "versions", utf16MetadataId);
      await mkdir(utf16MetadataDirectory, { recursive: true });
      const utf16MetadataJar = join(utf16MetadataDirectory, `${utf16MetadataId}.jar`);
      await writeFile(utf16MetadataJar, "fixture", "utf8");
      await writeFile(
        join(utf16MetadataDirectory, `${utf16MetadataId}.json`),
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(JSON.stringify({ id: utf16MetadataId, clientVersion: "1.21.5" }), "utf16le"),
        ]),
      );
      const linkedId = "linked-instance";
      const linkedTarget = join(root, "linked-target");
      await mkdir(linkedTarget, { recursive: true });
      await writeFile(join(linkedTarget, `${linkedId}.jar`), "fixture", "utf8");
      await writeFile(
        join(linkedTarget, `${linkedId}.json`),
        JSON.stringify({ id: linkedId, clientVersion: "1.21.5" }),
        "utf8",
      );
      const linkedDirectory = join(root, "versions", linkedId);
      await mkdir(join(root, "versions"), { recursive: true });
      await symlink(linkedTarget, linkedDirectory, "junction");
      const linkedJar = join(linkedDirectory, `${linkedId}.jar`);
      const conflictingId = "conflicting-instance";
      const conflictingJar = await writeVersionFixture(root, conflictingId, {
        id: conflictingId,
        clientVersion: "1.21.4",
      });
      const standardJar = await writeVersionFixture(root, "1.21.5", {
        id: "1.21.5",
        clientVersion: "1.21.5",
      });

      const fixtures: readonly FixedProbeProcessFixture[] = [
        {
          commandLine: minecraftCommandLine(wrongVersionId, wrongVersionJar),
          pid: 4301,
          port: 51401,
        },
        {
          commandLine: minecraftCommandLine(mismatchedId, mismatchedJar),
          pid: 4302,
          port: 51402,
        },
        {
          commandLine: minecraftCommandLine(missingId, missingJar),
          pid: 4303,
          port: 51403,
        },
        {
          commandLine: minecraftCommandLine(oversizedId, oversizedJar),
          pid: 4304,
          port: 51404,
        },
        {
          commandLine: `${minecraftCommandLine(duplicateId, duplicateJar)} --version other-instance`,
          pid: 4305,
          port: 51405,
        },
        {
          commandLine: minecraftCommandLine(substringId, substringJar),
          pid: 4306,
          port: 51406,
        },
        {
          commandLine: minecraftCommandLine(duplicateMetadataId, duplicateMetadataJar),
          pid: 4313,
          port: 51413,
        },
        {
          commandLine: minecraftCommandLine(utf16MetadataId, utf16MetadataJar),
          pid: 4314,
          port: 51414,
        },
        {
          commandLine: minecraftCommandLine(linkedId, linkedJar),
          pid: 4307,
          port: 51407,
        },
        {
          commandLine: `"C:\\Java\\javaw.exe" -cp "${standardJar};${conflictingJar}" net.minecraft.client.main.Main --version ${conflictingId}`,
          pid: 4308,
          port: 51408,
        },
        {
          commandLine: `"C:\\Java\\javaw.exe" -cp "${wrongVersionJar}" net.minecraft.client.main.Main --profile "--version ${wrongVersionId}" --versionSuffix 1.21.5`,
          pid: 4309,
          port: 51409,
        },
        {
          commandLine: `"C:\\Java\\javaw.exe" -cp "${wrongVersionJar}" net.minecraft.client.main.Main --version ..\\${wrongVersionId}`,
          pid: 4310,
          port: 51410,
        },
        {
          commandLine: `"C:\\Java\\javaw.exe" -cp "${wrongVersionJar}" net.minecraft.client.main.Main --profile "C:\\decoy\\versions\\1.21.5\\not-version.txt"`,
          pid: 4311,
          port: 51411,
        },
        {
          commandLine: `"C:\\Java\\javaw.exe" -cp "${standardJar}" net.minecraft.client.main.Main`,
          pid: 4312,
          port: 51412,
        },
      ];

      const records = await runRealFixedJavaListenerProbeScript(root, fixtures);

      expect(records).toHaveLength(fixtures.length);
      expect(records.map(({ localPort, version }) => ({ localPort, version }))).toEqual(
        fixtures.map(({ port }) => ({ localPort: port, version: null })),
      );
      expect(JSON.stringify(records)).not.toMatch(
        /wrong-version|mismatched-id|missing-metadata|oversized-metadata|linked-instance|conflicting-instance|Program Files|Game Dir/iu,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains exact legacy version-directory evidence when no version argument exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-version-probe-legacy-"));
    try {
      const jarPath = await writeVersionFixture(root, "1.21.5", {
        id: "1.21.5",
        type: "release",
      });
      const records = await runRealFixedJavaListenerProbeScript(root, [
        {
          commandLine: `"C:\\Java\\javaw.exe" -cp "${jarPath}" net.minecraft.client.main.Main --version 1.21.5`,
          pid: 4401,
          port: 51501,
        },
      ]);

      expect(records.map(({ localPort, version }) => ({ localPort, version }))).toEqual([
        { localPort: 51501, version: "1.21.5" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses the trusted fixed PowerShell boundary with bounded hidden UTF-8 execution", async () => {
    const execFile = vi.fn<ExecFilePort>((_file, _args, _options, callback) => {
      callback(null, "[]", "");
      return undefined;
    });

    await expect(
      runFixedJavaListenerProbe({
        execFile,
        resolvePowerShellPath: async () => trustedPowerShell,
      }),
    ).resolves.toEqual({ records: [], diagnostic: null });

    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      trustedPowerShell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        FIXED_JAVA_LISTENER_PROBE_SCRIPT,
      ],
      {
        encoding: "utf8",
        maxBuffer: 1_048_576,
        shell: false,
        timeout: 5_000,
        windowsHide: true,
      },
      expect.any(Function),
    );
    expect(runFixedJavaListenerProbe).toHaveLength(0);
    expect(FIXED_JAVA_LISTENER_PROBE_SCRIPT).toContain("Get-NetTCPConnection -State Listen");
    expect(FIXED_JAVA_LISTENER_PROBE_SCRIPT).toContain(
      String.raw`Get-CimInstance Win32_Process -Filter "Name = 'java.exe' OR Name = 'javaw.exe'"`,
    );
    expect(FIXED_JAVA_LISTENER_PROBE_SCRIPT).not.toContain(
      String.raw`Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue"`,
    );
    expect(FIXED_JAVA_LISTENER_PROBE_SCRIPT).not.toContain("$args");
    expect(FIXED_JAVA_LISTENER_PROBE_SCRIPT).toContain("return '1.21.5'");
    expect(FIXED_JAVA_LISTENER_PROBE_SCRIPT).not.toContain("$Matches[1]");
  });

  it("rejects malformed output and exposes no command line, executable path, username, or token", async () => {
    const unsafe = [
      {
        localAddress: "127.0.0.1",
        localPort: 51321,
        pid: 4200,
        processName: "javaw.exe",
        processStartedAt: 1785196800123,
        version: "1.21.5",
        commandLine: "--accessToken secret",
      },
    ];
    const execFile: ExecFilePort = (_file, _args, _options, callback) => {
      callback(null, JSON.stringify(unsafe), "");
      return undefined;
    };

    const result = await runFixedJavaListenerProbe({
      execFile,
      resolvePowerShellPath: async () => trustedPowerShell,
    });

    expect(result).toEqual({ records: [], diagnostic: { code: "INVALID_OUTPUT" } });
    expect(JSON.stringify(result)).not.toMatch(/accessToken|secret|Profiles|commandLine/iu);
  });

  it.each(["accessToken_secret", "Alice.Private", "1.21.50"])(
    "never publishes command-line-derived version lookalike %s",
    async (version) => {
      const execFile: ExecFilePort = (_file, _args, _options, callback) => {
        callback(
          null,
          JSON.stringify([
            {
              localAddress: "127.0.0.1",
              localPort: 51321,
              pid: 4200,
              processName: "javaw.exe",
              processStartedAt: 1785196800123,
              version,
            },
          ]),
          "",
        );
        return undefined;
      };

      const result = await runFixedJavaListenerProbe({
        execFile,
        resolvePowerShellPath: async () => trustedPowerShell,
      });

      expect(result).toEqual({ records: [], diagnostic: { code: "INVALID_OUTPUT" } });
      expect(JSON.stringify(result)).not.toContain(version);
    },
  );
});

describe("LAN candidate store", () => {
  it("deduplicates exact listener identities and expires candidates after 60 seconds", () => {
    let now = 1_000;
    let nextId = 0;
    const store = new LanCandidateStore({
      now: () => now,
      idFactory: () => `lan_candidate_${String(++nextId).padStart(4, "0")}`,
    });
    const observation = {
      port: 51321,
      pid: 4200,
      processStartedAt: 1785196800123,
      version: "1.21.5",
    } as const;

    const candidates = store.refresh([observation, observation]);
    expect(candidates).toEqual([
      {
        id: "lan_candidate_0001",
        port: 51321,
        version: "1.21.5",
        observedAt: 1_000,
        expiresAt: 61_000,
      },
    ]);
    expect(store.resolve(candidates[0]!.id)).toMatchObject(observation);

    now = 61_000;
    expect(store.resolve(candidates[0]!.id)).toBeUndefined();
  });

  it("rejects a candidate after wall-clock rollback before its observation", () => {
    let now = 1_000;
    const store = new LanCandidateStore({
      now: () => now,
      idFactory: () => "lan_candidate_rollback1",
    });
    const candidate = store.refresh([
      {
        port: 51321,
        pid: 4200,
        processStartedAt: 1785196800123,
        version: "unknown",
      },
    ])[0]!;

    now = 999;
    expect(store.resolve(candidate.id)).toBeUndefined();
  });

  it("invalidates old IDs on refresh and on PID, port, or process identity change", () => {
    let nextId = 0;
    const store = new LanCandidateStore({
      now: () => 1_000,
      idFactory: () => `lan_candidate_${String(++nextId).padStart(4, "0")}`,
    });
    const base = {
      port: 51321,
      pid: 4200,
      processStartedAt: 1785196800123,
      version: "unknown",
    } as const;

    const first = store.refresh([base])[0]!;
    const second = store.refresh([{ ...base, port: 51322 }])[0]!;
    expect(store.resolve(first.id)).toBeUndefined();
    expect(second.id).not.toBe(first.id);

    const third = store.refresh([{ ...base, pid: 4201 }])[0]!;
    expect(store.resolve(second.id)).toBeUndefined();
    expect(third.id).not.toBe(second.id);

    const fourth = store.refresh([{ ...base, processStartedAt: 1785196800124 }])[0]!;
    expect(store.resolve(third.id)).toBeUndefined();
    expect(fourth.id).not.toBe(third.id);
  });
});

describe("local Minecraft LAN detector", () => {
  it("accepts loopback-compatible listeners owned by a strict Java process", async () => {
    let nonceIndex = 0;
    const detector = new LanDetector({
      probe: async () => ({ records: await loadFixture(), diagnostic: null }),
      now: () => 1_000,
      idFactory: (() => {
        let index = 0;
        return () => `lan_candidate_${String(++index).padStart(4, "0")}`;
      })(),
    });

    const candidates = await detector.detectLanCandidates();

    expect(candidates).toEqual([
      {
        id: "lan_candidate_0001",
        port: 51321,
        version: "1.21.5",
        observedAt: 1_000,
        expiresAt: 61_000,
      },
      {
        id: "lan_candidate_0002",
        port: 51322,
        version: "unknown",
        observedAt: 1_000,
        expiresAt: 61_000,
      },
      {
        id: "lan_candidate_0003",
        port: 51323,
        version: "1.21.5",
        observedAt: 1_000,
        expiresAt: 61_000,
      },
    ]);
    expect(JSON.stringify(candidates)).not.toMatch(
      /4200|javaw|process|pid|path|Profiles|accessToken/iu,
    );
  });

  it.each(["0.0.0.0", "::"])(
    "accepts Minecraft's wildcard %s LAN bind but publishes only its local port",
    async (localAddress) => {
      const detector = new LanDetector({
        probe: async () => ({
          records: [
            {
              localAddress,
              localPort: 53662,
              pid: 27604,
              processName: "java.exe",
              processStartedAt: 1785196800123,
              version: "1.21.5",
            },
          ],
          diagnostic: null,
        }),
        now: () => 1_000,
        idFactory: () => "lan_candidate_wildcard",
      });

      await expect(detector.detectLanCandidates()).resolves.toEqual([
        {
          id: "lan_candidate_wildcard",
          port: 53662,
          version: "1.21.5",
          observedAt: 1_000,
          expiresAt: 61_000,
        },
      ]);
    },
  );

  it.each([
    { localAddress: "192.168.1.25", localPort: 51321 },
    { localAddress: "10.0.0.2", localPort: 51321 },
    { localAddress: "::ffff:127.0.0.1", localPort: 51321 },
    { localAddress: "127.0.0.1", localPort: 0 },
    { localAddress: "127.0.0.1", localPort: 65_536 },
  ])("rejects unsafe listener $localAddress:$localPort", async (listener) => {
    const detector = new LanDetector({
      probe: async () => ({
        records: [
          {
            ...listener,
            pid: 4200,
            processName: "java.exe",
            processStartedAt: 1785196800123,
            version: "1.21.5",
          },
        ],
        diagnostic: null,
      }),
    });

    await expect(detector.detectLanCandidates()).resolves.toEqual([]);
  });

  it("re-probes immediately, consumes the candidate once, and rejects stale or reused identity", async () => {
    let now = 1_000;
    let records: readonly JavaListenerProbeRecord[] = [
      {
        localAddress: "127.0.0.1",
        localPort: 51321,
        pid: 4200,
        processName: "javaw.exe",
        processStartedAt: 1785196800123,
        version: null,
      },
    ];
    const detector = new LanDetector({
      probe: async () => ({ records, diagnostic: null }),
      now: () => now,
      idFactory: (() => {
        let index = 0;
        return () => `lan_candidate_${String(++index).padStart(4, "0")}`;
      })(),
      nonceFactory: () => "proof_nonce_12345678",
    });

    const candidate = (await detector.detectLanCandidates())[0]!;
    const proofs: unknown[] = [];
    await expect(
      detector.confirmLanCandidate(candidate.id, async (proof) => {
        proofs.push(proof);
        return { status: "configured", port: 51321, confirmedAt: 1_000 };
      }),
    ).resolves.toEqual({
      status: "confirmed",
      port: 51321,
      version: "unknown",
      confirmedAt: 1_000,
    });
    expect(proofs).toEqual([
      {
        nonce: "proof_nonce_12345678",
        port: 51321,
        issuedAt: 1_000,
        expiresAt: 11_000,
      },
    ]);
    await expect(
      detector.confirmLanCandidate(candidate.id, async () => {
        throw new Error("must not run");
      }),
    ).rejects.toThrow("LAN_CANDIDATE_EXPIRED");

    const reused = (await detector.detectLanCandidates())[0]!;
    records = [{ ...records[0]!, processStartedAt: 1785196800999 }];
    await expect(
      detector.confirmLanCandidate(reused.id, async () => ({
        status: "configured",
        port: 51321,
        confirmedAt: now,
      })),
    ).rejects.toThrow("LAN_CANDIDATE_CHANGED");

    const expired = (await detector.detectLanCandidates())[0]!;
    now = expired.expiresAt;
    await expect(
      detector.confirmLanCandidate(expired.id, async () => ({
        status: "configured",
        port: 51321,
        confirmedAt: now,
      })),
    ).rejects.toThrow("LAN_CANDIDATE_EXPIRED");
  });

  it("serializes refresh and confirmation so a refresh cannot revive an old authority", async () => {
    let releaseProbe!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let calls = 0;
    const record: JavaListenerProbeRecord = {
      localAddress: "127.0.0.1",
      localPort: 51321,
      pid: 4200,
      processName: "java.exe",
      processStartedAt: 1785196800123,
      version: null,
    };
    const detector = new LanDetector({
      probe: async () => {
        calls += 1;
        if (calls === 2) await gate;
        return { records: [record], diagnostic: null };
      },
      now: () => 1_000,
      idFactory: (() => {
        let index = 0;
        return () => `lan_candidate_${String(++index).padStart(4, "0")}`;
      })(),
      nonceFactory: () => "proof_nonce_12345678",
    });
    const candidate = (await detector.detectLanCandidates())[0]!;
    const confirm = detector.confirmLanCandidate(candidate.id, async () => ({
      status: "configured",
      port: 51321,
      confirmedAt: 1_000,
    }));
    const refresh = detector.detectLanCandidates();
    releaseProbe();

    await expect(confirm).resolves.toMatchObject({ status: "confirmed", port: 51321 });
    const refreshed = await refresh;
    expect(refreshed[0]!.id).not.toBe(candidate.id);
  });

  it("rejects a child confirmation timestamp at the exact proof expiry boundary", async () => {
    const record: JavaListenerProbeRecord = {
      localAddress: "127.0.0.1",
      localPort: 51321,
      pid: 4200,
      processName: "java.exe",
      processStartedAt: 1785196800123,
      version: "1.21.5",
    };
    const detector = new LanDetector({
      probe: async () => ({ records: [record], diagnostic: null }),
      now: () => 1_000,
      idFactory: () => "lan_candidate_exact_expiry",
      nonceFactory: () => "proof_nonce_exact_expiry",
    });
    const candidate = (await detector.detectLanCandidates())[0]!;

    await expect(
      detector.confirmLanCandidate(candidate.id, async (proof) => ({
        status: "configured",
        port: proof.port,
        confirmedAt: proof.expiresAt,
      })),
    ).rejects.toThrow("LAN_CONFIRMATION_FAILED");
  });

  it("retains only a current main-process proof and revokes it after LAN identity changes", async () => {
    let records: readonly JavaListenerProbeRecord[] = [
      {
        localAddress: "127.0.0.1",
        localPort: 51321,
        pid: 4200,
        processName: "java.exe",
        processStartedAt: 1785196800123,
        version: "1.21.5",
      },
    ];
    const detector = new LanDetector({
      probe: async () => ({ records, diagnostic: null }),
      now: () => 1_000,
      idFactory: () => "lan_candidate_retained",
      nonceFactory: () => "proof_nonce_retained1",
    });
    const candidate = (await detector.detectLanCandidates())[0]!;
    let retainedProof:
      { nonce: string; port: number; issuedAt: number; expiresAt: number } | undefined;
    await detector.confirmLanCandidate(candidate.id, async (proof) => {
      retainedProof = proof;
      return { status: "configured", port: proof.port, confirmedAt: proof.issuedAt };
    });

    expect(detector.isCurrentConfirmedProof(retainedProof!)).toBe(true);
    records = [{ ...records[0]!, processStartedAt: 1785196800124 }];
    await expect(detector.validateConfirmedSession()).resolves.toBe(false);
    expect(detector.isCurrentConfirmedProof(retainedProof!)).toBe(false);
  });

  it("re-probes and redeems a retained proof exactly once", async () => {
    let nonceIndex = 0;
    let records: readonly JavaListenerProbeRecord[] = [
      {
        localAddress: "127.0.0.1",
        localPort: 51321,
        pid: 4200,
        processName: "java.exe",
        processStartedAt: 1785196800123,
        version: "1.21.5",
      },
    ];
    const detector = new LanDetector({
      probe: async () => ({ records, diagnostic: null }),
      now: () => 1_000,
      idFactory: () => "lan_candidate_redeem01",
      nonceFactory: () => `proof_nonce_redeem${String(++nonceIndex).padStart(2, "0")}`,
    });
    const candidate = (await detector.detectLanCandidates())[0]!;
    let proof: ConfirmedConnectionProof | undefined;
    await detector.confirmLanCandidate(candidate.id, async (candidateProof) => {
      proof = candidateProof;
      return {
        status: "configured",
        port: candidateProof.port,
        confirmedAt: candidateProof.issuedAt,
      };
    });

    await expect(detector.redeemConfirmedProof(proof!)).resolves.toMatchObject({
      port: 51321,
      pid: 4200,
      processStartedAt: 1785196800123,
      version: "1.21.5",
    });
    await expect(detector.redeemConfirmedProof(proof!)).rejects.toThrow("LAN_CONFIRMATION_FAILED");

    const fresh = (await detector.detectLanCandidates())[0]!;
    let secondProof: ConfirmedConnectionProof | undefined;
    await detector.confirmLanCandidate(fresh.id, async (candidateProof) => {
      secondProof = candidateProof;
      return {
        status: "configured",
        port: candidateProof.port,
        confirmedAt: candidateProof.issuedAt,
      };
    });
    records = [{ ...records[0]!, processStartedAt: 1785196800124 }];
    await expect(detector.redeemConfirmedProof(secondProof!)).rejects.toThrow(
      "LAN_CONFIRMATION_FAILED",
    );
  });

  it("inspects an immutable candidate repeatedly without consuming confirmation authority", async () => {
    let nonceIndex = 0;
    const record: JavaListenerProbeRecord = {
      localAddress: "127.0.0.1",
      localPort: 51321,
      pid: 4200,
      processName: "javaw.exe",
      processStartedAt: 1785196800123,
      version: "1.21.5",
    };
    const detector = new LanDetector({
      probe: async () => ({ records: [record], diagnostic: null }),
      now: () => 1_000,
      idFactory: () => "lan_candidate_inspect01",
      nonceFactory: () => `proof_nonce_inspect${String(++nonceIndex).padStart(2, "0")}`,
    });
    const candidate = (await detector.detectLanCandidates())[0]!;

    const first = await detector.inspectCandidate(candidate.id);
    const second = await detector.inspectCandidate(candidate.id);

    expect(first).toEqual({
      port: 51321,
      pid: 4200,
      processStartedAt: 1785196800123,
      version: "1.21.5",
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toEqual(first);
    await expect(
      detector.confirmLanCandidate(candidate.id, async (candidateProof) => ({
        status: "configured",
        port: candidateProof.port,
        confirmedAt: candidateProof.issuedAt,
      })),
    ).resolves.toMatchObject({ status: "confirmed", port: 51321 });
  });

  it("fails candidate inspection on expiry or any PID, start, listener, Java, or version drift", async () => {
    let now = 1_000;
    let record: JavaListenerProbeRecord = {
      localAddress: "127.0.0.1",
      localPort: 51321,
      pid: 4200,
      processName: "javaw.exe",
      processStartedAt: 1785196800123,
      version: "1.21.5",
    };
    let nextId = 0;
    const detector = new LanDetector({
      probe: async () => ({ records: [record], diagnostic: null }),
      now: () => now,
      idFactory: () => `lan_candidate_drift_${String(++nextId).padStart(2, "0")}`,
    });

    for (const replacement of [
      { ...record, pid: record.pid + 1 },
      { ...record, processStartedAt: record.processStartedAt + 1 },
      { ...record, localPort: record.localPort + 1 },
      { ...record, localAddress: "192.168.1.10" },
      { ...record, processName: "node.exe" } as unknown as JavaListenerProbeRecord,
      { ...record, version: null },
    ] satisfies readonly JavaListenerProbeRecord[]) {
      record = {
        localAddress: "127.0.0.1",
        localPort: 51321,
        pid: 4200,
        processName: "javaw.exe",
        processStartedAt: 1785196800123,
        version: "1.21.5",
      };
      const candidate = (await detector.detectLanCandidates())[0]!;
      record = replacement;
      await expect(detector.inspectCandidate(candidate.id)).rejects.toThrow(
        "LAN_CANDIDATE_CHANGED",
      );
    }

    record = {
      localAddress: "127.0.0.1",
      localPort: 51321,
      pid: 4200,
      processName: "javaw.exe",
      processStartedAt: 1785196800123,
      version: "1.21.5",
    };
    const expired = (await detector.detectLanCandidates())[0]!;
    now = expired.expiresAt;
    await expect(detector.inspectCandidate(expired.id)).rejects.toThrow("LAN_CANDIDATE_EXPIRED");
  });

  it("rejects renderer-shaped paths without probing or exposing stored process metadata", async () => {
    let probes = 0;
    const detector = new LanDetector({
      probe: async () => {
        probes += 1;
        return { records: [], diagnostic: null };
      },
    });

    await expect(detector.inspectCandidate("C:\\Minecraft\\mods")).rejects.toThrow(
      "LAN_CANDIDATE_EXPIRED",
    );
    expect(probes).toBe(0);
  });

  it("invalidates an in-flight probe when discovery stops", async () => {
    let releaseProbe!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const detector = new LanDetector({
      probe: async () => {
        await gate;
        return {
          records: [
            {
              localAddress: "127.0.0.1",
              localPort: 51321,
              pid: 4200,
              processName: "java.exe",
              processStartedAt: 1785196800123,
              version: null,
            },
          ],
          diagnostic: null,
        };
      },
    });

    const detection = detector.detectLanCandidates();
    detector.stop();
    releaseProbe();

    await expect(detection).rejects.toThrow("LAN_DETECTOR_STOPPED");
    await expect(detector.detectLanCandidates()).rejects.toThrow("LAN_DETECTOR_STOPPED");
  });
});
