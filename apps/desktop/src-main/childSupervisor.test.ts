// @vitest-environment node

import { EventEmitter } from "node:events";
import { PassThrough, type Writable } from "node:stream";
import { win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_PROTOCOL_VERSION,
  MAX_DESKTOP_LINE_BYTES,
  parseDesktopRequest,
  type ConfirmedConnectionProof,
  type DesktopCommand,
  type DesktopEvent,
  type DesktopResponse,
} from "../../../src/desktop/desktopProtocol.js";
import {
  DesktopChildServer,
  type DesktopChildWorldProfileStore,
} from "../../../src/desktop/childServer.js";
import { RuntimeFacade } from "../../../src/runtime/runtimeFacade.js";
import type { RuntimeSnapshot } from "../../../src/runtime/runtimeEvents.js";
import { createDefaultCompanionProfile } from "../../../src/profile/profileSchema.js";
import type { RuntimeSafetyConfiguration } from "../../../src/safety/safetyProfile.js";
import type { ConfirmedWorldBinding, WorldProfile } from "../../../src/world/worldProfileStore.js";
import { resolveAppPaths } from "./appPaths.js";
import {
  ChildSupervisor,
  CommittedProfileMutationError,
  type ChildProcessPort,
  type SpawnChild,
} from "./childSupervisor.js";

const idleSnapshot: RuntimeSnapshot = {
  revision: 0,
  lifecycle: "idle",
  minecraft: { state: "disconnected", sessionId: null },
  codex: { state: "stopped", model: null },
  task: null,
  lastError: null,
};

class FakeChild extends EventEmitter implements ChildProcessPort {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: string[] = [];
  killCalls = 0;
  killResult = true;
  exitOnKill = false;
  alive = true;
  exited = false;
  closed = false;

  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => this.writes.push(chunk));
  }

  kill(): boolean {
    this.killCalls += 1;
    if (this.exitOnKill) this.crash();
    return this.killResult;
  }

  crash(code = 1): void {
    if (this.exited) return;
    this.alive = false;
    this.exited = true;
    this.emit("exit", code, null);
  }

  finishClose(code: number | null = this.exited ? 1 : null): void {
    if (this.closed) return;
    this.alive = false;
    this.closed = true;
    this.emit("close", code, null);
  }

  respond(response: DesktopResponse): void {
    this.stdout.write(`${JSON.stringify(response)}\n`);
  }

  requests() {
    return this.writes
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => parseDesktopRequest(JSON.parse(line)));
  }
}

type OutputWriteCallback = (error?: Error | null) => void;

class CallbackControlledOutput {
  readonly attempts: string[] = [];
  readonly #target: PassThrough;
  #nextGate:
    | {
        readonly entered: (line: string) => void;
        readonly matches: (line: string) => boolean;
        callback?: OutputWriteCallback;
      }
    | undefined;

  constructor(target: PassThrough) {
    this.#target = target;
  }

  gateNextResponseCallback(): Promise<string> {
    if (this.#nextGate) throw new Error("an output callback is already gated");
    return new Promise((resolve) => {
      this.#nextGate = {
        entered: resolve,
        matches: (line) => {
          try {
            const value: unknown = JSON.parse(line);
            return typeof value === "object" && value !== null && "id" in value;
          } catch {
            return false;
          }
        },
      };
    });
  }

  write(chunk: string | Uint8Array, callback?: OutputWriteCallback): boolean {
    const line = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    this.attempts.push(line);
    this.#target.write(chunk);
    const gate = this.#nextGate;
    if (gate?.matches(line)) {
      if (!callback) throw new Error("gated protocol output requires a callback");
      gate.callback = callback;
      gate.entered(line);
    } else {
      queueMicrotask(() => callback?.());
    }
    return true;
  }

  release(error?: Error): void {
    const gate = this.#nextGate;
    if (!gate?.callback) throw new Error("no output callback is ready to release");
    this.#nextGate = undefined;
    queueMicrotask(() => gate.callback?.(error));
  }

  releaseAll(): void {
    const gate = this.#nextGate;
    this.#nextGate = undefined;
    if (gate?.callback) queueMicrotask(() => gate.callback?.());
  }

  responseAttempts(id: string): unknown[] {
    return this.attempts
      .flatMap((attempt) => attempt.split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
      .filter(
        (value): value is { id: string } =>
          typeof value === "object" &&
          value !== null &&
          "id" in value &&
          (value as { id?: unknown }).id === id,
      );
  }
}

class PartialFakeChild extends EventEmitter implements ChildProcessPort {
  readonly stdin = new PassThrough();
  readonly stdout = null;
  readonly stderr = null;
  killCalls = 0;
  alive = true;
  closed = false;

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }

  finishClose(): void {
    if (this.closed) return;
    this.alive = false;
    this.closed = true;
    this.emit("close", null, null);
  }
}

function successResponse(id: string, snapshot: RuntimeSnapshot = idleSnapshot): DesktopResponse {
  return {
    version: DESKTOP_PROTOCOL_VERSION,
    id,
    ok: true,
    result: snapshot,
  };
}

function failureResponse(
  id: string,
  code: Exclude<
    Extract<DesktopResponse, { ok: false }>["error"]["code"],
    | "OWNER_IDENTITY_CONFIG_CONFLICT"
    | "OWNER_IDENTITY_CONFIG_INVALID"
    | "OWNER_IDENTITY_INVALID"
    | "OWNER_IDENTITY_REQUIRED"
    | "OWNER_IDENTITY_WRITE_FAILED"
    | "PROFILE_RUNTIME_CONTAINMENT_FAILED"
  >,
): DesktopResponse {
  return {
    version: DESKTOP_PROTOCOL_VERSION,
    id,
    ok: false,
    error: {
      code,
      message: "The child could not prove authority containment",
    },
  };
}

function committedProfileEnvelope(
  revision = 1,
  overrides: Partial<ReturnType<typeof createDefaultCompanionProfile>> = {},
) {
  return {
    schemaVersion: 1 as const,
    revision,
    updatedAt: "2026-07-29T01:02:03.004Z",
    value: {
      ...createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99"),
      ...overrides,
    },
  };
}

function containmentFailureResponse(
  id: string,
  committed: ReturnType<typeof committedProfileEnvelope>,
): DesktopResponse {
  return {
    version: DESKTOP_PROTOCOL_VERSION,
    id,
    ok: false,
    error: {
      code: "PROFILE_RUNTIME_CONTAINMENT_FAILED",
      message: "Profile committed but runtime containment failed",
      committed,
    },
  };
}

function runtimeSnapshot(
  revision: number,
  lifecycle: RuntimeSnapshot["lifecycle"],
): RuntimeSnapshot {
  return {
    ...idleSnapshot,
    revision,
    lifecycle,
  };
}

function writeLifecycleEvent(
  child: FakeChild,
  revision: number,
  state: RuntimeSnapshot["lifecycle"] = "starting",
): void {
  child.stdout.write(
    `${JSON.stringify({
      version: DESKTOP_PROTOCOL_VERSION,
      event: { kind: "lifecycle", revision, state },
    })}\n`,
  );
}

function writeOwnerIdentityEvent(
  child: FakeChild,
  owner: {
    readonly revision: number;
    readonly ownerUsername: string;
    readonly presence: "online" | "offline" | "unknown";
  },
): void {
  child.stdout.write(
    `${JSON.stringify({
      version: DESKTOP_PROTOCOL_VERSION,
      event: {
        kind: "owner_identity",
        owner: {
          ...owner,
          configured: true,
        },
      },
    })}\n`,
  );
}

