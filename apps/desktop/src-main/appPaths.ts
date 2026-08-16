import { win32 } from "node:path";

export const WHITE_LILY_PRODUCT_DIRECTORY = "WhiteLily";
export const WHITE_LILY_PROGRAMS_DIRECTORY = "Programs";

export interface AppPaths {
  dataRoot: string;
  configPath: string;
  logRoot: string;
  avatarModelRoot: string;
  avatarModelStagingRoot: string;
  avatarModelBridgeRoot: string;
}

function normalizeLocalAppData(localAppData: string): string {
  if (localAppData.length === 0 || localAppData.includes("%") || !win32.isAbsolute(localAppData)) {
    throw new Error("WhiteLily requires an absolute LOCALAPPDATA path");
  }

  return win32.normalize(localAppData);
}

export function resolveInstallerProgramPath(localAppData: string): string {
  return win32.join(
    normalizeLocalAppData(localAppData),
    WHITE_LILY_PROGRAMS_DIRECTORY,
    WHITE_LILY_PRODUCT_DIRECTORY,
  );
}

export function resolveInstallerDataDeletionTarget(
  localAppData: string,
  candidate: string,
): string {
  const validatedLocalAppData = normalizeLocalAppData(localAppData);
  const expected = win32.join(validatedLocalAppData, WHITE_LILY_PRODUCT_DIRECTORY);
  const invalid =
    candidate.length === 0 ||
    candidate.includes("%") ||
    candidate.includes("*") ||
    candidate.includes("?") ||
    candidate.split(/[\\/]+/u).includes("..") ||
    candidate.startsWith(String.raw`\\`) ||
    !win32.isAbsolute(candidate);
  const canonicalCandidate = invalid ? "" : win32.normalize(candidate);

  if (invalid || canonicalCandidate.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("Deletion target must be the exact WhiteLily data root");
  }
  return expected;
}

export function resolveAppPaths(localAppData: string): AppPaths {
  const validatedLocalAppData = normalizeLocalAppData(localAppData);
  const dataRoot = resolveInstallerDataDeletionTarget(
    validatedLocalAppData,
    win32.join(validatedLocalAppData, WHITE_LILY_PRODUCT_DIRECTORY),
  );
  return {
    dataRoot,
    configPath: win32.join(dataRoot, "config.toml"),
    logRoot: win32.join(dataRoot, "logs"),
    avatarModelRoot: win32.join(dataRoot, "models"),
    avatarModelStagingRoot: win32.join(dataRoot, "models", ".staging"),
    avatarModelBridgeRoot: win32.join(dataRoot, "bridge", "avatar-model"),
  };
}
