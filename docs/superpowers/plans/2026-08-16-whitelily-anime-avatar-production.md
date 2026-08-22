# WhiteLily 高清非方块化动漫人物生产 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以用户提供的两张设定图为唯一艺术事实来源，制作可复现导出的 WhiteLily 高清/轻量平滑蒙皮 3D 模型、2K 赛璐璐贴图、六种装备主题、完整首批动作与表情，并通过自动验证、真实 Minecraft 测试和用户对照图验收。

**Architecture:** Blender 4.5.3 LTS 的受版本控制 `.blend` 是人物形体、骨架、权重、材质、装备和动画的唯一源工程，所有 GLB、贴图图集、清单和预览均由无交互脚本重建，禁止手改导出产物。该计划消费《人物模型库、导入与安全热切换》计划提供的 `WhiteLilyAvatarRenderBackend`、语义骨架、LOD、材质降级和热切换接口；每个艺术阶段先通过机器可测合同，再生成固定相机对照图进行视觉审核，最终以用户明确确认作为完成门槛。

**Tech Stack:** Blender 4.5.3 LTS、Blender Python API、glTF 2.0/GLB、Python 3.11（Blender 内置）、Node.js 24、Vitest 4、Java 21、Minecraft 1.21.5、Fabric Loader 0.16.14、Fabric API 0.128.2+1.21.5、Three.js 0.180.0。

## Global Constraints

- 艺术事实只来自 `subprojects/whitelily-avatar/assets/source/whitelily-turnaround.png` 和 `subprojects/whitelily-avatar/assets/source/whitelily-armor-themes.png`；现有 `.bbmodel`、64×64 皮肤、旧预览和程序化方块模型没有艺术决定权。
- 不保留 Minecraft 方块人物风格；high 和 low 都必须是圆润脸型、自然人体比例和连续曲面的日系动漫 3D 造型，不得出现方块头、长方体躯干、原版四肢或方块盔甲轮廓。
- 人物必须清晰保留银白长发、绿色眼睛、白/浅绿/金色服装、双层裙摆、宽袖、后腰蝴蝶结和右侧百合花；颜色直接从设定图取样，不重新设计。
- 近距离主图集固定为 2048×2048；只使用两到三段赛璐璐明暗和克制边缘高光，不制作写实塑料、真实毛发或大面积半透明材质。
- 六种主题固定为 `base`、`leather`、`iron`、`gold`、`diamond`、`netherite`；装备是可切换非方块化 3D 附件，不直接套用原版方块盔甲。
- `high` 首次在 `<=16` 格使用，`low` 首次在 `>16` 格使用；high→low 阈值为 `>18`，low→high 阈值为 `<14`，14–18 格保持当前级别。
- 首批动作包含待机、呼吸、眨眼、注视、说话、行走、奔跑、跳跃、游泳、战斗、受伤、钓鱼、挖矿、制作、熔炼、耕地、播种、收割、进食、建造、睡觉和醒来；本次不制作坐下。
- 表情至少包含自然、开心、专注、担心和疲惫；表达由语义状态驱动，不机械轮播；无表情数据时保持自然脸。
- 长发、宽袖和裙摆可使用受限次级骨骼动态或预设随动，不得使用会改变 Minecraft 物理、碰撞或规则的模拟。
- 收到立即叫停后的下一次有效状态更新必须退出工作动作；旧会话或旧任务动画事件不能重新启动被取消动作。
- 自定义用户模型不得自动套用本计划的 WhiteLily 专属装备；本计划资产只用于 `builtin:whitelily-hd`。
- 任何外观故障不得造成 Minecraft 退出、桌面端白屏、AI 对话失效、动作队列失效或立即叫停失效。
- 目标电脑、同世界、同视角、同图形设置下，一名 high WhiteLily 位于 8 格内时，稳定后的 95 分位帧时间增量目标不超过 2ms；low 不得比 high 更慢。
- 所有正式预览必须由仓库内命令重建；在用户明确确认最终对照图之前，不得删除原始设定图，也不得宣称人物模型完成。

---

### Task 1: 固定 Blender 源工程、命名和可复现构建入口

**Files:**
- Create: `subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend`
- Create: `subprojects/whitelily-avatar/assets/blender/export-profile.json`
- Create: `subprojects/whitelily-avatar/tools/blender/bootstrap_avatar.py`
- Create: `subprojects/whitelily-avatar/tools/blender/avatar_contract.py`
- Create: `subprojects/whitelily-avatar/tools/blender/validate_avatar.py`
- Create: `subprojects/whitelily-avatar/tools/blender/validate_blender_version.py`
- Create: `subprojects/whitelily-avatar/tools/blender/tests/test_avatar_contract.py`
- Create: `subprojects/whitelily-avatar/tools/build-anime-avatar.mjs`
- Create: `subprojects/whitelily-avatar/tools/build-anime-avatar.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Blender 4.5.3 LTS、两张原始设定图和现有 asset license。
- Produces: 受控 `.blend`、`AVATAR_CONTRACT`、`npm run avatar:anime:build`、`npm run avatar:anime:check`。

- [ ] **Step 1: 写版本、源摘要、集合和对象合同失败测试**

```python
def test_contract_names_are_stable():
    assert REQUIRED_COLLECTIONS == (
        "REF", "BODY_HIGH", "BODY_LOW", "OUTFIT_BASE", "ARMOR",
        "RIG", "CAMERAS", "LIGHTS"
    )
    assert REQUIRED_SOURCE_DIGESTS == {
        "whitelily-turnaround.png": "572e52d22255c9d36328c48a114dfe30f89988b676122b7025a16af062935cd6",
        "whitelily-armor-themes.png": "8bfa790fbfac1c5e5816765fac5d4466fdb856b9c3fa407c725b9c29270d5a46",
    }
