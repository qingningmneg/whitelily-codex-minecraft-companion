import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import {
  appConfigSchema,
  type AppConfig,
  type AppPaths,
  type ConfirmedRuntimeConnection,
} from "./schema.js";

export interface ResolveCoreAppPathsOptions {
  cwd: string;
  dataRoot?: string;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const child = relative(root, candidate);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${label} must stay within the WhiteLily data root`);
  }
}

export function resolveCoreAppPaths(
  configPath: string,
  options: ResolveCoreAppPathsOptions,
): AppPaths {
  if (options.dataRoot !== undefined && !isAbsolute(options.dataRoot)) {
    throw new Error("WhiteLily data root must be absolute");
  }
  const legacyCwd = resolve(options.cwd);
  const dataRoot = resolve(options.dataRoot ?? legacyCwd);
  const config = resolve(configPath);
  if (options.dataRoot !== undefined) assertWithin(dataRoot, config, "config");

  const dataDirectory = join(dataRoot, "data");
  const configDirectory = join(dataRoot, "config");
  const logs = join(dataRoot, "logs");
  const paths: AppPaths = {
    cwd: options.dataRoot === undefined ? legacyCwd : dataRoot,
    dataRoot,
    config,
    profiles: join(configDirectory, "profiles"),
    memories: join(dataDirectory, "memories.json"),
    worlds: join(configDirectory, "worlds"),
    logs,
    audit: join(logs, "audit.jsonl"),
    diagnostics: join(dataRoot, "diagnostics"),
    migrationSnapshots: join(dataDirectory, "migration-snapshots"),
    runtimeState: join(dataDirectory, "state.json"),
    codexWorkspace: join(dataRoot, "codex-workspace"),
    state: join(dataDirectory, "state.json"),
    log: join(logs, "companion.log"),
  };
  for (const [label, path] of Object.entries(paths)) {
    if (
      label === "cwd" ||
      label === "dataRoot" ||
      (label === "config" && options.dataRoot === undefined)
    ) {
      continue;
    }
    assertWithin(dataRoot, path, label);
  }
  return paths;
}

export async function loadConfig(
  path: string,
  confirmedConnection?: ConfirmedRuntimeConnection,
): Promise<AppConfig> {
  const raw = appConfigSchema.parse(parse(await readFile(path, "utf8")));
  const minecraft = confirmedConnection
    ? validateConfirmedRuntimeConnection(confirmedConnection)
    : { host: raw.minecraft.host, port: raw.minecraft.port };

  return {
    minecraft: {
      host: minecraft.host,
      port: minecraft.port,
      botUsername: raw.minecraft.bot_username,
      ownerUsername: raw.minecraft.owner_username,
    },
    codex: {
      preferredModel: raw.codex.preferred_model,
      reasoningEffort: raw.codex.reasoning_effort,
      allowApiKeyFallback: raw.codex.allow_api_key_fallback,
    },
    companion: {
      startMode: raw.companion.start_mode,
      personaName: raw.companion.persona_name,
    },
    safety: {
      spawnProtectionRadius: raw.safety.spawn_protection_radius,
      breakConfirmationThreshold: raw.safety.break_confirmation_threshold,
      placeConfirmationThreshold: raw.safety.place_confirmation_threshold,
      travelConfirmationDistance: raw.safety.travel_confirmation_distance,
    },
  };
}

function validateConfirmedRuntimeConnection(
  connection: ConfirmedRuntimeConnection,
): ConfirmedRuntimeConnection {
  if (
    connection.host !== "127.0.0.1" ||
    !Number.isSafeInteger(connection.port) ||
    connection.port < 1 ||
    connection.port > 65_535
  ) {
    throw new Error("invalid confirmed Minecraft connection");
  }
  return Object.freeze({ host: "127.0.0.1", port: connection.port });
}
