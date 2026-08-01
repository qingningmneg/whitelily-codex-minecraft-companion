// @vitest-environment node

import {
  access,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportSerializedJson, validateSafeWindowsExportPath } from "./safeExportDestination.js";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "whitelily-export-"));
  cleanup.push(value);
  return value;
}

describe("safe memory export destination", () => {
  it("writes exactly one already-serialized JSON value chosen by the main-process dialog", async () => {
    const root = await directory();
    const destination = join(root, "memories.json");
    const serialized = '{"schemaVersion":1,"records":[{"summary":"redacted"}]}';

    await expect(
      exportSerializedJson({
        chooseDestination: async () => ({ canceled: false, filePath: destination }),
        serialized,
      }),
    ).resolves.toEqual({ status: "saved" });
    expect(await readFile(destination, "utf8")).toBe(serialized);
  });

  it.each([
    String.raw`\\server\share\memories.json`,
    String.raw`\\.\PIPE\memories.json`,
    String.raw`\\?\C:\data\memories.json`,
    String.raw`C:\data\memories.txt`,
  ])("rejects unsafe or non-JSON dialog destination %s", async (filePath) => {
    await expect(
      exportSerializedJson({
        chooseDestination: async () => ({ canceled: false, filePath }),
        serialized: "{}",
      }),
    ).rejects.toThrow("safe JSON file");
  });

  it.each([
    String.raw`\rooted\memories.json`,
    String.raw`/rooted/memories.json`,
    String.raw`C:drive-relative\memories.json`,
    String.raw`relative\memories.json`,
    String.raw`C:\safe\..\escaped\memories.json`,
    String.raw`C:\safe\CON.json`,
    String.raw`C:\safe\con.txt\memories.json`,
    String.raw`C:\safe\NUL .json`,
    String.raw`C:\safe\CLOCK$.json`,
    String.raw`C:\safe\COM1.log\memories.json`,
    String.raw`C:\safe\LPT9...\memories.json`,
  ])("rejects drive-ambiguous, non-canonical, or DOS-device path %s", (filePath) => {
    expect(() => validateSafeWindowsExportPath(filePath)).toThrow("safe JSON file");
  });

  it("accepts only a canonical fully drive-qualified JSON path", () => {
    expect(validateSafeWindowsExportPath(String.raw`C:\Exports\whitelily-memories.json`)).toBe(
      String.raw`C:\Exports\whitelily-memories.json`,
    );
  });

  it("rejects directories, symbolic links, and unconfirmed overwrites", async () => {
    const root = await directory();
    const folder = join(root, "folder.json");
    const existing = join(root, "existing.json");
    const link = join(root, "link.json");
    await mkdir(folder);
    await writeFile(existing, "old");
    await symlink(folder, link, "junction");

    for (const filePath of [folder, link, existing]) {
      await expect(
        exportSerializedJson({
          chooseDestination: async () => ({ canceled: false, filePath }),
          serialized: "{}",
        }),
      ).rejects.toThrow();
    }
    expect(await readFile(existing, "utf8")).toBe("old");
  });

  it("fails closed when the selected path changes identity during the write", async () => {
    const root = await directory();
    const destination = join(root, "memories.json");
    await expect(
      exportSerializedJson({
        chooseDestination: async () => ({ canceled: false, filePath: destination }),
        serialized: "{}",
        openFile: async (...args) => {
          const handle = await open(...args);
          await rm(destination);
          await writeFile(destination, "swapped");
          return handle;
        },
      }),
    ).rejects.toThrow("changed during export");
  });

  it("rejects a parent whose real path is redirected through a reparse point", async () => {
    const root = await directory();
    const destination = join(root, "memories.json");
    await expect(
      exportSerializedJson({
        chooseDestination: async () => ({ canceled: false, filePath: destination }),
        serialized: "{}",
        realpathPath: async (path) =>
          path === dirname(destination) ? join(root, "redirected") : realpath(path),
      }),
    ).rejects.toThrow("trusted directory");
  });

  it("rechecks canonical parent identity after sync", async () => {
    const root = await directory();
    const destination = join(root, "memories.json");
    let parentReads = 0;
    await expect(
      exportSerializedJson({
        chooseDestination: async () => ({ canceled: false, filePath: destination }),
        serialized: "{}",
        realpathPath: async (path) => {
          if (path !== dirname(destination)) return realpath(path);
          parentReads += 1;
          return parentReads === 1 ? realpath(path) : join(root, "swapped-parent");
        },
      }),
    ).rejects.toThrow("changed during export");
  });

  it("does not unlink a partially created target after a write failure", async () => {
    const root = await directory();
    const destination = join(root, "memories.json");
    await expect(
      exportSerializedJson({
        chooseDestination: async () => ({ canceled: false, filePath: destination }),
        serialized: "{}",
        openFile: async (...args) => {
          const handle = await open(...args);
          return Object.assign(handle, {
            writeFile: async () => {
              throw new Error("injected partial write failure");
            },
          });
        },
      }),
    ).rejects.toThrow("injected partial write failure");
    await expect(access(destination)).resolves.toBeUndefined();
  });
});