```

```js
test("refuses a Blender version other than 4.5.3", async () => {
  await assert.rejects(
    buildAnimeAvatar({ blenderVersion: "4.5.2" }),
    /BLENDER_VERSION_MISMATCH/,
  );
});
```

- [ ] **Step 2: 运行红灯**

Run: `node --test subprojects/whitelily-avatar/tools/build-anime-avatar.test.mjs`

Expected: FAIL，缺少构建器。

Run: `blender --background --factory-startup --python subprojects/whitelily-avatar/tools/blender/tests/test_avatar_contract.py`

Expected: FAIL，缺少 `avatar_contract.py`。

- [ ] **Step 3: 定义源工程合同和固定导出配置**

```python
BLENDER_VERSION = (4, 5, 3)
UNIT_SCALE = 1.0
CHARACTER_HEIGHT_METERS = 1.80
HIGH_TRIANGLE_RANGE = (45_000, 85_000)
LOW_TRIANGLE_RANGE = (14_000, 28_000)
MAX_JOINTS = 128
MAX_WEIGHTS_PER_VERTEX = 4
TEXTURE_SIZE = 2048
THEMES = ("base", "leather", "iron", "gold", "diamond", "netherite")
```

`export-profile.json` 固定 glTF 2.0、GLB、Y-up、meters、apply modifiers、skins、animations、morph targets、images embedded、无 Draco、无外部 URI、4 weights、采样 30fps。正式构建检查 Blender 版本、源图片摘要、asset-license、dirty scene 未保存状态、相对路径和所有资源打包状态；任一不符以稳定错误码退出非零。

- [ ] **Step 4: 用 bootstrap 创建一次源工程骨架并保存 `.blend`**

Run: `blender --background --factory-startup --python subprojects/whitelily-avatar/tools/blender/bootstrap_avatar.py -- --output subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend`

Expected: 创建包含八个固定 collection、正交相机 `CAM_FRONT/CAM_BACK/CAM_LEFT/CAM_RIGHT/CAM_TOP/CAM_BOTTOM`、固定三点灯光、两张不可渲染 reference plane 和场景自定义属性 `whitelily_asset_schema=3` 的 `.blend`。

bootstrap 只负责确定性场景结构、命名、相机、灯光和引用，不自由生成最终人物造型；正式形体必须在后续任务的受控源工程中完成。

- [ ] **Step 5: 实现 Node 编排器和 package scripts**

```json
{
  "scripts": {
    "avatar:anime:build": "node subprojects/whitelily-avatar/tools/build-anime-avatar.mjs --export --render-previews",
    "avatar:anime:check": "node subprojects/whitelily-avatar/tools/build-anime-avatar.mjs --verify"
  }
}
```

编排器只使用 `spawn()` 参数数组启动 Blender，不拼接 shell 字符串；先运行版本/源摘要校验，再运行 `.blend` 合同校验、导出和预览，所有输出进入临时目录，通过后原子替换生成目录。日志不得包含用户目录之外的敏感路径。

所有 `tools/blender/tests/test_*.py` 使用 Python 标准库 `unittest`，文件末尾固定调用 `unittest.main(argv=[__file__])`，因此上面的 Blender `--python` 命令会实际执行测试并以断言结果设置退出码，不依赖 Blender 环境之外的 pytest。

- [ ] **Step 6: 跑绿并提交**

Run: `node --test subprojects/whitelily-avatar/tools/build-anime-avatar.test.mjs`

Expected: PASS。

Run: `npm run avatar:anime:check`

Expected: PASS，初始源工程结构通过但形体阶段以 `AVATAR_ART_STAGE=bootstrap` 明确标记，不能被发布清单接受。

```powershell
git add package.json subprojects/whitelily-avatar/assets/blender subprojects/whitelily-avatar/tools/blender subprojects/whitelily-avatar/tools/build-anime-avatar.mjs subprojects/whitelily-avatar/tools/build-anime-avatar.test.mjs
git commit -m "build: establish reproducible anime avatar source"
```

### Task 2: 制作基础 high 形体和立体服装结构

**Files:**
- Modify: `subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend`
- Create: `subprojects/whitelily-avatar/tools/blender/validate_silhouette.py`
- Create: `subprojects/whitelily-avatar/tools/blender/tests/test_body_high_contract.py`
- Create: `subprojects/whitelily-avatar/assets/measurements/base-silhouette.json`
- Create: `subprojects/whitelily-avatar/assets/review/body-high/README.md`

**Interfaces:**
- Consumes: Task 1 固定场景、用户基础设定图。
- Produces: `BODY_HIGH`、`OUTFIT_BASE`，自然比例、可蒙皮拓扑和固定轮廓测量。

- [ ] **Step 1: 写 high 形体结构失败测试**

```python
def test_body_high_is_smooth_and_complete(scene):
    assert 45_000 <= triangle_count("BODY_HIGH", "OUTFIT_BASE") <= 85_000
    assert abs(bounding_height("BODY_HIGH") - 1.80) <= 0.01
    assert all_quads_before_triangulation("Body", "Face", "Hair", "DressBase")
    assert has_objects(
        "Face", "Eyes", "HairFront", "HairBack", "HairSideL", "HairSideR",
        "LilyHairpin", "SleeveL", "SleeveR", "SkirtInner", "SkirtOuter",
        "BackRibbon"
    )
    assert no_axis_aligned_box_larger_than(0.08)
