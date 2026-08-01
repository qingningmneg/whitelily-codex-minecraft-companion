import { createHash } from "node:crypto";
import {
  appendFile,
  link,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG_TOML } from "../../src/config/defaultConfig.js";
import type { OwnerIdentitySnapshot } from "../../src/identity/ownerIdentity.js";
import { OwnerIdentityService } from "../../src/identity/ownerIdentityService.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: () => resolve?.() };
}

async function writeOwnerFixture(ownerUsername: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "whitelily-owner-"));
  const configPath = join(directory, "config.toml");
  await writeFile(configPath, DEFAULT_CONFIG_TOML.replace("YourMcName", ownerUsername), "utf8");
  return configPath;
}

describe("OwnerIdentityService", () => {
  it("publishes one immutable revision and resets presence after commit", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    const service = await OwnerIdentityService.open(configPath);
    const seen: OwnerIdentitySnapshot[] = [];
    service.subscribe((snapshot) => seen.push(snapshot));

    await service.update({ expectedRevision: 0, ownerUsername: "NewOwner" });

    expect(seen).toEqual([
      { revision: 1, ownerUsername: "NewOwner", configured: true, presence: "unknown" },
    ]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(await readFile(configPath, "utf8")).toContain('owner_username = "NewOwner"');
  });

  it("creates a valid private template when config.toml is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "whitelily-owner-missing-"));
    const configPath = join(directory, "config.toml");

    const service = await OwnerIdentityService.open(configPath);

    expect(service.snapshot()).toMatchObject({ ownerUsername: null, configured: false });
    expect(await readFile(configPath, "utf8")).toContain('owner_username = "YourMcName"');
  });

  it("does not install an arbitrary matching recovery file as config authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "whitelily-owner-arbitrary-recovery-"));
    const configPath = join(directory, "config.toml");
    await writeFile(
      join(directory, ".config.toml.external.recovery"),
      DEFAULT_CONFIG_TOML.replace("YourMcName", "ForeignOwner"),
      "utf8",
    );

    const service = await OwnerIdentityService.open(configPath);

    expect(service.snapshot()).toMatchObject({ revision: 0, ownerUsername: null });
    expect(await readFile(configPath, "utf8")).toContain('owner_username = "YourMcName"');
  });

  it("does not install invalid recovery content as config authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "whitelily-owner-invalid-recovery-"));
    const configPath = join(directory, "config.toml");
    const recoveryBasename = ".config.toml.owner-identity.forged-intent.recovery";
    const invalid = "[minecraft]\nowner_username = ";
    const invalidFingerprint = createHash("sha256").update(invalid, "utf8").digest("hex");
    await writeFile(join(directory, recoveryBasename), invalid, "utf8");
    await writeFile(
      join(directory, ".config.toml.owner-identity.transaction.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        targetBasename: "config.toml",
        recoveryBasename,
        transactionToken: "forged-intent",
        expectedFingerprint: invalidFingerprint,
        nextFingerprint: "0".repeat(64),
      })}\n`,
      "utf8",
    );

    const service = await OwnerIdentityService.open(configPath);

    expect(service.snapshot()).toMatchObject({ revision: 0, ownerUsername: null });
    expect(await readFile(configPath, "utf8")).toContain('owner_username = "YourMcName"');
  });

  it("ignores multiple unowned recovery leftovers instead of blocking bootstrap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "whitelily-owner-many-recoveries-"));
    const configPath = join(directory, "config.toml");
    for (const [token, ownerUsername] of [
      ["first", "FirstOwner"],
      ["second", "SecondOwner"],
    ] as const) {
      await writeFile(
        join(directory, `.config.toml.${token}.recovery`),
        DEFAULT_CONFIG_TOML.replace("YourMcName", ownerUsername),
        "utf8",
      );
    }

    const service = await OwnerIdentityService.open(configPath);

    expect(service.snapshot()).toMatchObject({ revision: 0, ownerUsername: null });
    expect(await readFile(configPath, "utf8")).toContain('owner_username = "YourMcName"');
  });

  it("rejects an external edit without replacing it", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    const service = await OwnerIdentityService.open(configPath);
    await appendFile(configPath, "\n# external edit\n");

    await expect(
      service.update({ expectedRevision: 0, ownerUsername: "NewOwner" }),
    ).rejects.toMatchObject({ code: "OWNER_IDENTITY_CONFIG_CONFLICT" });

    expect(service.snapshot().ownerUsername).toBe("OldOwner");
    expect(await readFile(configPath, "utf8")).toContain("# external edit");
  });

  it.each(["after-read", "after-sync", "before-publish"] as const)(
    "rejects and preserves an external edit injected %s in the commit window",
    async (stage) => {
      const configPath = await writeOwnerFixture("OldOwner");
      const original = await readFile(configPath, "utf8");
      const external = `${original.trimEnd()}\n\n# external commit-window edit\n`;
      let updating = false;
      let injected = false;
      const injectExternalEdit = async (): Promise<void> => {
        if (injected) return;
        injected = true;
        await writeFile(configPath, external, "utf8");
      };
      const io = {
        readFile: async (path: string, encoding: "utf8"): Promise<string> => {
          const raw = await readFile(path, encoding);
          if (updating && path === configPath && stage === "after-read") {
            await injectExternalEdit();
          }
          return raw;
        },
        open: async (path: string, flags: "wx", mode: number) => {
          const handle = await open(path, flags, mode);
          return {
            writeFile: async (contents: string, options: { encoding: "utf8" }) => {
              await handle.writeFile(contents, options);
            },
            sync: async () => {
              await handle.sync();
              if (updating && stage === "after-sync") await injectExternalEdit();
            },
            close: async () => {
              await handle.close();
            },
          };
        },
        rename: async (source: string, destination: string): Promise<void> => {
          if (updating && destination === configPath && stage === "before-publish") {
            await injectExternalEdit();
          }
          await rename(source, destination);
        },
        link: async (source: string, destination: string): Promise<void> => {
          if (updating && destination === configPath && stage === "before-publish") {
            await injectExternalEdit();
          }
          await link(source, destination);
        },
      };
      const service = await OwnerIdentityService.open(configPath, { io });
      updating = true;

      await expect(
        service.update({ expectedRevision: 0, ownerUsername: "NewOwner" }),
      ).rejects.toMatchObject({ code: "OWNER_IDENTITY_CONFIG_CONFLICT" });

      expect(injected).toBe(true);
      expect(await readFile(configPath, "utf8")).toBe(external);
      expect(service.snapshot()).toMatchObject({ revision: 0, ownerUsername: "OldOwner" });

      updating = false;
      await writeFile(configPath, original, "utf8");
      await expect(
        service.update({ expectedRevision: 0, ownerUsername: "RecoveredOwner" }),
      ).resolves.toMatchObject({ revision: 1, ownerUsername: "RecoveredOwner" });
    },
  );

  it("restores the captured config when create-no-replace publish fails", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    const original = await readFile(configPath, "utf8");
    let updating = false;
    const service = await OwnerIdentityService.open(configPath, {
      io: {
        link: async (source, destination) => {
          if (updating && destination === configPath && source.endsWith(".tmp")) {
            throw new Error("publish failed");
          }
          await link(source, destination);
        },
      },
    });
    updating = true;

    await expect(
      service.update({ expectedRevision: 0, ownerUsername: "NewOwner" }),
    ).rejects.toMatchObject({ code: "OWNER_IDENTITY_WRITE_FAILED" });

    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(service.snapshot()).toMatchObject({ revision: 0, ownerUsername: "OldOwner" });

    updating = false;
    await expect(
      service.update({ expectedRevision: 0, ownerUsername: "RecoveredOwner" }),
    ).resolves.toMatchObject({ revision: 1, ownerUsername: "RecoveredOwner" });
  });

  it("never publishes when durable commit-intent creation fails", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    const original = await readFile(configPath, "utf8");
    let updating = false;
    const service = await OwnerIdentityService.open(configPath, {
      createTempToken: () => "proof-failure",
      io: {
        link: async (source, destination) => {
          if (updating && destination.endsWith(".committed.json")) {
            throw new Error("commit intent failed");
          }
          await link(source, destination);
        },
      },
    });
    updating = true;

    await expect(
      service.update({ expectedRevision: 0, ownerUsername: "NewOwner" }),
    ).rejects.toMatchObject({ code: "OWNER_IDENTITY_WRITE_FAILED" });

    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(service.snapshot()).toMatchObject({ revision: 0, ownerUsername: "OldOwner" });
  });

  it("still never publishes when commit-intent creation and journal deactivation both fail", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    const original = await readFile(configPath, "utf8");
    const journalPath = join(dirname(configPath), ".config.toml.owner-identity.transaction.json");
    let updating = false;
    const service = await OwnerIdentityService.open(configPath, {
      createTempToken: () => "proof-and-deactivate-failure",
      io: {
        link: async (source, destination) => {
          if (updating && destination.endsWith(".committed.json")) {
            throw new Error("commit intent failed");
          }
          await link(source, destination);
        },
        rename: async (source, destination) => {
          if (updating && source === journalPath && destination.endsWith(".inactive")) {
            try {
              await readFile(source, "utf8");
            } catch {
              await rename(source, destination);
              return;
            }
            throw new Error("journal deactivation failed");
          }
          await rename(source, destination);
        },
      },
    });
    updating = true;

    let updateError: unknown;
    try {
      await service.update({ expectedRevision: 0, ownerUsername: "NewOwner" });
    } catch (error) {
      updateError = error;
    }
    const afterFailure = await readFile(configPath, "utf8");
    await unlink(configPath);

    const reopened = await OwnerIdentityService.open(configPath);

    expect.soft(updateError).toMatchObject({ code: "OWNER_IDENTITY_WRITE_FAILED" });
    expect.soft(afterFailure).toBe(original);
    expect(reopened.snapshot()).toMatchObject({ revision: 0, ownerUsername: "OldOwner" });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("replays a durable pre-publication intent after interruption", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    const oldRaw = await readFile(configPath, "utf8");
    const nextRaw = DEFAULT_CONFIG_TOML.replace("YourMcName", "NewOwner");
    const directory = dirname(configPath);
    const token = "prepublish-crash";
    const tempPath = join(directory, `.config.toml.${token}.tmp`);
    const recoveryPath = join(directory, `.config.toml.owner-identity.${token}.recovery`);
    const journalPath = join(directory, ".config.toml.owner-identity.transaction.json");
    const committedPath = join(directory, `.config.toml.owner-identity.${token}.committed.json`);
    const journal = `${JSON.stringify({
      schemaVersion: 1,
      targetBasename: "config.toml",
      recoveryBasename: `.config.toml.owner-identity.${token}.recovery`,
      transactionToken: token,
      expectedFingerprint: createHash("sha256").update(oldRaw, "utf8").digest("hex"),
      nextFingerprint: createHash("sha256").update(nextRaw, "utf8").digest("hex"),
    })}\n`;
    await writeFile(tempPath, nextRaw, "utf8");
    await writeFile(journalPath, journal, "utf8");
    await link(journalPath, committedPath);
    await rename(configPath, recoveryPath);

    const reopened = await OwnerIdentityService.open(configPath);

    expect(reopened.snapshot()).toMatchObject({ revision: 0, ownerUsername: "NewOwner" });
    expect(await readFile(configPath, "utf8")).toBe(nextRaw);
    await expect(readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(tempPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(recoveryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(committedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([".recovery", ".tmp"] as const)(
    "keeps the committed config available when %s cleanup fails",
    async (cleanupSuffix) => {
      const configPath = await writeOwnerFixture("OldOwner");
      let updating = false;
      const service = await OwnerIdentityService.open(configPath, {
        io: {
          unlink: async (path) => {
            if (updating && path.endsWith(cleanupSuffix)) throw new Error("cleanup failed");
            await unlink(path);
          },
        },
      });
      updating = true;

      await expect(
        service.update({ expectedRevision: 0, ownerUsername: "NewOwner" }),
      ).resolves.toMatchObject({ revision: 1, ownerUsername: "NewOwner" });

      expect(await readFile(configPath, "utf8")).toContain('owner_username = "NewOwner"');
      expect(service.snapshot()).toMatchObject({ revision: 1, ownerUsername: "NewOwner" });
      const leftovers = (await readdir(join(configPath, ".."))).filter((entry) =>
        entry.endsWith(cleanupSuffix),
      );
      expect(leftovers).toHaveLength(1);
    },
  );

  it("never revives a cleanup leftover after a successful publication", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    let updating = false;
    const service = await OwnerIdentityService.open(configPath, {
      io: {
        unlink: async (path) => {
          if (updating && path.endsWith(".recovery")) throw new Error("cleanup failed");
          await unlink(path);
        },
      },
    });
    updating = true;

    await expect(
      service.update({ expectedRevision: 0, ownerUsername: "NewOwner" }),
    ).resolves.toMatchObject({ revision: 1, ownerUsername: "NewOwner" });
    await unlink(configPath);

    const reopened = await OwnerIdentityService.open(configPath);

    expect(reopened.snapshot()).toMatchObject({ revision: 0, ownerUsername: null });
    expect(await readFile(configPath, "utf8")).toContain('owner_username = "YourMcName"');
  });

  it("retains every witness after published config deactivation fails and replays the new owner", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    const directory = dirname(configPath);
    const token = "post-publish-deactivate";
    const journalPath = join(directory, ".config.toml.owner-identity.transaction.json");
    const tempPath = join(directory, `.config.toml.${token}.tmp`);
    const recoveryPath = join(directory, `.config.toml.owner-identity.${token}.recovery`);
    const committedPath = join(directory, `.config.toml.owner-identity.${token}.committed.json`);
    let updating = false;
    const service = await OwnerIdentityService.open(configPath, {
      createTempToken: () => token,
      io: {
        rename: async (source, destination) => {
          if (updating && source === journalPath && destination.endsWith(".inactive")) {
            try {
              await readFile(source, "utf8");
            } catch {
              await rename(source, destination);
              return;
            }
            throw new Error("journal deactivation failed");
          }
          await rename(source, destination);
        },
      },
    });
    updating = true;

    let updateError: unknown;
    try {
      await service.update({ expectedRevision: 0, ownerUsername: "NewOwner" });
    } catch (error) {
      updateError = error;
    }
    expect(await readFile(configPath, "utf8")).toContain('owner_username = "NewOwner"');
    expect
      .soft(await readdir(directory))
      .toEqual(
        expect.arrayContaining([
          "config.toml",
          ".config.toml.owner-identity.transaction.json",
          `.config.toml.${token}.tmp`,
          `.config.toml.owner-identity.${token}.recovery`,
          `.config.toml.owner-identity.${token}.committed.json`,
        ]),
      );
    await unlink(configPath);

    const reopened = await OwnerIdentityService.open(configPath);

    expect.soft(updateError).toMatchObject({ code: "OWNER_IDENTITY_CONFIG_CONFLICT" });
    expect.soft(reopened.snapshot()).toMatchObject({ revision: 0, ownerUsername: "NewOwner" });
    expect(await readFile(configPath, "utf8")).toContain('owner_username = "NewOwner"');
    await expect(readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(tempPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(recoveryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(committedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let inert recovery cleanup block open or overwrite the inert artifact", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    const inertRecoveryPath = join(dirname(configPath), ".config.toml.owner-identity.recovery");
    const inertRecovery = `${DEFAULT_CONFIG_TOML.trimEnd()}\n\n# external inert artifact\n`;
    await writeFile(inertRecoveryPath, inertRecovery, "utf8");

    const service = await OwnerIdentityService.open(configPath, {
      io: {
        rename: async (source, destination) => {
          if (source === inertRecoveryPath) throw new Error("inert cleanup failed");
          await rename(source, destination);
        },
      },
    });

    await expect(
      service.update({ expectedRevision: 0, ownerUsername: "NewOwner" }),
    ).resolves.toMatchObject({ revision: 1, ownerUsername: "NewOwner" });
    expect(await readFile(configPath, "utf8")).toContain('owner_username = "NewOwner"');
    expect(await readFile(inertRecoveryPath, "utf8")).toBe(inertRecovery);
  });

  it("never revives the captured config after an external file wins publication", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    const original = await readFile(configPath, "utf8");
    const external = `${original.trimEnd()}\n\n# external publication winner\n`;
    let updating = false;
    let injected = false;
    const service = await OwnerIdentityService.open(configPath, {
      io: {
        link: async (source, destination) => {
          if (updating && destination === configPath && !injected) {
            injected = true;
            await writeFile(configPath, external, "utf8");
          }
          await link(source, destination);
        },
      },
    });
    updating = true;

    await expect(
      service.update({ expectedRevision: 0, ownerUsername: "NewOwner" }),
    ).rejects.toMatchObject({ code: "OWNER_IDENTITY_CONFIG_CONFLICT" });
    expect(await readFile(configPath, "utf8")).toBe(external);
    await unlink(configPath);

    const reopened = await OwnerIdentityService.open(configPath);

    expect(reopened.snapshot()).toMatchObject({ revision: 0, ownerUsername: null });
    expect(await readFile(configPath, "utf8")).toContain('owner_username = "YourMcName"');
  });

  it("recovers a captured config when publication and immediate restoration both fail", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    const original = await readFile(configPath, "utf8");
    let updating = false;
    const service = await OwnerIdentityService.open(configPath, {
      io: {
        link: async (source, destination) => {
          if (updating && destination === configPath) {
            throw new Error(source.endsWith(".tmp") ? "publish failed" : "restore failed");
          }
          await link(source, destination);
        },
      },
    });
    updating = true;

    await expect(
      service.update({ expectedRevision: 0, ownerUsername: "NewOwner" }),
    ).rejects.toMatchObject({ code: "OWNER_IDENTITY_WRITE_FAILED" });
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const reopened = await OwnerIdentityService.open(configPath);

    expect(reopened.snapshot()).toMatchObject({ revision: 0, ownerUsername: "OldOwner" });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("keeps the old owner when rename fails", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    let updating = false;
    const service = await OwnerIdentityService.open(configPath, {
      io: {
        rename: vi.fn(async (source, destination) => {
          if (updating && source === configPath) throw new Error("disk");
          await rename(source, destination);
        }),
      },
    });
    updating = true;

    await expect(
      service.update({ expectedRevision: 0, ownerUsername: "NewOwner" }),
    ).rejects.toMatchObject({ code: "OWNER_IDENTITY_WRITE_FAILED" });

    expect(service.snapshot().ownerUsername).toBe("OldOwner");
  });

  it("retains a corrupt config and reports a stable error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "whitelily-owner-corrupt-"));
    const configPath = join(directory, "config.toml");
    await writeFile(configPath, "[minecraft]\nowner_username = ", "utf8");

    const service = await OwnerIdentityService.open(configPath);

    expect(() => service.snapshot()).toThrowError(
      expect.objectContaining({ code: "OWNER_IDENTITY_CONFIG_INVALID" }),
    );
    await expect(
      service.update({ expectedRevision: 0, ownerUsername: "NewOwner" }),
    ).rejects.toMatchObject({ code: "OWNER_IDENTITY_CONFIG_INVALID" });
    expect(await readFile(configPath, "utf8")).toBe("[minecraft]\nowner_username = ");
  });

  it("ignores a presence update from a stale owner revision", async () => {
    const service = await OwnerIdentityService.open(await writeOwnerFixture("OldOwner"));
    const seen: OwnerIdentitySnapshot[] = [];
    service.subscribe((snapshot) => seen.push(snapshot));

    service.setPresence({ revision: 0, ownerUsername: "OldOwner", presence: "online" });
    await service.update({ expectedRevision: 0, ownerUsername: "NewOwner" });
    service.setPresence({ revision: 0, ownerUsername: "OldOwner", presence: "offline" });

    expect(seen).toEqual([
      { revision: 0, ownerUsername: "OldOwner", configured: true, presence: "online" },
      { revision: 1, ownerUsername: "NewOwner", configured: true, presence: "unknown" },
    ]);
  });

  it("allows only one concurrent update from the same revision to commit", async () => {
    const configPath = await writeOwnerFixture("OldOwner");
    const firstRead = deferred();
    const releaseFirstRead = deferred();
    let updateReadCount = 0;
    let updating = false;
    const service = await OwnerIdentityService.open(configPath, {
      io: {
        readFile: async (path, encoding) => {
          const raw = await readFile(path, encoding);
          if (updating && ++updateReadCount === 1) {
            firstRead.resolve();
            await releaseFirstRead.promise;
          }
          return raw;
        },
      },
    });
    const seen: OwnerIdentitySnapshot[] = [];
    service.subscribe((snapshot) => seen.push(snapshot));
    updating = true;

    const first = service.update({ expectedRevision: 0, ownerUsername: "FirstOwner" });
    await firstRead.promise;
    const second = service.update({ expectedRevision: 0, ownerUsername: "SecondOwner" });
    releaseFirstRead.resolve();

    await expect(first).resolves.toMatchObject({ revision: 1, ownerUsername: "FirstOwner" });
    await expect(second).rejects.toMatchObject({ code: "OWNER_IDENTITY_CONFIG_CONFLICT" });
    expect(service.snapshot()).toMatchObject({ revision: 1, ownerUsername: "FirstOwner" });
    expect(seen).toEqual([
      { revision: 1, ownerUsername: "FirstOwner", configured: true, presence: "unknown" },
    ]);
  });
});
