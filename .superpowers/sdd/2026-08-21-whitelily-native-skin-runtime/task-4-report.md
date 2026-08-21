# Task 4 报告：停止内置 3D 预加载并保持原生皮肤切换原子性

## 实现

- 新增 `NativeSkinCandidateRuntime`。它只接受原生皮肤别名：
  - `builtin:whitelily` + `minecraft-skin`
  - `builtin:whitelily-hd` + `minecraft-skin` / `builtin-hd`
  - `builtin:whitelily-classic` + `minecraft-skin` / `builtin-classic`
- `prepare` 不读取或解析 `resourcePath`、摘要、骨骼、动画或表情字段；候选只保存 runtime owner 与 `modelId`。
- `requestCommit`、`cancel`、`release`、`consumeVisibleCommit` 在同一 runtime monitor 下串行，并用原子引用保存待确认候选。待确认 commit 只能消费一次；cancel/release 只清理同一候选。
- 用户 `glb` / `vrm` 以及 ID/格式不相干的内置描述符返回失败 future，不再回落旧 renderer。
- `WhiteLilyAvatarClient` 初始化现在直接把单一 `NativeSkinCandidateRuntime` 注入控制器；删除 registry、classic/HD/GLB/VRM backend map、classic 初始 prepare/activate、registry shutdown 和可替换 runtime 路径。
- `NativeSkinStateApplication.ApplicationResult` 现在明确区分 `APPLIED`、`UNCHANGED`、`FAILED`。只有真正把原生皮肤写入 `PlayerRenderState.skin` 才返回 `APPLIED`；未匹配、null skin、异常都不确认。
- `PlayerRendererMixin` 在 `APPLIED` 后调用 `onNativeSkinFrameVisible()`；该方法只在 runtime 有待确认候选时向控制器提交一次 `AvatarVisibleFrameResult.COMPLETE`。通知异常由现有一次性诊断捕获并稳定输出 `WL_AVATAR_SKIN_001`，不逃逸 render loop。
- 保留 `RuntimeBridgeApprovalContractTest` 中既有身份授权 ASM 行为测试；新增真实 controller/runtime 组合行为，分别验证旧 HD/classic 描述符的 render boundary → pending → visible COMPLETE → 恰好一个 COMMITTED，且不可读取的资源路径不影响流程。
- 删除 `GlbDocumentReaderTest.productionBackendResolvesDescriptorsFromTheRealModelsRoot`。该过时测试反射要求客户端保留 `smoothBackends(Path)`，与本任务禁止为测试暴露任意路径加载 API 的裁决冲突；GLB reader/backend 的其余行为测试未删除并单独通过。

`NativeSkinStateApplication`、`PlayerRendererMixin` 和对应测试超出简报初始文件清单，但这是落实显式 first-frame 裁决所必需的最小跨文件接口调整，已由上游在执行中确认。

## TDD：RED

所有命令均在 `subprojects/whitelily-avatar` 运行，使用 Java 21：

```powershell
$env:JAVA_HOME='C:\Users\Admin\AppData\Roaming\.minecraft\runtime\java-runtime-delta'
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
```

1. 原生候选 runtime 不存在：

```powershell
.\gradlew.bat :mod-fabric:test --tests "io.github.whitelily.avatar.skin.NativeSkinCandidateRuntimeTest" -x stageMinecraftComponents
```

结果：`BUILD FAILED`；`compileTestJava` 在 `NativeSkinCandidateRuntime` 找不到符号处失败，符合预期。

2. 应用结果尚无明确状态：

```powershell
.\gradlew.bat :mod-fabric:test --tests "io.github.whitelily.avatar.render.NativeSkinRenderContractTest" -x stageMinecraftComponents
```

结果：`BUILD FAILED`；`Status` 与 `status()` 找不到符号，符合预期。

3. APPLIED gate 与首帧组合 seam 尚不存在：

```powershell
.\gradlew.bat :mod-fabric:test --tests "io.github.whitelily.avatar.render.NativeSkinRenderContractTest" --tests "io.github.whitelily.avatar.render.RuntimeBridgeApprovalContractTest" -x stageMinecraftComponents
```

结果：`BUILD FAILED`；`onApplied(...)` 与 `onNativeSkinFrameVisible(runtime, controller)` 找不到符号，符合预期。

4. 旧内置 ID 使用新 `minecraft-skin` 格式的迁移别名尚未接受：

```powershell
.\gradlew.bat :mod-fabric:test --tests "io.github.whitelily.avatar.skin.NativeSkinCandidateRuntimeTest.preparesOnlyCoherentBuiltinNativeSkinAliasesWithoutReadingTheirResourcePaths" -x stageMinecraftComponents
```

结果：测试以预期的 `CompletionException` / `IllegalArgumentException` 失败。

5. 首次全量回归发现旧装配契约：

```powershell
.\gradlew.bat :mod-fabric:test -x stageMinecraftComponents
```

结果：180 tests，2 failed，1 skipped。其中 `GlbDocumentReaderTest.productionBackendResolvesDescriptorsFromTheRealModelsRoot` 因反射查找已删除的 `smoothBackends(Path)` 失败；这是应删除的旧客户端装配契约。另一个失败是 Task 5 已接管的 staged NOTICE 漂移。

6. null ID/格式必须作为不受支持描述符稳定拒绝：

```powershell
.\gradlew.bat :mod-fabric:test --tests "io.github.whitelily.avatar.skin.NativeSkinCandidateRuntimeTest.rejectsUserGeometryAndIncoherentBuiltinDescriptors" -x stageMinecraftComponents
```

