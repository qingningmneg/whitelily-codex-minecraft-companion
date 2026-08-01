import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentStoreError } from "../../../src/storage/documentStore.js";
import { DesktopPreferences } from "./desktopPreferences.js";

describe("DesktopPreferences", () => {
  it("persists a strict versioned close-to-tray preference across instances", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-preferences-"));
    const first = new DesktopPreferences({ rootDirectory });
    const initial = await first.read();
    expect(initial).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      value: { closeToTray: true },
    });

    await first.setCloseToTray(initial.revision, false);
    await expect(new DesktopPreferences({ rootDirectory }).read()).resolves.toMatchObject({
      revision: 1,
      value: { closeToTray: false },
    });
  });

  it("rejects stale revisions and never silently overwrites a corrupt preference", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "whitelily-preferences-"));
    const preferences = new DesktopPreferences({ rootDirectory });
    await preferences.setCloseToTray(0, false);
    await expect(preferences.setCloseToTray(0, true)).rejects.toMatchObject({
      code: "DOCUMENT_CONFLICT",
    });

    const path = join(rootDirectory, "desktop-preferences.json");
    await writeFile(path, "{corrupt", "utf8");
    await expect(new DesktopPreferences({ rootDirectory }).read()).rejects.toBeInstanceOf(
      DocumentStoreError,
    );
    await expect(readFile(path, "utf8")).resolves.toBe("{corrupt");
  });
});
