import { z } from "zod";

const isoUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const isoUtcTimestampSchema = z.string().refine(
  (value) => {
    if (!isoUtcPattern.test(value)) return false;
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  },
  { message: "updatedAt must be a canonical ISO-8601 UTC timestamp" },
);

export function createDocumentEnvelopeSchema<T>(schemaVersion: number, valueSchema: z.ZodType<T>) {
  return z
    .object({
      schemaVersion: z.literal(schemaVersion),
      revision: z
        .number()
        .nonnegative()
        .refine(Number.isSafeInteger, "revision must be a non-negative safe integer"),
      updatedAt: isoUtcTimestampSchema,
      value: valueSchema,
    })
    .strict();
}
