# 人物模型库、导入与安全热切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 WhiteLily 桌面端建立与 ChatGPT AI 模型设置完全分离的人物模型库，支持两个内置人物模型、VRM/GLB 安全导入、固定高度横向模型轨道，以及不重启桌面端或 Minecraft 的可回滚热切换。

**Architecture:** Electron 主进程是目录、受管理文件、导入事务、预览和全局选择的唯一权威；React 只通过类型化 preload API 读取投影和发起“选择文件/切换”意图。桌面端与 Fabric 客户端通过 `%LOCALAPPDATA%/WhiteLily/bridge/avatar-model/` 下的原子 JSON 请求/状态邮箱完成 `prepare → ready → commit → visible-frame-committed` 协议，Fabric 侧用 `WhiteLilyAvatarRenderBackend` 隔离经典 GeckoLib 后端和平滑蒙皮 GLB 后端，任何候选失败都保留旧活动会话。

**Tech Stack:** TypeScript 7、Node.js 24、Zod 4、React 19、Electron 43、Vite 8、Vitest 4、Three.js 0.180.0、Java 21、Minecraft 1.21.5、Fabric Loader 0.16.14、Fabric API 0.128.2+1.21.5、GeckoLib 5.1.0、JUnit 5.12.2。

## Global Constraints

- Node.js 必须为 `>=24.0.0`，npm 必须为 `>=11.0.0`；TypeScript 固定使用 7.x 严格模式。
- Java 固定为 21；Minecraft 固定为 1.21.5；Fabric Loader 固定为 0.16.14；Fabric API 固定为 0.128.2+1.21.5；GeckoLib 固定为 5.1.0。
- 新人物系统必须命名为 `AvatarModelCatalog`、`AvatarModelPage` 等，不得复用或改写 `src/codex/modelCatalog.ts`、`apps/desktop/src/pages/ModelPage.tsx` 所代表的 ChatGPT AI 模型语义。
- Electron 数据根目录保持 `%LOCALAPPDATA%/WhiteLily`；自定义人物模型只能落入 `models/<avatar-model-id>/`，目录记录只保存受管理相对路径，不能保存用户原始绝对路径。
- 内置标识固定为 `builtin:whitelily-hd` 和 `builtin:whitelily-classic`；高清模型永远排第一，经典模型永远排第二，经典模型只能由用户主动选择，不能作为高清模型或自定义模型的自动降级目标。
- 首版只接受 VRM 0.x、VRM 1.0 和自包含 GLB；远程 URI、外部文件 URI、管理目录外资源、损坏缓冲区和缺少必需身体骨骼必须拒绝。
- 全局选择只能在候选模型首个完整可见帧提交成功后持久化；导入、准备帧、桥接、世界切换、资源重载或首帧失败时必须保留旧模型和旧选择。
- 自定义模型复用身体动画和真实手持物；无表情数据时能力为 `neutral-only`；实际盔甲属性继续生效，但不得显示 WhiteLily 专属盔甲附件。
- 模型库保持单行、不换行、固定高度和真实可见横向滚动条；2 个内置加 10 个用户模型必须在 736px 和 360px 内容宽度下可用，页面根节点不得横向溢出或随模型数量增高。
- 第一张卡片必须用 `object-fit: contain` 完整等比显示 `whitelily-turnaround.png`，不得裁剪、拉伸或压扁。
- 人物外观层只能读取 AI/Minecraft 状态，不得修改行动队列、背包、装备、方块、主人身份、世界权限、AI 对话或立即叫停行为。
- 任何渲染异常不得关闭 Minecraft、造成桌面端白屏、阻断 AI 或逐帧刷屏；同一稳定错误码按模型标识和渲染会话限频。

---

### Task 1: 定义人物模型目录和跨进程协议

**Files:**
- Create: `src/avatar/avatarModelTypes.ts`
- Create: `src/avatar/avatarModelSchemas.ts`
- Create: `tests/unit/avatarModelSchemas.test.ts`
- Create: `subprojects/whitelily-avatar/protocol/avatar-model-control-v1.schema.json`
- Create: `subprojects/whitelily-avatar/protocol/fixtures/prepare-request.json`
- Create: `subprojects/whitelily-avatar/protocol/fixtures/ready-state.json`
- Create: `subprojects/whitelily-avatar/protocol/fixtures/committed-state.json`

**Interfaces:**
- Consumes: Zod 4、现有稳定 JSON 协议约定。
- Produces: `AvatarModelId`、`AvatarModelRecord`、`AvatarModelCatalogSnapshot`、`AvatarModelControlRequest`、`AvatarModelControlState`、`parseAvatarModelControlRequest()`、`parseAvatarModelControlState()`。

- [x] **Step 1: 写稳定标识、目录顺序和协议联合类型的失败测试**

```ts
it("accepts the prepare-ready-commit protocol and fixes builtin order", () => {
  const request = parseAvatarModelControlRequest(fixture("prepare-request.json"));
  const state = parseAvatarModelControlState(fixture("ready-state.json"));
  expect(request.operation).toBe("prepare");
  expect(state.phase).toBe("ready");
  expect(BUILTIN_AVATAR_MODEL_IDS).toEqual([
    "builtin:whitelily-hd",
    "builtin:whitelily-classic",
  ]);
});

it.each(["", "../escape", "C:\\outside.glb", "https://host/model.glb"])(
  "rejects an unsafe managed resource path: %s",
  (resourcePath) => expect(() => parseAvatarModelRecord(record({ resourcePath }))).toThrow(),
);
```

- [x] **Step 2: 运行测试并确认红灯**

Run: `npx vitest run tests/unit/avatarModelSchemas.test.ts`

Expected: FAIL，提示无法导入 `src/avatar/avatarModelSchemas.ts`。

- [x] **Step 3: 建立唯一的 TypeScript 协议定义**

```ts
export const BUILTIN_AVATAR_MODEL_IDS = [
  "builtin:whitelily-hd",
  "builtin:whitelily-classic",
] as const;

export type AvatarModelFormat = "builtin-hd" | "builtin-classic" | "vrm" | "glb";
export type AvatarExpressionCapability = "full" | "neutral-only";
export type AvatarBodyAnimationCapability = "whitelily-humanoid-v1";
export type AvatarModelValidationCode =
  | "AVATAR_VALID"
  | "AVATAR_FORMAT_UNSUPPORTED"
  | "AVATAR_GLB_INVALID"
  | "AVATAR_EXTERNAL_RESOURCE"
  | "AVATAR_REQUIRED_BONE_MISSING"
  | "AVATAR_PREVIEW_FAILED"
  | "AVATAR_DIGEST_MISMATCH";

export interface AvatarBoneMapping {
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

export interface AvatarModelRecord {
  readonly id: string;
  readonly displayName: string;
  readonly origin: "builtin" | "imported";
  readonly format: AvatarModelFormat;
  readonly resourcePath: string;
  readonly sha256: string;
  readonly importedAt: string;
  readonly previewPath: string;
  readonly previewStatus: "ready";
  readonly boneMapping: AvatarBoneMapping;
  readonly bodyAnimation: AvatarBodyAnimationCapability;
  readonly expressions: AvatarExpressionCapability;
  readonly validation: { readonly code: "AVATAR_VALID"; readonly validatedAt: string };
}

export interface AvatarModelListItem {
  readonly id: string;
  readonly displayName: string;
  readonly origin: "builtin" | "imported";
  readonly format: AvatarModelFormat;
  readonly previewDataUrl: string;
  readonly bodyAnimation: AvatarBodyAnimationCapability;
  readonly expressions: AvatarExpressionCapability;
}

export interface AvatarModelCatalogSnapshot {
  readonly revision: number;
  readonly models: readonly AvatarModelListItem[];
  readonly activeModelId: string;
  readonly pendingModelId?: string;
}

export interface AvatarRuntimeDescriptor {
  readonly modelId: string;
  readonly origin: "builtin" | "imported";
  readonly format: AvatarModelFormat;
  readonly resourcePath: string;
  readonly sha256: string;
  readonly boneMapping: AvatarBoneMapping;
  readonly bodyAnimation: AvatarBodyAnimationCapability;
  readonly expressions: AvatarExpressionCapability;
}

export type AvatarModelControlRequest =
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly operation: "prepare";
      readonly modelId: string;
      readonly worldSessionId: string;
      readonly candidate: AvatarRuntimeDescriptor;
      readonly issuedAt: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly requestId: string;
      readonly operation: "commit" | "cancel";
      readonly modelId: string;
      readonly worldSessionId: string;
      readonly issuedAt: string;
    };

export interface AvatarModelControlState {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly phase: "preparing" | "ready" | "committed" | "cancelled" | "failed";
  readonly activeModelId: string;
  readonly candidateModelId?: string;
  readonly worldSessionId: string;
  readonly errorCode?: string;
  readonly updatedAt: string;
}
```