```

- [ ] **Step 2: 运行红灯**

Run: `blender --background subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend --python subprojects/whitelily-avatar/tools/blender/tests/test_body_high_contract.py`

Expected: FAIL，bootstrap 场景还没有正式 high 网格。

- [ ] **Step 3: 完成自然比例基础身体和动漫脸**

在正/侧 reference plane 同时校准：总高 1.80m，头高占总高 1/6.3–1/6.8，肩宽 0.34–0.40m，骨盆到脚底保持自然腿长；脸部为连续曲面而不是方盒，保留柔和下颌、小鼻体积、绿色大眼但不做夸张头身。眼白、虹膜、瞳孔和高光为独立可控层；眼睑拓扑支持眨眼，嘴部环线支持口型和五种表情。对称阶段完成后保留必要非对称：右侧百合花、发束和原稿装饰。

- [ ] **Step 4: 完成立体长发、宽袖、双层裙摆、蝴蝶结和百合花**

长发分前刘海、两侧发束、后发主体和 6–10 个可随动发束；宽袖拥有内外表面和肩/肘活动余量；内外裙摆是两个独立连续曲面，静止时不穿腿；后腰蝴蝶结有结心、左右结片和垂带；百合花至少有 6 枚花瓣、花蕊和固定底座。所有可见厚度使用真实薄壳或实体厚度，不用互相穿插的单面卡片伪造主体结构。

- [ ] **Step 5: 建立可复现轮廓测量**

`validate_silhouette.py` 用六个固定正交相机渲染纯白遮罩，记录 1024×1024 alpha silhouette、人物边界和关键点。`base-silhouette.json` 固定正/背/左/右视图的头顶、下巴、肩、腰、裙摆、袖口、脚底、百合花和蝴蝶结归一化坐标；后续修改每个关键点最大漂移 2.5% 画幅、主体 silhouette IoU 不低于 0.94，除非用户批准新的基线。

- [ ] **Step 6: 跑结构和轮廓检查，生成首轮白模图**

Run: `npm run avatar:anime:check -- --stage body-high`

Expected: PASS，生成 `assets/review/body-high/front.png`、`back.png`、`left.png`、`right.png` 和四图 contact sheet；图中只有平滑白模，不得出现方块头、长方体躯干或方块四肢。

- [ ] **Step 7: 提交**

```powershell
git add subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend subprojects/whitelily-avatar/assets/measurements/base-silhouette.json subprojects/whitelily-avatar/assets/review/body-high subprojects/whitelily-avatar/tools/blender/validate_silhouette.py subprojects/whitelily-avatar/tools/blender/tests/test_body_high_contract.py
git commit -m "feat: sculpt WhiteLily anime body and outfit"
```

### Task 3: 建立语义骨架、权重和挂点

**Files:**
- Modify: `subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend`
- Create: `subprojects/whitelily-avatar/tools/blender/validate_rig.py`
- Create: `subprojects/whitelily-avatar/tools/blender/tests/test_rig_contract.py`
- Create: `subprojects/whitelily-avatar/assets/rig/whitelily-humanoid-v1.json`

**Interfaces:**
- Consumes: Task 2 high 网格。
- Produces: `RIG_WhiteLily`、标准身体语义、衣发控制、左右手持有物挂点和归一化蒙皮权重。

- [ ] **Step 1: 写骨骼、父子层级和权重失败测试**

```python
def test_required_semantic_bones_and_weights(scene):
    assert semantic_bones() == load_contract("whitelily-humanoid-v1.json")
    assert parent_of("head") == "neck"
    assert parent_of("neck") == "chest"
    assert parent_of("chest") == "spine"
    assert parent_of("spine") == "hips"
    assert max_influences_per_vertex() <= 4
    assert all_weights_sum_to_one(tolerance=1e-4)
    assert unweighted_vertex_count() == 0
```

- [ ] **Step 2: 运行红灯**

Run: `blender --background subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend --python subprojects/whitelily-avatar/tools/blender/tests/test_rig_contract.py`

Expected: FAIL，尚无正式骨架和权重。

- [ ] **Step 3: 创建共享 high/low 的身体语义骨架**

身体骨骼固定为 `hips/spine/chest/upperChest/neck/head`、左右 `shoulder/upperArm/lowerArm/hand`、左右 `upperLeg/lowerLeg/foot/toes`；挂点固定为 `heldItemL`、`heldItemR`。脸部包含 jaw、左右 eyelid 和眼球控制；长发链、两侧宽袖、内外裙摆、蝴蝶结、百合花和装备 attachment 使用 `secondary.*`/`attachment.*` 命名空间，不能替代必需身体语义。

- [ ] **Step 4: 完成变形权重和极限姿势修正**

所有可见顶点最多 4 权重且和为 1；肩、肘、腕、髋、膝、踝在 ±90° 主运动范围内无明显塌陷。固定测试姿势包括 T-pose、A-pose、双臂前举、弯肘持镐、深跨步、游泳伸展、侧卧睡觉；持续可见穿模不得超过 0.5 秒等价的 15 帧。必要 corrective shape key 使用 `corrective.<joint>.<pose>` 命名并由 driver 驱动。

- [ ] **Step 5: 校准真实 Minecraft 手持物矩阵**

`heldItemL/R` 以手掌中心为原点，+Y 沿前臂向手指，+Z 朝手背；测试剑、镐、鱼竿、面包四种物品，物品不穿过手掌且左右手镜像方向一致。导出合同把两个挂点写入 runtime manifest。

- [ ] **Step 6: 跑 rig 合同和姿势预览**

Run: `npm run avatar:anime:check -- --stage rig`

Expected: PASS，输出 7 个极限姿势的 front/side contact sheet 和权重热图，零未加权顶点、零非归一化权重。

- [ ] **Step 7: 提交**

```powershell
git add subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend subprojects/whitelily-avatar/assets/rig subprojects/whitelily-avatar/tools/blender/validate_rig.py subprojects/whitelily-avatar/tools/blender/tests/test_rig_contract.py
git commit -m "feat: rig WhiteLily humanoid avatar"
```

### Task 4: 制作 2K 手绘贴图和赛璐璐材质

**Files:**
- Modify: `subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend`
- Create: `subprojects/whitelily-avatar/assets/textures/source/whitelily-base-albedo.png`
- Create: `subprojects/whitelily-avatar/assets/textures/source/whitelily-base-control.png`
- Create: `subprojects/whitelily-avatar/assets/palettes/whitelily-base.json`
- Create: `subprojects/whitelily-avatar/tools/blender/bake_cel_materials.py`
- Create: `subprojects/whitelily-avatar/tools/blender/tests/test_material_contract.py`
- Create: `subprojects/whitelily-avatar/tools/validate-avatar-textures.mjs`
- Create: `subprojects/whitelily-avatar/tools/validate-avatar-textures.test.mjs`

**Interfaces:**
- Consumes: Task 2 UV、原始设定图配色。
- Produces: 2048×2048 base 图集、high 与 low 共用赛璐璐材质参数、基础材质降级版本。

- [ ] **Step 1: 写尺寸、色板、UV 和材质节点失败测试**

```js
test("requires exact 2K embedded color textures and approved sampled colors", async () => {
  const result = await validateAvatarTextures(fixtureRoot);
  assert.deepEqual(result.size, [2048, 2048]);
  assert.deepEqual(result.requiredPalette, [
    "#f7f6f2", "#e9f1ea", "#cde2c8", "#d4c7a3", "#a67c52",
  ]);
  assert.equal(result.externalUris.length, 0);
});
```

```python
def test_materials_have_approved_cel_fallback():
    assert material_names() == ("MAT_Face", "MAT_Eyes", "MAT_Hair", "MAT_Outfit")
    assert all(has_node_group(name, "WhiteLilyCelV1") for name in material_names())
    assert all(has_basic_fallback(name) for name in material_names())
