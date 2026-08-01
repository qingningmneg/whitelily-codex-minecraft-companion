import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { nodeAtomicJsonFileIo, type AtomicJsonFileIo } from "../../src/storage/atomicJsonFile.js";
import {
  DocumentStore,
  DocumentStoreError,
  type DocumentStoreOptions,
  type DocumentEnvelope,
} from "../../src/storage/documentStore.js";

const cleanups: Array<() => Promise<void>> = [];
const valueSchema = z
  .object({
    label: z.string().min(1),
    nested: z.object({ count: z.number().int().nonnegative() }).strict(),
  })
  .strict();

async function fixture(clockValues: readonly string[] = ["2026-07-29T01:02:03.004Z"]) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-document-store-"));
  cleanups.push(() => rm(rootDirectory, { recursive: true, force: true }));
  const path = join(rootDirectory, "settings.json");
  let clockIndex = 0;
  const store = new DocumentStore({
    path,
    rootDirectory,
    schemaVersion: 1,
    valueSchema,
    defaultValue: () => ({ label: "default", nested: { count: 0 } }),
    clock: () => new Date(clockValues[Math.min(clockIndex++, clockValues.length - 1)]!),
  });
  return { rootDirectory, path, store };
}

function expectCode(code: DocumentStoreError["code"]) {
  return expect.objectContaining<Partial<DocumentStoreError>>({ code });
}

function swapDriveLetterCase(path: string): string {
  return /^[A-Za-z]:/u.test(path)
    ? `${path[0] === path[0]!.toLowerCase() ? path[0]!.toUpperCase() : path[0]!.toLowerCase()}${path.slice(1)}`
    : path;
}

