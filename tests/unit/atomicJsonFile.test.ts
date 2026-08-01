import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AtomicJsonFile,
  AtomicJsonFileError,
  nodeAtomicJsonFileIo,
  type AtomicJsonBoundaryContext,
  type AtomicJsonFileIo,
  type AtomicJsonFileOptions,
} from "../../src/storage/atomicJsonFile.js";

const cleanups: Array<() => Promise<void>> = [];
const valueSchema = z.object({ nested: z.object({ count: z.number().int() }).strict() }).strict();

async function fixture() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-atomic-json-"));
  cleanups.push(() => rm(rootDirectory, { recursive: true, force: true }));
  const path = join(rootDirectory, "settings.json");
  return { rootDirectory, path };
}

function createFile(
  path: string,
  rootDirectory: string,
  io: AtomicJsonFileIo = nodeAtomicJsonFileIo,
  beforeBoundary?: (context: AtomicJsonBoundaryContext) => void | Promise<void>,
) {
  let sequence = 0;
  return new AtomicJsonFile({
    path,
    rootDirectory,
    validate: (value) => valueSchema.parse(value),
    io,
    randomId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    ...(beforeBoundary === undefined ? {} : { beforeBoundary }),
  } as AtomicJsonFileOptions<z.infer<typeof valueSchema>> & {
    beforeBoundary?: (context: AtomicJsonBoundaryContext) => void | Promise<void>;
  });
}

