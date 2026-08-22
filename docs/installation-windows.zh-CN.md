# WhiteLily Windows 安装、升级与卸载指南

[English](installation-windows.md)

> **状态：`v0.2.0-beta.2` Public Beta 候选。** 它把模型热切换和 Minecraft 动作工作区合并进一个未签名的 Windows x64 安装包。该候选已通过隔离清洁安装、beta.1 原位升级、工作区修复、数据保留、卸载与重装检查；真实游戏动作只在已确认可丢弃的 Minecraft Java 1.21.5 LAN 世界中验收。请严格核对 SHA-256。当前已公开发布的桌面版本仍是 `v0.2.0-beta.1`；beta.2 在完成剩余门禁前不会发布。

已发布的 `v0.1.1` 是面向开发者和早期测试者的旧版 CLI ZIP 预览，需要系统开发工具；它不是下面介绍的桌面 EXE 安装包。

## 1. 支持边界

首个桌面 Beta 的目标范围是：

- Windows 10/11 x64，按当前 Windows 用户安装，不要求管理员权限。
- Plain Craft Launcher 2（PCL2）由用户自行下载安装、启动和操作。
- Minecraft Java 版 **1.21.5**；未测试版本不在首个 Beta 的支持范围内。
- WhiteLily、PCL2、Minecraft 和内置 Codex 运行在同一台电脑上。
- 只连接 `127.0.0.1` 上由用户手动开放的 Minecraft LAN 世界；不支持跨电脑部署或远程 LAN 主机。
- 用户在 WhiteLily 中使用 ChatGPT 登录；不提供 Platform API 密钥回退。

WhiteLily 不会启动、控制、点击或修改 PCL2，也不会自动启动 Minecraft 或自动开放 LAN。你必须自己完成这些步骤，并在 WhiteLily 中确认检测到的本机会话。

## 2. 下载两个文件

从官方 [GitHub Releases](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases) 下载：

1. [`WhiteLily-0.2.0-beta.2-windows-x64-setup.exe`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/download/v0.2.0-beta.2/WhiteLily-0.2.0-beta.2-windows-x64-setup.exe)
2. [`WhiteLily-0.2.0-beta.2-windows-x64-setup.exe.sha256`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/download/v0.2.0-beta.2/WhiteLily-0.2.0-beta.2-windows-x64-setup.exe.sha256)

不要从源码目录、聊天附件、网盘或第三方镜像获取同名 EXE。文件名相同不代表内容可信。

## 3. 安装前验证 SHA-256

把 EXE 和 `.sha256` 放在同一目录，打开 PowerShell 并进入该目录，然后运行：

```powershell
$installer = ".\WhiteLily-0.2.0-beta.2-windows-x64-setup.exe"
$checksum = ".\WhiteLily-0.2.0-beta.2-windows-x64-setup.exe.sha256"
$expected = ((Get-Content -Raw $checksum).Trim() -split "\s+")[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA-256 mismatch. Do not run the installer." }
"SHA-256 verified: $actual"
```

只有命令显示 `SHA-256 verified` 时才继续。哈希不一致、校验文件格式异常或任一文件来自不同来源时，删除两个文件并重新从官方 Release 下载。不要用“看起来是同一个文件”代替哈希验证。

## 4. 未签名构建与 SmartScreen

首个 Beta 是**未签名**安装包，因此 Windows SmartScreen 可能显示“Windows 已保护你的电脑”或“未知发布者”。这不是哈希验证的替代品，也不表示任意同名文件都安全。

确认下载来源和 SHA-256 都正确后，按[未签名与 Windows SmartScreen 说明](smartscreen.zh-CN.md)检查文件，再选择“更多信息”→“仍要运行”。不要关闭 SmartScreen，不要降低整台电脑的安全设置，也不要为来源不明或哈希不匹配的文件绕过警告。

## 5. 安装

1. 退出正在运行的 WhiteLily 开发构建或旧桌面构建。
2. 双击已经验证 SHA-256 的 EXE。
3. 阅读安装向导并确认当前用户安装。
4. 完成后从开始菜单或桌面快捷方式打开 WhiteLily。

默认程序目录：

```text
%LOCALAPPDATA%\Programs\WhiteLily
```

默认用户数据目录：

```text
%LOCALAPPDATA%\WhiteLily
```

安装包计划内置 Electron、编译后的 WhiteLily 后台运行时、固定版本的 Codex CLI、生产依赖和许可证材料。因此普通用户**不需要系统 Node.js、npm、Git 或 Codex CLI**，安装过程也不会联网下载可执行依赖。PCL2 和 Minecraft 不包含在 WhiteLily 安装包中，仍由用户从各自可信来源安装。

beta.2 安装包还内置一套经过逐字节校验的 Minecraft 组件资源：WhiteLily Bridge、可选的 WhiteLily Avatar、Fabric API `0.128.2+1.21.5`、GeckoLib `5.1.0` 及其许可证。辅助安装默认勾选 Bridge 和 Avatar；静默安装也默认启用两者。安装器只在当前用户的 `%LOCALAPPDATA%\WhiteLily\config\minecraft-components.json` 不存在时写入一次偏好，不搜索 PCL2、不猜测游戏目录，也不向 Minecraft 写文件。升级、重装和“保留数据”卸载不会覆盖该偏好。

