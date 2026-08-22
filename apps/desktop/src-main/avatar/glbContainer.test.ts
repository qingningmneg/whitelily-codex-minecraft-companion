import { describe, expect, it } from "vitest";
import { createGlbFixture } from "./__fixtures__/createGlbFixture.js";
import { parseGlbContainer } from "./glbContainer.js";

describe("parseGlbContainer", () => {
  it.each([
    ["plain self-contained GLB", "glb", "glb", undefined],
    ["VRM 0.x", "vrm0", "vrm", "0.x"],
    ["VRM 1.0", "vrm1", "vrm", "1.0"],
  ] as const)("accepts %s", (_name, fixtureFormat, format, vrmVersion) => {
    const parsed = parseGlbContainer(createGlbFixture({ format: fixtureFormat }));

    expect(parsed.format).toBe(format);
    expect(parsed.vrmVersion).toBe(vrmVersion);
    expect(parsed.binaryChunk.byteLength).toBe(1_068);
    expect(parsed.json.nodes).toHaveLength(17);
  });

  it.each([
    ["wrong magic", { magic: "NOPE" }, "AVATAR_GLB_INVALID"],
    ["remote image", { imageUri: "https://example.test/skin.png" }, "AVATAR_EXTERNAL_RESOURCE"],
    ["data image", { imageUri: "data:image/png;base64,AA==" }, "AVATAR_EXTERNAL_RESOURCE"],
    ["external buffer", { bufferUri: "body.bin" }, "AVATAR_EXTERNAL_RESOURCE"],
    ["out-of-range accessor", { invalidAccessorBounds: true }, "AVATAR_GLB_INVALID"],
    ["out-of-range material", { invalidMaterialIndex: true }, "AVATAR_GLB_INVALID"],
    ["conflicting VRM version", { format: "vrm1", vrmSpecVersion: "0.0" }, "AVATAR_GLB_INVALID"],
    ["too many nodes", { nodeCount: 4_097 }, "AVATAR_GLB_INVALID"],
  ] as const)("rejects %s with a stable code", (_name, options, code) => {
    expect(() => parseGlbContainer(createGlbFixture(options))).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("does not trust a forged total length", () => {
    const fixture = createGlbFixture();
    fixture.writeUInt32LE(fixture.length - 4, 8);

    expect(() => parseGlbContainer(fixture)).toThrow(
      expect.objectContaining({ code: "AVATAR_GLB_INVALID" }),
    );
  });
});
