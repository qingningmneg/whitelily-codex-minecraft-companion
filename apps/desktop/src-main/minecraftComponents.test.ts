// @vitest-environment node

import { createHash } from "node:crypto";
import { renameSync, watch, writeFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LanDetector } from "./discovery/lanDetector.js";
import type { JavaListenerProbeRecord } from "./discovery/fixedWindowsProbe.js";
import { WorldBindingAuthority } from "./discovery/worldBindingAuthority.js";
import {
  createMinecraftComponentManager,
  type MinecraftComponentResourceManifest,
} from "./minecraftComponents.js";

const PROCESS_STARTED_AT = 1_785_196_800_123;
const BEFORE_PROCESS_START = new Date(PROCESS_STARTED_AT - 10_000);
const AFTER_PROCESS_START = new Date(PROCESS_STARTED_AT + 10_000);
const BRIDGE_FILE = "whitelily-bridge-fabric-1.21.5-0.1.0.jar";
const PRIOR_BRIDGE_FILE = "whitelily-bridge-fabric-1.21.5-0.0.9.jar";
const AVATAR_FILE = "whitelily-avatar-fabric-1.21.5-0.1.0.jar";

interface Fixture {
  readonly root: string;
  readonly gameDir: string;
  readonly mods: string;
  readonly resources: string;
  readonly presence: string;
  readonly candidateId: string;
  readonly bridge: Buffer;
  readonly priorBridge: Buffer;
  readonly avatar: Buffer;
  readonly manifest: MinecraftComponentResourceManifest;
  readonly manager: ReturnType<typeof createMinecraftComponentManager>;
  cleanup(): Promise<void>;
}

interface FixtureOptions {
  readonly fabric?: boolean;
  readonly commandLineOverride?: (gameDir: string) => string;
  readonly version?: "1.21.5" | null;
  readonly onProbe?: (
    call: number,
    fixture: Omit<Fixture, "manager" | "candidateId">,
  ) => Promise<void>;
  readonly probeRecordPatch?: (call: number) => Partial<JavaListenerProbeRecord>;
  readonly gameDirOverride?: (fixture: Omit<Fixture, "manager" | "candidateId">) => string;
  readonly manifestPatch?: (
    manifest: MinecraftComponentResourceManifest,
  ) => MinecraftComponentResourceManifest;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "whitelily-components-"));
  const gameDir = join(root, "game");
  const mods = join(gameDir, "mods");
  const resources = join(root, "resources");
  const presence = join(root, "presence");
  await mkdir(mods, { recursive: true });
  await mkdir(resources);
  await mkdir(presence);
  const bridge = jar("whitelily_bridge", "0.1.0");
  const priorBridge = jar("whitelily_bridge", "0.0.9");
  const avatar = jar("whitelily_avatar", "0.1.0");
  await writeFile(join(resources, BRIDGE_FILE), bridge);
  await writeFile(join(resources, AVATAR_FILE), avatar);
  const baseManifest: MinecraftComponentResourceManifest = {
    schemaVersion: 1,
    minecraftVersion: "1.21.5",
    artifacts: [
      {
        component: "bridge",
        fileName: BRIDGE_FILE,
        bytes: bridge.byteLength,
        sha256: sha256(bridge),
        modId: "whitelily_bridge",
        version: "0.1.0",
        prior: [
          {
            fileName: PRIOR_BRIDGE_FILE,
            bytes: priorBridge.byteLength,
            sha256: sha256(priorBridge),
            modId: "whitelily_bridge",
            version: "0.0.9",
          },
        ],
      },
      {
        component: "avatar",
        fileName: AVATAR_FILE,
        bytes: avatar.byteLength,
        sha256: sha256(avatar),
        modId: "whitelily_avatar",
        version: "0.1.0",
        prior: [],
      },
    ],
  };
  const manifest = options.manifestPatch?.(baseManifest) ?? baseManifest;
  const partial = {
    root,
    gameDir,
    mods,
    resources,
    presence,
    bridge,
    priorBridge,
    avatar,
    manifest,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
  let probeCalls = 0;
  const detector = new LanDetector({
    probe: async () => {
      probeCalls += 1;
      await options.onProbe?.(probeCalls, partial);
      const recordPatch = options.probeRecordPatch?.(probeCalls);
      return {
        records: [
          {
            localAddress: "127.0.0.1",
            localPort: 51321,
            pid: 4200,
            processName: "javaw.exe",
            processStartedAt: PROCESS_STARTED_AT,
            version: options.version === undefined ? "1.21.5" : options.version,
            ...recordPatch,
          },
        ],
        diagnostic: null,
      };
    },
    now: () => PROCESS_STARTED_AT + 30_000,
    idFactory: () => "lan_candidate_components01",
  });
  const candidateId = (await detector.detectLanCandidates())[0]!.id;
  const selectedGameDir = options.gameDirOverride?.(partial) ?? gameDir;
  const mainClass =
    options.fabric === false
      ? "net.minecraft.client.main.Main"
      : "net.fabricmc.loader.impl.launch.knot.KnotClient";
  const snapshot = {
    pid: 4200,
    processStartedAt: PROCESS_STARTED_AT,
    executablePath: "C:/Java/bin/javaw.exe",
    commandLine:
      options.commandLineOverride?.(selectedGameDir) ??
      `javaw.exe -cp fabric-loader.jar ${mainClass} --version Fabric --gameDir "${selectedGameDir}"`,
  };
  const authority = new WorldBindingAuthority({
    configPath: join(root, "unused.toml"),
    lanDetector: detector,
    readJavaProcessSnapshot: async () => snapshot,
  });
  let manager: ReturnType<typeof createMinecraftComponentManager>;
  try {
    manager = createMinecraftComponentManager({
      lanDetector: detector,
      worldBindingAuthority: authority,
      resourceDirectory: resources,
      presenceDirectory: presence,
      manifest,
    });
  } catch (error) {
    await partial.cleanup();
    throw error;
  }
  return { ...partial, candidateId, manager };
}

