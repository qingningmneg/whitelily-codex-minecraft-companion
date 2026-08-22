import { describe, expect, it, vi } from "vitest";
import type { AvatarAppearanceRecord } from "../../../../src/avatar/avatarModelTypes.js";
import { AvatarSkinImportPicker } from "./avatarSkinImportPicker.js";

const record: AvatarAppearanceRecord = {
  id: "user:00000000-0000-4000-8000-000000000001",
  displayName: "Imported skin",
  origin: "imported",
  worldRenderer: "minecraft-skin",
  skinAsset: "user/00000000-0000-4000-8000-000000000001/skin.png",
  skinSha256: "a".repeat(64),
  armModel: "slim",
  importedAt: "2026-08-21T00:00:00.000Z",
  validation: { code: "AVATAR_VALID", validatedAt: "2026-08-21T00:00:00.000Z" },
};

describe("AvatarSkinImportPicker", () => {
  it("picks a PNG skin first and offers an explicit portrait skip without exposing paths", async () => {
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ["C:\\skin.png"] }));
    const importSkin = vi.fn(async () => record);
    const picker = new AvatarSkinImportPicker({
      showOpenDialog,
      choosePortrait: async () => "skip",
      importer: { importSkin },
    });

    await expect(picker.importFromPicker()).resolves.toEqual({ status: "imported", model: record });
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: "PNG", extensions: ["png"] }] }),
    );
    expect(importSkin).toHaveBeenCalledWith({
      skinSourcePath: "C:\\skin.png",
      displayName: "Imported skin",
      armModel: "slim",
    });
  });

  it.each([
    [
      "skin dialog",
      async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
        canceled: true,
        filePaths: [],
      }),
      async (): Promise<"skip"> => "skip",
    ],
    [
      "portrait choice",
      async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
        canceled: false,
        filePaths: ["C:\\skin.png"],
      }),
      async (): Promise<"cancel"> => "cancel",
    ],
    [
      "portrait dialog",
      vi
        .fn()
        .mockResolvedValueOnce({ canceled: false, filePaths: ["C:\\skin.png"] })
        .mockResolvedValueOnce({ canceled: true, filePaths: [] }),
      async (): Promise<"pick"> => "pick",
    ],
  ])(
    "returns cancelled when %s is cancelled and never imports",
    async (_name, dialog, choosePortrait) => {
      const importSkin = vi.fn(async () => record);
      const picker = new AvatarSkinImportPicker({
        showOpenDialog: dialog,
        choosePortrait,
        importer: { importSkin },
      });

      await expect(picker.importFromPicker()).resolves.toEqual({ status: "cancelled" });
      expect(importSkin).not.toHaveBeenCalled();
    },
  );
});