```

- [ ] **Step 2: 运行红灯**

Run: `node --test subprojects/whitelily-avatar/tools/validate-avatar-textures.test.mjs`

Expected: FAIL，尚无 2K 贴图验证器。

- [ ] **Step 3: 完成 UV 与手绘基础图集**

脸、眼、头发、服装分区不重叠；镜像只用于不可见或完全对称区域，右侧百合花和服装非对称金纹拥有独立 UV。主图集 2048×2048 RGBA，纹素密度在脸/眼优先，头发与服装次之；留 16px mip padding。色板直接取设定图固定值：`#F7F6F2/#E9F1EA/#CDE2C8/#D4C7A3/#A67C52`，绿色眼睛另记录虹膜深/中/高光三色的采样坐标和十六进制值。

- [ ] **Step 4: 建立高级/基础两级赛璐璐材质**

高级材质固定两到三段明暗阈值 `0.35/0.68`、0.08 强度边缘高光、眼睛独立无阴影高光层；头发和裙摆使用柔和颜色过渡但不做写实毛发或塑料高光。基础材质只使用 albedo、Minecraft 光照和单段阴影，不改变几何；降级图不得纯白、纯黑、紫黑缺贴图或持续闪烁。透明仅允许百合花细边和少量发梢，alpha test 阈值固定 0.5，不使用多层 alpha blend 主体。

- [ ] **Step 5: 跑贴图和材质合同，生成灯光对比**

Run: `node --test subprojects/whitelily-avatar/tools/validate-avatar-textures.test.mjs && npm run avatar:anime:check -- --stage materials`

Expected: PASS，生成白天、夜晚、室内三种固定灯光下的高级/基础材质对照；两级都能辨认绿色眼睛、银白长发、浅绿裙装、金色细节和百合花。

- [ ] **Step 6: 提交**

```powershell
git add subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend subprojects/whitelily-avatar/assets/textures subprojects/whitelily-avatar/assets/palettes subprojects/whitelily-avatar/tools/blender/bake_cel_materials.py subprojects/whitelily-avatar/tools/blender/tests/test_material_contract.py subprojects/whitelily-avatar/tools/validate-avatar-textures.mjs subprojects/whitelily-avatar/tools/validate-avatar-textures.test.mjs
git commit -m "feat: texture WhiteLily with cel materials"
```

### Task 5: 从 high 制作同风格 low 细节等级

**Files:**
- Modify: `subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend`
- Create: `subprojects/whitelily-avatar/tools/blender/build_low_lod.py`
- Create: `subprojects/whitelily-avatar/tools/blender/validate_lod.py`
- Create: `subprojects/whitelily-avatar/tools/blender/tests/test_lod_contract.py`
- Create: `subprojects/whitelily-avatar/assets/measurements/lod-silhouette.json`

**Interfaces:**
- Consumes: high 网格、共享骨架/UV/材质。
- Produces: 14k–28k triangles 的 `BODY_LOW`/`OUTFIT_LOW`，共享身体语义和稳定轮廓。

- [ ] **Step 1: 写 triangle、语义和轮廓保持失败测试**

```python
def test_low_lod_keeps_style_and_semantics():
    assert 14_000 <= triangle_count("BODY_LOW", "OUTFIT_LOW") <= 28_000
    assert triangle_count("BODY_LOW", "OUTFIT_LOW") < triangle_count("BODY_HIGH", "OUTFIT_BASE")
    assert exported_semantics("low") == exported_semantics("high")
    assert silhouette_iou("high", "low", "front") >= 0.97
    assert silhouette_iou("high", "low", "side") >= 0.95
    assert has_objects("LilyHairpin_LOW", "BackRibbon_LOW", "SkirtInner_LOW", "SkirtOuter_LOW")
```

- [ ] **Step 2: 运行红灯**

Run: `blender --background subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend --python subprojects/whitelily-avatar/tools/blender/tests/test_lod_contract.py`

Expected: FAIL，尚无 low。

- [ ] **Step 3: 生成后人工修复 low 拓扑**

从 high 的副本开始，按对象使用受控 decimate/溶解：脸和轮廓保留较高密度，隐藏内表面、发束内部和非变形平面优先减面；随后手工修复眼睑、嘴角、肩肘、裙摆边、袖口、蝴蝶结和百合花。low 可以减少次级发束/裙摆骨骼数，但对运行时暴露的身体、手持物、裙摆、袖子、长发、蝴蝶结、百合花和装备挂点语义必须保留适配映射。

- [ ] **Step 4: 验证运动和轮廓不退回方块风格**

在 Task 3 的 7 个极限姿势与 front/side/back 视图比较 high/low；头部、肩线、袖口、裙摆、发尾、蝴蝶结和百合花关键点最大漂移 2.0% 画幅。输出线框图证明 low 仍为连续曲面，不用大立方体替换形体。

- [ ] **Step 5: 跑 LOD 合同并提交**

Run: `npm run avatar:anime:check -- --stage lod`

Expected: PASS，low triangle count 低于 high，所有 high/low 对比图生成且阈值通过。

```powershell
git add subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend subprojects/whitelily-avatar/assets/measurements/lod-silhouette.json subprojects/whitelily-avatar/tools/blender/build_low_lod.py subprojects/whitelily-avatar/tools/blender/validate_lod.py subprojects/whitelily-avatar/tools/blender/tests/test_lod_contract.py
git commit -m "feat: add smooth low LOD avatar"
```

### Task 6: 制作六种非方块化装备主题

**Files:**
- Modify: `subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend`
- Create: `subprojects/whitelily-avatar/assets/palettes/armor-themes.json`
- Create: `subprojects/whitelily-avatar/tools/blender/validate_armor.py`
- Create: `subprojects/whitelily-avatar/tools/blender/tests/test_armor_contract.py`
- Create: `subprojects/whitelily-avatar/assets/review/armor/README.md`

**Interfaces:**
- Consumes: 用户装备主题图、基础骨架、high/low、赛璐璐材质。
- Produces: `base/leather/iron/gold/diamond/netherite` 附件、材质变体和实际 `ArmorTheme` 映射。

- [ ] **Step 1: 写六主题、挂点和辨识度失败测试**