控制协议使用同一个 `requestId` 完成三种操作：`prepare` 携带只读 `AvatarRuntimeDescriptor`，`commit` 只引用已 `ready` 的模型，`cancel` 释放尚未提交候选。状态的 `phase` 固定为 `preparing | ready | committed | cancelled | failed`；`committed` 明确表示首个完整可见帧已经成功，而不是仅完成文件加载。

- [x] **Step 4: 写 JSON Schema 与三份跨语言固定夹具并跑绿**

`prepare-request.json` 使用 `requestId: "switch-0001"`、`modelId: "builtin:whitelily-hd"`、`operation: "prepare"`、64 位小写 SHA-256、`worldSessionId: "world-0001"` 和管理目录相对路径 `builtin/whitelily-hd/high.glb`。`ready-state.json` 使用相同请求和世界会话；`committed-state.json` 把 `phase` 改为 `committed` 且 `activeModelId` 为高清内置标识。Schema 设置 `additionalProperties: false`，所有字符串设置最大长度，错误码只接受已声明枚举。

Run: `npx vitest run tests/unit/avatarModelSchemas.test.ts`

Expected: PASS。

- [x] **Step 5: 提交**

```powershell
git add src/avatar tests/unit/avatarModelSchemas.test.ts subprojects/whitelily-avatar/protocol
git commit -m "feat: define avatar model control protocol"
```

### Task 2: 建立受管理目录与全局选择权威

**Files:**
- Create: `apps/desktop/src-main/avatar/avatarModelPaths.ts`
- Create: `apps/desktop/src-main/avatar/avatarModelCatalog.ts`
- Create: `apps/desktop/src-main/avatar/avatarModelCatalog.test.ts`
- Create: `apps/desktop/src-main/avatar/avatarModelPreferences.ts`
- Create: `apps/desktop/src-main/avatar/avatarModelPreferences.test.ts`
- Modify: `apps/desktop/src-main/appPaths.ts`
- Modify: `apps/desktop/src-main/main.ts`

**Interfaces:**
- Consumes: `AppPaths.dataRoot`、`AtomicJsonFile<T>`、Task 1 的模型类型和 schema。
- Produces: `resolveAvatarModelPaths(dataRoot)`、`AvatarModelCatalog.initialize()`、`list()`、`appendImported()`、`resolveRuntimeDescriptor()`、`AvatarModelPreferences.readActiveModelId()`、`commitActiveModelId()`。

- [x] **Step 1: 写内置顺序、导入顺序和损坏选择恢复测试**

```ts
it("restores two builtins first and imported records in committed order", async () => {
  const catalog = await harness.catalog.initialize();
  await catalog.appendImported(imported("user:first", "2026-08-16T08:00:00.000Z"));
  await catalog.appendImported(imported("user:second", "2026-08-16T08:01:00.000Z"));
  expect((await catalog.list()).models.map(({ id }) => id)).toEqual([
    "builtin:whitelily-hd",
    "builtin:whitelily-classic",
    "user:first",
    "user:second",
  ]);
});

it("falls back to builtin HD only when the saved id no longer exists", async () => {
  await harness.writePreferences({ schemaVersion: 1, revision: 3, activeModelId: "user:gone" });
  expect(await harness.preferences.readActiveModelId(harness.catalog)).toBe(
    "builtin:whitelily-hd",
  );
});
```

- [x] **Step 2: 运行红灯**

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarModelCatalog.test.ts src-main/avatar/avatarModelPreferences.test.ts`

Expected: FAIL，缺少目录和偏好类。

- [x] **Step 3: 实现路径边界和原子目录索引**

```ts
export interface AvatarModelPaths {
  readonly root: string;
  readonly catalogPath: string;
  readonly preferencesPath: string;
  readonly stagingRoot: string;
  readonly bridgeRoot: string;
}

export function resolveAvatarModelPaths(dataRoot: string): AvatarModelPaths {
  return Object.freeze({
    root: join(dataRoot, "models"),
    catalogPath: join(dataRoot, "models", "catalog.json"),
    preferencesPath: join(dataRoot, "avatar-model-preferences.json"),
    stagingRoot: join(dataRoot, "models", ".staging"),
    bridgeRoot: join(dataRoot, "bridge", "avatar-model"),
  });
}
```

`AvatarModelCatalog` 通过 `AtomicJsonFile` 保存 `{schemaVersion: 1, revision, imported: AvatarModelRecord[]}`；启动时重新合成两个代码内置记录，不允许索引覆盖内置记录。`appendImported()` 在持有进程内互斥锁时复读索引、拒绝重复 ID、追加并原子写入。扫描时忽略 `.staging`，拒绝 reparse point、符号链接、目录逃逸和摘要不一致的自定义条目，并把错误写入结构化诊断而不是让 Electron 启动白屏。

- [x] **Step 4: 实现只在成功热切换后调用的全局选择提交**

```ts
export class AvatarModelPreferences {
  readActiveModelId(catalog: AvatarModelCatalog): Promise<string>;
  commitActiveModelId(input: {
    expectedRevision: number;
    activeModelId: string;
    committedRequestId: string;
  }): Promise<{ readonly revision: number; readonly activeModelId: string }>;
}
```

偏好文档固定为 schema 1，默认高清内置模型；不得保存数组索引、世界 ID、用户原始路径或 `pendingModelId`。并发修订冲突返回 `AVATAR_PREFERENCE_CONFLICT`，由切换协调器重新读取后决定是否仍需提交。

- [x] **Step 5: 跑测试和桌面主进程类型检查**

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarModelCatalog.test.ts src-main/avatar/avatarModelPreferences.test.ts`

Expected: PASS。

Run: `npm run typecheck --workspace @whitelily/desktop`

Expected: PASS。

- [x] **Step 6: 提交**

```powershell
git add apps/desktop/src-main/appPaths.ts apps/desktop/src-main/main.ts apps/desktop/src-main/avatar
git commit -m "feat: add managed avatar model catalog"
```

