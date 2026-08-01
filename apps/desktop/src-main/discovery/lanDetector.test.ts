// @vitest-environment node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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

describe("fixed Java listener probe", () => {
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
    expect(FIXED_JAVA_LISTENER_PROBE_SCRIPT).not.toMatch(/\$args|param\s*\(/iu);
    expect(FIXED_JAVA_LISTENER_PROBE_SCRIPT).toContain("$safeVersion = '1.21.5'");
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
