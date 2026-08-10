import { execFile as nodeExecFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  parseJavaProcessSnapshotOutput,
  WorldBindingAuthority,
  type JavaProcessSnapshot,
} from "./worldBindingAuthority.js";

const execFile = promisify(nodeExecFile);

const config = `[minecraft]
host = "127.0.0.1"
port = 25565
bot_username = "WhiteLily"
owner_username = "TestOwner"

[codex]
preferred_model = "gpt-5.6-terra"
reasoning_effort = "low"
allow_api_key_fallback = false

[companion]
start_mode = "friend"
persona_name = "白百合"

[safety]
spawn_protection_radius = 16
break_confirmation_threshold = 32
place_confirmation_threshold = 128
travel_confirmation_distance = 256
`;

const proof = { nonce: "authority_proof_nonce_0001", port: 25565, issuedAt: 10, expiresAt: 9_999 };
const session = { pid: 1234, processStartedAt: 100, port: 25565, version: "1.21.5" };
const snapshot: JavaProcessSnapshot = {
  pid: session.pid,
  processStartedAt: session.processStartedAt,
  executablePath: "C:/Java/bin/javaw.exe",
  commandLine: 'javaw.exe --gameDir "C:/Minecraft/Instance"',
};

async function configPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "whitelily-world-authority-"));
  const path = join(directory, "config.toml");
  await writeFile(path, config, "utf8");
  return path;
}