结果：`BUILD FAILED`；原实现同步抛出 `NullPointerException`，而测试要求与其他不受支持描述符一致地返回含 `IllegalArgumentException` 的失败 future。

## TDD：GREEN

1. 候选 runtime 基础行为：

```powershell
.\gradlew.bat :mod-fabric:test --tests "io.github.whitelily.avatar.skin.NativeSkinCandidateRuntimeTest" -x stageMinecraftComponents
```

结果：`BUILD SUCCESSFUL`。

2. APPLIED / UNCHANGED / FAILED 状态：

```powershell
.\gradlew.bat :mod-fabric:test --tests "io.github.whitelily.avatar.render.NativeSkinRenderContractTest" -x stageMinecraftComponents
```

结果：`BUILD SUCCESSFUL`。

3. runtime、原生皮肤应用与身份授权 ASM 聚焦回归：

```powershell
.\gradlew.bat :mod-fabric:test --tests "io.github.whitelily.avatar.skin.NativeSkinCandidateRuntimeTest" --tests "io.github.whitelily.avatar.render.NativeSkinRenderContractTest" --tests "io.github.whitelily.avatar.render.RuntimeBridgeApprovalContractTest" -x stageMinecraftComponents
```

结果：`BUILD SUCCESSFUL`。覆盖 prepare、commit、consume-once、cancel、release、拒绝用户 geometry、APPLIED-only callback、一次 COMPLETE，以及原有 bridge identity ASM 契约。

4. 删除过时客户端装配反射测试后，GLB reader 全部剩余行为：

```powershell
.\gradlew.bat :mod-fabric:test --tests "io.github.whitelily.avatar.render.gltf.GlbDocumentReaderTest" -x stageMinecraftComponents
```

结果：`BUILD SUCCESSFUL`。

5. 最终全量 Fabric 回归：

```powershell
.\gradlew.bat :mod-fabric:test -x stageMinecraftComponents
```

结果：179 tests completed，1 failed，1 skipped。Task 4 相关测试全部通过；唯一失败为下述已知 Task 5 concern。

6. 最终关键路径回归（含控制器与一次性诊断）：

```powershell
.\gradlew.bat :mod-fabric:test --tests "io.github.whitelily.avatar.skin.NativeSkinCandidateRuntimeTest" --tests "io.github.whitelily.avatar.render.NativeSkinRenderContractTest" --tests "io.github.whitelily.avatar.render.RuntimeBridgeApprovalContractTest" --tests "io.github.whitelily.avatar.NativeSkinFailureDiagnosticsTest" --tests "io.github.whitelily.avatar.control.AvatarModelControllerTest" -x stageMinecraftComponents
```

结果：`BUILD SUCCESSFUL`。旧 HD/classic 描述符均从不可读取的资源路径完成 prepare、render-boundary commit 与一次首帧确认。

## 文件

- 新增 `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/skin/NativeSkinCandidateRuntime.java`
- 新增 `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/skin/NativeSkinCandidateRuntimeTest.java`
- 修改 `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/WhiteLilyAvatarClient.java`
- 修改 `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/mixin/PlayerRendererMixin.java`
- 修改 `subprojects/whitelily-avatar/mod-fabric/src/main/java/io/github/whitelily/avatar/render/NativeSkinStateApplication.java`
- 修改 `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/NativeSkinRenderContractTest.java`
- 修改 `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/RuntimeBridgeApprovalContractTest.java`
- 修改 `subprojects/whitelily-avatar/mod-fabric/src/test/java/io/github/whitelily/avatar/render/gltf/GlbDocumentReaderTest.java`
- 新增本报告。

## 自审

- 没有用 Java 源码字符串扫描证明旧 renderer 类名不存在；runtime 与客户端组合验证均为真实对象行为。正式 JAR/依赖不含自定义 renderer 的证明留给 Task 5 包契约。
- `resourcePath` 在测试中故意指向不存在的绝对路径，prepare 仍成功，证明 runtime 不做文件 I/O；生产实现完全不读取该字段。
- legacy ID/format 仅是原生别名，不实例化旧 renderer；用户 `glb`/`vrm` 显式失败。
- render boundary 仍由 controller 发起 commit；runtime 仅标记待确认；只有 `ApplicationResult.APPLIED` 才通知；一次消费保证恰好一次 COMPLETE。
- 未匹配、null skin、异常分别由行为测试证明不会执行可见回调；异常会恢复进入时的 vanilla skin。
- 原有 `productionCaptureUsesOnlyTheReadOnlyBridgeApprovalInsteadOfScoreboardAuthority` ASM 测试内容未改写为源码文本测试。
- `git diff --check` 通过；未改动用户已有计划、blend1、review/materials 或 `__pycache__`。

## Concerns

1. 全量 `:mod-fabric:test` 唯一失败是 `ComponentPackStagingTest.stagedLicensesAreTheReviewedProjectAndEmbeddedThirdPartyInputs`：仓库根 `NOTICE` 新增 Three.js 段落，而 staged `WhiteLily-NOTICE.txt` 尚未同步。任务简报明确把摘要/组件包漂移留给 Task 5，因此本任务未改 staging、manifest 或 NOTICE。
2. 当前 `AvatarModelControlCodec` 仍只接受旧 model ID 与 `builtin-hd` / `builtin-classic` / `vrm` / `glb` 格式。新的 `builtin:whitelily + minecraft-skin` 虽已被本任务 runtime 行为接受，但会在现有 mailbox codec 解码阶段被拒绝。这是已提交桌面 2D 计划 Task 1 的明确跨计划依赖；Task 4 不修改 codec/schema。当前桌面发送的旧 HD/classic 描述符已在本任务中分别验证可由 native runtime 无文件读取地完成首帧确认。
