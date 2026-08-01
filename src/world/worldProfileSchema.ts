import { z } from "zod";
import { safetyPresetSchema } from "../safety/safetyPreset.js";

export { safetyPresetSchema } from "../safety/safetyPreset.js";
export type { SafetyPreset } from "../safety/safetyPreset.js";

export const worldProfileSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().min(1).max(160),
    instanceFingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    ownerUsername: z
      .string()
      .min(1)
      .max(16)
      .regex(/^[A-Za-z0-9_]+$/u),
    safetyPreset: safetyPresetSchema,
  })
  .strict();

export type WorldProfile = z.infer<typeof worldProfileSchema>;
