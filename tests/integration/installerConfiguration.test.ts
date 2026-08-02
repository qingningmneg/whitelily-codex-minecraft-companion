import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface FileSet {
  from: string;
  to: string;
  filter?: string[];
}

type FilePattern = string | FileSet;

interface InstallerBuildConfiguration {
  appId?: string;
  productName?: string;
  forceCodeSigning?: boolean;
  disableDefaultIgnoredFiles?: boolean;
  directories?: {
    buildResources?: string;
    output?: string;
  };
  asar?: boolean;
  asarUnpack?: string[];
  afterPack?: string;
  files?: FilePattern[];
  extraResources?: FileSet[];
  win?: {
    target?: Array<{ target: string; arch: string[] }>;
    icon?: string;
    requestedExecutionLevel?: string;
    signExecutable?: boolean;
  };
  nsis?: {
    guid?: string;
    oneClick?: boolean;
    perMachine?: boolean;
    selectPerMachineByDefault?: boolean;
    allowElevation?: boolean;
    allowToChangeInstallationDirectory?: boolean;
    packElevateHelper?: boolean;
    createDesktopShortcut?: boolean;
    createStartMenuShortcut?: boolean;
    shortcutName?: string;
    include?: string;
    installerIcon?: string;
    uninstallerIcon?: string;
    artifactName?: string;
    deleteAppDataOnUninstall?: boolean;
  };
}

interface DesktopPackage {
  name: string;
  version: string;
  productName?: string;
  main: string;
  build?: InstallerBuildConfiguration;
}

interface IcoEntry {
  size: number;
  bytes: Buffer;
}

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const desktopPackagePath = join(repositoryRoot, "apps", "desktop", "package.json");
const installerIncludePath = join(repositoryRoot, "packaging", "nsis", "installer.nsh");
const uninstallerIncludePath = join(repositoryRoot, "packaging", "nsis", "uninstaller.nsh");
const svgPath = join(repositoryRoot, "assets", "branding", "whitelily-icon.svg");
const icoPath = join(repositoryRoot, "apps", "desktop", "build", "icon.ico");
const afterPackWrapperPath = join(repositoryRoot, "apps", "desktop", "build", "after-pack.cjs");
const viteConfigPath = join(repositoryRoot, "apps", "desktop", "vite.config.ts");
const electronBuilderNsisTemplateRoot = join(
  repositoryRoot,
  "node_modules",
  "app-builder-lib",
  "templates",
  "nsis",
);

async function readDesktopPackage(): Promise<DesktopPackage> {
  return JSON.parse(await readFile(desktopPackagePath, "utf8")) as DesktopPackage;
}

