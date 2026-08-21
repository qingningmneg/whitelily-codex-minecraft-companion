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
const PLACEHOLDER_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+5wN2AAAAAElFTkSuQmCC";

export type AvatarAppearanceProjectionDiagnosticCode =
  "AVATAR_PORTRAIT_UNAVAILABLE" | "AVATAR_PREVIEW_UNAVAILABLE";

export interface AvatarAppearanceProjectionDiagnostic {
  readonly code: AvatarAppearanceProjectionDiagnosticCode;
  readonly modelId: string;
}

export class AvatarAppearanceSnapshotProjector {
  readonly #modelRoot: string;
  readonly #diagnostic: (diagnostic: AvatarAppearanceProjectionDiagnostic) => void;
  readonly #reported = new Set<string>();

  constructor(options: {
    readonly dataRoot: string;
    readonly diagnostic?: (diagnostic: AvatarAppearanceProjectionDiagnostic) => void;
  }) {
    if (!isAbsolute(options.dataRoot)) throw new Error("invalid appearance projector root");
    this.#modelRoot = resolveAvatarModelPaths(resolve(options.dataRoot)).root;
    this.#diagnostic = options.diagnostic ?? (() => undefined);
  }

  async project(
    catalog: AvatarModelCatalogState,
    activeModelId: string,
    pendingModelId?: string,
  ): Promise<AvatarModelCatalogSnapshot> {
    const models = await Promise.all(catalog.models.map((record) => this.#projectRecord(record)));
    return Object.freeze({
      revision: catalog.revision,
      models: Object.freeze(models),
      activeModelId,
      ...(pendingModelId === undefined ? {} : { pendingModelId }),
    });
  }

  async #projectRecord(record: AvatarAppearanceRecord): Promise<AvatarAppearanceListItem> {
    const verifiedSkin = await this.#readVerifiedSkin(record).catch(() => undefined);
    const preview = await this.#readPreview(record, verifiedSkin).catch(() => undefined);
    if (preview === undefined) this.#reportOnce("AVATAR_PREVIEW_UNAVAILABLE", record.id);

    let portrait: Buffer | undefined;
    if (record.portraitAsset !== undefined && record.portraitSha256 !== undefined) {
      try {
        const bytes = await readVerifiedAvatarResource({
          root: this.#modelRoot,
          relativePath: record.portraitAsset,
          maximumBytes: MAX_APPEARANCE_BYTES,
        });
        validatePortrait(bytes);
        if (sha256(bytes) !== record.portraitSha256) throw new Error("portrait digest changed");
        portrait = bytes;
      } catch {
        this.#reportOnce("AVATAR_PORTRAIT_UNAVAILABLE", record.id);
      }
    }
    return Object.freeze({
      id: record.id,
      displayName: record.displayName,
      origin: record.origin,
      worldRenderer: record.worldRenderer,
      armModel: record.armModel,
      previewDataUrl: pngDataUrl(preview) ?? PLACEHOLDER_PNG_DATA_URL,
      ...(portrait === undefined ? {} : { portraitDataUrl: pngDataUrl(portrait)! }),
    });
  }

  async #readVerifiedSkin(record: AvatarAppearanceRecord): Promise<Buffer> {
    const bytes = await readVerifiedAvatarResource({
      root: this.#modelRoot,
      relativePath: record.skinAsset,
      maximumBytes: MAX_APPEARANCE_BYTES,
    });
    const validated = validateMinecraftSkin(bytes);
    if (sha256(bytes) !== record.skinSha256) throw new Error("skin digest changed");
    return createDeterministicSkinPreview(validated);
  }

  async #readPreview(record: AvatarAppearanceRecord, generated?: Buffer): Promise<Buffer> {
    const directory = record.skinAsset.slice(0, record.skinAsset.lastIndexOf("/") + 1);
    try {
      const bytes = await readVerifiedAvatarResource({
        root: this.#modelRoot,
        relativePath: `${directory}preview.png`,
        maximumBytes: MAX_APPEARANCE_BYTES,
      });
      validatePortrait(bytes);
      return bytes;
    } catch {
      if (generated !== undefined) return generated;
      throw new Error("preview unavailable");
    }
  }

  #reportOnce(code: AvatarAppearanceProjectionDiagnosticCode, modelId: string): void {
    const key = `${code}:${modelId}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.#diagnostic({ code, modelId });
  }
}

function pngDataUrl(bytes: Buffer | undefined): string | undefined {
  return bytes === undefined ? undefined : `data:image/png;base64,${bytes.toString("base64")}`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
