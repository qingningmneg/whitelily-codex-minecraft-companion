# WhiteLily Codex Minecraft Companion

[中文](#中文) · [English](#english)

## 中文

### Windows 安装包（v0.2.0-beta.2）

> **发布状态：Public Beta 候选。** `v0.2.0-beta.2` 只提供一个 Windows x64 EXE，合并模型热切换与 Minecraft 动作工作区修复。该候选已通过安装包解包校验、Windows Sandbox 清洁安装、beta.1 原位升级、工作区修复、数据保留、卸载与重装验收；真实游戏动作仍必须在已确认可丢弃的 Minecraft Java 1.21.5 LAN 世界中验证。当前已公开发布的桌面版本仍是 [`v0.2.0-beta.1`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/tag/v0.2.0-beta.1)；beta.2 在完成剩余门禁前不会发布。

`v0.2.0-beta.2` 发布后，从官方 [GitHub Releases](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases) 同时下载：

- [`WhiteLily-0.2.0-beta.2-windows-x64-setup.exe`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/download/v0.2.0-beta.2/WhiteLily-0.2.0-beta.2-windows-x64-setup.exe)
- [`WhiteLily-0.2.0-beta.2-windows-x64-setup.exe.sha256`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/download/v0.2.0-beta.2/WhiteLily-0.2.0-beta.2-windows-x64-setup.exe.sha256)

先按[中文安装指南](docs/installation-windows.zh-CN.md)验证 SHA-256，再阅读[未签名与 SmartScreen 说明](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/smartscreen.zh-CN.md)。首个 Beta 是未签名构建，Windows SmartScreen 可能显示“未知发布者”；不要关闭系统保护，也不要运行哈希不匹配或来源不明的文件。

安装包内置 Electron、WhiteLily 后台运行时和固定版本的 Codex CLI，因此普通用户不需要在系统中另装 Node.js、npm、Git 或 Codex CLI。首次打开后在 WhiteLily 中完成 ChatGPT 登录；不提供 Platform API 密钥回退。用户自行启动和操作 PCL2、用 PCL2 启动 Minecraft Java 1.21.5，并手动把可丢弃世界开放到 LAN。WhiteLily 不会启动、控制、点击或修改 PCL2，只连接同一台电脑上的 `127.0.0.1`。

beta.2 同时内置固定哈希的 WhiteLily Bridge、可选 Avatar、Fabric API `0.128.2+1.21.5`、GeckoLib `5.1.0` 和许可证。安装器只保存当前用户的默认组件偏好，不搜索或修改 PCL2/Minecraft；组件只由桌面应用安装到当前已验证的 Fabric Loader `>=0.16.14`、Minecraft `1.21.5` 实例。Bridge 是官方认证 LAN 必需组件，Avatar 依赖 Bridge；写入后需要重启 Minecraft，旧世界不变。WhiteLily 不读取启动器/微软/游戏凭据，也不更改全局认证、`online-mode`、白名单、计分板/队伍或世界数据。

### 项目定位与状态

WhiteLily（白百合）是一个面向 Minecraft Java 版的本地 AI 伙伴运行时。它通过 Mineflayer 以机器人身份加入 Minecraft 世界，让主人直接在游戏聊天框中与本机已登录的 Codex 交互。它不是 Minecraft 客户端模组，也不替代启动器。

**当前状态：Public Beta。** 最新公开版本是 **v0.2.0-beta.1**；当前发布候选是 **v0.2.0-beta.2**，提供按用户安装的单一 Windows x64 EXE。旧版 [`v0.1.1`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/tag/v0.1.1) CLI ZIP 仍保留给开发者参考，但它不是桌面安装器。

`v0.2.0-beta.2` 包含 Electron 控制中心、ChatGPT 登录与状态恢复、可持久化的模型热切换、只读 PCL2 发现、Minecraft LAN 检测与确认、主人身份在线切换，以及自动部署和修复的 Minecraft 动作工作区。它仍应只在可丢弃世界中试用。

### 当前运行架构

```text
PowerShell 脚本 / CLI
  └─ RuntimeFacade
      └─ WhiteLilyAppLifecycle
          ├─ CompanionService ── TaskController / TurnToolBudget
          ├─ 本机 MCP ── 受限工具注册表
          └─ 本机 Codex app-server
              ├─ 意图线程（无动作工具）
              └─ 执行线程 dynamic minecraft_* ── 同一受限工具注册表
                                                    └─ ActionExecutor ── SafetyEngine
                                                                          └─ MinecraftPort
                                                                              └─ Mineflayer
                                                                                  └─ 127.0.0.1 Minecraft LAN 世界
```

`RuntimeFacade` 提供稳定的 `start()`、`stop(reason)`、`subscribe()` 和 `snapshot()` 边界。普通对话和意图判断线程没有动作工具；只有已验证任务的执行线程获得受限的动态 Minecraft 工具。动态工具和本机 MCP 复用同一工具注册表，可信游戏快照、任务租约、预算、安全策略和动作执行器会在调用 Mineflayer 前逐层检查请求。完整依赖关系和停止顺序见[运行时架构](docs/runtime-architecture.md)。

PCL2 始终由用户自行启动和操作。WhiteLily 不会启动、控制、点击或修改 PCL2；当前版本只连接用户手动开放到 LAN 的 Minecraft 世界。

### v0.1.1 已实现能力

- 在 Minecraft 聊天框中识别配置的主人，区分普通对话与本地管理命令。
- 提供 `friend`、`balanced`、`autonomous` 三种现有模式，以及暂停、恢复、状态和紧急停止命令。
- 通过受限工具读取世界状态，并执行聊天、移动、跟随、观察、跳跃、挖掘、放置、合成、烧炼、拾取、装备和攻击可信敌对实体等有界动作。
- 每次任务先公开目标、预期动作、有效限制和停止条件；同一时间最多只有一个活动任务。
- 使用任务租约、逐回合工具租约、可信距离计算、确认票据和失效栅栏，避免旧任务、旧世界或旧会话继续获得动作权限。
- 在本机保存精简的结构化记忆、状态、日志和任务审计；公共运行时事件与日志经过长度限制和敏感信息脱敏。
- 提供可重复的 Windows 设置、检查、启动、停止、发布检查和 ZIP 打包脚本。
- v0.1.1 的自动化基线包含 32 个测试文件、831 项测试。

### 当前支持范围

| 项目         | v0.1.1 支持范围                                    |
| ------------ | -------------------------------------------------- |
| 操作系统     | Windows 11 x64                                     |
| 启动器       | PCL2，由用户自行启动和操作                         |
| Minecraft    | Java 版 1.21.5                                     |
| 部署方式     | WhiteLily、Codex、PCL2 和 Minecraft 位于同一台电脑 |
| 游戏地址     | 仅 `127.0.0.1`；不支持跨电脑或局域网远端主机       |
| 运行时       | Node.js 24+、npm 11+                               |
| 模型入口     | 本机 Codex CLI，使用 ChatGPT 登录                  |
| 推荐测试环境 | 可随时删除的单人测试世界，手动“对局域网开放”       |

具体可用性和额度取决于用户的 ChatGPT/Codex 账户与当前产品规则。WhiteLily 会使用本机登录会话的适用共享用量或额度，不承诺无限或固定用量，也不会回退到单独计费的 Platform API 密钥。参见官方 [Codex 定价](https://learn.chatgpt.com/docs/pricing.md)和[认证说明](https://learn.chatgpt.com/docs/auth)。

### 快速开始

以下步骤适用于 `v0.2.0-beta.2` 桌面安装包，不适用于旧版 v0.1.1 CLI ZIP。请先阅读 [Windows 11 + PCL2 完整安装指南](docs/installation-windows.zh-CN.md)。首次安装和每次更新都应在可丢弃世界中验证。

1. 按安装指南完成 WhiteLily 安装并打开桌面应用。
2. 在 WhiteLily 中使用 ChatGPT 登录，然后从实时模型列表中选择模型。
3. 在“主人身份”步骤填写**完全一致**的 Minecraft Java 用户名，包括大小写，并确认主人身份。
4. 用户自行打开 PCL2，启动 Minecraft Java 1.21.5，进入可丢弃的单人世界并选择“对局域网开放”。
5. 回到 WhiteLily，核对并确认应用检测到的本机 LAN 会话；不需要手工抄写端口。
6. 以后要更换主人时，在 WhiteLily 的“设置”→“主人身份”中完成确认，不需要让机器人退出或重新连接。

运行中切换主人会立即撤销旧主人的命令权限，并取消旧主人授权的活动任务，尚未执行的动作不会继续。WhiteLily、Mineflayer 连接和本机 Codex 服务保持连接；如果新主人离线，界面会显示“正在等待新主人上线”，且不会恢复旧主人的权限。

#### 持久化模型热切换与动作工作区

`v0.2.0-beta.2` 把这两项能力合并进同一个安装包，不需要另外安装模型组件或动作组件。

要更换模型时可打开“智能模型”，从当前 ChatGPT 会话的实时列表中选择模型和推理强度，再点“应用模型”。

成功切换模型会停止当前活动任务并撤销该任务尚未执行的动作，但不会断开已确认的 Minecraft LAN 会话。新选择只有在模型准备成功后才会保存并显示，并会在 WhiteLily 后台或桌面应用重启后继续使用；如果切换失败，WhiteLily 会保留原来的模型选择和连接，可直接重试。

每次启动时，WhiteLily 会核验并在需要时原子修复 `%LOCALAPPDATA%\WhiteLily\codex-workspace` 中的 `.codex/config.toml`、`AGENTS.md` 和 `workspace-manifest.json`。固定恢复错误为 `WORKSPACE_RESOURCE_INVALID`、`WORKSPACE_DEPLOY_FAILED` 和 `WORKSPACE_ROLLBACK_FAILED`；出现这些错误时先退出并重试，再用同一个 beta.2 安装包执行修复安装，不要手工下载脚本或把 API 密钥写入工作区。

当前 Beta 的限制包括：仅支持同机 `127.0.0.1` 的 Minecraft Java 1.21.5 LAN 世界；模型列表、响应速度和额度取决于 ChatGPT/Codex 账户；动作仅通过当前受限工具集合执行，不保证任意自然语言请求都能完成。默认卸载保留 `%LOCALAPPDATA%\WhiteLily`，只有在交互式卸载中明确选择“删除 WhiteLily 数据”才删除该精确数据目录。

#### 高级故障排查：手工配置主人

正常首次设置和后续切换都不要手工编辑 `owner_username`。只有 WhiteLily 无法打开主人设置、配置已损坏或支持人员明确要求时，才先停止 WhiteLily、备份本机 `config.toml`，再在 `[minecraft]` 下把 `owner_username` 修复为大小写完全一致的 Minecraft Java 用户名。完成后重新打开 WhiteLily，并在可丢弃世界中验证；不要公开包含真实用户名的配置文件。

### 游戏内命令

| 命令                      | 作用                                 |
| ------------------------- | ------------------------------------ |
| `!mode friend`            | 切换到陪伴聊天优先、行动前确认的模式 |
| `!mode balanced`          | 切换到可观察并提出有限行动建议的模式 |
| `!mode autonomous`        | 在已配置的有界活动内自主执行         |
| `!pause` / `!resume`      | 暂停或恢复伙伴运行                   |
| `!stop`                   | 立即取消当前任务和动作               |
| `!status`                 | 显示当前状态                         |
| `!allow <确认编号>`       | 批准与当前任务绑定的待确认动作       |
| `!deny <确认编号>`        | 拒绝与当前任务绑定的待确认动作       |
| `!memory show`            | 查看本地伙伴记忆                     |
| `!memory search <关键词>` | 搜索本地伙伴记忆                     |
| `!memory forget <编号>`   | 删除一条本地伙伴记忆                 |
| `!memory clear`           | 清除本地伙伴记忆                     |

只有 `owner_username` 完全匹配的玩家能够使用管理命令。

### 安全与隐私边界

- 每个任务的不可提高硬上限是：64 次工具调用、256 次方块变更、1,024 格水平移动、10 分钟和 8 次危险操作。
- TNT、熔岩和破坏性火焰始终拒绝；出生点保护范围内的方块变更和对受保护目标的攻击也会拒绝。达到动作阈值或需要承担后果的操作必须由主人确认。
- `!stop`、断线、世界变化、模型不可用和进程退出都会撤销当前任务权限并取消后续动作。
- 请勿直接在重要存档、重要建筑或正式多人服务器中测试。每次更新后先完成 [Windows 冒烟测试清单](docs/windows-smoke-test.md)。
- `config.toml`、`data/` 和 `logs/` 保留在本机并被 Git 忽略。不要提交认证文件、API 密钥、启动器凭据、世界存档或个人路径。
- 首次设置的浏览器存储键 `whitelily.onboarding.v1` 只保存界面恢复提示、语言和模型偏好，不保存主人用户名；普通日志和诊断包也不得包含主人用户名原文。
- WhiteLily 不控制或修改 PCL2，不扫描其他电脑，也不连接 `127.0.0.1` 以外的地址。
- 目前没有 API 密钥回退；`allow_api_key_fallback` 必须保持为 `false`。

### 开发与验证

```powershell
npm ci
npx prettier --check README.md
npm run typecheck
npm test
npm run build
.\scripts\release-check.ps1 -SkipInstall
```

行为改动必须在可丢弃的 Minecraft 世界中验证。发布检查会扫描敏感文件、校验公共仓库内容，并验证 ZIP 中 README 的本地链接闭包。

### 路线图

下面四份 Electron 实施计划取代早期 Tauri/Rust/sidecar 打包方向。开发构建中的能力尚不等于已经发布，也不构成固定发布日期承诺。

| 阶段                                                                                                                                                                                            | 状态        | 范围                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------- |
| [Electron 01 桌面基础](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-electron-01-desktop-foundation.md)             | Beta 已实现 | Electron 主进程、preload、渲染器、托盘和受管运行时子进程  |
| [Electron 02 引导与连接](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-electron-02-onboarding-connection.md)        | Beta 已实现 | ChatGPT 登录、实时模型选择、只读 PCL2 发现和 LAN 确认     |
| [Electron 03 配置、记忆与安全](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-electron-03-profiles-memory-safety.md) | 开发中      | 可编辑伙伴配置、分层记忆、世界绑定、安全预设与本地诊断    |
| [Electron 04 安装包与发布](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-electron-04-installer-release.md)          | Beta 已发布 | 内置运行时的 NSIS 安装器、升级/卸载保护、校验和与发布门禁 |
| [本机 LAN Bridge](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/specs/2026-08-10-local-lan-bridge-design.md)                                   | beta.2 候选 | 官方认证 LAN 证明、当前实例组件管理与 Bridge 约束 Avatar  |

旧版 v0.1.1 CLI ZIP 没有桌面端、PCL2/LAN 检测或模型选择 UI；这些能力从 `v0.2.0-beta.1` Windows 桌面安装包开始提供。

### 文档

- [Windows 11 + PCL2 安装指南](docs/installation-windows.zh-CN.md)
- [Windows installation guide (English)](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/installation-windows.md)
- [未签名与 Windows SmartScreen 说明](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/smartscreen.zh-CN.md)
- [Unsigned build and Windows SmartScreen (English)](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/smartscreen.md)
- [Windows 冒烟测试清单](docs/windows-smoke-test.md)
- [运行时架构与停止顺序](docs/runtime-architecture.md)
- [变更记录](CHANGELOG.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

### 贡献与许可证

提交变更前请阅读[贡献指南](CONTRIBUTING.md)和[安全策略](SECURITY.md)，并运行完整验证命令。不要在公开 issue、提交或日志附件中泄露凭据、个人世界数据或本机路径。

本项目采用 [Apache License 2.0](LICENSE)；第三方与归属信息见 [NOTICE](NOTICE)。

## English

### Windows installer (v0.2.0-beta.2)

> **Release status: Public Beta candidate.** `v0.2.0-beta.2` is one Windows x64 EXE combining persistent model hot switching and Minecraft action-workspace repair. This candidate passed extraction inspection, clean Windows Sandbox installation, in-place beta.1 upgrade, workspace repair, data-preservation, uninstall, and reinstall checks. Real actions must still be accepted only in a confirmed disposable Minecraft Java 1.21.5 LAN world. The latest publicly released desktop build remains [`v0.2.0-beta.1`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/tag/v0.2.0-beta.1); beta.2 will not be published before its remaining gates pass.

After `v0.2.0-beta.2` is published, download both assets from the official [GitHub Releases](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases) page:

- [`WhiteLily-0.2.0-beta.2-windows-x64-setup.exe`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/download/v0.2.0-beta.2/WhiteLily-0.2.0-beta.2-windows-x64-setup.exe)
- [`WhiteLily-0.2.0-beta.2-windows-x64-setup.exe.sha256`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/download/v0.2.0-beta.2/WhiteLily-0.2.0-beta.2-windows-x64-setup.exe.sha256)

Verify the SHA-256 using the [Windows installation guide](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/installation-windows.md), then read the [unsigned build and SmartScreen guide](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/smartscreen.md). The first Beta is unsigned, so Windows SmartScreen may report an unknown publisher. Do not disable system protection or run a file from another source or with a mismatched hash.

The installer bundles Electron, the WhiteLily child runtime, and an exact Codex CLI, so ordinary users do not need system Node.js, npm, Git, or Codex CLI. Complete ChatGPT sign-in inside WhiteLily; there is no Platform API-key fallback. You start and operate PCL2 yourself, use it to start Minecraft Java 1.21.5, and manually open a disposable world to LAN. WhiteLily does not launch, control, click, or modify PCL2 and connects only to `127.0.0.1` on the same computer.

Beta.2 also bundles fixed-hash WhiteLily Bridge, optional Avatar, Fabric API `0.128.2+1.21.5`, GeckoLib `5.1.0`, and licenses. Setup stores only a current-user component preference and never searches or modifies PCL2/Minecraft; only the desktop app installs components into the currently verified Fabric Loader `>=0.16.14`, Minecraft `1.21.5` instance. Bridge is required for official-auth LAN and Avatar depends on Bridge. Restart Minecraft after a component write; existing worlds remain unchanged. WhiteLily never reads launcher/Microsoft/game credentials or changes global authentication, `online-mode`, the whitelist, scoreboards/teams, or world data.

### Positioning and status

WhiteLily is a local AI companion runtime for Minecraft Java Edition. It joins a Minecraft world as a Mineflayer bot and lets the configured owner interact with a locally authenticated Codex session from the normal in-game chat. It is not a Minecraft client mod and does not replace the launcher.

**Current status: Public Beta.** The latest public release is **v0.2.0-beta.1**; the current release candidate is **v0.2.0-beta.2**, with one per-user Windows x64 installer. The older [`v0.1.1`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/tag/v0.1.1) CLI ZIP remains available for developer reference, but it is not the desktop installer.

`v0.2.0-beta.2` includes the Electron control center, ChatGPT sign-in and recovery, persistent model hot switching, read-only PCL2 discovery, Minecraft LAN detection and confirmation, live owner changes, and automatically provisioned and repaired Minecraft action workspace. It should still be used only with a disposable world.

### Current runtime architecture

```text
PowerShell scripts / CLI
  └─ RuntimeFacade
      └─ WhiteLilyAppLifecycle
          ├─ CompanionService ── TaskController / TurnToolBudget
          ├─ local MCP ── constrained tool registry
          └─ local Codex app-server
              ├─ intent thread (no action tools)
              └─ execution thread dynamic minecraft_* ── same constrained tool registry
                                                          └─ ActionExecutor ── SafetyEngine
                                                                                └─ MinecraftPort
                                                                                    └─ Mineflayer
                                                                                        └─ 127.0.0.1 Minecraft LAN world
```

`RuntimeFacade` exposes the stable `start()`, `stop(reason)`, `subscribe()`, and `snapshot()` boundary. Ordinary conversation and intent classification receive no action tools; only the execution thread for a validated task receives constrained dynamic Minecraft tools. Dynamic tools and the local MCP endpoint reuse the same registry, so trusted game snapshots, task leases, budgets, safety policy, and the action executor still check every request in layers before Mineflayer is called. See [runtime architecture](docs/runtime-architecture.md) for the full dependency direction and stop order.

PCL2 always remains under user control. WhiteLily does not launch, control, click, or modify PCL2; the current release only connects to a Minecraft world that the user manually opens to LAN.

### Implemented in v0.1.1

- Identifies the configured owner in Minecraft chat and separates normal conversation from local management commands.
- Provides the existing `friend`, `balanced`, and `autonomous` modes, plus pause, resume, status, and immediate-stop commands.
- Uses constrained tools for bounded world observation, chat, movement, following, looking, jumping, digging, placing, crafting, smelting, collecting, equipping, and attacking trusted hostile entities.
- Discloses the goal, expected actions, effective limits, and stop condition before each task; at most one task can be active.
- Uses task leases, per-turn tool leases, trusted distance accounting, confirmation tickets, and invalidation fences so an old task, world, or session cannot retain action authority.
- Stores concise structured memory, state, logs, and task audit data locally; public runtime events and logs are length-bounded and redact sensitive information.
- Includes reproducible Windows setup, doctor, start, stop, release-check, and ZIP-packaging scripts.
- The v0.1.1 automated baseline contains 32 test files and 831 tests.

### Current support matrix

| Item                   | v0.1.1 support                                             |
| ---------------------- | ---------------------------------------------------------- |
| Operating system       | Windows 11 x64                                             |
| Launcher               | PCL2, started and operated by the user                     |
| Minecraft              | Java Edition 1.21.5                                        |
| Deployment             | WhiteLily, Codex, PCL2, and Minecraft on the same computer |
| Game address           | `127.0.0.1` only; cross-device deployment is not supported |
| Runtime                | Node.js 24+, npm 11+                                       |
| Model entry point      | Local Codex CLI authenticated with ChatGPT                 |
| Recommended test world | A disposable single-player world manually opened to LAN    |

Availability and limits depend on the user's ChatGPT/Codex account and current product rules. WhiteLily uses the applicable shared usage or credits of the local signed-in session, does not promise unlimited or fixed usage, and does not fall back to separately billed Platform API keys. See the official [Codex pricing](https://learn.chatgpt.com/docs/pricing.md) and [authentication documentation](https://learn.chatgpt.com/docs/auth).

### Quick start

The following workflow applies to the `v0.2.0-beta.2` desktop installer, not the older v0.1.1 CLI ZIP. Read the [complete Windows 11 + PCL2 installation guide](docs/installation-windows.zh-CN.md) first. Validate every installation and update in a disposable world.

1. Complete the installation guide, then open the WhiteLily desktop app.
2. Sign in with ChatGPT inside WhiteLily and choose a model from the live catalog.
3. On the Owner identity step, enter the **exact** Minecraft Java username, including capitalization, and confirm it.
4. Open PCL2 yourself, start Minecraft Java 1.21.5, enter a disposable single-player world, and choose Open to LAN.
5. Return to WhiteLily, review the detected local LAN session, and confirm it. You do not need to copy the port manually.
6. To change the owner later, use WhiteLily Settings → Owner identity and confirm the change without disconnecting or reconnecting the bot.

A live owner change immediately revokes the old owner's command authority and cancels any active task authorized by that owner, so pending actions do not continue. WhiteLily, the Mineflayer connection, and the local Codex service remain connected. If the new owner is offline, the UI waits for the new owner and does not restore the old owner's authority.

#### Persistent model hot switching and action workspace

`v0.2.0-beta.2` combines both capabilities in the same installer; there is no separate model or action installer.

Open **AI model**, choose a model and reasoning effort from the current ChatGPT session's live catalog, then select **Apply model**.

A successful model switch stops the active task and revokes its pending actions without disconnecting the confirmed Minecraft LAN session. WhiteLily saves and displays the new selection only after the model is ready, and keeps using it after either the child runtime or desktop app restarts. If switching fails, the previous model selection and connection remain in place so you can retry.

On every start, WhiteLily verifies and, when necessary, atomically repairs `.codex/config.toml`, `AGENTS.md`, and `workspace-manifest.json` under `%LOCALAPPDATA%\WhiteLily\codex-workspace`. Stable recovery codes are `WORKSPACE_RESOURCE_INVALID`, `WORKSPACE_DEPLOY_FAILED`, and `WORKSPACE_ROLLBACK_FAILED`. Quit and retry first, then run the same beta.2 installer as a repair install; do not download scripts manually or add an API key to the workspace.

Known Beta limits: only same-machine `127.0.0.1` Minecraft Java 1.21.5 LAN worlds are supported; model catalog, latency, and usage limits depend on the ChatGPT/Codex account; actions are limited to the current constrained tool catalog and arbitrary requests are not guaranteed. Uninstall keeps `%LOCALAPPDATA%\WhiteLily` by default and deletes that exact data root only when the user explicitly chooses **Delete WhiteLily data**.

#### Advanced troubleshooting: manual owner configuration

Do not edit `owner_username` by hand during normal first-run setup or later owner changes. Only if WhiteLily cannot open the owner settings, the configuration is damaged, or support explicitly asks you to do so, stop WhiteLily, back up the local `config.toml`, and repair `owner_username` under `[minecraft]` so it exactly matches the Minecraft Java username, including capitalization. Reopen WhiteLily and validate the repair in a disposable world. Never share a configuration file containing the real username.

### In-game commands

| Command                    | Purpose                                             |
| -------------------------- | --------------------------------------------------- |
| `!mode friend`             | Prefer companion chat and confirm before acting     |
| `!mode balanced`           | Observe and propose limited actions                 |
| `!mode autonomous`         | Act within explicitly configured bounded activities |
| `!pause` / `!resume`       | Pause or resume the companion                       |
| `!stop`                    | Immediately cancel the current task and actions     |
| `!status`                  | Show current status                                 |
| `!allow <confirmation-id>` | Approve a pending action bound to the current task  |
| `!deny <confirmation-id>`  | Deny a pending action bound to the current task     |
| `!memory show`             | Show local companion memory                         |
| `!memory search <words>`   | Search local companion memory                       |
| `!memory forget <id>`      | Remove one local companion memory                   |
| `!memory clear`            | Clear local companion memory                        |

Only the player whose name exactly matches `owner_username` can use management commands.

### Safety and privacy boundaries

- Immutable per-task hard caps are 64 tool calls, 256 block changes, 1,024 blocks of horizontal travel, 10 minutes, and 8 dangerous operations.
- TNT, lava, and destructive fire are always denied. Block changes inside spawn protection and attacks on protected targets are also denied. Threshold-crossing or consequential actions require owner confirmation.
- `!stop`, disconnect, world change, model unavailability, and process exit revoke current task authority and cancel later actions.
- Do not begin in a valuable save, near important builds, or on a production multiplayer server. Complete the [Windows smoke-test checklist](docs/windows-smoke-test.md) after every update.
- `config.toml`, `data/`, and `logs/` remain local and are ignored by Git. Never commit authentication files, API keys, launcher credentials, world saves, or personal paths.
- The first-run browser storage key `whitelily.onboarding.v1` stores only UI resume hints, locale, and model preference—not the owner username. Normal logs and diagnostic bundles must not contain the owner username in plaintext either.
- WhiteLily does not control or modify PCL2, scan other computers, or connect to an address other than `127.0.0.1`.
- There is currently no API-key fallback; `allow_api_key_fallback` must remain `false`.

### Development and verification

```powershell
npm ci
npx prettier --check README.md
npm run typecheck
npm test
npm run build
.\scripts\release-check.ps1 -SkipInstall
```

Validate behavior changes in a disposable Minecraft world. The release check scans for sensitive files, validates the public repository payload, and verifies local-link closure for the READMEs inside the ZIP.

### Roadmap

These four Electron implementation plans replace the earlier Tauri/Rust/sidecar packaging direction. A capability in a development build is not a published release and does not promise a fixed delivery date.

| Stage                                                                                                                                                                                                       | Status              | Scope                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| [Electron 01 Desktop foundation](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-electron-01-desktop-foundation.md)               | Implemented in Beta | Electron main process, preload, renderer, tray, and managed runtime child                        |
| [Electron 02 Onboarding and connection](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-electron-02-onboarding-connection.md)     | Implemented in Beta | ChatGPT sign-in, live model selection, read-only PCL2 discovery, and LAN confirmation            |
| [Electron 03 Profiles, memory, and safety](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-electron-03-profiles-memory-safety.md) | In development      | Editable companion profiles, scoped memory, world binding, safety presets, and local diagnostics |
| [Electron 04 Installer and release](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-electron-04-installer-release.md)             | Published in Beta   | Bundled-runtime NSIS installer, upgrade/uninstall protection, checksums, and release gates       |
| [Local LAN Bridge](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/specs/2026-08-10-local-lan-bridge-design.md)                                              | beta.2 candidate    | Official-auth LAN proof, current-instance component management, and Bridge-bound Avatar identity |

The older v0.1.1 CLI ZIP has no desktop app, PCL2/LAN detection, or model-selection UI. Those capabilities are available starting with the `v0.2.0-beta.1` Windows desktop installer.

### Documentation

- [Windows 11 + PCL2 installation guide](docs/installation-windows.zh-CN.md)
- [Windows installation guide](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/installation-windows.md)
- [Unsigned build and Windows SmartScreen](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/smartscreen.md)
- [未签名与 Windows SmartScreen 说明](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/smartscreen.zh-CN.md)
- [Windows smoke-test checklist](docs/windows-smoke-test.md)
- [Runtime architecture and stop order](docs/runtime-architecture.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)

### Contributing and license

Read the [contributing guide](CONTRIBUTING.md) and [security policy](SECURITY.md), then run the complete verification commands before proposing a change. Do not expose credentials, personal world data, or local paths in public issues, commits, or attached logs.

This project is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for third-party and attribution information.
