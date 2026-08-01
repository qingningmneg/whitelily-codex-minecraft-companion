import { z } from "zod";
import type { ConfirmedWorldBinding } from "../world/worldProfileStore.js";
import { DESKTOP_PROTOCOL_VERSION } from "./desktopProtocol.js";

const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const boundedString = (limit: number) =>
  z
    .string()
    .refine((value) => value === value.toWellFormed())
    .refine((value) => Array.from(value).length <= limit);

const confirmedWorldBindingSchema = z
  .object({
    canonicalInstancePath: boundedString(32_768).refine((value) => value.length > 0),
    javaSession: z
      .object({
        pid: z.number().int().positive().safe(),
        processStartedAt: z.number().int().positive().safe(),
        port: z.number().int().min(1).max(65_535),
        version: boundedString(64).refine((value) => value.length > 0),
      })
      .strict(),
    ownerUsername: z.string().regex(/^[A-Za-z0-9_]{1,16}$/u),
    proof: z
      .object({
        nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/u),
        port: z.number().int().min(1).max(65_535),
        issuedAt: z.number().int().safe().nonnegative(),
        expiresAt: z.number().int().safe().nonnegative(),
      })
      .strict(),
  })
  .strict();

const privateChildRequestSchema = z
  .object({
    version: z.literal(DESKTOP_PROTOCOL_VERSION),
    id: requestIdSchema,
    privateCommand: z
      .object({
        kind: z.literal("bind_confirmed_world"),
        expectedRevision: z.number().int().safe().nonnegative(),
        label: boundedString(160).refine((value) => value.trim().length > 0),
        binding: confirmedWorldBindingSchema,
      })
      .strict(),
  })
  .strict();

export interface PrivateWorldBindRequest {
  version: typeof DESKTOP_PROTOCOL_VERSION;
  id: string;
  privateCommand: {
    kind: "bind_confirmed_world";
    expectedRevision: number;
    label: string;
    binding: ConfirmedWorldBinding;
  };
}

/**
 * Parent-only transport schema. It is intentionally not part of DesktopCommand
 * or parseDesktopRequest, which are renderer-adjacent public protocol surfaces.
 */
export function parsePrivateChildRequest(value: unknown): PrivateWorldBindRequest {
  const parsed = privateChildRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid private child request");
  return parsed.data as PrivateWorldBindRequest;
}
