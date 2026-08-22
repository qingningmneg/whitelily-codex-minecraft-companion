// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopChildServer } from "../../../src/desktop/childServer.js";
import { WorldProfileStore } from "../../../src/world/worldProfileStore.js";
import { ChildSupervisor, type ChildProcessPort, type SpawnChild } from "./childSupervisor.js";
import { WorldBindingAuthority } from "./discovery/worldBindingAuthority.js";
import { ExternalUrlPolicy } from "./externalUrlPolicy.js";
import { registerIpcHandlers } from "./ipcRegistry.js";
import { WHITE_LILY_IPC_CHANNELS } from "../src/desktopApi.js";

const config = `[minecraft]\nhost = "127.0.0.1"\nport = 25565\nbot_username = "WhiteLily"\nowner_username = "TestOwner"\n\n[codex]\npreferred_model = "gpt-5.6-terra"\nreasoning_effort = "low"\nallow_api_key_fallback = false\n\n[companion]\nstart_mode = "friend"\npersona_name = "白百合"\n\n[safety]\nspawn_protection_radius = 16\nbreak_confirmation_threshold = 32\nplace_confirmation_threshold = 128\ntravel_confirmation_distance = 256\n`;
const proof = { nonce: "e2e_private_proof_0001", port: 25565, issuedAt: 10, expiresAt: 110 };

class BridgeChild extends EventEmitter implements ChildProcessPort {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  server: DesktopChildServer | undefined;
  constructor() {
    super();
  }
  kill(): boolean {
    this.stdin.end();
    return true;
  }
}

describe("private bound-world IPC", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("carries only public intent through IPC and consumes a private authority on success or conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-ipc-private-"));
    const configPath = join(root, "config.toml");
    await writeFile(configPath, config, "utf8");
    let activeProof: string | undefined;
    const child = new BridgeChild();
    const spawn: SpawnChild = () => {
      const worlds = new WorldProfileStore({
        rootDirectory: root,
        now: () => 100,
        isCurrentLanProof: (value) => activeProof === value.nonce,
      });
      child.server = new DesktopChildServer({
        input: child.stdin,
        output: child.stdout,
        worldProfiles: worlds,
        now: () => 100,
        ownerIdentity: {
          snapshot: () => ({
            revision: 0,
            ownerUsername: "TestOwner",
            configured: true,
            presence: "unknown",
          }),
          update: async () => {
            throw new Error("unused");
          },
          setPresence: () => undefined,
          subscribe: () => () => undefined,
        },
        activatePrivateWorldBinding: (binding) => {
          activeProof = binding.proof.nonce;
          return () => {
            activeProof = undefined;
          };
        },
        account: {
          getAccount: async () => ({ status: "signed_out" }),
          startChatGptLogin: async () => {
            throw new Error("unused");
          },
          cancelChatGptLogin: async () => ({ status: "signed_out" }),
          subscribe: () => () => undefined,
          stop: async () => undefined,
        },
        models: {
          listModels: async () => ({
            models: [],
            selection: { mode: "automatic" },
            legacyMigrationCompleted: true,
          }),
          migrateLegacyPreference: async () => ({
            models: [],
            selection: { mode: "automatic" },
            legacyMigrationCompleted: true,
          }),
          selectModel: async () => ({ mode: "automatic" }),
          prepareSelection: async (selection) => ({
            preferenceRevision: 0,
            requested: selection,
            resolved: { modelId: "test", reasoningEffort: "low" },
          }),
          commitSelection: async (prepared) =>
            prepared.requested.mode === "automatic"
              ? { mode: "automatic" }
              : { ...prepared.requested, available: true },
          resolveRuntimeSelection: async () => ({ modelId: "test", reasoningEffort: "low" }),
          subscribe: () => () => undefined,
          stop: () => undefined,
        },
        createRuntime: async () => {
          throw new Error("unused");
        },
      });
      child.server.start();
      return child;
    };
    const supervisor = new ChildSupervisor({
      childEntry: "C:\\WhiteLily\\child.mjs",
      configPath: "C:\\WhiteLily\\config.toml",
      workingDirectory: "C:\\WhiteLily",
      environment: {},
      development: false,
      spawn,
    });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const authority = new WorldBindingAuthority({
      configPath,
      lanDetector: {
        redeemConfirmedProof: async () => ({
          pid: 1234,
          processStartedAt: 100,
          port: 25565,
          version: "1.21.5",
        }),
      },
      readJavaProcessSnapshot: async () => ({
        pid: 1234,
        processStartedAt: 100,
        executablePath: "C:/Java/bin/javaw.exe",
        commandLine: "javaw --gameDir C:/Instance",
      }),
      resolveInstancePath: async () => "C:/Instance",
    });
    let confirmations = 0;
    const cleanup = registerIpcHandlers({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => handlers.delete(channel),
      },
      supervisor,
      publishRuntime: () => undefined,
      publishOwnerIdentity: () => undefined,
      externalUrlPolicy: new ExternalUrlPolicy(),
      openExternal: async () => undefined,
      pcl2Discovery: { discoverPcl2: async () => [] },
      lanDetector: {
        detectLanCandidates: async () => [],
        confirmLanCandidate: async (_id, apply) => {
          confirmations += 1;
          await apply({
            ...proof,
            nonce: `e2e_private_proof_${String(confirmations).padStart(4, "0")}`,
          });
          return { status: "confirmed", port: 25565, version: "1.21.5", confirmedAt: 10 };
        },
        validateConfirmedSession: async () => true,
        stop: () => undefined,
      },
      worldAuthority: authority,
    });
    cleanups.push(async () => {
      cleanup();
      await child.server?.stop();
    });
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.confirmLanCandidate, "candidate_e2e_0001"),
    ).resolves.toMatchObject({ status: "confirmed" });
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.bindConfirmedWorld, {
        expectedRevision: 0,
        label: "Survival",
        binding: {},
      }),
    ).rejects.toThrow("invalid desktop request");
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.bindConfirmedWorld, {
        expectedRevision: 0,
        label: "Survival",
      }),
    ).resolves.toMatchObject({ revision: 1, value: { label: "Survival" } });
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.bindConfirmedWorld, { expectedRevision: 1, label: "Replay" }),
    ).rejects.toThrow("not confirmed");
    await invoke(WHITE_LILY_IPC_CHANNELS.confirmLanCandidate, "candidate_e2e_0002");
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.bindConfirmedWorld, {
        expectedRevision: 0,
        label: "Conflict",
      }),
    ).rejects.toThrow("DOCUMENT_CONFLICT");
    await expect(
      invoke(WHITE_LILY_IPC_CHANNELS.bindConfirmedWorld, { expectedRevision: 1, label: "Replay" }),
    ).rejects.toThrow("not confirmed");
  });
});
