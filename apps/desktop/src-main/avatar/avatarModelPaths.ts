import { isAbsolute, join, resolve } from "node:path";

export interface AvatarModelPaths {
  readonly root: string;
  readonly catalogPath: string;
  readonly preferencesPath: string;
  readonly stagingRoot: string;
  readonly bridgeRoot: string;
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
