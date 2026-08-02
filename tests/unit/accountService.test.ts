import { describe, expect, it, vi } from "vitest";
import {
  AccountService,
  type AccountAppServerPort,
  type AccountServerNotification,
} from "../../src/codex/accountService.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function createPort(
  overrides: Partial<AccountAppServerPort> = {},
): AccountAppServerPort & { emit(notification: AccountServerNotification): void } {
  const listeners = new Set<(notification: AccountServerNotification) => void>();
  return {
    startAccountSession: vi.fn(async () => undefined),
    readAccount: vi.fn(async () => ({ account: null, requiresOpenaiAuth: true })),
    startChatGptLogin: vi.fn(async () => ({
      type: "chatgpt" as const,
      loginId: "server-login-1",
      authUrl: "https://auth.openai.com/oauth/authorize?state=secret#private",
    })),
    cancelChatGptLogin: vi.fn(async () => ({ status: "canceled" as const })),
    subscribeAccountNotifications: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: vi.fn(async () => undefined),
    emit: (notification) => {
      for (const listener of listeners) listener(notification);
    },
    ...overrides,
  };
}

describe("AccountService", () => {
  it("reports signed out without exposing account details", async () => {
    const service = new AccountService(createPort());

    await expect(service.getAccount()).resolves.toEqual({ status: "signed_out" });
  });

  it("starts one ChatGPT browser login with an opaque public attempt ID", async () => {
    const port = createPort();
    const service = new AccountService(port, {
      now: () => 1_000,
      ttlMs: 60_000,
      createAttemptId: () => "opaque-attempt-7",
    });

    const attempt = await service.startChatGptLogin();

    expect(attempt).toEqual({
      attemptId: "opaque-attempt-7",
      expiresAt: 61_000,
      loginUrl: "https://auth.openai.com/oauth/authorize?state=secret#private",
    });
    await expect(service.getAccount()).resolves.toEqual({
      status: "pending",
      attemptId: "opaque-attempt-7",
      expiresAt: 61_000,
    });
    expect(port.startChatGptLogin).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("reports only signed-in ChatGPT state after a matching completion", async () => {
    const port = createPort({
      readAccount: vi.fn(async () => ({
        account: {
          type: "chatgpt" as const,
          email: "private@example.invalid",
          planType: "plus" as const,
        },
        requiresOpenaiAuth: true,
      })),
    });
    const service = new AccountService(port, {
      createAttemptId: () => "attempt-complete",
    });
    await service.startChatGptLogin();

    port.emit({
      method: "account/login/completed",
      params: { loginId: "server-login-1", success: true, error: null },
    });

    await expect(service.getAccount()).resolves.toEqual({
      status: "signed_in",
      auth: "chatgpt",
    });
    await service.stop();
  });

  it("reconciles saved ChatGPT authentication when the completion notification is missed", async () => {
    let signedIn = false;
    const port = createPort({
      readAccount: vi.fn(async () => ({
        account: signedIn
          ? {
              type: "chatgpt" as const,
              email: null,
              planType: "plus" as const,
            }
          : null,
        requiresOpenaiAuth: true,
      })),
    });
    const service = new AccountService(port, {
      createAttemptId: () => "attempt-missed-notification",
    });
    await service.startChatGptLogin();

    await expect(service.getAccount()).resolves.toMatchObject({ status: "pending" });
    signedIn = true;

    await expect(service.getAccount()).resolves.toEqual({
      status: "signed_in",
      auth: "chatgpt",
    });
    expect(port.readAccount).toHaveBeenCalledTimes(2);
    await service.stop();
  });

  it("keeps a pending login retryable after account status is temporarily unavailable", async () => {
    const readAccount = vi
      .fn<AccountAppServerPort["readAccount"]>()
      .mockRejectedValueOnce(new Error("transport timed out"))
      .mockResolvedValueOnce({
        account: {
          type: "chatgpt" as const,
          email: null,
          planType: "plus" as const,
        },
        requiresOpenaiAuth: true,
      });
    const service = new AccountService(createPort({ readAccount }), {
      createAttemptId: () => "attempt-transient-read",
    });
    await service.startChatGptLogin();

    await expect(service.getAccount()).resolves.toMatchObject({ status: "pending" });
    await expect(service.getAccount()).resolves.toEqual({
      status: "signed_in",
      auth: "chatgpt",
    });
    expect(readAccount).toHaveBeenCalledTimes(2);
    await service.stop();
  });

  it("cancels the current attempt idempotently", async () => {
    const port = createPort();
    const service = new AccountService(port, {
      createAttemptId: () => "attempt-cancel-0001",
    });
    await service.startChatGptLogin();

    await expect(service.cancelChatGptLogin("attempt-cancel-0001")).resolves.toEqual({
      status: "cancelled",
      attemptId: "attempt-cancel-0001",
    });
    await expect(service.cancelChatGptLogin("attempt-cancel-0001")).resolves.toEqual({
      status: "cancelled",
      attemptId: "attempt-cancel-0001",
    });
    await expect(service.getAccount()).resolves.toEqual({
      status: "cancelled",
      attemptId: "attempt-cancel-0001",
    });
    expect(port.cancelChatGptLogin).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("does not let an old cancel overwrite or orphan a newer attempt", async () => {
    const cancel = deferred<{ status: "canceled" }>();
    const cancelReached = deferred<void>();
    let loginNumber = 0;
    let attemptNumber = 0;
    const port = createPort({
      startChatGptLogin: vi.fn(async () => {
        loginNumber += 1;
        return {
          type: "chatgpt" as const,
          loginId: `server-login-${loginNumber}`,
          authUrl: `https://auth.openai.com/oauth/${loginNumber}`,
        };
      }),
      cancelChatGptLogin: vi.fn(() => {
        cancelReached.resolve();
        return cancel.promise;
      }),
    });
    const service = new AccountService(port, {
      createAttemptId: () => `attempt-generation-${++attemptNumber}`,
    });
    const first = await service.startChatGptLogin();

    const cancelling = service.cancelChatGptLogin(first.attemptId);
    await cancelReached.promise;
    const startingAgain = service.startChatGptLogin();
    await flushMicrotasks();

    expect(port.startChatGptLogin).toHaveBeenCalledTimes(1);
    cancel.resolve({ status: "canceled" });
    await expect(cancelling).resolves.toEqual({
      status: "cancelled",
      attemptId: "attempt-generation-1",
    });
    const second = await startingAgain;
    expect(second.attemptId).toBe("attempt-generation-2");
    await expect(service.getAccount()).resolves.toEqual({
      status: "pending",
      attemptId: "attempt-generation-2",
      expiresAt: second.expiresAt,
    });
    expect(port.startChatGptLogin).toHaveBeenCalledTimes(2);
    await service.stop();
  });

  it("does not let an old expiry overwrite or orphan a newer attempt", async () => {
    vi.useFakeTimers();
    try {
      let now = 5_000;
      const cancel = deferred<{ status: "canceled" }>();
      const cancelReached = deferred<void>();
      let loginNumber = 0;
      let attemptNumber = 0;
      const port = createPort({
        startChatGptLogin: vi.fn(async () => {
          loginNumber += 1;
          return {
            type: "chatgpt" as const,
            loginId: `server-login-${loginNumber}`,
            authUrl: `https://auth.openai.com/oauth/${loginNumber}`,
          };
        }),
        cancelChatGptLogin: vi.fn(() => {
          cancelReached.resolve();
          return cancel.promise;
        }),
      });
      const service = new AccountService(port, {
        now: () => now,
        ttlMs: 1_000,
        createAttemptId: () => `attempt-generation-${++attemptNumber}`,
      });
      await service.startChatGptLogin();

      now = 6_000;
      const expiring = service.getAccount();
      await cancelReached.promise;
      const startingAgain = service.startChatGptLogin();
      await flushMicrotasks();

      expect(port.startChatGptLogin).toHaveBeenCalledTimes(1);
      cancel.resolve({ status: "canceled" });
      await expect(expiring).resolves.toEqual({
        status: "expired",
        attemptId: "attempt-generation-1",
      });
      const second = await startingAgain;
      expect(second.attemptId).toBe("attempt-generation-2");
      await expect(service.getAccount()).resolves.toEqual({
        status: "pending",
        attemptId: "attempt-generation-2",
        expiresAt: 7_000,
      });
      expect(port.startChatGptLogin).toHaveBeenCalledTimes(2);
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles a successful late completion after cancel returned notFound", async () => {
    let signedIn = false;
    const port = createPort({
      cancelChatGptLogin: vi.fn(async () => ({ status: "notFound" as const })),
      readAccount: vi.fn(async () => ({
        account: signedIn
          ? {
              type: "chatgpt" as const,
              email: null,
              planType: "plus" as const,
            }
          : null,
        requiresOpenaiAuth: true,
      })),
    });
    const service = new AccountService(port, {
      createAttemptId: () => "attempt-reconcile-01",
    });
    await service.startChatGptLogin();
    await service.cancelChatGptLogin("attempt-reconcile-01");

    signedIn = true;
    port.emit({
      method: "account/login/completed",
      params: { loginId: "server-login-1", success: true, error: null },
    });

    await expect(service.getAccount()).resolves.toEqual({
      status: "signed_in",
      auth: "chatgpt",
    });
    expect(port.readAccount).toHaveBeenCalled();
    await service.stop();
  });

  it("reconciles ChatGPT account updates after an expired attempt", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      let signedIn = false;
      const port = createPort({
        readAccount: vi.fn(async () => ({
          account: signedIn
            ? {
                type: "chatgpt" as const,
                email: null,
                planType: "plus" as const,
              }
            : null,
          requiresOpenaiAuth: true,
        })),
      });
      const service = new AccountService(port, {
        now: () => now,
        ttlMs: 1_000,
        createAttemptId: () => "attempt-reconcile-02",
      });
      await service.startChatGptLogin();
      now = 11_000;
      await vi.advanceTimersByTimeAsync(1_000);

      signedIn = true;
      port.emit({
        method: "account/updated",
        params: { authMode: "chatgpt", planType: "plus" },
      });

      await expect(service.getAccount()).resolves.toEqual({
        status: "signed_in",
        auth: "chatgpt",
      });
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences a login start that completes after the service stops", async () => {
    const login = deferred<{
      type: "chatgpt";
      loginId: string;
      authUrl: string;
    }>();
    const loginReached = deferred<void>();
    const port = createPort({
      startChatGptLogin: vi.fn(() => {
        loginReached.resolve();
        return login.promise;
      }),
    });
    const service = new AccountService(port, {
      createAttemptId: () => "attempt-stopped-0001",
    });

    const starting = service.startChatGptLogin();
    await loginReached.promise;
    await service.stop();
    login.resolve({
      type: "chatgpt",
      loginId: "server-login-late",
      authUrl: "https://auth.openai.com/oauth/late",
    });

    await expect(starting).rejects.toThrow("Account service is stopped");
    expect(port.cancelChatGptLogin).toHaveBeenCalledWith("server-login-late");
    await expect(service.startChatGptLogin()).rejects.toThrow("Account service is stopped");
  });

  it("shares a concurrent cancel race and contacts the app server once", async () => {
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const port = createPort({
      cancelChatGptLogin: vi.fn(async () => {
        await cancelGate;
        return { status: "canceled" as const };
      }),
    });
    const service = new AccountService(port, {
      createAttemptId: () => "attempt-concurrent-01",
    });
    await service.startChatGptLogin();

    const first = service.cancelChatGptLogin("attempt-concurrent-01");
    const second = service.cancelChatGptLogin("attempt-concurrent-01");
    releaseCancel();

    await expect(first).resolves.toEqual({
      status: "cancelled",
      attemptId: "attempt-concurrent-01",
    });
    await expect(second).resolves.toEqual({
      status: "cancelled",
      attemptId: "attempt-concurrent-01",
    });
    expect(port.cancelChatGptLogin).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("expires the current attempt and cancels its server login once", async () => {
    vi.useFakeTimers();
    try {
      let now = 2_000;
      const port = createPort();
      const service = new AccountService(port, {
        now: () => now,
        ttlMs: 1_000,
        createAttemptId: () => "attempt-expired-001",
      });
      await service.startChatGptLogin();

      now = 3_000;
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(service.getAccount()).resolves.toEqual({
        status: "expired",
        attemptId: "attempt-expired-001",
      });
      expect(port.cancelChatGptLogin).toHaveBeenCalledTimes(1);
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects API-key account state without exposing credentials or server text", async () => {
    const port = createPort({
      readAccount: vi.fn(async () => ({
        account: { type: "apiKey" as const },
        requiresOpenaiAuth: true,
      })),
    });
    const service = new AccountService(port);

    await expect(service.getAccount()).rejects.toThrow("ChatGPT authentication is required");
  });

  it.each([
    "http://auth.openai.com/oauth",
    "https://user:@auth.openai.com/oauth",
    "https://auth.openai.com:443/oauth",
    "https://auth.openai.com\\@evil.test/oauth",
    "https://openai.com.evil.test/oauth",
    "https://auth.openai.com/%2e%2e/oauth",
  ])("rejects an unsafe login URL without echoing it: %s", async (authUrl) => {
    const port = createPort({
      startChatGptLogin: vi.fn(async () => ({
        type: "chatgpt" as const,
        loginId: "server-login-secret",
        authUrl,
      })),
    });
    const service = new AccountService(port);

    const error = await service.startChatGptLogin().catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Codex returned an invalid ChatGPT login");
    expect((error as Error).message).not.toContain(authUrl);
    expect((error as Error).message).not.toContain("server-login-secret");
  });

  it("rejects non-ChatGPT login responses and never creates an attempt", async () => {
    const port = createPort({
      startChatGptLogin: vi.fn(async () => ({ type: "apiKey" as const })),
    });
    const service = new AccountService(port);

    await expect(service.startChatGptLogin()).rejects.toThrow(
      "Codex returned an invalid ChatGPT login",
    );
    await expect(service.getAccount()).resolves.toEqual({ status: "signed_out" });
  });
});