describe("WorldBindingAuthority", () => {
  it("fails closed when the PowerShell snapshot is not valid UTF-8", () => {
    expect(() => parseJavaProcessSnapshotOutput(Buffer.from([0xc3, 0x28]))).toThrow(
      "invalid Java process snapshot encoding",
    );
  });

  it("rejects a UTF-8 BOM instead of silently accepting a prefixed snapshot", () => {
    const encoded = Buffer.from(JSON.stringify(snapshot), "utf8");
    expect(() =>
      parseJavaProcessSnapshotOutput(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded])),
    ).toThrow("invalid Java process snapshot encoding");
  });

  it("rejects a valid JSON snapshot beyond the PowerShell stdout byte limit", () => {
    const encoded = Buffer.from(
      JSON.stringify({ ...snapshot, commandLine: "x".repeat(65_536) }),
      "utf8",
    );
    expect(encoded.byteLength).toBeGreaterThan(65_536);

    expect(() => parseJavaProcessSnapshotOutput(encoded)).toThrow("invalid Java process snapshot");
  });

  it("accepts a valid snapshot at the exact PowerShell stdout byte limit", () => {
    const emptyCommandLine = Buffer.from(JSON.stringify({ ...snapshot, commandLine: "" }), "utf8");
    const commandLine = "x".repeat(65_536 - emptyCommandLine.byteLength);
    const encoded = Buffer.from(JSON.stringify({ ...snapshot, commandLine }), "utf8");
    expect(encoded.byteLength).toBe(65_536);

    expect(parseJavaProcessSnapshotOutput(encoded).commandLine).toBe(commandLine);
  });

  it.each([
    ["empty output", Buffer.alloc(0)],
    [
      "mixed JSON and diagnostic output",
      Buffer.concat([Buffer.from(JSON.stringify(snapshot), "utf8"), Buffer.from("\r\ndiagnostic")]),
    ],
  ])("rejects %s", (_label, output) => {
    expect(() => parseJavaProcessSnapshotOutput(output)).toThrow("invalid Java process snapshot");
  });

  it.skipIf(process.platform !== "win32")(
    "round-trips a real CJK --gameDir through Windows PowerShell before canonicalizing it",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "WhiteLily-白百合-"));
      const gameDirectory = join(root, "我的世界");
      const javaExecutable = join(root, "javaw.exe");
      const testConfigPath = join(root, "config.toml");
      await mkdir(gameDirectory);
      await copyFile(process.execPath, javaExecutable);
      await writeFile(testConfigPath, config, "utf8");
      const javaProcess = spawn(
        javaExecutable,
        ["-e", "setInterval(() => undefined, 1_000)", "--", "--gameDir", gameDirectory],
        { stdio: "ignore", windowsHide: true },
      );
      await once(javaProcess, "spawn");

      try {
        const { stdout } = await execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `[DateTimeOffset](Get-Process -Id ${javaProcess.pid}).StartTime.ToUniversalTime() | ForEach-Object ToUnixTimeMilliseconds`,
          ],
          { windowsHide: true },
        );
        const processStartedAt = Number.parseInt(stdout.trim(), 10);
        const liveSession = { ...session, pid: javaProcess.pid!, processStartedAt };
        const authority = new WorldBindingAuthority({
          configPath: testConfigPath,
          lanDetector: { redeemConfirmedProof: async () => liveSession },
        });

        await expect(authority.redeem(proof)).resolves.toMatchObject({
          canonicalInstancePath: await realpath(gameDirectory),
          javaSession: liveSession,
        });
      } finally {
        javaProcess.kill();
        await once(javaProcess, "exit");
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("fails closed when Java identity changes while resolving --gameDir", async () => {
    const snapshots = [snapshot, { ...snapshot, commandLine: "javaw.exe --gameDir C:/Other" }];
    const authority = new WorldBindingAuthority({
      configPath: await configPath(),
      lanDetector: { redeemConfirmedProof: async () => session },
      readJavaProcessSnapshot: async () => snapshots.shift()!,
      resolveInstancePath: async (received) => {
        expect(received).toEqual(snapshot);
        return "C:/Minecraft/Instance";
      },
    });

    await expect(authority.redeem(proof)).rejects.toThrow("identity changed");
  });

  it("resolves one immutable Java instance through the same double-snapshot authority path", async () => {
    const received: JavaProcessSnapshot[] = [];
    const authority = new WorldBindingAuthority({
      configPath: await configPath(),
      lanDetector: { redeemConfirmedProof: async () => session },
      readJavaProcessSnapshot: async () => snapshot,
      resolveInstancePath: async (value) => {
        received.push(value);
        return "C:/Minecraft/Instance";
      },
    });

    const resolved = await authority.resolveJavaInstance(session);

    expect(resolved).toEqual({
      canonicalInstancePath: "C:/Minecraft/Instance",
      javaSession: session,
      snapshot,
    });
    expect(received).toEqual([snapshot]);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.javaSession)).toBe(true);
    expect(Object.isFrozen(resolved.snapshot)).toBe(true);
  });

  it("rejects a linked --gameDir instead of silently canonicalizing through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-linked-game-dir-"));
    const target = join(root, "target");
    const linked = join(root, "linked");
    try {
      await mkdir(target);
      await symlink(target, linked, "junction");
      const linkedSnapshot = { ...snapshot, commandLine: `javaw.exe --gameDir "${linked}"` };
      const authority = new WorldBindingAuthority({
        configPath: await configPath(),
        lanDetector: { redeemConfirmedProof: async () => session },
        readJavaProcessSnapshot: async () => linkedSnapshot,
      });

      await expect(authority.resolveJavaInstance(session)).rejects.toThrow(
        "Minecraft instance path",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-Java snapshots through direct component inspection authority", async () => {
    const authority = new WorldBindingAuthority({
      configPath: await configPath(),
      lanDetector: { redeemConfirmedProof: async () => session },
      readJavaProcessSnapshot: async () => ({ ...snapshot, executablePath: "C:/node.exe" }),
      resolveInstancePath: async () => "C:/Minecraft/Instance",
    });

    await expect(authority.resolveJavaInstance(session)).rejects.toThrow("same Java process");
  });

  it("derives a binding only from a revalidated Java snapshot", async () => {
    const authority = new WorldBindingAuthority({
      configPath: await configPath(),
      lanDetector: { redeemConfirmedProof: async () => session },
      readJavaProcessSnapshot: async () => snapshot,
      resolveInstancePath: async (received) => {
        expect(received).toEqual(snapshot);
        return "C:/Minecraft/Instance";
      },
    });

    await expect(authority.redeem(proof)).resolves.toMatchObject({
      canonicalInstancePath: "C:/Minecraft/Instance",
      ownerUsername: "TestOwner",
      javaSession: session,
      proof,
    });
  });
});
