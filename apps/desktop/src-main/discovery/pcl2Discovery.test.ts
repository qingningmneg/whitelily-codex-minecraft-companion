// @vitest-environment node

import { execFile as actualExecFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  FIXED_PCL2_PROBE_SCRIPT,
  FIXED_UTF8_POWERSHELL_PREAMBLE,
  runFixedPcl2Probe,
  resolveTrustedWindowsPowerShell,
  TRUSTED_WINDOWS_POWERSHELL_ANCHOR,
  TRUSTED_WINDOWS_SYSTEM_ROOT_ANCHOR,
  type ExecFilePort,
  type TrustedWindowsStat,
} from "./fixedWindowsProbe.js";
import { Pcl2Discovery, type Pcl2ProbeRecord } from "./pcl2Discovery.js";

const fixturePath = fileURLToPath(
  new URL("../../../../tests/fixtures/discovery/pcl2-processes.json", import.meta.url),
);

async function loadFixture(): Promise<readonly Pcl2ProbeRecord[]> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as readonly Pcl2ProbeRecord[];
}

const syntheticSystemRoot = String.raw`D:\Windows`;
const syntheticPowerShellPath = String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

function trustedStat(dev: bigint, ino: bigint, kind: "directory" | "file"): TrustedWindowsStat {
  return {
    dev,
    ino,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
  };
}

function nonCWindowsIdentityStat(path: string): Promise<TrustedWindowsStat> {
  if (path === TRUSTED_WINDOWS_SYSTEM_ROOT_ANCHOR || path === syntheticSystemRoot) {
    return Promise.resolve(trustedStat(11n, 101n, "directory"));
  }
  if (path === TRUSTED_WINDOWS_POWERSHELL_ANCHOR || path === syntheticPowerShellPath) {
    return Promise.resolve(trustedStat(11n, 202n, "file"));
  }
  return Promise.reject(new Error("unexpected path"));
}

