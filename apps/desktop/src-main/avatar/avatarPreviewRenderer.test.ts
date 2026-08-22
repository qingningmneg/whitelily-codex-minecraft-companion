import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvatarBoneMapping } from "./avatarBoneMapper.js";
import {
  AvatarPreviewRenderer,
  type AvatarPreviewMessagePort,
  type AvatarPreviewWindowPort,
} from "./avatarPreviewRenderer.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("AvatarPreviewRenderer", () => {
  it("renders a bounded transparent 512px PNG and disposes the isolated window", async () => {
    const harness = await createHarness();

    const result = await harness.renderer.render({
      modelPath: harness.modelPath,
      outputPath: harness.outputPath,
      mapping: completeBoneMapping(),
    });

    expect(result).toEqual({ width: 512, height: 512, format: "png" });
    await expect(readFile(harness.outputPath)).resolves.toEqual(harness.png);
    expect(harness.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 512,
        height: 512,
        show: false,
        backgroundColor: "#00000000",
        webPreferences: expect.objectContaining({
          offscreen: true,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          preload: harness.previewPreloadPath,
        }),
      }),
    );
    expect(harness.window.loadFile).toHaveBeenCalledWith(harness.previewPagePath);
    expect(harness.window.destroy).toHaveBeenCalledOnce();
    expect(harness.mainPort.closed).toBe(true);
    expect(harness.rendererPort.closed).toBe(true);
  });

  it("allows only packaged file assets under the preview root", async () => {
    const harness = await createHarness();
    await harness.renderer.render({
      modelPath: harness.modelPath,
      outputPath: harness.outputPath,
      mapping: completeBoneMapping(),
    });

    expect(harness.requestDecision("https://example.test/model.glb")).toEqual({ cancel: true });
    expect(harness.requestDecision("file:///C:/outside/attack.js")).toEqual({ cancel: true });
    expect(harness.requestDecision(harness.previewPageUrl)).toEqual({ cancel: false });
    expect(harness.requestDecision(harness.previewAssetUrl)).toEqual({ cancel: false });
  });

  it("destroys the hidden window when the preview page reports a render failure", async () => {
    const harness = await createHarness({ rendererFailure: true });

    await expect(
      harness.renderer.render({
        modelPath: harness.modelPath,
        outputPath: harness.outputPath,
        mapping: completeBoneMapping(),
      }),
    ).rejects.toMatchObject({ code: "AVATAR_PREVIEW_FAILED" });
    expect(harness.window.destroy).toHaveBeenCalledOnce();
  });

  it("times out and disposes a preview page that never becomes ready", async () => {
    const harness = await createHarness({ neverReady: true, timeoutMilliseconds: 5 });

    await expect(
      harness.renderer.render({
        modelPath: harness.modelPath,
        outputPath: harness.outputPath,
        mapping: completeBoneMapping(),
      }),
    ).rejects.toMatchObject({ code: "AVATAR_PREVIEW_FAILED" });
    expect(harness.window.destroy).toHaveBeenCalledOnce();
    expect(harness.mainPort.closed).toBe(true);
  });
});

async function createHarness(
  options: {
    readonly rendererFailure?: boolean;
    readonly neverReady?: boolean;
    readonly timeoutMilliseconds?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-preview-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const previewRoot = join(root, "renderer");
  const previewPagePath = join(previewRoot, "src-preview", "avatarPreview.html");
  const previewPreloadPath = join(root, "preload", "avatar-preview-preload.cjs");
  const modelPath = join(root, "model.glb");
  const outputPath = join(root, "preview.png");
  const model = Buffer.from("validated-glb", "utf8");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
  await writeFile(modelPath, model);
  const [mainPort, rendererPort] = createPortPair();
  let requestListener:
    | ((details: { url: string }, callback: (decision: { cancel: boolean }) => void) => void)
    | undefined;
  const webRequest = {
    onBeforeRequest: vi.fn(
      (
        _filter: { urls: string[] },
        listener:
          | ((details: { url: string }, callback: (decision: { cancel: boolean }) => void) => void)
          | null,
      ) => {
        if (listener !== null) requestListener = listener;
      },
    ),
  };
  const window = {
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(),
    loadFile: vi.fn(async () => undefined),
    webContents: {
      session: { webRequest },
      postMessage: vi.fn(
        (_channel: string, _message: unknown, ports: AvatarPreviewMessagePort[]) => {
          const port = ports[0];
          if (port === undefined || options.neverReady) return;
          port.on("message", ({ data }) => {
            if (!isPlainObject(data) || data.kind !== "render") return;
            port.postMessage(
              options.rendererFailure
                ? { kind: "error", code: "AVATAR_PREVIEW_FAILED" }
                : { kind: "rendered", width: 512, height: 512 },
            );
          });
          port.start();
          port.postMessage({ kind: "ready" });
        },
      ),
      capturePage: vi.fn(async () => ({
        getSize: () => ({ width: 512, height: 512 }),
        toPNG: () => png,
      })),
    },
  } satisfies AvatarPreviewWindowPort;
  const createWindow = vi.fn(() => window);
  const renderer = new AvatarPreviewRenderer({
    createWindow,
    createMessageChannel: () => ({ port1: mainPort, port2: rendererPort }),
    previewPagePath,
    previewPreloadPath,
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });
  return {
    root,
    renderer,
    window,
    createWindow,
    mainPort,
    rendererPort,
    previewPagePath,
    previewPreloadPath,
    previewPageUrl: pathToFileURL(previewPagePath).href,
    previewAssetUrl: pathToFileURL(join(previewRoot, "assets", "preview.js")).href,
    modelPath,
    outputPath,
    png,
    requestDecision: (url: string) => {
      let decision: { cancel: boolean } | undefined;
      requestListener?.({ url }, (value) => {
        decision = value;
      });
      return decision;
    },
  };
}

class FakeMessagePort implements AvatarPreviewMessagePort {
  peer: FakeMessagePort | undefined;
  listeners: Array<(event: { data: unknown }) => void> = [];
  closed = false;

  on(_event: "message", listener: (event: { data: unknown }) => void): this {
    this.listeners.push(listener);
    return this;
  }

  start(): void {}

  postMessage(message: unknown): void {
    queueMicrotask(() => {
      for (const listener of this.peer?.listeners ?? []) listener({ data: message });
    });
  }

  close(): void {
    this.closed = true;
  }
}

function createPortPair(): readonly [FakeMessagePort, FakeMessagePort] {
  const first = new FakeMessagePort();
  const second = new FakeMessagePort();
  first.peer = second;
  second.peer = first;
  return [first, second];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completeBoneMapping(): AvatarBoneMapping {
  return {
    head: "Head",
    neck: "Neck",
    chest: "Chest",
    hips: "Hips",
    leftUpperArm: "LeftUpperArm",
    leftLowerArm: "LeftLowerArm",
    leftHand: "LeftHand",
    rightUpperArm: "RightUpperArm",
    rightLowerArm: "RightLowerArm",
    rightHand: "RightHand",
    leftUpperLeg: "LeftUpperLeg",
    leftLowerLeg: "LeftLowerLeg",
    leftFoot: "LeftFoot",
    rightUpperLeg: "RightUpperLeg",
    rightLowerLeg: "RightLowerLeg",
    rightFoot: "RightFoot",
  };
}