```python
def test_all_armor_themes_are_non_blocky_and_attached():
    assert armor_themes() == ("base", "leather", "iron", "gold", "diamond", "netherite")
    for theme in armor_themes()[1:]:
        assert attachment_slots(theme) == ("head", "shoulders", "forearms", "waist", "boots")
        assert no_axis_aligned_box_larger_than(0.08, collection=f"ARMOR.{theme}")
        assert visible_in_all_themes("Face", "HairFront", "LilyHairpin")
```

- [ ] **Step 2: 运行红灯**

Run: `blender --background subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend --python subprojects/whitelily-avatar/tools/blender/tests/test_armor_contract.py`

Expected: FAIL，尚无六套正式附件。

- [ ] **Step 3: 按原稿制作附件轮廓和独立材质**

`base` 使用原始服装。皮革为棕色软甲肩/袖/靴和腰部装饰；铁为银灰板片和金色细边；金为金黄主体、白色内层和原稿花纹；钻石为青绿色晶体色片与白金细节；下界合金为深紫黑板片、紫色高光和金色/白色小面积点缀。所有主题共享身体骨架，但拥有独立 material preset 和必要附件；不得遮住脸、整体发型或百合花，不得套入 Minecraft 原版头盔/胸甲/护腿/靴子几何。

- [ ] **Step 4: 完成 high/low 装备变体和切换无闪回**

每个附件提供 high/low 或明确在两个 LOD 共用的低成本网格；切换主题时下一完整帧原子替换附件和材质，不能中间闪回 base 或原版方块盔甲。卸下所有装备立即选择 base。导出 manifest 把每个主题的 primitive/material 名称和摘要固定下来。

- [ ] **Step 5: 生成统一灯光六主题验收图并跑绿**

Run: `npm run avatar:anime:check -- --stage armor`

Expected: PASS，输出 6×4（front/back/left/right）统一相机、统一灯光 contact sheet；每套保留脸、银白长发、百合花和 WhiteLily 轮廓。

- [ ] **Step 6: 提交**

```powershell
git add subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend subprojects/whitelily-avatar/assets/palettes/armor-themes.json subprojects/whitelily-avatar/assets/review/armor subprojects/whitelily-avatar/tools/blender/validate_armor.py subprojects/whitelily-avatar/tools/blender/tests/test_armor_contract.py
git commit -m "feat: add six WhiteLily armor themes"
```

### Task 7: 制作基础移动、战斗、工作、进食和睡觉动画

**Files:**
- Modify: `subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend`
- Create: `subprojects/whitelily-avatar/assets/animations/animation-contract.json`
- Create: `subprojects/whitelily-avatar/tools/blender/validate_animations.py`
- Create: `subprojects/whitelily-avatar/tools/blender/tests/test_animation_contract.py`
- Create: `subprojects/whitelily-avatar/assets/review/animations/README.md`

**Interfaces:**
- Consumes: 骨架、high/low 和 AI/Minecraft 语义动作名称。
- Produces: 固定命名、帧率、循环/退出元数据的第一批 animation clips。

- [ ] **Step 1: 写动画清单、长度和循环合同失败测试**

```python
def test_first_batch_animation_contract():
    assert action_names() == {
        "idle", "breathing", "blink", "look", "talk",
        "walk", "run", "jump", "swim", "combat", "hurt",
        "fish", "mine", "craft", "smelt", "till", "plant", "harvest",
        "eat", "build", "sleep", "wake"
    }
    assert action_fps() == 30
    assert loop_modes("walk", "run", "swim", "mine", "sleep") == "loop"
    assert loop_modes("jump", "hurt", "wake") == "once"
```

- [ ] **Step 2: 运行红灯**

Run: `blender --background subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend --python subprojects/whitelily-avatar/tools/blender/tests/test_animation_contract.py`

Expected: FAIL，动作清单不完整。

- [ ] **Step 3: 完成待机、移动和战斗动作**

所有 clip 30fps：idle 4s、breathing 4s、blink 0.2s、look 1.2s、talk 1s 循环；walk 1s、run 0.67s、swim 1.2s；jump 0.8s；combat 0.7s；hurt 0.45s。移动动作 root 保持原点，由 Minecraft 位移驱动；头部注视与身体 locomotion 可叠加。high/low 使用相同语义曲线，low 缺少的次级骨骼由映射忽略。

- [ ] **Step 4: 完成工作、进食、睡觉和醒来动作**

fish 2.4s、mine 1.0s、craft 2.0s、smelt 2.0s、till 1.2s、plant 1.4s、harvest 1.2s、eat 1.6s、build 1.0s，均支持在 0.15–0.30s 内退出到 neutral。sleep 包含进入 1.0s、侧卧循环 4s，wake 1.2s；床上姿势相对玩家睡觉朝向，不自行改变游戏位置。手持动作围绕 Task 3 挂点制作，鱼竿/镐/面包/方块方向和实际物品一致。

- [ ] **Step 5: 建立中断和迟到状态合同**

运行时动画图的每个工作状态保存 `renderSessionId` 和 `actionGeneration`；新的 neutral/follow/help 状态取消当前工作 blend，旧 generation 事件直接丢弃。叫停后下一有效状态更新开始退出，0.30s 内到 neutral；不得等待工作循环自然结束，也不得用动画反向触发 AI 任务。

- [ ] **Step 6: 自动播放所有动作并检查穿模**

`validate_animations.py` 对每个动作渲染 front/side 低分辨率序列，检测网格自交/法线翻转/离群顶点并生成 sprite sheet。人工检查门槛：身体穿模、裙摆翻面、长发穿脸、关节破面和贴图闪烁不得连续超过 15 帧（0.5s）。

Run: `npm run avatar:anime:check -- --stage animations`

Expected: PASS，22 个 clip 全部存在、命名唯一、帧率/时长/loop metadata 正确，生成对应 sprite sheet。

- [ ] **Step 7: 提交**

```powershell
git add subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend subprojects/whitelily-avatar/assets/animations subprojects/whitelily-avatar/assets/review/animations subprojects/whitelily-avatar/tools/blender/validate_animations.py subprojects/whitelily-avatar/tools/blender/tests/test_animation_contract.py
git commit -m "feat: animate WhiteLily living actions"
```

### Task 8: 制作五种表情、说话口型和受限衣发随动

