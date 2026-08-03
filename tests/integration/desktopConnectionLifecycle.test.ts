import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSnapshot } from "../../src/codex/accountService.js";
import type { Model } from "../../src/codex/generated/v2/Model.js";
import {
  ModelCatalog,
  type ModelCatalogAccountPort,
  type ModelCatalogEvent,
  type ResolvedModelSelection,
} from "../../src/codex/modelCatalog.js";
import { DesktopChildServer } from "../../src/desktop/childServer.js";
import {
  DESKTOP_PROTOCOL_VERSION,
  parseDesktopEvent,
  parseDesktopRequest,
  parseDesktopResponse,
  type DesktopCommand,
  type DesktopEvent,
  type DesktopResponse,
} from "../../src/desktop/desktopProtocol.js";
import { projectDesktopConnectionLifecycle } from "../../apps/desktop/src/connectionLifecycle.js";
import { RuntimeFacade } from "../../src/runtime/runtimeFacade.js";
import type { RuntimeSnapshot } from "../../src/runtime/runtimeEvents.js";
import type { MinecraftEvent } from "../../src/minecraft/minecraftPort.js";
import type { TaskStopReason } from "../../src/safety/taskBudget.js";
import { LanDetector } from "../../apps/desktop/src-main/discovery/lanDetector.js";
import type { JavaListenerProbeRecord } from "../../apps/desktop/src-main/discovery/fixedWindowsProbe.js";

function liveModel(
  id: string,
  efforts: readonly string[],
  options: { isDefault?: boolean; defaultReasoningEffort?: string } = {},
): Model {
  return {
    id: `record-${id}`,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: `Live ${id}`,
    description: "Service-provided model",
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: `Service ${reasoningEffort}`,
    })),
    defaultReasoningEffort: options.defaultReasoningEffort ?? efforts[0] ?? "",
    inputModalities: ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: options.isDefault ?? false,
  };
}

function signedInAccount(): ModelCatalogAccountPort {
  let snapshot: AccountSnapshot = { status: "signed_in", auth: "chatgpt" };
  return {
    getAccount: async () => snapshot,
    subscribe: (listener) => {
      listener(snapshot);
      return () => {
        snapshot = { status: "signed_out" };
      };
    },
  };
}

const idleRuntime: RuntimeSnapshot = {
  revision: 0,
  lifecycle: "idle",
  minecraft: { state: "disconnected", sessionId: null },
  codex: { state: "stopped", model: null },
  task: null,
  lastError: null,
};

const servers: DesktopChildServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function request(id: string, command: DesktopCommand) {
  return parseDesktopRequest({
    version: DESKTOP_PROTOCOL_VERSION,
    id,
    command,
  });
}

