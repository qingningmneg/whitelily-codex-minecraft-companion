import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  BUILTIN_AVATAR_MODEL_IDS,
  parseAvatarModelId,
} from "../../../../src/avatar/avatarModelSchemas.js";
import { AtomicJsonFile } from "../../../../src/storage/atomicJsonFile.js";
import type { AvatarModelCatalog } from "./avatarModelCatalog.js";
import { resolveAvatarModelPaths } from "./avatarModelPaths.js";

export type AvatarModelPreferenceErrorCode =
  | "AVATAR_PREFERENCE_CONFLICT"
  | "AVATAR_PREFERENCE_INVALID"
  | "AVATAR_MODEL_NOT_FOUND";

export class AvatarModelPreferenceError extends Error {
  constructor(
    readonly code: AvatarModelPreferenceErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "AvatarModelPreferenceError";
  }
}

export interface AvatarModelPreferenceSnapshot {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly activeModelId: string;
  readonly committedRequestId?: string | undefined;
}

const DEFAULT_AVATAR_MODEL_PREFERENCE = Object.freeze({
  schemaVersion: 1 as const,
  revision: 0,
  activeModelId: BUILTIN_AVATAR_MODEL_IDS[0],
});
const COMMITTED_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const preferenceQueues = new Map<string, Promise<unknown>>();

export class AvatarModelPreferences {
  readonly #root: string;
  readonly #file: AtomicJsonFile<AvatarModelPreferenceSnapshot>;

  constructor(options: { dataRoot: string }) {
    if (!isAbsolute(options.dataRoot)) throw new Error("invalid avatar model preference root");
    this.#root = resolve(options.dataRoot);
    const paths = resolveAvatarModelPaths(this.#root);
    this.#file = new AtomicJsonFile({
      rootDirectory: this.#root,
      path: paths.preferencesPath,
      validate: validatePreferenceSnapshot,
      recoverFrom: () => false,
    });
  }

  async read(catalog: AvatarModelCatalog): Promise<AvatarModelPreferenceSnapshot> {
    const current = await this.#readRaw();
    if (!(await catalog.has(current.activeModelId))) return current;
    return current;
  }

  async readActiveModelId(catalog: AvatarModelCatalog): Promise<string> {
    const current = await this.#readRaw();
    return (await catalog.has(current.activeModelId))
      ? current.activeModelId
      : BUILTIN_AVATAR_MODEL_IDS[0];
  }

  async commitActiveModelId(input: {
    readonly catalog: AvatarModelCatalog;
    readonly expectedRevision: number;
    readonly activeModelId: string;
    readonly committedRequestId: string;
  }): Promise<AvatarModelPreferenceSnapshot> {
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !COMMITTED_REQUEST_ID_PATTERN.test(input.committedRequestId)
    ) {
      throw new AvatarModelPreferenceError(
        "AVATAR_PREFERENCE_INVALID",
        "avatar model preference commit is invalid",
      );
    }
    const activeModelId = parseAvatarModelId(input.activeModelId);
    if (!(await input.catalog.has(activeModelId))) {
      throw new AvatarModelPreferenceError(
        "AVATAR_MODEL_NOT_FOUND",
        "avatar model preference target is unavailable",
      );
    }
    await mkdir(this.#root, { recursive: true });
    const key = await this.#file.coordinatorKey();
    return serializePreferenceOperation(key, async () => {
      const current = await this.#readRaw();
      if (current.committedRequestId === input.committedRequestId) {
        if (current.activeModelId !== activeModelId) {
          throw new AvatarModelPreferenceError(
            "AVATAR_PREFERENCE_CONFLICT",
            "avatar model request id was already committed",
          );
        }
        return current;
      }
      if (current.revision !== input.expectedRevision) {
        throw new AvatarModelPreferenceError(
          "AVATAR_PREFERENCE_CONFLICT",
          "avatar model preference revision changed",
        );
      }
      try {
        return await this.#file.write({
          schemaVersion: 1,
          revision: current.revision + 1,
          activeModelId,
          committedRequestId: input.committedRequestId,
        });
      } catch (error) {
        throw wrapPreferenceError(error);
      }
    });
  }

  async #readRaw(): Promise<AvatarModelPreferenceSnapshot> {
    await mkdir(this.#root, { recursive: true });
    try {
      await this.#file.writeIfAbsent(DEFAULT_AVATAR_MODEL_PREFERENCE);
      const current = await this.#file.read();
      if (current === undefined) throw new Error("avatar model preference is missing");
      return current;
    } catch (error) {
      throw wrapPreferenceError(error);
    }
  }
}

async function serializePreferenceOperation<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = preferenceQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  preferenceQueues.set(key, current);
  return current.finally(() => {
    if (preferenceQueues.get(key) === current) preferenceQueues.delete(key);
  });
}

function validatePreferenceSnapshot(value: unknown): AvatarModelPreferenceSnapshot {
  if (!isPlainObject(value)) throw new Error("invalid avatar model preference");
  const keys = Object.keys(value).sort().join(",");
  if (
    (keys !== "activeModelId,revision,schemaVersion" &&
      keys !== "activeModelId,committedRequestId,revision,schemaVersion") ||
    Reflect.get(value, "schemaVersion") !== 1 ||
    !Number.isSafeInteger(Reflect.get(value, "revision")) ||
    (Reflect.get(value, "revision") as number) < 0
  ) {
    throw new Error("invalid avatar model preference");
  }
  const activeModelId = parseAvatarModelId(Reflect.get(value, "activeModelId"));
  const committedRequestId = Reflect.get(value, "committedRequestId");
  if (
    committedRequestId !== undefined &&
    (typeof committedRequestId !== "string" ||
      !COMMITTED_REQUEST_ID_PATTERN.test(committedRequestId))
  ) {
    throw new Error("invalid avatar model preference");
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: Reflect.get(value, "revision") as number,
    activeModelId,
    ...(committedRequestId === undefined ? {} : { committedRequestId }),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function wrapPreferenceError(error: unknown): AvatarModelPreferenceError {
  return error instanceof AvatarModelPreferenceError
    ? error
    : new AvatarModelPreferenceError(
        "AVATAR_PREFERENCE_INVALID",
        "avatar model preference is invalid",
        { cause: error },
      );
}
