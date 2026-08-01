import { z } from "zod";
import type { CompanionMode } from "../domain/types.js";

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REASONING_EFFORT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

function boundedWellFormedString(
  maximumCodePoints: number,
  options: { readonly allowEmpty?: boolean } = {},
) {
  return z
    .string()
    .refine((value) => value === value.toWellFormed(), "value must be well-formed Unicode")
    .transform((value) => value.trim())
    .refine((value) => options.allowEmpty === true || value.length > 0, "value must not be empty")
    .refine(
      (value) => Array.from(value).length <= maximumCodePoints,
      `value must contain at most ${maximumCodePoints} code points`,
    );
}

const topicSchema = boundedWellFormedString(80);

const topicListSchema = z
  .array(topicSchema)
  .max(32)
  .transform((topics) => {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const topic of topics) {
      const key = topic.normalize("NFKC").toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(topic);
    }
    return normalized;
  });

export const companionModeSchema = z.enum(["friend", "balanced", "autonomous"]);

export const behaviorModeSettingsSchema = z
  .object({
    idleMinutes: z.number().int().min(1).max(120),
    allowProactiveChat: z.boolean(),
    allowSuggestions: z.boolean(),
    allowLowRiskMicroActions: z.boolean(),
  })
  .strict();

export const modelPreferenceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic") }).strict(),
  z
    .object({
      mode: z.literal("explicit"),
      modelId: z.string().regex(MODEL_ID_PATTERN),
      reasoningEffort: z.string().regex(REASONING_EFFORT_PATTERN),
    })
    .strict(),
]);

export const companionProfileSchema = z
  .object({
    id: z.string().uuid(),
    displayName: boundedWellFormedString(16),
    language: z.enum(["zh-CN", "en"]),
    tone: boundedWellFormedString(160),
    preferredTopics: topicListSchema,
    avoidedTopics: topicListSchema,
    persona: boundedWellFormedString(4_000, { allowEmpty: true }),
    mode: companionModeSchema,
    modeSettings: z
      .object({
        friend: behaviorModeSettingsSchema,
        balanced: behaviorModeSettingsSchema,
        autonomous: behaviorModeSettingsSchema,
      })
      .strict(),
    modelPreference: modelPreferenceSchema,
  })
  .strict();

export type BehaviorModeSettings = z.infer<typeof behaviorModeSettingsSchema>;
export type CompanionProfile = z.infer<typeof companionProfileSchema>;
export type ModelPreference = z.infer<typeof modelPreferenceSchema>;

export function createDefaultCompanionProfile(id: string): CompanionProfile {
  return companionProfileSchema.parse({
    id,
    displayName: "白百合",
    language: "zh-CN",
    tone: "温和、真诚、简洁",
    preferredTopics: [],
    avoidedTopics: [],
    persona: "",
    mode: "friend",
    modeSettings: {
      friend: {
        idleMinutes: 120,
        allowProactiveChat: false,
        allowSuggestions: false,
        allowLowRiskMicroActions: false,
      },
      balanced: {
        idleMinutes: 2,
        allowProactiveChat: true,
        allowSuggestions: true,
        allowLowRiskMicroActions: false,
      },
      autonomous: {
        idleMinutes: 1,
        allowProactiveChat: true,
        allowSuggestions: true,
        allowLowRiskMicroActions: true,
      },
    },
    modelPreference: { mode: "automatic" },
  } satisfies Record<string, unknown>);
}

export function withBehaviorMode(
  profile: CompanionProfile,
  mode: CompanionMode,
  settings: BehaviorModeSettings,
): CompanionProfile {
  return companionProfileSchema.parse({
    ...profile,
    mode,
    modeSettings: {
      ...profile.modeSettings,
      [mode]: settings,
    },
  });
}
