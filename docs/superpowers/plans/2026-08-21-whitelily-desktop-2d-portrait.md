# WhiteLily 桌面端 2D 立绘与皮肤库实施计划

> **供代理执行者使用：** 必须逐任务使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。所有步骤使用复选框跟踪。

**目标：** 把“模型与外观”页面迁移为 Minecraft 原生皮肤库，内置 WhiteLily 完整显示用户原稿 2D 立绘，并允许用户安全导入 64×64 皮肤和可选 portrait；10 个以上条目仍保持单行横向滚动且图片不变形。

**架构：** 共享 schema 以 `worldRenderer/skinAsset/armModel/portraitAsset` 描述外观，不再暴露 GLB 骨骼和表达式能力。主进程把皮肤与可选立绘先写入独占 staging 目录、逐字节验证，再原子 rename 到受管目录并写目录；renderer 只接收有上限的 PNG data URL。内置 portrait 直接复用用户提供的原稿资产，不重新生成角色设计；无 portrait 的用户皮肤通过确定性的正面皮肤预览生成器展示。

**技术栈：** TypeScript 7、Node.js 24、Electron、React、Zod 4、Vitest、CSS Flexbox。

**规格：** `docs/superpowers/specs/2026-08-21-minecraft-native-skin-and-2d-portrait-design.md`

## 全局约束

- 内置正式外观 ID 固定为 `builtin:whitelily`，世界 renderer 固定为 `minecraft-skin`，手臂固定为 `slim`。
- 内置立绘的艺术事实只来自 `subprojects/whitelily-avatar/assets/source/whitelily-turnaround.png` 与 `whitelily-armor-themes.png`；本计划不生成新角色设计。
- 用户皮肤必须是完整 64×64、8-bit RGBA PNG，必需基础 UV 区域全部不透明。
- portrait 可选，只在软件内显示，最大 4096×4096、8 MiB；失败不影响当前外观、世界连接或 AI。
- 用户导入条目不继承 WhiteLily 六主题。
- 文件先验证、复制到受管 staging 目录、复核摘要，再原子写入目录；拒绝符号链接、路径穿越、外部 URL 和导入期间换文件。
- 模型库只有一行；10 个以上条目用右侧横向滚动条访问，根页面本身不得横向溢出。
- 所有缩略图使用 `object-fit: contain`，完整人物、头饰、长发、裙摆不得被裁切或拉伸。

---

### Task 1：把共享模型契约迁移为原生皮肤外观契约

**Files:**
- Modify: `src/avatar/avatarModelTypes.ts`
- Modify: `src/avatar/avatarModelSchemas.ts`
- Modify: `tests/unit/avatarModelSchemas.test.ts`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/control/AvatarModelControlCodec.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/control/AvatarModelControlCodecTest.java`

**Interfaces:**
- Produces: `AvatarAppearanceRecord`、`AvatarAppearanceListItem` 和运行时 `AvatarRuntimeDescriptor`，字段名在 Electron 与 Fabric 之间逐字一致。
- Consumes: 无；本任务定义后续任务唯一允许使用的数据形状。

- [ ] **Step 1：写 schema 与控制协议红灯测试**

```ts
it("accepts the builtin native skin appearance", () => {
  expect(parseAvatarModelRecord({
    id: "builtin:whitelily",
    displayName: "WhiteLily",
    origin: "builtin",
    worldRenderer: "minecraft-skin",
    skinAsset: "builtin/whitelily/skin/base.png",
    skinSha256: "a".repeat(64),
    armModel: "slim",
    portraitAsset: "builtin/whitelily/portrait.png",
    portraitSha256: "b".repeat(64),
    importedAt: "2026-08-21T00:00:00.000Z",
    validation: { code: "AVATAR_VALID", validatedAt: "2026-08-21T00:00:00.000Z" },
  }).id).toBe("builtin:whitelily");
});
```

Java codec 的 candidate 只使用 `modelId/origin/worldRenderer/armModel`，断言 `worldRenderer == "minecraft-skin"`、`armModel == "slim"`，并断言含 `skinAsset`、`boneMapping`、`bodyAnimation`、`expressions` 或绝对路径的 candidate 被拒绝为 `AVATAR_CONTROL_INVALID`。

- [ ] **Step 2：运行红灯**

Run: `npm test -- tests/unit/avatarModelSchemas.test.ts`

Expected: FAIL，旧 schema 只接受 HD/classic/VRM/GLB。

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.control.AvatarModelControlCodecTest"`

