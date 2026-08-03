import type { Readable, Writable } from "node:stream";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntimeFacade } from "../app.js";
import { AccountService } from "../codex/accountService.js";
import { CodexAppServerClient } from "../codex/appServerClient.js";
import { ModelCatalog } from "../codex/modelCatalog.js";
import { ModelPreferenceStore } from "../codex/modelPreferenceStore.js";
import type { ResolvedModelSelection } from "../codex/modelCatalog.js";
import type { RuntimeFacade } from "../runtime/runtimeFacade.js";
import type { ConfirmedRuntimeConnection } from "../config/schema.js";
import { loadConfig, resolveCoreAppPaths } from "../config/loadConfig.js";
import { arch, platform, release } from "node:os";
import { DiagnosticExporter } from "../diagnostics/diagnosticExporter.js";
import { ProfileStore } from "../profile/profileStore.js";
import { MemoryMigration } from "../memory/memoryMigration.js";
import { MemoryStore } from "../memory/memoryStore.js";
import { ScopedMemoryStore } from "../memory/scopedMemoryStore.js";
import { WorldProfileStore, type ConfirmedWorldBinding } from "../world/worldProfileStore.js";
import type { RuntimeSafetyConfiguration } from "../safety/safetyProfile.js";
import type { OwnerIdentityAccess } from "../identity/ownerIdentity.js";
import { OwnerIdentityService } from "../identity/ownerIdentityService.js";
import {
  DesktopChildServer,
  type DesktopChildAccountService,
  type DesktopChildModelCatalog,
  type DesktopChildProfileStore,
  type DesktopChildRuntime,
} from "./childServer.js";

export interface DesktopChildServices {
  ownerIdentity: OwnerIdentityAccess;
  account: DesktopChildAccountService;
  models: DesktopChildModelCatalog;
  profiles?: DesktopChildProfileStore;
  worldProfiles?: import("./childServer.js").DesktopChildWorldProfileStore;
  getConfirmedWorldBinding?: () => Promise<ConfirmedWorldBinding>;
  activatePrivateWorldBinding?: (
    binding: ConfirmedWorldBinding,
  ) => Promise<() => void> | (() => void);
  memories?: import("./childServer.js").DesktopChildMemoryStore;
  memoryMigration?: Pick<MemoryMigration, "preview" | "commit" | "rollback" | "release">;
  diagnostics?: import("./childServer.js").DesktopChildDiagnostics;
  createRuntime(
    connection: ConfirmedRuntimeConnection,
    initialRevision: number,
    selection: ResolvedModelSelection,
    worldSafety: RuntimeSafetyConfiguration,
  ): Promise<DesktopChildRuntime>;
}

export interface DesktopChildServiceContext {
  configPath: string;
  cwd: string;
  dataRoot?: string;
}

export interface DesktopChildMainDependencies {
  input?: Readable;
  output?: Writable;
  writeStderr?: (message: string) => void;
  createRuntime?: (
    configPath: string,
    connection: ConfirmedRuntimeConnection,
    initialRevision: number,
    selection: ResolvedModelSelection,
    ownerIdentity: OwnerIdentityAccess,
  ) => Promise<RuntimeFacade>;
  createServices?: (
    context: DesktopChildServiceContext,
  ) => DesktopChildServices | Promise<DesktopChildServices>;
  cwd?: string;
}

export async function runDesktopChild(
  args: readonly string[],
  dependencies: DesktopChildMainDependencies = {},
): Promise<void> {
  const input = dependencies.input ?? process.stdin;
  const firstInput = await waitForInput(input);
  if (firstInput === "end") return;

  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const configPath = resolve(cwd, args[0] ?? "config.toml");
  let services: DesktopChildServices;
  let runtimeRevisionSeed: number;
  try {
    runtimeRevisionSeed = parseRuntimeRevisionSeed(args[1]);
    const dataRoot =
      process.env.WHITELILY_DATA_ROOT === undefined
        ? undefined
        : resolveCoreAppPaths(configPath, {
            cwd,
            dataRoot: process.env.WHITELILY_DATA_ROOT,
          }).dataRoot;
    if (dataRoot !== undefined && relative(dataRoot, cwd) !== "") {
      throw new Error("WhiteLily desktop child working directory must match its data root");
    }
    services = await (
      dependencies.createServices ??
      ((context: DesktopChildServiceContext) =>
        createDefaultDesktopChildServices(context, dependencies.createRuntime))
    )({
      configPath,
      cwd,
      ...(dataRoot === undefined ? {} : { dataRoot }),
    });
  } catch {
    (dependencies.writeStderr ?? ((message) => process.stderr.write(`${message}\n`)))(
      "WhiteLily desktop child failed to initialize",
    );
    process.exitCode = 1;
    return;
  }

  const server = new DesktopChildServer({
    ownerIdentity: services.ownerIdentity,
    createRuntime: services.createRuntime,
    account: services.account,
    models: services.models,
    ...(services.profiles === undefined ? {} : { profiles: services.profiles }),
    ...(services.worldProfiles === undefined ? {} : { worldProfiles: services.worldProfiles }),
    ...(services.getConfirmedWorldBinding === undefined
      ? {}
      : { getConfirmedWorldBinding: services.getConfirmedWorldBinding }),
    ...(services.activatePrivateWorldBinding === undefined
      ? {}
      : { activatePrivateWorldBinding: services.activatePrivateWorldBinding }),
    ...(services.memories === undefined ? {} : { memories: services.memories }),
    ...(services.memoryMigration === undefined
      ? {}
      : { memoryMigration: services.memoryMigration }),
    ...(services.diagnostics === undefined ? {} : { diagnostics: services.diagnostics }),
    input,
    output: dependencies.output ?? process.stdout,
    runtimeRevisionSeed,
  });
  server.start();
  input.resume();
  await waitForEnd(input);
  await server.stop();
}

