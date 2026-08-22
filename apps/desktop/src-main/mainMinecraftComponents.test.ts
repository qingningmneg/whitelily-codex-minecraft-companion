// @vitest-environment node

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDesktopMinecraftComponentResources } from "./main.js";

describe("desktop Minecraft component composition", () => {
  it("supplies only reviewed fixed resource, presence, and manifest authority from main", () => {
    const dataRoot = String.raw`X:\WhiteLilyTestData`;
    const resourcesPath = String.raw`X:\WhiteLilyTestApp\resources`;
    const authority = resolveDesktopMinecraftComponentResources({
      appPath: String.raw`X:\WhiteLilyTestApp\resources\app.asar`,
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
          fileName: "whitelily-bridge-fabric-1.21.5-0.1.2.jar",
          bytes: 53_984,
          sha256: "ac5bfab545b723b2346aeb017b3a6ea3186a6cbced370e16097f3836b128746d",
          modId: "whitelily_bridge",
          version: "0.1.2",
          prior: [
            {
              fileName: "whitelily-bridge-fabric-1.21.5-0.1.1.jar",
              bytes: 52_087,
              sha256: "8a6e00d47a28799798ffa5d561156ea7ceb0f697a0beb2cc7c55b34f6f81b514",
              modId: "whitelily_bridge",
              version: "0.1.1",
            },
            {
              fileName: "whitelily-bridge-fabric-1.21.5-0.1.0.jar",
              bytes: 51_837,
              sha256: "380721d28236f5ad8206fd8d69af1e5629d741e9d38ec27c26c052c95266b6ce",
              modId: "whitelily_bridge",
              version: "0.1.0",
            },
          ],
        },
        {
          component: "avatar",
          fileName: "whitelily-avatar-fabric-1.21.5-0.1.1.jar",
          bytes: 257_936,
          sha256: "11a4375fada69928a4d1e0d8f6d330bc35ba23ab99c8b8e4c444eaa69f3a9271",
          modId: "whitelily_avatar",
          version: "0.1.1",
          prior: [
            {
              fileName: "whitelily-avatar-fabric-1.21.5-0.1.0.jar",
              bytes: 239_985,
              sha256: "1fdba2b89281d7dbfb96d8e2ab3637caf95b20452831377f46e5285d37531351",
              modId: "whitelily_avatar",
              version: "0.1.0",
            },
          ],
        },
        {
          component: "avatar",
          fileName: "fabric-api-0.128.2+1.21.5.jar",
          bytes: 2_248_994,
          sha256: "a82fd00827206e911936ed1e0ceaec6eb55d061ca5d3c5d63c7f0031426d29ae",
          modId: "fabric-api",
          version: "0.128.2+1.21.5",
          prior: [],
        },
      ],
    });
    expect(Object.isFrozen(authority.manifest)).toBe(true);
    expect(JSON.stringify(authority)).not.toMatch(/candidate|renderer|pathToMods|pid|port/iu);
  });
});
