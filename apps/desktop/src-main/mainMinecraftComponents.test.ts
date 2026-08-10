// @vitest-environment node

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDesktopMinecraftComponentResources } from "./main.js";

describe("desktop Minecraft component composition", () => {
  it("supplies only reviewed fixed resource, presence, and manifest authority from main", () => {
    const dataRoot = String.raw`C:\Users\Current\AppData\Local\WhiteLily`;
    const resourcesPath = String.raw`C:\Program Files\WhiteLily\resources`;
    const authority = resolveDesktopMinecraftComponentResources({
      appPath: String.raw`C:\Program Files\WhiteLily\resources\app.asar`,
      resourcesPath,
      dataRoot,
      development: false,
    });

    expect(authority.resourceDirectory).toBe(resolve(resourcesPath, "minecraft-components"));
    expect(authority.presenceDirectory).toBe(resolve(dataRoot, "bridge", "presence"));
    expect(authority.manifest).toEqual({
      schemaVersion: 1,
      minecraftVersion: "1.21.5",
      artifacts: [
        {
          component: "bridge",
          fileName: "whitelily-bridge-fabric-1.21.5-0.1.0.jar",
          bytes: 51_837,
          sha256: "380721d28236f5ad8206fd8d69af1e5629d741e9d38ec27c26c052c95266b6ce",
          modId: "whitelily_bridge",
          version: "0.1.0",
          prior: [],
        },
        {
          component: "avatar",
          fileName: "whitelily-avatar-fabric-1.21.5-0.1.0.jar",
          bytes: 52_550,
          sha256: "f27dce8e9f13a1058b59d97cbeff1d36d567bbabf59e4de16f6e2d7c33e5d7c3",
          modId: "whitelily_avatar",
          version: "0.1.0",
          prior: [],
        },
        {
          component: "avatar",
          fileName: "fabric-api-0.128.2+1.21.5.jar",
          bytes: 2_243_253,
          sha256: "4aed9b9da68307bb3fc69ef5ed54be6caa9a07ac1d07cb7fd374acb9914a01b5",
          modId: "fabric-api",
          version: "0.128.2+1.21.5",
          prior: [],
        },
        {
          component: "avatar",
          fileName: "geckolib-fabric-1.21.5-5.1.0.jar",
          bytes: 698_651,
          sha256: "8d13e1c1f2317fc2d4c235cd8654fce6b7720252d5f310d65262cb72075b8eb4",
          modId: "geckolib",
          version: "5.1.0",
          prior: [],
        },
      ],
    });
    expect(Object.isFrozen(authority.manifest)).toBe(true);
    expect(JSON.stringify(authority)).not.toMatch(/candidate|renderer|pathToMods|pid|port/iu);
  });
});