Expected: FAIL，Java 协议仍要求 GLB 骨骼字段。

- [ ] **Step 3：定义新类型并保持命名兼容层最小化**

```ts
export const BUILTIN_AVATAR_MODEL_IDS = Object.freeze(["builtin:whitelily"] as const);
export type AvatarWorldRenderer = "minecraft-skin";
export type AvatarArmModel = "slim" | "wide";

export interface AvatarAppearanceRecord {
  readonly id: string;
  readonly displayName: string;
  readonly origin: "builtin" | "imported";
  readonly worldRenderer: AvatarWorldRenderer;
  readonly skinAsset: string;
  readonly skinSha256: string;
  readonly armModel: AvatarArmModel;
  readonly portraitAsset?: string;
  readonly portraitSha256?: string;
  readonly importedAt: string;
  readonly validation: { readonly code: "AVATAR_VALID"; readonly validatedAt: string };
}

export interface AvatarAppearanceListItem {
  readonly id: string;
  readonly displayName: string;
  readonly origin: "builtin" | "imported";
  readonly worldRenderer: "minecraft-skin";
  readonly armModel: "slim" | "wide";
  readonly previewDataUrl: string;
  readonly portraitDataUrl?: string;
}

export interface AvatarRuntimeDescriptor {
  readonly modelId: string;
  readonly origin: "builtin" | "imported";
  readonly worldRenderer: "minecraft-skin";
  readonly armModel: "slim" | "wide";
}
```

在迁移期可用 `type AvatarModelRecord = AvatarAppearanceRecord` 保持 IPC 方法名稳定，但不得保留旧 3D 字段。`portraitAsset` 与 `portraitSha256` 必须同时存在或同时缺失；内置记录必须两者都有，用户记录允许两者都无。

- [ ] **Step 4：同步 Java descriptor/codec**

`AvatarRuntimeDescriptor` 改为 `modelId, origin, worldRenderer, armModel`，不再携带文件路径或摘要；皮肤路径与 SHA-256 只能从 Minecraft 端读取的已批准清单获得。记录 schema 仍要求 `skinAsset` 是受管相对路径、`skinSha256` 是小写 64 位 SHA-256：内置路径必须以 `builtin/whitelily/` 开头，用户路径必须以 `user/<uuid>/` 开头。协议继续保持 `schemaVersion: 1`，避免无必要的 mailbox 文件升级。

- [ ] **Step 5：运行共享契约测试**

Run: `npm test -- tests/unit/avatarModelSchemas.test.ts`

Expected: PASS。

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.control.*"`

Expected: PASS。

- [ ] **Step 6：提交**

```powershell
git add src/avatar/avatarModelTypes.ts src/avatar/avatarModelSchemas.ts tests/unit/avatarModelSchemas.test.ts subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/control subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/control
git commit -m "refactor: migrate avatar contract to minecraft skins"
```

### Task 2：建立单内置 WhiteLily 记录与安全目录迁移

**Files:**
- Modify: `apps/desktop/src-main/avatar/avatarModelCatalog.ts`
- Modify: `apps/desktop/src-main/avatar/avatarModelCatalog.test.ts`
- Modify: `apps/desktop/src-main/avatar/avatarModelPaths.ts`
- Modify: `apps/desktop/src-main/avatar/avatarModelPreferences.ts`
- Modify: `apps/desktop/src-main/avatar/avatarModelPreferences.test.ts`
- Create: `apps/desktop/src-main/avatar/builtinAvatarAppearance.ts`
- Create: `apps/desktop/src-main/avatar/builtinAvatarAppearance.test.ts`
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/resources/avatar/builtin/whitelily/skin/base.png`
- Create: `apps/desktop/resources/avatar/builtin/whitelily/portrait.png`

**Interfaces:**
- Consumes: Task 1 的 `AvatarAppearanceRecord`。
- Produces: 始终排在首位且唯一的 `builtin:whitelily`，以及将旧 `builtin:whitelily-hd/classic` 偏好迁移到新 ID 的读取逻辑。

- [ ] **Step 1：写单内置记录与旧偏好迁移红灯**

```ts
it("lists one builtin before imported appearances", async () => {
  const state = await catalog.list();
  expect(state.models.map(({ id }) => id)).toEqual(["builtin:whitelily", imported.id]);
});

