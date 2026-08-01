import { randomBytes } from "node:crypto";
import {
  runFixedJavaListenerProbe,
  type FixedJavaListenerProbeResult,
  type JavaListenerProbeRecord,
} from "./fixedWindowsProbe.js";
import {
  isSameLanObservation,
  LanCandidateStore,
  type LanCandidate,
  type LanObservation,
} from "./lanCandidateStore.js";

export type { LanCandidate };

export interface ConfirmedConnectionProof {
  readonly nonce: string;
  readonly port: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ConfiguredConnectionResult {
  readonly status: "configured";
  readonly port: number;
  readonly confirmedAt: number;
}

export interface ConfirmedLanSession {
  readonly status: "confirmed";
  readonly port: number;
  readonly version: string;
  readonly confirmedAt: number;
}

export interface LanDetectorOptions {
  readonly probe?: () => Promise<FixedJavaListenerProbeResult>;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly nonceFactory?: () => string;
}

const CONFIRMATION_PROOF_TTL_MS = 10_000;

export class LanDetector {
  readonly #probe: () => Promise<FixedJavaListenerProbeResult>;
  readonly #now: () => number;
  readonly #nonceFactory: () => string;
  readonly #store: LanCandidateStore;
  #confirmedObservation: LanObservation | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(options: LanDetectorOptions = {}) {
    this.#probe = options.probe ?? runFixedJavaListenerProbe;
    this.#now = options.now ?? Date.now;
    this.#nonceFactory =
      options.nonceFactory ?? (() => `proof_${randomBytes(18).toString("base64url")}`);
    this.#store = new LanCandidateStore({
      now: this.#now,
      ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    });
  }

  detectLanCandidates(): Promise<readonly LanCandidate[]> {
    return this.#serialize(async () => {
      this.#assertRunning();
      const result = await this.#probe();
      this.#assertRunning();
      return this.#store.refresh(normalizeProbeRecords(result.records));
    });
  }

  confirmLanCandidate(
    candidateId: string,
    applyProof: (proof: ConfirmedConnectionProof) => Promise<ConfiguredConnectionResult>,
  ): Promise<ConfirmedLanSession> {
    return this.#serialize(async () => {
      this.#assertRunning();
      const candidate = this.#store.resolve(candidateId);
      if (!candidate) throw new Error("LAN_CANDIDATE_EXPIRED");
      const observations = normalizeProbeRecords((await this.#probe()).records);
      this.#assertRunning();
      const current = observations.find((observation) =>
        isSameLanObservation(observation, candidate),
      );
      if (!current) {
        this.#store.clear();
        throw new Error("LAN_CANDIDATE_CHANGED");
      }
      const consumed = this.#store.consume(candidateId, current);
      if (!consumed) throw new Error("LAN_CANDIDATE_EXPIRED");
      const issuedAt = this.#safeNow();
      if (issuedAt < consumed.observedAt || issuedAt >= consumed.expiresAt) {
        throw new Error("LAN_CANDIDATE_EXPIRED");
      }
      const nonce = this.#nonceFactory();
      if (!/^[A-Za-z0-9_-]{16,64}$/u.test(nonce)) throw new Error("LAN_CONFIRMATION_FAILED");
      const proof = Object.freeze({
        nonce,
        port: consumed.port,
        issuedAt,
        expiresAt: Math.min(consumed.expiresAt, issuedAt + CONFIRMATION_PROOF_TTL_MS),
      });
      const configured = await applyProof(proof);
      this.#assertRunning();
      if (
        configured.status !== "configured" ||
        configured.port !== consumed.port ||
        configured.confirmedAt < issuedAt ||
        configured.confirmedAt >= proof.expiresAt
      ) {
        throw new Error("LAN_CONFIRMATION_FAILED");
      }
      if (!this.#store.retainConfirmedProof(proof, current)) {
        throw new Error("LAN_CONFIRMATION_FAILED");
      }
      this.#confirmedObservation = Object.freeze({ ...current });
      return Object.freeze({
        status: "confirmed",
        port: consumed.port,
        version: consumed.version,
        confirmedAt: configured.confirmedAt,
      });
    });
  }

  validateConfirmedSession(): Promise<boolean> {
    return this.#serialize(async () => {
      this.#assertRunning();
      const confirmed = this.#confirmedObservation;
      if (!confirmed) return false;
      const observations = normalizeProbeRecords((await this.#probe()).records);
      this.#assertRunning();
      const valid = observations.some((observation) =>
        isSameLanObservation(observation, confirmed),
      );
      if (!valid) {
        this.#confirmedObservation = undefined;
        this.#store.clear();
      }
      return valid;
    });
  }

  /** Main-process-only proof validation for bound-world authorization. */
  isCurrentConfirmedProof(proof: ConfirmedConnectionProof): boolean {
    return this.#store.isCurrentConfirmedProof(proof);
  }

  redeemConfirmedProof(proof: ConfirmedConnectionProof): Promise<Readonly<LanObservation>> {
    return this.#serialize(async () => {
      this.#assertRunning();
      const retained = this.#store.currentConfirmedObservation(proof);
      if (!retained) throw new Error("LAN_CONFIRMATION_FAILED");
      const current = normalizeProbeRecords((await this.#probe()).records).find((observation) =>
        isSameLanObservation(observation, retained),
      );
      this.#assertRunning();
      if (!current || !isSameLanObservation(current, retained)) {
        this.#store.clear();
        throw new Error("LAN_CONFIRMATION_FAILED");
      }
      if (!this.#store.redeemCurrentConfirmedProof(proof)) {
        throw new Error("LAN_CONFIRMATION_FAILED");
      }
      return Object.freeze({ ...current });
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#store.clear();
    this.#confirmedObservation = undefined;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#operationTail.then(operation);
    this.#operationTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  #assertRunning(): void {
    if (this.#stopped) throw new Error("LAN_DETECTOR_STOPPED");
  }

  #safeNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("LAN_CLOCK_INVALID");
    return now;
  }
}

function normalizeProbeRecords(
  records: readonly JavaListenerProbeRecord[],
): readonly LanObservation[] {
  const observations: LanObservation[] = [];
  for (const record of records) {
    if (
      !(
        record.localAddress === "127.0.0.1" ||
        record.localAddress === "::1" ||
        record.localAddress === "0.0.0.0" ||
        record.localAddress === "::"
      ) ||
      !(record.processName === "java.exe" || record.processName === "javaw.exe") ||
      !Number.isSafeInteger(record.localPort) ||
      record.localPort < 1 ||
      record.localPort > 65_535 ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1 ||
      !Number.isSafeInteger(record.processStartedAt) ||
      record.processStartedAt < 1
    ) {
      continue;
    }
    observations.push(
      Object.freeze({
        port: record.localPort,
        pid: record.pid,
        processStartedAt: record.processStartedAt,
        version: record.version === "1.21.5" ? record.version : "unknown",
      }),
    );
  }
  return Object.freeze(observations);
}