**Files:**
- Modify: `subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend`
- Create: `subprojects/whitelily-avatar/assets/expressions/expression-contract.json`
- Create: `subprojects/whitelily-avatar/tools/blender/validate_expressions.py`
- Create: `subprojects/whitelily-avatar/tools/blender/tests/test_expression_contract.py`
- Create: `subprojects/whitelily-avatar/assets/review/expressions/README.md`

**Interfaces:**
- Consumes: 脸部拓扑、次级骨骼和语义 expression/speaking 状态。
- Produces: `neutral/happy/focused/worried/tired`、`aa/ih/ou/ee/oh` 口型、眨眼和预设衣发随动。

- [ ] **Step 1: 写 expression、morph range 和静默闭嘴失败测试**

```python
def test_expression_contract():
    assert expression_names() == {
        "neutral", "happy", "focused", "worried", "tired",
        "blinkLeft", "blinkRight", "aa", "ih", "ou", "ee", "oh"
    }
    assert all(0.0 <= value <= 1.0 for value in every_expression_delta_weight())
    assert evaluate_mouth(speaking=False, elapsed=10.0) == "neutral"
```

- [ ] **Step 2: 运行红灯**

Run: `blender --background subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend --python subprojects/whitelily-avatar/tools/blender/tests/test_expression_contract.py`

Expected: FAIL，表情合同不完整。

- [ ] **Step 3: 完成五种表情和克制口型**

neutral 保持自然放松；happy 眼尾/嘴角上扬；focused 轻收眉、视线集中；worried 内眉上抬且嘴角轻收；tired 上眼睑下压、姿势略放松。口型只在 speaking 为真时按语音幅度/音素驱动，幅度上限 0.55；沉默 100ms 内 blend 回 neutral，不随机持续张嘴。眨眼由 blink 语义触发，双眼可独立但不得固定周期机械同步。

- [ ] **Step 4: 建立受限次级随动预设**

为后发、侧发、宽袖、内外裙摆、蝴蝶结垂带建立 critically damped spring 预设，输入只来自角色速度、转向和基础骨骼姿势；位移/旋转设硬上限，世界切换、teleport、睡觉进入和资源重载时重置到当前基础姿势。低预算先禁用发梢和透明边缘，再减少裙摆/袖子随动，不能改变碰撞、角色位置或 Minecraft 规则。

- [ ] **Step 5: 跑表情/随动序列和静默回归**

Run: `npm run avatar:anime:check -- --stage expressions`

Expected: PASS，输出五种表情正面近景、五种口型、眨眼、走/跑/急停/睡觉的衣发随动序列；静默帧嘴型为 neutral。

- [ ] **Step 6: 提交**

```powershell
git add subprojects/whitelily-avatar/assets/blender/whitelily-anime-avatar.blend subprojects/whitelily-avatar/assets/expressions subprojects/whitelily-avatar/assets/review/expressions subprojects/whitelily-avatar/tools/blender/validate_expressions.py subprojects/whitelily-avatar/tools/blender/tests/test_expression_contract.py
git commit -m "feat: add avatar expressions and secondary motion"
```

### Task 9: 导出 high/low GLB、运行时清单和稳定预览

**Files:**
- Modify: `subprojects/whitelily-avatar/tools/build-avatar-assets.mjs`
- Modify: `subprojects/whitelily-avatar/tools/build-avatar-assets.test.mjs`
- Modify: `subprojects/whitelily-avatar/tools/validate-assets.mjs`
- Modify: `subprojects/whitelily-avatar/tools/validate-assets.test.mjs`
- Create: `subprojects/whitelily-avatar/tools/blender/export_avatar.py`
- Create: `subprojects/whitelily-avatar/tools/blender/render_avatar_previews.py`
- Create: `subprojects/whitelily-avatar/tools/validate-anime-glb.mjs`
- Create: `subprojects/whitelily-avatar/tools/validate-anime-glb.test.mjs`
- Create: `subprojects/whitelily-avatar/assets/runtime/avatar-runtime-manifest.json`
- Create: `subprojects/whitelily-avatar/assets/runtime/whitelily-hd-high.glb`
- Create: `subprojects/whitelily-avatar/assets/runtime/whitelily-hd-low.glb`
- Create: `subprojects/whitelily-avatar/assets/review/generated/README.md`

**Interfaces:**
- Consumes: Tasks 1–8 `.blend`、运行时计划的 GLB backend contract。
- Produces: 可复现 high/low GLB、摘要、能力清单、基础/装备/材质降级预览。

- [ ] **Step 1: 写 GLB 结构、摘要、动画和外部资源失败测试**

```js
test("validates the complete anime runtime asset contract", async () => {
  const manifest = await validateAnimeRuntimeAssets(assetRoot);
  assert.deepEqual(manifest.levels.map(({ id }) => id), ["high", "low"]);
  assert.deepEqual(manifest.themes, ["base", "leather", "iron", "gold", "diamond", "netherite"]);
  assert.equal(manifest.textureSize, 2048);
  assert.equal(manifest.externalUris.length, 0);
  assert.deepEqual(new Set(manifest.animations), EXPECTED_ANIMATIONS);
  assert.deepEqual(new Set(manifest.expressions), EXPECTED_EXPRESSIONS);
});
```

- [ ] **Step 2: 运行红灯**

Run: `node --test subprojects/whitelily-avatar/tools/validate-anime-glb.test.mjs`

Expected: FAIL，尚无正式 GLB 和验证器。

- [ ] **Step 3: 把现有程序化构建器缩减为编排/清单职责**

从 `build-avatar-assets.mjs` 删除“自由生成方块人物几何和贴图”的正式资产职责，保留源摘要、许可证、manifest、preview、digest 和复制到 Fabric resources 的能力。旧经典 `.bbmodel`/64×64 资源作为 `builtin:whitelily-classic` 独立保留，不从其反推或覆盖高清造型。

- [ ] **Step 4: 实现无交互 Blender 导出**

`export_avatar.py` 从同一 `.blend` 分别启用 high/low 和所需附件，应用导出允许的 modifier，验证 bind pose 和动画后调用 `bpy.ops.export_scene.gltf()`；所有纹理嵌入 GLB，禁止外部 URI。导出到临时目录，Node 验证器复核 GLB、三角数、joint/weight、语义挂点、动画、morph、贴图尺寸、材质、六主题和 SHA-256 后再原子替换正式产物。

- [ ] **Step 5: 生成固定相机截图基线**

