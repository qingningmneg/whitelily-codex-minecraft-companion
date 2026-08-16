import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindowConstructorOptions } from "electron";
import type { AvatarBoneMapping } from "../../../../src/avatar/avatarModelTypes.js";
import { MAX_AVATAR_SOURCE_BYTES } from "./glbContainer.js";

const PREVIEW_PORT_CHANNEL = "whitelily:avatar-preview:port";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface AvatarPreviewResult {
  readonly width: 512;
  readonly height: 512;
  readonly format: "png";
}

export class AvatarPreviewError extends Error {
  readonly code = "AVATAR_PREVIEW_FAILED" as const;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "AvatarPreviewError";
  }
}

export interface AvatarPreviewMessagePort {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  start(): void;
  postMessage(message: unknown): void;
  close(): void;
}

interface AvatarPreviewNativeImagePort {
  getSize(): { readonly width: number; readonly height: number };
  toPNG(): Buffer;
}

type PreviewRequestListener = (
  details: { readonly url: string },
  callback: (decision: { readonly cancel: boolean }) => void,
) => void;

export interface AvatarPreviewWindowPort {
  isDestroyed(): boolean;
  destroy(): void;
  loadFile(path: string): Promise<unknown>;
  readonly webContents: {
    readonly session: {
      readonly webRequest: {
        onBeforeRequest(
          filter: { readonly urls: readonly string[] },
          listener: PreviewRequestListener | null,
        ): void;
      };
    };
    postMessage(channel: string, message: unknown, ports: AvatarPreviewMessagePort[]): void;
    capturePage(): Promise<AvatarPreviewNativeImagePort>;
  };
}

interface AvatarPreviewRendererOptions {
  readonly createWindow: (options: BrowserWindowConstructorOptions) => AvatarPreviewWindowPort;
  readonly createMessageChannel: () => {
    readonly port1: AvatarPreviewMessagePort;
    readonly port2: AvatarPreviewMessagePort;
  };
  readonly previewPagePath: string;
  readonly previewPreloadPath: string;
  readonly previewAssetRoot?: string;
  readonly timeoutMilliseconds?: number;
  readonly createPartitionId?: () => string;
}

const requestFilter = Object.freeze({ urls: Object.freeze(["*://*/*", "file://*/*"]) });

export class AvatarPreviewRenderer {
  readonly #createWindow: AvatarPreviewRendererOptions["createWindow"];
  readonly #createMessageChannel: AvatarPreviewRendererOptions["createMessageChannel"];
  readonly #previewPagePath: string;
  readonly #previewPreloadPath: string;
  readonly #previewAssetRoot: string;
  readonly #timeoutMilliseconds: number;
  readonly #createPartitionId: () => string;

