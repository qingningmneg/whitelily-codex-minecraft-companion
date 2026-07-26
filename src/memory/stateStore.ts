import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CompanionMode } from "../domain/types.js";

export interface PersistentState {
  lastMode: CompanionMode;
  paused: boolean;
  unfinishedTaskSummary: string | null;
  updatedAt?: string;
}

const initialState: PersistentState = {
  lastMode: "friend",
  paused: false,
  unfinishedTaskSummary: null,
};
const modes = new Set<CompanionMode>(["friend", "balanced", "autonomous"]);
const writeQueues = new Map<string, Promise<unknown>>();

function serializeByPath<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  writeQueues.set(path, current);
  return current.finally(() => {
    if (writeQueues.get(path) === current) writeQueues.delete(path);
  });
}

function isPersistentState(value: unknown): value is PersistentState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const allowed = new Set(["lastMode", "paused", "unfinishedTaskSummary", "updatedAt"]);
  if (!Object.keys(state).every((key) => allowed.has(key))) return false;
  return (
    typeof state.lastMode === "string" &&
    modes.has(state.lastMode as CompanionMode) &&
    typeof state.paused === "boolean" &&
    (typeof state.unfinishedTaskSummary === "string" || state.unfinishedTaskSummary === null) &&
    (state.updatedAt === undefined ||
      (typeof state.updatedAt === "string" && !Number.isNaN(Date.parse(state.updatedAt))))
  );
}

export class StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<PersistentState> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...initialState };
      throw error;
    }
    if (!isPersistentState(parsed)) throw new Error("persistent state is invalid");
    return {
      lastMode: parsed.lastMode,
      paused: parsed.paused,
      unfinishedTaskSummary: parsed.unfinishedTaskSummary,
      ...(parsed.updatedAt === undefined ? {} : { updatedAt: parsed.updatedAt }),
    };
  }

  save(state: Omit<PersistentState, "updatedAt">): Promise<void> {
    const persisted: PersistentState = {
      lastMode: state.lastMode,
      paused: state.paused,
      unfinishedTaskSummary: state.unfinishedTaskSummary,
      updatedAt: new Date().toISOString(),
    };
    if (!isPersistentState(persisted))
      return Promise.reject(new Error("persistent state is invalid"));
    return serializeByPath(this.path, () =>
      this.writeAtomically(JSON.stringify(persisted, null, 2)),
    );
  }

  private async writeAtomically(contents: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${contents}\n`, "utf8");
      await rename(tempPath, this.path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
