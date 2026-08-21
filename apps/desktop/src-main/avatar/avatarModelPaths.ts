import { isAbsolute, join, resolve } from "node:path";

export interface AvatarModelPaths {
  readonly root: string;
  readonly catalogPath: string;
  readonly preferencesPath: string;
  readonly stagingRoot: string;
  readonly bridgeRoot: string;
}

export interface BuiltinAvatarAppearancePaths {
  readonly root: string;
  readonly skinPath: string;
  readonly portraitPath: string;
}

export function resolveAvatarModelPaths(dataRoot: string): AvatarModelPaths {
  if (!isAbsolute(dataRoot)) throw new Error("invalid WhiteLily data root");
  const trustedRoot = resolve(dataRoot);
  const root = join(trustedRoot, "models");
  return Object.freeze({
    root,
    catalogPath: join(root, "catalog.json"),
    preferencesPath: join(trustedRoot, "avatar-model-preferences.json"),
    stagingRoot: join(root, ".staging"),
    bridgeRoot: join(trustedRoot, "bridge", "avatar-model"),
  });
}

export function resolveBuiltinAvatarAppearancePaths(
  resourcesPath: string,
): BuiltinAvatarAppearancePaths {
  if (!isAbsolute(resourcesPath)) throw new Error("invalid WhiteLily resources root");
  const root = join(resolve(resourcesPath), "avatar", "builtin", "whitelily");
  return Object.freeze({
    root,
    skinPath: join(root, "skin", "base.png"),
    portraitPath: join(root, "portrait.png"),
  });
}