`render_avatar_previews.py` 用 Task 1 相机/灯光生成：base 的 front/back/left/right、high/low 对照、六装备主题四视图、advanced/basic material、五表情近景和动作 sprite sheets。PNG 固定 sRGB、透明背景、1024×1024；manifest 写入每张预览的尺寸和 SHA-256。第一张桌面卡片仍直接使用完整 `whitelily-turnaround.png`，不以这些正方形预览替代。

- [ ] **Step 6: 跑全资产合同和确定性二次构建**

Run: `npm run avatar:anime:build`

Expected: PASS。

Run: `node subprojects/whitelily-avatar/tools/build-anime-avatar.mjs --export --render-previews --verify-deterministic`

Expected: PASS，构建器在两个独立临时目录连续导出，比较相对路径、文件大小和 SHA-256 后确认无字节差异。

Run: `node --test subprojects/whitelily-avatar/tools/build-avatar-assets.test.mjs subprojects/whitelily-avatar/tools/validate-assets.test.mjs subprojects/whitelily-avatar/tools/validate-anime-glb.test.mjs`

Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add subprojects/whitelily-avatar/tools subprojects/whitelily-avatar/assets/runtime subprojects/whitelily-avatar/assets/review/generated subprojects/whitelily-avatar/assets/manifest.json
git commit -m "build: export reproducible anime avatar assets"
```

### Task 10: 接入运行时动画、装备、LOD 和材质降级

**Files:**
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/gltf/HumanoidAnimator.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/gltf/SmoothMeshRenderBackend.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/quality/AvatarDetailSelector.java`
- Modify: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/quality/AvatarFallbackController.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/animation/AvatarAnimationGraph.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/animation/AvatarAnimationState.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/animation/AvatarAnimationGraphTest.java`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/gltf/BuiltinHdAvatarIntegrationTest.java`

**Interfaces:**
- Consumes: Task 9 manifest/GLB、运行时计划的 `AvatarVisualState` 和 quality/fallback APIs。
- Produces: 完整内置高清人物的语义动画、六装备主题、high/low 和材质降级。

- [ ] **Step 1: 写动画优先级、中断、LOD 和装备映射失败测试**

```java
@Test
void stopGenerationBeatsALateMiningState() {
  graph.accept(state("mine", 41, "world-a"));
  graph.accept(state("neutral", 42, "world-a"));
  graph.accept(state("mine", 41, "world-a"));
  assertEquals("neutral", graph.current().baseClip());
}

@Test
void mapsRealArmorToTheSixReviewedThemes() {
  assertEquals("base", backend.theme(noArmor()));
  assertEquals("leather", backend.theme(leatherArmor()));
  assertEquals("netherite", backend.theme(netheriteArmor()));
}
```

- [ ] **Step 2: 运行红灯**

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.render.animation.*" --tests "io.github.whitelily.avatar.render.gltf.BuiltinHdAvatarIntegrationTest"`

Expected: FAIL，尚无完整动画图和资产接入。

- [ ] **Step 3: 实现语义动画混合优先级**

优先级固定为：hurt > sleep/wake > jump/swim > combat/work > run/walk > talk/expression overlay > idle/breathing。每个状态校验 world session 和 action generation；迟到事件丢弃。工作中断在 0.30s 内 blend 到 idle/follow/help；说话只叠加口型/轻微头部，不覆盖游泳/睡觉基础姿势；表情从对话/动作状态选择，不按时间机械轮播。

- [ ] **Step 4: 接入装备、LOD、次级动态和材质降级**

只对 `builtin:whitelily-hd` 根据实际装备解析六主题；自定义模型继续隐藏专属装备。LOD 使用 14/18 滞回并共享动画语义；切换时保持 normalized clip time，避免动作跳帧。降级严格关闭次级动态/透明、切基础材质、切 low、最后当前帧 vanilla；经典模型不参与自动降级。

- [ ] **Step 5: 跑完整 Fabric 回归**

Run: `npm run avatar:test`

Expected: PASS，包括身份、装备、手持物、session health、热切换、动画、LOD 和故障隔离测试。

- [ ] **Step 6: 提交**

```powershell
git add subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render
git commit -m "feat: integrate anime avatar runtime states"
```

### Task 11: 验证性能、故障隔离和真实 Minecraft 场景

**Files:**
- Create: `subprojects/whitelily-avatar/tools/analyze-frame-times.mjs`
- Create: `subprojects/whitelily-avatar/tools/analyze-frame-times.test.mjs`
- Create: `docs/testing/whitelily-anime-avatar-performance.md`
- Create: `docs/testing/whitelily-anime-avatar-gameplay-matrix.md`
- Create: `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/gltf/AvatarFaultIsolationTest.java`

**Interfaces:**
- Consumes: 完整 runtime、结构化诊断、真实游戏帧时间采样。
- Produces: p95 性能报告、故障注入报告和游戏场景验收矩阵。

- [ ] **Step 1: 写 p95 计算和故障隔离失败测试**

```js
test("computes stabilized p95 delta against the paired baseline", () => {
  const report = analyzeFrameTimes({
    baselineMs: [8, 9, 10, 11, 12],
    avatarMs: [9, 10, 11, 12, 13],
    warmupFrames: 0,
  });
  assert.equal(report.p95DeltaMs, 1);
});
```

```java
@Test
void shaderFailureDoesNotTouchConversationQueueOrStopControl() {
  harness.failShaderCompilation();
  harness.renderOneFrame();
  assertTrue(harness.minecraftStillRunning());
  assertTrue(harness.desktopStillResponsive());
  assertTrue(harness.aiConversationStillAvailable());
  assertTrue(harness.stopTaskStillAvailable());
}
```

- [ ] **Step 2: 运行红灯**

Run: `node --test subprojects/whitelily-avatar/tools/analyze-frame-times.test.mjs`

Expected: FAIL，缺少分析器。

Run: `subprojects\whitelily-avatar\gradlew.bat -p subprojects\whitelily-avatar :mod-fabric:test --tests "io.github.whitelily.avatar.render.gltf.AvatarFaultIsolationTest"`

Expected: FAIL，缺少故障注入 harness。

- [ ] **Step 3: 实现固定采样协议和分析器**

