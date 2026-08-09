import { execFile as nodeExecFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
