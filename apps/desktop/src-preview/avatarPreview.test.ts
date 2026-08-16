import { Box3, BufferGeometry, Mesh, MeshStandardMaterial, Texture, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { calculateAvatarPreviewCamera, disposeAvatarScene } from "./avatarPreview.js";

describe("avatar preview scene", () => {
  it("derives a deterministic square orthographic camera with eight percent margin", () => {
    const frame = calculateAvatarPreviewCamera(
      new Box3(new Vector3(-1, 0, -0.5), new Vector3(1, 4, 0.5)),
      { hipsY: 1, headY: 3 },
    );

    expect(frame).toEqual({
      left: -2.16,
      right: 2.16,
      top: 2.16,
      bottom: -2.16,
      near: 0.01,
      far: 40,
      position: [0, 2, 8.5],
      target: [0, 2, 0],
    });
  });

  it("rejects an empty or non-finite avatar bounds", () => {
    expect(() => calculateAvatarPreviewCamera(new Box3(), { hipsY: 0, headY: 1 })).toThrow(
      "avatar preview bounds are invalid",
    );
    expect(() =>
      calculateAvatarPreviewCamera(
        new Box3(new Vector3(0, 0, 0), new Vector3(Number.POSITIVE_INFINITY, 1, 1)),
        { hipsY: 0, headY: 1 },
      ),
    ).toThrow("avatar preview bounds are invalid");
  });

  it("disposes geometry, materials, and textures after capture", () => {
    const texture = new Texture();
    const geometry = new BufferGeometry();
    const material = new MeshStandardMaterial({ map: texture });
    const disposeTexture = vi.spyOn(texture, "dispose");
    const disposeGeometry = vi.spyOn(geometry, "dispose");
    const disposeMaterial = vi.spyOn(material, "dispose");
    const mesh = new Mesh(geometry, material);

    disposeAvatarScene(mesh);

    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
  });
});