同一电脑、世界存档、玩家位置、视角、天气、时间、渲染距离和图形设置分别采集：无 WhiteLily、high 8 格、low 24 格。每个场景预热 30 秒、采样 120 秒，记录 frame time 而不是平均 FPS；分析器丢弃预热，计算 p50/p95/p99 和 high 相对基线 p95 增量。目标：high 8 格 `p95DeltaMs <= 2.0`，low p95 不高于 high，资源重载和 LOD 切换后 5 秒内恢复稳定。

- [ ] **Step 4: 注入资源/网格/shader/动画故障**

分别替换错误摘要、截断 GLB、移除贴图、强制 shader 编译失败、抛出动画评价异常、切换时断桥和换世界。每次验证当前帧最多恢复 vanilla、旧已提交模型选择不变、Minecraft 不退出、桌面不白屏、AI 对话/动作队列/立即叫停可用，日志包含稳定码且 30 秒内不逐帧重复。

- [ ] **Step 5: 完成真实场景矩阵**

在白天、夜晚、室内、室外、水中、床上、8/16/24 格观察距离逐项截图；切换 base/皮革/铁/金/钻石/下界合金；播放 22 个动作并中断工作动作；检查 high/low 无抖动、基础材质完整、手持物左右手一致。结果写入 `whitelily-anime-avatar-gameplay-matrix.md`，每格记录版本、场景、期望、实测和截图路径。

- [ ] **Step 6: 跑自动测试和性能门槛**

Run: `node --test subprojects/whitelily-avatar/tools/analyze-frame-times.test.mjs && npm run avatar:check`

Expected: PASS。

Run: `node subprojects/whitelily-avatar/tools/analyze-frame-times.mjs --baseline build/avatar-performance/baseline.json --high build/avatar-performance/high-8-blocks.json --low build/avatar-performance/low-24-blocks.json --require-high-p95-delta-ms 2.0 --require-low-not-slower`

Expected: exit 0，并写入 `docs/testing/whitelily-anime-avatar-performance.md` 的表格数据与运行环境摘要。

- [ ] **Step 7: 提交**

```powershell
git add subprojects/whitelily-avatar/tools/analyze-frame-times.mjs subprojects/whitelily-avatar/tools/analyze-frame-times.test.mjs subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/gltf/AvatarFaultIsolationTest.java docs/testing/whitelily-anime-avatar-performance.md docs/testing/whitelily-anime-avatar-gameplay-matrix.md
git commit -m "test: verify anime avatar performance and isolation"
```

### Task 12: 生成原稿对照包并取得用户最终外观确认

**Files:**
- Create: `subprojects/whitelily-avatar/tools/blender/render_acceptance_package.py`
- Create: `subprojects/whitelily-avatar/tools/build-avatar-acceptance-package.mjs`
- Create: `subprojects/whitelily-avatar/tools/build-avatar-acceptance-package.test.mjs`
- Create: `subprojects/whitelily-avatar/assets/review/final/acceptance-manifest.json`
- Create: `subprojects/whitelily-avatar/assets/review/final/README.md`
- Modify: `docs/testing/whitelily-anime-avatar-gameplay-matrix.md`

**Interfaces:**
- Consumes: 用户原稿、最终 high/low、六主题、真实游戏截图和前述测试报告。
- Produces: 可复现最终对照包；用户明确“通过/需要修改”的验收门槛。

- [ ] **Step 1: 写对照包完整性和原图未改动失败测试**

```js
test("builds a complete acceptance package without altering the two source images", async () => {
  const manifest = await buildAcceptancePackage(fixtureRoot);
  assert.equal(manifest.sourceDigests.turnaround, TURNAROUND_SHA256);
  assert.equal(manifest.sourceDigests.armorThemes, ARMOR_SHA256);
  assert.deepEqual(manifest.orthographicViews, ["front", "back", "left", "right"]);
  assert.deepEqual(manifest.armorThemes, ["base", "leather", "iron", "gold", "diamond", "netherite"]);
  assert.ok(manifest.gameScreenshots.includes("close-day"));
  assert.ok(manifest.gameScreenshots.includes("close-night"));
});
```

- [ ] **Step 2: 运行红灯**

Run: `node --test subprojects/whitelily-avatar/tools/build-avatar-acceptance-package.test.mjs`

Expected: FAIL，缺少最终对照包生成器。

- [ ] **Step 3: 生成固定版式静态对照**

输出不遮挡原稿的 contact sheets：原始设定图与新 high 的正/背/左/右；high/low 线框和着色对比；六种装备主题统一灯光；高级/基础材质；五种表情。原始图只做等比 contain，不裁剪、不拉伸；每张标注源摘要、`.blend` Git commit、GLB 摘要、Blender 版本、相机和灯光配置。

- [ ] **Step 4: 加入真实游戏近景和动态证据**

包含白天/夜晚近景、水中、床上、六主题、手持鱼竿/镐/面包/方块、high/low 切换前后和叫停工作动作的连续帧。README 汇总自动测试、性能报告、已知限制（坐下不在范围、自定义模型无 WhiteLily 装备）和每张证据的相对路径。

- [ ] **Step 5: 重建并验证最终包**

Run: `node --test subprojects/whitelily-avatar/tools/build-avatar-acceptance-package.test.mjs && node subprojects/whitelily-avatar/tools/build-avatar-acceptance-package.mjs --verify-sources --render --verify-manifest`

Expected: PASS，`assets/review/final/acceptance-manifest.json` 内所有文件尺寸、SHA-256 和来源提交匹配。

- [ ] **Step 6: 向用户展示并等待明确验收**

向用户直接展示 `base-comparison.png`、`armor-comparison.png`、`high-low-comparison.png` 和 `minecraft-contact-sheet.png`，请求明确回答外观是否通过。若用户指出脸型、发型、比例、服装、花饰、配色、装备或动作问题，回到对应 Task 修改 `.blend`/贴图/动画并重建全部受影响产物；在用户明确确认前，本 Task 保持未完成状态。

- [ ] **Step 7: 用户确认后提交验收包**

```powershell
git add subprojects/whitelily-avatar/tools/blender/render_acceptance_package.py subprojects/whitelily-avatar/tools/build-avatar-acceptance-package.mjs subprojects/whitelily-avatar/tools/build-avatar-acceptance-package.test.mjs subprojects/whitelily-avatar/assets/review/final docs/testing/whitelily-anime-avatar-gameplay-matrix.md
git commit -m "docs: record approved WhiteLily avatar acceptance"
```
