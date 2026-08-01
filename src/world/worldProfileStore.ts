import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AtomicJsonFileIo } from "../storage/atomicJsonFile.js";
import { DocumentStore, type DocumentEnvelope } from "../storage/documentStore.js";
import {
  safetyPresetSchema,
  worldProfileSchema,
  type SafetyPreset,
  type WorldProfile,
} from "./worldProfileSchema.js";

const WORLD_PROFILE_SCHEMA_VERSION = 1;
const ACTIVE_WORLD_PROFILE_FILENAME = "active-world-profile.json";

const javaSessionSchema = z
  .object({
    pid: z.number().int().positive().safe(),
    processStartedAt: z.number().int().positive().safe(),
    port: z.number().int().min(1).max(65_535),
    version: z.string().min(1).max(64),
  })
  .strict();

const confirmedProofSchema = z
  .object({
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/u),
    port: z.number().int().min(1).max(65_535),
    issuedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().nonnegative().safe(),
  })
  .strict();

export { safetyPresetSchema, worldProfileSchema } from "./worldProfileSchema.js";
export type { SafetyPreset, WorldProfile } from "./worldProfileSchema.js";
export type JavaLanSession = z.infer<typeof javaSessionSchema>;
export type ConfirmedLanProof = z.infer<typeof confirmedProofSchema>;

/** This input is constructed in the main process; it is never protocol input. */
export interface ConfirmedWorldBinding {
  readonly canonicalInstancePath: string;
  readonly javaSession: JavaLanSession;
  readonly ownerUsername: string;
  readonly proof: ConfirmedLanProof;
}

export interface WorldProfileStoreOptions {
  rootDirectory: string;
  now?: () => number;
  createId?: () => string;
  /**
   * Main-process authority check.  Omit it only in isolated persistence tests;
   * protocol composition always supplies this from retained LAN discovery state.
   */
  isCurrentLanProof: (proof: ConfirmedLanProof) => boolean | Promise<boolean>;
  clock?: () => Date;
  fileIo?: AtomicJsonFileIo;
}

export function fingerprintConfirmedWorld(
  canonicalInstancePath: string,
  session: JavaLanSession,
): string {
  const checkedPath = z.string().min(1).max(32_768).parse(canonicalInstancePath);
  const checkedSession = javaSessionSchema.parse(session);
  return createHash("sha256")
    .update(
      `${checkedPath}\u0000${checkedSession.pid}\u0000${checkedSession.processStartedAt}\u0000${checkedSession.port}\u0000${checkedSession.version}`,
      "utf8",
    )
    .digest("base64url");
}

export class WorldProfileStore {
  readonly #documents: DocumentStore<WorldProfile | null>;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #isCurrentLanProof: (proof: ConfirmedLanProof) => boolean | Promise<boolean>;

  constructor(options: WorldProfileStoreOptions) {
    const rootDirectory = resolve(options.rootDirectory);
    this.#documents = new DocumentStore({
      path: join(rootDirectory, ACTIVE_WORLD_PROFILE_FILENAME),
      rootDirectory,
      schemaVersion: WORLD_PROFILE_SCHEMA_VERSION,
      valueSchema: worldProfileSchema.nullable(),
      defaultValue: () => null,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
    });
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#isCurrentLanProof = options.isCurrentLanProof;
  }

  read(): Promise<DocumentEnvelope<WorldProfile | null>> {
    return this.#documents.read();
  }

  async bindConfirmedWorld(
    expectedRevision: number,
    binding: ConfirmedWorldBinding,
    label = "Minecraft world",
  ): Promise<DocumentEnvelope<WorldProfile>> {
    const profile = await this.#createBoundProfile(binding, label);
    const envelope = await this.#documents.replace(expectedRevision, profile);
    return { ...envelope, value: profile };
  }

  async updateSafetyProfile(
    expectedRevision: number,
    safetyPreset: SafetyPreset,
  ): Promise<DocumentEnvelope<WorldProfile>> {
    const preset = safetyPresetSchema.parse(safetyPreset);
    const envelope = await this.#documents.update(expectedRevision, (current) => {
      if (!current) throw new Error("world profile is not bound");
      return { ...current, safetyPreset: preset };
    });
    if (!envelope.value) throw new Error("world profile is not bound");
    return { ...envelope, value: envelope.value };
  }

  async authorize(instanceFingerprint: string): Promise<boolean> {
    const candidateFingerprint = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/u)
      .safeParse(instanceFingerprint);
    if (!candidateFingerprint.success) return false;
    const profile = (await this.read()).value;
    return profile !== null && profile.instanceFingerprint === candidateFingerprint.data;
  }

  async #createBoundProfile(binding: ConfirmedWorldBinding, label: string): Promise<WorldProfile> {
    const checked = z
      .object({
        canonicalInstancePath: z.string().min(1).max(32_768),
        javaSession: javaSessionSchema,
        ownerUsername: z
          .string()
          .min(1)
          .max(16)
          .regex(/^[A-Za-z0-9_]+$/u),
        proof: confirmedProofSchema,
      })
      .strict()
      .parse(binding);
    const now = this.#now();
    if (
      !Number.isSafeInteger(now) ||
      now < checked.proof.issuedAt ||
      now >= checked.proof.expiresAt ||
      checked.proof.port !== checked.javaSession.port ||
      !(await this.#isCurrentLanProof(checked.proof))
    ) {
      throw new Error("a current confirmed LAN proof is required to bind a world");
    }
    return worldProfileSchema.parse({
      id: this.#createId(),
      label: z.string().min(1).max(160).parse(label),
      instanceFingerprint: fingerprintConfirmedWorld(
        checked.canonicalInstancePath,
        checked.javaSession,
      ),
      ownerUsername: checked.ownerUsername,
      safetyPreset: "conservative",
    });
  }
}
