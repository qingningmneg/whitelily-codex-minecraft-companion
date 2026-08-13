// @vitest-environment node

import { createHash } from "node:crypto";
import { renameSync, watch, writeFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { LanDetector } from "./discovery/lanDetector.js";
import type { LanObservation } from "./discovery/lanCandidateStore.js";
import type { JavaListenerProbeRecord } from "./discovery/fixedWindowsProbe.js";
import { WorldBindingAuthority } from "./discovery/worldBindingAuthority.js";
import {
  createMinecraftComponentManager,
  type MinecraftComponentResourceManifest,
} from "./minecraftComponents.js";

const PROCESS_STARTED_AT = 1_785_196_800_123;
const BEFORE_PROCESS_START = new Date(PROCESS_STARTED_AT - 10_000);
const AFTER_PROCESS_START = new Date(PROCESS_STARTED_AT + 10_000);
const BRIDGE_FILE = "whitelily-bridge-fabric-1.21.5-0.1.2.jar";
const PRIOR_BRIDGE_FILE = "whitelily-bridge-fabric-1.21.5-0.1.1.jar";
const LEGACY_BRIDGE_FILE = "whitelily-bridge-fabric-1.21.5-0.1.0.jar";
const AVATAR_FILE = "whitelily-avatar-fabric-1.21.5-0.1.0.jar";
const FABRIC_API_FILE = "fabric-api-0.128.2+1.21.5.jar";
const GECKOLIB_FILE = "geckolib-fabric-1.21.5-5.1.0.jar";
const FABRIC_LOADER_FILE = "fabric-loader-0.16.14.jar";

interface Fixture {
  readonly root: string;
  readonly gameDir: string;
  readonly mods: string;
  readonly resources: string;
  readonly presence: string;
  readonly candidateId: string;
  readonly bridge: Buffer;
  readonly priorBridge: Buffer;
  readonly legacyBridge: Buffer;
  readonly avatar: Buffer;
  readonly fabricApi: Buffer;
  readonly geckoLib: Buffer;
  readonly loader: Buffer;
  readonly loaderPath: string;
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
  readonly loaderId?: string;
  readonly loaderVersion?: string;
  readonly loaderBytes?: Buffer;
  readonly manifestPatch?: (
    manifest: MinecraftComponentResourceManifest,
  ) => MinecraftComponentResourceManifest;
  readonly managerFactory?: typeof createMinecraftComponentManager;
  readonly bridgeBytes?: Buffer;
  readonly stubWorldBindingAuthority?: boolean;
  readonly waitForJavaSessionExit?: (session: Readonly<LanObservation>) => Promise<void>;
  readonly probeRecords?: (
    call: number,
    record: JavaListenerProbeRecord,
  ) => readonly JavaListenerProbeRecord[];
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
  const bridge = options.bridgeBytes ?? jar("whitelily_bridge", "0.1.2");
  const priorBridge = jar("whitelily_bridge", "0.1.1");
  const legacyBridge = jar("whitelily_bridge", "0.1.0");
  const avatar = jar("whitelily_avatar", "0.1.0");
  const fabricApi = jar("fabric-api", "0.128.2+1.21.5");
  const geckoLib = jar("geckolib", "5.1.0");
  const loaderVersion = options.loaderVersion ?? "0.16.14";
  const loader = options.loaderBytes ?? jar(options.loaderId ?? "fabricloader", loaderVersion);
  const loaderDirectory = join(root, "libraries");
  const loaderPath = join(
    loaderDirectory,
    loaderVersion === "0.16.14" ? FABRIC_LOADER_FILE : `fabric-loader-${loaderVersion}.jar`,
  );
  await mkdir(loaderDirectory);
  await writeFile(loaderPath, loader);
  await writeFile(join(resources, BRIDGE_FILE), bridge);
  await writeFile(join(resources, AVATAR_FILE), avatar);
  await writeFile(join(resources, FABRIC_API_FILE), fabricApi);
  await writeFile(join(resources, GECKOLIB_FILE), geckoLib);
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
        version: "0.1.2",
        prior: [
          {
            fileName: PRIOR_BRIDGE_FILE,
            bytes: priorBridge.byteLength,
            sha256: sha256(priorBridge),
            modId: "whitelily_bridge",
            version: "0.1.1",
          },
          {
            fileName: LEGACY_BRIDGE_FILE,
            bytes: legacyBridge.byteLength,
            sha256: sha256(legacyBridge),
            modId: "whitelily_bridge",
            version: "0.1.0",
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
      {
        component: "avatar",
        fileName: FABRIC_API_FILE,
        bytes: fabricApi.byteLength,
        sha256: sha256(fabricApi),
        modId: "fabric-api",
        version: "0.128.2+1.21.5",
        prior: [],
      },
      {
        component: "avatar",
        fileName: GECKOLIB_FILE,
        bytes: geckoLib.byteLength,
        sha256: sha256(geckoLib),
        modId: "geckolib",
        version: "5.1.0",
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
    legacyBridge,
    avatar,
    fabricApi,
    geckoLib,
    loader,
    loaderPath,
    manifest,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
  let probeCalls = 0;
  const detector = new LanDetector({
    probe: async () => {
      probeCalls += 1;
      await options.onProbe?.(probeCalls, partial);
      const recordPatch = options.probeRecordPatch?.(probeCalls);
      const record: JavaListenerProbeRecord = {
        localAddress: "127.0.0.1",
        localPort: 51321,
        pid: 4200,
        processName: "javaw.exe",
        processStartedAt: PROCESS_STARTED_AT,
        version: options.version === undefined ? "1.21.5" : options.version,
        ...recordPatch,
      };
      return {
        records: options.probeRecords?.(probeCalls, record) ?? [record],
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
      `javaw.exe -cp "${loaderPath};minecraft.jar" ${mainClass} --version Fabric --gameDir "${selectedGameDir}"`,
  };
  const authority = options.stubWorldBindingAuthority
    ? {
        resolveJavaInstance: async (javaSession: Readonly<LanObservation>) => ({
          canonicalInstancePath: selectedGameDir,
          javaSession,
          snapshot,
        }),
      }
    : new WorldBindingAuthority({
        configPath: join(root, "unused.toml"),
        lanDetector: detector,
        readJavaProcessSnapshot: async () => snapshot,
      });
  let manager: ReturnType<typeof createMinecraftComponentManager>;
  try {
    manager = (options.managerFactory ?? createMinecraftComponentManager)(
      Object.assign(
        {
          lanDetector: detector,
          worldBindingAuthority: authority,
          resourceDirectory: resources,
          presenceDirectory: presence,
          manifest,
        },
        options.waitForJavaSessionExit
          ? { waitForJavaSessionExit: options.waitForJavaSessionExit }
          : {},
      ) as Parameters<typeof createMinecraftComponentManager>[0],
    );
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
      bridgeVersion: "0.1.2",
      writtenAt: PROCESS_STARTED_AT + 100,
      ...patch,
    })}\n`,
    "utf8",
  );
}

describe("Minecraft component manager", () => {
  it("accepts standard signed ZIP data descriptors used by the official Fabric Loader", async () => {
    const fixture = await createFixture({
      loaderBytes: dataDescriptorJar("fabricloader", "0.16.14"),
    });
    try {
      await expect(fixture.manager.status(fixture.candidateId)).resolves.toMatchObject({
        state: "bridge_not_installed",
        bridgeInstalled: false,
      });
    } finally {
      await fixture.cleanup();
    }
  });

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

  it.each([
    [PRIOR_BRIDGE_FILE, "priorBridge"],
    [LEGACY_BRIDGE_FILE, "legacyBridge"],
  ] as const)(
    "updates reviewed prior JAR %s through a collision-free backup and removes the backup",
    async (priorFile, priorBytes) => {
      const fixture = await createFixture();
      try {
        await installFixtureFile(fixture, priorFile, fixture[priorBytes]);

        await expect(
          fixture.manager.install(fixture.candidateId, ["bridge"]),
        ).resolves.toMatchObject({
          state: "bridge_restart_required",
          bridgeInstalled: true,
        });

        expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(fixture.bridge);
        await expect(lstat(join(fixture.mods, priorFile))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          lstat(join(fixture.mods, `${priorFile}.whitelily-disabled`)),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("waits for the authorized Java session to exit before updating a reviewed prior JAR", async () => {
    let processVisible = true;
    let releaseExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    const waitForJavaSessionExit = vi.fn(async (session: Readonly<LanObservation>) => {
      expect(session).toMatchObject({ pid: 4200, processStartedAt: PROCESS_STARTED_AT });
      await exited;
    });
    const fixture = await createFixture({
      waitForJavaSessionExit,
      probeRecords: (_call, record) => (processVisible ? [record] : []),
    });
    const priorPath = await installFixtureFile(fixture, PRIOR_BRIDGE_FILE, fixture.priorBridge);
    await installFixtureFile(fixture, AVATAR_FILE, fixture.avatar);
    await installFixtureFile(fixture, FABRIC_API_FILE, fixture.fabricApi);
    await installFixtureFile(fixture, GECKOLIB_FILE, fixture.geckoLib);
    try {
      const installation = fixture.manager.install(fixture.candidateId, ["bridge"]);

      await vi.waitFor(() => expect(waitForJavaSessionExit).toHaveBeenCalledTimes(1), {
        timeout: 10_000,
      });
      expect(await readFile(priorPath)).toEqual(fixture.priorBridge);
      await expect(lstat(join(fixture.mods, BRIDGE_FILE))).rejects.toMatchObject({
        code: "ENOENT",
      });

      processVisible = false;
      releaseExit();
      await expect(installation).resolves.toEqual({
        state: "bridge_restart_required",
        bridgeInstalled: true,
        bridgeActive: false,
        avatarInstalled: true,
        restartRequired: true,
      });
      expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(fixture.bridge);
      await expect(lstat(priorPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseExit();
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

  it("removes only the exact reviewed Avatar set and treats missing targets as idempotent", async () => {
    const fixture = await createFixture();
    try {
      await installFixtureFile(fixture, BRIDGE_FILE, fixture.bridge);
      await installFixtureFile(fixture, AVATAR_FILE, fixture.avatar);
      await installFixtureFile(fixture, FABRIC_API_FILE, fixture.fabricApi);
      await installFixtureFile(fixture, GECKOLIB_FILE, fixture.geckoLib);

      await expect(fixture.manager.remove(fixture.candidateId, ["avatar"])).resolves.toMatchObject({
        state: "bridge_not_active",
        bridgeInstalled: true,
        avatarInstalled: false,
      });
      expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(fixture.bridge);
      await expect(lstat(join(fixture.mods, AVATAR_FILE))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(join(fixture.mods, FABRIC_API_FILE))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(join(fixture.mods, GECKOLIB_FILE))).rejects.toMatchObject({
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
      await installFixtureFile(fixture, FABRIC_API_FILE, fixture.fabricApi);
      await installFixtureFile(fixture, GECKOLIB_FILE, fixture.geckoLib);
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

  it("makes Avatar imply Bridge while Bridge-only stays dependency-free", async () => {
    const bridgeOnly = await createFixture({ stubWorldBindingAuthority: true });
    const avatarOnly = await createFixture({ stubWorldBindingAuthority: true });
    try {
      await bridgeOnly.manager.install(bridgeOnly.candidateId, ["bridge"]);
      await expect(readFile(join(bridgeOnly.mods, BRIDGE_FILE))).resolves.toEqual(
        bridgeOnly.bridge,
      );
      for (const fileName of [AVATAR_FILE, FABRIC_API_FILE, GECKOLIB_FILE]) {
        await expect(lstat(join(bridgeOnly.mods, fileName))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }

      await avatarOnly.manager.install(avatarOnly.candidateId, ["avatar"]);
      await expect(readFile(join(avatarOnly.mods, AVATAR_FILE))).resolves.toEqual(
        avatarOnly.avatar,
      );
      await expect(readFile(join(avatarOnly.mods, FABRIC_API_FILE))).resolves.toEqual(
        avatarOnly.fabricApi,
      );
      await expect(readFile(join(avatarOnly.mods, GECKOLIB_FILE))).resolves.toEqual(
        avatarOnly.geckoLib,
      );
      await expect(readFile(join(avatarOnly.mods, BRIDGE_FILE))).resolves.toEqual(
        avatarOnly.bridge,
      );
    } finally {
      await bridgeOnly.cleanup();
      await avatarOnly.cleanup();
    }
  });

  it("makes Bridge removal remove the exact reviewed Avatar dependency set", async () => {
    const fixture = await createFixture({ stubWorldBindingAuthority: true });
    try {
      await fixture.manager.install(fixture.candidateId, ["avatar"]);
      await fixture.manager.remove(fixture.candidateId, ["bridge"]);
      for (const fileName of [BRIDGE_FILE, AVATAR_FILE, FABRIC_API_FILE, GECKOLIB_FILE]) {
        await expect(lstat(join(fixture.mods, fileName))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves the complete stack when Bridge removal preflight finds a dependency conflict", async () => {
    const fixture = await createFixture({ stubWorldBindingAuthority: true });
    const foreign = Buffer.from("foreign geckolib collision");
    try {
      await installFixtureFile(fixture, BRIDGE_FILE, fixture.bridge);
      await installFixtureFile(fixture, AVATAR_FILE, fixture.avatar);
      await installFixtureFile(fixture, FABRIC_API_FILE, fixture.fabricApi);
      await writeFile(join(fixture.mods, GECKOLIB_FILE), foreign);

      await expect(fixture.manager.remove(fixture.candidateId, ["bridge"])).resolves.toMatchObject({
        state: "bridge_file_conflict",
      });
      expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(fixture.bridge);
      expect(await readFile(join(fixture.mods, AVATAR_FILE))).toEqual(fixture.avatar);
      expect(await readFile(join(fixture.mods, FABRIC_API_FILE))).toEqual(fixture.fabricApi);
      expect(await readFile(join(fixture.mods, GECKOLIB_FILE))).toEqual(foreign);
    } finally {
      await fixture.cleanup();
    }
  });

  it("removes Avatar before dependencies for a valid permuted manifest", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        unlink: async (path: string) => {
          if (path.endsWith(AVATAR_FILE)) throw new Error("forced Avatar removal failure");
          return actual.unlink(path);
        },
      };
    });
    const { createMinecraftComponentManager: createFailingManager } =
      await import("./minecraftComponents.js");
    const fixture = await createFixture({
      managerFactory: createFailingManager,
      stubWorldBindingAuthority: true,
      manifestPatch: (manifest) => ({
        ...manifest,
        artifacts: [
          manifest.artifacts[0]!,
          manifest.artifacts[2]!,
          manifest.artifacts[3]!,
          manifest.artifacts[1]!,
        ],
      }),
    });
    try {
      await installFixtureFile(fixture, BRIDGE_FILE, fixture.bridge);
      await installFixtureFile(fixture, AVATAR_FILE, fixture.avatar);
      await installFixtureFile(fixture, FABRIC_API_FILE, fixture.fabricApi);
      await installFixtureFile(fixture, GECKOLIB_FILE, fixture.geckoLib);

      await expect(fixture.manager.remove(fixture.candidateId, ["bridge"])).rejects.toThrow(
        "MINECRAFT_COMPONENT_OPERATION_FAILED",
      );
      expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(fixture.bridge);
      expect(await readFile(join(fixture.mods, AVATAR_FILE))).toEqual(fixture.avatar);
      expect(await readFile(join(fixture.mods, FABRIC_API_FILE))).toEqual(fixture.fabricApi);
      expect(await readFile(join(fixture.mods, GECKOLIB_FILE))).toEqual(fixture.geckoLib);
    } finally {
      await fixture.cleanup();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("publishes Avatar last so a dependency failure cannot leave a broken Avatar stack", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        link: async (source: string, destination: string) => {
          if (destination.endsWith(GECKOLIB_FILE)) throw new Error("forced dependency failure");
          return actual.link(source, destination);
        },
      };
    });
    const { createMinecraftComponentManager: createFailingManager } =
      await import("./minecraftComponents.js");
    const fixture = await createFixture({
      managerFactory: createFailingManager,
      stubWorldBindingAuthority: true,
    });
    try {
      await expect(fixture.manager.install(fixture.candidateId, ["avatar"])).rejects.toThrow(
        "MINECRAFT_COMPONENT_OPERATION_FAILED",
      );
      expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(fixture.bridge);
      expect(await readFile(join(fixture.mods, FABRIC_API_FILE))).toEqual(fixture.fabricApi);
      await expect(lstat(join(fixture.mods, GECKOLIB_FILE))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(lstat(join(fixture.mods, AVATAR_FILE))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fixture.cleanup();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("reports a stable conflict for a foreign exact-name Avatar dependency", async () => {
    const fixture = await createFixture({ stubWorldBindingAuthority: true });
    const foreign = Buffer.from("foreign fabric api");
    try {
      await writeFile(join(fixture.mods, FABRIC_API_FILE), foreign);
      await expect(fixture.manager.status(fixture.candidateId)).resolves.toMatchObject({
        state: "bridge_file_conflict",
      });
      expect(await readFile(join(fixture.mods, FABRIC_API_FILE))).toEqual(foreign);
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

  it("rejects an authentic Fabric Loader below the reviewed minimum and fake loader metadata", async () => {
    const oldLoader = await createFixture({ loaderVersion: "0.16.13" });
    const fakeLoader = await createFixture({ loaderId: "foreign_loader" });
    try {
      await expect(oldLoader.manager.status(oldLoader.candidateId)).rejects.toThrow(
        "MINECRAFT_COMPONENT_AUTHORITY_INVALID",
      );
      await expect(fakeLoader.manager.status(fakeLoader.candidateId)).rejects.toThrow(
        "MINECRAFT_COMPONENT_AUTHORITY_INVALID",
      );
    } finally {
      await oldLoader.cleanup();
      await fakeLoader.cleanup();
    }
  });

  it("rejects an Avatar manifest missing exact Fabric API or GeckoLib versions", async () => {
    const fixture = await createFixture();
    const complete = fixture.manifest.artifacts;
    const create = (artifacts: MinecraftComponentResourceManifest["artifacts"]) =>
      createMinecraftComponentManager({
        lanDetector: { inspectCandidate: async () => Promise.reject(new Error("unused")) },
        worldBindingAuthority: {
          resolveJavaInstance: async () => Promise.reject(new Error("unused")),
        },
        resourceDirectory: fixture.resources,
        presenceDirectory: fixture.presence,
        manifest: { ...fixture.manifest, artifacts },
      });
    try {
      expect(() => create(complete.slice(0, -1))).toThrow("MINECRAFT_COMPONENT_MANIFEST_INVALID");
      expect(() =>
        create([...complete.slice(0, -1), { ...complete.at(-1)!, version: "5.0.0" }]),
      ).toThrow("MINECRAFT_COMPONENT_MANIFEST_INVALID");
    } finally {
      await fixture.cleanup();
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
          await writeFile(join(current.resources, FABRIC_API_FILE), current.fabricApi);
          await writeFile(join(current.resources, GECKOLIB_FILE), current.geckoLib);
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

  it("atomically rejects a foreign target introduced at the publication syscall", async () => {
    const foreign = Buffer.from("publication syscall collision");
    let raced = 0;
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      const racePublication = async (source: string, destination: string): Promise<void> => {
        if (
          raced === 0 &&
          source.endsWith(".whitelily-installing") &&
          destination.endsWith(BRIDGE_FILE)
        ) {
          writeFileSync(destination, foreign, { flag: "wx" });
          raced += 1;
        }
      };
      return {
        ...actual,
        link: async (source: string, destination: string) => {
          await racePublication(source, destination);
          return actual.link(source, destination);
        },
        rename: async (source: string, destination: string) => {
          await racePublication(source, destination);
          return actual.rename(source, destination);
        },
      };
    });
    const { createMinecraftComponentManager: createRacingManager } =
      await import("./minecraftComponents.js");
    const fixture = await createFixture({ managerFactory: createRacingManager });
    const target = join(fixture.mods, BRIDGE_FILE);
    try {
      await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).rejects.toThrow(
        "MINECRAFT_COMPONENT_OPERATION_FAILED",
      );
      expect(raced).toBe(1);
      expect(await readFile(target)).toEqual(foreign);
      await expect(
        lstat(join(fixture.mods, `${BRIDGE_FILE}.whitelily-installing`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.cleanup();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("atomically rejects a foreign backup introduced at its publication syscall", async () => {
    const foreign = Buffer.from("backup syscall collision");
    let collisions = 0;
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        link: async (source: string, destination: string) => {
          if (
            collisions === 0 &&
            source.endsWith(PRIOR_BRIDGE_FILE) &&
            destination.endsWith(".whitelily-disabled")
          ) {
            writeFileSync(destination, foreign, { flag: "wx" });
            collisions += 1;
          }
          return actual.link(source, destination);
        },
      };
    });
    const { createMinecraftComponentManager: createRacingManager } =
      await import("./minecraftComponents.js");
    const fixture = await createFixture({ managerFactory: createRacingManager });
    const priorPath = await installFixtureFile(fixture, PRIOR_BRIDGE_FILE, fixture.priorBridge);
    const backupPath = join(fixture.mods, `${PRIOR_BRIDGE_FILE}.whitelily-disabled`);
    try {
      await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).rejects.toThrow(
        "MINECRAFT_COMPONENT_OPERATION_FAILED",
      );
      expect(collisions).toBe(1);
      expect(await readFile(priorPath)).toEqual(fixture.priorBridge);
      expect(await readFile(backupPath)).toEqual(foreign);
    } finally {
      await fixture.cleanup();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("atomically rejects rollback-restore syscall collisions", async () => {
    const targetForeign = Buffer.from("publication collision");
    const priorForeign = Buffer.from("restore collision");
    let publicationCollisions = 0;
    let restoreCollisions = 0;
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        link: async (source: string, destination: string) => {
          if (
            publicationCollisions === 0 &&
            source.endsWith(".whitelily-installing") &&
            destination.endsWith(BRIDGE_FILE)
          ) {
            writeFileSync(destination, targetForeign, { flag: "wx" });
            publicationCollisions += 1;
          } else if (
            restoreCollisions === 0 &&
            source.endsWith(".whitelily-disabled") &&
            destination.endsWith(PRIOR_BRIDGE_FILE)
          ) {
            writeFileSync(destination, priorForeign, { flag: "wx" });
            restoreCollisions += 1;
          }
          return actual.link(source, destination);
        },
      };
    });
    const { createMinecraftComponentManager: createRacingManager } =
      await import("./minecraftComponents.js");
    const fixture = await createFixture({ managerFactory: createRacingManager });
    const priorPath = await installFixtureFile(fixture, PRIOR_BRIDGE_FILE, fixture.priorBridge);
    const backupPath = join(fixture.mods, `${PRIOR_BRIDGE_FILE}.whitelily-disabled`);
    try {
      await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).rejects.toThrow(
        "MINECRAFT_COMPONENT_OPERATION_FAILED",
      );
      expect({ publicationCollisions, restoreCollisions }).toEqual({
        publicationCollisions: 1,
        restoreCollisions: 1,
      });
      expect(await readFile(join(fixture.mods, BRIDGE_FILE))).toEqual(targetForeign);
      expect(await readFile(priorPath)).toEqual(priorForeign);
      expect(await readFile(backupPath)).toEqual(fixture.priorBridge);
    } finally {
      await fixture.cleanup();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
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

  it.each(["writeFile", "sync"] as const)(
    "cleans its exact partial staging file when FileHandle.%s fails",
    async (method) => {
      const fixture = await createFixture();
      const temporaryPath = join(fixture.mods, `${BRIDGE_FILE}.whitelily-installing`);
      const probePath = join(fixture.root, `file-handle-${method}`);
      const probe = await open(probePath, "wx");
      let prototype = Object.getPrototypeOf(probe) as Record<
        string,
        (...args: never[]) => unknown
      > | null;
      while (prototype && !Object.prototype.hasOwnProperty.call(prototype, method)) {
        prototype = Object.getPrototypeOf(prototype) as typeof prototype;
      }
      if (!prototype) throw new Error(`FileHandle.${method} is unavailable`);
      await probe.close();
      const original = prototype[method]!;
      const failure = vi.spyOn(prototype, method).mockImplementationOnce(async function (
        this: unknown,
        ...args: never[]
      ) {
        throw new Error(`forced ${method} failure`);
      });
      try {
        await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).rejects.toThrow(
          "MINECRAFT_COMPONENT_OPERATION_FAILED",
        );
        await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        failure.mockRestore();
        await fixture.cleanup();
      }
    },
  );

  it("preserves a foreign replacement when staging write cleanup detects identity drift", async () => {
    const foreign = Buffer.from("foreign staging replacement");
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const handle = await actual.open(...args);
          const path = String(args[0]);
          if (path.endsWith(".whitelily-installing")) {
            handle.writeFile = async () => {
              await actual.rename(path, `${path}.moved-owned`);
              await actual.writeFile(path, foreign, { flag: "wx" });
              throw new Error("forced write replacement");
            };
          }
          return handle;
        },
      };
    });
    const { createMinecraftComponentManager: createReplacingManager } =
      await import("./minecraftComponents.js");
    const fixture = await createFixture({ managerFactory: createReplacingManager });
    const temporaryPath = join(fixture.mods, `${BRIDGE_FILE}.whitelily-installing`);
    try {
      await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).rejects.toThrow(
        "MINECRAFT_COMPONENT_OPERATION_FAILED",
      );
      expect(await readFile(temporaryPath)).toEqual(foreign);
      expect((await lstat(`${temporaryPath}.moved-owned`)).size).toBe(0);
    } finally {
      await fixture.cleanup();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("cleans its exact partial staging file when FileHandle.close fails", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const handle = await actual.open(...args);
          const close = handle.close.bind(handle);
          let failed = false;
          handle.close = async () => {
            await close();
            if (!failed) {
              failed = true;
              throw new Error("forced close failure");
            }
          };
          return handle;
        },
      };
    });
    const { createMinecraftComponentManager: createCloseFailingManager } =
      await import("./minecraftComponents.js");
    const fixture = await createFixture({ managerFactory: createCloseFailingManager });
    const temporaryPath = join(fixture.mods, `${BRIDGE_FILE}.whitelily-installing`);
    try {
      await expect(fixture.manager.install(fixture.candidateId, ["bridge"])).rejects.toThrow(
        "MINECRAFT_COMPONENT_OPERATION_FAILED",
      );
      await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fixture.cleanup();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
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

  it.each(malformedJarCases())(
    "rejects malformed packaged ZIP metadata: %s",
    async (_label, bridgeBytes) => {
      const fixture = await createFixture({ bridgeBytes, stubWorldBindingAuthority: true });
      try {
        await expect(fixture.manager.status(fixture.candidateId)).rejects.toThrow(
          "MINECRAFT_COMPONENT_MANIFEST_INVALID",
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("rejects main-supplied manifest hash and embedded mod-ID mismatches", async () => {
    const badHash = await createFixture({
      manifestPatch: (manifest) => ({
        ...manifest,
        artifacts: [
          { ...manifest.artifacts[0]!, sha256: "0".repeat(64) },
          ...manifest.artifacts.slice(1),
        ],
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
          ...manifest.artifacts.slice(1),
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
              ...manifest.artifacts.slice(1),
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

function dataDescriptorJar(modId: string, version: string): Buffer {
  return zipWithSignedDataDescriptors([
    [
      "fabric.mod.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id: modId,
          version,
          environment: "client",
        }),
        "utf8",
      ),
    ],
  ]);
}

function zipWithSignedDataDescriptors(entries: readonly (readonly [string, Buffer])[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const encodedName = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(bytes);
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(encodedName.byteLength, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed.byteLength, 8);
    descriptor.writeUInt32LE(bytes.byteLength, 12);
    locals.push(local, encodedName, compressed, descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0808, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(bytes.byteLength, 24);
    central.writeUInt16LE(encodedName.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, encodedName);
    offset +=
      local.byteLength + encodedName.byteLength + compressed.byteLength + descriptor.byteLength;
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

function malformedJarCases(): readonly (readonly [string, Buffer])[] {
  const valid = jar("whitelily_bridge", "0.1.0");
  const endOffset = valid.byteLength - 22;
  const centralOffset = valid.readUInt32LE(endOffset + 16);
  const mutate = (change: (bytes: Buffer) => void): Buffer => {
    const bytes = Buffer.from(valid);
    change(bytes);
    return bytes;
  };
  const metadata = Buffer.from(
    JSON.stringify({ id: "whitelily_bridge", version: "0.1.0" }),
    "utf8",
  );
  return [
    [
      "central directory offset outside the archive",
      mutate((bytes) => bytes.writeUInt32LE(0xffffffff, endOffset + 16)),
    ],
    [
      "local header offset outside the archive",
      mutate((bytes) => bytes.writeUInt32LE(0xffffffff, centralOffset + 42)),
    ],
    [
      "central/local entry-name mismatch",
      mutate((bytes) => bytes.writeUInt8("x".charCodeAt(0), 30)),
    ],
    [
      "duplicate fabric.mod.json",
      zip([
        ["fabric.mod.json", metadata],
        ["fabric.mod.json", metadata],
      ]),
    ],
    [
      "duplicate decoded JSON object keys",
      zip([
        [
          "fabric.mod.json",
          Buffer.from('{"id":"foreign","\\u0069d":"whitelily_bridge","version":"0.1.0"}', "utf8"),
        ],
      ]),
    ],
    ["central CRC mismatch", mutate((bytes) => bytes.writeUInt32LE(0, centralOffset + 16))],
    [
      "entry count beyond the bound",
      mutate((bytes) => {
        bytes.writeUInt16LE(4_097, endOffset + 8);
        bytes.writeUInt16LE(4_097, endOffset + 10);
      }),
    ],
    ["invalid UTF-8 entry name", mutate((bytes) => bytes.writeUInt8(0xff, centralOffset + 46))],
    [
      "encrypted entry flag",
      mutate((bytes) => {
        bytes.writeUInt16LE(1, 6);
        bytes.writeUInt16LE(1, centralOffset + 8);
      }),
    ],
    [
      "data-descriptor entry flag",
      mutate((bytes) => {
        bytes.writeUInt16LE(8, 6);
        bytes.writeUInt16LE(8, centralOffset + 8);
      }),
    ],
    ["central/local size mismatch", mutate((bytes) => bytes.writeUInt32LE(1, 18))],
    ["deflate expansion beyond the metadata bound", overExpandingMetadataJar()],
  ];
}

function overExpandingMetadataJar(): Buffer {
  const name = Buffer.from("fabric.mod.json", "utf8");
  const expanded = Buffer.alloc(64 * 1024 + 1, 0x61);
  const compressed = deflateRawSync(expanded);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(expanded), 14);
  local.writeUInt32LE(compressed.byteLength, 18);
  local.writeUInt32LE(64 * 1024, 22);
  local.writeUInt16LE(name.byteLength, 26);
  const centralOffset = local.byteLength + name.byteLength + compressed.byteLength;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(expanded), 16);
  central.writeUInt32LE(compressed.byteLength, 20);
  central.writeUInt32LE(64 * 1024, 24);
  central.writeUInt16LE(name.byteLength, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.byteLength + name.byteLength, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
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