function wrapIo(
  transform: (
    handle: Awaited<ReturnType<AtomicJsonFileIo["open"]>>,
    path: string,
  ) => Awaited<ReturnType<AtomicJsonFileIo["open"]>>,
): AtomicJsonFileIo {
  return {
    ...nodeAtomicJsonFileIo,
    open: async (path, flags) => transform(await nodeAtomicJsonFileIo.open(path, flags), path),
  };
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("AtomicJsonFile", () => {
  it("returns undefined for a missing document without creating it", async () => {
    const { rootDirectory, path } = await fixture();

    await expect(createFile(path, rootDirectory).read()).resolves.toBeUndefined();
    await expect(readdir(rootDirectory)).resolves.toEqual([]);
  });

  it("returns undefined without creating a verified root that does not exist yet", async () => {
    const { rootDirectory } = await fixture();
    const missingRoot = join(rootDirectory, "not-created");
    const path = join(missingRoot, "settings.json");

    await expect(createFile(path, missingRoot).read()).resolves.toBeUndefined();
    await expect(readdir(rootDirectory)).resolves.toEqual([]);
  });

  it("publishes valid JSON through a random sibling temp and returns detached values", async () => {
    const { rootDirectory, path } = await fixture();
    const openedPaths: string[] = [];
    const io: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      open: async (candidate, flags) => {
        openedPaths.push(candidate);
        return nodeAtomicJsonFileIo.open(candidate, flags);
      },
    };
    const file = createFile(path, rootDirectory, io);

    const written = await file.write({ nested: { count: 1 } });
    written.nested.count = 99;
    const firstRead = await file.read();
    firstRead!.nested.count = 77;

    await expect(file.read()).resolves.toEqual({ nested: { count: 1 } });
    await expect(readFile(path, "utf8")).resolves.toBe(
      '{\n  "nested": {\n    "count": 1\n  }\n}\n',
    );
    expect(openedPaths).toHaveLength(1);
    expect(dirname(openedPaths[0]!)).toBe(rootDirectory);
    expect(openedPaths[0]).toMatch(/\.settings\.json\.00000000-0000-4000-8000-000000000001\.tmp$/u);
  });

  it("rejects a target outside the verified root before touching the filesystem", async () => {
    const { rootDirectory } = await fixture();

    expect(() => createFile(resolve(rootDirectory, "..", "escaped.json"), rootDirectory)).toThrow(
      expect.objectContaining<Partial<AtomicJsonFileError>>({ code: "ATOMIC_JSON_PATH" }),
    );
  });

  it("allows a verified root below an ancestor directory junction", async () => {
    const actualParent = await mkdtemp(join(tmpdir(), "whitelily-atomic-json-actual-parent-"));
    const aliasContainer = await mkdtemp(join(tmpdir(), "whitelily-atomic-json-alias-parent-"));
    const aliasParent = join(aliasContainer, "runner-work");
    cleanups.push(async () => {
      await rm(aliasParent, { force: true });
      await rm(aliasContainer, { recursive: true, force: true });
      await rm(actualParent, { recursive: true, force: true });
    });
    await symlink(actualParent, aliasParent, "junction");
    const rootDirectory = join(aliasParent, "WhiteLily", "data");
    const actualRoot = join(actualParent, "WhiteLily", "data");
    const path = join(rootDirectory, "settings.json");
    await mkdir(rootDirectory, { recursive: true });

    const file = createFile(path, rootDirectory);
    await expect(file.write({ nested: { count: 7 } })).resolves.toEqual({
      nested: { count: 7 },
    });
    await expect(file.read()).resolves.toEqual({ nested: { count: 7 } });
    await expect(readFile(join(actualRoot, "settings.json"), "utf8")).resolves.toContain(
      '"count": 7',
    );
  });

  it("still rejects a verified root that is itself a directory junction", async () => {
    const actualRoot = await mkdtemp(join(tmpdir(), "whitelily-atomic-json-actual-root-"));
    const aliasContainer = await mkdtemp(join(tmpdir(), "whitelily-atomic-json-alias-root-"));
    const aliasRoot = join(aliasContainer, "data");
    cleanups.push(async () => {
      await rm(aliasRoot, { force: true });
      await rm(aliasContainer, { recursive: true, force: true });
      await rm(actualRoot, { recursive: true, force: true });
    });
    await symlink(actualRoot, aliasRoot, "junction");

    await expect(createFile(join(aliasRoot, "settings.json"), aliasRoot).read()).rejects.toEqual(
      expect.objectContaining<Partial<AtomicJsonFileError>>({ code: "ATOMIC_JSON_PATH" }),
    );
  });

  it("refuses to follow a directory junction outside the verified root", async () => {
    const { rootDirectory } = await fixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "whitelily-atomic-json-outside-"));
    cleanups.push(() => rm(outsideDirectory, { recursive: true, force: true }));
    const outsidePath = join(outsideDirectory, "outside.json");
    const linkedDirectory = join(rootDirectory, "linked");
    const path = join(linkedDirectory, "outside.json");
    await writeFile(outsidePath, '{"nested":{"count":42}}\n', "utf8");
    await symlink(outsideDirectory, linkedDirectory, "junction");

    await expect(createFile(path, rootDirectory).read()).rejects.toEqual(
      expect.objectContaining<Partial<AtomicJsonFileError>>({ code: "ATOMIC_JSON_PATH" }),
    );
  });

  it("does not create a missing descendant through an existing junction outside the root", async () => {
    const { rootDirectory } = await fixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "whitelily-atomic-json-outside-"));
    cleanups.push(() => rm(outsideDirectory, { recursive: true, force: true }));
    const linkedDirectory = join(rootDirectory, "linked");
    const outsideDescendant = join(outsideDirectory, "created-outside", "nested");
    const path = join(linkedDirectory, "created-outside", "nested", "settings.json");
    await symlink(outsideDirectory, linkedDirectory, "junction");

    await expect(createFile(path, rootDirectory).write({ nested: { count: 1 } })).rejects.toEqual(
      expect.objectContaining<Partial<AtomicJsonFileError>>({ code: "ATOMIC_JSON_PATH" }),
    );
    await expect(access(outsideDescendant)).rejects.toThrow();
    await expect(readdir(outsideDirectory)).resolves.toEqual([]);
  });

  it("rejects an in-root junction alias instead of treating it as a second safe path", async () => {
    const { rootDirectory } = await fixture();
    const actualDirectory = join(rootDirectory, "actual");
    const aliasDirectory = join(rootDirectory, "alias");
    await mkdir(actualDirectory);
    await writeFile(join(actualDirectory, "settings.json"), '{"nested":{"count":42}}\n', "utf8");
    await symlink(actualDirectory, aliasDirectory, "junction");

    await expect(
      createFile(join(aliasDirectory, "settings.json"), rootDirectory).read(),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AtomicJsonFileError>>({ code: "ATOMIC_JSON_PATH" }),
    );
  });

  it("rechecks the target at the read-open boundary after an injected file swap", async () => {
    const { rootDirectory, path } = await fixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "whitelily-atomic-json-outside-"));
    cleanups.push(() => rm(outsideDirectory, { recursive: true, force: true }));
    const outsidePath = join(outsideDirectory, "outside.json");
    const outsideContents = '{"nested":{"count":42}}\n';
    await writeFile(path, '{"nested":{"count":1}}\n', "utf8");
    await writeFile(outsidePath, outsideContents, "utf8");
    let swapped = false;

    await expect(
      createFile(path, rootDirectory, nodeAtomicJsonFileIo, async ({ operation }) => {
        if (operation !== "open-read" || swapped) return;
        swapped = true;
        await rm(path);
        await symlink(outsideDirectory, path, "junction");
      }).read(),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AtomicJsonFileError>>({ code: "ATOMIC_JSON_PATH" }),
    );
    expect(swapped).toBe(true);
    await expect(readFile(outsidePath, "utf8")).resolves.toBe(outsideContents);
  });

  it("rechecks the verified parent before temp open after an injected directory swap", async () => {
    const { rootDirectory } = await fixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "whitelily-atomic-json-outside-"));
    cleanups.push(() => rm(outsideDirectory, { recursive: true, force: true }));
    const directory = join(rootDirectory, "safe");
    const heldDirectory = join(rootDirectory, "held");
    const path = join(directory, "settings.json");
    await mkdir(directory);
    let swapped = false;

    await expect(
      createFile(path, rootDirectory, nodeAtomicJsonFileIo, async ({ operation }) => {
        if (operation !== "open-temp" || swapped) return;
        swapped = true;
        await rename(directory, heldDirectory);
        await symlink(outsideDirectory, directory, "junction");
      }).write({ nested: { count: 1 } }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AtomicJsonFileError>>({ code: "ATOMIC_JSON_PATH" }),
    );
    expect(swapped).toBe(true);
    await expect(readdir(outsideDirectory)).resolves.toEqual([]);
  });

  it("rechecks the destination at the rename boundary after an injected target swap", async () => {
    const { rootDirectory, path } = await fixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "whitelily-atomic-json-outside-"));
    cleanups.push(() => rm(outsideDirectory, { recursive: true, force: true }));
    const outsidePath = join(outsideDirectory, "outside.json");
    const outsideContents = '{"nested":{"count":42}}\n';
    await createFile(path, rootDirectory).write({ nested: { count: 1 } });
    await writeFile(outsidePath, outsideContents, "utf8");
    let swapped = false;

    await expect(
      createFile(path, rootDirectory, nodeAtomicJsonFileIo, async (context) => {
        if (
          context.operation !== "rename" ||
          context.destination.toLowerCase() !== path.toLowerCase() ||
          swapped
        ) {
          return;
        }
        swapped = true;
        await rm(path);
        await symlink(outsideDirectory, path, "junction");
      }).write({ nested: { count: 2 } }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AtomicJsonFileError>>({ code: "ATOMIC_JSON_PATH" }),
    );
    expect(swapped).toBe(true);
    await expect(readFile(outsidePath, "utf8")).resolves.toBe(outsideContents);
  });

  it("rechecks that the temp source is a regular file at the rename boundary", async () => {
    const { rootDirectory, path } = await fixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "whitelily-atomic-json-outside-"));
    cleanups.push(() => rm(outsideDirectory, { recursive: true, force: true }));
    const outsidePath = join(outsideDirectory, "outside.json");
    const outsideContents = '{"nested":{"count":42}}\n';
    await writeFile(outsidePath, outsideContents, "utf8");
    let swapped = false;

    await expect(
      createFile(path, rootDirectory, nodeAtomicJsonFileIo, async (context) => {
        if (
          context.operation !== "rename" ||
          context.destination.toLowerCase() !== path.toLowerCase() ||
          swapped
        ) {
          return;
        }
        swapped = true;
        await rm(context.source);
        await symlink(outsideDirectory, context.source, "junction");
      }).write({ nested: { count: 1 } }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AtomicJsonFileError>>({ code: "ATOMIC_JSON_PATH" }),
    );
    expect(swapped).toBe(true);
    await expect(access(path)).rejects.toThrow();
    await expect(readFile(outsidePath, "utf8")).resolves.toBe(outsideContents);
  });

  it("rejects when the published primary is replaced after rename without deleting the replacement", async () => {
    const { rootDirectory, path } = await fixture();
    const unrelated = '{"nested":{"count":999}}\n';
    const io: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      rename: async (source, destination) => {
        await nodeAtomicJsonFileIo.rename(source, destination);
        if (destination.toLowerCase() !== path.toLowerCase()) return;
        await rm(destination);
        await writeFile(destination, unrelated, "utf8");
      },
    };

    await expect(
      createFile(path, rootDirectory, io).write({ nested: { count: 1 } }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AtomicJsonFileError>>({ code: "ATOMIC_JSON_PATH" }),
    );
    await expect(readFile(path, "utf8")).resolves.toBe(unrelated);
    expect((await readdir(rootDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects when the published backup is replaced after rename and leaves the primary untouched", async () => {
    const { rootDirectory, path } = await fixture();
    const original = '{\n  "nested": {\n    "count": 1\n  }\n}\n';
    const unrelated = '{"nested":{"count":999}}\n';
    await createFile(path, rootDirectory).write({ nested: { count: 1 } });
    const io: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      rename: async (source, destination) => {
        await nodeAtomicJsonFileIo.rename(source, destination);
        if (destination.toLowerCase() !== `${path}.backup`.toLowerCase()) return;
        await rm(destination);
        await writeFile(destination, unrelated, "utf8");
      },
    };

    await expect(
      createFile(path, rootDirectory, io).write({ nested: { count: 2 } }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AtomicJsonFileError>>({ code: "ATOMIC_JSON_PATH" }),
    );
    await expect(readFile(path, "utf8")).resolves.toBe(original);
    await expect(readFile(`${path}.backup`, "utf8")).resolves.toBe(unrelated);
    expect((await readdir(rootDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("cleans the created temp after the first writable-handle stat fails", async () => {
    const { rootDirectory, path } = await fixture();
    const io = wrapIo((handle) => {
      let first = true;
      return {
        ...handle,
        stat: async () => {
          if (first) {
            first = false;
            throw new Error("injected first handle stat failure");
          }
          return handle.stat();
        },
      };
    });

    await expect(
      createFile(path, rootDirectory, io).write({ nested: { count: 1 } }),
    ).rejects.toThrow("injected first handle stat failure");
    await expect(readdir(rootDirectory)).resolves.toEqual([]);
  });

  it("cleans the created temp after the first pathname identity verification fails", async () => {
    const { rootDirectory, path } = await fixture();
    let failed = false;
    const io: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      lstat: async (candidate) => {
        if (!failed && candidate.endsWith(".tmp")) {
          failed = true;
          throw new Error("injected first pathname verification failure");
        }
        return nodeAtomicJsonFileIo.lstat(candidate);
      },
    };

    await expect(
      createFile(path, rootDirectory, io).write({ nested: { count: 1 } }),
    ).rejects.toThrow("injected first pathname verification failure");
    await expect(readdir(rootDirectory)).resolves.toEqual([]);
  });

  it("does not delete an unrelated temp-path replacement after writable-handle stat fails", async () => {
    const { rootDirectory, path } = await fixture();
    const unrelated = '{"unrelated":"handle-stat-replacement"}\n';
    let replacementPath: string | undefined;
    const io = wrapIo((handle, candidate) => {
      let first = true;
      return {
        ...handle,
        stat: async () => {
          if (!first) return handle.stat();
          first = false;
          replacementPath = candidate;
          await rm(candidate);
          await writeFile(candidate, unrelated, "utf8");
          throw new Error("injected replaced handle stat failure");
        },
      };
    });

    await expect(
      createFile(path, rootDirectory, io).write({ nested: { count: 1 } }),
    ).rejects.toThrow("injected replaced handle stat failure");
    expect(replacementPath).toBeDefined();
    await expect(readFile(replacementPath!, "utf8")).resolves.toBe(unrelated);
  });

  it("does not delete an unrelated temp-path replacement after pathname verification fails", async () => {
    const { rootDirectory, path } = await fixture();
    const unrelated = '{"unrelated":"pathname-replacement"}\n';
    let replacementPath: string | undefined;
    const io: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      lstat: async (candidate) => {
        if (replacementPath === undefined && candidate.endsWith(".tmp")) {
          replacementPath = candidate;
          await rm(candidate);
          await writeFile(candidate, unrelated, "utf8");
          throw new Error("injected replaced pathname verification failure");
        }
        return nodeAtomicJsonFileIo.lstat(candidate);
      },
    };

    await expect(
      createFile(path, rootDirectory, io).write({ nested: { count: 1 } }),
    ).rejects.toThrow("injected replaced pathname verification failure");
    expect(replacementPath).toBeDefined();
    await expect(readFile(replacementPath!, "utf8")).resolves.toBe(unrelated);
  });

  it("cleans the original temp when final closed-path verification fails", async () => {
    const { rootDirectory, path } = await fixture();
    let tempLookups = 0;
    const io: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      lstat: async (candidate) => {
        if (candidate.endsWith(".tmp")) {
          tempLookups += 1;
          if (tempLookups === 2) {
            throw new Error("injected final closed temp verification failure");
          }
        }
        return nodeAtomicJsonFileIo.lstat(candidate);
      },
    };

    await expect(
      createFile(path, rootDirectory, io).write({ nested: { count: 1 } }),
    ).rejects.toThrow("injected final closed temp verification failure");
    await expect(readdir(rootDirectory)).resolves.toEqual([]);
  });

  it("preserves an unrelated temp replacement when final closed-path verification fails", async () => {
    const { rootDirectory, path } = await fixture();
    const unrelated = '{"unrelated":"final-closed-replacement"}\n';
    let replacementPath: string | undefined;
    let tempLookups = 0;
    const io: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      lstat: async (candidate) => {
        if (candidate.endsWith(".tmp")) {
          tempLookups += 1;
          if (tempLookups === 2) {
            replacementPath = candidate;
            await rm(candidate);
            await writeFile(candidate, unrelated, "utf8");
            throw new Error("injected replaced final closed verification failure");
          }
        }
        return nodeAtomicJsonFileIo.lstat(candidate);
      },
    };

    await expect(
      createFile(path, rootDirectory, io).write({ nested: { count: 1 } }),
    ).rejects.toThrow("injected replaced final closed verification failure");
    expect(replacementPath).toBeDefined();
    await expect(readFile(replacementPath!, "utf8")).resolves.toBe(unrelated);
  });

  it("keeps the final verification error when identity-safe cleanup also fails", async () => {
    const { rootDirectory, path } = await fixture();
    let tempLookups = 0;
    let cleanupAttempted = false;
    const io: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      lstat: async (candidate) => {
        if (candidate.endsWith(".tmp")) {
          tempLookups += 1;
          if (tempLookups === 2) {
            throw new Error("injected final verification priority failure");
          }
        }
        return nodeAtomicJsonFileIo.lstat(candidate);
      },
      rm: async (candidate) => {
        if (candidate.endsWith(".tmp")) {
          cleanupAttempted = true;
          throw new Error("injected cleanup failure");
        }
        await nodeAtomicJsonFileIo.rm(candidate);
      },
    };

    await expect(
      createFile(path, rootDirectory, io).write({ nested: { count: 1 } }),
    ).rejects.toThrow("injected final verification priority failure");
    expect(cleanupAttempted).toBe(true);
  });

  it.each([
    {
      name: "temp write",
      io: () =>
        wrapIo((handle) => ({
          ...handle,
          write: async () => {
            throw new Error("injected temp write failure");
          },
        })),
    },
    {
      name: "flush",
      io: () =>
        wrapIo((handle) => ({
          ...handle,
          flush: async () => {
            throw new Error("injected flush failure");
          },
        })),
    },
    {
      name: "close",
      io: () =>
        wrapIo((handle) => ({
          ...handle,
          close: async () => {
            await handle.close();
            throw new Error("injected close failure");
          },
        })),
    },
  ])("does not publish or retain a temp file when $name fails", async ({ name, io }) => {
    const { rootDirectory, path } = await fixture();

    await expect(
      createFile(path, rootDirectory, io()).write({ nested: { count: 1 } }),
    ).rejects.toThrow(`injected ${name} failure`);
    await expect(readdir(rootDirectory)).resolves.toEqual([]);
  });

  it("preserves the committed target when atomic replacement fails", async () => {
    const { rootDirectory, path } = await fixture();
    await createFile(path, rootDirectory).write({ nested: { count: 1 } });
    const io: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      rename: async (source, destination) => {
        if (destination === path) throw new Error("injected replace failure");
        await nodeAtomicJsonFileIo.rename(source, destination);
      },
    };

    await expect(
      createFile(path, rootDirectory, io).write({ nested: { count: 2 } }),
    ).rejects.toThrow("injected replace failure");
    await expect(createFile(path, rootDirectory).read()).resolves.toEqual({
      nested: { count: 1 },
    });
    expect((await readdir(rootDirectory)).every((name) => !name.endsWith(".tmp"))).toBe(true);
  });

  it("does not publish a replacement when the recoverable backup cannot be committed", async () => {
    const { rootDirectory, path } = await fixture();
    await createFile(path, rootDirectory).write({ nested: { count: 1 } });
    const io: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      rename: async (source, destination) => {
        if (destination.endsWith(".backup")) throw new Error("injected backup failure");
        await nodeAtomicJsonFileIo.rename(source, destination);
      },
    };

    await expect(
      createFile(path, rootDirectory, io).write({ nested: { count: 2 } }),
    ).rejects.toThrow("injected backup failure");
    await expect(createFile(path, rootDirectory).read()).resolves.toEqual({
      nested: { count: 1 },
    });
  });

  it("recovers a corrupt target only from a validated backup", async () => {
    const { rootDirectory, path } = await fixture();
    const file = createFile(path, rootDirectory);
    await file.write({ nested: { count: 1 } });
    await file.write({ nested: { count: 2 } });
    await writeFile(path, '{"nested":{"count":"corrupt"}}\n', "utf8");

    await expect(file.read()).resolves.toEqual({ nested: { count: 1 } });
    await expect(file.read()).resolves.toEqual({ nested: { count: 1 } });
    await expect(readFile(`${path}.backup`, "utf8")).resolves.toContain('"count": 1');
  });

  it("fails closed without modifying either file when the backup is also corrupt", async () => {
    const { rootDirectory, path } = await fixture();
    await writeFile(path, '{"nested":{"count":"target-corrupt"}}\n', "utf8");
    await writeFile(`${path}.backup`, '{"nested":{"count":"backup-corrupt"}}\n', "utf8");
    const beforeTarget = await readFile(path, "utf8");
    const beforeBackup = await readFile(`${path}.backup`, "utf8");

    await expect(createFile(path, rootDirectory).read()).rejects.toEqual(
      expect.objectContaining<Partial<AtomicJsonFileError>>({ code: "ATOMIC_JSON_INVALID" }),
    );
    await expect(readFile(path, "utf8")).resolves.toBe(beforeTarget);
    await expect(readFile(`${path}.backup`, "utf8")).resolves.toBe(beforeBackup);
  });

  it("reports recovery failure and leaves the corrupt target unpublished", async () => {
    const { rootDirectory, path } = await fixture();
    const file = createFile(path, rootDirectory);
    await file.write({ nested: { count: 1 } });
    await file.write({ nested: { count: 2 } });
    const corrupt = '{"nested":{"count":"corrupt"}}\n';
    await writeFile(path, corrupt, "utf8");
    const io: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      rename: async (source, destination) => {
        if (destination === path) throw new Error("injected recovery replace failure");
        await nodeAtomicJsonFileIo.rename(source, destination);
      },
    };

    await expect(createFile(path, rootDirectory, io).read()).rejects.toEqual(
      expect.objectContaining<Partial<AtomicJsonFileError>>({
        code: "ATOMIC_JSON_RECOVERY_FAILED",
      }),
    );
    await expect(readFile(path, "utf8")).resolves.toBe(corrupt);
  });
});