WhiteLily 只会在桌面应用中把固定组件安装到**当前已验证的 PCL2 Fabric Loader `>=0.16.14`、Minecraft Java `1.21.5` 实例**。Bridge 是官方认证 LAN 连接所必需的；Avatar 是可选外观，并依赖 Bridge、上述 Fabric API 与 GeckoLib。写入组件后必须重新启动该 Minecraft 实例；已创建的世界不会被修改。WhiteLily 不读取或复用 PCL2、Microsoft 或 Minecraft 凭据，不更改全局在线认证、`online-mode`、白名单、计分板/队伍或持久世界数据。

## 6. 首次打开

1. 打开 WhiteLily。
2. 在应用内完成 ChatGPT 登录。
3. 从当前账户实时返回的可用模型中选择模型和推理强度。
4. 设置与游戏内完全一致的 Minecraft Java 主人用户名，包括大小写。
5. 保留默认安全边界，并先使用可以随时删除的测试世界。

认证文件保存在 `%LOCALAPPDATA%\WhiteLily` 下的受控本机数据目录。WhiteLily 不要求把 API 密钥粘贴进配置，也不提供 API Key 回退。

### 持久化模型热切换与动作工作区

`v0.2.0-beta.2` 在同一个安装包中提供这两项能力，不需要单独安装模型组件或动作组件。

首次设置完成后，可以随时打开左侧“智能模型”，从当前 ChatGPT 会话的实时列表中重新选择模型和推理强度，再点“应用模型”。成功切换会停止当前活动任务并撤销该任务尚未执行的动作，但不会断开已经确认的 Minecraft LAN 会话。新选择只有在模型准备成功后才会保存并显示，并会在 WhiteLily 后台或桌面应用重启后继续使用。

如果切换失败，WhiteLily 会保留原来的模型选择和连接。不要通过反复重启、手工编辑本机认证文件或粘贴 API Key 绕过失败；先直接重试，仍然失败时保存脱敏诊断并报告问题。

每次启动时，WhiteLily 都会核验 `%LOCALAPPDATA%\WhiteLily\codex-workspace` 中精确的三个受管文件：`.codex/config.toml`、`AGENTS.md` 和 `workspace-manifest.json`。缺失、旧版或被修改的普通目录会从安装包内的已校验副本原子修复。稳定恢复错误为 `WORKSPACE_RESOURCE_INVALID`、`WORKSPACE_DEPLOY_FAILED` 和 `WORKSPACE_ROLLBACK_FAILED`；出现错误时先完全退出并重试，再运行同一个 beta.2 安装包执行修复安装。不要手工下载脚本，也不要向工作区写入 API 密钥。

## 7. 用 PCL2 进入 Minecraft

1. 用户自行启动和操作 PCL2。
2. 用 PCL2 启动 Minecraft Java 1.21.5。
3. 进入一个可丢弃的单人测试世界。
4. 按 `Esc`，选择“对局域网开放”，并由你手动完成 LAN 开放。
5. 回到 WhiteLily，核对检测到的版本、进程、`127.0.0.1` 和端口。
6. 只在信息正确时确认连接。

WhiteLily 不扫描局域网内其他电脑，不接受模型给出的远程主机地址，也不读取 PCL2 账户凭据。每次重新开放世界时端口可能变化，必须重新核对候选会话。

## 8. 更新

当前设计是手动更新，不在后台下载或运行新安装包：

1. 在 WhiteLily 中停止当前任务和伙伴。
2. 从系统托盘选择“退出”，确认应用完全结束。
3. 从官方 Release 下载新 EXE 和对应 `.sha256`。
4. 再次验证 SHA-256，然后运行新安装包。
5. 在可丢弃世界中完成更新后的冒烟测试。

同一产品标识的升级只替换程序目录。升级会保留 `%LOCALAPPDATA%\WhiteLily` 中的设置、配置、伙伴资料、记忆、世界绑定、日志和其他用户数据。升级前仍建议备份重要的本机配置；不要把数据目录复制到程序目录。

## 9. 卸载

先停止伙伴并从系统托盘退出 WhiteLily，再从 Windows“已安装的应用”运行卸载器。交互式卸载提供两个明确选项：

- **保留 WhiteLily 数据（默认）**：移除程序，保留 `%LOCALAPPDATA%\WhiteLily`，方便以后重装或升级后继续使用。
- **删除 WhiteLily 数据**：移除程序并删除 WhiteLily 的本机设置、认证状态、伙伴资料、记忆、日志和诊断数据；该操作不可恢复。

静默卸载也默认保留数据。只有用户在交互式卸载中明确选择“删除 WhiteLily 数据”时，卸载器才应删除精确匹配当前用户 `%LOCALAPPDATA%\WhiteLily` 的目录；不会删除父目录、通配符路径、网络路径或其他应用数据。

