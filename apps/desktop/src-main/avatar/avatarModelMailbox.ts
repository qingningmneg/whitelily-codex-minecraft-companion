import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  parseAvatarModelControlRequest,
  parseAvatarModelControlState,
  type AvatarModelControlRequest,
  type AvatarModelControlState,
} from "../../../../src/avatar/avatarModelSchemas.js";
import { AtomicJsonFile } from "../../../../src/storage/atomicJsonFile.js";
import { resolveAvatarModelPaths } from "./avatarModelPaths.js";

export type AvatarModelMailboxErrorCode =
  "AVATAR_MAILBOX_ABORTED" | "AVATAR_MAILBOX_TIMEOUT" | "AVATAR_MAILBOX_STATE_INVALID";

export class AvatarModelMailboxError extends Error {
  constructor(
    readonly code: AvatarModelMailboxErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "AvatarModelMailboxError";
  }
}

interface AvatarModelMailboxOptions {
  readonly dataRoot: string;
  readonly currentWorldSessionId: () => string | undefined;
  readonly pollIntervalMs?: number;
  readonly diagnostic?: (code: AvatarModelMailboxErrorCode) => void;
}

interface PublishedRequestClock {
  readonly worldSessionId: string;
  readonly issuedAt: number;
}

const MAX_MAILBOX_BYTES = 64 * 1024;

export class AvatarModelMailbox {
  readonly #bridgeRoot: string;
  readonly #statePath: string;
  readonly #requestFile: AtomicJsonFile<AvatarModelControlRequest>;
  readonly #stateFile: AtomicJsonFile<AvatarModelControlState>;
  readonly #currentWorldSessionId: () => string | undefined;
  readonly #pollIntervalMs: number;
  readonly #diagnostic: (code: AvatarModelMailboxErrorCode) => void;
  readonly #reportedDiagnostics = new Set<AvatarModelMailboxErrorCode>();
  readonly #publishedClocks = new Map<string, PublishedRequestClock>();
  readonly #latestStateTimes = new Map<string, number>();

