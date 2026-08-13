# WhiteLily 常驻安全退出入口设计

**状态：** 已确认。用户批准采用 App 级常驻退出按钮，通过零参数 IPC 复用现有 `ApplicationLifecycle.quit()`。

## 1. 背景与目标

WhiteLily 当前可配置“关闭到托盘”。当托盘图标或其可访问性入口不可用时，关闭主窗口只会隐藏应用，用户无法从 Onboarding 或主界面通过稳定、可访问的语义控件正常退出后台进程。这会阻塞安装升级，也迫使验收流程依赖操作系统级进程管理。

本改动提供一个始终可见的“退出 WhiteLily”按钮。它必须：

- 同时出现在 Onboarding 和主界面；
- 可通过标准按钮语义和 UI Automation 调用；
- 只调用现有的 `ApplicationLifecycle.quit()`；
- 不接受 PID、路径、模式、超时、强制退出或其他 renderer 输入；
- 不新增进程终止、Restart Manager、坐标点击或键盘模拟能力；
- 失败时仅显示固定、本地化且不含底层错误详情的提示。

## 2. 方案选择

采用 App 级常驻按钮，而不是设置页按钮或 Electron 原生菜单。

- 设置页方案无法覆盖当前 Onboarding 阶段，不能解决实际问题。
- 原生菜单方案扩大平台和可访问性测试面，且当前打包应用没有可稳定调用的菜单语义树。
- App 级按钮直接复用既有 React、preload、IPC 和 lifecycle 边界，改动最小且在两种页面阶段都可达。

## 3. 用户界面

新增小型 `ApplicationExitButton` 组件，由 `App` 在两个顶层分支复用：

- Onboarding：放在现有顶部栏，与语言切换按钮并列；
- 主界面：放在 `app-shell` 的固定应用级 chrome 中，不依赖 Sidebar 路由或 Settings 页面；
- 元素使用原生 `<button type="button">`，本地化文本为“退出 WhiteLily”/“Quit WhiteLily”；
- 单击后立即进入 busy 状态并禁用，避免重复请求；
- 正常退出时窗口可能在 Promise 完成前销毁，renderer 不依赖成功回执更新 UI；
- 若 renderer 仍存活且请求以固定错误拒绝，按钮恢复可用并显示固定本地化失败提示。

不增加确认弹窗。退出动作的含义由按钮文本直接表达；增加弹窗会制造新的阻塞状态，并不能提升 lifecycle 的安全性。

## 4. API 与权限边界

在 `WHITE_LILY_IPC_CHANNELS` 增加固定 channel，并在 `WhiteLilyDesktopApi` 增加：

```ts
quitApplication(): Promise<void>;
```

preload 实现必须：

- 运行既有零参数校验；
- 只调用固定 channel；
- 不接受或转发任何 payload；
- 保持暴露对象冻结。

`registerIpcHandlers` 增加注入依赖：

```ts
requestApplicationQuit(): Promise<void>;
```

handler 在调用依赖前再次执行零参数校验。内部异常必须转换为固定 opaque 错误，不保留 `cause`，也不把原始 message、路径、PID 或子进程输出传播到 renderer。

## 5. 生命周期接线

`startElectronComposition` 已创建唯一 `ApplicationLifecycle`。IPC 注册回调必须获得一个仅调用该实例 `quit()` 的窄闭包；不得在 IPC 层创建第二个 lifecycle，也不得直接调用 `app.quit()`、销毁窗口或终止进程。

由此，托盘“退出”、`before-quit` 和新按钮继续共享同一条退出路径：

1. 合并并发退出请求；
2. 请求 supervisor 正常停止；
3. 按既有 deadline 处理 WhiteLily 自有子进程；
4. 清理 tray、IPC 和窗口；
5. 调用 Electron `app.quit()`。

新按钮不改变 close-to-tray 配置。标题栏关闭仍可隐藏到托盘；显式“退出 WhiteLily”始终表示完整退出。

## 6. 错误处理

- renderer 只识别本地固定失败状态，不显示底层异常文本；
- IPC 输入非空时 fail closed，且不得调用 lifecycle；
- lifecycle 已在退出中时复用其既有幂等 Promise，不重复关闭子进程；
- handler cleanup 后 channel 不再可调用；
- renderer 卸载期间的 Promise 完成不得触发状态更新警告。

## 7. 测试策略

按 TDD 分层验证：

1. `desktopApi`：channel 固定、零参数、单次 invoke、API 冻结。
2. `ipcRegistry`：零参数校验、exact-once lifecycle 调用、并发复用、固定 opaque rejection、cleanup 移除 handler。
3. `main` composition：新 IPC 与 tray/before-quit 使用同一个 lifecycle 实例，不出现直接 `app.quit()` 旁路。
4. `App`：checking、Onboarding 和 main 都有唯一语义按钮；busy 时禁用；失败恢复并显示固定文案；成功不要求 renderer 回执。
5. i18n：中英文 key 完整，缺失 key 测试保持通过。
6. preload bundle、desktop typecheck、format、desktop 全量测试和 root 全量测试全部通过。
7. 打包后在 Windows Sandbox 重跑安装/升级/卸载生命周期；真实主机升级前，先通过 UI Automation 调用新按钮并证明 WhiteLily 正常归零、Minecraft/PCL/世界状态不变。

## 8. 非目标

本改动不负责：

- 修复或恢复托盘图标；
- 改变默认 close-to-tray 偏好；
- 自动退出 Minecraft 或 PCL2；
- 增加“强制退出”按钮；
- 修改 Minecraft 组件安装、LAN 检测或 Mineflayer 行为；
- 改变现有退出 deadline 和子进程清理策略。

## 9. 验收标准

- Onboarding 和主界面均存在且仅存在一个可访问的“退出 WhiteLily”按钮；
- renderer 无法通过该 API 传递参数或选择退出策略；
- 单击只进入现有 `ApplicationLifecycle.quit()`，无第二条退出实现；
- 正常路径使 WhiteLily 完整退出，PCL2、Minecraft 和世界状态不被该按钮操作；
- 失败路径保留应用并提供固定错误，允许用户再次显式操作；
- 自动测试、构建、Sandbox 与真实主机单次语义退出验收通过。