  constructor(options: AvatarPreviewRendererOptions) {
    if (!isAbsolute(options.previewPagePath) || !isAbsolute(options.previewPreloadPath)) {
      throw new Error("avatar preview resources must be absolute");
    }
    this.#createWindow = options.createWindow;
    this.#createMessageChannel = options.createMessageChannel;
    this.#previewPagePath = resolve(options.previewPagePath);
    this.#previewPreloadPath = resolve(options.previewPreloadPath);
    this.#previewAssetRoot = resolve(
      options.previewAssetRoot ?? dirname(dirname(this.#previewPagePath)),
    );
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 8_000;
    if (
      !Number.isSafeInteger(this.#timeoutMilliseconds) ||
      this.#timeoutMilliseconds <= 0 ||
      this.#timeoutMilliseconds > 30_000
    ) {
      throw new Error("avatar preview timeout is invalid");
    }
    this.#createPartitionId = options.createPartitionId ?? randomUUID;
  }

  async render(input: {
    readonly modelPath: string;
    readonly outputPath: string;
    readonly mapping: AvatarBoneMapping;
  }): Promise<AvatarPreviewResult> {
    if (!isAbsolute(input.modelPath) || !isAbsolute(input.outputPath)) {
      throw new AvatarPreviewError("avatar preview paths are invalid");
    }
    const modelBytes = await readFile(input.modelPath);
    if (modelBytes.byteLength === 0 || modelBytes.byteLength > MAX_AVATAR_SOURCE_BYTES) {
      throw new AvatarPreviewError("avatar preview model is invalid");
    }
    const partitionId = this.#createPartitionId();
    if (!/^[0-9A-Za-z-]{1,64}$/u.test(partitionId)) {
      throw new AvatarPreviewError("avatar preview partition is invalid");
    }
    const window = this.#createWindow(
      createAvatarPreviewWindowOptions(this.#previewPreloadPath, `avatar-preview-${partitionId}`),
    );
    const { port1, port2 } = this.#createMessageChannel();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const requestListener: PreviewRequestListener = (details, callback) => {
      callback({ cancel: !isAllowedPreviewRequest(details.url, this.#previewAssetRoot) });
    };
    window.webContents.session.webRequest.onBeforeRequest(requestFilter, requestListener);

    try {
      const protocol = this.#runProtocol(
        window,
        port1,
        input.mapping,
        modelBytes,
        input.outputPath,
      );
      await window.loadFile(this.#previewPagePath);
      window.webContents.postMessage(PREVIEW_PORT_CHANNEL, { kind: "port" }, [port2]);
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new AvatarPreviewError("avatar preview timed out")),
          this.#timeoutMilliseconds,
        );
      });
      return await Promise.race([protocol, deadline]);
    } catch (error) {
      if (error instanceof AvatarPreviewError) throw error;
      throw new AvatarPreviewError("avatar preview rendering failed", { cause: error });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      try {
        window.webContents.session.webRequest.onBeforeRequest(requestFilter, null);
      } catch {
        // The isolated session is being destroyed with the preview window.
      }
      closePort(port1);
      closePort(port2);
      if (!window.isDestroyed()) window.destroy();
    }
  }

  #runProtocol(
    window: AvatarPreviewWindowPort,
    port: AvatarPreviewMessagePort,
    mapping: AvatarBoneMapping,
    modelBytes: Buffer,
    outputPath: string,
  ): Promise<AvatarPreviewResult> {
    return new Promise<AvatarPreviewResult>((resolveProtocol, rejectProtocol) => {
      let started = false;
      let capturing = false;
      port.on("message", ({ data }) => {
        if (!isPlainObject(data)) return;
        if (data.kind === "ready" && !started) {
          started = true;
          const bytes = modelBytes.buffer.slice(
            modelBytes.byteOffset,
            modelBytes.byteOffset + modelBytes.byteLength,
          );
          port.postMessage({ kind: "render", bytes, mapping });
          return;
        }
        if (data.kind === "error") {
          rejectProtocol(new AvatarPreviewError("avatar preview page rejected the model"));
          return;
        }
        if (data.kind !== "rendered" || data.width !== 512 || data.height !== 512 || capturing) {
          return;
        }
        capturing = true;
        void capturePreview(window, outputPath)
          .then(async () => {
            port.postMessage({ kind: "captured" });
            resolveProtocol({ width: 512, height: 512, format: "png" });
          })
          .catch((error: unknown) => {
            rejectProtocol(
              error instanceof AvatarPreviewError
                ? error
                : new AvatarPreviewError("avatar preview capture failed", { cause: error }),
            );
          });
      });
      port.start();
    });
  }
}

export function createAvatarPreviewWindowOptions(
  preloadPath: string,
  partition: string,
): BrowserWindowConstructorOptions {
  return {
    width: 512,
    height: 512,
    minWidth: 512,
    minHeight: 512,
    maxWidth: 512,
    maxHeight: 512,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: preloadPath,
      partition,
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  };
}

async function capturePreview(window: AvatarPreviewWindowPort, outputPath: string): Promise<void> {
  const image = await window.webContents.capturePage();
  const size = image.getSize();
  const png = image.toPNG();
  if (
    size.width !== 512 ||
    size.height !== 512 ||
    png.byteLength <= PNG_SIGNATURE.byteLength ||
    !png.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) {
    throw new AvatarPreviewError("avatar preview capture is invalid");
  }
  await writeFile(outputPath, png, { flag: "wx" });
}

function isAllowedPreviewRequest(url: string, assetRoot: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return false;
    const candidate = resolve(fileURLToPath(parsed));
    const child = relative(assetRoot, candidate);
    return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  } catch {
    return false;
  }
}

function closePort(port: AvatarPreviewMessagePort): void {
  try {
    port.close();
  } catch {
    // A transferred port may already have been closed by Electron.
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
