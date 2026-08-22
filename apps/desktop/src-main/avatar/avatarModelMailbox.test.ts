import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AvatarModelControlRequest,
  AvatarModelControlState,
} from "../../../../src/avatar/avatarModelTypes.js";
import { AvatarModelMailbox } from "./avatarModelMailbox.js";
import { resolveAvatarModelPaths } from "./avatarModelPaths.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("AvatarModelMailbox", () => {
  it("atomically publishes a schema-validated request", async () => {
    const harness = await createHarness();
    const request = prepareRequest();

    await harness.mailbox.publish(request);

    expect(JSON.parse(await readFile(harness.requestPath, "utf8"))).toEqual(request);
  });

  it("uses one production request slot whose next write replaces the previous operation", async () => {
    const harness = await createHarness();
    const prepare = prepareRequest();
    const cancellation: AvatarModelControlRequest = {
      schemaVersion: 1,
      requestId: prepare.requestId,
      operation: "cancel",
      modelId: prepare.modelId,
      worldSessionId: prepare.worldSessionId,
      issuedAt: "2026-08-16T08:00:02.000Z",
    };

    await harness.mailbox.publish(prepare);
    await harness.mailbox.publish(cancellation);

    expect(JSON.parse(await readFile(harness.requestPath, "utf8"))).toEqual(cancellation);
  });

  it("ignores stale request ids and wrong worlds before accepting a matching state", async () => {
    const harness = await createHarness();
    const request = prepareRequest();
    await harness.mailbox.publish(request);
    const waiting = harness.mailbox.waitForState({
      requestId: request.requestId,
      accepted: ["ready", "failed"],
      signal: new AbortController().signal,
      timeoutMs: 500,
    });

    await harness.writeState(state("ready", { requestId: "stale-request" }));
    await harness.waitForPoll();
    await harness.writeState(state("ready", { worldSessionId: "world-old" }));
    await harness.waitForPoll();
    await harness.writeState(state("ready"));

    await expect(waiting).resolves.toMatchObject({
      requestId: request.requestId,
      phase: "ready",
      worldSessionId: "world-0001",
    });
  });

  it("ignores malformed state documents and records one stable diagnostic", async () => {
    const harness = await createHarness();
    await harness.mailbox.publish(prepareRequest());
    const waiting = harness.mailbox.waitForState({
      requestId: "switch-0001",
      accepted: ["ready"],
      signal: new AbortController().signal,
      timeoutMs: 500,
    });

    await writeFile(harness.statePath, "{corrupt", "utf8");
    await vi.waitFor(() => expect(harness.diagnostics).toContain("AVATAR_MAILBOX_STATE_INVALID"));
    await harness.writeState(state("ready"));

    await expect(waiting).resolves.toMatchObject({ phase: "ready" });
    expect(harness.diagnostics).toContain("AVATAR_MAILBOX_STATE_INVALID");
  });

  it("aborts without waiting for the polling timeout", async () => {
    const harness = await createHarness();
    await harness.mailbox.publish(prepareRequest());
    const controller = new AbortController();
    const waiting = harness.mailbox.waitForState({
      requestId: "switch-0001",
      accepted: ["ready"],
      signal: controller.signal,
      timeoutMs: 1_000,
    });

    controller.abort();

    await expect(waiting).rejects.toMatchObject({ code: "AVATAR_MAILBOX_ABORTED" });
  });

  it("returns a stable timeout code without a busy loop", async () => {
    const harness = await createHarness();
    await harness.mailbox.publish(prepareRequest());

    await expect(
      harness.mailbox.waitForState({
        requestId: "switch-0001",
        accepted: ["ready"],
        signal: new AbortController().signal,
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: "AVATAR_MAILBOX_TIMEOUT" });
  });
});

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-mailbox-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAvatarModelPaths(root);
  await mkdir(paths.bridgeRoot, { recursive: true });
  const diagnostics: string[] = [];
  return {
    root,
    requestPath: join(paths.bridgeRoot, "request.json"),
    statePath: join(paths.bridgeRoot, "state.json"),
    diagnostics,
    mailbox: new AvatarModelMailbox({
      dataRoot: root,
      currentWorldSessionId: () => "world-0001",
      pollIntervalMs: 10,
      diagnostic: (code) => diagnostics.push(code),
    }),
    writeState: (value: AvatarModelControlState) =>
      writeFile(join(paths.bridgeRoot, "state.json"), `${JSON.stringify(value)}\n`, "utf8"),
    waitForPoll: () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
  };
}

function prepareRequest(): AvatarModelControlRequest {
  return {
    schemaVersion: 1,
    requestId: "switch-0001",
    operation: "prepare",
    modelId: "builtin:whitelily",
    worldSessionId: "world-0001",
    candidate: {
      modelId: "builtin:whitelily",
      origin: "builtin",
      worldRenderer: "minecraft-skin",
      armModel: "slim",
    },
    issuedAt: "2026-08-16T08:00:00.000Z",
  };
}

function state(
  phase: AvatarModelControlState["phase"],
  overrides: Partial<AvatarModelControlState> = {},
): AvatarModelControlState {
  return {
    schemaVersion: 1,
    requestId: "switch-0001",
    phase,
    activeModelId: "builtin:whitelily",
    candidateModelId: "builtin:whitelily",
    worldSessionId: "world-0001",
    ...(phase === "failed" ? { errorCode: "AVATAR_SHADER_FAILED" } : {}),
    updatedAt: "2026-08-16T08:00:01.000Z",
    ...overrides,
  };
}
