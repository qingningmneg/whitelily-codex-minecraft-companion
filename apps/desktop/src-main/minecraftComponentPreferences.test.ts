// @vitest-environment node

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AtomicJsonBoundaryContext,
  AtomicJsonFileOptions,
} from "../../../src/storage/atomicJsonFile.js";
import { MinecraftComponentPreferences } from "./minecraftComponentPreferences.js";

const atomicBoundary = vi.hoisted(
  (): {
    callback?: (context: AtomicJsonBoundaryContext) => Promise<void>;
  } => ({}),
);

vi.mock("../../../src/storage/atomicJsonFile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/storage/atomicJsonFile.js")>();
  return {
    ...actual,
    AtomicJsonFile: class<T> extends actual.AtomicJsonFile<T> {
      constructor(options: AtomicJsonFileOptions<T>) {
        super({
          ...options,
          beforeBoundary: async (context) => {
            await options.beforeBoundary?.(context);
            await atomicBoundary.callback?.(context);
          },
        });
      }
    },
  };
});

describe("MinecraftComponentPreferences", () => {
  afterEach(() => {
    atomicBoundary.callback = undefined;
  });

  it("atomically initializes the exact schema 1 defaults only when absent", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-components-preferences-"));
    const preferences = new MinecraftComponentPreferences({ dataRoot });

    await expect(preferences.initializeDefaults()).resolves.toEqual({
      schemaVersion: 1,
      bridgeEnabled: true,
      avatarEnabled: true,
    });
    await expect(
      readFile(join(dataRoot, "config", "minecraft-components.json"), "utf8").then(JSON.parse),
    ).resolves.toEqual({
      schemaVersion: 1,
      bridgeEnabled: true,
      avatarEnabled: true,
    });
  });

  it("preserves existing user choices byte-for-byte across later initialization", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-components-preferences-"));
    const configDirectory = join(dataRoot, "config");
    const path = join(configDirectory, "minecraft-components.json");
    const existing = '{"schemaVersion":1,"bridgeEnabled":false,"avatarEnabled":false}\n';
    await mkdir(configDirectory);
    await writeFile(path, existing, "utf8");

    await expect(
      new MinecraftComponentPreferences({ dataRoot }).initializeDefaults(),
    ).resolves.toEqual({
      schemaVersion: 1,
      bridgeEnabled: false,
      avatarEnabled: false,
    });
    await expect(readFile(path, "utf8")).resolves.toBe(existing);
  });

  it("atomically preserves and returns a user file created at absent-default publication", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-components-preferences-"));
    const configDirectory = join(dataRoot, "config");
    const path = join(configDirectory, "minecraft-components.json");
    const winner = '{"schemaVersion":1,"bridgeEnabled":false,"avatarEnabled":true}\n';
    await mkdir(configDirectory);
    let inserted = false;
    atomicBoundary.callback = async (context) => {
      const boundary = context as AtomicJsonBoundaryContext & {
        readonly operation: string;
        readonly destination?: string;
      };
      if (
        inserted ||
        (boundary.operation !== "rename" && boundary.operation !== "link") ||
        boundary.destination !== path
      ) {
        return;
      }
      inserted = true;
      await writeFile(path, winner, { encoding: "utf8", flag: "wx" });
    };

    await expect(
      new MinecraftComponentPreferences({ dataRoot }).initializeDefaults(),
    ).resolves.toEqual({
      schemaVersion: 1,
      bridgeEnabled: false,
      avatarEnabled: true,
    });
    expect(inserted).toBe(true);
    await expect(readFile(path, "utf8")).resolves.toBe(winner);
  });

  it("fails closed without overwriting a malformed file raced into absent-default publication", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-components-preferences-"));
    const configDirectory = join(dataRoot, "config");
    const path = join(configDirectory, "minecraft-components.json");
    const winner =
      '{"schemaVersion":1,"bridgeEnabled":false,"avatarEnabled":true,"path":"C:/Private"}\n';
    await mkdir(configDirectory);
    atomicBoundary.callback = async (context) => {
      const boundary = context as AtomicJsonBoundaryContext & {
        readonly operation: string;
        readonly destination?: string;
      };
      if (
        (boundary.operation !== "rename" && boundary.operation !== "link") ||
        boundary.destination !== path
      ) {
        return;
      }
      await writeFile(path, winner, { encoding: "utf8", flag: "wx" });
    };

    await expect(
      new MinecraftComponentPreferences({ dataRoot }).initializeDefaults(),
    ).rejects.toThrow("invalid Minecraft component preferences");
    await expect(readFile(path, "utf8")).resolves.toBe(winner);
  });

  it("fails closed without replacing malformed or extra-key preferences", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "whitelily-components-preferences-"));
    const configDirectory = join(dataRoot, "config");
    const path = join(configDirectory, "minecraft-components.json");
    const malformed =
      '{"schemaVersion":1,"bridgeEnabled":true,"avatarEnabled":true,"path":"C:/Private"}\n';
    await mkdir(configDirectory);
    await writeFile(path, malformed, "utf8");

    await expect(
      new MinecraftComponentPreferences({ dataRoot }).initializeDefaults(),
    ).rejects.toThrow("invalid Minecraft component preferences");
    await expect(readFile(path, "utf8")).resolves.toBe(malformed);
  });
});
