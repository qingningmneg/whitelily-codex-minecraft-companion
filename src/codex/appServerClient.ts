import { resolve } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config/schema.js";
import type { InitializeParams, InitializeResponse } from "./generated/index.js";
import type { AgentMessageDeltaNotification } from "./generated/v2/AgentMessageDeltaNotification.js";
import type { CancelLoginAccountResponse } from "./generated/v2/CancelLoginAccountResponse.js";
import type { GetAccountResponse } from "./generated/v2/GetAccountResponse.js";
import type { LoginAccountResponse } from "./generated/v2/LoginAccountResponse.js";
import type { Model } from "./generated/v2/Model.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import type { ModelListParams } from "./generated/v2/ModelListParams.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { TurnCompletedNotification } from "./generated/v2/TurnCompletedNotification.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { TurnInterruptResponse } from "./generated/v2/TurnInterruptResponse.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";
import type { CodexPort, CodexTurnResult } from "./codexPort.js";
import type { AccountServerNotification, AccountAppServerPort } from "./accountService.js";
import {
  JsonRpcProcess,
  runCodexLoginStatus,
  spawnCodexAppServerTransport,
  type JsonRpcLineTransport,
  type JsonRpcMessage,
  type LoginStatusResult,
} from "./jsonRpcProcess.js";

export type { LoginStatusResult } from "./jsonRpcProcess.js";

const loginRefusal =
  "Codex must be signed in with ChatGPT. API-key billing is disabled for WhiteLily.";
const MAX_MODEL_PAGES = 100;
const MAX_MODEL_RECORDS = 256;

const wellFormedString = (maxCodePoints: number) =>
  z
    .string()
    .refine((value) => value === value.toWellFormed())
    .refine((value) => Array.from(value).length <= maxCodePoints);