### Task 3: 校验 VRM/GLB 并建立原子导入事务

**Files:**
- Create: `apps/desktop/src-main/avatar/glbContainer.ts`
- Create: `apps/desktop/src-main/avatar/glbContainer.test.ts`
- Create: `apps/desktop/src-main/avatar/avatarBoneMapper.ts`
- Create: `apps/desktop/src-main/avatar/avatarBoneMapper.test.ts`
- Create: `apps/desktop/src-main/avatar/avatarModelImporter.ts`
- Create: `apps/desktop/src-main/avatar/avatarModelImporter.test.ts`
- Create: `apps/desktop/src-main/avatar/__fixtures__/createGlbFixture.ts`

**Interfaces:**
- Consumes: Task 1 模型 schema、Task 2 目录与目录追加接口、Node `crypto`/`fs/promises`。
- Produces: `parseGlbContainer(bytes)`、`mapAvatarBones(document)`、`AvatarModelImporter.importFile(sourcePath, displayName)`、`AvatarImportError`。

- [x] **Step 1: 写格式、资源与骨骼安全失败测试**

```ts
it.each([
  ["wrong magic", fixture({ magic: "NOPE" }), "AVATAR_GLB_INVALID"],
  ["remote image", fixture({ imageUri: "https://example.test/skin.png" }), "AVATAR_EXTERNAL_RESOURCE"],
  ["external buffer", fixture({ bufferUri: "body.bin" }), "AVATAR_EXTERNAL_RESOURCE"],
  ["missing hips", fixture({ omitBone: "hips" }), "AVATAR_REQUIRED_BONE_MISSING"],
])("rejects %s without catalog mutation", async (_name, bytes, code) => {
  await harness.writeSource(bytes);
  await expect(harness.import()).rejects.toMatchObject({ code });
  expect((await harness.catalog.list()).models).toHaveLength(2);
  expect(await harness.stagingEntries()).toEqual([]);
});
```

- [x] **Step 2: 运行红灯**

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/glbContainer.test.ts src-main/avatar/avatarBoneMapper.test.ts src-main/avatar/avatarModelImporter.test.ts`

Expected: FAIL，缺少 GLB 解析器和导入器。

- [x] **Step 3: 实现有界 GLB 容器与 glTF 结构校验**

```ts
export interface ParsedGlbContainer {
  readonly json: GltfDocument;
  readonly binaryChunk: Uint8Array;
  readonly format: "vrm" | "glb";
  readonly vrmVersion?: "0.x" | "1.0";
}

export function parseGlbContainer(bytes: Uint8Array): ParsedGlbContainer;
```

固定限制：源文件最多 128 MiB、JSON chunk 最多 8 MiB、节点最多 4096、关节最多 256、材质最多 128、纹理最多 128、图元最多 2048。校验 GLB magic/version/总长度/chunk 对齐、唯一 JSON 与 BIN chunk、bufferView/accessor 范围、索引类型、蒙皮 inverse bind matrix、图片 MIME、材质纹理索引和动画 sampler。只允许无 URI 的单一 BIN buffer及嵌入 bufferView 的图片；任何 `http:`、`https:`、`file:`、`data:`、相对或绝对 URI 都返回 `AVATAR_EXTERNAL_RESOURCE`。

- [x] **Step 4: 实现 VRM 和普通 GLB 的确定性身体骨骼映射**

```ts
export function mapAvatarBones(input: ParsedGlbContainer): {
  readonly mapping: AvatarBoneMapping;
  readonly expressions: AvatarExpressionCapability;
};
```

VRM 1.0 读取 `VRMC_vrm.humanoid.humanBones`，VRM 0.x 读取 `VRM.humanoid.humanBones`。普通 GLB 对规范化节点名按固定优先级映射：精确 `hips/pelvis`、`spine/chest`、`neck`、`head`、左右 `upperarm/lowerarm/hand/upperleg/lowerleg/foot`，再验证祖先层级和静止姿势左右方向；每个语义只能映射一次。缺少任何 `AvatarBoneMapping` 必填项失败；缺少表情扩展或 morph target 时返回 `neutral-only`。

- [x] **Step 5: 实现暂存、摘要、预览前置和无半成品提交**

```ts
export class AvatarModelImporter {
  importFile(input: {
    readonly sourcePath: string;
    readonly displayName: string;
  }): Promise<AvatarModelRecord>;
}
```

导入器先用随机 ID 建立 `.staging/<id>/`，通过已打开文件句柄完成有界读取与 SHA-256，写入规范文件名 `model.vrm` 或 `model.glb`，再调用 Task 4 的 `AvatarPreviewRenderer.render()`。只有模型、`preview.png` 和 `record.json` 全部落盘并复核摘要后，才把暂存目录原子重命名为 `models/<id>/`，最后调用 `catalog.appendImported()`；目录追加失败必须只删除本次新目录。显示名移除控制字符并截断到 80 Unicode 字符；ID 使用 `user:<lowercase-uuid>`。

- [x] **Step 6: 覆盖成功、损坏、缺表情和事务清理并跑绿**

增加测试：VRM 0.x、VRM 1.0、自包含 GLB 成功；`neutral-only` 成功；坏 accessor 越界、重复骨骼、预览失败、重命名失败、目录追加失败；用户删除原文件后受管理副本仍能读取；每种失败均不改变活动模型、偏好或目录顺序。

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/glbContainer.test.ts src-main/avatar/avatarBoneMapper.test.ts src-main/avatar/avatarModelImporter.test.ts`

Expected: PASS。

- [x] **Step 7: 提交**

```powershell
git add apps/desktop/src-main/avatar/glbContainer.ts apps/desktop/src-main/avatar/glbContainer.test.ts apps/desktop/src-main/avatar/avatarBoneMapper.ts apps/desktop/src-main/avatar/avatarBoneMapper.test.ts apps/desktop/src-main/avatar/avatarModelImporter.ts apps/desktop/src-main/avatar/avatarModelImporter.test.ts apps/desktop/src-main/avatar/__fixtures__
git commit -m "feat: import managed VRM and GLB avatars"
```

### Task 4: 用隔离的离屏渲染器生成本地预览

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/src-main/avatar/avatarPreviewRenderer.ts`
- Create: `apps/desktop/src-main/avatar/avatarPreviewRenderer.test.ts`
- Create: `apps/desktop/src-preview/avatarPreview.html`
- Create: `apps/desktop/src-preview/avatarPreview.ts`
- Create: `apps/desktop/src-preview/avatarPreview.test.ts`
- Modify: `apps/desktop/vite.config.ts`
- Modify: `apps/desktop/tsconfig.json`
- Modify: `apps/desktop/src-main/main.ts`

**Interfaces:**
- Consumes: Electron `BrowserWindow` 离屏渲染、Three.js `GLTFLoader`、Task 3 已验证的受管理候选。
- Produces: `AvatarPreviewRenderer.render({modelPath, outputPath, mapping})`、512×512 PNG。

- [x] **Step 1: 安装唯一新增的预览依赖并记录许可证**

Run: `npm install --save-exact three@0.180.0 --workspace @whitelily/desktop && npm install --save-dev --save-exact @types/three@0.180.0 --workspace @whitelily/desktop`

Expected: `package-lock.json` 固定解析版本，`npm ls three @types/three` 无 peer dependency 错误。

- [x] **Step 2: 写“预览失败不能提交模型”和确定性相机测试**

```ts
it("renders a bounded transparent 512px PNG and disposes the hidden window", async () => {
  const result = await harness.renderer.render({
    modelPath: harness.fixturePath,
    outputPath: harness.outputPath,
    mapping: completeBoneMapping(),
  });
  expect(result).toEqual({ width: 512, height: 512, format: "png" });
  expect(await pngSize(harness.outputPath)).toEqual([512, 512]);
  expect(harness.window.destroy).toHaveBeenCalledOnce();
});
```

- [x] **Step 3: 运行红灯**

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarPreviewRenderer.test.ts src-preview/avatarPreview.test.ts`

