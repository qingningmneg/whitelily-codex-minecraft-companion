import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AvatarAppearanceListItem,
  AvatarAppearanceRecord,
  AvatarModelCatalogSnapshot,
} from "../../../../src/avatar/avatarModelTypes.js";
import { AvatarAppearanceSnapshotProjector } from "./avatarAppearanceSnapshotProjector.js";
import { AvatarApprovedSkinCatalog } from "./avatarApprovedSkinCatalog.js";
import { AvatarModelCatalog } from "./avatarModelCatalog.js";
import { AvatarModelImporter } from "./avatarModelImporter.js";
import { AvatarModelMailbox } from "./avatarModelMailbox.js";
import {
  resolveAvatarModelPaths,
  resolveBuiltinAvatarAppearancePaths,
} from "./avatarModelPaths.js";
import { AvatarModelPreferences } from "./avatarModelPreferences.js";
import { AvatarModelSwitchCoordinator } from "./avatarModelSwitchCoordinator.js";
import { AvatarSkinImportPicker, type AvatarSkinOpenDialogPort } from "./avatarSkinImportPicker.js";
import {
  createDeterministicSkinPreview,
  validateMinecraftSkin,
  validatePortrait,
} from "./pngImageValidator.js";

export interface AvatarRuntimeMinecraftEvent {
  readonly kind: "minecraft";
  readonly state: {
    readonly state: "disconnected" | "connecting" | "connected" | "reconnecting";
    readonly sessionId: string | null;
  };
}

export interface AvatarModelComposition {
  list(): Promise<AvatarModelCatalogSnapshot>;
  importFromPicker(): Promise<
    | { readonly status: "cancelled" }
    | { readonly status: "imported"; readonly model: AvatarAppearanceListItem }
  >;
  switchTo(modelId: string): Promise<AvatarModelCatalogSnapshot>;
  subscribe(listener: (snapshot: AvatarModelCatalogSnapshot) => void): () => void;
  dispose(): void;
}

export async function createAvatarModelComposition(options: {
  readonly dataRoot: string;
  readonly resourcesPath: string;
  readonly showOpenDialog: AvatarSkinOpenDialogPort["showOpenDialog"];
  readonly choosePortrait: () => Promise<"pick" | "skip" | "cancel">;
  readonly subscribeRuntime: (
    listener: (event: AvatarRuntimeMinecraftEvent | { readonly kind: string }) => void,
  ) => () => void;
  readonly diagnostic?: (code: string, modelId?: string) => void;
}): Promise<AvatarModelComposition> {
  const dataRoot = resolve(options.dataRoot);
  const diagnostic = options.diagnostic ?? (() => undefined);
  const builtin = await provisionBuiltinAppearance(dataRoot, options.resourcesPath, diagnostic);
  const catalog = await new AvatarModelCatalog({
    dataRoot,
    builtinModels: builtin,
    diagnostic: ({ code, modelId }) => diagnostic(code, modelId),
  }).initialize();
  const approved = new AvatarApprovedSkinCatalog({ dataRoot });
  const preferences = new AvatarModelPreferences({ dataRoot });
  const projector = new AvatarAppearanceSnapshotProjector({
    dataRoot,
    diagnostic: ({ code, modelId }) => diagnostic(code, modelId),
  });
  let worldSessionId: string | undefined;
  const mailbox = new AvatarModelMailbox({
    dataRoot,
    currentWorldSessionId: () => worldSessionId,
    diagnostic: (code) => diagnostic(code),
  });
  const listeners = new Set<(snapshot: AvatarModelCatalogSnapshot) => void>();

  const projectSnapshot = async (
    activeModelId: string,
    pendingModelId?: string,
  ): Promise<AvatarModelCatalogSnapshot> => {
    const state = await catalog.list();
    await approved.publish(state.models);
    return projector.project(state, activeModelId, pendingModelId);
  };
  const publishSnapshot = (snapshot: AvatarModelCatalogSnapshot): void => {
    for (const listener of listeners) listener(snapshot);
  };
  const coordinator = new AvatarModelSwitchCoordinator({
    catalog,
    preferences,
    mailbox,
    currentWorldSessionId: () => worldSessionId,
    projectSnapshot,
    publishSnapshot,
    createRequestId: randomUUID,
    now: () => new Date(),
  });
  const importer = new AvatarModelImporter({ dataRoot, catalog });
  const picker = new AvatarSkinImportPicker({
    showOpenDialog: options.showOpenDialog,
    choosePortrait: options.choosePortrait,
    importer,
  });

  const initialState = await catalog.list();
  await approved.publish(initialState.models);

  let disposed = false;
  const unsubscribeRuntime = options.subscribeRuntime((event) => {
    if (disposed || event.kind !== "minecraft" || !("state" in event)) return;
    const minecraft = (event as AvatarRuntimeMinecraftEvent).state;
    const next =
      minecraft.state === "connected" && minecraft.sessionId !== null
        ? minecraft.sessionId
        : undefined;
    const previous = worldSessionId;
    worldSessionId = next;
    if (previous !== undefined && next !== previous) {
      void coordinator.cancelPending(next === undefined ? "bridge_disconnected" : "world_changed");
    }
    if (next !== undefined && next !== previous) {
      void coordinator
        .reconcilePersistedSelection()
        .catch(() => diagnostic("AVATAR_SWITCH_FAILED"));
    }
  });

  const composition: AvatarModelComposition = {
    list: async () => {
      const activeModelId = await preferences.readActiveModelId(catalog);
      return projectSnapshot(activeModelId);
    },
    importFromPicker: async () => {
      const result = await picker.importFromPicker();
      if (result.status === "cancelled" || result.model === undefined)
        return { status: "cancelled" };
      const snapshot = await composition.list();
      publishSnapshot(snapshot);
      const projected = snapshot.models.find(({ id }) => id === result.model!.id);
      if (projected === undefined) throw new Error("imported appearance projection is unavailable");
      return { status: "imported", model: projected };
    },
    switchTo: async (modelId) => {
      const state = await catalog.list();
      await approved.publish(state.models);
      return coordinator.switchTo(modelId);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeRuntime();
      listeners.clear();
      void coordinator.cancelPending("desktop_closing");
    },
  };
  return composition;
}