function createProtocolHarness(options: {
  resolveSelection(): Promise<ResolvedModelSelection>;
  createRuntime(
    selection: ResolvedModelSelection,
    initialRevision: number,
  ): Promise<{ runtime: RuntimeFacade; stopReasons: TaskStopReason[] }>;
  subscribeAccount?(listener: (snapshot: AccountSnapshot) => void): () => void;
  subscribeModel?(listener: (event: ModelCatalogEvent) => void): () => void;
}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const responses: DesktopResponse[] = [];
  const events: DesktopEvent["event"][] = [];
  const waiters = new Map<string, (response: DesktopResponse) => void>();
  let buffered = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object") continue;
      if (Object.hasOwn(value, "event")) {
        events.push(parseDesktopEvent(value).event);
        continue;
      }
      if (!Object.hasOwn(value, "id")) continue;
      const response = parseDesktopResponse(value);
      responses.push(response);
      waiters.get(response.id)?.(response);
      waiters.delete(response.id);
    }
  });
  const selections: ResolvedModelSelection[] = [];
  const runtimes: Array<{ runtime: RuntimeFacade; stopReasons: TaskStopReason[] }> = [];
  const server = new DesktopChildServer({
    input,
    output,
    now: () => 1_000,
    ownerIdentity: {
      snapshot: () => ({
        revision: 0,
        ownerUsername: "HarnessOwner",
        configured: true,
        presence: "unknown",
      }),
      update: async () => ({
        revision: 0,
        ownerUsername: "HarnessOwner",
        configured: true,
        presence: "unknown",
      }),
      setPresence: () => undefined,
      subscribe: () => () => undefined,
    },
    account: {
      getAccount: async () => ({ status: "signed_in", auth: "chatgpt" }),
      startChatGptLogin: async () => ({
        attemptId: "attempt_live_1234",
        expiresAt: 60_000,
        loginUrl: "https://auth.openai.com/oauth",
      }),
      cancelChatGptLogin: async (attemptId) => ({ status: "cancelled", attemptId }),
      subscribe: options.subscribeAccount ?? (() => () => undefined),
      stop: async () => undefined,
    },
    models: {
      listModels: async () => ({
        models: [],
        selection: { mode: "automatic" },
        legacyMigrationCompleted: false,
      }),
      selectModel: async () => ({ mode: "automatic" }),
      prepareSelection: async (selection) => ({
        preferenceRevision: 0,
        requested: selection,
        resolved: await options.resolveSelection(),
      }),
      commitSelection: async (prepared) =>
        prepared.requested.mode === "automatic"
          ? { mode: "automatic" }
          : { ...prepared.requested, available: true },
      resolveRuntimeSelection: options.resolveSelection,
      subscribe: options.subscribeModel ?? (() => () => undefined),
      stop: () => undefined,
    },
    createRuntime: async (_connection, initialRevision, selection) => {
      selections.push(selection);
      const created = await options.createRuntime(selection, initialRevision);
      runtimes.push(created);
      return created.runtime;
    },
  });
  servers.push(server);
  server.start();
  const send = async (id: string, command: DesktopCommand): Promise<DesktopResponse> => {
    input.write(`${JSON.stringify(request(id, command))}\n`);
    const existing = responses.find((response) => response.id === id);
    if (existing) return existing;
    return new Promise((resolve) => waiters.set(id, resolve));
  };
  return { send, selections, runtimes, events };
}