Expected: FAIL，缺少预览入口和渲染器。

- [x] **Step 4: 实现离屏、无网络、有限时的预览过程**

```ts
export interface AvatarPreviewResult {
  readonly width: 512;
  readonly height: 512;
  readonly format: "png";
}

export class AvatarPreviewRenderer {
  render(input: {
    readonly modelPath: string;
    readonly outputPath: string;
    readonly mapping: AvatarBoneMapping;
  }): Promise<AvatarPreviewResult>;
}
```

主进程建立 `show: false`、`offscreen: true`、`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 的临时窗口；`session.webRequest` 拒绝除打包的 `file:` 页面外全部请求。主进程读取已验证 GLB 为有界 `ArrayBuffer` 后经一次性 MessagePort 传入，不向预览页面暴露文件路径。页面用 `GLTFLoader.parse()`、正交相机、透明背景和固定三点灯光，把角色 hips/head 包围盒居中并留 8% 边距；8 秒超时、WebGL context lost、空包围盒或捕获失败统一抛 `AVATAR_PREVIEW_FAILED`。所有 geometry/material/texture、MessagePort 和 BrowserWindow 在 `finally` 释放。

- [x] **Step 5: 更新 Vite 多入口和打包验证**

`vite.config.ts` 的 renderer 构建加入 `index.html` 与 `src-preview/avatarPreview.html` 两个 HTML 入口；`apps/desktop/tsconfig.json` 的 `include` 加入 `src-preview`，确保预览代码也经过 strict typecheck；`preloadBundle.test.ts` 和新的预览测试断言离屏页面不包含 Node 内置模块、远程 URL 或开发服务器硬编码。

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarPreviewRenderer.test.ts src-preview/avatarPreview.test.ts src-main/preloadBundle.test.ts`

Expected: PASS。

Run: `npm run build --workspace @whitelily/desktop`

Expected: PASS，`apps/desktop/dist-renderer/src-preview/avatarPreview.html` 存在。

- [x] **Step 6: 提交**

```powershell
git add package.json package-lock.json apps/desktop/package.json apps/desktop/vite.config.ts apps/desktop/tsconfig.json apps/desktop/src-main/main.ts apps/desktop/src-main/avatar/avatarPreviewRenderer.ts apps/desktop/src-main/avatar/avatarPreviewRenderer.test.ts apps/desktop/src-preview
git commit -m "feat: render isolated avatar previews"
```

### Task 5: 暴露人物目录、导入和选择的类型化 IPC

**Files:**
- Modify: `apps/desktop/src/desktopApi.ts`
- Modify: `apps/desktop/src/desktopApi.task5.test.ts`
- Modify: `apps/desktop/src-main/ipcRegistry.ts`
- Modify: `apps/desktop/src-main/ipcRegistry.test.ts`
- Modify: `apps/desktop/src-main/main.ts`
- Modify: `apps/desktop/src-main/preloadBundle.test.ts`

**Interfaces:**
- Consumes: `AvatarModelCatalog`、`AvatarModelImporter`、Task 6 的 `AvatarModelSwitchCoordinator` 端口。
- Produces: `listAvatarModels()`、`importAvatarModel()`、`switchAvatarModel(modelId)`、`subscribeAvatarModels()`。

- [x] **Step 1: 写 preload 参数校验、文件选择取消和事件解析失败测试**

```ts
it("never accepts a renderer supplied filesystem path", async () => {
  const api = createWhiteLilyApi(transport);
  await expect(
    (api.importAvatarModel as (...args: unknown[]) => Promise<unknown>)("C:\\secret.glb"),
  ).rejects.toThrow("invalid avatar import input");
});

it("drops malformed avatar catalog events at the preload boundary", () => {
  const listener = vi.fn();
  api.subscribeAvatarModels(listener);
  transport.emit(WHITE_LILY_IPC_CHANNELS.avatarModelsEvent, { activeModelId: 9 });
  expect(listener).not.toHaveBeenCalled();
});
```

- [x] **Step 2: 运行红灯**

Run: `npm run test --workspace @whitelily/desktop -- src/desktopApi.task5.test.ts src-main/ipcRegistry.test.ts src-main/preloadBundle.test.ts`

Expected: FAIL，缺少 avatar IPC channels。

- [x] **Step 3: 扩展 preload API 而不污染 ChatGPT 模型方法**

```ts
export interface WhiteLilyAvatarApi {
  listAvatarModels(): Promise<AvatarModelCatalogSnapshot>;
  importAvatarModel(): Promise<
    | { readonly status: "cancelled" }
    | { readonly status: "imported"; readonly model: AvatarModelListItem }
  >;
  switchAvatarModel(modelId: string): Promise<AvatarModelCatalogSnapshot>;
  subscribeAvatarModels(listener: (snapshot: AvatarModelCatalogSnapshot) => void): () => void;
}
```

新增 channels：`whitelily:list-avatar-models`、`whitelily:import-avatar-model`、`whitelily:switch-avatar-model`、`whitelily:avatar-models-event`。`importAvatarModel()` 在主进程调用 `dialog.showOpenDialog()`，过滤器只显示 `vrm`/`glb`，仅接受一个普通文件；取消返回 `cancelled`。主进程不把受管理绝对路径或原始源路径返回 renderer，列表项只含有界 `previewDataUrl`、能力、状态和稳定错误码。

- [x] **Step 4: 注册服务并确保清理订阅**

`IpcRegistryOptions` 新增 `avatarModels` 端口，明确方法签名为 `list()`、`importFromPicker()`、`switchTo(modelId)`、`subscribe(listener)`。`registerIpcHandlers()` 清理函数必须移除三个 invoke handler 和目录订阅；重复启动/关闭 composition 不得留下监听器。

- [x] **Step 5: 跑 IPC、preload 和构建测试**

Run: `npm run test --workspace @whitelily/desktop -- src/desktopApi.task5.test.ts src-main/ipcRegistry.test.ts src-main/preloadBundle.test.ts`

Expected: PASS。

Run: `npm run typecheck --workspace @whitelily/desktop`

Expected: PASS。

- [x] **Step 6: 提交**

```powershell
git add apps/desktop/src/desktopApi.ts apps/desktop/src/desktopApi.task5.test.ts apps/desktop/src-main/ipcRegistry.ts apps/desktop/src-main/ipcRegistry.test.ts apps/desktop/src-main/main.ts apps/desktop/src-main/preloadBundle.test.ts
git commit -m "feat: expose avatar model desktop API"
```

### Task 6: 实现桌面端切换串行器和原子 JSON 邮箱