it.each(["builtin:whitelily-hd", "builtin:whitelily-classic"])(
  "migrates %s to the native builtin",
  async (legacyId) => {
    await writePreferences({ schemaVersion: 1, activeModelId: legacyId });
    expect((await preferences.load()).activeModelId).toBe("builtin:whitelily");
  },
);
```

- [ ] **Step 2：运行红灯**

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarModelCatalog.test.ts src-main/avatar/avatarModelPreferences.test.ts`

Expected: FAIL，目录构造器仍要求两个内置 3D 模型。

- [ ] **Step 3：复制已审核内置资产并生成摘要**

把现有 `textures/skin/base.png` 原字节复制为 Electron 内置 `skin/base.png`；把用户原稿 `whitelily-turnaround.png` 原字节复制为 `portrait.png`。`builtinAvatarAppearance.ts` 在启动时对这两个打包资源做有界读取并计算 SHA-256，再构造内置记录，禁止在源代码中手写与文件不符的摘要。`apps/desktop/package.json` 将 `resources/avatar/**` 纳入 Electron 构建资源。立绘保留完整画布，不裁切人物。

- [ ] **Step 4：实现目录与偏好迁移**

`AvatarModelCatalogOptions.builtinModels` 改为单个只读记录；快照最少条目从 2 改为 1，只要求 `models[0].id === "builtin:whitelily"`。读取旧偏好时规范化两个旧 ID，原子写回新 ID；旧目录中的用户记录只有在能安全转换为 64×64 皮肤记录时才保留，否则忽略并记录一次 `AVATAR_CATALOG_LEGACY_MODEL_SKIPPED`，不得导致白屏。

- [ ] **Step 5：运行目录和偏好测试**

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarModelCatalog.test.ts src-main/avatar/avatarModelPreferences.test.ts`

Expected: PASS。

- [ ] **Step 6：提交**

```powershell
git add apps/desktop/src-main/avatar apps/desktop/resources/avatar apps/desktop/package.json
git commit -m "feat: add builtin whitelily skin and portrait"
```

### Task 3：实现 64×64 皮肤与可选 portrait 的安全导入

**Files:**
- Create: `apps/desktop/src-main/avatar/pngImageValidator.ts`
- Create: `apps/desktop/src-main/avatar/pngImageValidator.test.ts`
- Modify: `apps/desktop/src-main/avatar/avatarModelImporter.ts`
- Modify: `apps/desktop/src-main/avatar/avatarModelImporter.test.ts`
- Modify: `apps/desktop/src-main/avatar/avatarModelPaths.ts`
- Modify: Electron 文件选择 IPC 的现有实现与 `apps/desktop/src/desktopApi.ts`

**Interfaces:**
- Consumes: 绝对 `skinSourcePath`、可选绝对 `portraitSourcePath`、`displayName`、`armModel: "slim" | "wide"`。
- Produces: 受管 `user/<uuid>/skin.png`、可选 `portrait.png`、无 portrait 时的 `preview.png` 与一个校验完成的 `AvatarAppearanceRecord`。

- [ ] **Step 1：写 PNG 安全验证红灯**

```ts
it("accepts only a complete 64x64 rgba skin with opaque base uv", () => {
  expect(validateMinecraftSkin(validSkinBytes()).width).toBe(64);
  expect(() => validateMinecraftSkin(png({ width: 64, height: 32, colorType: 6 }))).toThrowCode("AVATAR_SKIN_INVALID");
  expect(() => validateMinecraftSkin(png({ width: 64, height: 64, colorType: 2 }))).toThrowCode("AVATAR_SKIN_INVALID");
  expect(() => validateMinecraftSkin(skinWithTransparentBaseUv())).toThrowCode("AVATAR_SKIN_INVALID");
});

it("bounds optional portraits", () => {
  expect(validatePortrait(png({ width: 2048, height: 2048, colorType: 6 }))).toBeDefined();
  expect(() => validatePortrait(png({ width: 4097, height: 64, colorType: 6 }))).toThrowCode("AVATAR_PORTRAIT_INVALID");
});
```

- [ ] **Step 2：运行红灯**

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/pngImageValidator.test.ts src-main/avatar/avatarModelImporter.test.ts`

Expected: FAIL，当前 importer 只解析 VRM/GLB。

- [ ] **Step 3：实现有界 PNG 解析与语义检查**

