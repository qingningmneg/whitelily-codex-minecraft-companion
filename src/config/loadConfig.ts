import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { appConfigSchema, type AppConfig } from "./schema.js";

export async function loadConfig(path: string): Promise<AppConfig> {
  const raw = appConfigSchema.parse(parse(await readFile(path, "utf8")));

  return {
    minecraft: {
      host: raw.minecraft.host,
      port: raw.minecraft.port,
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