**Files:**
- Create: `apps/desktop/src-main/avatar/avatarModelMailbox.ts`
- Create: `apps/desktop/src-main/avatar/avatarModelMailbox.test.ts`
- Create: `apps/desktop/src-main/avatar/avatarModelSwitchCoordinator.ts`
- Create: `apps/desktop/src-main/avatar/avatarModelSwitchCoordinator.test.ts`
- Modify: `apps/desktop/src-main/main.ts`

**Interfaces:**
- Consumes: Task 1 控制协议、Task 2 目录/偏好、原子 JSON 文件、Minecraft presence/world session。
- Produces: `AvatarModelMailbox.publish()`、`waitForState()`、`AvatarModelSwitchCoordinator.switchTo()`、`cancelPending()`、`reconcilePersistedSelection()`。

- [ ] **Step 1: 写准备、候选抢占、首帧提交和失败回滚测试**

```ts
it("persists only after the matching visible-frame committed state", async () => {
  const switching = harness.coordinator.switchTo("user:one");
  await harness.mailbox.expectRequest("prepare", "user:one");
  await harness.mailbox.reply("ready");
  await harness.mailbox.expectRequest("commit", "user:one");
  expect(harness.preferences.commitActiveModelId).not.toHaveBeenCalled();
  await harness.mailbox.reply("committed");
  await switching;
  expect(harness.preferences.commitActiveModelId).toHaveBeenCalledWith(
    expect.objectContaining({ activeModelId: "user:one" }),
  );
});

it("cancels an uncommitted candidate when a newer choice arrives", async () => {
  const first = harness.coordinator.switchTo("user:one");
  const second = harness.coordinator.switchTo("user:two");
  await expect(first).rejects.toMatchObject({ code: "AVATAR_SWITCH_SUPERSEDED" });
  await harness.mailbox.expectRequest("prepare", "user:two");
  await harness.complete(second);
});
```

