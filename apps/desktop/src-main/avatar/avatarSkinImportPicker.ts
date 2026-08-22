import type { AvatarAppearanceRecord } from "../../../../src/avatar/avatarModelTypes.js";

export interface AvatarSkinOpenDialogPort {
  showOpenDialog(options: {
    readonly title: string;
    readonly properties: readonly ["openFile"];
    readonly filters: readonly [{ readonly name: "PNG"; readonly extensions: readonly ["png"] }];
  }): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

export interface AvatarSkinImportPickerResult {
  readonly status: "cancelled" | "imported";
  readonly model?: AvatarAppearanceRecord;
}

interface AvatarSkinImporterPort {
  importSkin(input: {
    readonly skinSourcePath: string;
    readonly portraitSourcePath?: string;
    readonly displayName: string;
    readonly armModel: "slim" | "wide";
  }): Promise<AvatarAppearanceRecord>;
}

export class AvatarSkinImportPicker {
  readonly #showOpenDialog: AvatarSkinOpenDialogPort["showOpenDialog"];
  readonly #choosePortrait: () => Promise<"pick" | "skip" | "cancel">;
  readonly #importer: AvatarSkinImporterPort;

  constructor(options: {
    readonly showOpenDialog: AvatarSkinOpenDialogPort["showOpenDialog"];
    readonly choosePortrait: () => Promise<"pick" | "skip" | "cancel">;
    readonly importer: AvatarSkinImporterPort;
  }) {
    this.#showOpenDialog = options.showOpenDialog;
    this.#choosePortrait = options.choosePortrait;
    this.#importer = options.importer;
  }

  async importFromPicker(): Promise<AvatarSkinImportPickerResult> {
    const skin = await this.#showOpenDialog(pngDialog("Choose Minecraft skin"));
    const skinSourcePath = pickedPath(skin);
    if (skinSourcePath === undefined) return { status: "cancelled" };
    const portraitChoice = await this.#choosePortrait();
    if (portraitChoice === "cancel") return { status: "cancelled" };
    let portraitSourcePath: string | undefined;
    if (portraitChoice === "pick") {
      portraitSourcePath = pickedPath(
        await this.#showOpenDialog(pngDialog("Choose optional portrait")),
      );
      if (portraitSourcePath === undefined) return { status: "cancelled" };
    }
    const model = await this.#importer.importSkin({
      skinSourcePath,
      ...(portraitSourcePath === undefined ? {} : { portraitSourcePath }),
      displayName: "Imported skin",
      armModel: "slim",
    });
    return { status: "imported", model };
  }
}

function pngDialog(title: string): {
  readonly title: string;
  readonly properties: readonly ["openFile"];
  readonly filters: readonly [{ readonly name: "PNG"; readonly extensions: readonly ["png"] }];
} {
  return { title, properties: ["openFile"], filters: [{ name: "PNG", extensions: ["png"] }] };
}

function pickedPath(result: {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}): string | undefined {
  if (result.canceled || result.filePaths.length !== 1 || typeof result.filePaths[0] !== "string") {
    return undefined;
  }
  return result.filePaths[0];
}