async function provisionBuiltinAppearance(
  dataRoot: string,
  resourcesPath: string,
  diagnostic: (code: string, modelId?: string) => void,
): Promise<AvatarAppearanceRecord> {
  const source = resolveBuiltinAvatarAppearancePaths(resourcesPath);
  const paths = resolveAvatarModelPaths(dataRoot);
  const destination = join(paths.root, "builtin", "whitelily");
  const staging = join(paths.stagingRoot, `builtin-${randomUUID()}`);
  const skin = await readFile(source.skinPath);
  const preview = createDeterministicSkinPreview(validateMinecraftSkin(skin));
  const portrait = await readFile(source.portraitPath)
    .then((bytes) => {
      validatePortrait(bytes);
      return bytes;
    })
    .catch(() => {
      diagnostic("AVATAR_PORTRAIT_UNAVAILABLE", "builtin:whitelily");
      return preview;
    });
  await mkdir(paths.stagingRoot, { recursive: true });
  const backup = `${destination}.previous-${randomUUID()}`;
  let movedPrevious = false;
  try {
    await mkdir(join(staging, "skin"), { recursive: true });
    await Promise.all([
      writeFile(join(staging, "skin", "base.png"), skin, { flag: "wx" }),
      writeFile(join(staging, "portrait.png"), portrait, { flag: "wx" }),
      writeFile(join(staging, "preview.png"), preview, { flag: "wx" }),
    ]);
    await mkdir(join(paths.root, "builtin"), { recursive: true });
    try {
      await rename(destination, backup);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (movedPrevious) {
        await rename(backup, destination);
        movedPrevious = false;
      }
      throw error;
    }
    if (movedPrevious) {
      await rm(backup, { recursive: true, force: true });
      movedPrevious = false;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const timestamp = "2026-08-21T00:00:00.000Z";
  return Object.freeze({
    id: "builtin:whitelily",
    displayName: "WhiteLily",
    origin: "builtin",
    worldRenderer: "minecraft-skin",
    skinAsset: "builtin/whitelily/skin/base.png",
    skinSha256: sha256(skin),
    armModel: "slim",
    portraitAsset: "builtin/whitelily/portrait.png",
    portraitSha256: sha256(portrait),
    importedAt: timestamp,
    validation: { code: "AVATAR_VALID" as const, validatedAt: timestamp },
  });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
