import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { win32 } from "node:path";
import {
  PCL2_EXECUTABLE_NAME,
  runFixedPcl2Probe,
  type FixedPcl2ProbeResult,
  type Pcl2CandidateSource,
  type Pcl2ProbeRecord,
} from "./fixedWindowsProbe.js";

export type { Pcl2CandidateSource, Pcl2ProbeRecord };

export const MAX_PUBLIC_PCL2_CANDIDATES = 32;

export interface Pcl2Candidate {
  readonly id: string;
  readonly displayPath: string;
  readonly source: Pcl2CandidateSource;
  readonly running: boolean;
}

export interface Pcl2DiscoveryOptions {
  readonly probe?: () => Promise<FixedPcl2ProbeResult>;
  readonly canonicalize?: (path: string) => Promise<string>;
  readonly statPath?: (path: string) => Promise<{ isFile(): boolean }>;
  readonly idFactory?: () => string;
}

interface AggregatedCandidate {
  canonicalPath: string;
  source: Pcl2CandidateSource;
  running: boolean;
}

const SOURCE_PRIORITY: Readonly<Record<Pcl2CandidateSource, number>> = {
  known_location: 0,
  start_menu: 1,
  running_process: 2,
};

export class Pcl2Discovery {
  readonly #probe: () => Promise<FixedPcl2ProbeResult>;
  readonly #canonicalize: (path: string) => Promise<string>;
  readonly #statPath: (path: string) => Promise<{ isFile(): boolean }>;
  readonly #idFactory: () => string;
  readonly #canonicalPaths = new Map<string, string>();
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: Pcl2DiscoveryOptions = {}) {
    this.#probe = options.probe ?? runFixedPcl2Probe;
    this.#canonicalize = options.canonicalize ?? ((path) => realpath(path));
    this.#statPath = options.statPath ?? ((path) => stat(path));
    this.#idFactory = options.idFactory ?? (() => `pcl2_${randomBytes(18).toString("base64url")}`);
  }

  discoverPcl2(): Promise<readonly Pcl2Candidate[]> {
    const operation = this.#operationTail.then(() => this.#discoverCurrent());
    this.#operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  resolveCanonicalPath(candidateId: string): string | undefined {
    return this.#canonicalPaths.get(candidateId);
  }

  async #discoverCurrent(): Promise<readonly Pcl2Candidate[]> {
    this.#canonicalPaths.clear();
    const probeResult = await this.#probe();
    const aggregated = new Map<string, AggregatedCandidate>();
    for (const record of probeResult.records) {
      const canonicalPath = await this.#safeCanonicalize(record);
      if (!canonicalPath) continue;
      const key = canonicalPath.toLocaleLowerCase("en-US");
      const existing = aggregated.get(key);
      if (existing) {
        existing.running ||= record.running;
        if (SOURCE_PRIORITY[record.source] > SOURCE_PRIORITY[existing.source]) {
          existing.source = record.source;
        }
      } else {
        aggregated.set(key, {
          canonicalPath,
          source: record.source,
          running: record.running,
        });
      }
    }

    const candidates: Pcl2Candidate[] = [];
    for (const candidate of aggregated.values()) {
      if (candidates.length >= MAX_PUBLIC_PCL2_CANDIDATES) break;
      const id = this.#createUniqueId();
      if (!id) continue;
      this.#canonicalPaths.set(id, candidate.canonicalPath);
      candidates.push(
        Object.freeze({
          id,
          displayPath: PCL2_EXECUTABLE_NAME,
          source: candidate.source,
          running: candidate.running,
        }),
      );
    }
    return Object.freeze(candidates);
  }

  async #safeCanonicalize(record: Pcl2ProbeRecord): Promise<string | undefined> {
    if (!hasExactExecutableName(record.path)) return undefined;
    try {
      const canonicalPath = await this.#canonicalize(record.path);
      if (!isSafeCanonicalPath(canonicalPath) || !hasExactExecutableName(canonicalPath)) {
        return undefined;
      }
      if (!(await this.#statPath(canonicalPath)).isFile()) return undefined;
      return win32.normalize(canonicalPath);
    } catch {
      return undefined;
    }
  }

  #createUniqueId(): string | undefined {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.#idFactory();
      if (/^[A-Za-z0-9_-]{16,64}$/u.test(id) && !this.#canonicalPaths.has(id)) return id;
    }
    return undefined;
  }
}

function hasExactExecutableName(path: string): boolean {
  return (
    win32.basename(path).toLocaleLowerCase("en-US") ===
    PCL2_EXECUTABLE_NAME.toLocaleLowerCase("en-US")
  );
}

function isSafeCanonicalPath(path: string): boolean {
  return (
    /^[A-Za-z]:\\/u.test(path) &&
    win32.isAbsolute(path) &&
    path.isWellFormed() &&
    [...path].length <= 1_024 &&
    !/[\u0000-\u001f\u007f]/u.test(path)
  );
}
