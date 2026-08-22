# WhiteLily Minecraft 原生皮肤运行时实施计划

> **供代理执行者使用：** 必须逐任务使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。所有步骤使用复选框跟踪。

**目标：** 让匹配到的 WhiteLily 玩家始终由 Minecraft 1.21.5 原生纤细玩家模型渲染，并根据装备在六张已审核皮肤之间安全切换，不再启动或调用 WhiteLily 的 Gecko/GLB/自定义 shader 渲染链。

**架构：** 保留现有身份识别和装备主题解析，把它们的结果交给一个只返回受信任 `ResourceLocation` 的原生皮肤目录。`PlayerRendererMixin` 仅在 `extractRenderState` 结束时替换 `PlayerRenderState.skin`，不捕获几何、不取消原版 `LivingEntityRenderer`，因此原版动作、手持物、睡眠和渲染层继续生效。模型切换桥在迁移期只把旧内置 ID 视为同一原生 WhiteLily 外观别名，不读取几何资产；桌面端迁移完成后再移除别名。

**技术栈：** Java 21、Fabric Loader 0.16.14、Minecraft 1.21.5、Mixin、JUnit 5、Node.js 资产验证器。

**规格：** `docs/superpowers/specs/2026-08-21-minecraft-native-skin-and-2d-portrait-design.md`

## 全局约束

- 正式世界渲染模式固定为 `minecraft-skin`，手臂固定为 `slim`。
- 六主题顺序固定为 `base`、`leather`、`iron`、`gold`、`diamond`、`netherite`。
- 主题非法、资源缺失或资源构造失败时回退 `base`；不得接受桌面端发送的任意文件路径。
- 匹配成功也不得取消 Minecraft 原版玩家渲染。
- `builtin:whitelily` 及迁移期旧内置别名不得预加载 GLB、GPU 蒙皮、Gecko 几何或自定义 shader。
- 现有 Blender、GLB、Gecko 和 entity texture 研究文件保留在 Git 历史与工作树，不在本计划中删除。
- 外观失败不得影响 Minecraft 连接、AI 对话、动作队列或立即叫停。

---

### Task 1：把资产清单收敛为原生皮肤声明

**Files:**
- Modify: `subprojects/whitelily-avatar/assets/manifest.json`
- Modify: `subprojects/whitelily-avatar/tools/validate-assets.mjs`
- Modify: `subprojects/whitelily-avatar/tools/validate-assets.test.mjs`

**Interfaces:**
- Consumes: 六张 `assets/whitelily_avatar/textures/skin/<theme>.png` 和六张稳定前视预览。
- Produces: `manifest.worldRenderer: "minecraft-skin"`、`manifest.armModel: "slim"`、`manifest.defaultTheme: "base"` 与按主题索引的受信任皮肤条目。

- [ ] **Step 1：先写失败的清单契约测试**

```js
test("declares the native slim renderer and six exact skins", async () => {
  const manifest = JSON.parse(await readFile(join(ASSET_ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.worldRenderer, "minecraft-skin");
  assert.equal(manifest.armModel, "slim");
  assert.equal(manifest.defaultTheme, "base");
  assert.deepEqual(
    manifest.skins.map(({ theme }) => theme),
    ["base", "leather", "iron", "gold", "diamond", "netherite"],
  );
  assert.equal(
    manifest.runtimeAssets.some(({ path }) => /geckolib|textures\/entity|shader|\.glb$/u.test(path)),
    false,
  );
});
```

- [ ] **Step 2：运行红灯**

Run: `node --test subprojects/whitelily-avatar/tools/validate-assets.test.mjs`

Expected: FAIL，当前清单没有 `worldRenderer/armModel/defaultTheme`，且 `runtimeAssets` 仍声明 Gecko/entity 资源。

- [ ] **Step 3：实现清单与验证规则**

在 `manifest.json` 顶层加入：

```json
{
  "worldRenderer": "minecraft-skin",
  "armModel": "slim",
  "defaultTheme": "base"
}
```

保留六张皮肤、预览、概念图和原稿的审计声明；`runtimeAssets` 只列六张 `textures/skin/*.png`。在 `validate-assets.mjs` 中删除运行时必须包含 Gecko 几何/entity texture 的要求，保留并继续执行 64×64 RGBA、必需基础 UV 不透明、叠加层语义、摘要和路径边界验证。

- [ ] **Step 4：运行资产验证**

Run: `node --test subprojects/whitelily-avatar/tools/validate-assets.test.mjs`

Expected: PASS。

Run: `node subprojects/whitelily-avatar/tools/validate-assets.mjs`

Expected: 输出验证成功且退出码为 0。

- [ ] **Step 5：提交**

```powershell
git add subprojects/whitelily-avatar/assets/manifest.json subprojects/whitelily-avatar/tools/validate-assets.mjs subprojects/whitelily-avatar/tools/validate-assets.test.mjs
git commit -m "refactor: declare native whitelily skin assets"
```

