import { stringify } from "smol-toml";

export const DEFAULT_CONFIG_TOML = `${stringify({
  minecraft: {
    host: "127.0.0.1",
    port: 25565,
    bot_username: "WhiteLily",
    owner_username: "YourMcName",
  },
  codex: {
    preferred_model: "gpt-5.6-terra",
    reasoning_effort: "low",
    allow_api_key_fallback: false,
  },
  companion: { start_mode: "friend", persona_name: "\u767d\u767e\u5408" },
  safety: {
    spawn_protection_radius: 16,
    break_confirmation_threshold: 32,
    place_confirmation_threshold: 128,
    travel_confirmation_distance: 256,
  },
}).trimEnd()}\n`;