复用仓库 `validate-assets.mjs` 已验证的 PNG 规则：签名、chunk 顺序、CRC、IHDR、IDAT 解压上限、IEND、8-bit RGBA、尺寸和基础 UV alpha。把共享算法移入可被 Node 工具与 Electron 调用的模块，避免复制两套不同规则。portrait 允许 1×1 至 4096×4096 RGBA PNG，压缩文件最多 8 MiB，解压字节数必须精确等于 `width * height * 4 + height`。

- [ ] **Step 4：实现两阶段原子导入**

导入顺序固定为：对打开的文件句柄前后 `stat` → 有界读取 → PNG 校验 → SHA-256 → `mkdir(staging/<uuid>)` → 独占写 `skin.png` 与可选 `portrait.png` → 从已验证皮肤生成 `preview.png` → 逐字节摘要复核 → `rename(staging, user/<uuid>)` → `catalog.appendImported(record)`。任一步失败只清理本次拥有的目录，不修改活动外观。

- [ ] **Step 5：更新文件选择和错误码**

皮肤 picker 只允许 `.png`；皮肤通过后再允许用户选择可选 portrait 或跳过。稳定错误码为 `AVATAR_SKIN_INVALID`、`AVATAR_PORTRAIT_INVALID`、`AVATAR_DIGEST_MISMATCH`、`AVATAR_IMPORT_FAILED`。取消任一 picker 返回 `{ status: "cancelled" }`，不是错误。

- [ ] **Step 6：运行 importer 与完整桌面主进程测试**

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/pngImageValidator.test.ts src-main/avatar/avatarModelImporter.test.ts src-main/avatar/avatarModelCatalog.test.ts`

Expected: PASS。

- [ ] **Step 7：提交**

```powershell
git add apps/desktop/src-main/avatar apps/desktop/src/desktopApi.ts
git commit -m "feat: import minecraft skins with optional portraits"
```

### Task 4：把页面改成不变形的单行横向外观库

**Files:**
- Modify: `apps/desktop/src/pages/AvatarModelPage.tsx`
- Modify: `apps/desktop/src/pages/AvatarModelPage.test.tsx`
- Modify: `apps/desktop/src/components/AvatarModelCard.tsx`
- Modify: `apps/desktop/src/components/AvatarModelCard.test.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/styles.test.ts`
- Modify: `apps/desktop/src/i18n/messageKeys.ts`
- Modify: `apps/desktop/src/i18n/zh-CN.ts`
- Modify: `apps/desktop/src/i18n/en.ts`

**Interfaces:**
- Consumes: `AvatarAppearanceListItem` 的 `previewDataUrl`、可选 `portraitDataUrl`、`armModel` 和活动/等待状态。
- Produces: 单行可键盘操作的外观卡列表；内置卡使用完整 portrait，用户卡优先 portrait、否则使用皮肤正面预览。

- [ ] **Step 1：写 10 个条目与图片回退红灯**

```tsx
it("keeps ten appearances in one horizontally scrollable row", async () => {
  render(<AvatarModelPage api={apiWithModels(tenModels)} locale="zh-CN" />);
  const viewport = await screen.findByTestId("avatar-model-track-viewport");
  const track = screen.getByTestId("avatar-model-track");
  expect(track.children).toHaveLength(10);
  expect(viewport.className).toContain("avatar-model-track-viewport");
  expect(track.className).toContain("avatar-model-track");
});