### Task 2：实现六主题原生皮肤目录与安全回退

**Files:**
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/skin/WhiteLilySkinCatalog.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/skin/WhiteLilySkinCatalogTest.java`

**Interfaces:**
- Consumes: `ArmorTheme`，允许传入 `null` 以覆盖非法/缺失主题回退。
- Produces: `PlayerSkin skinFor(ArmorTheme theme)`；始终返回 `PlayerSkin.Model.SLIM`，贴图只来自 `whitelily_avatar:textures/skin/<theme>.png`。

- [ ] **Step 1：写目录红灯测试**

```java
@Test
void mapsEveryThemeToItsBundledSlimSkin() {
  WhiteLilySkinCatalog catalog = new WhiteLilySkinCatalog();
  for (ArmorTheme theme : ArmorTheme.values()) {
    PlayerSkin skin = catalog.skinFor(theme);
    assertEquals(PlayerSkin.Model.SLIM, skin.model());
    assertEquals(
        ResourceLocation.fromNamespaceAndPath(
            "whitelily_avatar", "textures/skin/" + theme.name().toLowerCase(Locale.ROOT) + ".png"),
        skin.texture());
  }
}

@Test
void fallsBackToBaseForMissingTheme() {
  assertEquals(
      ResourceLocation.fromNamespaceAndPath("whitelily_avatar", "textures/skin/base.png"),
      new WhiteLilySkinCatalog().skinFor(null).texture());
}
```

- [ ] **Step 2：运行红灯**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.skin.WhiteLilySkinCatalogTest"`

Expected: FAIL，`WhiteLilySkinCatalog` 尚不存在。

- [ ] **Step 3：实现最小受信任目录**

```java
public final class WhiteLilySkinCatalog {
  private static final String NAMESPACE = "whitelily_avatar";
  private final Map<ArmorTheme, PlayerSkin> skins;

  public WhiteLilySkinCatalog() {
    EnumMap<ArmorTheme, PlayerSkin> built = new EnumMap<>(ArmorTheme.class);
    for (ArmorTheme theme : ArmorTheme.values()) {
      String name = theme.name().toLowerCase(Locale.ROOT);
      ResourceLocation texture =
          ResourceLocation.fromNamespaceAndPath(NAMESPACE, "textures/skin/" + name + ".png");
      built.put(theme, new PlayerSkin(texture, null, null, null, PlayerSkin.Model.SLIM, true));
    }
    skins = Map.copyOf(built);
  }

  public PlayerSkin skinFor(ArmorTheme theme) {
    return skins.getOrDefault(theme == null ? ArmorTheme.BASE : theme, skins.get(ArmorTheme.BASE));
  }
}
```

- [ ] **Step 4：运行目录和主题回归测试**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.skin.*" --tests "io.github.whitelily.avatar.theme.*" --tests "io.github.whitelily.avatar.render.EquipmentThemeInputAdapterTest"`

Expected: PASS。

- [ ] **Step 5：提交**

```powershell
git add subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/skin subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/skin
git commit -m "feat: add trusted native skin catalog"
```

### Task 3：把匹配玩家接入原版 PlayerRenderer

**Files:**
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/mixin/PlayerRendererMixin.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/mixin/LivingEntityRendererMixin.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/WhiteLilyRenderDecision.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/NativeSkinRenderContractTest.java`

**Interfaces:**
- Consumes: `WhiteLilyRenderRuntime.captureDecision(AbstractClientPlayer)` 与 Task 2 的 `skinFor(ArmorTheme)`。
- Produces: 匹配玩家的 `PlayerRenderState.skin` 替换；未匹配、会话失效或异常时保持进入 mixin 前的原版 `PlayerSkin`。

- [ ] **Step 1：写不取消原版渲染的契约红灯**

```java
@Test
void playerMixinOnlyReplacesTheSkinOnAMatchedDecision() throws Exception {
  String source = Files.readString(projectFile("src/main/java/io/github/whitelily/avatar/mixin/PlayerRendererMixin.java"));
  assertTrue(source.contains("playerRenderState.skin = SKINS.skinFor(decision.armorTheme())"));
  assertFalse(source.contains("WhiteLilyGeoRenderer"));
  assertFalse(source.contains("captureRenderState("));
}

@Test
void livingRendererCannotCancelVanillaForWhitelily() throws Exception {
  String mixins = Files.readString(projectFile("src/main/resources/whitelily_avatar.mixins.json"));
  assertFalse(mixins.contains("LivingEntityRendererMixin"));
}
```

- [ ] **Step 2：运行红灯**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.render.NativeSkinRenderContractTest"`

Expected: FAIL，当前 mixin 构造 Gecko renderer 并由 `LivingEntityRendererMixin` 取消原版帧。

