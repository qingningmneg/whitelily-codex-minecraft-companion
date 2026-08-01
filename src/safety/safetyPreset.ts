import { z } from "zod";

export const safetyPresetSchema = z.enum(["conservative", "standard"]);
export type SafetyPreset = z.infer<typeof safetyPresetSchema>;
