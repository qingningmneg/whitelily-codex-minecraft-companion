import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBridgeProofIssuer,
  createBridgeProofIssuerForTesting,
} from "../../src/minecraft/bridgeProofIssuer.js";

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

  it("does not replace a target created after validation and removes only its own temporary file", async () => {
    const dataRoot = await createDataRoot();
    const nonce = nonceFor(11);
    const target = requestPath(dataRoot, nonce);
    const unrelated = join(dataRoot, "bridge", "requests", "unrelated.txt");
    let attackerIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
    const issuer = createBridgeProofIssuerForTesting(
      {
        dataRoot,
        randomBytes: () => Buffer.alloc(32, 11),
      },
      {
        beforePublish: async () => {
          await writeFile(target, "attacker-target", "utf8");
          attackerIdentity = await lstat(target);
        },
      },
    );
    await mkdir(join(dataRoot, "bridge", "requests"), { recursive: true });
    await writeFile(unrelated, "unrelated", "utf8");

    await expect(issuer.issue(25_565)).rejects.toThrow("bridge proof rejected");

    const targetAfter = await lstat(target);
    expect(await readFile(target, "utf8")).toBe("attacker-target");
    expect(targetAfter.dev).toBe(attackerIdentity?.dev);
    expect(targetAfter.ino).toBe(attackerIdentity?.ino);
    expect(await readFile(unrelated, "utf8")).toBe("unrelated");
    expect((await readdir(join(dataRoot, "bridge", "requests"))).sort()).toEqual(
      ["unrelated.txt", target.split(sep).at(-1)!].sort(),
    );
  });

  it("removes a final-name hard-link alias of its own temporary proof after rejecting publication", async () => {
    const dataRoot = await createDataRoot();
    const nonce = nonceFor(15);
    const target = requestPath(dataRoot, nonce);
    const temporary = join(dataRoot, "bridge", "requests", `.${target.split(sep).at(-1)!}.tmp`);
    const unrelated = join(dataRoot, "bridge", "requests", "unrelated.txt");
    const issuer = createBridgeProofIssuerForTesting(
      {
        dataRoot,
        randomBytes: () => Buffer.alloc(32, 15),
      },
      {
        beforePublish: async () => {
          await link(temporary, target);
        },
      },
    );
    await mkdir(join(dataRoot, "bridge", "requests"), { recursive: true });
    await writeFile(unrelated, "unrelated", "utf8");

    await expect(issuer.issue(25_565)).rejects.toThrow("bridge proof rejected");

    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unrelated, "utf8")).resolves.toBe("unrelated");
  });

  it("rejects pre-open request-directory junction drift without creating an outside temporary or final target", async () => {
    const dataRoot = await createDataRoot();
    const outside = await createDataRoot();
    const nonce = nonceFor(18);
    const target = requestPath(dataRoot, nonce);
    const requests = join(dataRoot, "bridge", "requests");
    const parkedRequests = join(dataRoot, "bridge", "requests-parked");
    const temporaryName = `.${target.split(sep).at(-1)!}.tmp`;
    const outsideTemporary = join(outside, temporaryName);
    const outsideTarget = join(outside, target.split(sep).at(-1)!);
    const outsideUnrelated = join(outside, "unrelated.txt");
    await mkdir(requests, { recursive: true });
    const issuer = createBridgeProofIssuerForTesting(
      {
        dataRoot,
        randomBytes: () => Buffer.alloc(32, 18),
      },
      {
        beforeTempOpen: async () => {
          await rename(requests, parkedRequests);
          await symlink(outside, requests, process.platform === "win32" ? "junction" : "dir");
          await writeFile(outsideUnrelated, "outside-unrelated", "utf8");
        },
      },
    );

    await expect(issuer.issue(25_565)).rejects.toThrow("bridge proof rejected");

    await expect(lstat(outsideTemporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(outsideTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(outsideUnrelated, "utf8")).resolves.toBe("outside-unrelated");
  });

  it("rejects pre-link request-directory junction drift without creating an outside final target", async () => {
    const dataRoot = await createDataRoot();
    const outside = await createDataRoot();
    const nonce = nonceFor(17);
    const target = requestPath(dataRoot, nonce);
    const requests = join(dataRoot, "bridge", "requests");
    const parkedRequests = join(dataRoot, "bridge", "requests-parked");
    const temporaryName = `.${target.split(sep).at(-1)!}.tmp`;
    const outsideTemporary = join(outside, temporaryName);
    const outsideTarget = join(outside, target.split(sep).at(-1)!);
    const outsideUnrelated = join(outside, "unrelated.txt");
    const issuer = createBridgeProofIssuerForTesting(
      {
        dataRoot,
        randomBytes: () => Buffer.alloc(32, 17),
      },
      {
        beforePublish: async () => {
          await rename(requests, parkedRequests);
          await symlink(outside, requests, process.platform === "win32" ? "junction" : "dir");
          await writeFile(outsideTemporary, "outside-temporary", "utf8");
          await writeFile(outsideUnrelated, "outside-unrelated", "utf8");
        },
      },
    );

    await expect(issuer.issue(25_565)).rejects.toThrow("bridge proof rejected");

    await expect(lstat(outsideTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(outsideTemporary, "utf8")).resolves.toBe("outside-temporary");
    await expect(readFile(outsideUnrelated, "utf8")).resolves.toBe("outside-unrelated");
    expect((await lstat(join(parkedRequests, temporaryName))).isFile()).toBe(true);
  });

  it("preserves an attacker replacement made after the issuer links its temporary proof", async () => {
    const dataRoot = await createDataRoot();
    const nonce = nonceFor(16);
    const target = requestPath(dataRoot, nonce);
    let attackerIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
    const issuer = createBridgeProofIssuerForTesting(
      {
        dataRoot,
        randomBytes: () => Buffer.alloc(32, 16),
      },
      {
        afterPublishLink: async () => {
          await rm(target);
          await writeFile(target, "attacker-replacement", "utf8");
          attackerIdentity = await lstat(target);
        },
      },
    );

    await expect(issuer.issue(25_565)).rejects.toThrow("bridge proof rejected");

    const targetAfter = await lstat(target);
    expect(await readFile(target, "utf8")).toBe("attacker-replacement");
    expect(targetAfter.dev).toBe(attackerIdentity?.dev);
    expect(targetAfter.ino).toBe(attackerIdentity?.ino);
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

  it("rejects a data root reached through an ancestor junction or directory symlink", async () => {
    const container = await createDataRoot();
    const outside = await createDataRoot();
    const linkedParent = join(container, "linked-parent");
    const dataRoot = join(linkedParent, "data-root");
    await symlink(outside, linkedParent, process.platform === "win32" ? "junction" : "dir");
    const issuer = createBridgeProofIssuer({ dataRoot, randomBytes: () => Buffer.alloc(32, 12) });

    await expect(issuer.issue(25_565)).rejects.toThrow("bridge proof rejected");
    await expect(readdir(outside)).resolves.toEqual([]);
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

  it("rejects a pre-existing ordinary request target without overwriting it", async () => {
    const dataRoot = await createDataRoot();
    const nonce = nonceFor(3);
    const target = requestPath(dataRoot, nonce);
    await mkdir(join(dataRoot, "bridge", "requests"), { recursive: true });
    await writeFile(target, "pre-existing-target", "utf8");
    const issuer = createBridgeProofIssuer({ dataRoot, randomBytes: () => Buffer.alloc(32, 3) });

    await expect(issuer.issue(25_565)).rejects.toThrow("bridge proof rejected");
    await expect(readFile(target, "utf8")).resolves.toBe("pre-existing-target");
  });

  it("rejects a privilege-free file hard-link collision without changing either link", async () => {
    const dataRoot = await createDataRoot();
    const outside = await createDataRoot();
    const nonce = nonceFor(13);
    const source = join(outside, "hard-link-source.json");
    const target = requestPath(dataRoot, nonce);
    await mkdir(join(dataRoot, "bridge", "requests"), { recursive: true });
    await writeFile(source, "hard-link-source", "utf8");
    await link(source, target);
    const sourceBefore = await lstat(source);
    const targetBefore = await lstat(target);
    const issuer = createBridgeProofIssuer({ dataRoot, randomBytes: () => Buffer.alloc(32, 13) });

    await expect(issuer.issue(25_565)).rejects.toThrow("bridge proof rejected");

    const sourceAfter = await lstat(source);
    const targetAfter = await lstat(target);
    expect(await readFile(source, "utf8")).toBe("hard-link-source");
    expect(sourceAfter.ino).toBe(sourceBefore.ino);
    expect(targetAfter.ino).toBe(targetBefore.ino);
    expect(sourceAfter.ino).toBe(targetAfter.ino);
  });

  it("rejects a real file symlink when the environment permits file-symlink creation", async (context) => {
    const dataRoot = await createDataRoot();
    const outside = await createDataRoot();
    const nonce = nonceFor(14);
    const source = join(outside, "symlink-source.json");
    const target = requestPath(dataRoot, nonce);
    await mkdir(join(dataRoot, "bridge", "requests"), { recursive: true });
    await writeFile(source, "symlink-source", "utf8");
    try {
      await symlink(source, target, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("file symlink creation is unavailable in this Windows environment");
        return;
      }
      throw error;
    }
    const issuer = createBridgeProofIssuer({ dataRoot, randomBytes: () => Buffer.alloc(32, 14) });

    await expect(issuer.issue(25_565)).rejects.toThrow("bridge proof rejected");
    await expect(readFile(source, "utf8")).resolves.toBe("symlink-source");
  });

  it("rejects a duplicate-nonce collision and preserves the existing request", async () => {
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
    expect(publicError).not.toContain(requestPath(dataRoot, nonce));
    expect(publicError).not.toContain("25565");
  });
});