it("shows a stable fallback when a portrait cannot load", () => {
  render(<AvatarModelCard model={model} {...requiredProps} />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByTestId("avatar-preview-fallback")).toBeVisible();
});
```

CSS 契约测试必须断言 viewport 有 `overflow-x: auto`，track 有 `display: flex` 与 `flex-wrap: nowrap`，card 有固定 `flex` 基准，preview 有 `object-fit: contain`，并断言页面根节点没有 `overflow-x: auto`。

- [ ] **Step 2：运行红灯**

Run: `npm run test --workspace @whitelily/desktop -- src/pages/AvatarModelPage.test.tsx src/components/AvatarModelCard.test.tsx src/styles.test.ts`

Expected: FAIL，新 list item 字段、错误占位和 CSS 契约尚未接入。

- [ ] **Step 3：实现卡片图片选择与稳定占位**

`const preview = model.portraitDataUrl ?? model.previewDataUrl`。图片容器保持固定尺寸，`img` 使用 `width/height: 100%`、`object-fit: contain`、`object-position: center bottom`。`onError` 只隐藏损坏图片并显示本地 CSS 占位，不重新请求、不抛异常；内置 portrait 必须完整显示原始画布。

- [ ] **Step 4：实现单行横向布局**

```css
.avatar-model-track-viewport { min-width: 0; max-width: 100%; overflow-x: auto; overflow-y: hidden; scrollbar-gutter: stable; }
.avatar-model-track { display: flex; flex-wrap: nowrap; align-items: stretch; width: max-content; min-width: 100%; gap: 16px; }
.avatar-model-card { flex: 0 0 220px; width: 220px; }
.avatar-model-card__preview { width: 100%; height: 100%; object-fit: contain; object-position: center bottom; }
```

保留 Home/End 键和 `scrollIntoView({ inline: "nearest" })`；不使用 grid、wrap 或隐藏 scrollbar。

- [ ] **Step 5：更新中文文案与错误映射**

页面标题使用“模型与外观”，导入按钮使用“导入皮肤”，错误文案明确区分“皮肤不是 64×64 RGBA PNG”和“立绘文件无效”。不得再向用户显示 VRM、GLB、骨骼或表达式能力标签；卡片显示“纤细手臂/经典手臂”。

- [ ] **Step 6：运行页面测试与构建**

Run: `npm run test --workspace @whitelily/desktop -- src/pages/AvatarModelPage.test.tsx src/components/AvatarModelCard.test.tsx src/styles.test.ts src/i18n/i18n.test.ts`

Expected: PASS。

Run: `npm run build --workspace @whitelily/desktop`

Expected: PASS。

- [ ] **Step 7：提交**

```powershell
git add apps/desktop/src/pages/AvatarModelPage.tsx apps/desktop/src/pages/AvatarModelPage.test.tsx apps/desktop/src/components/AvatarModelCard.tsx apps/desktop/src/components/AvatarModelCard.test.tsx apps/desktop/src/styles.css apps/desktop/src/styles.test.ts apps/desktop/src/i18n
git commit -m "feat: show horizontal minecraft skin library"
```

### Task 5：完成 IPC、桥切换和故障隔离回归

**Files:**
- Modify: `apps/desktop/src-main/avatar/avatarModelSwitchCoordinator.ts`
- Modify: `apps/desktop/src-main/avatar/avatarModelSwitchCoordinator.test.ts`
- Create: `apps/desktop/src-main/avatar/avatarAppearanceSnapshotProjector.ts`
- Create: `apps/desktop/src-main/avatar/avatarAppearanceSnapshotProjector.test.ts`
- Create: `apps/desktop/src-main/avatar/avatarApprovedSkinCatalog.ts`
- Create: `apps/desktop/src-main/avatar/avatarApprovedSkinCatalog.test.ts`
- Create: `apps/desktop/src-main/avatar/avatarModelComposition.ts`
- Create: `apps/desktop/src-main/avatar/avatarModelComposition.test.ts`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/skin/ApprovedSkinCatalog.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/skin/ApprovedSkinCatalogTest.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/skin/NativeSkinCandidateRuntime.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/skin/WhiteLilySkinCatalog.java`
- Modify: `apps/desktop/src-main/main.ts`
- Modify: `apps/desktop/src-main/preload.ts`
- Modify: `apps/desktop/src-main/ipcRegistry.test.ts`
- Modify: `apps/desktop/src/desktopApi.ts`
- Create: `apps/desktop/src-main/avatar/avatarNativeSkinE2e.test.ts`
- Create: `docs/testing/whitelily-desktop-appearance-manual-checklist.md`

**Interfaces:**
- Consumes: 本计划 Tasks 1–4 的单内置目录、用户皮肤 importer 和 `minecraft-skin` descriptor，以及 `2026-08-21-whitelily-native-skin-runtime.md` Task 4 创建的 `NativeSkinCandidateRuntime`/`WhiteLilySkinCatalog`。
- Produces: 原子外观切换、重启持久化、图片故障隔离和完整人工验收证据。

- [ ] **Step 1：写切换失败保留旧外观的端到端红灯**

