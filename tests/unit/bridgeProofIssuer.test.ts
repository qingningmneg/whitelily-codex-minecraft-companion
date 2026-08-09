import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createBridgeProofIssuer } from "../../src/minecraft/bridgeProofIssuer.js";

interface BridgeRequestDocument {
  schemaVersion: 1;
  username: "WhiteLily";
  port: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

const temporaryRoots: string[] = [];

async function createDataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "whitelily-bridge-proof-"));
  temporaryRoots.push(root);
  return root;
}

function nonceFor(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

function requestPath(dataRoot: string, nonce: string): string {
  return join(
    dataRoot,
    "bridge",
    "requests",
    `${createHash("sha256").update(nonce).digest("hex")}.json`,
  );
}

async function readOnlyRequestDocuments(dataRoot: string): Promise<BridgeRequestDocument[]> {
  const directory = join(dataRoot, "bridge", "requests");
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
      .map(
        async (entry) =>
          JSON.parse(await readFile(join(directory, entry.name), "utf8")) as BridgeRequestDocument,
      ),
  );
}

function serializedError(error: unknown): string {
  const value = error instanceof Error ? { message: error.message, name: error.name } : error;
  return JSON.stringify(value);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("BridgeProofIssuer", () => {
  it("issues one bounded atomic proof without exposing it in the object shape", async () => {
    const dataRoot = await createDataRoot();
    const issuer = createBridgeProofIssuer({
      dataRoot,
      now: () => 1_000,
      randomBytes: () => Buffer.alloc(32, 7),
    });

    const proof = await issuer.issue(49_152);

    expect(proof.fakeHost).toBe(`127.0.0.1\0WL1\0${nonceFor(7)}`);
    expect(Object.keys(proof).sort()).toEqual(["close", "fakeHost"]);
    expect(await readOnlyRequestDocuments(dataRoot)).toEqual([
      {
        schemaVersion: 1,
        username: "WhiteLily",
        port: 49_152,
        issuedAt: 1_000,
        expiresAt: 31_000,
        nonce: nonceFor(7),
      },
    ]);
    expect((await lstat(requestPath(dataRoot, nonceFor(7)))).size).toBeLessThanOrEqual(4_096);
  });

  it.each([0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid port %s before writing a request",
    async (port) => {
      const dataRoot = await createDataRoot();
      const issuer = createBridgeProofIssuer({ dataRoot, randomBytes: () => Buffer.alloc(32, 1) });

      await expect(issuer.issue(port)).rejects.toThrow("bridge proof port is invalid");
      await expect(readOnlyRequestDocuments(dataRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects relative and lexically escaped data roots", async () => {
    const root = await createDataRoot();
    const escapedRoot = `${root}${sep}..${sep}outside`;

    expect(isAbsolute(root)).toBe(true);
    expect(() => createBridgeProofIssuer({ dataRoot: "relative-root" })).toThrow(
      "bridge proof root is invalid",
    );
    expect(() => createBridgeProofIssuer({ dataRoot: escapedRoot })).toThrow(
      "bridge proof root is invalid",
    );
  });

  it("rejects request-directory symlinks or junctions without writing through them", async () => {
    const dataRoot = await createDataRoot();
    const outside = await createDataRoot();
    const bridgeDirectory = join(dataRoot, "bridge");
    await mkdir(bridgeDirectory);
    await symlink(
      outside,
      join(bridgeDirectory, "requests"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const issuer = createBridgeProofIssuer({ dataRoot, randomBytes: () => Buffer.alloc(32, 2) });

    await expect(issuer.issue(25_565)).rejects.toThrow("bridge proof rejected");
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("rejects an existing linked or replacement request target without overwriting it", async () => {
    const dataRoot = await createDataRoot();
    const outside = await createDataRoot();
    const nonce = nonceFor(3);
    const target = requestPath(dataRoot, nonce);
    let protectedContents = "do-not-replace";
    await mkdir(join(dataRoot, "bridge", "requests"), { recursive: true });
    await writeFile(join(outside, "replacement.json"), protectedContents, "utf8");
    try {
      await symlink(join(outside, "replacement.json"), target, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      protectedContents = "replacement-target";
      await writeFile(target, protectedContents, "utf8");
    }
    const issuer = createBridgeProofIssuer({ dataRoot, randomBytes: () => Buffer.alloc(32, 3) });

    await expect(issuer.issue(25_565)).rejects.toThrow("bridge proof rejected");
    await expect(readFile(target, "utf8")).resolves.toBe(protectedContents);
  });

  it("bounds duplicate-nonce collision retries and preserves the existing request", async () => {
    const dataRoot = await createDataRoot();
    const nonce = nonceFor(4);
    const target = requestPath(dataRoot, nonce);
    await mkdir(join(dataRoot, "bridge", "requests"), { recursive: true });
    await writeFile(target, "existing", "utf8");
    const issuer = createBridgeProofIssuer({ dataRoot, randomBytes: () => Buffer.alloc(32, 4) });

    await expect(issuer.issue(25_565)).rejects.toThrow("bridge proof rejected");
    await expect(readFile(target, "utf8")).resolves.toBe("existing");
  });

  it("closes an individual proof idempotently and only removes its exact request", async () => {
    const dataRoot = await createDataRoot();
    const nonce = nonceFor(5);
    const issuer = createBridgeProofIssuer({ dataRoot, randomBytes: () => Buffer.alloc(32, 5) });
    const proof = await issuer.issue(25_565);

    await proof.close();
    await proof.close();

    await expect(readOnlyRequestDocuments(dataRoot)).resolves.toEqual([]);
    expect(proof.fakeHost).toBe(`127.0.0.1\0WL1\0${nonce}`);
  });

  it("closes all issuer-owned proofs and refuses later issues", async () => {
    const dataRoot = await createDataRoot();
    let byte = 6;
    const issuer = createBridgeProofIssuer({
      dataRoot,
      randomBytes: () => Buffer.alloc(32, byte++),
    });
    await issuer.issue(25_565);
    await issuer.issue(25_566);

    await issuer.close();
    await issuer.close();

    await expect(readOnlyRequestDocuments(dataRoot)).resolves.toEqual([]);
    await expect(issuer.issue(25_567)).rejects.toThrow("bridge proof issuer is closed");
  });

  it("cleans only its expired owned request before issuing a fresh proof", async () => {
    const dataRoot = await createDataRoot();
    let now = 1_000;
    let byte = 8;
    const issuer = createBridgeProofIssuer({
      dataRoot,
      now: () => now,
      randomBytes: () => Buffer.alloc(32, byte++),
    });
    await issuer.issue(25_565);
    now = 31_001;
    await issuer.issue(25_565);

    expect(await readOnlyRequestDocuments(dataRoot)).toEqual([
      {
        schemaVersion: 1,
        username: "WhiteLily",
        port: 25_565,
        issuedAt: 31_001,
        expiresAt: 61_001,
        nonce: nonceFor(9),
      },
    ]);
  });

  it("never serializes the nonce or absolute root in public errors", async () => {
    const dataRoot = join(await createDataRoot(), "sensitive-root");
    const nonce = nonceFor(10);
    const target = requestPath(dataRoot, nonce);
    await mkdir(join(dataRoot, "bridge", "requests"), { recursive: true });
    await writeFile(target, "existing", "utf8");
    const issuer = createBridgeProofIssuer({ dataRoot, randomBytes: () => Buffer.alloc(32, 10) });

    const error = await issuer.issue(25_565).catch((reason: unknown) => reason);
    const publicError = serializedError(error);

    expect(publicError).not.toContain(nonce);
    expect(publicError).not.toContain(dataRoot);
  });
});
