import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvatarAppearanceRecord } from "../../../../src/avatar/avatarModelTypes.js";
import { AvatarModelCatalog } from "./avatarModelCatalog.js";
import {
  nodeAtomicJsonFileIo,
  type AtomicJsonFileIo,
} from "../../../../src/storage/atomicJsonFile.js";
import {
  AvatarModelImporter,
  nodeAvatarModelImporterIo,
  type AvatarModelImporterIo,
} from "./avatarModelImporter.js";
import { resolveAvatarModelPaths } from "./avatarModelPaths.js";
import { png, validSkinBytes } from "./pngImageValidator.test.js";

const cleanups: Array<() => Promise<void>> = [];
const importedUuid = "00000000-0000-4000-8000-000000000001";
const importedId = `user:${importedUuid}`;

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("AvatarModelImporter", () => {
  it("atomically imports a validated skin with its explicitly selected portrait", async () => {
    const harness = await createHarness();
    const skin = validSkinBytes();
    const portrait = png({ width: 1, height: 1 });
    await harness.writeSources(skin, portrait);

    const record = await harness.importer.importSkin({
      skinSourcePath: harness.skinSourcePath,
      portraitSourcePath: harness.portraitSourcePath,
      displayName: "  Lily\u0000\n  ",
      armModel: "wide",
    });

    expect(record).toEqual({
      id: importedId,
      displayName: "Lily",
      origin: "imported",
      worldRenderer: "minecraft-skin",
      skinAsset: `user/${importedUuid}/skin.png`,
      skinSha256: sha256(skin),
      armModel: "wide",
      portraitAsset: `user/${importedUuid}/portrait.png`,
      portraitSha256: sha256(portrait),
      importedAt: "2026-08-21T08:00:00.000Z",
      validation: { code: "AVATAR_VALID", validatedAt: "2026-08-21T08:00:00.000Z" },
    });
    await expect(readFile(join(harness.paths.root, record.skinAsset))).resolves.toEqual(skin);
    await expect(readFile(join(harness.paths.root, record.portraitAsset!))).resolves.toEqual(
      portrait,
    );
    await expect(
      readFile(join(harness.paths.root, `user/${importedUuid}/preview.png`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await harness.catalog.list()).models.map(({ id }) => id)).toEqual([
      "builtin:whitelily",
      importedId,
    ]);
    expect(await harness.stagingEntries()).toEqual([]);
  });

  it("creates a deterministic preview from the verified skin only when portrait is skipped", async () => {
    const first = await createHarness();
    const second = await createHarness();
    const skin = validSkinBytes();
    await first.writeSources(skin);
    await second.writeSources(skin);
    const record = await first.importer.importSkin({
      skinSourcePath: first.skinSourcePath,
      displayName: "No portrait",
      armModel: "slim",
    });
    await second.importer.importSkin({
      skinSourcePath: second.skinSourcePath,
      displayName: "No portrait",
      armModel: "slim",
    });

    expect(record).not.toHaveProperty("portraitAsset");
    const [firstPreview, secondPreview] = await Promise.all([
      readFile(join(first.paths.root, `user/${importedUuid}/preview.png`)),
      readFile(join(second.paths.root, `user/${importedUuid}/preview.png`)),
    ]);
    expect(firstPreview).toEqual(secondPreview);
  });

  it.each([
    ["a malformed skin", () => Buffer.from("not a png"), undefined, "AVATAR_SKIN_INVALID"],
    [
      "a malformed portrait",
      validSkinBytes,
      () => Buffer.from("not a png"),
      "AVATAR_PORTRAIT_INVALID",
    ],
  ] as const)(
    "rejects %s without publishing files or a catalog record",
    async (_name, skin, portrait, code) => {
      const harness = await createHarness();
      await harness.writeSources(skin(), portrait?.());
      await expect(
        harness.importer.importSkin({
          skinSourcePath: harness.skinSourcePath,
          ...(portrait === undefined ? {} : { portraitSourcePath: harness.portraitSourcePath }),
          displayName: "Unsafe",
          armModel: "slim",
        }),
      ).rejects.toMatchObject({ code });
      expect((await harness.catalog.list()).models).toHaveLength(1);
      expect(await harness.stagingEntries()).toEqual([]);
      expect(await harness.userEntries()).toEqual([]);
    },
  );

  it("rejects unresolved traversal and URL-like source inputs before path resolution", async () => {
    const harness = await createHarness();
    await harness.writeSources(validSkinBytes());

    await expect(
      harness.importer.importSkin({
        skinSourcePath: `${harness.root}${sep}nested${sep}..${sep}selected-skin.png`,
        displayName: "Traversal",
        armModel: "slim",
      }),
    ).rejects.toMatchObject({ code: "AVATAR_IMPORT_FAILED" });
    await expect(
      harness.importer.importSkin({
        skinSourcePath: "file:///C:/skin.png",
        displayName: "URL",
        armModel: "slim",
      }),
    ).rejects.toMatchObject({ code: "AVATAR_IMPORT_FAILED" });
  });

  it("cleans its staging directory when staged bytes fail their digest recheck", async () => {
    const io = {
      ...nodeAvatarModelImporterIo,
      readFile: async (path: Parameters<typeof nodeAvatarModelImporterIo.readFile>[0]) => {
        const bytes = (await nodeAvatarModelImporterIo.readFile(path)) as Buffer;
        return String(path).endsWith("skin.png") ? Buffer.from("tampered") : bytes;
      },
    } as AvatarModelImporterIo;
    const harness = await createHarness({ io });
    await harness.writeSources(validSkinBytes());
    await expect(
      harness.importer.importSkin({
        skinSourcePath: harness.skinSourcePath,
        displayName: "Digest",
        armModel: "slim",
      }),
    ).rejects.toMatchObject({ code: "AVATAR_DIGEST_MISMATCH" });
    expect(await harness.stagingEntries()).toEqual([]);
    expect(await harness.userEntries()).toEqual([]);
  });

  it("cleans owned directories when catalog append proves it did not commit", async () => {
    const catalog = await createHarness({ catalogAppendFails: true });
    await catalog.writeSources(validSkinBytes());
    await expect(
      catalog.importer.importSkin({
        skinSourcePath: catalog.skinSourcePath,
        displayName: "Catalog",
        armModel: "slim",
      }),
    ).rejects.toMatchObject({ code: "AVATAR_IMPORT_FAILED" });
    expect(await catalog.stagingEntries()).toEqual([]);
    expect(await catalog.userEntries()).toEqual([]);
  });

  it("reconciles a catalog error injected after its atomic rename without deleting committed assets", async () => {
    const harness = await createHarness({ catalogAppendFailsAfterCommit: true });
    await harness.writeSources(validSkinBytes());

    await expect(
      harness.importer.importSkin({
        skinSourcePath: harness.skinSourcePath,
        displayName: "Committed",
        armModel: "slim",
      }),
    ).resolves.toMatchObject({ id: importedId });
    await expect(
      readFile(join(harness.paths.root, `user/${importedUuid}/skin.png`)),
    ).resolves.toEqual(validSkinBytes());
    await expect(harness.catalog.has(importedId)).resolves.toBe(true);
  });

  it("retains managed files when a catalog error has no provable commit outcome", async () => {
    const harness = await createHarness({ catalogAppendOutcomeUnknown: true });
    await harness.writeSources(validSkinBytes());

    await expect(
      harness.importer.importSkin({
        skinSourcePath: harness.skinSourcePath,
        displayName: "Unknown catalog",
        armModel: "slim",
      }),
    ).rejects.toMatchObject({ code: "AVATAR_IMPORT_FAILED" });
    await expect(readFile(join(harness.paths.userRoot, importedUuid, "skin.png"))).resolves.toEqual(
      validSkinBytes(),
    );
  });

  it("reconciles a real AtomicJsonFile error thrown after catalog rename", async () => {
    let throwAfterRename = false;
    const fileIo: AtomicJsonFileIo = {
      ...nodeAtomicJsonFileIo,
      rename: async (source, destination) => {
        await nodeAtomicJsonFileIo.rename(source, destination);
        if (throwAfterRename && destination.endsWith("catalog.json")) {
          throw new Error("injected post-rename catalog error");
        }
      },
    };
    const harness = await createHarness({ fileIo });
    await harness.writeSources(validSkinBytes());
    throwAfterRename = true;

    await expect(
      harness.importer.importSkin({
        skinSourcePath: harness.skinSourcePath,
        displayName: "Atomic catalog",
        armModel: "slim",
      }),
    ).resolves.toMatchObject({ id: importedId });
    await expect(harness.catalog.has(importedId)).resolves.toBe(true);
    await expect(readFile(join(harness.paths.userRoot, importedUuid, "skin.png"))).resolves.toEqual(
      validSkinBytes(),
    );
  });

  it("never invokes replace-capable rename for a pre-existing UUID destination", async () => {
    const rename = vi.fn();
    const ioWithReplaceCapableRename = { ...nodeAvatarModelImporterIo, rename };
    const harness = await createHarness({ io: ioWithReplaceCapableRename });
    await harness.writeSources(validSkinBytes());
    await harness.reserveDestination(Buffer.from("foreign"));

    await expect(
      harness.importer.importSkin({
        skinSourcePath: harness.skinSourcePath,
        displayName: "Collision",
        armModel: "slim",
      }),
    ).rejects.toMatchObject({ code: "AVATAR_IMPORT_FAILED" });
    expect(rename).not.toHaveBeenCalled();
    await expect(
      readFile(join(harness.paths.userRoot, importedUuid, "foreign.txt")),
    ).resolves.toEqual(Buffer.from("foreign"));
  });

  it("preserves a pre-existing empty UUID destination", async () => {
    const harness = await createHarness();
    await harness.writeSources(validSkinBytes());
    await harness.reserveDestination();

    await expect(
      harness.importer.importSkin({
        skinSourcePath: harness.skinSourcePath,
        displayName: "Empty collision",
        armModel: "slim",
      }),
    ).rejects.toMatchObject({ code: "AVATAR_IMPORT_FAILED" });
    await expect(readdir(join(harness.paths.userRoot, importedUuid))).resolves.toEqual([]);
  });

  it("allows only one concurrent import to reserve the same UUID destination", async () => {
    const harness = await createHarness();
    await harness.writeSources(validSkinBytes());
    const concurrent = new AvatarModelImporter({
      dataRoot: harness.root,
      catalog: harness.catalog,
      createId: () => importedUuid,
      now: () => new Date("2026-08-21T08:00:00.000Z"),
    });
    const input = {
      skinSourcePath: harness.skinSourcePath,
      displayName: "Race",
      armModel: "slim",
    } as const;

    const outcomes = await Promise.allSettled([
      harness.importer.importSkin(input),
      concurrent.importSkin(input),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await harness.userEntries()).toEqual([importedUuid]);
  });
});

async function createHarness(
  options: {
    readonly io?: AvatarModelImporterIo;
    readonly catalogAppendFails?: boolean;
    readonly catalogAppendFailsAfterCommit?: boolean;
    readonly catalogAppendOutcomeUnknown?: boolean;
    readonly fileIo?: AtomicJsonFileIo;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "whitelily-skin-importer-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAvatarModelPaths(root);
  const skinSourcePath = join(root, "selected-skin.png");
  const portraitSourcePath = join(root, "selected-portrait.png");
  const catalog = new AvatarModelCatalog({
    dataRoot: root,
    builtinModels: builtinAppearance(),
    ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
  });
  await catalog.initialize();
  const catalogPort = options.catalogAppendFails
    ? {
        appendImported: async () => Promise.reject(new Error("injected catalog append failure")),
        has: async () => false,
      }
    : options.catalogAppendFailsAfterCommit
      ? {
          appendImported: async (record: AvatarAppearanceRecord) => {
            await catalog.appendImported(record);
            throw new Error("injected post-rename catalog failure");
          },
          has: (id: string) => catalog.has(id),
        }
      : options.catalogAppendOutcomeUnknown
        ? {
            appendImported: async () =>
              Promise.reject(new Error("injected uncertain catalog failure")),
            has: async () => Promise.reject(new Error("catalog outcome unavailable")),
          }
        : catalog;
  return {
    root,
    paths,
    skinSourcePath,
    portraitSourcePath,
    catalog,
    importer: new AvatarModelImporter({
      dataRoot: root,
      catalog: catalogPort,
      createId: () => importedUuid,
      now: () => new Date("2026-08-21T08:00:00.000Z"),
      ...(options.io === undefined ? {} : { io: options.io }),
    }),
    writeSources: async (skin: Buffer, portrait?: Buffer) => {
      await writeFile(skinSourcePath, skin);
      if (portrait !== undefined) await writeFile(portraitSourcePath, portrait);
    },
    reserveDestination: async (contents?: Buffer) => {
      const destination = join(paths.userRoot, importedUuid);
      await mkdir(destination, { recursive: true });
      if (contents !== undefined) {
        await writeFile(join(destination, "foreign.txt"), contents, { flag: "wx" });
      }
    },
    stagingEntries: () => entriesOrEmpty(paths.stagingRoot),
    userEntries: () => entriesOrEmpty(join(paths.root, "user")),
  };
}

async function entriesOrEmpty(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === "ENOENT"
  );
}
function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function builtinAppearance(): AvatarAppearanceRecord {
  return {
    id: "builtin:whitelily",
    displayName: "WhiteLily",
    origin: "builtin",
    worldRenderer: "minecraft-skin",
    skinAsset: "builtin/whitelily/skin/base.png",
    skinSha256: "a".repeat(64),
    armModel: "slim",
    portraitAsset: "builtin/whitelily/portrait.png",
    portraitSha256: "b".repeat(64),
    importedAt: "2026-08-21T00:00:00.000Z",
    validation: { code: "AVATAR_VALID", validatedAt: "2026-08-21T00:00:00.000Z" },
  };
}