const internalLoginIdSchema = wellFormedString(512).refine(
  (value) => value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value),
);
const authModeSchema = z.enum([
  "apikey",
  "chatgpt",
  "chatgptAuthTokens",
  "headers",
  "agentIdentity",
  "personalAccessToken",
  "bedrockApiKey",
]);
const planTypeSchema = z.enum([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);
const accountLoginCompletedNotificationSchema = z
  .object({
    method: z.literal("account/login/completed"),
    params: z
      .object({
        loginId: internalLoginIdSchema.nullable(),
        success: z.boolean(),
        error: wellFormedString(1_024).nullable(),
      })
      .strict(),
  })
  .strict();
const accountUpdatedNotificationSchema = z
  .object({
    method: z.literal("account/updated"),
    params: z
      .object({
        authMode: authModeSchema.nullable(),
        planType: planTypeSchema.nullable(),
      })
      .strict(),
  })
  .strict();

function parseAccountNotification(value: unknown): AccountServerNotification | undefined {
  const loginCompleted = accountLoginCompletedNotificationSchema.safeParse(value);
  if (loginCompleted.success) return loginCompleted.data;
  const accountUpdated = accountUpdatedNotificationSchema.safeParse(value);
  return accountUpdated.success ? accountUpdated.data : undefined;
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
  text: string;
  resolve(result: CodexTurnResult): void;
  reject(reason: Error): void;
  watchdog?: ReturnType<typeof setTimeout>;
  interruptGraceWatchdog?: ReturnType<typeof setTimeout>;
}

interface EarlyTurnEvents {
  text: string;
  status?: CodexTurnResult["status"];
}

interface PendingTurnStart {
  reject(reason: Error): void;
}

export interface CodexAppServerClientDependencies {
  runLoginStatus?: (signal: AbortSignal) => Promise<LoginStatusResult>;
  createTransport?: () => Promise<JsonRpcLineTransport>;
  workspacePath?: string;
  loginTimeoutMs?: number;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  turnInterruptGraceMs?: number;
}

function timeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolveResult, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error("login status timed out"));
    }, milliseconds);
    void operation.then(
      (result) => {
        clearTimeout(timer);
        resolveResult(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("operation aborted"));
  return new Promise<T>((resolveResult, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolveResult(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function loginError(result?: LoginStatusResult): Error {
  const details = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  const doctorHint = /access denied|permission denied|eacces/i.test(details)
    ? " Run scripts\\doctor.ps1 to verify local Codex access."
    : "";
  return new Error(`${loginRefusal}${doctorHint}`);
}

function finalStatus(value: unknown): CodexTurnResult["status"] | undefined {
  return value === "completed" || value === "failed" || value === "interrupted" ? value : undefined;
}

function positiveTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}`);
  return value;
}

export class CodexAppServerClient implements CodexPort, AccountAppServerPort {
  private readonly runLoginStatus: (signal: AbortSignal) => Promise<LoginStatusResult>;
  private readonly createTransport: () => Promise<JsonRpcLineTransport>;
  private workspacePath: string;
  private defaultReasoningEffort: string;
  private readonly loginTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly turnInterruptGraceMs: number;
  private readonly hasInjectedLoginStatus: boolean;
  private readonly reasoningEfforts = new Map<string, string>();
  private readonly accountNotificationListeners = new Set<
    (notification: AccountServerNotification) => void
  >();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingTurnStarts = new Set<PendingTurnStart>();
  private readonly earlyTurnEvents = new Map<string, EarlyTurnEvents>();
  private rpc: JsonRpcProcess | undefined;
  private startingRpc: { generation: number; rpc: JsonRpcProcess } | undefined;
  private startPromise: Promise<void> | undefined;
  private accountStartPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private startController: AbortController | undefined;
  private loginController: AbortController | undefined;
  private loginPromise: Promise<void> | undefined;
  private loginVerified = false;
  private lifecycleGeneration = 0;
  private stopping = false;
  private hasGameThreads = false;
  private threadStarting = false;

  constructor(config: AppConfig | undefined, dependencies: CodexAppServerClientDependencies = {}) {
    this.loginTimeoutMs = positiveTimeout(dependencies.loginTimeoutMs ?? 10_000, "login timeout");
    this.requestTimeoutMs = positiveTimeout(
      dependencies.requestTimeoutMs ?? 30_000,
      "request timeout",
    );
    this.turnTimeoutMs = positiveTimeout(dependencies.turnTimeoutMs ?? 5 * 60_000, "turn timeout");
    this.turnInterruptGraceMs = positiveTimeout(
      dependencies.turnInterruptGraceMs ?? 5_000,
      "turn interrupt grace",
    );
    this.hasInjectedLoginStatus = dependencies.runLoginStatus !== undefined;
    this.runLoginStatus =
      dependencies.runLoginStatus ??
      ((signal) => runCodexLoginStatus(undefined, this.loginTimeoutMs, undefined, signal));
    this.createTransport =
      dependencies.createTransport ?? (async () => spawnCodexAppServerTransport());
    this.workspacePath = dependencies.workspacePath ?? resolve(process.cwd(), "codex-workspace");
    this.defaultReasoningEffort = config?.codex.reasoningEffort ?? "medium";
  }

  configureRuntime(options: { workspacePath: string; reasoningEffort: string }): void {
    if (this.activeTurns.size > 0 || this.hasGameThreads || this.threadStarting) {
      throw new Error("Codex runtime settings cannot change during an active session");
    }
    this.workspacePath = resolve(options.workspacePath);
    this.defaultReasoningEffort = options.reasoningEffort;
  }

  async start(): Promise<void> {
    if (this.stopping) throw new Error("Codex app server is stopping");
    if (this.startPromise) return this.startPromise;
    const start = (async (): Promise<void> => {
      await this.assertChatGptLogin();
      await this.startAccountSession();
    })();
    this.startPromise = start;
    try {
      await start;
    } finally {
      if (this.startPromise === start) this.startPromise = undefined;
    }
  }

  async startAccountSession(): Promise<void> {
    if (this.stopping) throw new Error("Codex app server is stopping");
    if (this.accountStartPromise) return this.accountStartPromise;
    if (this.rpc) return;
    this.stopping = false;
    const generation = ++this.lifecycleGeneration;
    const controller = new AbortController();
    this.startController = controller;
    const connecting = this.startInternal(generation, controller.signal);
    this.accountStartPromise = connecting;
    try {
      await connecting;
    } finally {
      if (this.accountStartPromise === connecting) this.accountStartPromise = undefined;
      if (this.startController === controller) this.startController = undefined;
    }
  }

  assertChatGptLogin(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("Codex app server is stopping"));
    if (this.loginVerified) return Promise.resolve();
    if (this.loginPromise) return this.loginPromise;
    const controller = new AbortController();
    this.loginController = controller;
    const checking = this.verifyChatGptLogin(controller.signal);
    this.loginPromise = checking;
    void checking.then(
      () => {
        this.loginVerified = true;
        if (this.loginPromise === checking) this.loginPromise = undefined;
        if (this.loginController === controller) this.loginController = undefined;
      },
      () => {
        if (this.loginPromise === checking) this.loginPromise = undefined;
        if (this.loginController === controller) this.loginController = undefined;
      },
    );
    return checking;
  }

  private async verifyChatGptLogin(signal: AbortSignal): Promise<void> {
    let status: LoginStatusResult;
    let timedOut = false;
    try {
      const loginStatus = this.runLoginStatus(signal);
      const abortableStatus = abortable(loginStatus, signal);
      const checkedStatus = this.hasInjectedLoginStatus
        ? timeout(abortableStatus, this.loginTimeoutMs, () => {
            timedOut = true;
            if (this.loginController?.signal === signal) this.loginController.abort();
          })
        : abortableStatus;
      status = await checkedStatus;
    } catch {
      if (signal.aborted && !timedOut) {
        throw new Error("Codex app server stopped during startup");
      }
      throw loginError();
    }
    const statusLines = [status.stdout, status.stderr].flatMap((output) => output.split(/\r?\n/u));
    const hasChatGptLoginLine = statusLines.includes("Logged in using ChatGPT");
    const hasApiKeyLoginLine = statusLines.includes("Logged in using an API key");
    if (status.exitCode !== 0 || !hasChatGptLoginLine || hasApiKeyLoginLine) {
      throw loginError(status);
    }
  }

  private async startInternal(generation: number, signal: AbortSignal): Promise<void> {
    if (!this.isCurrent(generation)) throw new Error("Codex app server stopped during startup");

    const creatingTransport = this.createTransport();
    let transport: JsonRpcLineTransport;
    try {
      transport = await abortable(creatingTransport, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      void creatingTransport
        .then(async (lateTransport) => {
          await lateTransport.close();
        })
        .catch(() => undefined);
      throw new Error("Codex app server stopped during startup");
    }
    if (!this.isCurrent(generation)) {
      await transport.close();
      throw new Error("Codex app server stopped during startup");
    }
    const rpc = new JsonRpcProcess(transport, { requestTimeoutMs: this.requestTimeoutMs });
    try {
      const params: InitializeParams = {
        clientInfo: { name: "whitelily-companion", title: null, version: "0.1.1" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      };
      rpc.onNotification((notification) => {
        if (this.rpc === rpc && this.isCurrent(generation)) {
          this.handleNotification(notification);
        }
      });
      rpc.onExit((error) => {
        if (this.rpc === rpc) this.failActiveTurns(error);
        if (this.rpc === rpc) this.rpc = undefined;
        if (this.startingRpc?.rpc === rpc) this.startingRpc = undefined;
      });
      this.startingRpc = { generation, rpc };
      await rpc.request<InitializeResponse>("initialize", params);
      if (
        !this.isCurrent(generation) ||
        this.startingRpc?.generation !== generation ||
        this.startingRpc.rpc !== rpc
      ) {
        throw new Error("Codex app server stopped during startup");
      }
      this.startingRpc = undefined;
      this.rpc = rpc;
      rpc.notify("initialized", {});
    } catch (error) {
      if (this.startingRpc?.rpc === rpc) this.startingRpc = undefined;
      if (this.rpc === rpc) this.rpc = undefined;
      await rpc.close();
      throw error;
    }
  }

  async listModels(): Promise<string[]> {
    return (await this.listModelRecords()).map((model) => model.model);
  }

  async validateModelSelection(selection: {
    modelId: string;
    reasoningEffort: string;
  }): Promise<boolean> {
    const records = await this.listModelRecords();
    return records.some(
      (record) =>
        !record.hidden &&
        record.model === selection.modelId &&
        record.supportedReasoningEfforts.some(
          (option) => option.reasoningEffort === selection.reasoningEffort,
        ),
    );
  }

  async listModelRecords(): Promise<Model[]> {
    await this.startAccountSession();
    const rpc = this.requireRpc();
    const records: Model[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const params: ModelListParams = cursor === null ? {} : { cursor };
      const result = await rpc.request<ModelListResponse>("model/list", params);
      const remaining = MAX_MODEL_RECORDS - records.length;
      records.push(...result.data.slice(0, remaining));
      if (records.length >= MAX_MODEL_RECORDS) return records;
      cursor = result.nextCursor;
      if (cursor === null) return records;
      if (seenCursors.has(cursor)) throw new Error("Codex model list repeated a cursor");
      seenCursors.add(cursor);
    }
    throw new Error("Codex model list exceeded the page limit");
  }

  async readAccount(): Promise<GetAccountResponse> {
    await this.startAccountSession();
    return this.requireRpc().request<GetAccountResponse>("account/read", {});
  }

  async startChatGptLogin(): Promise<LoginAccountResponse> {
    await this.startAccountSession();
    return this.requireRpc().request<LoginAccountResponse>("account/login/start", {
      type: "chatgpt",
    });
  }

  async cancelChatGptLogin(loginId: string): Promise<CancelLoginAccountResponse> {
    await this.startAccountSession();
    return this.requireRpc().request<CancelLoginAccountResponse>("account/login/cancel", {
      loginId,
    });
  }

  subscribeAccountNotifications(
    listener: (notification: AccountServerNotification) => void,
  ): () => void {
    this.accountNotificationListeners.add(listener);
    return () => this.accountNotificationListeners.delete(listener);
  }

  async startThread(input: {
    cwd: string;
    model: string;
    reasoningEffort: string;
  }): Promise<string> {
    if (this.threadStarting) {
      throw new Error("a Codex thread is already starting for this game session");
    }
    this.threadStarting = true;
    const params: ThreadStartParams = {
      model: input.model,
      cwd: this.workspacePath,
      sandbox: "read-only",
      approvalPolicy: "never",
    };
    try {
      const result = await this.requireRpc().request<ThreadStartResponse>("thread/start", params);
      this.hasGameThreads = true;
      this.reasoningEfforts.set(result.thread.id, input.reasoningEffort);
      return result.thread.id;
    } finally {
      this.threadStarting = false;
    }
  }

  sendTurn(
    threadId: string,
    text: string,
    onStarted?: (turnId: string) => void,
  ): Promise<CodexTurnResult> {
    const params: TurnStartParams = {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      effort: this.reasoningEfforts.get(threadId) ?? this.defaultReasoningEffort,
    };
    return new Promise<CodexTurnResult>((resolveResult, reject) => {
      const pending: PendingTurnStart = { reject };
      this.pendingTurnStarts.add(pending);
      let start: Promise<TurnStartResponse>;
      try {
        start = this.requireRpc().request<TurnStartResponse>("turn/start", params);
      } catch (error) {
        this.pendingTurnStarts.delete(pending);
        reject(error instanceof Error ? error : new Error("Codex app server is stopped"));
        return;
      }
      void start.then(
        (started) => {
          this.pendingTurnStarts.delete(pending);
          if (this.stopping) {
            reject(new Error("Codex app server stopped"));
            return;
          }
          const turnId = started.turn.id;
          try {
            onStarted?.(turnId);
          } catch (error) {
            reject(error instanceof Error ? error : new Error("turn-start callback failed"));
            return;
          }
          const active: ActiveTurn = { threadId, turnId, text: "", resolve: resolveResult, reject };
          active.watchdog = setTimeout(() => this.handleTurnTimeout(active), this.turnTimeoutMs);
          active.watchdog.unref?.();
          this.activeTurns.set(turnId, active);
          const early = this.earlyTurnEvents.get(turnId);
          if (!early) return;
          active.text = early.text;
          this.earlyTurnEvents.delete(turnId);
          if (early.status) this.completeTurn(active, early.status);
        },
        (error: unknown) => {
          this.pendingTurnStarts.delete(pending);
          reject(error instanceof Error ? error : new Error("Codex app-server request failed"));
        },
      );
    });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    const params: TurnInterruptParams = { threadId, turnId };
    await this.requireRpc().request<TurnInterruptResponse>("turn/interrupt", params);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const stopping = this.stopInternal();
    this.stopPromise = stopping;
    void stopping.then(
      () => {
        if (this.stopPromise === stopping) this.stopPromise = undefined;
      },
      () => undefined,
    );
    return stopping;
  }

  private async stopInternal(): Promise<void> {
    this.stopping = true;
    this.lifecycleGeneration += 1;
    this.startController?.abort();
    this.loginController?.abort();
    const readyRpc = this.rpc;
    const initializingRpc = this.startingRpc?.rpc;
    const closeResults = await Promise.allSettled(
      [...new Set([readyRpc, initializingRpc].filter((rpc) => rpc !== undefined))].map((rpc) =>
        rpc.close(),
      ),
    );
    const accountStarting = this.accountStartPromise;
    if (accountStarting) await accountStarting.catch(() => undefined);
    const starting = this.startPromise;
    if (starting) await starting.catch(() => undefined);
    const login = this.loginPromise;
    if (login) await login.catch(() => undefined);
    const closeFailure = closeResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (closeFailure) throw closeFailure.reason;
    this.rpc = undefined;
    this.startingRpc = undefined;
    this.reasoningEfforts.clear();
    this.activeTurns.clear();
    this.pendingTurnStarts.clear();
    this.earlyTurnEvents.clear();
    this.hasGameThreads = false;
    this.threadStarting = false;
    this.startController = undefined;
    this.accountStartPromise = undefined;
    this.loginPromise = undefined;
    this.loginController = undefined;
    this.loginVerified = false;
    this.stopping = false;
  }

  private isCurrent(generation: number): boolean {
    return !this.stopping && generation === this.lifecycleGeneration;
  }

  private requireRpc(): JsonRpcProcess {
    if (!this.rpc) throw new Error("Codex app server has not started");
    return this.rpc;
  }

  private handleNotification(notification: JsonRpcMessage): void {
    if (!("method" in notification)) return;
    if (
      notification.method === "account/login/completed" ||
      notification.method === "account/updated"
    ) {
      const accountNotification = parseAccountNotification(notification);
      if (!accountNotification) return;
      for (const listener of this.accountNotificationListeners) {
        try {
          listener(accountNotification);
        } catch {
          // Authentication observers cannot interfere with the app-server transport.
        }
      }
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const params = notification.params as AgentMessageDeltaNotification;
      if (typeof params.turnId !== "string" || typeof params.delta !== "string") return;
      const active = this.activeTurns.get(params.turnId);
      if (active) {
        active.text += params.delta;
      } else {
        const early = this.earlyTurnEvents.get(params.turnId) ?? { text: "" };
        early.text += params.delta;
        this.earlyTurnEvents.set(params.turnId, early);
      }
      return;
    }
    if (notification.method === "turn/completed") {
      const params = notification.params as TurnCompletedNotification;
      const status = finalStatus(params.turn?.status);
      if (typeof params.turn?.id !== "string" || !status) return;
      const active = this.activeTurns.get(params.turn.id);
      if (active) {
        this.completeTurn(active, status);
      } else {
        const early = this.earlyTurnEvents.get(params.turn.id) ?? { text: "" };
        early.status = status;
        this.earlyTurnEvents.set(params.turn.id, early);
      }
    }
  }

  private completeTurn(active: ActiveTurn, status: CodexTurnResult["status"]): void {
    this.activeTurns.delete(active.turnId);
    this.clearTurnWatchdogs(active);
    active.resolve({
      threadId: active.threadId,
      turnId: active.turnId,
      text: active.text,
      status,
    });
  }

  private failActiveTurns(error: Error): void {
    for (const pending of this.pendingTurnStarts) pending.reject(error);
    this.pendingTurnStarts.clear();
    for (const active of this.activeTurns.values()) {
      this.clearTurnWatchdogs(active);
      active.reject(error);
    }
    this.activeTurns.clear();
  }

  private handleTurnTimeout(active: ActiveTurn): void {
    if (this.activeTurns.get(active.turnId) !== active) return;
    if (active.watchdog) {
      clearTimeout(active.watchdog);
      delete active.watchdog;
    }
    void this.interrupt(active.threadId, active.turnId).catch(() => undefined);
    active.interruptGraceWatchdog = setTimeout(() => {
      if (this.activeTurns.get(active.turnId) !== active) return;
      this.activeTurns.delete(active.turnId);
      this.clearTurnWatchdogs(active);
      active.reject(new Error("Codex turn timed out"));
      const rpc = this.rpc;
      if (rpc) void rpc.close().catch(() => undefined);
    }, this.turnInterruptGraceMs);
    active.interruptGraceWatchdog.unref?.();
  }

  private clearTurnWatchdogs(active: ActiveTurn): void {
    if (active.watchdog) clearTimeout(active.watchdog);
    if (active.interruptGraceWatchdog) clearTimeout(active.interruptGraceWatchdog);
    delete active.watchdog;
    delete active.interruptGraceWatchdog;
  }
}
