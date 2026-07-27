import { resolve } from "node:path";
import type { AppConfig } from "../config/schema.js";
import type { InitializeParams, InitializeResponse } from "./generated/index.js";
import type { AgentMessageDeltaNotification } from "./generated/v2/AgentMessageDeltaNotification.js";
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

export class CodexAppServerClient implements CodexPort {
  private readonly runLoginStatus: (signal: AbortSignal) => Promise<LoginStatusResult>;
  private readonly createTransport: () => Promise<JsonRpcLineTransport>;
  private readonly workspacePath: string;
  private readonly loginTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly turnInterruptGraceMs: number;
  private readonly hasInjectedLoginStatus: boolean;
  private readonly reasoningEfforts = new Map<string, "low" | "medium">();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingTurnStarts = new Set<PendingTurnStart>();
  private readonly earlyTurnEvents = new Map<string, EarlyTurnEvents>();
  private rpc: JsonRpcProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private startController: AbortController | undefined;
  private loginController: AbortController | undefined;
  private loginPromise: Promise<void> | undefined;
  private loginVerified = false;
  private lifecycleGeneration = 0;
  private stopping = false;
  private gameThreadId: string | undefined;
  private threadStarting = false;

  constructor(
    private readonly config: AppConfig,
    dependencies: CodexAppServerClientDependencies = {},
  ) {
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
  }

  async start(): Promise<void> {
    if (this.rpc) return;
    if (this.stopping) throw new Error("Codex app server is stopping");
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    const generation = ++this.lifecycleGeneration;
    const controller = new AbortController();
    this.startController = controller;
    const start = this.startInternal(generation, controller.signal);
    this.startPromise = start;
    try {
      await start;
    } finally {
      if (this.startPromise === start) this.startPromise = undefined;
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
    const hasChatGptLoginLine = status.stdout.split(/\r?\n/u).includes("Logged in using ChatGPT");
    if (status.exitCode !== 0 || !hasChatGptLoginLine) {
      throw loginError(status);
    }
  }

  private async startInternal(generation: number, signal: AbortSignal): Promise<void> {
    await this.assertChatGptLogin();

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
      rpc.onNotification((notification) => this.handleNotification(notification));
      rpc.onExit((error) => {
        this.failActiveTurns(error);
        if (this.rpc === rpc) this.rpc = undefined;
      });
      this.rpc = rpc;
      await rpc.request<InitializeResponse>("initialize", params);
      if (!this.isCurrent(generation)) throw new Error("Codex app server stopped during startup");
      rpc.notify("initialized", {});
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }

  async listModels(): Promise<string[]> {
    const models: string[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const params: ModelListParams = cursor === null ? {} : { cursor };
      const result = await this.requireRpc().request<ModelListResponse>("model/list", params);
      models.push(...result.data.map((model) => model.model));
      cursor = result.nextCursor;
      if (cursor === null) return models;
      if (seenCursors.has(cursor)) throw new Error("Codex model list repeated a cursor");
      seenCursors.add(cursor);
    }
    throw new Error("Codex model list exceeded the page limit");
  }

  async startThread(input: {
    cwd: string;
    model: string;
    reasoningEffort: "low" | "medium";
  }): Promise<string> {
    if (this.gameThreadId || this.threadStarting) {
      throw new Error("a Codex thread is already active for this game session");
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
      this.gameThreadId = result.thread.id;
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
      effort: this.reasoningEfforts.get(threadId) ?? this.config.codex.reasoningEffort,
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
    await this.rpc?.close();
    const starting = this.startPromise;
    if (starting) await starting.catch(() => undefined);
    const login = this.loginPromise;
    if (login) await login.catch(() => undefined);
    this.rpc = undefined;
    this.reasoningEfforts.clear();
    this.activeTurns.clear();
    this.pendingTurnStarts.clear();
    this.earlyTurnEvents.clear();
    this.gameThreadId = undefined;
    this.threadStarting = false;
    this.startController = undefined;
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
