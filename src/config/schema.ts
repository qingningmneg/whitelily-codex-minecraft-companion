import { z } from "zod";

export const appConfigSchema = z
  .object({
    minecraft: z
      .object({
        host: z.literal("127.0.0.1", {
          error: "minecraft.host must be 127.0.0.1",
        }),
        port: z.number().int().min(1).max(65535),
        bot_username: z.literal("WhiteLily"),
        owner_username: z
          .string()
          .regex(/^[A-Za-z0-9_]{3,16}$/, "owner username must match Minecraft Java rules"),
      })
      .strict(),
    codex: z
      .object({
        preferred_model: z.string().min(1),
        reasoning_effort: z.enum(["low", "medium"]),
        allow_api_key_fallback: z.literal(false),
      })
      .strict(),
    companion: z
      .object({
        start_mode: z.literal("friend"),
        persona_name: z.literal("白百合"),
      })
      .strict(),
    safety: z
      .object({
        spawn_protection_radius: z.literal(16),
        break_confirmation_threshold: z.literal(32),
        place_confirmation_threshold: z.literal(128),
        travel_confirmation_distance: z.literal(256),
      })
      .strict(),
  })
  .strict();

export type RawAppConfig = z.infer<typeof appConfigSchema>;

export interface AppConfig {
  minecraft: {
    host: "127.0.0.1";
    port: number;
    botUsername: "WhiteLily";
    ownerUsername: string;
  };
  codex: {
    preferredModel: string;
    reasoningEffort: "low" | "medium";
    allowApiKeyFallback: false;
  };
  companion: {
    startMode: "friend";
    personaName: "白百合";
  };
  safety: {
    spawnProtectionRadius: 16;
    breakConfirmationThreshold: 32;
    placeConfirmationThreshold: 128;
    travelConfirmationDistance: 256;
  };
}