- [ ] **Step 3：替换为皮肤注入**

`PlayerRendererMixin` 保留 `extractRenderState(..., @At("RETURN"))` 注入点，先通知模型控制器渲染边界，再捕获身份/主题决定；只在 `decision.usesNativeSkin()` 为真时执行：

```java
PlayerSkin original = playerRenderState.skin;
try {
  playerRenderState.skin = SKINS.skinFor(decision.armorTheme());
  WhiteLilyAvatarClient.onNativeSkinFrameVisible();
} catch (RuntimeException error) {
  playerRenderState.skin = original;
  WhiteLilyAvatarClient.reportNativeSkinFailure(error);
}
```

`WhiteLilyRenderDecision` 增加 `usesNativeSkin()` 并复用现有已匹配/会话有效判定；为使旧研究类仍可编译，保留 `usesCustomRenderer/canRenderCustomIn/expressionCapable` 等兼容方法，但正式 mixin 不再调用它们。`hidesVanillaArmor()` 和 `rendersHeldItem()` 固定返回 `false`。未匹配玩家不写 `playerRenderState.skin`。

- [ ] **Step 4：停用会取消原版渲染的 mixin**

从 `whitelily_avatar.mixins.json` 移除 `LivingEntityRendererMixin` 和仅服务于捕获状态的 `PlayerRenderStateMixin`。把 `LivingEntityRendererMixin` 收敛为空 mixin，使它不再引用 client registry 或 cancellation API；旧实现仍可从 Git 历史恢复。两者都不进入 mixin 配置、不在运行时执行。

- [ ] **Step 5：运行渲染、身份和 mixin 回归测试**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.render.NativeSkinRenderContractTest" --tests "io.github.whitelily.avatar.render.WhiteLilyRenderDecisionTest" --tests "io.github.whitelily.avatar.identity.*"`

Expected: PASS。

- [ ] **Step 6：提交**

```powershell
git add subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/mixin/PlayerRendererMixin.java subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/mixin/LivingEntityRendererMixin.java subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/WhiteLilyRenderDecision.java subprojects/whitelily-avatar/mod-fabric/src/main/resources/whitelily_avatar.mixins.json subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/NativeSkinRenderContractTest.java subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/WhiteLilyRenderDecisionTest.java
git commit -m "feat: render whitelily with vanilla player skin"
```

### Task 4：停止内置 WhiteLily 的 3D 预加载并保持桥切换原子性

**Files:**
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/skin/NativeSkinCandidateRuntime.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/skin/NativeSkinCandidateRuntimeTest.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/WhiteLilyAvatarClient.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/RuntimeBridgeApprovalContractTest.java`

**Interfaces:**
- Consumes: 迁移期桌面端发来的两个旧内置 ID 与 `minecraft-skin` 新描述符。
- Produces: 不读取文件的 `AvatarCandidateRuntime`；`requestCommit` 后等待下一次成功的原版皮肤帧，再向 `AvatarModelController` 报告 `COMPLETE`。

- [ ] **Step 1：写无 3D 预加载和首帧确认红灯**

```java
@Test
void preparesBuiltinSkinWithoutLoadingGeometry() {
  NativeSkinCandidateRuntime runtime = new NativeSkinCandidateRuntime();
  PreparedCandidate candidate = runtime.prepare(descriptor("minecraft-skin")).toCompletableFuture().join();
  runtime.requestCommit(candidate);
  assertTrue(runtime.consumeVisibleCommit().isPresent());
}

@Test
void clientDoesNotConstructAnyCustomGeometryBackend() throws Exception {
  String source = Files.readString(projectFile("src/main/java/io/github/whitelily/avatar/WhiteLilyAvatarClient.java"));
  assertFalse(source.contains("SmoothMeshRenderBackend"));
  assertFalse(source.contains("ClassicGeckoRenderBackend"));
  assertFalse(source.contains("AvatarRenderBackendRegistry"));
}
```

- [ ] **Step 2：运行红灯**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.skin.NativeSkinCandidateRuntimeTest" --tests "io.github.whitelily.avatar.render.RuntimeBridgeApprovalContractTest"`

Expected: FAIL，客户端当前创建 classic、HD、GLB、VRM 后端并预备 Gecko 候选。

- [ ] **Step 3：实现无文件 I/O 的候选运行时**

`NativeSkinCandidateRuntime.prepare` 只接受受支持的内置 ID 和格式，不解析 `resourcePath`，返回不可变候选；`requestCommit` 原子记录候选；`consumeVisibleCommit` 仅消费一次等待首帧的候选；`cancel/release` 清理同一候选且不得影响当前有效皮肤。迁移期允许：

