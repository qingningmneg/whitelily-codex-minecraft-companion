import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type {
  AvatarAppearanceListItem,
  AvatarAppearanceRecord,
  AvatarModelCatalogSnapshot,
  AvatarModelCatalogState,
} from "../../../../src/avatar/avatarModelTypes.js";
import { resolveAvatarModelPaths } from "./avatarModelPaths.js";
import {
  createDeterministicSkinPreview,
  validateMinecraftSkin,
  validatePortrait,
} from "./pngImageValidator.js";
import { readVerifiedAvatarResource } from "./verifiedAvatarResourceReader.js";

const MAX_APPEARANCE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_IPC_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_EMBEDDED_DATA_URL_BYTES = 3_000_000;
const SKIN_PREVIEW_DECODED_BYTES = 128 * 256 * 4;
const MAX_CONCURRENT_RECORDS = 4;
const PLACEHOLDER_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+5wN2AAAAAElFTkSuQmCC";

export type AvatarAppearanceProjectionDiagnosticCode =
  "AVATAR_PORTRAIT_UNAVAILABLE" | "AVATAR_PREVIEW_UNAVAILABLE" | "AVATAR_PORTRAIT_BUDGET_EXCEEDED";

export interface AvatarAppearanceProjectionDiagnostic {
  readonly code: AvatarAppearanceProjectionDiagnosticCode;
  readonly modelId: string;
}

export class AvatarAppearanceSnapshotProjector {
  readonly #modelRoot: string;
  readonly #diagnostic: (diagnostic: AvatarAppearanceProjectionDiagnostic) => void;
  readonly #maximumSnapshotBytes: number;
  readonly #maximumDecodedBytes: number;
  readonly #maximumConcurrentRecords: number;
  readonly #readResource: typeof readVerifiedAvatarResource;
  readonly #reported = new Set<string>();

  constructor(options: {
    readonly dataRoot: string;
    readonly diagnostic?: (diagnostic: AvatarAppearanceProjectionDiagnostic) => void;
    readonly maximumSnapshotBytes?: number;
    readonly maximumDecodedBytes?: number;
    readonly maximumConcurrentRecords?: number;
    readonly resourceReader?: typeof readVerifiedAvatarResource;
  }) {
    if (!isAbsolute(options.dataRoot)) throw new Error("invalid appearance projector root");
    this.#modelRoot = resolveAvatarModelPaths(resolve(options.dataRoot)).root;
    this.#diagnostic = options.diagnostic ?? (() => undefined);
    this.#maximumSnapshotBytes = positiveBudget(
      options.maximumSnapshotBytes ?? MAX_SNAPSHOT_IPC_BYTES,
    );
    this.#maximumDecodedBytes = positiveBudget(
      options.maximumDecodedBytes ?? MAX_SNAPSHOT_DECODED_BYTES,
    );
    this.#maximumConcurrentRecords = positiveBudget(
      options.maximumConcurrentRecords ?? MAX_CONCURRENT_RECORDS,
    );
    this.#readResource = options.resourceReader ?? readVerifiedAvatarResource;
  }

  async project(
    catalog: AvatarModelCatalogState,
    activeModelId: string,
    pendingModelId?: string,
  ): Promise<AvatarModelCatalogSnapshot> {
    let snapshotBytes = 0;
    let decodedBytes = 0;
    const models: AvatarAppearanceListItem[] = [];
    for (let offset = 0; offset < catalog.models.length; offset += this.#maximumConcurrentRecords) {
      const batch = await Promise.all(
        catalog.models
          .slice(offset, offset + this.#maximumConcurrentRecords)
          .map((record) => this.#projectRecord(record)),
      );
      for (const { item, preview, portrait } of batch) {
        const previewDataUrl = pngDataUrl(preview) ?? PLACEHOLDER_PNG_DATA_URL;
        snapshotBytes += Buffer.byteLength(previewDataUrl, "utf8");
        decodedBytes += preview === undefined ? 4 : SKIN_PREVIEW_DECODED_BYTES;
        let portraitDataUrl: string | undefined;
        if (portrait !== undefined) {
          const candidate = pngDataUrl(portrait.bytes)!;
          const candidateBytes = Buffer.byteLength(candidate, "utf8");
          if (
            candidateBytes <= MAX_EMBEDDED_DATA_URL_BYTES &&
            snapshotBytes + candidateBytes <= this.#maximumSnapshotBytes &&
            decodedBytes + portrait.decodedBytes <= this.#maximumDecodedBytes
          ) {
            portraitDataUrl = candidate;
            snapshotBytes += candidateBytes;
            decodedBytes += portrait.decodedBytes;
          } else {
            this.#reportOnce("AVATAR_PORTRAIT_BUDGET_EXCEEDED", item.id);
          }
        }
        models.push(
          Object.freeze({
            ...item,
            previewDataUrl,
            ...(portraitDataUrl === undefined ? {} : { portraitDataUrl }),
          }),
        );
      }
    }
    return Object.freeze({
      revision: catalog.revision,
      models: Object.freeze(models),
      activeModelId,
      ...(pendingModelId === undefined ? {} : { pendingModelId }),
    });
  }

  async #projectRecord(record: AvatarAppearanceRecord): Promise<ProjectedAppearanceDraft> {
    const preview = await this.#readVerifiedSkin(record).catch(() => undefined);
    if (preview === undefined) this.#reportOnce("AVATAR_PREVIEW_UNAVAILABLE", record.id);

    let portrait: ProjectedPortrait | undefined;
    if (record.portraitAsset !== undefined && record.portraitSha256 !== undefined) {
      try {
        const bytes = await this.#readResource({
          root: this.#modelRoot,
          relativePath: record.portraitAsset,
          maximumBytes: MAX_APPEARANCE_BYTES,
        });
        const validated = validatePortrait(bytes);
        if (sha256(bytes) !== record.portraitSha256) throw new Error("portrait digest changed");
        portrait = { bytes, decodedBytes: validated.width * validated.height * 4 };
      } catch {
        this.#reportOnce("AVATAR_PORTRAIT_UNAVAILABLE", record.id);
      }
    }
    return {
      item: {
        id: record.id,
        displayName: record.displayName,
        origin: record.origin,
        worldRenderer: record.worldRenderer,
        armModel: record.armModel,
      },
      ...(preview === undefined ? {} : { preview }),
      ...(portrait === undefined ? {} : { portrait }),
    };
  }

  async #readVerifiedSkin(record: AvatarAppearanceRecord): Promise<Buffer> {
    const bytes = await this.#readResource({
      root: this.#modelRoot,
      relativePath: record.skinAsset,
      maximumBytes: MAX_APPEARANCE_BYTES,
    });
    const validated = validateMinecraftSkin(bytes);
    if (sha256(bytes) !== record.skinSha256) throw new Error("skin digest changed");
    return createDeterministicSkinPreview(validated);
  }

  #reportOnce(code: AvatarAppearanceProjectionDiagnosticCode, modelId: string): void {
    const key = `${code}:${modelId}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.#diagnostic({ code, modelId });
  }
}

interface ProjectedPortrait {
  readonly bytes: Buffer;
  readonly decodedBytes: number;
}

interface ProjectedAppearanceDraft {
  readonly item: Omit<AvatarAppearanceListItem, "previewDataUrl" | "portraitDataUrl">;
  readonly preview?: Buffer;
  readonly portrait?: ProjectedPortrait;
}

function positiveBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid appearance budget");
  return value;
}

function pngDataUrl(bytes: Buffer | undefined): string | undefined {
  return bytes === undefined ? undefined : `data:image/png;base64,${bytes.toString("base64")}`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
