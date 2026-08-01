import { randomBytes } from "node:crypto";

export const LAN_CANDIDATE_TTL_MS = 60_000;
export const MAX_LAN_CANDIDATES = 32;

export interface LanObservation {
  readonly port: number;
  readonly pid: number;
  readonly processStartedAt: number;
  readonly version: string;
}

export interface LanCandidate {
  readonly id: string;
  readonly port: number;
  readonly version: string;
  readonly observedAt: number;
  readonly expiresAt: number;
}

export interface StoredLanCandidate extends LanObservation {
  readonly id: string;
  readonly generation: number;
  readonly observedAt: number;
  readonly expiresAt: number;
}

export interface LanCandidateStoreOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly ttlMs?: number;
  readonly maxCandidates?: number;
}

/** Retained by the main process only; never included in renderer discovery results. */
export interface CurrentLanProof {
  readonly nonce: string;
  readonly port: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class LanCandidateStore {
  readonly #now: () => number;
  readonly #idFactory: () => string;
  readonly #ttlMs: number;
  readonly #maxCandidates: number;
  readonly #candidates = new Map<string, StoredLanCandidate>();
  readonly #confirmedProofs = new Map<
    string,
    CurrentLanProof & { generation: number; observation: LanObservation }
  >();
  #generation = 0;

  constructor(options: LanCandidateStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? (() => `lan_${randomBytes(18).toString("base64url")}`);
    this.#ttlMs = options.ttlMs ?? LAN_CANDIDATE_TTL_MS;
    this.#maxCandidates = options.maxCandidates ?? MAX_LAN_CANDIDATES;
  }

  refresh(observations: readonly LanObservation[]): readonly LanCandidate[] {
    this.#generation += 1;
    this.#candidates.clear();
    const now = this.#safeNow();
    if (now === undefined) return Object.freeze([]);
    const expiresAt = now + this.#ttlMs;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return Object.freeze([]);
    const seen = new Set<string>();
    const candidates: LanCandidate[] = [];
    for (const observation of observations) {
      if (candidates.length >= this.#maxCandidates || !isLanObservation(observation)) break;
      const identity = observationIdentity(observation);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const id = this.#createUniqueId();
      if (!id) continue;
      const stored = Object.freeze({
        ...observation,
        id,
        generation: this.#generation,
        observedAt: now,
        expiresAt,
      });
      this.#candidates.set(id, stored);
      candidates.push(toPublicCandidate(stored));
    }
    return Object.freeze(candidates);
  }

  resolve(id: string): StoredLanCandidate | undefined {
    if (!isOpaqueLanId(id)) return undefined;
    const candidate = this.#candidates.get(id);
    const now = this.#safeNow();
    if (
      !candidate ||
      now === undefined ||
      candidate.generation !== this.#generation ||
      now < candidate.observedAt ||
      now >= candidate.expiresAt
    ) {
      if (candidate) this.#candidates.delete(id);
      return undefined;
    }
    return candidate;
  }

  consume(id: string, observation: LanObservation): StoredLanCandidate | undefined {
    const candidate = this.resolve(id);
    if (!candidate || observationIdentity(candidate) !== observationIdentity(observation)) {
      return undefined;
    }
    this.#candidates.delete(id);
    return candidate;
  }

  retainConfirmedProof(proof: CurrentLanProof, observation: LanObservation): boolean {
    const now = this.#safeNow();
    if (
      now === undefined ||
      !isLanObservation(observation) ||
      !isCurrentLanProof(proof) ||
      proof.port !== observation.port ||
      now < proof.issuedAt ||
      now >= proof.expiresAt
    ) {
      return false;
    }
    this.#confirmedProofs.set(
      proof.nonce,
      Object.freeze({ ...proof, generation: this.#generation, observation: { ...observation } }),
    );
    return true;
  }

  isCurrentConfirmedProof(proof: CurrentLanProof): boolean {
    const now = this.#safeNow();
    if (now === undefined || !isCurrentLanProof(proof)) return false;
    for (const [nonce, current] of this.#confirmedProofs) {
      if (current.expiresAt <= now || current.generation !== this.#generation) {
        this.#confirmedProofs.delete(nonce);
      }
    }
    const retained = this.#confirmedProofs.get(proof.nonce);
    return (
      retained !== undefined &&
      retained.port === proof.port &&
      retained.issuedAt === proof.issuedAt &&
      retained.expiresAt === proof.expiresAt &&
      now >= retained.issuedAt &&
      now < retained.expiresAt
    );
  }

  redeemCurrentConfirmedProof(proof: CurrentLanProof): LanObservation | undefined {
    if (!this.isCurrentConfirmedProof(proof)) return undefined;
    const retained = this.#confirmedProofs.get(proof.nonce);
    if (!retained) return undefined;
    this.#confirmedProofs.delete(proof.nonce);
    return Object.freeze({ ...retained.observation });
  }

  currentConfirmedObservation(proof: CurrentLanProof): LanObservation | undefined {
    if (!this.isCurrentConfirmedProof(proof)) return undefined;
    const retained = this.#confirmedProofs.get(proof.nonce);
    return retained === undefined ? undefined : Object.freeze({ ...retained.observation });
  }

  clear(): void {
    this.#generation += 1;
    this.#candidates.clear();
    this.#confirmedProofs.clear();
  }

  #safeNow(): number | undefined {
    const now = this.#now();
    return Number.isSafeInteger(now) && now >= 0 ? now : undefined;
  }

  #createUniqueId(): string | undefined {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#idFactory();
      if (isOpaqueLanId(id) && !this.#candidates.has(id)) return id;
    }
    return undefined;
  }
}

function isCurrentLanProof(value: CurrentLanProof): boolean {
  return (
    typeof value.nonce === "string" &&
    /^[A-Za-z0-9_-]{16,64}$/u.test(value.nonce) &&
    Number.isSafeInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65_535 &&
    Number.isSafeInteger(value.issuedAt) &&
    value.issuedAt >= 0 &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > value.issuedAt
  );
}

export function isOpaqueLanId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/u.test(value);
}

export function isSameLanObservation(left: LanObservation, right: LanObservation): boolean {
  return observationIdentity(left) === observationIdentity(right);
}

function observationIdentity(observation: LanObservation): string {
  return `${observation.port}:${observation.pid}:${observation.processStartedAt}`;
}

function isLanObservation(value: LanObservation): boolean {
  return (
    Number.isSafeInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65_535 &&
    Number.isSafeInteger(value.pid) &&
    value.pid >= 1 &&
    Number.isSafeInteger(value.processStartedAt) &&
    value.processStartedAt >= 1 &&
    (value.version === "1.21.5" || value.version === "unknown")
  );
}

function toPublicCandidate(candidate: StoredLanCandidate): LanCandidate {
  return Object.freeze({
    id: candidate.id,
    port: candidate.port,
    version: candidate.version,
    observedAt: candidate.observedAt,
    expiresAt: candidate.expiresAt,
  });
}
