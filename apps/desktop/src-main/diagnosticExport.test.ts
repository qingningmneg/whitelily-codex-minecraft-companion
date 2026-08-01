// @vitest-environment node

import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveDiagnosticArchive } from "./diagnosticExport.js";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "whitelily-diagnostic-save-"));
  cleanup.push(value);
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("diagnostic archive Save As", () => {
  it("lets main choose a ZIP destination, prepares the active opaque ID, and never returns a path", async () => {
    const dataRoot = await directory();
    const outputRoot = await directory();
    const destination = join(outputRoot, "whitelily-diagnostics.zip");
    const exportId = "diagnostic_1234567890";
    const prepareArchive = vi.fn(async () => {
      await mkdir(join(dataRoot, "diagnostics"), { recursive: true });
      const bytes = Buffer.from("fixed diagnostic zip");
      await writeFile(join(dataRoot, "diagnostics", `${exportId}.zip`), bytes);
      return { exportId, size: bytes.byteLength, sha256: sha256(bytes) };
    });

    const result = await saveDiagnosticArchive({
      dataRoot,
      exportId,
      chooseDestination: async () => ({ canceled: false, filePath: destination }),
      prepareArchive,
    });

    expect(result).toEqual({ status: "saved" });
    expect(Object.keys(result)).toEqual(["status"]);
    expect(prepareArchive).toHaveBeenCalledWith(exportId);
    expect(await readFile(destination, "utf8")).toBe("fixed diagnostic zip");
    await expect(access(join(dataRoot, "diagnostics", `${exportId}.zip`))).rejects.toThrow();
  });

  it("does not prepare an archive when the native dialog is cancelled", async () => {
    const prepareArchive = vi.fn();
    await expect(
      saveDiagnosticArchive({
        dataRoot: await directory(),
        exportId: "diagnostic_1234567890",
        chooseDestination: async () => ({ canceled: true }),
        prepareArchive,
      }),
    ).resolves.toEqual({ status: "cancelled" });
    expect(prepareArchive).not.toHaveBeenCalled();
  });

  it("rejects malformed IDs, mismatched preparation, and existing destinations", async () => {
    const dataRoot = await directory();
    const outputRoot = await directory();
    const existing = join(outputRoot, "existing.zip");
    await writeFile(existing, "keep me");
    const chooseDestination = vi.fn(async () => ({ canceled: false, filePath: existing }));
    const prepareArchive = vi.fn();

    await expect(
      saveDiagnosticArchive({
        dataRoot,
        exportId: String.raw`..\auth`,
        chooseDestination,
        prepareArchive,
      }),
    ).rejects.toThrow("invalid diagnostic export id");
    expect(chooseDestination).not.toHaveBeenCalled();
    await expect(
      saveDiagnosticArchive({
        dataRoot,
        exportId: "diagnostic_1234567890",
        chooseDestination,
        prepareArchive,
      }),
    ).rejects.toThrow("already exists");
    expect(prepareArchive).not.toHaveBeenCalled();
    expect(await readFile(existing, "utf8")).toBe("keep me");
  });

  it("does not delete an existing opaque-ID source when preparation rejects", async () => {
    const dataRoot = await directory();
    const outputRoot = await directory();
    const exportId = "diagnostic_1234567890";
    const source = join(dataRoot, "diagnostics", `${exportId}.zip`);
    await mkdir(join(dataRoot, "diagnostics"), { recursive: true });
    await writeFile(source, "pre-existing archive");

    await expect(
      saveDiagnosticArchive({
        dataRoot,
        exportId,
        chooseDestination: async () => ({
          canceled: false,
          filePath: join(outputRoot, "diagnostics.zip"),
        }),
        prepareArchive: async () => {
          throw new Error("diagnostic archive already exists");
        },
      }),
    ).rejects.toThrow("diagnostic archive already exists");
    expect(await readFile(source, "utf8")).toBe("pre-existing archive");
  });

  it("rejects a reparse source even when preparation reports the matching ID", async () => {
    const dataRoot = await directory();
    const outputRoot = await directory();
    const outside = await directory();
    const exportId = "diagnostic_1234567890";
    await mkdir(join(dataRoot, "diagnostics"), { recursive: true });
    await writeFile(join(outside, "private.zip"), "outside private archive");
    await symlink(outside, join(dataRoot, "diagnostics", `${exportId}.zip`), "junction");
    const destination = join(outputRoot, "diagnostics.zip");

    await expect(
      saveDiagnosticArchive({
        dataRoot,
        exportId,
        chooseDestination: async () => ({ canceled: false, filePath: destination }),
        prepareArchive: async () => ({ exportId, size: 10, sha256: "0".repeat(64) }),
      }),
    ).rejects.toThrow("trusted regular file");
    await expect(access(destination)).rejects.toThrow();
  });

  it("does not write archive bytes when the selected parent is replaced before destination open", async () => {
    const dataRoot = await directory();
    const outputRoot = await directory();
    const relocatedOutputRoot = `${outputRoot}-relocated`;
    cleanup.push(relocatedOutputRoot);
    const outside = await directory();
    const exportId = "diagnostic_1234567890";
    const destination = join(outputRoot, "diagnostics.zip");

    await expect(
      saveDiagnosticArchive({
        dataRoot,
        exportId,
        chooseDestination: async () => ({ canceled: false, filePath: destination }),
        prepareArchive: async () => {
          const bytes = Buffer.from("fixed diagnostic zip");
          await mkdir(join(dataRoot, "diagnostics"), { recursive: true });
          await writeFile(join(dataRoot, "diagnostics", `${exportId}.zip`), bytes);
          await rename(outputRoot, relocatedOutputRoot);
          await symlink(outside, outputRoot, "junction");
          return { exportId, size: bytes.byteLength, sha256: sha256(bytes) };
        },
      }),
    ).rejects.toThrow();
    await expect(access(join(outside, "diagnostics.zip"))).rejects.toThrow();
  });

  it("rejects a same-size source replacement against the child content attestation", async () => {
    const dataRoot = await directory();
    const outputRoot = await directory();
    const exportId = "diagnostic_1234567890";
    const destination = join(outputRoot, "diagnostics.zip");
    const expected = Buffer.from("trusted whitelist ZIP");
    const replacement = Buffer.from("untrusted private ZIP");
    expect(replacement.byteLength).toBe(expected.byteLength);

    await expect(
      saveDiagnosticArchive({
        dataRoot,
        exportId,
        chooseDestination: async () => ({ canceled: false, filePath: destination }),
        prepareArchive: async () => {
          await mkdir(join(dataRoot, "diagnostics"), { recursive: true });
          const source = join(dataRoot, "diagnostics", `${exportId}.zip`);
          await writeFile(source, expected);
          const expectedSha256 = sha256(expected);
          await writeFile(source, replacement);
          return { exportId, size: expected.byteLength, sha256: expectedSha256 };
        },
      }),
    ).rejects.toThrow("content attestation");
    await expect(access(destination)).rejects.toThrow();
  });
});