```java
private static final Set<String> BUILTIN_IDS = Set.of(
    "builtin:whitelily",
    "builtin:whitelily-hd",
    "builtin:whitelily-classic");
private static final Set<String> FORMATS = Set.of(
    "minecraft-skin",
    "builtin-hd",
    "builtin-classic");
```

旧格式只作为协议兼容别名，不创建旧 renderer。

- [ ] **Step 4：把客户端初始化切到原生候选运行时**

删除 `smoothBackends`、registry 初始 prepare/activate 和所有 3D backend import。`onRenderBoundary` 仍驱动控制器 commit；`onNativeSkinFrameVisible` 只在 runtime 有待确认候选时调用 `controller.onVisibleFrameResult(COMPLETE)`。失败只记录稳定错误码 `WL_AVATAR_SKIN_001`，不抛到 Minecraft render loop。

- [ ] **Step 5：运行控制协议和完整 Fabric 测试**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test`

Expected: PASS；测试源码与初始化路径均不含内置 3D 后端构造。

- [ ] **Step 6：提交**

```powershell
git add subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/skin subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/WhiteLilyAvatarClient.java subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/skin subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/RuntimeBridgeApprovalContractTest.java
git commit -m "refactor: remove builtin 3d renderer preload"
```

### Task 5：更新发布边界并完成真实 Minecraft 验收

**Files:**
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/packaging/ComponentPackJarContractTest.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/packaging/ComponentPackPolicy.java`
- Modify: `subprojects/whitelily-avatar/build.gradle.kts`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/resources/fabric.mod.json`
- Modify: `subprojects/whitelily-avatar/tools/stage-minecraft-components.test.mjs`
- Modify: `packaging/electron/runtime-manifest.json`
- Modify: `apps/desktop/src-main/main.ts`
- Modify: `apps/desktop/src-main/mainMinecraftComponents.test.ts`
- Modify: `apps/desktop/src-main/minecraftComponents.test.ts`
- Create: `docs/testing/whitelily-native-skin-manual-checklist.md`

**Interfaces:**
- Consumes: Tasks 1–4 的 Fabric JAR 与六张皮肤。
- Produces: 只把六张原生皮肤视为 WhiteLily 必需运行时外观资源的可发布组件，以及一份真实世界验收记录模板。

- [ ] **Step 1：写发布边界红灯**

把 `AVATAR_THEME_RESOURCES` 改为六张 `textures/skin/*.png`，增加：

```java
@Test
void avatarJarDoesNotPublishCustomSkinningShaders() throws Exception {
  assertFalse(hasEntryPrefix(AVATAR, "assets/whitelily_avatar/shaders/"));
}
```

同时把“删任一主题即失败”的变异目标改为 `textures/skin/gold.png`。

- [ ] **Step 2：运行红灯**

Run: `npm run avatar:check`

Expected: FAIL，旧发布契约仍要求 Gecko/entity 资源，JAR 仍可能包含自定义 shader。

- [ ] **Step 3：收敛发布资源边界**

在 Fabric `processResources` 中排除 `assets/whitelily_avatar/shaders/**`、`assets/whitelily_avatar/geckolib/**` 和 `assets/whitelily_avatar/textures/entity/**`；不删除源文件。GeckoLib 从 `modImplementation` 改为仅编译旧研究类所需的 `modCompileOnly`，从 `fabric.mod.json`、staging 产物、Electron runtime manifest 和桌面 Minecraft 组件清单中删除 GeckoLib 运行时依赖。更新组件策略，只要求六张皮肤且继续拒绝未声明 JAR、原生可执行文件、跨组件类复制和摘要漂移。

- [ ] **Step 4：完成自动验证**

Run: `npm run avatar:check`

Expected: PASS。

Run: `npm run test && npm run typecheck`

Expected: PASS。

- [ ] **Step 5：启动真实 Minecraft 并按清单验收**

`docs/testing/whitelily-native-skin-manual-checklist.md` 必须逐项记录：前/后/左/右/俯/仰视；六主题；空手和主副手物品；行走、跑、跳、游泳、挥击、挖矿、钓鱼、进食和睡觉；换世界；损坏候选回退；AI 对话；动作队列；“先停下来吧”和“先来帮我一下”下一次有效状态更新立即退出工作动作。任何一项失败都不得把任务标记为完成。

- [ ] **Step 6：提交**

```powershell
git add subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/packaging subprojects/whitelily-avatar/build.gradle.kts subprojects/whitelily-avatar/mod-fabric/src/main/resources/fabric.mod.json subprojects/whitelily-avatar/tools/stage-minecraft-components.test.mjs packaging/electron/runtime-manifest.json apps/desktop/src-main/main.ts apps/desktop/src-main/mainMinecraftComponents.test.ts apps/desktop/src-main/minecraftComponents.test.ts docs/testing/whitelily-native-skin-manual-checklist.md
git commit -m "test: verify native skin runtime package"
```