- [ ] **Step 2: 运行红灯**

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarModelMailbox.test.ts src-main/avatar/avatarModelSwitchCoordinator.test.ts`

Expected: FAIL，缺少邮箱和切换协调器。

- [ ] **Step 3: 实现安全邮箱**

```ts
export interface AvatarModelMailbox {
  publish(request: AvatarModelControlRequest): Promise<void>;
  waitForState(input: {
    readonly requestId: string;
    readonly accepted: readonly AvatarModelControlState["phase"][];
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<AvatarModelControlState>;
}
```

请求写入 `request.json`，Fabric 状态写入 `state.json`，双方均使用同目录临时文件、flush、原子 rename。读者复核普通文件、大小不超过 64 KiB、schema、`requestId`、`worldSessionId` 和单调 `updatedAt`。等待采用 `fs.watch` 加 250ms 轮询兜底，不使用忙循环；prepare 超时 15 秒、commit 超时 5 秒。旧 request/state、未知字段、世界会话不匹配和 symlink/reparse point 一律忽略并记录稳定错误码。

- [ ] **Step 4: 实现最新候选获胜的串行切换**

```ts
export class AvatarModelSwitchCoordinator {
  switchTo(modelId: string): Promise<AvatarModelCatalogSnapshot>;
  cancelPending(reason: "desktop_closing" | "bridge_disconnected" | "world_changed"): Promise<void>;
  reconcilePersistedSelection(): Promise<void>;
}
```

协调器在读取候选记录后复核资源摘要和 `AVATAR_VALID`；保留旧活动 ID；发布 prepare，等待 ready；若未被抢占则发布 commit，等待 committed；仅在 committed 的 `activeModelId`、`requestId`、`worldSessionId` 全匹配时写偏好并更新单一活动卡片。任何失败先发布 cancel（如果仍有活动世界）、清理 pending 状态并返回带稳定码错误，绝不改旧偏好。断桥、换世界、资源重载和 Electron 关闭都调用 `cancelPending()`；重新连接只对持久化 ID 执行全新协商。

- [ ] **Step 5: 覆盖所有中断边界并跑绿**

增加测试：摘要漂移、ready 之后换世界、commit 之后状态来自旧 session、bridge 断开、超时、failed 状态、偏好修订冲突、已活动模型幂等选择、桌面重启重新协商、同一错误不会重复发布目录事件。

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarModelMailbox.test.ts src-main/avatar/avatarModelSwitchCoordinator.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add apps/desktop/src-main/avatar/avatarModelMailbox.ts apps/desktop/src-main/avatar/avatarModelMailbox.test.ts apps/desktop/src-main/avatar/avatarModelSwitchCoordinator.ts apps/desktop/src-main/avatar/avatarModelSwitchCoordinator.test.ts apps/desktop/src-main/main.ts
git commit -m "feat: coordinate atomic avatar hot switches"
```

### Task 7: 在 Fabric 端解析邮箱并管理候选生命周期

**Files:**
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/control/AvatarModelControlRequest.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/control/AvatarModelControlState.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/control/AvatarModelControlCodec.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/control/AvatarModelMailbox.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/control/AvatarCandidateRuntime.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/control/AvatarVisibleFrameResult.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/control/AvatarModelController.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/control/AvatarModelControlCodecTest.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/control/AvatarModelControllerTest.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/WhiteLilyAvatarClient.java`

**Interfaces:**
- Consumes: Task 1 JSON fixture、`WHITELILY_DATA_ROOT`/`LOCALAPPDATA`、Fabric client tick/world lifecycle。
- Produces: `AvatarModelController.tick()`、`onRenderBoundary()`、`onVisibleFrameResult()`、`cancelForWorldChange()`。

- [ ] **Step 1: 写跨语言夹具和状态机失败测试**

```java
@Test
void parsesTheReviewedPrepareFixture() throws Exception {
  AvatarModelControlRequest request = codec.read(fixture("prepare-request.json"));
  assertEquals("switch-0001", request.requestId());
  assertEquals(AvatarModelOperation.PREPARE, request.operation());
  assertEquals("builtin:whitelily-hd", request.modelId());
}

@Test
void neverCommitsBeforeACompleteVisibleFrame() {
  controller.accept(prepare("user:one"));
  loader.completePrepared();
  controller.tick();
  controller.accept(commit("user:one"));
  controller.onRenderBoundary();
  assertEquals("builtin:whitelily-hd", controller.confirmedActiveModelId());
  controller.onVisibleFrameResult(AvatarVisibleFrameResult.COMPLETE);
  assertEquals("user:one", controller.confirmedActiveModelId());
}
```

- [ ] **Step 2: 运行红灯**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.control.*"`

Expected: FAIL，缺少 control 包。

- [ ] **Step 3: 用 Gson 严格解析固定协议**

```java
public record AvatarModelControlRequest(
    int schemaVersion,
    String requestId,
    AvatarModelOperation operation,
    String modelId,
    String worldSessionId,
    AvatarRuntimeDescriptor candidate,
    Instant issuedAt) {}

public final class AvatarModelController {
  public void tick();
  public void onRenderBoundary();
  public void onVisibleFrameResult(AvatarVisibleFrameResult result);
  public void cancelForWorldChange();
  public String confirmedActiveModelId();
}

public interface AvatarCandidateRuntime {
  CompletionStage<PreparedCandidate> prepare(AvatarRuntimeDescriptor descriptor);
  void requestCommit(PreparedCandidate candidate);
  void cancel(PreparedCandidate candidate);
  void release(PreparedCandidate candidate);
}

public enum AvatarVisibleFrameResult {
  COMPLETE,
  FAILED
}
```

在 `mod-fabric` 增加 `implementation("com.google.code.gson:gson:2.13.1")`。codec 先检查文件普通性和 64 KiB 上限，再用 JSON tree 拒绝未知键、空字符串、超长字符串、非小写摘要、路径逃逸和不匹配 schema。模型资源路径必须 canonicalize 后仍位于 `%LOCALAPPDATA%/WhiteLily/models` 或打包内置资源根目录，禁止 symlink/reparse point。

- [ ] **Step 4: 实现非渲染线程读取、渲染线程提交的状态机**

client tick 每 250ms 检查一次 request mtime；`prepare` 将解析/文件读取/骨架准备提交到有界单线程 executor，成功后先执行不可见准备帧再写 `ready`。`commit` 只为同 request、同 world session、同 candidate 的 ready 资源设置 `commitRequested`；`onRenderBoundary()` 原子交换候选和旧活动会话但保留旧资源；`onVisibleFrameResult(COMPLETE)` 后才写 `committed` 并释放旧资源。`FAILED` 立即恢复旧活动引用并写稳定错误；`cancel`、断线、换世界和资源重载取消 future、释放候选并丢弃迟到回调。

- [ ] **Step 5: 跑协议与生命周期测试**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.control.*"`

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/control subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/control subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/WhiteLilyAvatarClient.java subprojects/whitelily-avatar/build.gradle.kts
git commit -m "feat: consume avatar model control mailbox"
```

### Task 8: 建立可替换渲染后端和完整帧提交边界

**Files:**
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/backend/WhiteLilyAvatarRenderBackend.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/backend/AvatarVisualState.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/backend/AvatarFrameResult.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/backend/ClassicGeckoRenderBackend.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/backend/AvatarRenderBackendRegistry.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/backend/AvatarRenderBackendRegistryTest.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/WhiteLilyRenderRuntime.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/WhiteLilyRenderDecision.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/mixin/PlayerRendererMixin.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/mixin/LivingEntityRendererMixin.java`

**Interfaces:**
- Consumes: 现有身份、装备、手持物、session health 和 GeckoLib renderer。
- Produces: `WhiteLilyAvatarRenderBackend.prepare()`、`renderFrame()`、`dispose()`，不可变 `AvatarVisualState`。

- [ ] **Step 1: 写“完整自定义帧成功后才抑制原版人物”失败测试**

```java
@Test
void suppressesVanillaOnlyAfterEveryCustomBatchCommits() {
  backend.nextResult(AvatarFrameResult.failed("AVATAR_SHADER_FAILED"));
  assertFalse(registry.render(snapshot()).suppressVanilla());
  assertTrue(graphicsState.wasRestored());

  backend.nextResult(AvatarFrameResult.complete());
  assertTrue(registry.render(snapshot()).suppressVanilla());
}
```

- [ ] **Step 2: 运行红灯**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.render.backend.*"`

Expected: FAIL，缺少 backend 接口。

- [ ] **Step 3: 定义只读快照和后端契约**

```java
public interface WhiteLilyAvatarRenderBackend extends AutoCloseable {
  PreparedAvatarResources prepare(AvatarRuntimeDescriptor descriptor) throws AvatarRenderException;
  AvatarFrameResult renderFrame(
      PreparedAvatarResources resources,
      AvatarVisualState state,
      AvatarRenderContext context);
  void dispose(PreparedAvatarResources resources);
  @Override default void close() {}
}
```

`AvatarVisualState` 固定包含 render session/world session、位置朝向、Minecraft pose、局部帧时间、`ArmorTheme`、主副手实际物品、移动/游泳/睡觉/受伤、说话/表情/AI 工作语义、观察距离和图形能力；所有字段为值对象，不持有可变玩家实体或行动队列引用。`WhiteLilyRenderRuntime.captureDecision()` 继续做身份审批，再把输入适配为快照。

- [ ] **Step 4: 把当前 GeckoLib 路径封装为显式经典后端**

`ClassicGeckoRenderBackend` 复用 `WhiteLilyGeoRenderer` 和当前持有物层，仅在活动模型 ID 为 `builtin:whitelily-classic` 时工作。`AvatarRenderBackendRegistry` 实现 Task 7 的 `AvatarCandidateRuntime`，把 backend 准备资源封装成 `PreparedCandidate`，并把完整/失败帧映射为 `AvatarVisibleFrameResult` 回报控制器。Registry 不以异常、FPS 或距离自动选择经典后端；高清/自定义失败时只允许当前帧恢复 vanilla player rendering，并上报失败，不写全局选择。

- [ ] **Step 5: 在 mixin 中建立图形状态事务**

渲染前复制 PoseStack、记录 blend/depth/cull/shader color；后端返回 `complete` 才设置 captured render 并抑制 vanilla。任何 batch 失败先关闭/丢弃本帧 buffer、恢复 PoseStack 与 RenderSystem 状态，再走 vanilla；不要留下半个人物、纯白材质或损坏缓冲区。

- [ ] **Step 6: 跑现有回归与新契约测试**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.render.*"`

Expected: PASS，包括已有 `WhiteLilyRenderDecisionTest`、`WhiteLilyHeldItemLayerContractTest` 和 `RendererSessionHealthTest`。

- [ ] **Step 7: 提交**

```powershell
git add subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/mixin subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render
git commit -m "refactor: isolate avatar render backends"
```

### Task 9: 加载和渲染平滑蒙皮 GLB/VRM

**Files:**
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/gltf/GlbDocumentReader.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/gltf/GlbMeshDecoder.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/gltf/HumanoidSkeleton.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/gltf/HumanoidAnimator.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/gltf/SmoothMeshRenderBackend.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/gltf/AvatarGpuResources.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/resources/assets/whitelily_avatar/shaders/core/avatar_skinning.json`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/resources/assets/whitelily_avatar/shaders/core/avatar_skinning.vsh`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/resources/assets/whitelily_avatar/shaders/core/avatar_skinning.fsh`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/gltf/GlbDocumentReaderTest.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/gltf/HumanoidAnimatorTest.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/gltf/SmoothMeshRenderBackendTest.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/resources/avatar/minimal-humanoid.glb`

**Interfaces:**
- Consumes: Task 7 `AvatarRuntimeDescriptor`、Task 8 backend 契约和 `AvatarVisualState`。
- Produces: `SmoothMeshRenderBackend`、GPU 蒙皮、身体动画、真实手持物挂点。

- [ ] **Step 1: 写最小平滑样例、骨架姿势和资源释放失败测试**

```java
@Test
void decodesTheReviewedSkinnedTriangleWithoutExternalResources() throws Exception {
  GlbMesh mesh = reader.read(resource("avatar/minimal-humanoid.glb"));
  assertEquals(1, mesh.primitives().size());
  assertEquals(16, mesh.skeleton().semanticBones().size());
  assertTrue(mesh.primitives().getFirst().skinned());
}

@Test
void neutralOnlyModelsKeepABindPoseFaceWhileBodyAnimationRuns() {
  AvatarPose pose = animator.evaluate(state("mining"), neutralOnlySkeleton(), 0.25f);
  assertNotEquals(new Matrix4f().identity(), pose.bone("rightUpperArm"));
  assertEquals(ExpressionWeights.NEUTRAL, pose.expressions());
}
```

- [ ] **Step 2: 运行红灯**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.render.gltf.*"`

Expected: FAIL，缺少 glTF 包。

- [ ] **Step 3: 实现与 Electron 校验一致的有界 GLB 解码**

Java 解码器复核 magic/version/chunk、摘要、bufferView/accessor、索引、材质/图片和节点层级，不信任桌面结果。只接受 TRIANGLES、最多 256 joints、每顶点最多 4 权重并归一化；上传前把 POSITION/NORMAL/UV/JOINTS/WEIGHTS/indices 转为不可变直接 ByteBuffer。PNG/JPEG 由 Minecraft NativeImage 解码；禁止任何 URI 和运行时下载。

- [ ] **Step 4: 实现共享语义骨架和 GPU 蒙皮材质**

`HumanoidAnimator.evaluate(AvatarVisualState, HumanoidSkeleton, float)` 把 Minecraft pose、走跑游泳睡觉、受伤、说话和工作语义混合为骨矩阵；缺少非必要头发/裙摆/表情只禁用对应通道。shader 接收 model/view/projection、最多 128 个活动 joint matrices、贴图、基础两到三段赛璐璐阈值和有界边缘高光；加载 shader 或高级材质失败时返回稳定错误，让 Task 11 的降级状态机处理。

- [ ] **Step 5: 实现真实持有物和自定义盔甲规则**

`SmoothMeshRenderBackend` 从骨骼映射得到左右手矩阵，再委托现有 Minecraft item renderer 绘制真实主副手物品。若记录来源为 `imported`，永远不添加 WhiteLily armor theme mesh；`ArmorTheme` 只保留为游戏状态/诊断输入，盔甲属性继续由 Minecraft 自身决定。

- [ ] **Step 6: 跑解析、动画、shader contract 和资源释放测试**

测试至少覆盖：损坏 GLB、摘要不符、超过 joint 上限、权重未归一化、neutral-only、左右手、dispose 幂等、准备取消后不上传 GPU、渲染异常恢复图形状态。

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.render.gltf.*"`

Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/gltf subprojects/whitelily-avatar/mod-fabric/src/main/resources/assets/whitelily_avatar/shaders subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/gltf subprojects/whitelily-avatar/mod-fabric/src/test/resources/avatar
git commit -m "feat: render smooth skinned avatar models"
```

### Task 10: 完成模型页面的单行横向轨道

**Files:**
- Create: `apps/desktop/src/pages/AvatarModelPage.tsx`
- Create: `apps/desktop/src/pages/AvatarModelPage.test.tsx`
- Create: `apps/desktop/src/components/AvatarModelCard.tsx`
- Create: `apps/desktop/src/components/AvatarModelCard.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.task5.test.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/styles.test.ts`
- Modify: `apps/desktop/src/i18n/messageKeys.ts`
- Modify: `apps/desktop/src/i18n/zh-CN.ts`
- Modify: `apps/desktop/src/i18n/en.ts`
- Modify: `apps/desktop/src/i18n/i18n.test.ts`

**Interfaces:**
- Consumes: Task 5 `WhiteLilyAvatarApi` 和 `AvatarModelCatalogSnapshot`。
- Produces: 独立 `avatarModels` route、固定高度模型库、导入/切换/失败 UI。

- [ ] **Step 1: 写 12 张卡片、完整设定图和状态不抢跑测试**

```tsx
it.each([736, 360])("keeps twelve cards on one horizontal track at %ipx", async (width) => {
  setContentWidth(width);
  render(<AvatarModelPage api={apiWithTenImports()} locale="zh-CN" />);
  const track = await screen.findByTestId("avatar-model-track");
  expect(track.children).toHaveLength(12);
  expect(getComputedStyle(track).flexWrap).toBe("nowrap");
  expect(track.scrollWidth).toBeGreaterThan(track.clientWidth);
  expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
});

it("keeps the turnaround image fully contained", async () => {
  render(<AvatarModelPage api={apiWithTenImports()} locale="zh-CN" />);
  const image = await screen.findByAltText("WhiteLily 高清动漫 3D 模型设定图");
  expect(image).toHaveStyle({ objectFit: "contain" });
});
```

- [ ] **Step 2: 运行红灯**

Run: `npm run test --workspace @whitelily/desktop -- src/pages/AvatarModelPage.test.tsx src/components/AvatarModelCard.test.tsx src/styles.test.ts src/App.task5.test.tsx`

Expected: FAIL，缺少页面和 route。

- [ ] **Step 3: 建立与 ChatGPT 模型页并列的独立导航**

把现有 `model` route 和文案明确改名为 AI 模型设置，新增 `avatarModels` route，中文标题固定为“模型与外观”。页面挂载时调用 `listAvatarModels()` 并订阅目录事件；locale-only rerender 不重新加载、不清除 pending；卸载时取消订阅。导入按钮位于标题栏右侧，调用无参数 `importAvatarModel()`；取消静默保持页面，失败显示按稳定码映射的中文/英文错误，不添加卡片。

- [ ] **Step 4: 实现固定轨道和两种卡片尺寸**

```css
.avatar-model-page { min-width: 0; overflow: hidden; height: 100%; }
.avatar-model-track-viewport { min-width: 0; overflow-x: scroll; overflow-y: hidden; scrollbar-gutter: stable; }
.avatar-model-track { display: flex; flex-wrap: nowrap; align-items: stretch; width: max-content; gap: 16px; }
.avatar-model-card { flex: 0 0 220px; height: 430px; }
.avatar-model-card--builtin-hd { flex-basis: 300px; }
.avatar-model-card__preview { width: 100%; height: 320px; object-fit: contain; }
```

轨道 viewport 固定在内容区可用高度内；真实 scrollbar 不隐藏。卡片依序使用 API 返回顺序，React key 使用稳定 model ID。活动卡显示“正在使用”，pending 卡显示 loading 且活动卡继续保留“正在使用”；点击当前卡幂等，切换错误恢复旧唯一选中状态。

- [ ] **Step 5: 增加窄屏键盘和滚动可达性测试**

测试 Home/End、Tab focus、触控板/滚轮不被自定义 handler 阻断、最后一张 `scrollIntoView({inline: "nearest"})` 可达、360px 时侧栏折叠但轨道仍单行、页面高度在 2 和 12 张卡时相同。不得用 CSS grid、`flex-wrap: wrap` 或隐藏 scrollbar。

Run: `npm run test --workspace @whitelily/desktop -- src/pages/AvatarModelPage.test.tsx src/components/AvatarModelCard.test.tsx src/styles.test.ts src/App.task5.test.tsx src/i18n/i18n.test.ts`

Expected: PASS。

- [ ] **Step 6: 构建并提交**

Run: `npm run build --workspace @whitelily/desktop`

Expected: PASS。

```powershell
git add apps/desktop/src/pages/AvatarModelPage.tsx apps/desktop/src/pages/AvatarModelPage.test.tsx apps/desktop/src/components/AvatarModelCard.tsx apps/desktop/src/components/AvatarModelCard.test.tsx apps/desktop/src/App.tsx apps/desktop/src/App.task5.test.tsx apps/desktop/src/components/Sidebar.tsx apps/desktop/src/styles.css apps/desktop/src/styles.test.ts apps/desktop/src/i18n
git commit -m "feat: add horizontal avatar model library"
```

### Task 11: 加入细节等级、降级顺序和限频诊断

**Files:**
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/quality/AvatarDetailSelector.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/quality/AvatarFallbackController.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/diagnostics/AvatarRenderDiagnostic.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/diagnostics/AvatarDiagnosticRateLimiter.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/quality/AvatarDetailSelectorTest.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/quality/AvatarFallbackControllerTest.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/diagnostics/AvatarDiagnosticRateLimiterTest.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/gltf/SmoothMeshRenderBackend.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/WhiteLilyRenderRuntime.java`

**Interfaces:**
- Consumes: 观察距离、图形能力、帧失败类型和 render session。
- Produces: `AvatarDetailLevel.HIGH/LOW`、严格降级状态、结构化限频日志。

- [ ] **Step 1: 写滞回、严格降级和经典模型不自动参与测试**

```java
@Test
void appliesFourteenEighteenBlockHysteresis() {
  assertEquals(HIGH, selector.select(HIGH, 17.9f));
  assertEquals(LOW, selector.select(HIGH, 18.1f));
  assertEquals(LOW, selector.select(LOW, 14.1f));
  assertEquals(HIGH, selector.select(LOW, 13.9f));
}

@Test
void neverReturnsClassicAsAnAutomaticFallback() {
  controller.record(SECONDARY_DYNAMICS_FAILED);
  controller.record(ADVANCED_MATERIAL_FAILED);
  controller.record(HIGH_MODEL_FAILED);
  assertEquals(VANILLA_FRAME_ONLY, controller.currentStage());
}
```

- [ ] **Step 2: 运行红灯**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.render.quality.*" --tests "io.github.whitelily.avatar.render.diagnostics.*"`

Expected: FAIL，缺少 quality/diagnostics 包。

- [ ] **Step 3: 实现 14/18 滞回和固定降级链**

首次出现时距离 `<=16` 选 high，`>16` 选 low；已 high 仅在 `>18` 转 low，已 low 仅在 `<14` 转 high。失败链严格为：关闭次级衣发动态/非必要透明 → 基础赛璐璐 → 同风格 low → 当前帧 vanilla。最后一级不改变活动模型 ID，不激活经典模型，并使当前外观验收标记为失败；资源重载或新会话重新从已校验活动模型协商，不无条件继承旧失败状态。

- [ ] **Step 4: 实现结构化日志和每会话限频**

```java
public record AvatarRenderDiagnostic(
    String assetVersion,
    String backend,
    String modelId,
    String detailLevel,
    String armorTheme,
    String materialTier,
    String sessionId,
    String errorCode,
    String sanitizedReason) {}
```

按 `(sessionId, modelId, errorCode)` 首次立即记录，随后 30 秒内抑制重复，窗口结束写一条含 `suppressedCount` 的摘要。错误码区分 `AVATAR_ASSET_VALIDATION_FAILED`、`AVATAR_MESH_LOAD_FAILED`、`AVATAR_SHADER_FAILED`、`AVATAR_ANIMATION_FAILED`、`AVATAR_FRAME_FALLBACK`；原因去除绝对用户路径、token 和控制字符并截断 240 字符。

- [ ] **Step 5: 跑质量和完整 avatar 测试**

Run: `npm run avatar:test`

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/quality subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/diagnostics subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/gltf/SmoothMeshRenderBackend.java subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/WhiteLilyRenderRuntime.java subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/quality subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/diagnostics
git commit -m "feat: add avatar quality fallback isolation"
```

### Task 12: 打包内置模型并完成跨端回归验收

**Files:**
- Modify: `subprojects/whitelily-avatar/tools/stage-minecraft-components.mjs`
- Modify: `subprojects/whitelily-avatar/tools/stage-minecraft-components.test.mjs`
- Modify: `subprojects/whitelily-avatar/build.gradle.kts`
- Modify: `subprojects/whitelily-avatar/gradle.properties`
- Modify: `packaging/electron/runtime-manifest.json`
- Modify: `scripts/prepare-electron-bundle.ps1`
- Create: `apps/desktop/src-main/avatar/avatarModelE2e.test.ts`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/packaging/AvatarRuntimeAssetContractTest.java`
- Create: `docs/testing/avatar-model-library-manual-checklist.md`

**Interfaces:**
- Consumes: Tasks 1–11 及第二份美术生产计划最终导出的 `whitelily-hd-high.glb`、`whitelily-hd-low.glb`、清单和预览。
- Produces: 可安装的双内置模型、完整运行时资源、跨世界/重启持久化和人工验收记录。

- [ ] **Step 1: 写发布包和端到端失败测试**

```ts
it("keeps the old model when Minecraft reports a first-frame failure", async () => {
  const app = await launchPackagedHarness({ activeModelId: "builtin:whitelily-classic" });
  await app.switchTo("builtin:whitelily-hd");
  await app.fabricReply("ready");
  await app.fabricReply("failed", "AVATAR_SHADER_FAILED");
  expect((await app.list()).activeModelId).toBe("builtin:whitelily-classic");
  await app.restart();
  expect((await app.list()).activeModelId).toBe("builtin:whitelily-classic");
});
```

Java contract test 打开 remapped avatar JAR，断言包含 high/low GLB、shader、资源清单、两个内置记录所需预览与许可证，摘要与清单逐字节一致，并断言不存在 `http://`、`https://` 或未声明 `.bin`/贴图资源。

- [ ] **Step 2: 运行红灯**

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarModelE2e.test.ts`

Expected: FAIL，发布 composition 尚未提供完整 avatar services。

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.packaging.AvatarRuntimeAssetContractTest"`

Expected: FAIL，运行时资产尚未全部进入 JAR。

- [ ] **Step 3: 更新可复现打包和摘要钉死**

资源构建先运行第二份计划的 `build-anime-avatar.mjs --verify --export --render-previews`，再把已验证 GLB、贴图、shader、预览和 `avatar-runtime-manifest.json` 放入 Fabric resources 和 Electron bundle。`stageMinecraftComponents` 保持 reproducible order/timestamps，更新 avatar JAR 和组件清单的 byte count/SHA-256；任何摘要变化都必须先由构建产生并通过 contract test，不能手改产物掩盖差异。

- [ ] **Step 4: 完成跨端自动验证**

Run: `npm run test`

Expected: PASS。

Run: `npm run desktop:test`

Expected: PASS。

Run: `npm run avatar:check`

Expected: PASS。

Run: `npm run typecheck && npm run desktop:build`

Expected: PASS。

- [ ] **Step 5: 完成真实 Minecraft 快速检查**

按 `docs/testing/avatar-model-library-manual-checklist.md` 逐项记录：两个内置模型切换；一个 VRM 0.x、一个 VRM 1.0、一个 GLB 导入；无表情模型自然脸；自定义模型手持物；实际盔甲属性但无 WhiteLily 专属盔甲；切换中换世界/断桥/资源重载；故障时 Minecraft、桌面端、AI 对话、动作队列和立即叫停仍工作；重启后仅恢复最后一次 committed 模型。页面在 736px 和 360px 使用 10 个测试导入模型，截图证明 12 张卡片单行、第一图完整、末卡可达、根页面无横向滚动。

- [ ] **Step 6: 提交**

```powershell
git add subprojects/whitelily-avatar/tools subprojects/whitelily-avatar/build.gradle.kts subprojects/whitelily-avatar/gradle.properties subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/packaging apps/desktop/src-main/avatar/avatarModelE2e.test.ts packaging/electron/runtime-manifest.json scripts/prepare-electron-bundle.ps1 docs/testing/avatar-model-library-manual-checklist.md
git commit -m "test: verify avatar model library end to end"
```
