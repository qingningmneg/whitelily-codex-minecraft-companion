import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Material,
  Mesh,
  Object3D,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/** Research-only legacy preview mapping; never crosses the production IPC boundary. */
interface AvatarBoneMapping {
  readonly head: string;
  readonly neck: string;
  readonly chest: string;
  readonly hips: string;
  readonly leftUpperArm: string;
  readonly leftLowerArm: string;
  readonly leftHand: string;
  readonly rightUpperArm: string;
  readonly rightLowerArm: string;
  readonly rightHand: string;
  readonly leftUpperLeg: string;
  readonly leftLowerLeg: string;
  readonly leftFoot: string;
  readonly rightUpperLeg: string;
  readonly rightLowerLeg: string;
  readonly rightFoot: string;
}

const PREVIEW_SIZE = 512;

export interface AvatarPreviewCameraFrame {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly near: number;
  readonly far: number;
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

export function calculateAvatarPreviewCamera(
  bounds: Box3,
  anchors: { readonly hipsY: number; readonly headY: number },
): AvatarPreviewCameraFrame {
  const values = [
    bounds.min.x,
    bounds.min.y,
    bounds.min.z,
    bounds.max.x,
    bounds.max.y,
    bounds.max.z,
    anchors.hipsY,
    anchors.headY,
  ];
  if (bounds.isEmpty() || values.some((value) => !Number.isFinite(value))) {
    throw new Error("avatar preview bounds are invalid");
  }
  const size = bounds.getSize(new Vector3());
  if (size.x <= 0 || size.y <= 0 || size.z < 0) {
    throw new Error("avatar preview bounds are invalid");
  }
  const centerX = (bounds.min.x + bounds.max.x) / 2;
  const centerY = (anchors.hipsY + anchors.headY) / 2;
  const centerZ = (bounds.min.z + bounds.max.z) / 2;
  const halfHeight = rounded(Math.max(size.x / 2, size.y / 2) * 1.08);
  const positionZ = rounded(bounds.max.z + Math.max(size.x, size.y, size.z) * 2);
  return Object.freeze({
    left: -halfHeight,
    right: halfHeight,
    top: halfHeight,
    bottom: -halfHeight,
    near: 0.01,
    far: rounded(Math.max(40, (positionZ - bounds.min.z) * 4)),
    position: Object.freeze([rounded(centerX), rounded(centerY), positionZ] as const),
    target: Object.freeze([rounded(centerX), rounded(centerY), rounded(centerZ)] as const),
  });
}

export function disposeAvatarScene(root: Object3D): void {
  const disposedTextures = new Set<Texture>();
  const disposedMaterials = new Set<Material>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (disposedMaterials.has(material)) continue;
      disposedMaterials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture && !disposedTextures.has(value)) {
          disposedTextures.add(value);
          value.dispose();
        }
      }
      material.dispose();
    }
  });
}

interface PreviewRenderRequest {
  readonly kind: "render";
  readonly bytes: ArrayBuffer;
  readonly mapping: AvatarBoneMapping;
}

function startPreviewPort(port: MessagePort): void {
  let activeScene: Object3D | undefined;
  let renderer: WebGLRenderer | undefined;
  port.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (isCapturedMessage(event.data)) {
      if (activeScene !== undefined) disposeAvatarScene(activeScene);
      renderer?.dispose();
      activeScene = undefined;
      renderer = undefined;
      return;
    }
    if (!isRenderRequest(event.data)) return;
    void renderRequest(event.data)
      .then((result) => {
        activeScene = result.scene;
        renderer = result.renderer;
        port.postMessage({ kind: "rendered", width: PREVIEW_SIZE, height: PREVIEW_SIZE });
      })
      .catch(() => {
        port.postMessage({ kind: "error", code: "AVATAR_PREVIEW_FAILED" });
      });
  });
  port.start();
  port.postMessage({ kind: "ready" });
}

async function renderRequest(request: PreviewRenderRequest): Promise<{
  readonly scene: Object3D;
  readonly renderer: WebGLRenderer;
}> {
  const gltf = await new Promise<Awaited<ReturnType<GLTFLoader["parseAsync"]>>>(
    (resolve, reject) => {
      new GLTFLoader().parse(request.bytes, "", resolve, reject);
    },
  );
  const avatar = gltf.scene;
  const hips = avatar.getObjectByName(request.mapping.hips);
  const head = avatar.getObjectByName(request.mapping.head);
  if (hips === undefined || head === undefined)
    throw new Error("avatar preview anchors are missing");
  avatar.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(avatar);
  const hipsPosition = hips.getWorldPosition(new Vector3());
  const headPosition = head.getWorldPosition(new Vector3());
  const frame = calculateAvatarPreviewCamera(bounds, {
    hipsY: hipsPosition.y,
    headY: headPosition.y,
  });
  const camera = new OrthographicCamera(
    frame.left,
    frame.right,
    frame.top,
    frame.bottom,
    frame.near,
    frame.far,
  );
  camera.position.set(...frame.position);
  camera.lookAt(...frame.target);

  const scene = new Scene();
  scene.background = null;
  scene.add(avatar);
  scene.add(new AmbientLight(new Color(0xffffff), 1.2));
  const key = new DirectionalLight(new Color(0xfff7f0), 2.2);
  key.position.set(3, 5, 6);
  scene.add(key);
  const fill = new DirectionalLight(new Color(0xdde8ff), 1.1);
  fill.position.set(-4, 2, 3);
  scene.add(fill);
  const rim = new DirectionalLight(new Color(0xffffff), 0.8);
  rim.position.set(0, 4, -4);
  scene.add(rim);

  const canvas = document.querySelector<HTMLCanvasElement>("#avatar-preview");
  if (canvas === null) throw new Error("avatar preview canvas is missing");
  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(PREVIEW_SIZE, PREVIEW_SIZE, false);
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);
  return { scene, renderer };
}

function isRenderRequest(value: unknown): value is PreviewRenderRequest {
  if (!isPlainObject(value) || value.kind !== "render" || !(value.bytes instanceof ArrayBuffer)) {
    return false;
  }
  const mapping = value.mapping;
  if (!isPlainObject(mapping)) return false;
  return [
    "head",
    "neck",
    "chest",
    "hips",
    "leftUpperArm",
    "leftLowerArm",
    "leftHand",
    "rightUpperArm",
    "rightLowerArm",
    "rightHand",
    "leftUpperLeg",
    "leftLowerLeg",
    "leftFoot",
    "rightUpperLeg",
    "rightLowerLeg",
    "rightFoot",
  ].every((key) => typeof mapping[key] === "string");
}

function isCapturedMessage(value: unknown): boolean {
  return isPlainObject(value) && value.kind === "captured";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

if (typeof window !== "undefined") {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (
      !isPlainObject(event.data) ||
      event.data.kind !== "whitelily-avatar-preview-port" ||
      event.ports[0] === undefined
    ) {
      return;
    }
    startPreviewPort(event.ports[0]);
  });
}