## 10. 隐私和本机数据

- WhiteLily 不收集遥测，不自动上传日志或诊断包。
- PCL2 凭据、Minecraft 存档和主人用户名不会作为公开诊断内容上传。
- ChatGPT/Codex 认证、设置、记忆和脱敏日志保存在本机 WhiteLily 数据目录。
- WhiteLily 只访问用户确认的同机 `127.0.0.1` Minecraft LAN 会话。
- 分享日志或截图前仍需人工检查其中是否有个人信息。

## 11. 常见问题

### 系统没有 `node`、`npm`、`git` 或 `codex`

这是桌面安装包的预期环境。正式安装包包含运行所需组件，不依赖系统 PATH 中的 Node.js、npm、Git 或 Codex CLI。若安装后的 WhiteLily 提示这些系统命令缺失，请不要自行安装工具绕过问题，应保存脱敏诊断并报告安装包缺陷。

### 找不到 PCL2

WhiteLily 只做只读发现，不替你安装或启动 PCL2。请从 PCL2 官方来源安装，用户自行启动并操作 PCL2，然后回到 WhiteLily 刷新发现结果。

### 无法连接 Minecraft

确认 Minecraft Java 版本是 1.21.5、世界仍处于 LAN 开放状态、候选地址是 `127.0.0.1`，并且世界中没有同名机器人。不要改成局域网其他电脑的 IP。

### SmartScreen 仍然阻止运行

不要关闭系统保护。重新核对官方下载来源和 SHA-256，并阅读[SmartScreen 指南](smartscreen.zh-CN.md)。无法确认任一项时不要运行。

## 12. 开发者预览

公开的 `v0.1.1` CLI ZIP 是旧版开发者预览，确实要求 Node.js、npm、Git/源码工作区和 Codex CLI。它的要求不适用于 `v0.2.0-beta.2` 桌面安装包。

维护者验证安装包时，生命周期测试会在 Windows Sandbox 中建立真实的 Windows 主体边界：可信控制器以 `SYSTEM` 运行，交互式引导进程只充当受信任的启动代理，安装包、应用和卸载程序始终以一次性的标准本地候选用户运行。报告与控制状态位于 guest 本地的 SYSTEM/Administrators-only 目录；候选用户的恶意写入探针必须得到 AccessDenied。由于 Sandbox 映射目录不能作为 guest ACL 的安全边界，最终 schema 2 报告通过一次性 256-bit 主机密钥生成 HMAC-SHA256 信封传回。控制器在写入信封前以独占方式持有映射中的 shutdown guard，检查系统关机命令是否成功启动，并保持控制器与 guard 存活，直到 guest 关机终止它们；主机必须先验签、再等待 guard 的独占占用释放、重新验签，才能继续。guard 未释放或关机启动失败时必须失败关闭，保留映射目录并要求人工关闭 Sandbox。

控制器直接核对候选用户的 per-user 安装目录、数据目录、注册表 hive、双重观察的安装包哈希和全部 15 个阶段，并在候选用户被删除后才签出报告。它还对安装后的 9 个 Minecraft 组件资源逐个重算字节数与 SHA-256，确认清洁安装生成精确的无 BOM/无换行 schema 1 偏好，并证明 beta.1 升级、“保留数据”卸载和重装都不覆盖用户偏好；“删除数据”最终删除该文件和整个固定数据根。主机只跟踪它启动的那个 `WindowsSandbox.exe` 进程，不会按进程名枚举或终止其他 Sandbox 会话。成功后的清理采用两层固定允许集合：先检查映射根和报告目录的全部顶层条目，拒绝任何意外目录、reparse point、额外名称或非普通文件；然后只按固定 `LiteralPath` 逐个删除已允许的普通文件，最后非递归删除已经确认为空的两个目录。发现污染时不得递归删除；应保留提示中的精确路径，先关闭 Sandbox，再人工核对并只删除已确认的普通文件。保留数据和删除数据两种卸载都必须在有限等待后证明程序目录、`WhiteLily.exe`、卸载器和注册表项已经消失。

## 13. 已知 Beta 限制

- 仅支持同一台电脑上 `127.0.0.1` 的 Minecraft Java 1.21.5 LAN 世界；不支持远程主机。
- 模型列表、响应速度和使用额度由当前 ChatGPT/Codex 账户决定；没有 Platform API 密钥回退。
- 游戏动作只能使用 WhiteLily 当前发现并校验的受限工具，任意自然语言请求不保证都能执行。
- PCL2、Minecraft 和 LAN 世界仍由用户自行启动、操作和确认；每次更新后先在可丢弃世界中测试。

维护者从源码验证桌面构建时应使用锁定依赖和仓库中的开发脚本；普通安装用户不需要克隆仓库或运行 `npm ci`。隔离生命周期自动化不能代替人工 Minecraft 验收；只有同时通过隔离生命周期和 Minecraft 1.21.5 同机连接验收的构建才可合并、打标签或作为预发布安装包提供。