function caught<T>(promise: Promise<T>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

function createHarness(
  options: { development?: boolean; onSpawn?: (child: FakeChild) => void } = {},
) {
  const children: FakeChild[] = [];
  const spawnCalls: Parameters<SpawnChild>[] = [];
  const spawn: SpawnChild = (...args) => {
    if (children.some((child) => child.alive)) {
      throw new Error("test observed two alive WhiteLily children");
    }
    spawnCalls.push(args);
    const child = new FakeChild();
    children.push(child);
    options.onSpawn?.(child);
    return child;
  };
  const supervisor = new ChildSupervisor({
    childEntry: String.raw`C:\Program Files\WhiteLily\resources\childMain.js`,
    configPath: String.raw`C:\LocalAppData\owner\WhiteLily\config.toml`,
    workingDirectory: String.raw`C:\LocalAppData\owner\WhiteLily`,
    environment: {
      LOCALAPPDATA: String.raw`C:\LocalAppData\owner`,
      WHITELILY_DATA_ROOT: String.raw`C:\LocalAppData\owner\WhiteLily`,
    },
    development: options.development ?? true,
    spawn,
  });
  return { children, spawnCalls, supervisor };
}

interface ServerBackedWorldHarness {
  readonly binding: ConfirmedWorldBinding;
  readonly child: FakeChild;
  readonly output: CallbackControlledOutput;
  readonly safetyConfigurations: RuntimeSafetyConfiguration[];
  readonly server: DesktopChildServer;
  readonly supervisor: ChildSupervisor;
}

const openServerBackedWorldHarnesses: ServerBackedWorldHarness[] = [];

function createServerBackedWorldHarness(): ServerBackedWorldHarness {
  const proof: ConfirmedConnectionProof = {
    nonce: "correlated_world_proof_0001",
    port: 25565,
    issuedAt: 10,
    expiresAt: 9_999,
  };
  const binding: ConfirmedWorldBinding = {
    canonicalInstancePath: "C:/Minecraft/Instance",
    javaSession: {
      pid: 1234,
      processStartedAt: 10,
      port: 25565,
      version: "1.21.5",
    },
    ownerUsername: "Owner",
    proof,
  };
  let revision = 0;
  let profile: WorldProfile | null = null;
  const worldProfiles: DesktopChildWorldProfileStore = {
    read: async () => ({
      schemaVersion: 1,
      revision,
      updatedAt: "2026-07-29T00:00:00.000Z",
      value: profile === null ? null : structuredClone(profile),
    }),
    bindConfirmedWorld: async (expectedRevision, _binding, label) => {
      if (expectedRevision !== revision) throw new Error("unexpected world revision");
      revision += 1;
      profile = {
        id: "be176ae1-a4b4-4fd6-b04c-89634cd74a99",
        label,
        instanceFingerprint: "f".repeat(43),
        ownerUsername: "Owner",
        safetyPreset: "standard",
      };
      return {
        schemaVersion: 1,
        revision,
        updatedAt: "2026-07-29T00:00:01.000Z",
        value: structuredClone(profile),
      };
    },
    updateSafetyProfile: async (expectedRevision, safetyPreset) => {
      if (expectedRevision !== revision || profile === null) {
        throw new Error("unexpected world revision");
      }
      revision += 1;
      profile = { ...profile, safetyPreset };
      return {
        schemaVersion: 1,
        revision,
        updatedAt: "2026-07-29T00:00:02.000Z",
        value: structuredClone(profile),
      };
    },
  };
  const safetyConfigurations: RuntimeSafetyConfiguration[] = [];
  let child: FakeChild | undefined;
  let output: CallbackControlledOutput | undefined;
  let server: DesktopChildServer | undefined;
  const { supervisor } = createHarness({
    onSpawn: (spawnedChild) => {
      child = spawnedChild;
      output = new CallbackControlledOutput(spawnedChild.stdout);
      server = new DesktopChildServer({
        input: spawnedChild.stdin,
        output: output as unknown as Writable,
        now: () => 100,
        ownerIdentity: {
          snapshot: () => ({
            revision: 0,
            ownerUsername: "HarnessOwner",
            configured: true,
            presence: "unknown",
          }),
          update: async () => {
            throw new Error("unused");
          },
          setPresence: () => undefined,
          subscribe: () => () => undefined,
        },
        account: {
          getAccount: async () => ({ status: "signed_out" }),
          startChatGptLogin: async () => ({
            attemptId: "correlated_attempt_0001",
            expiresAt: 60_000,
            loginUrl: "https://auth.openai.com/oauth",
          }),
          cancelChatGptLogin: async (attemptId) => ({ status: "cancelled", attemptId }),
          subscribe: () => () => undefined,
          stop: async () => undefined,
        },
        models: {
          listModels: async () => ({
            models: [],
            selection: { mode: "automatic" },
            legacyMigrationCompleted: true,
          }),
          migrateLegacyPreference: async () => ({
            models: [],
            selection: { mode: "automatic" },
            legacyMigrationCompleted: true,
          }),
          selectModel: async () => ({ mode: "automatic" }),
          prepareSelection: async (selection) => ({
            preferenceRevision: 0,
            requested: selection,
            resolved: { modelId: "correlated-live-model", reasoningEffort: "medium" },
          }),
          commitSelection: async (prepared) =>
            prepared.requested.mode === "automatic"
              ? { mode: "automatic" }
              : { ...prepared.requested, available: true },
          resolveRuntimeSelection: async () => ({
            modelId: "correlated-live-model",
            reasoningEffort: "medium",
          }),
          subscribe: () => () => undefined,
          stop: () => undefined,
        },
        worldProfiles,
        getConfirmedWorldBinding: async () => structuredClone(binding),
        createRuntime: async (_connection, initialRevision, _selection, safety) => {
          safetyConfigurations.push(safety);
          return new RuntimeFacade({
            initialRevision,
            lifecycle: {
              start: async () => undefined,
              stop: async () => undefined,
            },
          });
        },
      });
      server.start();
    },
  });
  supervisor.start();
  if (!child || !output || !server) throw new Error("server-backed child did not start");
  const harness = { binding, child, output, safetyConfigurations, server, supervisor };
  openServerBackedWorldHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const harness of openServerBackedWorldHarnesses.splice(0)) {
    harness.output.releaseAll();
    await harness.server.stop();
    harness.child.stdin.destroy();
    harness.child.stdout.destroy();
    harness.child.stderr.destroy();
  }
});

