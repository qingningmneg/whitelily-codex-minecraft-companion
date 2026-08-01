import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorldProfileStore,
  fingerprintConfirmedWorld,
  type ConfirmedWorldBinding,
} from "../../src/world/worldProfileStore.js";

const proof = { nonce: "proof_nonce_123456", port: 51321, issuedAt: 1_000, expiresAt: 9_000 };

function binding(overrides: Partial<ConfirmedWorldBinding> = {}): ConfirmedWorldBinding {
  return {
    canonicalInstancePath: "C:/PCL2/instances/Survival",
    javaSession: { pid: 4120, processStartedAt: 900, port: 51321, version: "1.21.5" },
    ownerUsername: "ExactOwner",
    proof,
    ...overrides,
  };
}

async function store(): Promise<WorldProfileStore> {
  return new WorldProfileStore({
    rootDirectory: await mkdtemp(join(tmpdir(), "whitelily-world-profile-")),
    now: () => 2_000,
    createId: () => "00000000-0000-4000-8000-000000000001",
    isCurrentLanProof: () => true,
  });
}

describe("WorldProfileStore", () => {
  it("keeps the bound owner as history while authorizing only the canonical instance", async () => {
    const profiles = await store();
    const bound = await profiles.bindConfirmedWorld(0, binding());

    expect(bound.value.ownerUsername).toBe("ExactOwner");
    await expect(profiles.authorize(bound.value.instanceFingerprint)).resolves.toBe(true);
  });

  it("rejects expired or renderer-invented LAN proof before a profile is persisted", async () => {
    const profiles = await store();

    await expect(
      profiles.bindConfirmedWorld(0, binding({ proof: { ...proof, expiresAt: 2_000 } })),
    ).rejects.toThrow("current confirmed LAN proof");
    await expect(profiles.read()).resolves.toMatchObject({ revision: 0, value: null });
  });

  it("derives a stable hash without persisting the raw canonical instance path", async () => {
    const profiles = await store();
    const input = binding();
    const expected = createHash("sha256")
      .update("C:/PCL2/instances/Survival\u00004120\u0000900\u000051321\u00001.21.5", "utf8")
      .digest("base64url");

    expect(fingerprintConfirmedWorld(input.canonicalInstancePath, input.javaSession)).toBe(
      expected,
    );
    const bound = await profiles.bindConfirmedWorld(0, input);
    expect(JSON.stringify(bound)).not.toContain("C:/PCL2/instances/Survival");
    expect(bound.value.instanceFingerprint).toBe(expected);
  });

  it("does not authorize a copied or moved instance with a different canonical path", async () => {
    const profiles = await store();
    const bound = await profiles.bindConfirmedWorld(0, binding());
    const moved = fingerprintConfirmedWorld("D:/Backups/Survival-copy", binding().javaSession);

    expect(moved).not.toBe(bound.value.instanceFingerprint);
    await expect(profiles.authorize(moved)).resolves.toBe(false);
  });
});
