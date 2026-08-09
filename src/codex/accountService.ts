import { randomBytes } from "node:crypto";
import type { AuthMode } from "./generated/AuthMode.js";
import type { Account } from "./generated/v2/Account.js";
import type { AccountLoginCompletedNotification } from "./generated/v2/AccountLoginCompletedNotification.js";
import type { AccountUpdatedNotification } from "./generated/v2/AccountUpdatedNotification.js";
import type { CancelLoginAccountResponse } from "./generated/v2/CancelLoginAccountResponse.js";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse.js";
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse.js";

const DEFAULT_LOGIN_TTL_MS = 10 * 60_000;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const ENCODED_SEPARATOR = /%2f|%5c/iu;

export type AccountSnapshot =
  | { status: "signed_out" }
  | { status: "pending"; attemptId: string; expiresAt: number }
  | { status: "signed_in"; auth: "chatgpt" }
  | { status: "cancelled"; attemptId: string }
  | { status: "expired"; attemptId: string };

export interface LoginAttempt {
  attemptId: string;
  expiresAt: number;
  loginUrl: string;
}

export type AccountServerNotification =
  | { method: "account/login/completed"; params: AccountLoginCompletedNotification }
  | { method: "account/updated"; params: AccountUpdatedNotification };

export interface AccountAppServerPort {
  startAccountSession(): Promise<void>;
  readAccount(): Promise<GetAccountResponse>;
  startChatGptLogin(): Promise<LoginAccountResponse>;
  cancelChatGptLogin(loginId: string): Promise<CancelLoginAccountResponse>;
  subscribeAccountNotifications(
    listener: (notification: AccountServerNotification) => void,
  ): () => void;
  stop(): Promise<void>;
}

export interface AccountServiceOptions {
  now?: () => number;
  ttlMs?: number;
  createAttemptId?: () => string;
}

interface CurrentAttempt extends LoginAttempt {
  loginId: string;
  generation: number;
}

type ChatGptAccount = Extract<Account, { type: "chatgpt" }>;
type NonSignedInAccountSnapshot = Exclude<AccountSnapshot, { status: "signed_in" }>;

class AccountStatusUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Account status is unavailable", { cause });
    this.name = "AccountStatusUnavailableError";
  }
}

export class AccountService {
  readonly #port: AccountAppServerPort;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #createAttemptId: () => string;
  readonly #listeners = new Set<(snapshot: AccountSnapshot) => void>();
  readonly #unsubscribeNotifications: () => void;
  #snapshot: AccountSnapshot = { status: "signed_out" };
  #signedInAccount: ChatGptAccount | undefined;
  #attempt: CurrentAttempt | undefined;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  #lifecycleGeneration = 0;
  #attemptGeneration = 0;
  #stopPromise: Promise<void> | undefined;
  #stopped = false;