describe("ChildSupervisor", () => {
  it("sends a dedicated task-only stop command without terminating the child", async () => {
    const { children, supervisor } = createHarness();

    const stopping = supervisor.stopTask();
    const child = children[0]!;
    const stopRequest = child.requests()[0]!;
    expect(stopRequest.command).toEqual({ kind: "stop_task" });
    child.respond(successResponse(stopRequest.id, { ...idleSnapshot, revision: 1 }));

    await expect(stopping).resolves.toEqual({ ...idleSnapshot, revision: 1 });
    expect(child.killCalls).toBe(0);
    expect(children).toHaveLength(1);
  });

  it("keeps one public-bind terminal when LAN invalidation wins during its Writable callback", async () => {
    const { binding, child, output, safetyConfigurations, supervisor } =
      createServerBackedWorldHarness();
    await expect(
      supervisor.request({ kind: "set_confirmed_connection", proof: binding.proof }),
    ).resolves.toMatchObject({ status: "configured" });
    const enteredWrite = output.gateNextResponseCallback();

    const bind = supervisor.request({
      kind: "bind_confirmed_world",
      expectedRevision: 0,
      label: "Survival",
    });
    const successLine = await enteredWrite;
    const bindId = (JSON.parse(successLine) as { id: string }).id;
    await expect(bind).resolves.toMatchObject({
      revision: 1,
      value: { label: "Survival", safetyPreset: "standard" },
    });

    const invalidation = supervisor.request({
      kind: "invalidate_connection",
      reason: "lan_changed",
    });
    output.release();

    const invalidationOutcome = await caught(invalidation);
    expect(output.responseAttempts(bindId)).toHaveLength(1);
    expect(invalidationOutcome).toMatchObject({ lifecycle: "idle" });
    expect(child.killCalls).toBe(0);

    const nextProof = { ...binding.proof, nonce: "correlated_world_proof_0002" };
    await expect(
      supervisor.request({ kind: "set_confirmed_connection", proof: nextProof }),
    ).resolves.toMatchObject({ status: "configured" });
    await expect(supervisor.request({ kind: "start_runtime" })).resolves.toMatchObject({
      lifecycle: "running",
    });
    expect(safetyConfigurations.at(-1)).toEqual({ compatibilityVerified: false });
  });

  it("keeps one private-bind terminal when LAN invalidation wins during its Writable callback", async () => {
    const { binding, child, output, safetyConfigurations, supervisor } =
      createServerBackedWorldHarness();
    await expect(
      supervisor.request({ kind: "set_confirmed_connection", proof: binding.proof }),
    ).resolves.toMatchObject({ status: "configured" });
    const enteredWrite = output.gateNextResponseCallback();

    const bind = supervisor.bindConfirmedWorld(binding, {
      kind: "bind_confirmed_world",
      expectedRevision: 0,
      label: "Survival",
    });
    const successLine = await enteredWrite;
    const bindId = (JSON.parse(successLine) as { id: string }).id;
    await expect(bind).resolves.toMatchObject({
      revision: 1,
      value: { label: "Survival", safetyPreset: "standard" },
    });

    const invalidation = supervisor.request({
      kind: "invalidate_connection",
      reason: "lan_changed",
    });
    output.release();

    const invalidationOutcome = await caught(invalidation);
    expect(output.responseAttempts(bindId)).toHaveLength(1);
    expect(invalidationOutcome).toMatchObject({ lifecycle: "idle" });
    expect(child.killCalls).toBe(0);

    const nextProof = { ...binding.proof, nonce: "correlated_world_proof_0002" };
    await expect(
      supervisor.request({ kind: "set_confirmed_connection", proof: nextProof }),
    ).resolves.toMatchObject({ status: "configured" });
    await expect(supervisor.request({ kind: "start_runtime" })).resolves.toMatchObject({
      lifecycle: "running",
    });
    expect(safetyConfigurations.at(-1)).toEqual({ compatibilityVerified: false });
  });

  it("does not retry a safety-update terminal after its success Writable callback fails", async () => {
    const { binding, child, output, supervisor } = createServerBackedWorldHarness();
    await expect(
      supervisor.request({ kind: "set_confirmed_connection", proof: binding.proof }),
    ).resolves.toMatchObject({ status: "configured" });
    await expect(
      supervisor.bindConfirmedWorld(binding, {
        kind: "bind_confirmed_world",
        expectedRevision: 0,
        label: "Survival",
      }),
    ).resolves.toMatchObject({ revision: 1 });
    const enteredWrite = output.gateNextResponseCallback();

    const update = supervisor.request({
      kind: "update_safety_profile",
      expectedRevision: 1,
      safetyPreset: "conservative",
    });
    const successLine = await enteredWrite;
    const updateId = (JSON.parse(successLine) as { id: string }).id;
    await expect(update).resolves.toMatchObject({
      revision: 2,
      value: { safetyPreset: "conservative" },
    });

    output.release(new Error("simulated Writable callback failure"));
    const statusOutcome = await caught(supervisor.request({ kind: "get_status" }));
    expect(output.responseAttempts(updateId)).toHaveLength(1);
    expect(statusOutcome).toMatchObject({ lifecycle: "idle" });
    expect(child.killCalls).toBe(0);
  });

  it("quarantines and restarts after committed profile containment failure while preserving revision evidence", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    const profile = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
    const envelope = {
      schemaVersion: 1 as const,
      revision: 1,
      updatedAt: "2026-07-29T01:02:03.004Z",
      value: { ...profile, displayName: "已提交配置" },
    };
    supervisor.start();

    const update = caught(
      supervisor.request({
        kind: "update_profile",
        expectedRevision: 0,
        profile: envelope.value,
      }),
    );
    const request = children[0]!.requests()[0]!;
    children[0]!.respond({
      version: DESKTOP_PROTOCOL_VERSION,
      id: request.id,
      ok: false,
      error: {
        code: "PROFILE_RUNTIME_CONTAINMENT_FAILED",
        message: "Profile committed but runtime containment failed",
        committed: envelope,
      },
    });

    const error = await update;
    expect(error).toBeInstanceOf(CommittedProfileMutationError);
    expect((error as CommittedProfileMutationError).committed).toEqual(envelope);
    expect(children[0]!.killCalls).toBe(1);
    await expect(supervisor.request({ kind: "read_profile" })).rejects.toThrow(
      "quarantined until process exit",
    );

    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(999);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);
  });

  it("rejects unrelated committed-profile evidence as malformed protocol", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();

    const account = caught(supervisor.request({ kind: "get_account" }));
    const request = children[0]!.requests()[0]!;
    children[0]!.respond(containmentFailureResponse(request.id, committedProfileEnvelope(1)));

    const error = await account;
    expect(error).not.toBeInstanceOf(CommittedProfileMutationError);
    expect(error).toMatchObject({ message: "WhiteLily child sent malformed protocol" });
    expect(children[0]!.killCalls).toBe(1);
  });

  it.each([
    ["wrong revision", committedProfileEnvelope(2, { displayName: "已提交配置" })],
    ["wrong profile", committedProfileEnvelope(1, { displayName: "其他配置" })],
  ])("rejects update_profile committed evidence with %s", async (_name, committed) => {
    const { children, supervisor } = createHarness();
    const submitted = {
      ...createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99"),
      displayName: "已提交配置",
    };
    supervisor.start();

    const callerCommand = {
      kind: "update_profile" as const,
      expectedRevision: 0,
      profile: submitted,
    };
    const update = caught(supervisor.request(callerCommand));
    const request = children[0]!.requests()[0]!;
    (callerCommand as { kind: string }).kind = "get_account";
    callerCommand.expectedRevision = 99;
    submitted.displayName = "mutated after dispatch";
    submitted.preferredTopics.push("mutated topic");
    children[0]!.respond(containmentFailureResponse(request.id, committed));

    const error = await update;
    expect(error).not.toBeInstanceOf(CommittedProfileMutationError);
    expect(error).toMatchObject({ message: "WhiteLily child sent malformed protocol" });
    expect(children[0]!.killCalls).toBe(1);
  });

  it("correlates update_profile committed evidence with the normalized submitted profile", async () => {
    const { children, supervisor } = createHarness();
    const submitted = {
      ...createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99"),
      displayName: " 已提交配置 ",
      preferredTopics: [" 建筑 ", "建筑"],
    };
    const committed = committedProfileEnvelope(1, {
      displayName: "已提交配置",
      preferredTopics: ["建筑"],
    });
    supervisor.start();

    const update = caught(
      supervisor.request({
        kind: "update_profile",
        expectedRevision: 0,
        profile: submitted,
      }),
    );
    const request = children[0]!.requests()[0]!;
    children[0]!.respond(containmentFailureResponse(request.id, committed));

    const error = await update;
    expect(error).toBeInstanceOf(CommittedProfileMutationError);
    expect((error as CommittedProfileMutationError).committed).toEqual(committed);
    expect(children[0]!.killCalls).toBe(1);
  });

  it("rejects committed evidence when the requested revision cannot be incremented safely", async () => {
    const { children, supervisor } = createHarness();
    const submitted = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
    supervisor.start();

    const update = caught(
      supervisor.request({
        kind: "update_profile",
        expectedRevision: Number.MAX_SAFE_INTEGER,
        profile: submitted,
      }),
    );
    const request = children[0]!.requests()[0]!;
    children[0]!.respond(
      containmentFailureResponse(
        request.id,
        committedProfileEnvelope(Number.MAX_SAFE_INTEGER, submitted),
      ),
    );

    const error = await update;
    expect(error).not.toBeInstanceOf(CommittedProfileMutationError);
    expect(error).toMatchObject({ message: "WhiteLily child sent malformed protocol" });
    expect(children[0]!.killCalls).toBe(1);
  });

  it("accepts only correlated set_behavior_mode committed evidence", async () => {
    const { children, supervisor } = createHarness();
    const settings = {
      idleMinutes: 7,
      allowProactiveChat: true,
      allowSuggestions: false,
      allowLowRiskMicroActions: false,
    };
    const baseline = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
    const committed = committedProfileEnvelope(2, {
      displayName: "严格但可变的其他字段",
      mode: "balanced",
      modeSettings: {
        ...baseline.modeSettings,
        balanced: structuredClone(settings),
      },
    });
    supervisor.start();

    const callerCommand = {
      kind: "set_behavior_mode" as const,
      expectedRevision: 1,
      mode: "balanced" as const,
      settings,
    };
    const update = caught(supervisor.request(callerCommand));
    const request = children[0]!.requests()[0]!;
    (callerCommand as { kind: string }).kind = "get_account";
    callerCommand.expectedRevision = 99;
    (callerCommand as { mode: string }).mode = "friend";
    settings.idleMinutes = 99;
    settings.allowSuggestions = true;
    children[0]!.respond(containmentFailureResponse(request.id, committed));

    const error = await update;
    expect(error).toBeInstanceOf(CommittedProfileMutationError);
    expect((error as CommittedProfileMutationError).committed).toEqual(committed);
    expect(children[0]!.killCalls).toBe(1);
  });

  it.each([
    [
      "wrong revision",
      committedProfileEnvelope(3, {
        mode: "balanced",
      }),
    ],
    [
      "wrong mode",
      committedProfileEnvelope(2, {
        mode: "friend",
      }),
    ],
    [
      "wrong selected settings",
      committedProfileEnvelope(2, {
        mode: "balanced",
        modeSettings: {
          ...createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99").modeSettings,
          balanced: {
            idleMinutes: 9,
            allowProactiveChat: false,
            allowSuggestions: false,
            allowLowRiskMicroActions: false,
          },
        },
      }),
    ],
  ])("rejects set_behavior_mode committed evidence with %s", async (_name, committed) => {
    const { children, supervisor } = createHarness();
    const settings = {
      idleMinutes: 7,
      allowProactiveChat: true,
      allowSuggestions: true,
      allowLowRiskMicroActions: false,
    };
    supervisor.start();

    const update = caught(
      supervisor.request({
        kind: "set_behavior_mode",
        expectedRevision: 1,
        mode: "balanced",
        settings,
      }),
    );
    const request = children[0]!.requests()[0]!;
    children[0]!.respond(containmentFailureResponse(request.id, committed));

    const error = await update;
    expect(error).not.toBeInstanceOf(CommittedProfileMutationError);
    expect(error).toMatchObject({ message: "WhiteLily child sent malformed protocol" });
    expect(children[0]!.killCalls).toBe(1);
  });

  it.each(["unknown committed field", "oversized committed envelope"] as const)(
    "rejects %s as malformed protocol rather than proven commit evidence",
    async (fault) => {
      const { children, supervisor } = createHarness();
      const submitted = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
      supervisor.start();

      const update = caught(
        supervisor.request({
          kind: "update_profile",
          expectedRevision: 0,
          profile: submitted,
        }),
      );
      const request = children[0]!.requests()[0]!;
      const committed =
        fault === "unknown committed field"
          ? { ...committedProfileEnvelope(1, submitted), unknown: true }
          : {
              ...committedProfileEnvelope(1, submitted),
              padding: "x".repeat(MAX_DESKTOP_LINE_BYTES),
            };
      children[0]!.stdout.write(
        `${JSON.stringify({
          version: DESKTOP_PROTOCOL_VERSION,
          id: request.id,
          ok: false,
          error: {
            code: "PROFILE_RUNTIME_CONTAINMENT_FAILED",
            message: "Profile committed but runtime containment failed",
            committed,
          },
        })}\n`,
      );

      const error = await update;
      expect(error).not.toBeInstanceOf(CommittedProfileMutationError);
      expect(error).toMatchObject({ message: "WhiteLily child sent malformed protocol" });
      expect(children[0]!.killCalls).toBe(1);
    },
  );

  it("infers and returns the strict result for an account command", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();

    const account = supervisor.request({ kind: "get_account" });
    const request = children[0]!.requests()[0]!;
    children[0]!.respond({
      version: DESKTOP_PROTOCOL_VERSION,
      id: request.id,
      ok: true,
      result: { status: "signed_out" },
    });

    await expect(account).resolves.toEqual({ status: "signed_out" });
  });

  it("quarantines a child whose success result does not match its pending command", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();

    const account = caught(supervisor.request({ kind: "get_account" }));
    const request = children[0]!.requests()[0]!;
    children[0]!.respond(successResponse(request.id));

    await expect(account).resolves.toMatchObject({
      message: "WhiteLily child sent malformed protocol",
    });
    expect(children[0]!.killCalls).toBe(1);
  });

  it("keeps one live child and uses only the trusted executable, entry, and environment", () => {
    const { children, spawnCalls, supervisor } = createHarness();

    supervisor.start();
    supervisor.start();

    expect(children).toHaveLength(1);
    expect(spawnCalls[0]).toEqual([
      process.execPath,
      [
        String.raw`C:\Program Files\WhiteLily\resources\childMain.js`,
        String.raw`C:\LocalAppData\owner\WhiteLily\config.toml`,
        "0",
      ],
      {
        cwd: String.raw`C:\LocalAppData\owner\WhiteLily`,
        env: {
          LOCALAPPDATA: String.raw`C:\LocalAppData\owner`,
          WHITELILY_DATA_ROOT: String.raw`C:\LocalAppData\owner\WhiteLily`,
          ELECTRON_RUN_AS_NODE: "1",
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    ]);
  });

  it("runs the fixed packaged JavaScript child as Node in production", () => {
    const { spawnCalls, supervisor } = createHarness({ development: false });

    supervisor.start();

    expect(spawnCalls[0]?.[2].env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  it("times out ordinary requests after exactly ten seconds", async () => {
    vi.useFakeTimers();
    const { supervisor } = createHarness();
    supervisor.start();

    const outcome = supervisor.request({ kind: "get_status" }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("timed out"),
    });
  });

  it.each([
    {
      command: {
        kind: "update_profile",
        expectedRevision: 0,
        profile: createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99"),
      } as const,
    },
    {
      command: {
        kind: "set_behavior_mode",
        expectedRevision: 0,
        mode: "balanced",
        settings: {
          idleMinutes: 7,
          allowProactiveChat: true,
          allowSuggestions: true,
          allowLowRiskMicroActions: false,
        },
      } as const,
    },
  ])(
    "quarantines an unacknowledged $command.kind after exactly ten seconds and restarts once after exit",
    async ({ command }) => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();

      const outcome = caught(supervisor.request(command));
      const request = children[0]!.requests()[0]!;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(children[0]!.killCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);

      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining("timed out"),
      });
      expect(children[0]!.killCalls).toBe(1);
      expect(children[0]!.alive).toBe(true);
      await expect(supervisor.request({ kind: "get_account" })).rejects.toThrow("quarantined");
      expect(() => supervisor.start()).toThrow("quarantined");

      const lateCommitted =
        command.kind === "update_profile"
          ? committedProfileEnvelope(1, command.profile)
          : committedProfileEnvelope(1, {
              mode: command.mode,
              modeSettings: {
                ...createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99")
                  .modeSettings,
                [command.mode]: command.settings,
              },
            });
      children[0]!.respond(containmentFailureResponse(request.id, lateCommitted));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(children).toHaveLength(1);

      children[0]!.crash();
      children[0]!.finishClose();
      await vi.advanceTimersByTimeAsync(999);
      expect(children).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(2);
      expect(children[1]!.requests()).toEqual([]);
      children[0]!.respond(containmentFailureResponse(request.id, lateCommitted));
      await Promise.resolve();
      expect(children[1]!.killCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(children).toHaveLength(2);
    },
  );

  it("quarantines an unacknowledged owner update timeout and restarts after exit", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = caught(
      supervisor.request({
        kind: "update_owner_identity",
        expectedRevision: 2,
        ownerUsername: "NewOwner",
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("timed out"),
    });
    expect(children[0]!.killCalls).toBe(1);
    await expect(supervisor.request({ kind: "read_owner_identity" })).rejects.toThrow(
      "quarantined",
    );

    children[0]!.crash();
    children[0]!.finishClose();
    await vi.advanceTimersByTimeAsync(999);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);
    expect(children[1]!.requests()).toEqual([]);
  });

  it("quarantines an owner update when stdout closes before acknowledgement", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = caught(
      supervisor.request({
        kind: "update_owner_identity",
        expectedRevision: 2,
        ownerUsername: "NewOwner",
      }),
    );
    children[0]!.stdout.emit("close");

    expect(children[0]!.killCalls).toBe(1);
    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("stdout closed"),
    });
    await expect(supervisor.request({ kind: "read_owner_identity" })).rejects.toThrow(
      "quarantined",
    );
  });

  it("accepts an exact next-revision owner event as acknowledgement without a response", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = caught(
      supervisor.request({
        kind: "update_owner_identity",
        expectedRevision: 2,
        ownerUsername: "NewOwner",
      }),
    );
    writeOwnerIdentityEvent(children[0]!, {
      revision: 3,
      ownerUsername: "NewOwner",
      presence: "offline",
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("timed out"),
    });
    expect(children[0]!.killCalls).toBe(0);

    const read = supervisor.request({ kind: "read_owner_identity" });
    const readRequest = children[0]!.requests()[1]!;
    children[0]!.respond({
      version: DESKTOP_PROTOCOL_VERSION,
      id: readRequest.id,
      ok: true,
      result: {
        revision: 3,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline",
      },
    });
    await expect(read).resolves.toMatchObject({
      revision: 3,
      ownerUsername: "NewOwner",
    });
  });

  it.each([
    {
      label: "unchanged revision",
      owner: { revision: 2, ownerUsername: "NewOwner", presence: "offline" as const },
    },
    {
      label: "advanced revision",
      owner: { revision: 4, ownerUsername: "NewOwner", presence: "offline" as const },
    },
    {
      label: "different username",
      owner: { revision: 3, ownerUsername: "OtherOwner", presence: "online" as const },
    },
  ])("does not accept an owner event with $label as acknowledgement", async ({ owner }) => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = caught(
      supervisor.request({
        kind: "update_owner_identity",
        expectedRevision: 2,
        ownerUsername: "NewOwner",
      }),
    );
    writeOwnerIdentityEvent(children[0]!, owner);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("timed out"),
    });
    expect(children[0]!.killCalls).toBe(1);
    await expect(supervisor.request({ kind: "read_owner_identity" })).rejects.toThrow(
      "quarantined",
    );
  });

  it("accepts an owner update response as acknowledgement without an event", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = supervisor.request({
      kind: "update_owner_identity",
      expectedRevision: 2,
      ownerUsername: "NewOwner",
    });
    const request = children[0]!.requests()[0]!;
    children[0]!.respond({
      version: DESKTOP_PROTOCOL_VERSION,
      id: request.id,
      ok: true,
      result: {
        revision: 3,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline",
      },
    });

    await expect(outcome).resolves.toMatchObject({
      revision: 3,
      ownerUsername: "NewOwner",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children[0]!.killCalls).toBe(0);
  });

  it("accepts an idempotent owner update response at the current revision", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = supervisor.request({
      kind: "update_owner_identity",
      expectedRevision: 2,
      ownerUsername: "NewOwner",
    });
    const request = children[0]!.requests()[0]!;
    children[0]!.respond({
      version: DESKTOP_PROTOCOL_VERSION,
      id: request.id,
      ok: true,
      result: {
        revision: 2,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline",
      },
    });

    await expect(outcome).resolves.toMatchObject({
      revision: 2,
      ownerUsername: "NewOwner",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children[0]!.killCalls).toBe(0);
  });

  it("quarantines an idempotent response that contradicts a matching next-revision event", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = caught(
      supervisor.request({
        kind: "update_owner_identity",
        expectedRevision: 2,
        ownerUsername: "NewOwner",
      }),
    );
    const request = children[0]!.requests()[0]!;
    writeOwnerIdentityEvent(children[0]!, {
      revision: 3,
      ownerUsername: "NewOwner",
      presence: "offline",
    });
    children[0]!.respond({
      version: DESKTOP_PROTOCOL_VERSION,
      id: request.id,
      ok: true,
      result: {
        revision: 2,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline",
      },
    });

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("malformed protocol"),
    });
    expect(children[0]!.killCalls).toBe(1);
  });

  it.each([
    {
      label: "a different owner at the next revision",
      event: { revision: 3, ownerUsername: "OtherOwner", presence: "offline" as const },
    },
    {
      label: "the requested owner beyond the next revision",
      event: { revision: 4, ownerUsername: "NewOwner", presence: "offline" as const },
    },
  ])("quarantines a current-revision response after $label was observed", async ({ event }) => {
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = caught(
      supervisor.request({
        kind: "update_owner_identity",
        expectedRevision: 2,
        ownerUsername: "NewOwner",
      }),
    );
    const request = children[0]!.requests()[0]!;
    writeOwnerIdentityEvent(children[0]!, event);
    children[0]!.respond({
      version: DESKTOP_PROTOCOL_VERSION,
      id: request.id,
      ok: true,
      result: {
        revision: 2,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline",
      },
    });

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("malformed protocol"),
    });
    expect(children[0]!.killCalls).toBe(1);
  });

  it("accepts a next-revision response after its matching owner event", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = supervisor.request({
      kind: "update_owner_identity",
      expectedRevision: 2,
      ownerUsername: "NewOwner",
    });
    const request = children[0]!.requests()[0]!;
    writeOwnerIdentityEvent(children[0]!, {
      revision: 3,
      ownerUsername: "NewOwner",
      presence: "offline",
    });
    children[0]!.respond({
      version: DESKTOP_PROTOCOL_VERSION,
      id: request.id,
      ok: true,
      result: {
        revision: 3,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline",
      },
    });

    await expect(outcome).resolves.toMatchObject({
      revision: 3,
      ownerUsername: "NewOwner",
    });
    expect(children[0]!.killCalls).toBe(0);
  });

  it.each([
    {
      label: "a different username",
      result: {
        revision: 3,
        ownerUsername: "OtherOwner",
        configured: true,
        presence: "online" as const,
      },
    },
    {
      label: "the wrong revision",
      result: {
        revision: 4,
        ownerUsername: "NewOwner",
        configured: true,
        presence: "offline" as const,
      },
    },
    {
      label: "an unconfigured identity",
      result: {
        revision: 3,
        ownerUsername: null,
        configured: false,
        presence: "unknown" as const,
      },
    },
  ])("quarantines an owner update response with $label", async ({ result }) => {
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = caught(
      supervisor.request({
        kind: "update_owner_identity",
        expectedRevision: 2,
        ownerUsername: "NewOwner",
      }),
    );
    const request = children[0]!.requests()[0]!;
    children[0]!.respond({
      version: DESKTOP_PROTOCOL_VERSION,
      id: request.id,
      ok: true,
      result,
    });

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("malformed protocol"),
    });
    expect(children[0]!.killCalls).toBe(1);
    await expect(supervisor.request({ kind: "read_owner_identity" })).rejects.toThrow(
      "quarantined",
    );
  });

  it.each(["update_profile", "set_behavior_mode"] as const)(
    "keeps the validated %s timeout fence after caller mutation",
    async (kind) => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      const profile = createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99");
      const callerCommand =
        kind === "update_profile"
          ? {
              kind,
              expectedRevision: 3,
              profile: structuredClone(profile),
            }
          : {
              kind,
              expectedRevision: 3,
              mode: "balanced" as const,
              settings: {
                idleMinutes: 7,
                allowProactiveChat: true,
                allowSuggestions: false,
                allowLowRiskMicroActions: false,
              },
            };
      supervisor.start();

      const outcome = caught(supervisor.request(callerCommand));
      const dispatched = children[0]!.requests()[0]!;
      (callerCommand as { kind: string }).kind = "get_account";
      callerCommand.expectedRevision = 99;
      if ("profile" in callerCommand) {
        callerCommand.profile!.displayName = "mutated after dispatch";
        callerCommand.profile!.modeSettings.balanced.allowSuggestions = true;
      } else {
        callerCommand.settings.idleMinutes = 99;
        callerCommand.settings.allowSuggestions = true;
      }

      expect(dispatched.command.kind).toBe(kind);
      expect(
        "expectedRevision" in dispatched.command ? dispatched.command.expectedRevision : undefined,
      ).toBe(3);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining("timed out"),
      });
      expect(children[0]!.killCalls).toBe(1);
      await expect(supervisor.request({ kind: "get_account" })).rejects.toThrow("quarantined");
    },
  );

  it("does not turn an ordinary timeout fatal when the caller mutates its command into a profile update", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    const callerCommand = { kind: "get_account" as const };
    supervisor.start();

    const outcome = caught(supervisor.request(callerCommand));
    Object.assign(callerCommand as unknown as Record<string, unknown>, {
      kind: "update_profile",
      expectedRevision: 0,
      profile: createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99"),
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("timed out"),
    });
    expect(children[0]!.killCalls).toBe(0);
  });

  it("keeps a kill-false profile timeout quarantined until actual exit", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0]!.killResult = false;

    const outcome = caught(
      supervisor.request({
        kind: "update_profile",
        expectedRevision: 0,
        profile: createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99"),
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("timed out"),
    });
    expect(children[0]!.killCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children).toHaveLength(1);
    await expect(supervisor.request({ kind: "read_profile" })).rejects.toThrow("quarantined");

    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);
  });

  it.each(["stdin", "stdout"] as const)(
    "quarantines a profile mutation when the %s protocol stream closes before acknowledgement",
    async (stream) => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();

      const outcome = caught(
        supervisor.request({
          kind: "update_profile",
          expectedRevision: 0,
          profile: createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99"),
        }),
      );

      children[0]![stream].emit("close");

      expect(children[0]!.killCalls).toBe(1);
      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining(`${stream} closed`),
      });
      await expect(supervisor.request({ kind: "get_status" })).rejects.toThrow("quarantined");
    },
  );

  it.each([
    [
      {
        kind: "update_profile",
        expectedRevision: 0,
        profile: createDefaultCompanionProfile("be176ae1-a4b4-4fd6-b04c-89634cd74a99"),
      } as const,
      "DOCUMENT_CONFLICT" as const,
    ],
    [
      {
        kind: "set_behavior_mode",
        expectedRevision: 0,
        mode: "balanced",
        settings: {
          idleMinutes: 7,
          allowProactiveChat: true,
          allowSuggestions: true,
          allowLowRiskMicroActions: false,
        },
      } as const,
      "PROFILE_OPERATION_FAILED" as const,
    ],
  ])("does not quarantine pre-commit $errorCode for $command.kind", async (command, errorCode) => {
    const { children, supervisor } = createHarness();
    supervisor.start();

    const mutation = caught(supervisor.request(command as DesktopCommand));
    const mutationRequest = children[0]!.requests()[0]!;
    children[0]!.respond(failureResponse(mutationRequest.id, errorCode));

    await expect(mutation).resolves.toMatchObject({
      message: expect.stringContaining(errorCode),
    });
    expect(children[0]!.killCalls).toBe(0);

    const account = supervisor.request({ kind: "get_account" });
    const accountRequest = children[0]!.requests()[1]!;
    children[0]!.respond({
      version: DESKTOP_PROTOCOL_VERSION,
      id: accountRequest.id,
      ok: true,
      result: { status: "signed_out" },
    });
    await expect(account).resolves.toEqual({ status: "signed_out" });
  });

  it.each([
    [{ kind: "stop_runtime" } as const, "RUNTIME_STOP_FAILED" as const],
    [
      { kind: "invalidate_connection", reason: "lan_changed" } as const,
      "CONNECTION_OPERATION_FAILED" as const,
    ],
    [{ kind: "emergency_stop" } as const, "EMERGENCY_STOP_FAILED" as const],
  ])(
    "quarantines and terminates the exact child when $kind containment is rejected",
    async (command, errorCode) => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();

      const outcome = caught(supervisor.request(command));
      const request = children[0]!.requests()[0]!;
      children[0]!.respond(failureResponse(request.id, errorCode));

      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining(errorCode),
      });
      expect(children[0]!.killCalls).toBe(1);
      expect(children[0]!.alive).toBe(true);
      await expect(supervisor.request({ kind: "get_status" })).rejects.toThrow("quarantined");
      expect(() => supervisor.start()).toThrow("quarantined");

      await vi.advanceTimersByTimeAsync(10_000);
      expect(children).toHaveLength(1);
      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(999);
      expect(children).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(2);
      expect(children.filter((child) => child.alive)).toHaveLength(1);
    },
  );

  it.each([
    { kind: "stop_runtime" } as const,
    { kind: "invalidate_connection", reason: "lan_changed" } as const,
  ])("quarantines and terminates the exact child when $kind times out", async (command) => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = caught(supervisor.request(command));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(children[0]!.killCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("timed out"),
    });
    expect(children[0]!.killCalls).toBe(1);
    expect(children[0]!.alive).toBe(true);
    await expect(supervisor.request({ kind: "get_status" })).rejects.toThrow("quarantined");
  });

  it.each(["success acknowledgement", "error response"] as const)(
    "ignores a late authority-invalidation %s while the exact child remains quarantined",
    async (lateResponseKind) => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();

      const outcome = caught(supervisor.request({ kind: "stop_runtime" }));
      const request = children[0]!.requests()[0]!;
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining("timed out"),
      });

      children[0]!.respond(
        lateResponseKind === "success acknowledgement"
          ? successResponse(request.id)
          : failureResponse(request.id, "RUNTIME_STOP_FAILED"),
      );
      await Promise.resolve();

      expect(children[0]!.killCalls).toBe(1);
      expect(children).toHaveLength(1);
      expect(children[0]!.alive).toBe(true);
      await expect(supervisor.request({ kind: "get_status" })).rejects.toThrow("quarantined");
    },
  );

  it("quarantines an emergency timeout and restarts only after actual exit", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = supervisor.emergencyStop().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(children[0]?.killCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(children[0]?.killCalls).toBe(1);
    expect(children[0]?.alive).toBe(true);
    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("timed out"),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children).toHaveLength(1);

    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(999);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);
    expect(children.filter((child) => child.alive)).toHaveLength(1);
  });

  it("retains a kill-false child and rejects follow-up request and start", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0]!.killResult = false;

    const outcome = caught(supervisor.emergencyStop());
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("timed out"),
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(children).toHaveLength(1);
    expect(children[0]!.alive).toBe(true);
    await expect(supervisor.request({ kind: "get_status" })).rejects.toThrow("quarantined");
    expect(() => supervisor.start()).toThrow("quarantined");
    expect(children).toHaveLength(1);
  });

  it("uses 1s, 2s, and 4s crash restart delays and stops after three restarts", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();

    children[0]?.crash();
    await vi.advanceTimersByTimeAsync(999);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);

    children[1]?.crash();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(3);

    children[2]?.crash();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(children).toHaveLength(4);

    children[3]?.crash();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(4);
  });

  it("seeds each restarted child above the active generation runtime high-water mark", async () => {
    vi.useFakeTimers();
    const { children, spawnCalls, supervisor } = createHarness();
    const observedEvents: Array<{ revision: number; state: string }> = [];
    supervisor.subscribe((event) => {
      if (event.kind === "lifecycle") {
        observedEvents.push({ revision: event.revision, state: event.state });
      }
    });
    supervisor.start();

    expect(spawnCalls[0]?.[1][2]).toBe("0");
    const oldStatus = supervisor.request({ kind: "get_status" });
    const oldRequest = children[0]!.requests()[0]!;
    children[0]!.respond(successResponse(oldRequest.id, runtimeSnapshot(40, "running")));
    await expect(oldStatus).resolves.toMatchObject({ revision: 40, lifecycle: "running" });

    const oldChild = children[0]!;
    oldChild.crash();
    oldChild.stdout.write(
      `${JSON.stringify({
        version: DESKTOP_PROTOCOL_VERSION,
        event: { kind: "lifecycle", revision: 900, state: "failed" },
      })}\n`,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(spawnCalls[1]?.[1][2]).toBe("41");
    const freshStatus = supervisor.request({ kind: "get_status" });
    const freshStatusRequest = children[1]!.requests()[0]!;
    children[1]!.respond(successResponse(freshStatusRequest.id, runtimeSnapshot(41, "idle")));
    await expect(freshStatus).resolves.toMatchObject({ revision: 41, lifecycle: "idle" });

    const freshControl = supervisor.request({ kind: "stop_runtime" });
    const freshControlRequest = children[1]!.requests()[1]!;
    children[1]!.respond(successResponse(freshControlRequest.id, runtimeSnapshot(41, "stopped")));
    await expect(freshControl).resolves.toMatchObject({ revision: 41, lifecycle: "stopped" });
    children[1]!.stdout.write(
      `${JSON.stringify({
        version: DESKTOP_PROTOCOL_VERSION,
        event: { kind: "lifecycle", revision: 42, state: "starting" },
      })}\n`,
    );
    await vi.waitFor(() => expect(observedEvents).toEqual([{ revision: 42, state: "starting" }]));

    children[1]!.crash();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawnCalls[2]?.[1][2]).toBe("43");
  });

  it.each([
    ["duplicate", 5],
    ["skipped", 7],
    ["regressing", 4],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ] as const)(
    "quarantines a current child before publishing a %s runtime event after a full snapshot",
    async (_label, revision) => {
      vi.useFakeTimers();
      const { children, spawnCalls, supervisor } = createHarness();
      const observedKinds: string[] = [];
      supervisor.subscribe((event) => observedKinds.push(event.kind));
      supervisor.start();
      const status = supervisor.request({ kind: "get_status" });
      const statusRequest = children[0]!.requests()[0]!;
      children[0]!.respond(successResponse(statusRequest.id, runtimeSnapshot(5, "running")));
      await expect(status).resolves.toMatchObject({ revision: 5 });

      writeLifecycleEvent(children[0]!, revision);
      await Promise.resolve();

      expect(children[0]!.killCalls).toBe(1);
      expect(observedKinds).toEqual([]);
      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spawnCalls[1]?.[1][2]).toBe("6");
    },
  );

  it.each([
    ["duplicate", 41],
    ["skipped", 43],
    ["regressing", 40],
  ] as const)(
    "quarantines a %s runtime event relative to a fresh restart seed without advancing that seed",
    async (_label, revision) => {
      vi.useFakeTimers();
      const { children, spawnCalls, supervisor } = createHarness();
      const observedKinds: string[] = [];
      supervisor.subscribe((event) => observedKinds.push(event.kind));
      supervisor.start();
      const oldStatus = supervisor.request({ kind: "get_status" });
      const oldStatusRequest = children[0]!.requests()[0]!;
      children[0]!.respond(successResponse(oldStatusRequest.id, runtimeSnapshot(40, "running")));
      await expect(oldStatus).resolves.toMatchObject({ revision: 40 });
      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spawnCalls[1]?.[1][2]).toBe("41");

      writeLifecycleEvent(children[1]!, revision);
      await Promise.resolve();

      expect(children[1]!.killCalls).toBe(1);
      expect(observedKinds).toEqual([]);
      children[1]!.crash();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(spawnCalls[2]?.[1][2]).toBe("41");
    },
  );

  it("quarantines an event when a fresh restart seed has exhausted the safe revision range", async () => {
    vi.useFakeTimers();
    const { children, spawnCalls, supervisor } = createHarness();
    const observedKinds: string[] = [];
    supervisor.subscribe((event) => observedKinds.push(event.kind));
    supervisor.start();
    const oldStatus = supervisor.request({ kind: "get_status" });
    const oldStatusRequest = children[0]!.requests()[0]!;
    children[0]!.respond(
      successResponse(oldStatusRequest.id, runtimeSnapshot(Number.MAX_SAFE_INTEGER - 1, "running")),
    );
    await expect(oldStatus).resolves.toMatchObject({
      revision: Number.MAX_SAFE_INTEGER - 1,
    });
    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnCalls[1]?.[1][2]).toBe(String(Number.MAX_SAFE_INTEGER));

    writeLifecycleEvent(children[1]!, Number.MAX_SAFE_INTEGER);
    await Promise.resolve();

    expect(children[1]!.killCalls).toBe(1);
    expect(observedKinds).toEqual([]);
    children[1]!.crash();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawnCalls[2]?.[1][2]).toBe(String(Number.MAX_SAFE_INTEGER));
  });

  it("keeps owner identity revisions separate from the runtime revision fence", async () => {
    vi.useFakeTimers();
    const { children, spawnCalls, supervisor } = createHarness();
    const observedKinds: string[] = [];
    supervisor.subscribe((event) => observedKinds.push(event.kind));
    supervisor.start();
    const status = supervisor.request({ kind: "get_status" });
    const statusRequest = children[0]!.requests()[0]!;
    children[0]!.respond(successResponse(statusRequest.id, runtimeSnapshot(5, "running")));
    await expect(status).resolves.toMatchObject({ revision: 5 });

    children[0]!.stdout.write(
      `${JSON.stringify({
        version: DESKTOP_PROTOCOL_VERSION,
        event: {
          kind: "owner_identity",
          owner: {
            revision: 99,
            ownerUsername: "NewOwner",
            configured: true,
            presence: "online",
          },
        },
      })}\n`,
    );
    await Promise.resolve();
    writeLifecycleEvent(children[0]!, 6, "stopped");
    await Promise.resolve();

    expect(children[0]!.killCalls).toBe(0);
    expect(observedKinds).toEqual(["owner_identity", "lifecycle"]);
    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnCalls[1]?.[1][2]).toBe("7");
  });

  it("tags owner events with the managed child generation across restart", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    const observed: Array<{ ownerUsername: string | null; childGeneration: number | undefined }> =
      [];
    (
      supervisor.subscribe as unknown as (
        listener: (event: DesktopEvent["event"], context: { childGeneration: number }) => void,
      ) => () => void
    )((event, context) => {
      if (event.kind === "owner_identity") {
        observed.push({
          ownerUsername: event.owner.ownerUsername,
          childGeneration: context?.childGeneration,
        });
      }
    });
    supervisor.start();

    writeOwnerIdentityEvent(children[0]!, {
      revision: 7,
      ownerUsername: "OldOwner",
      presence: "online",
    });
    children[0]!.crash();
    children[0]!.finishClose();
    await vi.advanceTimersByTimeAsync(1_000);
    writeOwnerIdentityEvent(children[1]!, {
      revision: 0,
      ownerUsername: "NewOwner",
      presence: "offline",
    });

    expect(observed).toEqual([
      { ownerUsername: "OldOwner", childGeneration: 1 },
      { ownerUsername: "NewOwner", childGeneration: 2 },
    ]);
  });

  it("accepts equal and newer correlated full snapshots before the exact next runtime event", async () => {
    vi.useFakeTimers();
    const { children, spawnCalls, supervisor } = createHarness();
    const observedRevisions: number[] = [];
    supervisor.subscribe((event) => {
      if (event.kind !== "account" && event.kind !== "owner_identity") {
        observedRevisions.push(event.revision);
      }
    });
    supervisor.start();

    for (const [revision, lifecycle] of [
      [5, "running"],
      [5, "running"],
      [8, "stopping"],
    ] as const) {
      const status = supervisor.request({ kind: "get_status" });
      const statusRequest = children[0]!.requests().at(-1)!;
      children[0]!.respond(successResponse(statusRequest.id, runtimeSnapshot(revision, lifecycle)));
      await expect(status).resolves.toMatchObject({ revision, lifecycle });
    }

    writeLifecycleEvent(children[0]!, 9, "stopped");
    await Promise.resolve();

    expect(children[0]!.killCalls).toBe(0);
    expect(observedRevisions).toEqual([9]);
    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnCalls[1]?.[1][2]).toBe("10");
  });

  it("preserves authoritative invalidation revision high-water across child restart", async () => {
    vi.useFakeTimers();
    const { children, spawnCalls, supervisor } = createHarness();
    const observed: Array<{ kind: string; revision?: number }> = [];
    supervisor.subscribe((event) => observed.push(event));
    supervisor.start();

    children[0]!.stdout.write(
      `${JSON.stringify({
        version: DESKTOP_PROTOCOL_VERSION,
        event: {
          kind: "connection_invalidated",
          revision: 1,
          reason: "lan_changed",
          snapshot: runtimeSnapshot(1, "stopped"),
        },
      })}\n`,
    );
    await Promise.resolve();

    expect(observed).toEqual([
      expect.objectContaining({ kind: "connection_invalidated", revision: 1 }),
    ]);
    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnCalls[1]?.[1][2]).toBe("2");
  });

  it("quarantines unsafe invalidation snapshots without advancing restart high-water", async () => {
    vi.useFakeTimers();
    const { children, spawnCalls, supervisor } = createHarness();
    const observed: string[] = [];
    supervisor.subscribe((event) => observed.push(event.kind));
    supervisor.start();
    const baseline = supervisor.request({ kind: "get_status" });
    const baselineRequest = children[0]!.requests()[0]!;
    children[0]!.respond(successResponse(baselineRequest.id, runtimeSnapshot(5, "running")));
    await baseline;

    children[0]!.stdout.write(
      `${JSON.stringify({
        version: DESKTOP_PROTOCOL_VERSION,
        event: {
          kind: "connection_invalidated",
          revision: 6,
          reason: "model_unavailable",
          snapshot: {
            ...runtimeSnapshot(6, "running"),
            minecraft: { state: "connected", sessionId: null },
          },
        },
      })}\n`,
    );
    await Promise.resolve();

    expect(children[0]!.killCalls).toBe(1);
    expect(observed).not.toContain("connection_invalidated");
    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnCalls[1]?.[1][2]).toBe("6");
  });

  it("quarantines a correlated full snapshot that regresses the current process cursor", async () => {
    vi.useFakeTimers();
    const { children, spawnCalls, supervisor } = createHarness();
    supervisor.start();
    const baseline = supervisor.request({ kind: "get_status" });
    const baselineRequest = children[0]!.requests()[0]!;
    children[0]!.respond(successResponse(baselineRequest.id, runtimeSnapshot(5, "running")));
    await expect(baseline).resolves.toMatchObject({ revision: 5 });

    const regressing = caught(supervisor.request({ kind: "get_status" }));
    const regressingRequest = children[0]!.requests()[1]!;
    children[0]!.respond(successResponse(regressingRequest.id, runtimeSnapshot(4, "stopped")));

    await expect(regressing).resolves.toMatchObject({
      message: expect.stringContaining("malformed protocol"),
    });
    expect(children[0]!.killCalls).toBe(1);
    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnCalls[1]?.[1][2]).toBe("6");
  });

  it("does not let an uncorrelated full snapshot advance the next child seed", async () => {
    vi.useFakeTimers();
    const { children, spawnCalls, supervisor } = createHarness();
    supervisor.start();

    children[0]!.respond(successResponse("desktop_unknown", runtimeSnapshot(500, "running")));
    await Promise.resolve();

    expect(children[0]!.killCalls).toBe(1);
    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnCalls[1]?.[1][2]).toBe("1");
  });

  it("fails closed instead of restarting past the safe revision range", async () => {
    vi.useFakeTimers();
    const { children, spawnCalls, supervisor } = createHarness();
    supervisor.start();
    const status = supervisor.request({ kind: "get_status" });
    const request = children[0]!.requests()[0]!;
    children[0]!.respond(
      successResponse(request.id, runtimeSnapshot(Number.MAX_SAFE_INTEGER, "running")),
    );
    await expect(status).resolves.toMatchObject({ revision: Number.MAX_SAFE_INTEGER });

    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(children).toHaveLength(1);
    expect(spawnCalls).toHaveLength(1);
    expect(() => supervisor.start()).toThrow(/revision.*exhausted/iu);
    expect(spawnCalls).toHaveLength(1);
  });

  it("never replays start_runtime after a crash restart", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();

    const started = supervisor.request({ kind: "start_runtime" });
    const request = children[0]?.requests()[0];
    expect(request?.command).toEqual({ kind: "start_runtime" });
    children[0]?.respond({
      version: DESKTOP_PROTOCOL_VERSION,
      id: request!.id,
      ok: true,
      result: { ...idleSnapshot, lifecycle: "running" },
    });
    await expect(started).resolves.toMatchObject({ lifecycle: "running" });

    children[0]?.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children[1]?.requests()).toEqual([]);
  });

  it("quarantines malformed protocol until the child actually exits", async () => {
    vi.useFakeTimers();
    const { children, supervisor } = createHarness();
    supervisor.start();

    const outcome = supervisor.request({ kind: "get_status" }).catch((error: unknown) => error);
    const request = children[0]?.requests()[0];
    children[0]?.stdout.write(
      `${JSON.stringify({
        version: DESKTOP_PROTOCOL_VERSION,
        id: request!.id,
        ok: true,
        result: idleSnapshot,
        leakedPath: String.raw`C:\secret`,
      })}\n`,
    );

    await expect(outcome).resolves.toMatchObject({
      message: expect.stringContaining("malformed"),
    });
    expect(children[0]?.killCalls).toBe(1);
    expect(children[0]?.alive).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children).toHaveLength(1);

    children[0]!.crash();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);
    expect(children.filter((child) => child.alive)).toHaveLength(1);
  });

  it("fails every pending request when the child exits", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    const first = supervisor.request({ kind: "get_status" }).catch((error: unknown) => error);
    const second = supervisor.request({ kind: "stop_runtime" }).catch((error: unknown) => error);

    children[0]?.crash();

    await expect(first).resolves.toMatchObject({
      message: expect.stringContaining("exited"),
    });
    await expect(second).resolves.toMatchObject({
      message: expect.stringContaining("exited"),
    });
  });

  describe("bounded shutdown", () => {
    it("lets an acknowledged child finish through stdin EOF before resolving", async () => {
      const { children, supervisor } = createHarness();
      supervisor.start();

      const shutdown = supervisor.shutdown();
      const emergency = children[0]!.requests()[0]!;
      children[0]!.respond(successResponse(emergency.id));
      await Promise.resolve();
      await Promise.resolve();

      expect(children[0]!.stdin.writableEnded).toBe(true);
      expect(children[0]!.killCalls).toBe(0);
      let settled = false;
      void shutdown.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      children[0]!.crash(0);
      await expect(shutdown).resolves.toBeUndefined();
      expect(children[0]!.killCalls).toBe(0);
    });

    it("kills only after an emergency acknowledgement timeout", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      children[0]!.exitOnKill = true;

      const shutdown = supervisor.shutdown();
      await vi.advanceTimersByTimeAsync(1_499);
      expect(children[0]!.killCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(children[0]!.killCalls).toBe(1);
      await expect(shutdown).resolves.toBeUndefined();
    });

    it("kills after the bounded EOF exit wait expires", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      children[0]!.exitOnKill = true;

      const shutdown = supervisor.shutdown();
      const emergency = children[0]!.requests()[0]!;
      children[0]!.respond(successResponse(emergency.id));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(3_499);
      expect(children[0]!.killCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(children[0]!.killCalls).toBe(1);
      await expect(shutdown).resolves.toBeUndefined();
    });

    it("rejects concurrent ordinary pending work before sending emergency stop", async () => {
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));

      const shutdown = supervisor.shutdown();

      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("shutting down"),
      });
      expect(children[0]!.requests().map((request) => request.command.kind)).toEqual([
        "get_status",
        "emergency_stop",
      ]);
      children[0]!.crash(0);
      await expect(shutdown).resolves.toBeUndefined();
    });

    it("ignores a canceled ordinary response while awaiting graceful shutdown exit", async () => {
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));
      const ordinary = children[0]!.requests()[0]!;
      const shutdown = supervisor.shutdown();
      const emergency = children[0]!.requests()[1]!;
      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("shutting down"),
      });

      children[0]!.respond(successResponse(emergency.id));
      children[0]!.respond(successResponse(ordinary.id));
      await Promise.resolve();
      await Promise.resolve();

      expect(children[0]!.killCalls).toBe(0);
      children[0]!.crash(0);
      await expect(shutdown).resolves.toBeUndefined();
    });

    it("returns the same shutdown operation for repeated calls", async () => {
      const { children, supervisor } = createHarness();
      supervisor.start();

      const first = supervisor.shutdown();
      const second = supervisor.shutdown();

      expect(first).toBe(second);
      expect(children[0]!.requests()).toHaveLength(1);
      children[0]!.crash(0);
      await expect(first).resolves.toBeUndefined();
    });

    it("handles child exit while the emergency request is pending", async () => {
      const { children, supervisor } = createHarness();
      supervisor.start();

      const shutdown = supervisor.shutdown();
      children[0]!.crash(0);

      await expect(shutdown).resolves.toBeUndefined();
      expect(children[0]!.killCalls).toBe(0);
    });

    it("rejects when a timed-out child cannot be killed", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      children[0]!.killResult = false;

      const shutdown = caught(supervisor.shutdown());
      await vi.advanceTimersByTimeAsync(1_500);

      await expect(shutdown).resolves.toMatchObject({
        message: expect.stringContaining("could not be killed"),
      });
      expect(children).toHaveLength(1);
      expect(children[0]!.alive).toBe(true);
      expect(() => supervisor.start()).toThrow("shutting down");
    });

    it("reports an unconfirmed kill while retaining the quarantined child", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();

      const shutdown = caught(supervisor.shutdown());
      await vi.advanceTimersByTimeAsync(1_500);

      await expect(shutdown).resolves.toMatchObject({
        message: expect.stringContaining("did not exit"),
      });
      expect(children[0]!.killCalls).toBe(1);
      expect(children[0]!.alive).toBe(true);
      expect(children).toHaveLength(1);
    });

    it("rejects force termination without confirmed exit and never restarts", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      children[0]!.killResult = false;

      const force = caught(supervisor.forceTerminate());
      expect(children[0]!.killCalls).toBe(1);
      expect(children[0]!.alive).toBe(true);
      await vi.advanceTimersByTimeAsync(999);
      let settled = false;
      void force.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(force).resolves.toMatchObject({
        message: expect.stringContaining("termination was not confirmed"),
      });
      expect(children).toHaveLength(1);

      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(children).toHaveLength(1);
    });

    it("retries the force-kill request after bounded shutdown failure without releasing ownership", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      children[0]!.killResult = false;

      const shutdown = caught(supervisor.shutdown());
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(shutdown).resolves.toMatchObject({
        message: expect.stringContaining("could not be killed"),
      });
      expect(children[0]!.killCalls).toBe(1);

      const force = caught(supervisor.forceTerminate());
      expect(children[0]!.killCalls).toBe(2);
      expect(children[0]!.alive).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(force).resolves.toMatchObject({
        message: expect.stringContaining("termination was not confirmed"),
      });
      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(children).toHaveLength(1);
    });

    it("resolves force termination only after a later real exit", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();

      const force = supervisor.forceTerminate();
      expect(children[0]!.killCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(children[0]!.alive).toBe(true);
      children[0]!.crash();

      await expect(force).resolves.toBeUndefined();
    });

    it("resolves force termination after aggregate close without exit", async () => {
      const { children, supervisor } = createHarness();
      supervisor.start();

      const force = supervisor.forceTerminate();
      children[0]!.finishClose();

      await expect(force).resolves.toBeUndefined();
    });
  });

  describe("process and pipe failures", () => {
    it("retains all pipe error sinks after exit until aggregate close", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));

      children[0]!.crash();
      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("exited"),
      });

      expect(() => children[0]!.stdin.emit("error", new Error("late stdin"))).not.toThrow();
      expect(() => children[0]!.stdout.emit("error", new Error("late stdout"))).not.toThrow();
      expect(() => children[0]!.stderr.emit("error", new Error("late stderr"))).not.toThrow();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(2);
      expect(children.filter((child) => child.alive)).toHaveLength(1);

      children[0]!.finishClose();
      expect(children[0]!.stdin.listenerCount("error")).toBe(0);
      expect(children[0]!.stdout.listenerCount("error")).toBe(0);
      expect(children[0]!.stderr.listenerCount("error")).toBe(0);
    });

    it("finalizes a failed spawn on close without requiring exit", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));

      children[0]!.emit("error", new Error("spawn EACCES"));
      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("child process failed"),
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(children).toHaveLength(1);
      expect(children[0]!.exited).toBe(false);

      children[0]!.finishClose(null);
      await vi.advanceTimersByTimeAsync(999);
      expect(children).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(2);
      expect(children.filter((child) => child.alive)).toHaveLength(1);
    });

    it("settles racing error, exit, and close notifications exactly once", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));

      children[0]!.emit("error", new Error("spawn failed"));
      children[0]!.emit("error", new Error("duplicate process error"));
      children[0]!.stdin.emit("error", new Error("EPIPE"));
      children[0]!.crash();
      expect(() => children[0]!.stdout.emit("error", new Error("late stdout"))).not.toThrow();
      expect(() => children[0]!.stderr.emit("error", new Error("late stderr"))).not.toThrow();
      children[0]!.emit("exit", 1, null);
      children[0]!.finishClose();
      children[0]!.emit("close", 1, null);

      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("child process failed"),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(children).toHaveLength(2);
      expect(children.filter((child) => child.alive)).toHaveLength(1);
    });

    it("attaches a safe error sink before rejecting partial stdio", async () => {
      vi.useFakeTimers();
      const partial = new PartialFakeChild();
      const replacements: FakeChild[] = [];
      let spawnCount = 0;
      const spawn: SpawnChild = () => {
        spawnCount += 1;
        if (spawnCount === 1) return partial;
        if (partial.alive || replacements.some((child) => child.alive)) {
          throw new Error("test observed two alive WhiteLily children");
        }
        const child = new FakeChild();
        replacements.push(child);
        return child;
      };
      const supervisor = new ChildSupervisor({
        childEntry: String.raw`C:\Program Files\WhiteLily\resources\childMain.js`,
        configPath: String.raw`C:\LocalAppData\owner\WhiteLily\config.toml`,
        workingDirectory: String.raw`C:\LocalAppData\owner\WhiteLily`,
        environment: {
          LOCALAPPDATA: String.raw`C:\LocalAppData\owner`,
          WHITELILY_DATA_ROOT: String.raw`C:\LocalAppData\owner\WhiteLily`,
        },
        development: true,
        spawn,
      });

      expect(() => supervisor.start()).toThrow("separate protocol streams");
      expect(partial.killCalls).toBe(1);
      expect(() => partial.stdin.emit("error", new Error("late partial EPIPE"))).not.toThrow();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(spawnCount).toBe(1);

      partial.finishClose();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(spawnCount).toBe(2);
      expect(replacements[0]!.alive).toBe(true);
    });

    it("quarantines a process error and restarts once only after exit", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));

      children[0]!.emit("error", new Error("spawn EACCES"));

      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("child process failed"),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(1);
      expect(children[0]!.alive).toBe(true);

      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(2);
      expect(children.filter((child) => child.alive)).toHaveLength(1);
    });

    it("quarantines asynchronous stdin EPIPE until actual exit", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));

      children[0]!.stdin.emit("error", new Error("EPIPE"));

      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("stdin failed"),
      });
      expect(children[0]!.killCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(1);

      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(2);
      expect(children.filter((child) => child.alive)).toHaveLength(1);
    });

    it("quarantines an independent stderr failure until actual exit", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));

      children[0]!.stderr.emit("error", new Error("stderr failed"));

      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("stderr failed"),
      });
      expect(children[0]!.killCalls).toBe(1);
      expect(children[0]!.alive).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(1);

      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(2);
    });

    it("quarantines stdout failure and restarts once only after exit", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));

      children[0]!.stdout.emit("error", new Error("stdout failed"));
      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("stdout failed"),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(1);
      expect(children[0]!.alive).toBe(true);

      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(children).toHaveLength(2);
      expect(children[0]!.killCalls).toBe(1);
    });

    it("ignores duplicate error, pipe, and exit notifications for restart accounting", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();

      children[0]!.emit("error", new Error("spawn failed"));
      children[0]!.stdin.emit("error", new Error("EPIPE"));
      children[0]!.stdout.emit("error", new Error("closed"));
      children[0]!.stderr.emit("error", new Error("closed"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(children).toHaveLength(1);
      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(children).toHaveLength(2);
    });

    it("preserves the initiating pipe failure when kill emits exit synchronously", async () => {
      const { children, supervisor } = createHarness();
      supervisor.start();
      children[0]!.exitOnKill = true;
      const pending = caught(supervisor.request({ kind: "get_status" }));

      children[0]!.stdin.emit("error", new Error("EPIPE"));

      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("stdin failed"),
      });
      expect(children[0]!.killCalls).toBe(1);
    });

    it("quarantines a synchronous stdin write throw and settles all pending once", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      const first = caught(supervisor.request({ kind: "get_status" }));
      vi.spyOn(children[0]!.stdin, "write").mockImplementationOnce(() => {
        throw new Error("sync EPIPE");
      });

      const second = caught(supervisor.request({ kind: "stop_runtime" }));

      await expect(first).resolves.toMatchObject({
        message: expect.stringContaining("stdin failed"),
      });
      await expect(second).resolves.toMatchObject({
        message: expect.stringContaining("stdin failed"),
      });
      expect(children[0]!.killCalls).toBe(1);
      expect(children[0]!.alive).toBe(true);
      await expect(supervisor.request({ kind: "get_status" })).rejects.toThrow("quarantined");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(children).toHaveLength(1);

      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(children).toHaveLength(2);
      expect(children.filter((child) => child.alive)).toHaveLength(1);
    });
  });

  describe("bounded protocol parser", () => {
    it.each([
      ["malformed JSON", Buffer.from("{not-json}\n")],
      ["empty line", Buffer.from("\n")],
      [
        "invalid UTF-8",
        Buffer.concat([
          Buffer.from(
            '{"version":1,"id":"desktop_1","ok":false,"error":{"code":"INTERNAL_ERROR","message":"',
          ),
          Buffer.from([0xc3, 0x28]),
          Buffer.from('"}}\n'),
        ]),
      ],
    ])("rejects %s", async (_label, bytes) => {
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));

      children[0]!.stdout.write(bytes);

      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("malformed protocol"),
      });
      expect(children[0]!.killCalls).toBe(1);
    });

    it("accepts a valid response line at exactly the 1 MiB boundary", async () => {
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = supervisor.request({ kind: "get_status" });
      const request = children[0]!.requests()[0]!;
      const response = JSON.stringify(successResponse(request.id));
      const padding = " ".repeat(MAX_DESKTOP_LINE_BYTES - Buffer.byteLength(response));

      children[0]!.stdout.write(`${response}${padding}\n`);

      await expect(pending).resolves.toEqual(idleSnapshot);
      expect(children[0]!.killCalls).toBe(0);
    });

    it("rejects an oversized line split across chunks without buffering its remainder", async () => {
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));

      children[0]!.stdout.write(Buffer.alloc(MAX_DESKTOP_LINE_BYTES, 0x20));
      children[0]!.stdout.write(Buffer.from("x\n"));

      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("malformed protocol"),
      });
      expect(children[0]!.killCalls).toBe(1);
    });

    it("parses multiple response lines delivered in one chunk", async () => {
      const { children, supervisor } = createHarness();
      supervisor.start();
      const first = supervisor.request({ kind: "get_status" });
      const second = supervisor.request({ kind: "stop_runtime" });
      const [firstRequest, secondRequest] = children[0]!.requests();

      children[0]!.stdout.write(
        `${JSON.stringify(successResponse(firstRequest!.id))}\n${JSON.stringify(
          successResponse(secondRequest!.id),
        )}\n`,
      );

      await expect(first).resolves.toEqual(idleSnapshot);
      await expect(second).resolves.toEqual(idleSnapshot);
    });

    it("quarantines an arbitrary well-formed unknown response ID", async () => {
      const { children, supervisor } = createHarness();
      supervisor.start();

      children[0]!.respond(successResponse("desktop_unknown"));
      await Promise.resolve();

      expect(children[0]!.killCalls).toBe(1);
      expect(children[0]!.alive).toBe(true);
      expect(() => supervisor.start()).toThrow("quarantined");
      expect(children).toHaveLength(1);
    });

    it("rejects a response ID after its request timed out", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));
      const request = children[0]!.requests()[0]!;
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("timed out"),
      });

      children[0]!.respond(successResponse(request.id));
      await Promise.resolve();
      expect(children[0]!.killCalls).toBe(1);
    });

    it("rejects malformed runtime events", async () => {
      const { children, supervisor } = createHarness();
      supervisor.start();

      children[0]!.stdout.write(
        `${JSON.stringify({
          version: DESKTOP_PROTOCOL_VERSION,
          event: { kind: "lifecycle", state: "running", leaked: true },
        })}\n`,
      );
      await Promise.resolve();

      expect(children[0]!.killCalls).toBe(1);
    });

    it("settles an exit-before-timeout race once as an exit", async () => {
      vi.useFakeTimers();
      const { children, supervisor } = createHarness();
      supervisor.start();
      const pending = caught(supervisor.request({ kind: "get_status" }));

      await vi.advanceTimersByTimeAsync(9_999);
      children[0]!.crash();
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining("exited"),
      });
      expect(children[0]!.killCalls).toBe(0);
    });
  });
});

describe("resolveAppPaths", () => {
  it("derives all data paths from the caller-supplied absolute LOCALAPPDATA", () => {
    expect(resolveAppPaths(String.raw`C:\LocalAppData\owner`)).toEqual({
      dataRoot: win32.join(String.raw`C:\LocalAppData\owner`, "WhiteLily"),
      configPath: win32.join(String.raw`C:\LocalAppData\owner`, "WhiteLily", "config.toml"),
      logRoot: win32.join(String.raw`C:\LocalAppData\owner`, "WhiteLily", "logs"),
    });
  });

  it.each(["", "AppData/Local", String.raw`%LOCALAPPDATA%`])(
    "rejects unvalidated LOCALAPPDATA input %j",
    (localAppData) => {
      expect(() => resolveAppPaths(localAppData)).toThrow("absolute LOCALAPPDATA");
    },
  );
});
