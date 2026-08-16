import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AvatarBoneMapping,
  AvatarModelRecord,
} from "../../../../src/avatar/avatarModelTypes.js";
import { createGlbFixture } from "./__fixtures__/createGlbFixture.js";
import { AvatarModelCatalog } from "./avatarModelCatalog.js";
import {
  AvatarModelImporter,
  nodeAvatarModelImporterIo,
  type AvatarModelImporterIo,
  type AvatarPreviewRendererPort,
} from "./avatarModelImporter.js";
import { resolveAvatarModelPaths } from "./avatarModelPaths.js";

const cleanups: Array<() => Promise<void>> = [];
const importedUuid = "00000000-0000-4000-8000-000000000001";
const importedId = `user:${importedUuid}`;

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("AvatarModelImporter", () => {
  it.each([
    ["self-contained GLB", { format: "glb" }, "glb"],
    ["VRM 0.x", { format: "vrm0" }, "vrm"],
    ["VRM 1.0", { format: "vrm1" }, "vrm"],
  ] as const)(
    "atomically imports %s into its managed copy",
    async (_name, fixtureOptions, format) => {
      const harness = await createHarness();
      const sourceBytes = createGlbFixture(fixtureOptions);
      await harness.writeSource(sourceBytes);

      const record = await harness.importer.importFile({
        sourcePath: harness.sourcePath,
        displayName: "  Lily\u0000\n  ",
      });

      expect(record).toMatchObject({
        id: importedId,
        displayName: "Lily",
        origin: "imported",
        format,
        sha256: createHash("sha256").update(sourceBytes).digest("hex"),
        previewStatus: "ready",
        validation: { code: "AVATAR_VALID" },
      });
      expect((await harness.catalog.list()).models.map(({ id }) => id)).toEqual([
        "builtin:whitelily-hd",
        "builtin:whitelily-classic",
        importedId,
      ]);
      expect(await harness.stagingEntries()).toEqual([]);

      await rm(harness.sourcePath);
      await expect(readFile(join(harness.paths.root, record.resourcePath))).resolves.toEqual(
        sourceBytes,
      );
      await expect(
        readFile(join(harness.paths.root, `user/${importedUuid}/record.json`), "utf8").then(
          JSON.parse,
        ),
      ).resolves.toEqual(record);
    },
  );

  it.each([
    ["wrong magic", { magic: "NOPE" }, "AVATAR_GLB_INVALID"],
    ["remote image", { imageUri: "https://example.test/skin.png" }, "AVATAR_EXTERNAL_RESOURCE"],
    ["external buffer", { bufferUri: "body.bin" }, "AVATAR_EXTERNAL_RESOURCE"],
    ["missing hips", { omitBone: "hips" }, "AVATAR_REQUIRED_BONE_MISSING"],
    ["bad accessor", { invalidAccessorBounds: true }, "AVATAR_GLB_INVALID"],
  ] as const)(
    "rejects %s without catalog mutation or staging residue",
    async (_name, options, code) => {
      const harness = await createHarness();
      await harness.writeSource(createGlbFixture(options));

      await expect(
        harness.importer.importFile({ sourcePath: harness.sourcePath, displayName: "Unsafe" }),
      ).rejects.toMatchObject({ code });
      expect((await harness.catalog.list()).models).toHaveLength(2);
      expect(await harness.stagingEntries()).toEqual([]);
      expect(await harness.userEntries()).toEqual([]);
    },
  );

  it("commits a neutral-only GLB without inventing facial animation", async () => {
    const harness = await createHarness();
    await harness.writeSource(createGlbFixture());

    const record = await harness.importer.importFile({
      sourcePath: harness.sourcePath,
      displayName: "Neutral",
    });

    expect(record.expressions).toBe("neutral-only");
  });

  it("cleans staging when preview generation fails", async () => {
    const harness = await createHarness({
      previewRenderer: {
        render: async () => {
          throw new Error("injected preview failure");
        },
      },
    });
    await harness.writeSource(createGlbFixture());

    await expect(
      harness.importer.importFile({ sourcePath: harness.sourcePath, displayName: "Preview" }),
    ).rejects.toMatchObject({ code: "AVATAR_PREVIEW_FAILED" });
    expect((await harness.catalog.list()).models).toHaveLength(2);
    expect(await harness.stagingEntries()).toEqual([]);
    expect(await harness.userEntries()).toEqual([]);
  });

  it("cleans staging when the atomic directory rename fails", async () => {
    const io: AvatarModelImporterIo = {
      ...nodeAvatarModelImporterIo,
      rename: async () => {
        throw new Error("injected rename failure");
      },
    };
    const harness = await createHarness({ io });
    await harness.writeSource(createGlbFixture());

    await expect(
      harness.importer.importFile({ sourcePath: harness.sourcePath, displayName: "Rename" }),
    ).rejects.toMatchObject({ code: "AVATAR_IMPORT_FAILED" });
    expect((await harness.catalog.list()).models).toHaveLength(2);
    expect(await harness.stagingEntries()).toEqual([]);
    expect(await harness.userEntries()).toEqual([]);
  });

  it("removes only the new managed directory when catalog append fails", async () => {
    const harness = await createHarness({ catalogAppendFails: true });
    await harness.writeSource(createGlbFixture());

    await expect(
      harness.importer.importFile({ sourcePath: harness.sourcePath, displayName: "Catalog" }),
    ).rejects.toMatchObject({ code: "AVATAR_IMPORT_FAILED" });
    expect((await harness.catalog.list()).models).toHaveLength(2);
    expect(await harness.stagingEntries()).toEqual([]);
    expect(await harness.userEntries()).toEqual([]);
  });
});