async function installFixtureFile(
  fixture: Fixture,
  fileName: string,
  bytes: Buffer,
  modified = BEFORE_PROCESS_START,
): Promise<string> {
  const path = join(fixture.mods, fileName);
  await writeFile(path, bytes);
  await utimes(path, modified, modified);
  return path;
}

async function writePresence(
  fixture: Fixture,
  patch: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  await writeFile(
    join(fixture.presence, "4200.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      pid: 4200,
      processStartEpochMs: PROCESS_STARTED_AT,
      minecraftVersion: "1.21.5",
      bridgeVersion: "0.1.0",
      writtenAt: PROCESS_STARTED_AT + 100,
      ...patch,
    })}\n`,
    "utf8",
  );
}

describe("Minecraft component manager", () => {
  it("installs fixed manifest bytes and reports a restart for the running Java instance", async () => {
    const fixture = await createFixture();
    try {
      await expect(fixture.manager.status(fixture.candidateId)).resolves.toEqual({
        state: "bridge_not_installed",
        bridgeInstalled: false,
        bridgeActive: false,
        avatarInstalled: false,
        restartRequired: false,
      });

      await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).resolves.toEqual({
        state: "bridge_restart_required",
        bridgeInstalled: true,
        bridgeActive: false,
        avatarInstalled: false,
        restartRequired: true,
      });
      expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(fixture.bridge);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps an exact current hash idempotent without changing its identity or mtime", async () => {
    const fixture = await createFixture();
    try {
      const path = await installFixtureFile(fixture, BRIDGE_FILE, fixture.bridge);
      await writePresence(fixture);
      const before = await lstat(path, { bigint: true });

      await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).resolves.toMatchObject(
        {
          state: "avatar_not_installed",
          bridgeInstalled: true,
          bridgeActive: true,
          restartRequired: false,
        },
      );

      const after = await lstat(path, { bigint: true });
      expect({ ino: after.ino, mtimeNs: after.mtimeNs }).toEqual({
        ino: before.ino,
        mtimeNs: before.mtimeNs,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("updates one reviewed prior JAR through a collision-free backup and removes the backup", async () => {
    const fixture = await createFixture();
    try {
      await installFixtureFile(fixture, PRIOR_BRIDGE_FILE, fixture.priorBridge);

      await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).resolves.toMatchObject(
        {
          state: "bridge_restart_required",
          bridgeInstalled: true,
        },
      );

      expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(fixture.bridge);
      await expect(lstat(join(fixture.mods, PRIOR_BRIDGE_FILE))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        lstat(join(fixture.mods, `${PRIOR_BRIDGE_FILE}.whitelily-disabled`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves an unknown same-name file and reports a fixed conflict", async () => {
    const fixture = await createFixture();
    try {
      const foreign = Buffer.from("foreign jar");
      await writeFile(join(fixture.mods, BRIDGE_FILE), foreign);

      await expect(fixture.manager.status(fixture.candidateId)).resolves.toMatchObject({
        state: "bridge_file_conflict",
        bridgeInstalled: false,
      });
      await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).resolves.toMatchObject(
        { state: "bridge_file_conflict" },
      );
      expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(foreign);
    } finally {
      await fixture.cleanup();
    }
  });

  it("removes only reviewed WhiteLily current artifacts and treats a missing target as idempotent", async () => {
    const fixture = await createFixture();
    try {
      await installFixtureFile(fixture, BRIDGE_FILE, fixture.bridge);
      await installFixtureFile(fixture, AVATAR_FILE, fixture.avatar);

      await expect(fixture.manager.remove(fixture.candidateId, ["avatar"])).resolves.toMatchObject({
        state: "bridge_not_active",
        bridgeInstalled: true,
        avatarInstalled: false,
      });
      expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(fixture.bridge);
      await expect(lstat(join(fixture.mods, AVATAR_FILE))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fixture.manager.remove(fixture.candidateId, ["avatar"])).resolves.toMatchObject({
        avatarInstalled: false,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("distinguishes current JAR mtimes and exact presence bound to this Java start", async () => {
    const fixture = await createFixture();
    try {
      const bridge = await installFixtureFile(
        fixture,
        BRIDGE_FILE,
        fixture.bridge,
        AFTER_PROCESS_START,
      );
      await expect(fixture.manager.status(fixture.candidateId)).resolves.toMatchObject({
        state: "bridge_restart_required",
        restartRequired: true,
      });

      await utimes(bridge, BEFORE_PROCESS_START, BEFORE_PROCESS_START);
      await expect(fixture.manager.status(fixture.candidateId)).resolves.toMatchObject({
        state: "bridge_not_active",
        bridgeInstalled: true,
        bridgeActive: false,
      });

      await writePresence(fixture, { processStartEpochMs: PROCESS_STARTED_AT + 1 });
      await expect(fixture.manager.status(fixture.candidateId)).resolves.toMatchObject({
        state: "bridge_not_active",
        bridgeActive: false,
      });

      await writePresence(fixture);
      await expect(fixture.manager.status(fixture.candidateId)).resolves.toMatchObject({
        state: "avatar_not_installed",
        bridgeActive: true,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports Avatar restart and ready only from exact current Bridge and Avatar files", async () => {
    const fixture = await createFixture();
    try {
      await installFixtureFile(fixture, BRIDGE_FILE, fixture.bridge);
      const avatar = await installFixtureFile(
        fixture,
        AVATAR_FILE,
        fixture.avatar,
        AFTER_PROCESS_START,
      );
      await writePresence(fixture);

      await expect(fixture.manager.status(fixture.candidateId)).resolves.toMatchObject({
        state: "avatar_restart_required",
        bridgeActive: true,
        avatarInstalled: true,
        restartRequired: true,
      });

      await utimes(avatar, BEFORE_PROCESS_START, BEFORE_PROCESS_START);
      await expect(fixture.manager.status(fixture.candidateId)).resolves.toEqual({
        state: "ready",
        bridgeInstalled: true,
        bridgeActive: true,
        avatarInstalled: true,
        restartRequired: false,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects non-Fabric argv and reports stable unsupported metadata", async () => {
    const nonFabric = await createFixture({ fabric: false });
    const fabricClassDecoy = await createFixture({
      commandLineOverride: (gameDir) =>
        `javaw.exe -cp minecraft.jar net.minecraft.client.main.Main --profile "net.fabricmc.loader.impl.launch.knot.KnotClient" --gameDir "${gameDir}"`,
    });
    const unknownVersion = await createFixture({ version: null });
    try {
      await expect(nonFabric.manager.status(nonFabric.candidateId)).rejects.toThrow(
        "MINECRAFT_COMPONENT_AUTHORITY_INVALID",
      );
      await expect(fabricClassDecoy.manager.status(fabricClassDecoy.candidateId)).rejects.toThrow(
        "MINECRAFT_COMPONENT_AUTHORITY_INVALID",
      );
      await expect(
        unknownVersion.manager.status(unknownVersion.candidateId),
      ).resolves.toMatchObject({ state: "bridge_version_unsupported" });
    } finally {
      await nonFabric.cleanup();
      await fabricClassDecoy.cleanup();
      await unknownVersion.cleanup();
    }
  });

  it("rejects listener drift after canonical gameDir resolution without consuming the candidate", async () => {
    const fixture = await createFixture({
      probeRecordPatch: (call) => (call === 3 ? { localPort: 51322 } : {}),
    });
    try {
      await expect(fixture.manager.status(fixture.candidateId)).rejects.toThrow(
        "MINECRAFT_COMPONENT_AUTHORITY_INVALID",
      );
      await expect(lstat(join(fixture.mods, BRIDGE_FILE))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a renderer path-shaped candidate before any filesystem target is selected", async () => {
    const fixture = await createFixture();
    try {
      await expect(fixture.manager.status("C:\\Minecraft\\mods")).rejects.toThrow(
        "MINECRAFT_COMPONENT_AUTHORITY_INVALID",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects real mods junctions and exact-byte target hardlinks", async () => {
    const junctionFixture = await createFixture();
    const hardlinkFixture = await createFixture();
    try {
      const movedMods = join(junctionFixture.gameDir, "real-mods");
      await rename(junctionFixture.mods, movedMods);
      await symlink(movedMods, junctionFixture.mods, "junction");
      await expect(junctionFixture.manager.status(junctionFixture.candidateId)).rejects.toThrow(
        "MINECRAFT_COMPONENT_AUTHORITY_INVALID",
      );

      const source = join(hardlinkFixture.root, "bridge-source.jar");
      await writeFile(source, hardlinkFixture.bridge);
      await link(source, join(hardlinkFixture.mods, BRIDGE_FILE));
      await expect(
        hardlinkFixture.manager.status(hardlinkFixture.candidateId),
      ).resolves.toMatchObject({ state: "bridge_file_conflict" });
    } finally {
      await junctionFixture.cleanup();
      await hardlinkFixture.cleanup();
    }
  });

  it("rejects a missing direct mods directory instead of creating a target", async () => {
    const fixture = await createFixture();
    try {
      await rename(fixture.mods, join(fixture.gameDir, "moved-mods"));
      await expect(fixture.manager.status(fixture.candidateId)).rejects.toThrow(
        "MINECRAFT_COMPONENT_AUTHORITY_INVALID",
      );
      await expect(lstat(fixture.mods)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a real target file symlink, skipping only an actual Windows privilege denial", async (context) => {
    const fixture = await createFixture();
    try {
      const source = join(fixture.root, "bridge-source.jar");
      await writeFile(source, fixture.bridge);
      try {
        await symlink(source, join(fixture.mods, BRIDGE_FILE), "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          context.skip("Windows file-symlink creation denied by the current token");
          return;
        }
        throw error;
      }
      await expect(fixture.manager.status(fixture.candidateId)).resolves.toMatchObject({
        state: "bridge_file_conflict",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("detects parent identity drift during the final candidate re-probe", async () => {
    let drifted = false;
    const fixture = await createFixture({
      onProbe: async (call, current) => {
        if (call === 3) {
          drifted = true;
          await rename(current.mods, join(current.gameDir, "moved-mods"));
          await mkdir(current.mods);
        }
      },
    });
    try {
      await expect(fixture.manager.status(fixture.candidateId)).rejects.toThrow(
        "MINECRAFT_COMPONENT_AUTHORITY_INVALID",
      );
      expect(drifted).toBe(true);
      await expect(lstat(join(fixture.mods, BRIDGE_FILE))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("detects packaged resource-directory identity drift even with exact replacement bytes", async () => {
    let drifted = false;
    const fixture = await createFixture({
      onProbe: async (call, current) => {
        if (call === 3) {
          drifted = true;
          await rename(current.resources, join(current.root, "moved-resources"));
          await mkdir(current.resources);
          await writeFile(join(current.resources, BRIDGE_FILE), current.bridge);
          await writeFile(join(current.resources, AVATAR_FILE), current.avatar);
        }
      },
    });
    try {
      await expect(fixture.manager.status(fixture.candidateId)).rejects.toThrow(
        "MINECRAFT_COMPONENT_AUTHORITY_INVALID",
      );
      expect(drifted).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves a target introduced during candidate re-probe instead of clobbering it", async () => {
    const foreign = Buffer.from("raced replacement");
    const fixture = await createFixture({
      onProbe: async (call, current) => {
        if (call === 3) await writeFile(join(current.mods, BRIDGE_FILE), foreign);
      },
    });
    try {
      await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).resolves.toMatchObject(
        {
          state: "bridge_file_conflict",
        },
      );
      expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(foreign);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects fixed temp and update-backup collisions without deleting either collision", async () => {
    const tempFixture = await createFixture();
    const updateFixture = await createFixture();
    try {
      const tempPath = join(tempFixture.mods, `${BRIDGE_FILE}.whitelily-installing`);
      await writeFile(tempPath, "foreign temp", "utf8");
      await expect(
        tempFixture.manager.install(tempFixture.candidateId, ["bridge"]),
      ).rejects.toThrow("MINECRAFT_COMPONENT_OPERATION_FAILED");
      expect(await readFile(tempPath, "utf8")).toBe("foreign temp");

      const priorPath = await installFixtureFile(
        updateFixture,
        PRIOR_BRIDGE_FILE,
        updateFixture.priorBridge,
      );
      const backupPath = join(updateFixture.mods, `${PRIOR_BRIDGE_FILE}.whitelily-disabled`);
      await writeFile(backupPath, "foreign backup", "utf8");
      await expect(
        updateFixture.manager.install(updateFixture.candidateId, ["bridge"]),
      ).rejects.toThrow("MINECRAFT_COMPONENT_OPERATION_FAILED");
      expect(await readFile(priorPath)).toEqual(updateFixture.priorBridge);
      expect(await readFile(backupPath, "utf8")).toBe("foreign backup");
    } finally {
      await tempFixture.cleanup();
      await updateFixture.cleanup();
    }
  });

  it("restores a reviewed prior JAR when publication collides after the backup move", async () => {
    const fixture = await createFixture();
    const priorPath = await installFixtureFile(fixture, PRIOR_BRIDGE_FILE, fixture.priorBridge);
    const target = join(fixture.mods, BRIDGE_FILE);
    const backupName = `${PRIOR_BRIDGE_FILE}.whitelily-disabled`;
    const backupPath = join(fixture.mods, backupName);
    const foreign = Buffer.from("publication collision");
    let collided = false;
    const watcher = watch(fixture.mods, (_event, fileName) => {
      if (collided || fileName !== backupName) return;
      try {
        writeFileSync(target, foreign, { flag: "wx" });
        collided = true;
      } catch {
        // An earlier notification can arrive before the prior rename completes.
      }
    });
    try {
      await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).rejects.toThrow(
        "MINECRAFT_COMPONENT_OPERATION_FAILED",
      );
      expect(collided).toBe(true);
      expect(await readFile(priorPath)).toEqual(fixture.priorBridge);
      expect(await readFile(target)).toEqual(foreign);
      await expect(lstat(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      watcher.close();
      await fixture.cleanup();
    }
  });

  it("preserves a replacement detected before removal", async () => {
    const foreign = Buffer.from("replacement before unlink");
    let ownedMoved = "";
    const fixture = await createFixture({
      onProbe: async (call, current) => {
        if (call === 3) {
          ownedMoved = join(current.mods, "moved-owned.jar");
          await rename(join(current.mods, BRIDGE_FILE), ownedMoved);
          await writeFile(join(current.mods, BRIDGE_FILE), foreign);
        }
      },
    });
    try {
      await installFixtureFile(fixture, BRIDGE_FILE, fixture.bridge);
      await expect(fixture.manager.remove(fixture.candidateId, ["bridge"])).resolves.toMatchObject({
        state: "bridge_file_conflict",
      });
      expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(foreign);
      expect(await readFile(ownedMoved)).toEqual(fixture.bridge);
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves a replacement detected immediately after atomic publication", async () => {
    const fixture = await createFixture();
    const target = join(fixture.mods, BRIDGE_FILE);
    const movedOwned = join(fixture.mods, "published-owned.jar");
    const foreign = Buffer.from("replacement after publication");
    let replaced = false;
    const watcher = watch(fixture.mods, (_event, fileName) => {
      if (replaced || fileName !== BRIDGE_FILE) return;
      try {
        renameSync(target, movedOwned);
        writeFileSync(target, foreign, { flag: "wx" });
        replaced = true;
      } catch {
        // The callback may observe an earlier notification before publication completes.
      }
    });
    try {
      await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).rejects.toThrow(
        "MINECRAFT_COMPONENT_OPERATION_FAILED",
      );
      expect(replaced).toBe(true);
      expect(await readFile(target)).toEqual(foreign);
      expect(await readFile(movedOwned)).toEqual(fixture.bridge);
    } finally {
      watcher.close();
      await fixture.cleanup();
    }
  });

  it("rejects main-supplied manifest hash and embedded mod-ID mismatches", async () => {
    const badHash = await createFixture({
      manifestPatch: (manifest) => ({
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0]!, sha256: "0".repeat(64) }, manifest.artifacts[1]!],
      }),
    });
    const foreignBridge = jar("foreign_bridge", "0.1.0");
    const badEmbeddedId = await createFixture({
      manifestPatch: (manifest) => ({
        ...manifest,
        artifacts: [
          {
            ...manifest.artifacts[0]!,
            bytes: foreignBridge.byteLength,
            sha256: sha256(foreignBridge),
          },
          manifest.artifacts[1]!,
        ],
      }),
    });
    await writeFile(join(badEmbeddedId.resources, BRIDGE_FILE), foreignBridge);
    try {
      await expect(badHash.manager.status(badHash.candidateId)).rejects.toThrow(
        "MINECRAFT_COMPONENT_MANIFEST_INVALID",
      );
      await expect(
        createFixture({
          manifestPatch: (manifest) => ({
            ...manifest,
            artifacts: [
              { ...manifest.artifacts[0]!, modId: "foreign_bridge" },
              manifest.artifacts[1]!,
            ],
          }),
        }),
      ).rejects.toThrow("MINECRAFT_COMPONENT_MANIFEST_INVALID");
      await expect(badEmbeddedId.manager.status(badEmbeddedId.candidateId)).rejects.toThrow(
        "MINECRAFT_COMPONENT_MANIFEST_INVALID",
      );
    } finally {
      await badHash.cleanup();
      await badEmbeddedId.cleanup();
    }
  });
});

function jar(modId: string, version: string): Buffer {
  return zip([
    [
      "fabric.mod.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id: modId,
          version,
          environment: "client",
          depends: { minecraft: "=1.21.5", fabricloader: ">=0.16.14" },
        }),
        "utf8",
      ),
    ],
    ["fixture.txt", Buffer.from(`${modId}:${version}`, "utf8")],
  ]);
}

function zip(entries: readonly (readonly [string, Buffer])[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const encodedName = Buffer.from(name, "utf8");
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.byteLength, 18);
    local.writeUInt32LE(bytes.byteLength, 22);
    local.writeUInt16LE(encodedName.byteLength, 26);
    locals.push(local, encodedName, bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.byteLength, 20);
    central.writeUInt32LE(bytes.byteLength, 24);
    central.writeUInt16LE(encodedName.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, encodedName);
    offset += local.byteLength + encodedName.byteLength + bytes.byteLength;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