describe("fixed Windows PCL2 probe", () => {
  it("runs one fixed hidden PowerShell program with bounded output and no caller path", async () => {
    const execFile = vi.fn<ExecFilePort>((file, args, options, callback) => {
      callback(null, "[]", "");
      return undefined;
    });

    await expect(
      runFixedPcl2Probe({
        execFile,
        resolvePowerShellPath: async () => syntheticPowerShellPath,
      }),
    ).resolves.toEqual({
      records: [],
      diagnostic: null,
    });

    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      syntheticPowerShellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        FIXED_PCL2_PROBE_SCRIPT,
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
    expect(runFixedPcl2Probe).toHaveLength(0);
  });

  it("ignores real CWD and PATH impostors while executing the identity-anchored image", async () => {
    const execFile = vi.fn<ExecFilePort>((_file, _args, _options, callback) => {
      callback(null, "[]", "");
      return undefined;
    });
    const trustedPowerShellPath = await resolveTrustedWindowsPowerShell();
    expect(trustedPowerShellPath).toMatch(
      /^[A-Za-z]:\\.+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu,
    );
    const originalCwd = process.cwd();
    const originalPath = process.env.Path;
    const impostorRoot = await mkdtemp(join(tmpdir(), "whitelily-pcl2-impostor-"));
    await writeFile(join(impostorRoot, "powershell.exe"), "not a system executable", "utf8");
    try {
      process.chdir(impostorRoot);
      process.env.Path = impostorRoot;

      await runFixedPcl2Probe({ execFile });

      expect(execFile.mock.calls[0]?.[0]).toBe(trustedPowerShellPath);
      expect(execFile.mock.calls[0]?.[0]).not.toContain(impostorRoot);
    } finally {
      process.chdir(originalCwd);
      if (originalPath === undefined) delete process.env.Path;
      else process.env.Path = originalPath;
      await rm(impostorRoot, { force: true, recursive: true });
    }
  });

  it("fails closed when a poisoned SystemRoot points at a real fake tree", async () => {
    const execFile = vi.fn<ExecFilePort>();
    const originalSystemRoot = process.env.SystemRoot;
    const impostorRoot = await mkdtemp(join(tmpdir(), "whitelily-systemroot-impostor-"));
    try {
      process.env.SystemRoot = impostorRoot;
      await expect(runFixedPcl2Probe({ execFile })).resolves.toEqual({
        records: [],
        diagnostic: { code: "PROBE_FAILED" },
      });
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = originalSystemRoot;
      await rm(impostorRoot, { force: true, recursive: true });
    }
  });

  it("fails closed before exec when trusted system PowerShell cannot be validated", async () => {
    const execFile = vi.fn<ExecFilePort>();

    for (const resolvedPath of [
      null,
      String.raw`C:\Profiles\Impostor\powershell.exe`,
      String.raw`\\server\share\powershell.exe`,
      String.raw`\\?\C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    ]) {
      await expect(
        runFixedPcl2Probe({
          execFile,
          resolvePowerShellPath: async () => resolvedPath,
        }),
      ).resolves.toEqual({
        records: [],
        diagnostic: { code: "PROBE_FAILED" },
      });
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  it("accepts a valid non-C Windows root only when GLOBALROOT identities match", async () => {
    const canonicalize = vi.fn(async (path: string) => path);

    await expect(
      resolveTrustedWindowsPowerShell({
        getSystemRoot: () => syntheticSystemRoot,
        canonicalize,
        statPath: nonCWindowsIdentityStat,
      }),
    ).resolves.toBe(syntheticPowerShellPath);
    expect(canonicalize).toHaveBeenCalledWith(syntheticSystemRoot);
    expect(canonicalize).toHaveBeenCalledWith(syntheticPowerShellPath);
  });

  it("fails closed for missing or poisoned SystemRoot identity", async () => {
    await expect(
      resolveTrustedWindowsPowerShell({
        getSystemRoot: () => undefined,
        canonicalize: async (path) => path,
        statPath: nonCWindowsIdentityStat,
      }),
    ).resolves.toBeNull();

    await expect(
      resolveTrustedWindowsPowerShell({
        getSystemRoot: () => String.raw`E:\FakeWindows`,
        canonicalize: async (path) => path,
        statPath: async (path) =>
          path === TRUSTED_WINDOWS_SYSTEM_ROOT_ANCHOR
            ? trustedStat(11n, 101n, "directory")
            : trustedStat(99n, 909n, path.endsWith(".exe") ? "file" : "directory"),
      }),
    ).resolves.toBeNull();
  });

  it.each([
    { name: "root anchor mismatch", root: [11n, 101n], exe: [11n, 202n], mutate: "root" },
    { name: "file anchor mismatch", root: [11n, 101n], exe: [11n, 202n], mutate: "exe" },
    { name: "zero root identity", root: [0n, 0n], exe: [11n, 202n], mutate: "none" },
    { name: "zero file identity", root: [11n, 101n], exe: [0n, 0n], mutate: "none" },
  ] as const)(
    "fails closed for $name",
    async ({ root: [rootDev, rootIno], exe: [exeDev, exeIno], mutate }) => {
      await expect(
        resolveTrustedWindowsPowerShell({
          getSystemRoot: () => syntheticSystemRoot,
          canonicalize: async (path) => path,
          statPath: async (path) => {
            if (path === TRUSTED_WINDOWS_SYSTEM_ROOT_ANCHOR) {
              return trustedStat(rootDev, rootIno, "directory");
            }
            if (path === syntheticSystemRoot) {
              return trustedStat(
                mutate === "root" ? 77n : rootDev,
                mutate === "root" ? 707n : rootIno,
                "directory",
              );
            }
            if (path === TRUSTED_WINDOWS_POWERSHELL_ANCHOR) {
              return trustedStat(exeDev, exeIno, "file");
            }
            return trustedStat(
              mutate === "exe" ? 88n : exeDev,
              mutate === "exe" ? 808n : exeIno,
              "file",
            );
          },
        }),
      ).resolves.toBeNull();
    },
  );

  it("rejects canonical reparse escape even when identity hooks claim a match", async () => {
    await expect(
      resolveTrustedWindowsPowerShell({
        getSystemRoot: () => syntheticSystemRoot,
        canonicalize: async (path) =>
          path === syntheticSystemRoot ? String.raw`E:\EscapedWindows` : path,
        statPath: nonCWindowsIdentityStat,
      }),
    ).resolves.toBeNull();
  });

  it.skipIf(process.platform !== "win32")(
    "emits BOM-free UTF-8 for a real non-ASCII Windows path",
    async () => {
      const powershellPath = await resolveTrustedWindowsPowerShell();
      expect(powershellPath).toMatch(
        /^[A-Za-z]:\\.+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu,
      );
      expect(FIXED_PCL2_PROBE_SCRIPT.startsWith(FIXED_UTF8_POWERSHELL_PREAMBLE)).toBe(true);
      const expectedPath = String.raw`C:\Profiles\测试用户\中文路径\Plain Craft Launcher 2.exe`;
      const stdout = await new Promise<Buffer>((resolve, reject) => {
        actualExecFile(
          powershellPath!,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `${FIXED_UTF8_POWERSHELL_PREAMBLE}\n[Console]::Out.Write('${expectedPath}')`,
          ],
          { encoding: "buffer", windowsHide: true },
          (error, value) => {
            if (error) reject(error);
            else resolve(value);
          },
        );
      });

      expect(stdout.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
      expect(decoded).toBe(expectedPath);
      expect(decoded).not.toContain("\uFFFD");
    },
  );

  it("returns a typed empty access-denied diagnostic without leaking stderr", async () => {
    const execFile: ExecFilePort = (_file, _args, _options, callback) => {
      const error = Object.assign(new Error("拒绝访问 C:\\Profiles\\Private"), {
        code: "EACCES",
      });
      callback(error, "", "拒绝访问 C:\\Profiles\\Private");
      return undefined;
    };

    const result = await runFixedPcl2Probe({
      execFile,
      resolvePowerShellPath: async () => syntheticPowerShellPath,
    });

    expect(result).toEqual({
      records: [],
      diagnostic: { code: "ACCESS_DENIED" },
    });
    expect(JSON.stringify(result)).not.toContain("Private");

    const localizedExecFile: ExecFilePort = (_file, _args, _options, callback) => {
      callback(Object.assign(new Error("PowerShell failed"), { code: 1 }), "", "拒绝访问");
      return undefined;
    };
    await expect(
      runFixedPcl2Probe({
        execFile: localizedExecFile,
        resolvePowerShellPath: async () => syntheticPowerShellPath,
      }),
    ).resolves.toEqual({
      records: [],
      diagnostic: { code: "ACCESS_DENIED" },
    });
  });

  it("distinguishes timeout, output overflow, and ordinary probe failures", async () => {
    const cases = [
      {
        error: Object.assign(new Error("probe stopped"), { killed: true }),
        code: "TIMED_OUT",
      },
      {
        error: Object.assign(new Error("stdout maxBuffer length exceeded"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          killed: true,
        }),
        code: "OUTPUT_LIMIT",
      },
      {
        error: Object.assign(new Error("PowerShell exited 1"), {
          code: 1,
          killed: false,
        }),
        code: "PROBE_FAILED",
      },
    ] as const;

    for (const item of cases) {
      const execFile: ExecFilePort = (_file, _args, _options, callback) => {
        callback(item.error, "", "");
        return undefined;
      };
      await expect(
        runFixedPcl2Probe({
          execFile,
          resolvePowerShellPath: async () => syntheticPowerShellPath,
        }),
      ).resolves.toEqual({
        records: [],
        diagnostic: { code: item.code },
      });
    }
  });

  it("rejects malformed, excessive, and oversized probe output with stable diagnostics", async () => {
    const cases = [
      "{not json",
      JSON.stringify(
        Array.from({ length: 257 }, () => ({
          path: String.raw`C:\PCL2\Plain Craft Launcher 2.exe`,
          source: "known_location",
          running: false,
        })),
      ),
      "x".repeat(1_048_577),
    ];

    for (const stdout of cases) {
      const execFile: ExecFilePort = (_file, _args, _options, callback) => {
        callback(null, stdout, "");
        return undefined;
      };
      const result = await runFixedPcl2Probe({
        execFile,
        resolvePowerShellPath: async () => syntheticPowerShellPath,
      });
      expect(result.records).toEqual([]);
      expect(result.diagnostic).toEqual({
        code: stdout.length > 1_048_576 ? "OUTPUT_LIMIT" : "INVALID_OUTPUT",
      });
    }
  });
});

describe("read-only PCL2 discovery", () => {
  it("discovers known, Start Menu, and running PCL2 paths with case-insensitive deduplication", async () => {
    const records = await loadFixture();
    const canonicalPaths = new Map(
      records.map((record) => [record.path.toLowerCase(), record.path]),
    );
    const discovery = new Pcl2Discovery({
      probe: async () => ({ records, diagnostic: null }),
      canonicalize: async (path) => canonicalPaths.get(path.toLowerCase()) ?? path,
      statPath: async () => ({ isFile: () => true }),
      idFactory: (() => {
        let index = 0;
        return () => `pcl2_candidate_${String(++index).padStart(4, "0")}`;
      })(),
    });

    const candidates = await discovery.discoverPcl2();

    expect(candidates).toEqual([
      {
        id: "pcl2_candidate_0001",
        displayPath: "Plain Craft Launcher 2.exe",
        source: "running_process",
        running: true,
      },
      {
        id: "pcl2_candidate_0002",
        displayPath: "Plain Craft Launcher 2.exe",
        source: "start_menu",
        running: false,
      },
    ]);
    expect(candidates).toHaveLength(2);
    expect(discovery.resolveCanonicalPath("pcl2_candidate_0001")?.toLowerCase()).toBe(
      String.raw`c:\profiles\sample\apps\pcl2\plain craft launcher 2.exe`,
    );
  });

  it("rejects lookalike executables and exposes neither username nor canonical path", async () => {
    const secretPath = String.raw`C:\Profiles\Alice.Secret\Downloads\Plain Craft Launcher 2.exe`;
    const records: readonly Pcl2ProbeRecord[] = [
      {
        path: secretPath,
        source: "running_process",
        running: true,
      },
      {
        path: String.raw`C:\Profiles\Alice.Secret\Downloads\PCL2.exe`,
        source: "running_process",
        running: true,
      },
      {
        path: String.raw`C:\Profiles\Alice.Secret\Downloads\Plain Craft Launcher 2.exe.bat`,
        source: "start_menu",
        running: false,
      },
    ];
    const discovery = new Pcl2Discovery({
      probe: async () => ({ records, diagnostic: null }),
      canonicalize: async (path) => path,
      statPath: async () => ({ isFile: () => true }),
      idFactory: () => "pcl2_candidate_safe1",
    });

    const candidates = await discovery.discoverPcl2();

    expect(candidates).toEqual([
      {
        id: "pcl2_candidate_safe1",
        displayPath: "Plain Craft Launcher 2.exe",
        source: "running_process",
        running: true,
      },
    ]);
    expect(JSON.stringify(candidates)).not.toContain("Alice");
    expect(JSON.stringify(candidates)).not.toContain("C:\\");
    expect(Object.keys(candidates[0] ?? {}).sort()).toEqual([
      "displayPath",
      "id",
      "running",
      "source",
    ]);
  });

  it("bounds renderer candidates and clears stale canonical-path authority on refresh", async () => {
    let generation = 0;
    const records = Array.from({ length: 40 }, (_, index): Pcl2ProbeRecord => ({
      path: `C:\\PCL2-${index}\\Plain Craft Launcher 2.exe`,
      source: "known_location",
      running: false,
    }));
    const discovery = new Pcl2Discovery({
      probe: async () => ({
        records: generation++ === 0 ? records : [],
        diagnostic: null,
      }),
      canonicalize: async (path) => path,
      statPath: async () => ({ isFile: () => true }),
      idFactory: (() => {
        let index = 0;
        return () => `pcl2_candidate_${String(++index).padStart(4, "0")}`;
      })(),
    });

    const first = await discovery.discoverPcl2();
    expect(first).toHaveLength(32);
    expect(discovery.resolveCanonicalPath(first[0]!.id)).toContain("PCL2-0");

    await expect(discovery.discoverPcl2()).resolves.toEqual([]);
    expect(discovery.resolveCanonicalPath(first[0]!.id)).toBeUndefined();
  });

  it("retains a late running-process observation when public candidates are capped", async () => {
    const firstPath = String.raw`C:\PCL2-0\Plain Craft Launcher 2.exe`;
    const records: Pcl2ProbeRecord[] = Array.from({ length: 32 }, (_, index): Pcl2ProbeRecord => ({
      path: `C:\\PCL2-${index}\\Plain Craft Launcher 2.exe`,
      source: "known_location",
      running: false,
    }));
    records.push({
      path: firstPath.toLowerCase(),
      source: "running_process",
      running: true,
    });
    const discovery = new Pcl2Discovery({
      probe: async () => ({ records, diagnostic: null }),
      canonicalize: async (path) => path,
      statPath: async () => ({ isFile: () => true }),
      idFactory: (() => {
        let index = 0;
        return () => `pcl2_candidate_${String(++index).padStart(4, "0")}`;
      })(),
    });

    const candidates = await discovery.discoverPcl2();

    expect(candidates).toHaveLength(32);
    expect(candidates[0]).toMatchObject({
      source: "running_process",
      running: true,
    });
  });

  it.each([
    {
      name: "directory with executable basename",
      input: String.raw`C:\Profiles\Safe\Plain Craft Launcher 2.exe`,
      canonical: String.raw`C:\Profiles\Safe\Plain Craft Launcher 2.exe`,
      isFile: false,
    },
    {
      name: "reparse target with a different final basename",
      input: String.raw`C:\Profiles\Safe\Plain Craft Launcher 2.exe`,
      canonical: String.raw`C:\Profiles\Safe\Not PCL2.exe`,
      isFile: true,
    },
    {
      name: "UNC target",
      input: String.raw`C:\Profiles\Safe\Plain Craft Launcher 2.exe`,
      canonical: String.raw`\\server\share\Plain Craft Launcher 2.exe`,
      isFile: true,
    },
    {
      name: "device target",
      input: String.raw`C:\Profiles\Safe\Plain Craft Launcher 2.exe`,
      canonical: String.raw`\\?\C:\Profiles\Safe\Plain Craft Launcher 2.exe`,
      isFile: true,
    },
  ])("rejects $name after canonicalization", async ({ input, canonical, isFile }) => {
    const discovery = new Pcl2Discovery({
      probe: async () => ({
        records: [{ path: input, source: "start_menu", running: false }],
        diagnostic: null,
      }),
      canonicalize: async () => canonical,
      statPath: async () => ({ isFile: () => isFile }),
      idFactory: () => "pcl2_candidate_safe1",
    });

    await expect(discovery.discoverPcl2()).resolves.toEqual([]);
    expect(discovery.resolveCanonicalPath("pcl2_candidate_safe1")).toBeUndefined();
  });
});