function createStore(
  path: string,
  rootDirectory: string,
  options: {
    clock?: () => Date;
    fileIo?: AtomicJsonFileIo;
  } = {},
) {
  return new DocumentStore({
    path,
    rootDirectory,
    schemaVersion: 1,
    valueSchema,
    defaultValue: () => ({ label: "default", nested: { count: 0 } }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
  } as DocumentStoreOptions<z.infer<typeof valueSchema>> & { fileIo?: AtomicJsonFileIo });
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("DocumentStore", () => {
  it("returns a validated detached default for a missing file without persisting it", async () => {
    const { path, store } = await fixture();

    const first = await store.read();
    first.value.nested.count = 99;
    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-07-29T01:02:03.004Z",
      value: { label: "default", nested: { count: 0 } },
    });
    await expect(access(path)).rejects.toThrow();
  });

  it("creates the caller value at revision zero and refuses to overwrite it", async () => {
    const { store } = await fixture();

    await expect(store.create({ label: "created", nested: { count: 2 } })).resolves.toEqual({
      schemaVersion: 1,
      revision: 0,
      updatedAt: "2026-07-29T01:02:03.004Z",
      value: { label: "created", nested: { count: 2 } },
    });
    await expect(store.create()).rejects.toEqual(expectCode("DOCUMENT_ALREADY_EXISTS"));
  });

  it("reads a valid envelope and isolates every returned nested value", async () => {
    const { store } = await fixture();
    const created = await store.create({ label: "created", nested: { count: 2 } });
    created.value.nested.count = 98;
    const read = await store.read();
    read.value.nested.count = 99;

    await expect(store.read()).resolves.toMatchObject({
      revision: 0,
      value: { label: "created", nested: { count: 2 } },
    });
  });

  it("rejects unknown versions and malformed envelopes with stable domain codes", async () => {
    const { path, store } = await fixture();
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        revision: 0,
        updatedAt: "2026-07-29T01:02:03.004Z",
        value: { label: "newer", nested: { count: 1 } },
      }),
      "utf8",
    );
    await expect(store.read()).rejects.toEqual(expectCode("DOCUMENT_SCHEMA_UNSUPPORTED"));

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        revision: -1,
        updatedAt: "not-an-instant",
        value: { label: "", nested: { count: -1 } },
        extra: true,
      }),
      "utf8",
    );
    await expect(store.read()).rejects.toEqual(expectCode("DOCUMENT_INVALID"));
  });

  it("does not downgrade an unknown schema version through an older valid backup", async () => {
    const { path, store } = await fixture(["2026-07-29T01:02:03.004Z", "2026-07-29T02:03:04.005Z"]);
    await store.create({ label: "version-one", nested: { count: 1 } });
    await store.update(0, (current) => ({
      ...current,
      nested: { count: 2 },
    }));
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        revision: 2,
        updatedAt: "2026-07-29T03:04:05.006Z",
        value: { label: "newer-schema", nested: { count: 3 } },
      }),
      "utf8",
    );

    await expect(store.read()).rejects.toEqual(expectCode("DOCUMENT_SCHEMA_UNSUPPORTED"));
  });

  it("uses injected UTC timestamps and monotonically increments revisions", async () => {
    const { store } = await fixture([
      "2026-07-29T01:02:03.004Z",
      "2026-07-29T02:03:04.005Z",
      "2026-07-29T03:04:05.006Z",
    ]);
    await store.create({ label: "created", nested: { count: 0 } });

    await expect(
      store.update(0, (current) => ({
        ...current,
        nested: { count: current.nested.count + 1 },
      })),
    ).resolves.toEqual({
      schemaVersion: 1,
      revision: 1,
      updatedAt: "2026-07-29T02:03:04.005Z",
      value: { label: "created", nested: { count: 1 } },
    });
    await expect(store.replace(1, { label: "replacement", nested: { count: 7 } })).resolves.toEqual(
      {
        schemaVersion: 1,
        revision: 2,
        updatedAt: "2026-07-29T03:04:05.006Z",
        value: { label: "replacement", nested: { count: 7 } },
      },
    );
  });

  it("serializes concurrent updates by canonical path without bypassing revisions", async () => {
    const { path, rootDirectory, store } = await fixture([
      "2026-07-29T01:00:00.000Z",
      "2026-07-29T02:00:00.000Z",
      "2026-07-29T03:00:00.000Z",
    ]);
    await store.create({ label: "created", nested: { count: 0 } });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const first = store.update(0, async (current) => {
      firstEntered();
      await firstGate;
      return { ...current, nested: { count: 1 } };
    });
    await entered;
    const secondStore = new DocumentStore({
      path,
      rootDirectory,
      schemaVersion: 1,
      valueSchema,
      defaultValue: () => ({ label: "default", nested: { count: 0 } }),
      clock: () => new Date("2026-07-29T03:00:00.000Z"),
    });
    const second = secondStore.update(1, (current) => ({
      ...current,
      nested: { count: current.nested.count + 1 },
    }));
    releaseFirst();

    await expect(first).resolves.toMatchObject({ revision: 1, value: { nested: { count: 1 } } });
    await expect(second).resolves.toMatchObject({ revision: 2, value: { nested: { count: 2 } } });
  });

  it.runIf(process.platform === "win32")(
    "normalizes Windows drive and path case aliases to one document coordinator",
    async () => {
      const { path, rootDirectory, store } = await fixture([
        "2026-07-29T01:00:00.000Z",
        "2026-07-29T02:00:00.000Z",
      ]);
      await store.create({ label: "created", nested: { count: 0 } });
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      const first = store.update(0, async (current) => {
        firstEntered();
        await firstGate;
        return { ...current, nested: { count: 1 } };
      });
      await entered;
      const alias = createStore(
        swapDriveLetterCase(path).toUpperCase(),
        swapDriveLetterCase(rootDirectory).toUpperCase(),
        { clock: () => new Date("2026-07-29T03:00:00.000Z") },
      );
      const second = alias.update(1, (current) => ({
        ...current,
        nested: { count: current.nested.count + 1 },
      }));
      const secondBeforeRelease = await Promise.race([
        second.then(
          () => "settled",
          () => "settled",
        ),
        delay(100).then(() => "pending"),
      ]);
      releaseFirst();

      expect(secondBeforeRelease).toBe("pending");
      await expect(first).resolves.toMatchObject({ revision: 1, value: { nested: { count: 1 } } });
      await expect(second).resolves.toMatchObject({ revision: 2, value: { nested: { count: 2 } } });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        revision: 2,
        value: { nested: { count: 2 } },
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "derives one case-normalized coordinator before a document parent exists",
    async () => {
      const { rootDirectory } = await fixture();
      const path = join(rootDirectory, "missing", "nested", "settings.json");
      let releaseCreate!: () => void;
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      let createEntered!: () => void;
      const createAtMkdir = new Promise<void>((resolve) => {
        createEntered = resolve;
      });
      let gateFirstMkdir = true;
      const firstIo: AtomicJsonFileIo = {
        ...nodeAtomicJsonFileIo,
        mkdir: async (candidate) => {
          if (gateFirstMkdir) {
            gateFirstMkdir = false;
            createEntered();
            await createGate;
          }
          await nodeAtomicJsonFileIo.mkdir(candidate);
        },
      };
      const first = createStore(path, rootDirectory, { fileIo: firstIo }).create({
        label: "first",
        nested: { count: 1 },
      });
      await createAtMkdir;
      const alias = createStore(path.toUpperCase(), rootDirectory.toUpperCase());
      const second = alias.create({ label: "second", nested: { count: 2 } });
      const secondBeforeRelease = await Promise.race([
        second.then(
          () => "settled",
          () => "settled",
        ),
        delay(100).then(() => "pending"),
      ]);
      releaseCreate();

      expect(secondBeforeRelease).toBe("pending");
      await expect(first).resolves.toMatchObject({
        revision: 0,
        value: { label: "first", nested: { count: 1 } },
      });
      await expect(second).rejects.toEqual(expectCode("DOCUMENT_ALREADY_EXISTS"));
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        revision: 0,
        value: { label: "first", nested: { count: 1 } },
      });
    },
  );

  it("serializes backup recovery before a newer update can commit", async () => {
    const { path, rootDirectory, store } = await fixture([
      "2026-07-29T01:00:00.000Z",
      "2026-07-29T02:00:00.000Z",
    ]);
    await store.create({ label: "created", nested: { count: 0 } });
    await store.update(0, (current) => ({ ...current, nested: { count: 1 } }));
    await writeFile(path, '{"schemaVersion":1,"revision":"corrupt"}\n', "utf8");
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let recoveryEntered!: () => void;
    const recoveryAtPublish = new Promise<void>((resolve) => {
      recoveryEntered = resolve;
    });
    let gateRecovery = true;
    const recoveryIo: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      rename: async (source, destination) => {
        if (gateRecovery && destination.toLowerCase() === path.toLowerCase()) {
          gateRecovery = false;
          recoveryEntered();
          await recoveryGate;
        }
        await nodeAtomicJsonFileIo.rename(source, destination);
      },
    };
    const recoveringStore = createStore(path, rootDirectory, { fileIo: recoveryIo });
    const recovery = recoveringStore.read();
    await expect(
      Promise.race([recoveryAtPublish.then(() => true), delay(250).then(() => false)]),
    ).resolves.toBe(true);
    let updaterEntered = false;
    const updating = createStore(path, rootDirectory, {
      clock: () => new Date("2026-07-29T03:00:00.000Z"),
    }).update(0, (current) => {
      updaterEntered = true;
      return { ...current, nested: { count: 99 } };
    });
    const updateRanBeforeRecovery = await Promise.race([
      updating.then(
        () => true,
        () => true,
      ),
      delay(100).then(() => false),
    ]);
    releaseRecovery();

    await expect(recovery).resolves.toMatchObject({ revision: 0, value: { nested: { count: 0 } } });
    await expect(updating).resolves.toMatchObject({
      revision: 1,
      value: { nested: { count: 99 } },
    });
    expect(updateRanBeforeRecovery).toBe(false);
    expect(updaterEntered).toBe(true);
    await expect(createStore(path, rootDirectory).read()).resolves.toMatchObject({
      revision: 1,
      value: { nested: { count: 99 } },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      revision: 1,
      value: { nested: { count: 99 } },
    });
  });

  it("coalesces two recovery-capable reads through the document coordinator", async () => {
    const { path, rootDirectory, store } = await fixture([
      "2026-07-29T01:00:00.000Z",
      "2026-07-29T02:00:00.000Z",
    ]);
    await store.create({ label: "created", nested: { count: 0 } });
    await store.update(0, (current) => ({ ...current, nested: { count: 1 } }));
    await writeFile(path, '{"schemaVersion":1,"revision":"corrupt"}\n', "utf8");
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let recoveryEntered!: () => void;
    const recoveryAtPublish = new Promise<void>((resolve) => {
      recoveryEntered = resolve;
    });
    let recoveryPublishes = 0;
    const recoveryIo: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      rename: async (source, destination) => {
        if (destination.toLowerCase() === path.toLowerCase()) {
          recoveryPublishes += 1;
          if (recoveryPublishes === 1) {
            recoveryEntered();
            await recoveryGate;
          }
        }
        await nodeAtomicJsonFileIo.rename(source, destination);
      },
    };
    const first = createStore(path, rootDirectory, { fileIo: recoveryIo }).read();
    await recoveryAtPublish;
    let secondSettled = false;
    const second = createStore(path, rootDirectory, { fileIo: recoveryIo })
      .read()
      .finally(() => {
        secondSettled = true;
      });
    await delay(100);
    const secondSettledBeforeRelease = secondSettled;
    releaseRecovery();

    await expect(first).resolves.toMatchObject({ revision: 0, value: { nested: { count: 0 } } });
    await expect(second).resolves.toMatchObject({ revision: 0, value: { nested: { count: 0 } } });
    expect(secondSettledBeforeRelease).toBe(false);
    expect(recoveryPublishes).toBe(1);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      revision: 0,
      value: { nested: { count: 0 } },
    });
  });

  it("does not poison later mutations when coordinated recovery fails", async () => {
    const { path, rootDirectory, store } = await fixture([
      "2026-07-29T01:00:00.000Z",
      "2026-07-29T02:00:00.000Z",
    ]);
    await store.create({ label: "created", nested: { count: 0 } });
    await store.update(0, (current) => ({ ...current, nested: { count: 1 } }));
    await writeFile(path, '{"schemaVersion":1,"revision":"corrupt"}\n', "utf8");
    let failRecovery = true;
    const recoveryIo: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      rename: async (source, destination) => {
        if (failRecovery && destination.toLowerCase() === path.toLowerCase()) {
          failRecovery = false;
          throw new Error("injected coordinated recovery failure");
        }
        await nodeAtomicJsonFileIo.rename(source, destination);
      },
    };
    const coordinated = createStore(path, rootDirectory, {
      clock: () => new Date("2026-07-29T03:00:00.000Z"),
      fileIo: recoveryIo,
    });

    await expect(coordinated.read()).rejects.toEqual(
      expect.objectContaining({ code: "ATOMIC_JSON_RECOVERY_FAILED" }),
    );
    await expect(
      coordinated.update(0, (current) => ({ ...current, nested: { count: 7 } })),
    ).resolves.toMatchObject({ revision: 1, value: { nested: { count: 7 } } });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      revision: 1,
      value: { nested: { count: 7 } },
    });
  });

  it("rejects stale concurrent writers with DOCUMENT_CONFLICT", async () => {
    const { store } = await fixture();
    await store.create({ label: "created", nested: { count: 0 } });

    const first = store.update(0, (current) => ({
      ...current,
      nested: { count: current.nested.count + 1 },
    }));
    const stale = store.update(0, (current) => ({
      ...current,
      nested: { count: current.nested.count + 10 },
    }));

    await expect(first).resolves.toMatchObject({ revision: 1 });
    await expect(stale).rejects.toEqual(expectCode("DOCUMENT_CONFLICT"));
    await expect(store.read()).resolves.toMatchObject({ value: { nested: { count: 1 } } });
  });

  it("rejects revision overflow before invoking the updater or publishing", async () => {
    const { path, store } = await fixture();
    const envelope: DocumentEnvelope<z.infer<typeof valueSchema>> = {
      schemaVersion: 1,
      revision: Number.MAX_SAFE_INTEGER,
      updatedAt: "2026-07-29T01:02:03.004Z",
      value: { label: "maximum", nested: { count: 1 } },
    };
    await writeFile(path, JSON.stringify(envelope), "utf8");
    let updaterCalled = false;

    await expect(
      store.update(Number.MAX_SAFE_INTEGER, (current) => {
        updaterCalled = true;
        return current;
      }),
    ).rejects.toEqual(expectCode("DOCUMENT_REVISION_OVERFLOW"));
    expect(updaterCalled).toBe(false);
    await expect(readFile(path, "utf8")).resolves.toBe(JSON.stringify(envelope));
  });

  it("rejects invalid updater and replacement output without changing the document", async () => {
    const { store } = await fixture();
    await store.create({ label: "created", nested: { count: 1 } });

    await expect(store.update(0, () => ({ label: "", nested: { count: -1 } }))).rejects.toEqual(
      expectCode("DOCUMENT_VALUE_INVALID"),
    );
    await expect(store.replace(0, { label: "", nested: { count: -1 } })).rejects.toEqual(
      expectCode("DOCUMENT_VALUE_INVALID"),
    );
    await expect(store.read()).resolves.toMatchObject({
      revision: 0,
      value: { label: "created", nested: { count: 1 } },
    });
  });

  it.each([
    ["invalid date", () => new Date(Number.NaN)],
    ["non-UTC custom date", () => ({ toISOString: () => "2026-07-29T09:00:00+08:00" }) as Date],
  ])("fails closed for an $0 from the injected clock", async (_name, clock) => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-document-clock-"));
    cleanups.push(() => rm(rootDirectory, { recursive: true, force: true }));
    const store = new DocumentStore({
      path: join(rootDirectory, "settings.json"),
      rootDirectory,
      schemaVersion: 1,
      valueSchema,
      defaultValue: () => ({ label: "default", nested: { count: 0 } }),
      clock,
    });

    await expect(store.create()).rejects.toEqual(expectCode("DOCUMENT_INVALID_TIMESTAMP"));
  });
});
