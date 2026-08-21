import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readVerifiedAvatarFile,
  readVerifiedAvatarResource,
  type VerifiedAvatarResourceReaderIo,
} from "./verifiedAvatarResourceReader.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("readVerifiedAvatarResource", () => {
  it("rejects growth and same-size file swaps for absolute picker sources", async () => {
    const root = await createRoot();
    const path = join(root, "skin.png");
    await writeFile(path, "skin");

    await expect(
      readVerifiedAvatarFile({ path, maximumBytes: 16, io: extraByteIo(path) }),
    ).rejects.toThrow("avatar resource changed during read");
    await expect(
      readVerifiedAvatarFile({ path, maximumBytes: 16, io: metadataDriftIo(path) }),
    ).rejects.toThrow("avatar resource changed during read");
  });

  it("rejects an ancestor link or reparse point when the platform permits one", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-reader-root-"));
    const outside = await mkdtemp(join(tmpdir(), "whitelily-avatar-reader-outside-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "skin.png"), "skin");
    try {
      await symlink(
        outside,
        join(root, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await expect(
      readVerifiedAvatarResource({ root, relativePath: "linked/skin.png", maximumBytes: 16 }),
    ).rejects.toThrow("avatar resource path component is unsafe");
  });

  it("rejects a picker source reached through an ancestor link or reparse point", async () => {
    const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-reader-source-root-"));
    const outside = await mkdtemp(join(tmpdir(), "whitelily-avatar-reader-source-outside-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "skin.png"), "skin");
    try {
      await symlink(
        outside,
        join(root, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await expect(
      readVerifiedAvatarFile({
        path: join(root, "linked", "skin.png"),
        maximumBytes: 16,
      }),
    ).rejects.toThrow("avatar resource source is unsafe");
  });

  it("rejects an extra byte after reading the validated size", async () => {
    const root = await createRoot();
    const path = join(root, "skin.png");
    await writeFile(path, "skin");

    await expect(
      readVerifiedAvatarResource({
        root,
        relativePath: "skin.png",
        maximumBytes: 16,
        io: extraByteIo(path),
      }),
    ).rejects.toThrow("avatar resource changed during read");
  });

  it("rejects same-size metadata drift after a bounded read", async () => {
    const root = await createRoot();
    const path = join(root, "skin.png");
    await writeFile(path, "skin");

    await expect(
      readVerifiedAvatarResource({
        root,
        relativePath: "skin.png",
        maximumBytes: 16,
        io: metadataDriftIo(path),
      }),
    ).rejects.toThrow("avatar resource changed during read");
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "whitelily-avatar-reader-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  return root;
}

function extraByteIo(path: string): VerifiedAvatarResourceReaderIo {
  return controlledIo(path, { extraByte: true, metadataDrift: false });
}

function metadataDriftIo(path: string): VerifiedAvatarResourceReaderIo {
  return controlledIo(path, { extraByte: false, metadataDrift: true });
}

function controlledIo(
  path: string,
  behavior: { readonly extraByte: boolean; readonly metadataDrift: boolean },
): VerifiedAvatarResourceReaderIo {
  let statCalls = 0;
  return {
    lstat: (candidate, options) => lstat(candidate, options),
    realpath: async (candidate) => candidate,
    open: async () => {
      const initial = await lstat(path, { bigint: true });
      return {
        stat: async () => {
          statCalls += 1;
          if (!behavior.metadataDrift || statCalls < 2) return initial;
          return { ...initial, ctimeNs: initial.ctimeNs + 1n };
        },
        read: async (buffer, offset, length, position) => {
          if (position === 4 && behavior.extraByte) {
            buffer[offset] = 0x78;
            return { bytesRead: 1 };
          }
          Buffer.from("skin").copy(buffer, offset, 0, length);
          return { bytesRead: length };
        },
        close: async () => undefined,
      };
    },
  };
}