async function createHarness(
  options: {
    readonly previewRenderer?: AvatarPreviewRendererPort;
    readonly io?: AvatarModelImporterIo;
    readonly catalogAppendFails?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-importer-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAvatarModelPaths(root);
  const sourcePath = join(root, "selected-avatar.glb");
  const catalog = new AvatarModelCatalog({ dataRoot: root, builtinModels: builtinModels() });
  await catalog.initialize();
  const previewRenderer = options.previewRenderer ?? {
    render: async ({ outputPath }) => {
      await writeFile(outputPath, Buffer.from("preview-png", "utf8"));
    },
  };
  const catalogPort = options.catalogAppendFails
    ? {
        appendImported: async () => {
          throw new Error("injected catalog append failure");
        },
      }
    : catalog;
  return {
    root,
    paths,
    sourcePath,
    catalog,
    importer: new AvatarModelImporter({
      dataRoot: root,
      catalog: catalogPort,
      previewRenderer,
      createId: () => importedUuid,
      now: () => new Date("2026-08-16T08:00:00.000Z"),
      ...(options.io === undefined ? {} : { io: options.io }),
    }),
    writeSource: (bytes: Uint8Array) => writeFile(sourcePath, bytes),
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

const boneMapping = {
  head: "Head",
  neck: "Neck",
  chest: "Chest",
  hips: "Hips",
  leftUpperArm: "LeftUpperArm",
  leftLowerArm: "LeftLowerArm",
  leftHand: "LeftHand",
  rightUpperArm: "RightUpperArm",
  rightLowerArm: "RightLowerArm",
  rightHand: "RightHand",
  leftUpperLeg: "LeftUpperLeg",
  leftLowerLeg: "LeftLowerLeg",
  leftFoot: "LeftFoot",
  rightUpperLeg: "RightUpperLeg",
  rightLowerLeg: "RightLowerLeg",
  rightFoot: "RightFoot",
} as const satisfies AvatarBoneMapping;

function builtinModels(): readonly [AvatarModelRecord, AvatarModelRecord] {
  const common = {
    displayName: "WhiteLily",
    origin: "builtin" as const,
    sha256: "a".repeat(64),
    importedAt: "2026-08-16T00:00:00.000Z",
    previewStatus: "ready" as const,
    boneMapping,
    bodyAnimation: "whitelily-humanoid-v1" as const,
    expressions: "full" as const,
    validation: {
      code: "AVATAR_VALID" as const,
      validatedAt: "2026-08-16T00:00:00.000Z",
    },
  };
  return [
    {
      ...common,
      id: "builtin:whitelily-hd",
      format: "builtin-hd",
      resourcePath: "builtin/whitelily-hd/high.glb",
      previewPath: "builtin/whitelily-hd/turnaround.png",
    },
    {
      ...common,
      id: "builtin:whitelily-classic",
      format: "builtin-classic",
      resourcePath: "builtin/whitelily-classic/whitelily.geo.json",
      previewPath: "builtin/whitelily-classic/preview.png",
    },
  ];
}