  constructor(port: AccountAppServerPort, options: AccountServiceOptions = {}) {
    this.#port = port;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_LOGIN_TTL_MS, "login TTL");
    this.#createAttemptId =
      options.createAttemptId ?? (() => randomBytes(24).toString("base64url"));
    this.#unsubscribeNotifications = port.subscribeAccountNotifications((notification) => {
      if (this.#stopped) return;
      void this.#queueOperation((currentGeneration) =>
        this.#handleNotification(notification, currentGeneration),
      ).catch(() => undefined);
    });
  }

  subscribe(listener: (snapshot: AccountSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getAccount(): Promise<AccountSnapshot> {
    return this.#queueOperation(async (generation) => {
      await this.#expireIfNeeded(generation);
      if (this.#snapshot.status === "cancelled" || this.#snapshot.status === "expired") {
        return this.#snapshot;
      }
      if (this.#snapshot.status === "pending") {
        try {
          return await this.#refreshAccount(generation);
        } catch (error) {
          this.#assertCurrentLifecycle(generation);
          if (
            error instanceof AccountStatusUnavailableError &&
            this.#snapshot.status === "pending"
          ) {
            return this.#snapshot;
          }
          throw error;
        }
      }
      return this.#refreshAccount(generation);
    });
  }

  startChatGptLogin(): Promise<LoginAttempt> {
    return this.#queueOperation((generation) => this.#startChatGptLogin(generation));
  }

  async #startChatGptLogin(generation: number): Promise<LoginAttempt> {
    await this.#expireIfNeeded(generation);
    if (
      this.#attempt &&
      this.#snapshot.status === "pending" &&
      this.#attempt.generation === this.#attemptGeneration
    ) {
      return publicLoginAttempt(this.#attempt);
    }
    await this.#port.startAccountSession();
    this.#assertCurrentLifecycle(generation);
    const response = await this.#port.startChatGptLogin().catch(() => {
      this.#assertCurrentLifecycle(generation);
      throw new Error("Unable to start ChatGPT login");
    });
    if (!this.#isCurrentLifecycle(generation)) {
      if (response.type === "chatgpt" && validInternalLoginId(response.loginId)) {
        await this.#port.cancelChatGptLogin(response.loginId).catch(() => undefined);
      }
      throw new Error("Account service is stopped");
    }
    if (response.type !== "chatgpt" || !validInternalLoginId(response.loginId)) {
      throw new Error("Codex returned an invalid ChatGPT login");
    }
    const loginUrl = validateChatGptLoginUrl(response.authUrl);
    if (!loginUrl) {
      await this.#port.cancelChatGptLogin(response.loginId).catch(() => undefined);
      throw new Error("Codex returned an invalid ChatGPT login");
    }
    const attemptId = this.#createAttemptId();
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      await this.#port.cancelChatGptLogin(response.loginId).catch(() => undefined);
      throw new Error("Unable to create a secure login attempt");
    }
    const expiresAt = this.#now() + this.#ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      await this.#port.cancelChatGptLogin(response.loginId).catch(() => undefined);
      throw new Error("Unable to create a secure login attempt");
    }
    const attempt: CurrentAttempt = {
      attemptId,
      expiresAt,
      generation: ++this.#attemptGeneration,
      loginId: response.loginId,
      loginUrl,
    };
    this.#attempt = attempt;
    this.#setSnapshot({ status: "pending", attemptId, expiresAt });
    this.#scheduleExpiry(attempt);
    return publicLoginAttempt(attempt);
  }

  cancelChatGptLogin(attemptId: string): Promise<AccountSnapshot> {
    return this.#queueOperation((generation) => this.#cancelChatGptLogin(attemptId, generation));
  }

  async #cancelChatGptLogin(attemptId: string, generation: number): Promise<AccountSnapshot> {
    await this.#expireIfNeeded(generation);
    if (
      (this.#snapshot.status === "cancelled" || this.#snapshot.status === "expired") &&
      this.#snapshot.attemptId === attemptId
    ) {
      return this.#snapshot;
    }
    const attempt = this.#attempt;
    if (!attempt || attempt.attemptId !== attemptId || this.#snapshot.status !== "pending") {
      throw new Error("Login attempt is not current");
    }
    this.#clearExpiryTimer();
    await this.#port.cancelChatGptLogin(attempt.loginId).catch(() => undefined);
    this.#assertCurrentAttempt(attempt, generation);
    this.#attempt = undefined;
    return this.#setSnapshot({ status: "cancelled", attemptId });
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    this.#lifecycleGeneration += 1;
    this.#attemptGeneration += 1;
    this.#attempt = undefined;
    this.#signedInAccount = undefined;
    this.#clearExpiryTimer();
    this.#unsubscribeNotifications();
    this.#listeners.clear();
    const stopping = this.#port.stop();
    this.#stopPromise = stopping;
    return stopping;
  }

  async #refreshAccount(generation: number): Promise<AccountSnapshot> {
    let response: GetAccountResponse;
    try {
      await this.#port.startAccountSession();
      this.#assertCurrentLifecycle(generation);
      response = await this.#port.readAccount();
    } catch (error) {
      this.#assertCurrentLifecycle(generation);
      throw new AccountStatusUnavailableError(error);
    }
    this.#assertCurrentLifecycle(generation);
    if (response.account === null) {
      if (this.#snapshot.status === "pending") return this.#snapshot;
      return this.#setSnapshot({ status: "signed_out" });
    }
    if (response.account.type !== "chatgpt") {
      this.#attempt = undefined;
      this.#attemptGeneration += 1;
      this.#clearExpiryTimer();
      this.#setSnapshot({ status: "signed_out" });
      throw new Error("ChatGPT authentication is required");
    }
    this.#attempt = undefined;
    this.#attemptGeneration += 1;
    this.#clearExpiryTimer();
    return this.#setSignedInSnapshot(response.account);
  }

  async #handleNotification(
    notification: AccountServerNotification,
    generation: number,
  ): Promise<void> {
    this.#assertCurrentLifecycle(generation);
    if (notification.method === "account/login/completed") {
      const attempt = this.#attempt;
      if (notification.params.success) {
        await this.#refreshAccount(generation);
        return;
      }
      if (
        attempt &&
        notification.params.loginId === attempt.loginId &&
        this.#snapshot.status === "pending"
      ) {
        this.#attempt = undefined;
        this.#attemptGeneration += 1;
        this.#clearExpiryTimer();
        this.#setSnapshot({ status: "signed_out" });
      }
      return;
    }
    if (notification.method === "account/updated") {
      const authMode = notification.params.authMode;
      if (authMode === null || !isChatGptAuthMode(authMode)) {
        this.#attempt = undefined;
        this.#attemptGeneration += 1;
        this.#clearExpiryTimer();
        this.#setSnapshot({ status: "signed_out" });
      } else {
        await this.#refreshAccount(generation);
      }
    }
  }

  async #expireIfNeeded(generation: number): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt || this.#snapshot.status !== "pending" || this.#now() < attempt.expiresAt) {
      return;
    }
    this.#clearExpiryTimer();
    await this.#port.cancelChatGptLogin(attempt.loginId).catch(() => undefined);
    this.#assertCurrentAttempt(attempt, generation);
    this.#attempt = undefined;
    this.#setSnapshot({ status: "expired", attemptId: attempt.attemptId });
  }

  #scheduleExpiry(attempt: CurrentAttempt): void {
    this.#clearExpiryTimer();
    this.#expiryTimer = setTimeout(
      () => {
        if (this.#attempt !== attempt || this.#stopped) return;
        void this.#queueOperation((generation) => this.#expireIfNeeded(generation)).catch(
          () => undefined,
        );
      },
      Math.max(0, attempt.expiresAt - this.#now()),
    );
    this.#expiryTimer.unref?.();
  }

  #clearExpiryTimer(): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
  }

  #setSnapshot(snapshot: NonSignedInAccountSnapshot): AccountSnapshot {
    const unchanged = sameAccountSnapshot(this.#snapshot, snapshot);
    this.#snapshot = snapshot;
    this.#signedInAccount = undefined;
    if (unchanged) return snapshot;
    this.#notifySnapshot(snapshot);
    return snapshot;
  }

  #setSignedInSnapshot(account: ChatGptAccount): AccountSnapshot {
    const snapshot = { status: "signed_in", auth: "chatgpt" } as const;
    const unchanged =
      sameAccountSnapshot(this.#snapshot, snapshot) &&
      sameChatGptAccount(this.#signedInAccount, account);
    this.#snapshot = snapshot;
    this.#signedInAccount = { ...account };
    if (unchanged) return snapshot;
    this.#notifySnapshot(snapshot);
    return snapshot;
  }

  #notifySnapshot(snapshot: AccountSnapshot): void {
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // Account observers cannot change authentication state.
      }
    }
  }

  #queueOperation<T>(operation: (generation: number) => Promise<T>): Promise<T> {
    if (this.#stopped) return Promise.reject(new Error("Account service is stopped"));
    const generation = this.#lifecycleGeneration;
    const queued = this.#operationTail
      .catch(() => undefined)
      .then(async () => {
        this.#assertCurrentLifecycle(generation);
        return operation(generation);
      });
    this.#operationTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  #isCurrentLifecycle(generation: number): boolean {
    return !this.#stopped && generation === this.#lifecycleGeneration;
  }

  #assertCurrentLifecycle(generation: number): void {
    if (!this.#isCurrentLifecycle(generation)) {
      throw new Error("Account service is stopped");
    }
  }

  #assertCurrentAttempt(attempt: CurrentAttempt, lifecycleGeneration: number): void {
    this.#assertCurrentLifecycle(lifecycleGeneration);
    if (
      this.#attempt !== attempt ||
      attempt.generation !== this.#attemptGeneration ||
      this.#snapshot.status !== "pending"
    ) {
      throw new Error("Login attempt is no longer current");
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}`);
  return value;
}

function validInternalLoginId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function publicLoginAttempt(attempt: CurrentAttempt): LoginAttempt {
  return {
    attemptId: attempt.attemptId,
    expiresAt: attempt.expiresAt,
    loginUrl: attempt.loginUrl,
  };
}

function sameAccountSnapshot(left: AccountSnapshot, right: AccountSnapshot): boolean {
  if (left.status !== right.status) return false;
  switch (left.status) {
    case "signed_out":
      return true;
    case "signed_in":
      return right.status === "signed_in" && left.auth === right.auth;
    case "pending":
      return (
        right.status === "pending" &&
        left.attemptId === right.attemptId &&
        left.expiresAt === right.expiresAt
      );
    case "cancelled":
      return right.status === "cancelled" && left.attemptId === right.attemptId;
    case "expired":
      return right.status === "expired" && left.attemptId === right.attemptId;
  }
}

function sameChatGptAccount(left: ChatGptAccount | undefined, right: ChatGptAccount): boolean {
  return left !== undefined && left.email === right.email && left.planType === right.planType;
}

function validateChatGptLoginUrl(value: string): string | undefined {
  try {
    if (value.length > 8_192 || value.includes("\\")) return undefined;
    const authorityMatch = /^https:\/\/([^/?#]*)/iu.exec(value);
    if (!authorityMatch) return undefined;
    const authority = authorityMatch[1]!;
    if (authority.includes(":") || authority.includes("@")) return undefined;
    const rawPath = value.slice(authorityMatch[0].length).split(/[?#]/u, 1)[0]!;
    if (ENCODED_SEPARATOR.test(rawPath)) return undefined;
    for (const segment of rawPath.split("/")) {
      const decoded = decodeURIComponent(segment);
      if (decoded === "." || decoded === "..") return undefined;
    }
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.port.length > 0 ||
      !isAllowedOpenAiHost(url.hostname)
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function isAllowedOpenAiHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "openai.com" ||
    host.endsWith(".openai.com") ||
    host === "chatgpt.com" ||
    host.endsWith(".chatgpt.com")
  );
}

function isChatGptAuthMode(value: AuthMode): boolean {
  return value === "chatgpt" || value === "chatgptAuthTokens";
}
