// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "vite";
import { expect, it } from "vitest";

it("runs the built preload with only sandbox-approved module access", async () => {
  const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "whitelily-preload-"));
  const outDir = join(temporaryRoot, "preload");

  try {
    await build({
      root: desktopRoot,
      configFile: join(desktopRoot, "vite.config.ts"),
      mode: "preload",
      build: { outDir },
    });

    const bundle = await readFile(join(outDir, "preload.cjs"), "utf8");
    let exposedName: string | undefined;
    let exposedApi: unknown;
    const electron = {
      contextBridge: {
        exposeInMainWorld(name: string, api: unknown) {
          exposedName = name;
          exposedApi = api;
        },
      },
      ipcRenderer: {
        invoke: async () => undefined,
        on: () => undefined,
        removeListener: () => undefined,
      },
    };

    vm.runInNewContext(bundle, {
      Buffer,
      URL,
      TextDecoder,
      TextEncoder,
      clearImmediate,
      clearTimeout,
      console,
      process,
      require: (moduleId: string) => {
        if (moduleId === "electron") return electron;
        throw new Error(`sandboxed preload cannot require ${moduleId}`);
      },
      setImmediate,
      setTimeout,
      structuredClone,
    });

    expect(exposedName).toBe("whiteLily");
    expect(exposedApi).toEqual(
      expect.objectContaining({
        detectLanCandidates: expect.any(Function),
        getMinecraftComponentStatus: expect.any(Function),
        installMinecraftComponents: expect.any(Function),
        removeMinecraftComponents: expect.any(Function),
        readOwnerIdentity: expect.any(Function),
        updateOwnerIdentity: expect.any(Function),
        subscribeOwnerIdentity: expect.any(Function),
        subscribeRuntime: expect.any(Function),
      }),
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