  constructor(options: AvatarModelMailboxOptions) {
    if (!isAbsolute(options.dataRoot)) throw new Error("invalid avatar model mailbox root");
    if (
      options.pollIntervalMs !== undefined &&
      (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 1)
    ) {
      throw new Error("invalid avatar model mailbox polling interval");
    }
    const dataRoot = resolve(options.dataRoot);
    const paths = resolveAvatarModelPaths(dataRoot);
    this.#bridgeRoot = paths.bridgeRoot;
    this.#statePath = join(paths.bridgeRoot, "state.json");
    this.#currentWorldSessionId = options.currentWorldSessionId;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    this.#diagnostic = options.diagnostic ?? (() => undefined);
    this.#requestFile = new AtomicJsonFile({
      rootDirectory: dataRoot,
      path: join(paths.bridgeRoot, "request.json"),
      validate: parseAvatarModelControlRequest,
      recoverFromBackup: false,
    });
    this.#stateFile = new AtomicJsonFile({
      rootDirectory: dataRoot,
      path: this.#statePath,
      validate: parseAvatarModelControlState,
      recoverFromBackup: false,
    });
  }

  async publish(request: AvatarModelControlRequest): Promise<void> {
    const parsed = parseAvatarModelControlRequest(request);
    if (Buffer.byteLength(`${JSON.stringify(parsed)}\n`, "utf8") > MAX_MAILBOX_BYTES) {
      throw new AvatarModelMailboxError(
        "AVATAR_MAILBOX_STATE_INVALID",
        "avatar model mailbox request exceeds the size limit",
      );
    }
    await mkdir(this.#bridgeRoot, { recursive: true });
    await this.#requestFile.write(parsed);
    this.#publishedClocks.set(parsed.requestId, {
      worldSessionId: parsed.worldSessionId,
      issuedAt: Date.parse(parsed.issuedAt),
    });
  }

  async waitForState(input: {
    readonly requestId: string;
    readonly accepted: readonly AvatarModelControlState["phase"][];
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<AvatarModelControlState> {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      throw new AvatarModelMailboxError(
        "AVATAR_MAILBOX_TIMEOUT",
        "avatar model mailbox wait timed out",
      );
    }
    if (input.signal.aborted) throw this.#aborted(input.signal);
    await mkdir(this.#bridgeRoot, { recursive: true });
    if (input.signal.aborted) throw this.#aborted(input.signal);

    return new Promise<AvatarModelControlState>((resolvePromise, rejectPromise) => {
      let settled = false;
      let inspecting = false;
      let inspectAgain = false;
      let watcher: FSWatcher | undefined;

      const cleanup = (): void => {
        clearTimeout(timeout);
        clearInterval(poll);
        watcher?.close();
        input.signal.removeEventListener("abort", abort);
      };
      const resolve = (state: AvatarModelControlState): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(state);
      };
      const reject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      };
      const abort = (): void => reject(this.#aborted(input.signal));
      const scheduleInspect = (): void => {
        if (settled) return;
        if (inspecting) {
          inspectAgain = true;
          return;
        }
        inspecting = true;
        void this.#readMatchingState(input)
          .then((state) => {
            if (state !== undefined) resolve(state);
          })
          .finally(() => {
            inspecting = false;
            if (inspectAgain && !settled) {
              inspectAgain = false;
              scheduleInspect();
            }
          });
      };
      const timeout = setTimeout(
        () =>
          reject(
            new AvatarModelMailboxError(
              "AVATAR_MAILBOX_TIMEOUT",
              "avatar model mailbox wait timed out",
            ),
          ),
        input.timeoutMs,
      );
      const poll = setInterval(scheduleInspect, this.#pollIntervalMs);
      poll.unref?.();
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        watcher = watch(this.#bridgeRoot, { persistent: false }, (_event, fileName) => {
          if (fileName === null || fileName.toString() === "state.json") scheduleInspect();
        });
        watcher.on("error", scheduleInspect);
      } catch {
        // The bounded polling fallback remains active when native watching is unavailable.
      }
      scheduleInspect();
    });
  }

  async #readMatchingState(input: {
    readonly requestId: string;
    readonly accepted: readonly AvatarModelControlState["phase"][];
  }): Promise<AvatarModelControlState | undefined> {
    try {
      const metadata = await lstat(this.#statePath);
      if (metadata.size > MAX_MAILBOX_BYTES) throw new Error("mailbox state exceeds size limit");
      const state = await this.#stateFile.read();
      if (state === undefined || state.requestId !== input.requestId) return undefined;
      const published = this.#publishedClocks.get(input.requestId);
      const expectedWorld = published?.worldSessionId ?? this.#currentWorldSessionId();
      if (expectedWorld === undefined || state.worldSessionId !== expectedWorld) return undefined;
      const updatedAt = Date.parse(state.updatedAt);
      if (published !== undefined && updatedAt < published.issuedAt) return undefined;
      const previousUpdatedAt = this.#latestStateTimes.get(input.requestId);
      if (previousUpdatedAt !== undefined && updatedAt < previousUpdatedAt) return undefined;
      this.#latestStateTimes.set(input.requestId, updatedAt);
      return input.accepted.includes(state.phase) ? state : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      this.#reportOnce("AVATAR_MAILBOX_STATE_INVALID");
      return undefined;
    }
  }

  #aborted(signal: AbortSignal): AvatarModelMailboxError {
    return new AvatarModelMailboxError(
      "AVATAR_MAILBOX_ABORTED",
      "avatar model mailbox wait aborted",
      {
        ...(signal.reason === undefined ? {} : { cause: signal.reason }),
      },
    );
  }

  #reportOnce(code: AvatarModelMailboxErrorCode): void {
    if (this.#reportedDiagnostics.has(code)) return;
    this.#reportedDiagnostics.add(code);
    this.#diagnostic(code);
  }
}