function createTrackedRuntime(
  model: string,
  initialRevision = 0,
): { runtime: RuntimeFacade; stopReasons: TaskStopReason[] } {
  const stopReasons: TaskStopReason[] = [];
  const runtime = new RuntimeFacade({
    initialRevision,
    lifecycle: {
      start: async () => undefined,
      stop: async () => undefined,
    },
    task: {
      current: () => null,
      budget: () => ({
        active: false,
        stopReason: null,
        limits: {
          maxToolCalls: 1,
          maxBlockChanges: 1,
          maxHorizontalTravel: 1,
          maxDurationMs: 1,
          maxDangerousOperations: 0,
        },
        toolCalls: 0,
        blockChanges: 0,
        horizontalTravel: 0,
        dangerousOperations: 0,
        startedAt: null,
      }),
      stop: (reason) => stopReasons.push(reason),
    },
    codex: { model: () => model },
  });
  return { runtime, stopReasons };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("desktop connection lifecycle", () => {
  it("resolves automatic startup only from the live default model and its service default effort", async () => {
    const catalog = new ModelCatalog(
      {
        listModelRecords: async () => [
          liveModel("legacy-looking-first", ["low"]),
          liveModel("live-default", ["minimal", "xhigh"], {
            isDefault: true,
            defaultReasoningEffort: "xhigh",
          }),
        ],
      },
      signedInAccount(),
    );

    await catalog.selectModel({ mode: "automatic" });

    await expect(catalog.resolveRuntimeSelection()).resolves.toEqual({
      modelId: "live-default",
      reasoningEffort: "xhigh",
    });
  });

  it("preserves the exact explicitly selected live model and reasoning effort for startup", async () => {
    const catalog = new ModelCatalog(
      {
        listModelRecords: async () => [liveModel("live-explicit", ["minimal", "medium", "xhigh"])],
      },
      signedInAccount(),
    );
    await catalog.selectModel({
      mode: "explicit",
      modelId: "live-explicit",
      reasoningEffort: "minimal",
    });

    await expect(catalog.resolveRuntimeSelection()).resolves.toEqual({
      modelId: "live-explicit",
      reasoningEffort: "minimal",
    });
  });

  it("resolves the live selection immediately before runtime creation and passes it unchanged", async () => {
    const selection = { modelId: "live-runtime", reasoningEffort: "xhigh" } as const;
    const resolveSelection = vi.fn(async () => selection);
    const harness = createProtocolHarness({
      resolveSelection,
      createRuntime: async (resolved, initialRevision) =>
        createTrackedRuntime(resolved.modelId, initialRevision),
    });

    await expect(
      harness.send("confirm-live", {
        kind: "set_confirmed_connection",
        proof: {
          nonce: "proof_live_model_1234",
          port: 51_321,
          issuedAt: 1_000,
          expiresAt: 11_000,
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(harness.send("start-live", { kind: "start_runtime" })).resolves.toMatchObject({
      ok: true,
      result: { lifecycle: "running", codex: { model: "live-runtime" } },
    });

    expect(resolveSelection).toHaveBeenCalledOnce();
    expect(harness.selections).toEqual([selection]);
  });

  it("fences a running runtime on ChatGPT sign-out while retaining confirmed LAN recovery", async () => {
    let publishAccount: ((snapshot: AccountSnapshot) => void) | undefined;
    let accountAvailable = true;
    const harness = createProtocolHarness({
      resolveSelection: async () => {
        if (!accountAvailable) throw new Error("ChatGPT authentication is required");
        return { modelId: "live-runtime", reasoningEffort: "medium" };
      },
      createRuntime: async (selection, initialRevision) =>
        createTrackedRuntime(selection.modelId, initialRevision),
      subscribeAccount: (listener) => {
        publishAccount = listener;
        return () => {
          publishAccount = undefined;
        };
      },
    });
    await harness.send("confirm-account", {
      kind: "set_confirmed_connection",
      proof: {
        nonce: "proof_account_out_12",
        port: 51_321,
        issuedAt: 1_000,
        expiresAt: 11_000,
      },
    });
    await harness.send("start-account", { kind: "start_runtime" });

    accountAvailable = false;
    publishAccount?.({ status: "signed_out" });
    await vi.waitFor(() =>
      expect(harness.runtimes[0]?.runtime.snapshot().lifecycle).toBe("stopped"),
    );

    expect(harness.runtimes[0]?.stopReasons).toContain("model_unavailable");
    expect(harness.events).toContainEqual(
      expect.objectContaining({ kind: "connection_invalidated", reason: "account_lost" }),
    );
    await expect(
      harness.send("restart-account-without-confirm", { kind: "start_runtime" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "RUNTIME_START_FAILED" },
    });
    accountAvailable = true;
    publishAccount?.({ status: "signed_in", auth: "chatgpt" });
    await expect(
      harness.send("restart-account-after-login", { kind: "start_runtime" }),
    ).resolves.toMatchObject({ ok: true, result: { lifecycle: "running" } });
  });

  it("cancels an in-flight runtime start when account authority is lost", async () => {
    let publishAccount: ((snapshot: AccountSnapshot) => void) | undefined;
    let accountAvailable = true;
    const startGate = deferred();
    const harness = createProtocolHarness({
      resolveSelection: async () => {
        if (!accountAvailable) throw new Error("ChatGPT authentication is required");
        return { modelId: "live-runtime", reasoningEffort: "medium" };
      },
      createRuntime: async (selection, initialRevision) => {
        const tracked = createTrackedRuntime(selection.modelId, initialRevision);
        const runtime = new RuntimeFacade({
          initialRevision,
          lifecycle: {
            start: () => startGate.promise,
            stop: async () => undefined,
          },
          codex: { model: () => selection.modelId },
        });
        return { runtime, stopReasons: tracked.stopReasons };
      },
      subscribeAccount: (listener) => {
        publishAccount = listener;
        return () => {
          publishAccount = undefined;
        };
      },
    });
    await harness.send("confirm-inflight", {
      kind: "set_confirmed_connection",
      proof: {
        nonce: "proof_inflight_auth12",
        port: 51_321,
        issuedAt: 1_000,
        expiresAt: 11_000,
      },
    });

    const starting = harness.send("start-inflight", { kind: "start_runtime" });
    await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
    accountAvailable = false;
    publishAccount?.({ status: "signed_out" });
    startGate.resolve();

    await expect(starting).resolves.toMatchObject({
      ok: false,
      error: { code: "RUNTIME_START_FAILED" },
    });
    await expect(
      harness.send("restart-inflight-without-confirm", { kind: "start_runtime" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "RUNTIME_START_FAILED" },
    });
    accountAvailable = true;
    publishAccount?.({ status: "signed_in", auth: "chatgpt" });
    await expect(
      harness.send("restart-inflight-after-login", { kind: "start_runtime" }),
    ).resolves.toMatchObject({ ok: true, result: { lifecycle: "running" } });
  });

  it("fences a running runtime when the selected live model or effort becomes unavailable", async () => {
    let publishModelEvent: ((event: ModelCatalogEvent) => void) | undefined;
    let modelAvailable = true;
    const harness = createProtocolHarness({
      resolveSelection: async () => {
        if (!modelAvailable) throw new Error("Selected model is unavailable");
        return { modelId: "live-runtime", reasoningEffort: "minimal" };
      },
      createRuntime: async (selection, initialRevision) =>
        createTrackedRuntime(selection.modelId, initialRevision),
      subscribeModel: (listener) => {
        publishModelEvent = listener;
        return () => {
          publishModelEvent = undefined;
        };
      },
    });
    await harness.send("confirm-model", {
      kind: "set_confirmed_connection",
      proof: {
        nonce: "proof_model_gone_123",
        port: 51_321,
        issuedAt: 1_000,
        expiresAt: 11_000,
      },
    });
    await harness.send("start-model", { kind: "start_runtime" });

    modelAvailable = false;
    publishModelEvent?.({ kind: "selection_invalidated", reason: "model_unavailable" });
    await vi.waitFor(() =>
      expect(harness.runtimes[0]?.runtime.snapshot().lifecycle).toBe("stopped"),
    );

    expect(harness.runtimes[0]?.stopReasons).toContain("model_unavailable");
    expect(harness.events).toContainEqual(
      expect.objectContaining({ kind: "connection_invalidated", reason: "model_unavailable" }),
    );
    await expect(
      harness.send("restart-model-without-confirm", { kind: "start_runtime" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "RUNTIME_START_FAILED" },
    });
    modelAvailable = true;
    await expect(
      harness.send("restart-model-after-selection", { kind: "start_runtime" }),
    ).resolves.toMatchObject({ ok: true, result: { lifecycle: "running" } });
  });

  it("publishes world change as a disconnected authority boundary instead of reconnecting", async () => {
    let minecraftListener: ((event: MinecraftEvent) => void) | undefined;
    const events: import("../../src/runtime/runtimeEvents.js").RuntimeEvent[] = [];
    const stopReasons: TaskStopReason[] = [];
    const runtime = new RuntimeFacade({
      lifecycle: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      minecraft: {
        subscribe: (listener) => {
          minecraftListener = listener;
          return () => {
            minecraftListener = undefined;
          };
        },
      },
      task: {
        current: () => null,
        budget: () => ({
          active: false,
          stopReason: null,
          limits: {
            maxToolCalls: 1,
            maxBlockChanges: 1,
            maxHorizontalTravel: 1,
            maxDurationMs: 1,
            maxDangerousOperations: 0,
          },
          toolCalls: 0,
          blockChanges: 0,
          horizontalTravel: 0,
          dangerousOperations: 0,
          startedAt: null,
        }),
        stop: (reason) => stopReasons.push(reason),
      },
      codex: { model: () => "live-runtime" },
    });
    runtime.subscribe((event) => events.push(event));
    await runtime.start();

    minecraftListener?.({ kind: "world_changed" });

    expect(events.at(-1)).toMatchObject({
      kind: "minecraft",
      state: { state: "disconnected" },
    });
    expect(runtime.snapshot().minecraft.state).toBe("disconnected");
    expect(stopReasons).toEqual(["world_changed"]);
  });

  it("retires the runtime on a trusted LAN listener identity change and rejects restart", async () => {
    const harness = createProtocolHarness({
      resolveSelection: async () => ({ modelId: "live-runtime", reasoningEffort: "medium" }),
      createRuntime: async (selection, initialRevision) =>
        createTrackedRuntime(selection.modelId, initialRevision),
    });
    await harness.send("confirm-lan", {
      kind: "set_confirmed_connection",
      proof: {
        nonce: "proof_lan_changed_123",
        port: 51_321,
        issuedAt: 1_000,
        expiresAt: 11_000,
      },
    });
    await harness.send("start-lan", { kind: "start_runtime" });

    await expect(
      harness.send("invalidate-lan", {
        kind: "invalidate_connection",
        reason: "lan_changed",
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { lifecycle: "stopped" },
    });
    expect(harness.runtimes[0]?.stopReasons).toContain("disconnect");
    expect(harness.events).toContainEqual(
      expect.objectContaining({ kind: "connection_invalidated", reason: "lan_changed" }),
    );
    await expect(
      harness.send("restart-lan-without-confirm", { kind: "start_runtime" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "CONNECTION_OPERATION_FAILED" },
    });
  });

  it("detects a confirmed LAN port or process identity change on authoritative revalidation", async () => {
    let records: readonly JavaListenerProbeRecord[] = [
      {
        localAddress: "127.0.0.1",
        localPort: 51_321,
        pid: 4_200,
        processName: "javaw.exe",
        processStartedAt: 1_785_196_800_123,
        version: "1.21.5",
      },
    ];
    const detector = new LanDetector({
      probe: async () => ({ records, diagnostic: null }),
      now: () => 1_000,
      idFactory: () => "lan_confirmed_live1",
      nonceFactory: () => "proof_monitor_live_12",
    });
    const candidate = (await detector.detectLanCandidates())[0]!;
    await detector.confirmLanCandidate(candidate.id, async (proof) => ({
      status: "configured",
      port: proof.port,
      confirmedAt: proof.issuedAt,
    }));

    await expect(detector.validateConfirmedSession()).resolves.toBe(true);
    records = [{ ...records[0]!, localPort: 51_322 }];
    await expect(detector.validateConfirmedSession()).resolves.toBe(false);
    await expect(detector.validateConfirmedSession()).resolves.toBe(false);
  });

  it.each([
    {
      name: "idle",
      input: { runtime: idleRuntime },
      expected: "idle",
    },
    {
      name: "detecting",
      input: { runtime: idleRuntime, detecting: true },
      expected: "detecting",
    },
    {
      name: "awaiting confirmation",
      input: { runtime: idleRuntime, hasCandidates: true },
      expected: "awaiting_confirmation",
    },
    {
      name: "connecting",
      input: {
        runtime: {
          ...idleRuntime,
          lifecycle: "starting" as const,
          minecraft: { state: "connecting" as const, sessionId: null },
        },
      },
      expected: "connecting",
    },
    {
      name: "connected",
      input: {
        runtime: {
          ...idleRuntime,
          lifecycle: "running" as const,
          minecraft: { state: "connected" as const, sessionId: null },
        },
      },
      expected: "connected",
    },
    {
      name: "stopping",
      input: { runtime: { ...idleRuntime, lifecycle: "stopping" as const } },
      expected: "stopping",
    },
    {
      name: "failed",
      input: { runtime: { ...idleRuntime, lifecycle: "failed" as const } },
      expected: "failed",
    },
  ] as const)(
    "projects $name without changing the core runtime lifecycle",
    ({ input, expected }) => {
      expect(projectDesktopConnectionLifecycle(input)).toBe(expected);
    },
  );
});
