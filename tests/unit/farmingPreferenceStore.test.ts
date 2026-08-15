import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FarmingPreferenceStore } from "../../src/profile/farmingPreferenceStore.js";
import { nodeAtomicJsonFileIo, type AtomicJsonFileIo } from "../../src/storage/atomicJsonFile.js";

const cleanups: Array<() => Promise<void>> = [];

async function fixture() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-farming-preference-"));
  cleanups.push(() => rm(rootDirectory, { recursive: true, force: true }));
  return {
    rootDirectory,
    store: new FarmingPreferenceStore({
      rootDirectory,
      clock: () => new Date("2026-08-15T08:00:00.000Z"),
    }),
  };
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("FarmingPreferenceStore", () => {
  it("returns an unknown default without creating a file", async () => {
    const { rootDirectory, store } = await fixture();

    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-08-15T08:00:00.000Z",
      value: { status: "unknown", updatedAt: "2026-08-15T08:00:00.000Z" },
    });
    await expect(
      readFile(join(rootDirectory, "farming-preference.json"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps one approval across locations, worlds, and store instances", async () => {
    const { rootDirectory, store } = await fixture();

    const allowed = await store.setAllowed(0);
    const restarted = new FarmingPreferenceStore({ rootDirectory });

    expect(allowed).toMatchObject({ revision: 1, value: { status: "allowed" } });
    await expect(restarted.read()).resolves.toMatchObject({
      revision: 1,
      value: { status: "allowed", updatedAt: "2026-08-15T08:00:00.000Z" },
    });
    const persisted = await readFile(join(rootDirectory, "farming-preference.json"), "utf8");
    expect(persisted).not.toMatch(/world|dimension|position|coordinate|"x"|"y"|"z"/iu);
  });

  it("persists denial and supports a later explicit approval", async () => {
    const { rootDirectory, store } = await fixture();
    const denied = await store.setDenied(0);
    const allowed = await store.setAllowed(denied.revision);

    expect(denied.value.status).toBe("denied");
    expect(allowed.value.status).toBe("allowed");
    await expect(new FarmingPreferenceStore({ rootDirectory }).read()).resolves.toMatchObject({
      revision: 2,
      value: { status: "allowed" },
    });
  });

  it("does not commit an approval after its authority is lost before the final write", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-farming-commit-"));
    cleanups.push(() => rm(rootDirectory, { recursive: true, force: true }));
    let authorityCurrent = true;
    let writeEntered!: () => void;
    const writeEnteredPromise = new Promise<void>((resolve) => {
      writeEntered = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let gateFirstTemporaryWrite = true;
    const fileIo: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      open: async (path, flags) => {
        if (gateFirstTemporaryWrite && path.endsWith(".tmp")) {
          gateFirstTemporaryWrite = false;
          writeEntered();
          await writeGate;
        }
        return nodeAtomicJsonFileIo.open(path, flags);
      },
    };
    const store = new FarmingPreferenceStore({
      rootDirectory,
      clock: () => new Date("2026-08-15T08:00:00.000Z"),
      fileIo,
    });

    const approval = store.setAllowed(0, () => authorityCurrent);
    await writeEnteredPromise;
    authorityCurrent = false;
    releaseWrite();

    await expect(approval).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });
    await expect(store.read()).resolves.toMatchObject({
      revision: 0,
      value: { status: "unknown" },
    });
  });

  it("rejects a stale concurrent revision without overwriting the winner", async () => {
    const { rootDirectory, store } = await fixture();
    const concurrent = new FarmingPreferenceStore({ rootDirectory });

    await store.setAllowed(0);
    await expect(concurrent.setDenied(0)).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });
    await expect(store.read()).resolves.toMatchObject({
      revision: 1,
      value: { status: "allowed" },
    });
  });

  it("fails closed for damaged files and unknown persisted fields", async () => {
    const { rootDirectory, store } = await fixture();
    const path = join(rootDirectory, "farming-preference.json");
    await writeFile(path, "{not-json", "utf8");

    await expect(store.read()).rejects.toBeDefined();

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        updatedAt: "2026-08-15T08:00:00.000Z",
        value: {
          status: "allowed",
          updatedAt: "2026-08-15T08:00:00.000Z",
          worldId: "secret-world",
        },
      }),
      "utf8",
    );
    await expect(store.read()).rejects.toMatchObject({ code: "DOCUMENT_INVALID" });
  });

  it("never restores an older approval after a denial when the primary is damaged", async () => {
    const { rootDirectory, store } = await fixture();
    const path = join(rootDirectory, "farming-preference.json");
    const allowed = await store.setAllowed(0);
    await store.setDenied(allowed.revision);
    await writeFile(path, "{not-json", "utf8");

    await expect(new FarmingPreferenceStore({ rootDirectory }).read()).rejects.toMatchObject({
      code: "ATOMIC_JSON_INVALID",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("{not-json");
  });

  it("never restores an older approval after a denial when only the backup remains", async () => {
    const { rootDirectory, store } = await fixture();
    const path = join(rootDirectory, "farming-preference.json");
    const allowed = await store.setAllowed(0);
    await store.setDenied(allowed.revision);
    await rm(path);

    await expect(new FarmingPreferenceStore({ rootDirectory }).read()).rejects.toMatchObject({
      code: "ATOMIC_JSON_RECOVERY_FAILED",
    });
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports the document timestamp error for an invalid injected clock", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-farming-clock-"));
    cleanups.push(() => rm(rootDirectory, { recursive: true, force: true }));
    const store = new FarmingPreferenceStore({
      rootDirectory,
      clock: () => new Date(Number.NaN),
    });

    await expect(store.read()).rejects.toMatchObject({ code: "DOCUMENT_INVALID_TIMESTAMP" });
  });
});
