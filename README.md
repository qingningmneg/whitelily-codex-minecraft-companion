# WhiteLily Codex Minecraft Companion

[中文](#中文) · [English](#english)

## 中文

### 项目定位与状态

WhiteLily（白百合）是一个面向 Minecraft Java 版的本地 AI 伙伴运行时。它通过 Mineflayer 以机器人身份加入 Minecraft 世界，让主人直接在游戏聊天框中与本机已登录的 Codex 交互。它不是 Minecraft 客户端模组，也不替代启动器。

**当前状态：Public Beta / 开发中。** 最新版本是 **v0.1.1 Preview**。已发布的 [`whitelily-0.1.1-windows-x64.zip`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/tag/v0.1.1) 是供开发者和早期测试者使用的 ZIP 预览包，**不是一键安装器**。它仍要求用户自行安装 Node.js 24、Codex CLI，使用 ChatGPT 完成 `codex login`，并运行 `setup.ps1`。

v0.1.1 已完成可复用的 CLI 核心运行时、安全边界和 Windows 生命周期脚本；桌面控制中心、PCL2 自动发现、Minecraft LAN 自动检测、模型选择 UI 和原生安装器仍在路线图中，尚未交付。

### 当前运行架构

```text
PowerShell 脚本 / CLI
  └─ RuntimeFacade
      └─ WhiteLilyAppLifecycle
          ├─ CompanionService ── TaskController / TurnToolBudget
          ├─ 本机 Codex app-server
          └─ 受限 MCP 工具 ── ActionExecutor ── SafetyEngine
                                             └─ MinecraftPort
                                                 └─ Mineflayer
                                                     └─ 127.0.0.1 Minecraft LAN 世界
```

`RuntimeFacade` 提供稳定的 `start()`、`stop(reason)`、`subscribe()` 和 `snapshot()` 边界。Codex 只能通过受限 MCP 工具提出游戏操作；可信游戏快照、任务租约、预算、安全策略和动作执行器会在调用 Mineflayer 前逐层检查请求。完整依赖关系和停止顺序见[运行时架构](docs/runtime-architecture.md)。

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

请先阅读 [Windows 11 + PCL2 完整安装指南](docs/installation-windows.zh-CN.md)。首次安装和每次更新都应在可丢弃世界中验证。

1. 安装 Node.js 24、npm 11 和 Codex CLI。
2. 在 PowerShell 中运行 `codex login`，并使用 ChatGPT 登录。
3. 下载 v0.1.1 ZIP 及其 `.sha256` 文件并校验哈希，或克隆本仓库。
4. 解压后在项目目录运行设置脚本：

   ```powershell
   .\scripts\setup.ps1
   ```

5. 编辑脚本生成或保留的 `config.toml`：

   ```toml
   [minecraft]
   host = "127.0.0.1"
   port = 25565
   bot_username = "WhiteLily"
   owner_username = "你的Minecraft游戏名"

   [codex]
   allow_api_key_fallback = false
   ```

6. 用户自行打开 PCL2，启动 Minecraft Java 1.21.5，进入可丢弃的单人世界并选择“对局域网开放”。将游戏显示的本次 LAN 端口写入 `config.toml`；每次重新开放时端口都可能变化。
7. 检查、启动和停止：

   ```powershell
   .\scripts\doctor.ps1
   .\scripts\start.ps1
   .\scripts\stop.ps1
   ```

`doctor.ps1` 会检查 Windows、Node.js、npm、Codex CLI、ChatGPT 登录、配置、回环端口和本地目录。不要跳过失败项。

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

下面的计划文档描述尚未完成的 Public Beta 工作；它们不是 v0.1.1 已交付能力，也不构成固定发布日期承诺。

| 阶段                                                                                                                                                                                      | 状态          | 范围                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------- |
| [01 核心运行时](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-public-beta-01-core-runtime.md)                 | v0.1.1 已实现 | 可复用运行时、单任务控制、租约、预算、连接生命周期和安全栅栏  |
| [02 桌面壳](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-public-beta-02-desktop-shell.md)                    | 计划中        | Tauri 桌面控制中心、Sidecar 协议、托盘、原生紧急停止          |
| [03 引导与连接](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-public-beta-03-onboarding-connection.md)        | 计划中        | ChatGPT 登录流程、实时模型 UI、只读 PCL2 发现、LAN 检测与确认 |
| [04 配置、记忆与安全](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-public-beta-04-profiles-memory-safety.md) | 计划中        | 可编辑伙伴配置、分层记忆、世界绑定和安全预设                  |
| [05 打包与发布](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-public-beta-05-packaging-release.md)            | 计划中        | 双语桌面产品、诊断导出、更新提醒、兼容性矩阵和原生安装器      |

因此，当前版本没有桌面端、不会自动发现 PCL2 或 LAN 端口、没有模型选择 UI，也没有一键安装器。

### 文档

- [Windows 11 + PCL2 安装指南](docs/installation-windows.zh-CN.md)
- [Windows 冒烟测试清单](docs/windows-smoke-test.md)
- [运行时架构与停止顺序](docs/runtime-architecture.md)
- [变更记录](CHANGELOG.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

### 贡献与许可证

提交变更前请阅读[贡献指南](CONTRIBUTING.md)和[安全策略](SECURITY.md)，并运行完整验证命令。不要在公开 issue、提交或日志附件中泄露凭据、个人世界数据或本机路径。

本项目采用 [Apache License 2.0](LICENSE)；第三方与归属信息见 [NOTICE](NOTICE)。

## English

### Positioning and status

WhiteLily is a local AI companion runtime for Minecraft Java Edition. It joins a Minecraft world as a Mineflayer bot and lets the configured owner interact with a locally authenticated Codex session from the normal in-game chat. It is not a Minecraft client mod and does not replace the launcher.

**Current status: Public Beta / in development.** The latest version is **v0.1.1 Preview**. The published [`whitelily-0.1.1-windows-x64.zip`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/tag/v0.1.1) is a ZIP preview for developers and early testers, **not a one-click installer**. Users must still install Node.js 24 and the Codex CLI, complete `codex login` with ChatGPT, and run `setup.ps1`.

v0.1.1 delivers the reusable CLI core runtime, safety boundaries, and Windows lifecycle scripts. The desktop control center, automatic PCL2 discovery, automatic Minecraft LAN detection, model-selection UI, and native installer are roadmap work and have not shipped.

### Current runtime architecture

```text
PowerShell scripts / CLI
  └─ RuntimeFacade
      └─ WhiteLilyAppLifecycle
          ├─ CompanionService ── TaskController / TurnToolBudget
          ├─ local Codex app-server
          └─ constrained MCP tools ── ActionExecutor ── SafetyEngine
                                                  └─ MinecraftPort
                                                      └─ Mineflayer
                                                          └─ 127.0.0.1 Minecraft LAN world
```

`RuntimeFacade` exposes the stable `start()`, `stop(reason)`, `subscribe()`, and `snapshot()` boundary. Codex can propose game operations only through constrained MCP tools. Trusted game snapshots, task leases, budgets, safety policy, and the action executor check a request in layers before Mineflayer is called. See [runtime architecture](docs/runtime-architecture.md) for the full dependency direction and stop order.

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

Read the [complete Windows 11 + PCL2 installation guide](docs/installation-windows.zh-CN.md) first. Validate every installation and update in a disposable world.

1. Install Node.js 24, npm 11, and the Codex CLI.
2. Run `codex login` in PowerShell and sign in with ChatGPT.
3. Download the v0.1.1 ZIP and its `.sha256` file and verify the hash, or clone this repository.
4. From the extracted project directory, run:

   ```powershell
   .\scripts\setup.ps1
   ```

5. Edit the `config.toml` created or preserved by the script:

   ```toml
   [minecraft]
   host = "127.0.0.1"
   port = 25565
   bot_username = "WhiteLily"
   owner_username = "YourMinecraftName"

   [codex]
   allow_api_key_fallback = false
   ```

6. Open PCL2 yourself, start Minecraft Java 1.21.5, enter a disposable single-player world, and choose Open to LAN. Put the displayed LAN port into `config.toml`; the port can change every time the world is reopened to LAN.
7. Check, start, and stop WhiteLily:

   ```powershell
   .\scripts\doctor.ps1
   .\scripts\start.ps1
   .\scripts\stop.ps1
   ```

`doctor.ps1` checks Windows, Node.js, npm, the Codex CLI, ChatGPT login, configuration, loopback ports, and local directories. Do not bypass failures.

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

The plans below describe unfinished Public Beta work. They are not v0.1.1 capabilities and do not promise fixed delivery dates.

| Stage                                                                                                                                                                                                 | Status                | Scope                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------- |
| [01 Core runtime](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-public-beta-01-core-runtime.md)                           | Implemented in v0.1.1 | Reusable runtime, single-task control, leases, budgets, connection lifecycle, and safety fences           |
| [02 Desktop shell](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-public-beta-02-desktop-shell.md)                         | Planned               | Tauri control center, Sidecar protocol, tray, and native emergency stop                                   |
| [03 Onboarding and connection](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-public-beta-03-onboarding-connection.md)     | Planned               | ChatGPT login flow, live model UI, read-only PCL2 discovery, LAN detection, and confirmation              |
| [04 Profiles, memory, and safety](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-public-beta-04-profiles-memory-safety.md) | Planned               | Editable companion profiles, scoped memory, world binding, and safety presets                             |
| [05 Packaging and release](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/superpowers/plans/2026-07-27-whitelily-public-beta-05-packaging-release.md)             | Planned               | Bilingual desktop product, diagnostics export, update notices, compatibility matrix, and native installer |

The current release therefore has no desktop app, does not automatically discover PCL2 or LAN ports, has no model-selection UI, and has no one-click installer.

### Documentation

- [Windows 11 + PCL2 installation guide](docs/installation-windows.zh-CN.md)
- [Windows smoke-test checklist](docs/windows-smoke-test.md)
- [Runtime architecture and stop order](docs/runtime-architecture.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)

### Contributing and license

Read the [contributing guide](CONTRIBUTING.md) and [security policy](SECURITY.md), then run the complete verification commands before proposing a change. Do not expose credentials, personal world data, or local paths in public issues, commits, or attached logs.

This project is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for third-party and attribution information.
