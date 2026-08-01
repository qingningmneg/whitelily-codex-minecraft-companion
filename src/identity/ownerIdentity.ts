export type OwnerPresence = "unknown" | "online" | "offline";

export interface OwnerIdentitySnapshot {
  readonly revision: number;
  readonly ownerUsername: string | null;
  readonly configured: boolean;
  readonly presence: OwnerPresence;
}

export type OwnerIdentityErrorCode =
  | "OWNER_IDENTITY_INVALID"
  | "OWNER_IDENTITY_REQUIRED"
  | "OWNER_IDENTITY_CONFIG_CONFLICT"
  | "OWNER_IDENTITY_WRITE_FAILED"
  | "OWNER_IDENTITY_CONFIG_INVALID";

export class OwnerIdentityError extends Error {
  constructor(readonly code: OwnerIdentityErrorCode) {
    super(code);
    this.name = "OwnerIdentityError";
  }
}

export interface OwnerIdentityAccess {
  snapshot(): OwnerIdentitySnapshot;
  update(input: {
    readonly expectedRevision: number;
    readonly ownerUsername: string;
  }): Promise<OwnerIdentitySnapshot>;
  setPresence(input: {
    readonly revision: number;
    readonly ownerUsername: string;
    readonly presence: Exclude<OwnerPresence, "unknown">;
  }): void;
  subscribe(listener: (snapshot: OwnerIdentitySnapshot) => void): () => void;
}

export const MINECRAFT_JAVA_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/u;

const TEMPLATE_OWNER = "YourMcName";

export function parseMinecraftJavaUsername(value: unknown, botUsername = "WhiteLily"): string {
  if (typeof value !== "string") throw new OwnerIdentityError("OWNER_IDENTITY_INVALID");
  const candidate = value.trim();
  const normalizedCandidate = candidate.toLowerCase();
  if (
    !MINECRAFT_JAVA_USERNAME_PATTERN.test(candidate) ||
    normalizedCandidate === TEMPLATE_OWNER.toLowerCase() ||
    normalizedCandidate === botUsername.toLowerCase()
  ) {
    throw new OwnerIdentityError("OWNER_IDENTITY_INVALID");
  }
  return candidate;
}

export function publicSnapshot(
  revision: number,
  ownerUsername: string | null,
  presence: OwnerPresence,
): OwnerIdentitySnapshot {
  return Object.freeze({
    revision,
    ownerUsername,
    configured: ownerUsername !== null,
    presence,
  });
}
