import { z } from "zod";
import { redactPublicText } from "./redaction.js";
import type { ScopedMemoryExport } from "./scopedMemoryStore.js";

const redactedTextSchema = z.string().min(1).max(160);
const timestampSchema = z.string().datetime({ offset: false });
const categorySchema = z.enum(["preference", "place", "project", "promise", "experience"]);
const importanceSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
const commonRecord = {
  id: z.number().int().positive().safe(),
  category: categorySchema,
  summary: redactedTextSchema,
  importance: importanceSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  source: z.enum(["manual", "automatic"]),
  pinned: z.boolean(),
  revision: z.number().int().nonnegative().safe(),
};
const redactedMemoryRecordSchema = z.discriminatedUnion("scope", [
  z.object({ ...commonRecord, scope: z.literal("global") }).strict(),
  z.object({ ...commonRecord, scope: z.literal("world") }).strict(),
]);

export const redactedMemoryExportSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative().safe(),
    updatedAt: timestampSchema,
    records: z.array(redactedMemoryRecordSchema),
    legacyMigrated: z.boolean(),
  })
  .strict();

export type RedactedMemoryExport = z.infer<typeof redactedMemoryExportSchema>;

const rawChatOrReasoning =
  /^\s*(?:(?:player|user|assistant|玩家|用户|白百合|模型)\s*(?:said|says|说)?\s*[:：]|(?:模型|model)\s*(?:推理|思考|reasoning|analysis)\s*[:：])/iu;

export function createRedactedMemoryExport(source: ScopedMemoryExport): RedactedMemoryExport {
  const candidate = {
    schemaVersion: 1 as const,
    revision: source.revision,
    updatedAt: source.updatedAt,
    legacyMigrated: source.legacyMigrated,
    records: source.records.map((record) => {
      const summary = rawChatOrReasoning.test(record.summary)
        ? "[REDACTED_MEMORY]"
        : redactPublicText(record.summary);
      return {
        id: record.id,
        category: record.category,
        summary,
        importance: record.importance,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        scope: record.scope,
        source: record.source,
        pinned: record.pinned,
        revision: record.revision,
      };
    }),
  };
  return redactedMemoryExportSchema.parse(candidate);
}

export function parseRedactedMemoryExport(value: unknown): RedactedMemoryExport {
  return redactedMemoryExportSchema.parse(value);
}