function parseRuntimeRevisionSeed(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Runtime revision seed is invalid");
  }
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error("Runtime revision seed is invalid");
  }
  return seed;
}

async function createDefaultDesktopChildServices(
  context: DesktopChildServiceContext,
  injectedRuntimeFactory?: (
    configPath: string,
    connection: ConfirmedRuntimeConnection,
    initialRevision: number,
    selection: ResolvedModelSelection,
    ownerIdentity: OwnerIdentityAccess,
  ) => Promise<RuntimeFacade>,
): Promise<DesktopChildServices> {
  const paths = resolveCoreAppPaths(context.configPath, {
    cwd: context.cwd,
    ...(context.dataRoot === undefined ? {} : { dataRoot: context.dataRoot }),
  });
  const legacyConfig = await loadConfig(context.configPath);
  const modelPreferenceStore = new ModelPreferenceStore({ rootDirectory: dirname(paths.config) });
  const legacyConfigCandidate = {
    mode: "explicit" as const,
    modelId: legacyConfig.codex.preferredModel,
    reasoningEffort: legacyConfig.codex.reasoningEffort,
  };
  const client = new CodexAppServerClient(undefined, {
    workspacePath: resolve(context.cwd, "codex-workspace"),
  });
  const account = new AccountService(client);
  const models = new ModelCatalog(client, account, {
    store: modelPreferenceStore,
    legacyConfigCandidate,
  });
  const profiles = new ProfileStore({ rootDirectory: paths.profiles });
  const ownerIdentity = await OwnerIdentityService.open(paths.config);
  let activePrivateWorldProof: string | undefined;
  const worldProfiles = new WorldProfileStore({
    rootDirectory: paths.worlds,
    // The store may validate only a proof actively scoped to one parsed private
    // parent operation; it never trusts a public protocol line on its own.
    isCurrentLanProof: (proof) => activePrivateWorldProof === proof.nonce,
  });
  const memories = new ScopedMemoryStore(`${paths.memories}.scoped.json`);
  await new MemoryMigration(undefined, memories, {
    legacy: new MemoryStore(paths.memories),
  }).migrateLegacyOnce();
  const memoryMigration = new MemoryMigration(memories, memories);
  const diagnostics = new DiagnosticExporter({
    dataRoot: paths.dataRoot,
    appVersion: "0.2.0-beta.1",
    osSummary: { platform: platform(), release: release(), arch: arch() },
    dependencyVersions: {
      node: process.versions.node,
      codex: "0.145.0",
      mineflayer: "4.37.1",
    },
    compatibilityManifest: {
      minecraftJava: ["1.21.5"],
      supportLevel: "public-beta",
    },
    configSchemaSummary: {
      schemaVersion: 1,
      sections: ["minecraft", "codex", "companion", "safety"],
      valuesIncluded: false,
      secretsIncluded: false,
    },
  });
  return {
    ownerIdentity,
    account,
    models,
    profiles,
    worldProfiles,
    activatePrivateWorldBinding: (binding) => {
      if (activePrivateWorldProof !== undefined) {
        throw new Error("private world binding operation is already active");
      }
      activePrivateWorldProof = binding.proof.nonce;
      return () => {
        activePrivateWorldProof = undefined;
      };
    },
    memories,
    memoryMigration,
    diagnostics,
    createRuntime:
      injectedRuntimeFactory === undefined
        ? (connection, initialRevision, selection, worldSafety) =>
            createRuntimeFacade(context.configPath, {
              cwd: context.cwd,
              ...(context.dataRoot === undefined ? {} : { dataRoot: context.dataRoot }),
              codexClient: client,
              confirmedMinecraftConnection: connection,
              runtimeInitialRevision: initialRevision,
              runtimeModelSelection: selection,
              worldSafety,
              ownerIdentity,
            })
        : (connection, initialRevision, selection) =>
            injectedRuntimeFactory(
              context.configPath,
              connection,
              initialRevision,
              selection,
              ownerIdentity,
            ),
  };
}

function waitForInput(input: Readable): Promise<"data" | "end"> {
  if (input.readableEnded) return Promise.resolve("end");
  if (input.readableLength > 0) return Promise.resolve("data");
  return new Promise((resolve) => {
    const cleanup = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
    };
    const onData = (chunk: Buffer | string): void => {
      input.pause();
      input.unshift(chunk);
      cleanup();
      resolve("data");
    };
    const onEnd = (): void => {
      cleanup();
      resolve("end");
    };
    input.once("data", onData);
    input.once("end", onEnd);
    input.once("error", onEnd);
    input.resume();
  });
}

function waitForEnd(input: Readable): Promise<void> {
  if (input.readableEnded || input.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const cleanup = (): void => {
      input.off("end", onEnd);
      input.off("error", onEnd);
      input.off("close", onEnd);
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    input.once("end", onEnd);
    input.once("error", onEnd);
    input.once("close", onEnd);
  });
}

function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && metaUrl === pathToFileURL(resolve(argv1)).href;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await runDesktopChild(process.argv.slice(2));
}