function readIcoEntries(buffer: Buffer): IcoEntry[] {
  expect(buffer.readUInt16LE(0)).toBe(0);
  expect(buffer.readUInt16LE(2)).toBe(1);
  const count = buffer.readUInt16LE(4);
  const entries: IcoEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const tableOffset = 6 + index * 16;
    const rawWidth = buffer.readUInt8(tableOffset);
    const rawHeight = buffer.readUInt8(tableOffset + 1);
    const width = rawWidth === 0 ? 256 : rawWidth;
    const height = rawHeight === 0 ? 256 : rawHeight;
    expect(height).toBe(width);
    const byteLength = buffer.readUInt32LE(tableOffset + 8);
    const imageOffset = buffer.readUInt32LE(tableOffset + 12);
    entries.push({
      size: width,
      bytes: buffer.subarray(imageOffset, imageOffset + byteLength),
    });
  }
  return entries;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  expect(buffer.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(buffer.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

describe("WhiteLily assisted Windows installer configuration", () => {
  it("pins one unsigned per-user x64 NSIS product and upgrade identity", async () => {
    const desktopPackage = await readDesktopPackage();
    const build = desktopPackage.build;

    expect(desktopPackage).toMatchObject({
      productName: "WhiteLily",
      version: "0.2.0-beta.1",
      main: "dist/main/main.js",
    });
    expect(build).toMatchObject({
      appId: "io.github.qingningmneg.whitelily",
      productName: "WhiteLily",
      forceCodeSigning: false,
      disableDefaultIgnoredFiles: true,
      win: {
        target: [{ target: "nsis", arch: ["x64"] }],
        requestedExecutionLevel: "asInvoker",
        signExecutable: false,
      },
      nsis: {
        guid: "dc0622a7-44a0-5754-9d1a-deb3725832ce",
        oneClick: false,
        perMachine: false,
        selectPerMachineByDefault: false,
        allowElevation: false,
        allowToChangeInstallationDirectory: false,
        packElevateHelper: false,
        artifactName: "WhiteLily-${version}-windows-x64-setup.${ext}",
        deleteAppDataOnUninstall: false,
      },
    });
  });

  it("uses stable icons, shortcuts, hooks, ASAR, and the prepared resource boundary", async () => {
    const build = (await readDesktopPackage()).build;

    expect(build).toMatchObject({
      directories: {
        buildResources: "build",
        output: "../../build/electron-installer",
      },
      asar: true,
      afterPack: "apps/desktop/build/after-pack.cjs",
      files: [
        "package.json",
        "!node_modules{,/**/*}",
        {
          from: "../../build/electron-bundle/desktop/main",
          to: "dist/main",
          filter: ["**/*"],
        },
        {
          from: "../../build/electron-bundle/desktop/preload",
          to: "dist/preload",
          filter: ["**/*"],
        },
        {
          from: "../../build/electron-bundle/desktop/renderer",
          to: "dist-renderer",
          filter: ["**/*"],
        },
      ],
      extraResources: [
        { from: "../../build/electron-bundle/core", to: "core", filter: ["**/*"] },
        { from: "../../build/electron-bundle/codex", to: "codex", filter: ["**/*"] },
        { from: "../../build/electron-bundle/licenses", to: "licenses", filter: ["**/*"] },
        {
          from: "../../build/electron-bundle/runtime-manifest.json",
          to: "runtime-manifest.json",
        },
      ],
      win: { icon: "build/icon.ico" },
      nsis: {
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: "WhiteLily",
        include: "../../packaging/nsis/installer.nsh",
        installerIcon: "build/icon.ico",
        uninstallerIcon: "build/icon.ico",
      },
    });
    expect(build?.asarUnpack).toBeUndefined();
    expect(build?.files).not.toContainEqual({
      from: "package.json",
      to: "package.json",
    });
    expect(build?.extraResources).toContainEqual({
      from: "../../build/electron-bundle/codex",
      to: "codex",
      filter: ["**/*"],
    });
  });

  it("loads the committed verifier through one fixed project-local afterPack wrapper", async () => {
    const build = (await readDesktopPackage()).build;
    const wrapper = await readFile(afterPackWrapperPath, "utf8");

    expect(resolve(repositoryRoot, build?.afterPack ?? "")).toBe(afterPackWrapperPath);
    expect(wrapper).toBe(
      '"use strict";\n\nconst { resolve } = require("node:path");\nconst verifier = require("../../../packaging/electron/after-pack.cjs");\n\nmodule.exports = (context) =>\n  verifier.materializePreparedNodeModulesAndVerify(\n    context,\n    resolve(__dirname, "../../../build/electron-bundle"),\n  );\n',
    );
  });

  it("bundles every non-Electron main-process runtime dependency into app.asar", async () => {
    const viteConfig = await readFile(viteConfigPath, "utf8");

    expect(viteConfig).toMatch(
      /if \(mode === "main"\) \{[\s\S]*?ssr:\s*\{\s*noExternal:\s*true,?\s*\}[\s\S]*?build:/u,
    );
  });

  it("forces the assisted installer to the current user without a directory chooser", async () => {
    const installer = await readFile(installerIncludePath, "utf8");

    expect(installer).toMatch(
      /!macro\s+customInstallMode[\s\S]*?StrCpy\s+\$isForceCurrentInstall\s+"1"/u,
    );
    expect(installer).toContain(
      '!include "${PROJECT_DIR}\\..\\..\\packaging\\nsis\\uninstaller.nsh"',
    );
    expect(installer).not.toMatch(/RequestExecutionLevel\s+(?:admin|highest)/iu);
  });

  it("resets INSTDIR after electron-builder mode and /D processing and before installation", async () => {
    const [installer, installerTemplate, assistedTemplate] = await Promise.all([
      readFile(installerIncludePath, "utf8"),
      readFile(join(electronBuilderNsisTemplateRoot, "installer.nsi"), "utf8"),
      readFile(join(electronBuilderNsisTemplateRoot, "assistedInstaller.nsh"), "utf8"),
    ]);

    expect(installer).toMatch(
      /!macro\s+WhiteLilySetFixedInstallDirectory[\s\S]*?StrCpy\s+\$INSTDIR\s+"\$LOCALAPPDATA\\Programs\\WhiteLily"/u,
    );
    expect(installer).toMatch(
      /!macro\s+customInit[\s\S]*?!insertmacro\s+WhiteLilySetFixedInstallDirectory/u,
    );
    expect(installer).toMatch(
      /!macro\s+customPageAfterChangeDir[\s\S]*?Page\s+custom\s+WhiteLilyEnforceInstallDirectory/u,
    );
    expect(installer).toMatch(
      /Function\s+WhiteLilyEnforceInstallDirectory[\s\S]*?!insertmacro\s+WhiteLilySetFixedInstallDirectory[\s\S]*?Abort[\s\S]*?FunctionEnd/u,
    );
    expect(installerTemplate.indexOf("!insertmacro initMultiUser")).toBeLessThan(
      installerTemplate.indexOf("!insertmacro customInit"),
    );
    expect(assistedTemplate.indexOf("!insertmacro customPageAfterChangeDir")).toBeLessThan(
      assistedTemplate.indexOf("!insertmacro MUI_PAGE_INSTFILES"),
    );
  });
});

describe("WhiteLily uninstall data safety", () => {
  it("keeps data by default and permits deletion only after an interactive explicit choice", async () => {
    const [installer, uninstaller] = await Promise.all([
      readFile(installerIncludePath, "utf8"),
      readFile(uninstallerIncludePath, "utf8"),
    ]);

    expect(installer).not.toContain('!include "StrContains.nsh"');
    expect(installer).not.toContain('!include "StrFunc.nsh"');
    expect(uninstaller).toContain("Var WhiteLilyUnStrHaystack");
    expect(uninstaller).toContain("Var WhiteLilyUnStrNeedle");
    expect(uninstaller).toMatch(/Function\s+un\.StrContains[\s\S]*?FunctionEnd/u);
    expect(uninstaller).toMatch(
      /!macro\s+_UnStrContainsConstructor\s+OUT\s+NEEDLE\s+HAYSTACK[\s\S]*?Call\s+un\.StrContains/u,
    );
    expect(uninstaller).not.toMatch(/!insertmacro\s+MUI_HEADER_TEXT/u);
    expect(uninstaller).not.toContain("${StrContains}");
    expect(uninstaller.match(/\$\{UnStrContains\}/gu)).toHaveLength(7);
    expect(uninstaller).toContain("卸载程序文件后，如何处理 WhiteLily 数据？");
    expect(uninstaller).toContain("保留 WhiteLily 数据（推荐）");
    expect(uninstaller).toContain("删除 WhiteLily 数据");
    expect(uninstaller).not.toMatch(/[鏁鍗淇鍒锛]/u);
    expect(uninstaller).toMatch(
      /!macro\s+customUnInit[\s\S]*?StrCpy\s+\$WhiteLilyDataChoice\s+"keep_data"/u,
    );
    expect(uninstaller).toMatch(
      /BM_GETCHECK[\s\S]*?BST_CHECKED[\s\S]*?StrCpy\s+\$WhiteLilyDataChoice\s+"delete_data"/u,
    );
    expect(uninstaller).toMatch(
      /!macro\s+customUnInstall[\s\S]*?\$WhiteLilyDataChoice\s+==\s+"delete_data"[\s\S]*?\$\{IfNot\}\s+\$\{Silent\}/u,
    );
    expect(uninstaller).not.toMatch(/--delete-app-data/iu);
  });

  it("canonicalizes and compares the exact data root before the only recursive delete", async () => {
    const uninstaller = await readFile(uninstallerIncludePath, "utf8");
    const recursiveDeletes = uninstaller
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^RMDir\s+\/r\b/iu.test(line));

    expect(uninstaller).toContain('StrCpy $WhiteLilyExpectedDataRoot "$LOCALAPPDATA\\WhiteLily"');
    expect(uninstaller).toContain(
      'GetFullPathName $WhiteLilyCanonicalDeleteTarget "$WhiteLilyDeleteTarget"',
    );
    expect(uninstaller).toContain(
      'GetFullPathName $WhiteLilyCanonicalExpectedRoot "$WhiteLilyExpectedDataRoot"',
    );
    expect(uninstaller).toMatch(
      /StrCmp\s+\$WhiteLilyCanonicalDeleteTarget\s+\$WhiteLilyCanonicalExpectedRoot/u,
    );
    for (const dangerousFragment of ['"*"', '"?"', '"%"', '"\\\\"', '"\\..\\"', '"/../"']) {
      expect(uninstaller).toContain(dangerousFragment);
    }
    expect(recursiveDeletes).toEqual(['RMDir /r "$WhiteLilyCanonicalDeleteTarget"']);
  });

  it("guards the real target and LOCALAPPDATA handles against reparse-point deletion", async () => {
    const uninstaller = await readFile(uninstallerIncludePath, "utf8");
    const deleteOffset = uninstaller.indexOf('RMDir /r "$WhiteLilyCanonicalDeleteTarget"');
    const guard = uninstaller.slice(0, deleteOffset);

    expect(deleteOffset).toBeGreaterThan(0);
    expect(guard).toContain("FILE_ATTRIBUTE_REPARSE_POINT");
    expect(guard).toMatch(
      /GetFileAttributesW\(w "\$WhiteLilyCanonicalDeleteTarget"\)[\s\S]*?FILE_ATTRIBUTE_REPARSE_POINT[\s\S]*?Return/u,
    );
    expect(guard).toMatch(
      /GetFileAttributesW\(w "\$LOCALAPPDATA"\)[\s\S]*?FILE_ATTRIBUTE_REPARSE_POINT[\s\S]*?Return/u,
    );
    expect(guard.match(/CreateFileW\(/gu)).toHaveLength(2);
    expect(guard.match(/GetFinalPathNameByHandleW\(/gu)).toHaveLength(2);
    expect(guard.match(/CloseHandle\(/gu)).toHaveLength(2);
    expect(guard).toMatch(
      /GetFinalPathNameByHandleW\([\s\S]*?StrCpy\s+\$WhiteLilyResolvedExpectedRoot\s+"\$WhiteLilyResolvedLocalAppData\\WhiteLily"[\s\S]*?StrCmp\s+\$WhiteLilyResolvedDeleteTarget\s+\$WhiteLilyResolvedExpectedRoot/u,
    );
  });

  it("accepts only the exact canonical current-user data root", async () => {
    const appPaths = (await import("../../apps/desktop/src-main/appPaths.js")) as Record<
      string,
      unknown
    >;
    const resolveDeletionTarget = appPaths.resolveInstallerDataDeletionTarget;
    expect(resolveDeletionTarget).toBeTypeOf("function");
    if (typeof resolveDeletionTarget !== "function") return;

    const localAppData = String.raw`C:\Users\Owner\AppData\Local`;
    expect(
      resolveDeletionTarget(localAppData, String.raw`C:\Users\Owner\AppData\Local\WhiteLily`),
    ).toBe(String.raw`C:\Users\Owner\AppData\Local\WhiteLily`);
    expect(
      resolveDeletionTarget(localAppData, String.raw`c:\users\owner\appdata\local\WHITELILY`),
    ).toBe(String.raw`C:\Users\Owner\AppData\Local\WhiteLily`);

    for (const target of [
      "",
      localAppData,
      String.raw`C:\Users\Owner\AppData\Local\WhiteLily\memory`,
      String.raw`C:\Users\Owner\AppData\Local\WhiteLily\..\Other`,
      String.raw`C:\Users\Owner\AppData\Local\Temporary\..\WhiteLily`,
      String.raw`C:\Users\Owner\AppData\Local\White*`,
      String.raw`C:\Users\Owner\AppData\Local\White?ily`,
      String.raw`%LOCALAPPDATA%\WhiteLily`,
      String.raw`\\server\share\WhiteLily`,
      String.raw`C:\Users\Other\AppData\Local\WhiteLily`,
    ]) {
      expect(() => resolveDeletionTarget(localAppData, target), target).toThrow(
        "exact WhiteLily data root",
      );
    }
  });

  it("derives the fixed per-user program and data paths from LOCALAPPDATA", async () => {
    const appPaths = (await import("../../apps/desktop/src-main/appPaths.js")) as Record<
      string,
      unknown
    >;
    const resolveProgramPath = appPaths.resolveInstallerProgramPath;
    const resolvePaths = appPaths.resolveAppPaths;
    expect(resolveProgramPath).toBeTypeOf("function");
    expect(resolvePaths).toBeTypeOf("function");
    if (typeof resolveProgramPath !== "function" || typeof resolvePaths !== "function") return;

    const localAppData = String.raw`C:\Users\Owner\AppData\Local`;
    expect(resolveProgramPath(localAppData)).toBe(
      String.raw`C:\Users\Owner\AppData\Local\Programs\WhiteLily`,
    );
    expect(resolvePaths(localAppData)).toMatchObject({
      dataRoot: String.raw`C:\Users\Owner\AppData\Local\WhiteLily`,
    });
  });
});

describe("WhiteLily installer branding", () => {
  it("keeps one wordless editable vector mark on a deep teal field", async () => {
    const svg = await readFile(svgPath, "utf8");

    expect(svg).toContain('viewBox="0 0 256 256"');
    expect(svg.toLowerCase()).toContain("#0b3b3c");
    expect(svg).toMatch(/<(?:path|ellipse)\b/u);
    expect(svg).not.toMatch(/<(?:text|image)\b/iu);
  });

  it("contains exact 16 through 256 pixel PNG layers in the ICO", async () => {
    const entries = readIcoEntries(await readFile(icoPath));

    expect(entries.map((entry) => entry.size)).toEqual([16, 24, 32, 48, 64, 128, 256]);
    for (const entry of entries) {
      expect(readPngDimensions(entry.bytes)).toEqual({
        width: entry.size,
        height: entry.size,
      });
    }
  });
});