```ts
it("keeps the previous skin when the first native frame fails", async () => {
  const app = await launchHarness({ activeModelId: "builtin:whitelily" });
  const imported = await app.importSkin(validSkinPath);
  await app.switchTo(imported.id);
  await app.fabricReply("ready");
  await app.fabricReply("failed", "AVATAR_FRAME_FAILED");
  expect((await app.list()).activeModelId).toBe("builtin:whitelily");
  await app.restart();
  expect((await app.list()).activeModelId).toBe("builtin:whitelily");
});
```

再增加三类红灯：portrait data URL 构建失败时列表仍返回皮肤 preview；`avatarApprovedSkinCatalog.test.ts` 断言只发布记录中的受管相对路径和实际 SHA-256；`ApprovedSkinCatalogTest` 断言路径穿越、符号链接、摘要漂移和非 64×64 RGBA 文件全部被拒绝，且拒绝后活动候选不变。

- [ ] **Step 2：运行红灯**

Run: `npm run test --workspace @whitelily/desktop -- src-main/avatar/avatarNativeSkinE2e.test.ts src-main/avatar/avatarModelSwitchCoordinator.test.ts`

Expected: FAIL，旧 coordinator 仍发送 3D descriptor。

- [ ] **Step 3：原子发布并读取已批准皮肤清单**

`avatarApprovedSkinCatalog` 从已校验 catalog 记录生成 `schemaVersion: 1` 文档，每个条目只含 `id/origin/skinAsset/skinSha256/armModel`，原子写入 `<dataRoot>/bridge/avatar-model/approved-skins.json`。`ApprovedSkinCatalog` 使用与 mailbox 相同的有界普通文件规则读取文档，将相对路径解析到 `<dataRoot>/models` 后再次验证 real path 边界、非符号链接、64×64 RGBA、基础 UV alpha 和 SHA-256；任一失败都拒绝候选并保留当前皮肤。

- [ ] **Step 4：发送无路径 descriptor 并准备动态原生皮肤**

prepare 请求只包含 `modelId/origin/worldRenderer/armModel`。`NativeSkinCandidateRuntime.prepare` 按 ID 从 `ApprovedSkinCatalog` 取得已复核像素，在 Minecraft render executor 上注册独立动态 `ResourceLocation` 并构造 `PlayerSkin`；内置 ID 仍使用六主题 bundled catalog，用户 ID 永远只使用自己的单张皮肤。ready 后发送 commit，只有首个原版皮肤帧 `committed` 才持久化新 ID。换世界、取消、超时或首帧失败都回到旧 `PlayerSkin` 并释放未激活动态贴图，不能重启任务或改变动作队列。

- [ ] **Step 5：隔离 preview/portrait 读取失败**

`avatarAppearanceSnapshotProjector` 对每条记录单独有界读取并校验摘要。portrait 失败时回退 `preview.png`；preview 也失败时提供内置占位 PNG data URL。单条资源失败只记录一次无绝对路径的诊断，不使页面白屏。`avatarModelComposition` 构造 catalog、importer、preferences、mailbox、projector 和 switch coordinator；`main.ts` 将其作为 `avatarModels` 传给现有 `registerIpc`，并在应用退出时注销订阅。

- [ ] **Step 6：运行全量自动验证**

Run: `npm run test`

Expected: PASS。

Run: `npm run desktop:test`

Expected: PASS。

Run: `npm run avatar:check`

Expected: PASS。

Run: `npm run typecheck && npm run desktop:build`

Expected: PASS。

- [ ] **Step 7：完成 10 条目与真实世界人工验收**

清单记录 736px 和 360px 两种窗口宽度：10 个条目仍单行、第一张内置原稿完整、最后一张可通过滚动条访问、根页面不横向滚动、损坏 portrait 有占位且 AI 仍回复。再进入 Minecraft 验证内置和一个用户皮肤切换、重启恢复、换世界取消、手持物/动作/睡眠、动作队列和立即叫停均正常。最终生成并向用户展示“用户原稿 / 软件内完整 2D 立绘 / Minecraft 原生皮肤前后视”对照，只有获得明确确认才完成视觉验收。

- [ ] **Step 8：提交**

```powershell
git add apps/desktop/src-main/avatar apps/desktop/src-main/main.ts apps/desktop/src-main/preload.ts apps/desktop/src-main/ipcRegistry.test.ts apps/desktop/src/desktopApi.ts subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/skin subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/skin docs/testing/whitelily-desktop-appearance-manual-checklist.md
git commit -m "test: verify native skin appearance flow end to end"
```
