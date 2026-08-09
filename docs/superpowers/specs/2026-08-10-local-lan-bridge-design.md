# WhiteLily 本地 LAN Bridge 设计

**状态：** 已确认。用户已经授权自主选择后续方案，并已明确接受“可安装 Mod、在 WhiteLily 面板中为目标 PCL2 实例添加 Mod、与桌面程序放在同一个安装包且可勾选”的方向。本设计据此选择安全的本地 Fabric Bridge；不再要求用户提供第二个 Minecraft 账号，也不降低其他连接的正版验证。

## 1. 背景与目标

Minecraft Java 1.21.5 由正版 PCL2 会话开放 LAN 时，集成服仍会验证登录身份。WhiteLily 当前使用 Mineflayer 的离线身份 `WhiteLily`，真实验收会收到登录拒绝，因此机器人无法加入。关闭全局验证、复用主人的 access token 或要求每位用户准备第二个正版账号都不适合通用项目。

本子项目需要同时满足：

- 让同一台 Windows 电脑上的 WhiteLily 加入用户明确确认的 Minecraft Java 1.21.5 集成服；
- 只放行这一条连接，不改变其他玩家、其他服务器或远程 LAN 连接的认证行为；
- 不读取、复制、存储或转发 PCL2/Microsoft/Minecraft 账号凭据；
- 只支持 Fabric Loader，第一版精确支持 Minecraft 1.21.5；
- 在 WhiteLily 内为已验证的 PCL2 实例安装、更新或移除组件，不接受 renderer 提供的任意路径；
- 功能 Bridge 与可选的 WhiteLily Avatar 外观组件一起进入同一个 Windows 安装包；
- 对缺少 Bridge、需要重启、版本不兼容和文件冲突给出稳定、安全的错误，不再无限停留在“启动中”。

## 2. 方案比较

### 方案 A：本地 Fabric Bridge（采用）

WhiteLily 为每次 Mineflayer 连接生成短时一次性证明，并通过 Minecraft 握手的 hostname 字段发送。Fabric Bridge 只在当前进程确实运行集成服、来源地址为 loopback、端口匹配、用户名精确为 `WhiteLily`、证明有效且成功原子消费时，跳过这一条连接的在线验证并创建固定的离线 GameProfile。所有其他连接继续执行原版认证。

优点是无需额外账号、不暴露主人的令牌、能够精确限制授权范围；代价是目标实例必须使用 Fabric Loader，并在安装或更新组件后重启游戏。

### 方案 B：第二个正版 Minecraft 账号（不采用）

技术上可让 Mineflayer 用独立账号在线登录，但会增加购买、登录、凭据管理、封禁和额度问题，不能让项目对其他 PCL2 用户开箱可用。

### 方案 C：关闭正版验证或复用主人令牌（拒绝）

关闭验证会改变整个 LAN 服务器的安全边界；复用主人令牌可能形成重复 UUID、踢掉主人，并把 PCL2 凭据带入 WhiteLily。两者均不允许实现。

## 3. 组件边界

### 3.1 `whitelily-bridge-fabric`

新增独立 Fabric 子模块，`environment` 为 `client`，因为它只服务 Minecraft 客户端进程内的集成服务器。它只依赖 Minecraft 1.21.5 与 Fabric Loader，不依赖 Fabric API 或 GeckoLib。

模块包含四个小边界：

1. `BridgePresencePublisher`：客户端启动后写入有界 presence 记录，绑定当前 Java PID、进程启动时间、Minecraft 版本和 Bridge 版本；退出时尽力删除。记录没有凭据或玩家身份。
2. `BridgeProofStore`：用稳定文件句柄读取一次性请求，拒绝链接、重解析点、超限、过期、端口不符或格式异常的记录，并通过同目录原子移动确保只有一个登录线程能消费。
3. `HandshakeProofMixin`：读取 `ClientIntentionPacket.hostName()` 中的固定格式证明，只在远端地址为 loopback 时把候选证明附加到该 `Connection`；不修改普通 hostname 的处理。
4. `LoginAuthorizationMixin`：在 `ServerLoginPacketListenerImpl` 的 hello 边界重新检查集成服、loopback、当前发布端口、精确用户名和已消费证明。通过时仅为该 listener 调用原版后续登录流程；失败时完全回落到原版在线认证。

Bridge 不修改 `online-mode`，不写白名单，不写 scoreboard/team，不修改世界存档，也不接受远程 IP。

### 3.2 Node 侧 `BridgeProofIssuer`

WhiteLily core 在每次实际 Mineflayer 尝试前生成 256-bit 随机 nonce，在 `%LOCALAPPDATA%\WhiteLily\bridge\requests` 下原子写入独立请求文件。文件名只使用 `SHA-256(nonce)` 的小写十六进制值，不扫描目录或把 nonce 当路径。记录包含固定 schema、精确目标端口、`WhiteLily`、创建与到期时间、nonce；TTL 不超过 30 秒。

Mineflayer 的 `fakeHost` 使用固定、有界格式：

`127.0.0.1\0WL1\0<base64url nonce>`

总长度远低于协议上限。nonce、请求文件内容和路径不进入日志、诊断导出、任务审计或公开错误。连接成功、失败、取消或超时后，issuer 只按自己创建的精确文件名清理；重试必须生成新 nonce，不复用已消费证明。

### 3.3 `MinecraftComponentManager`

Electron main 持有安装权限。它从尚未消费的 opaque LAN candidate ID 重新读取同一真实 Java 进程，并复用 `WorldBindingAuthority` 的进程身份与 `--gameDir` 解析规则得到目标实例根。candidate 必须在操作前后都通过 PID、进程启动时间、监听端口、Minecraft 版本、可执行文件和完整命令行复核；检查或安装组件不会消费 LAN 确认权。renderer 只能使用不透明 candidate ID 和枚举选项，不能提交路径、进程、下载地址、脚本或文件名。

管理器只允许：

- Minecraft `1.21.5`；
- 命令行与版本元数据证明使用 Fabric Loader；
- `mods` 位于已验证 gameDir 的直接子目录；
- gameDir、`mods` 及目标文件均为普通、非 link、非 reparse 对象；
- 固定文件名和打包 manifest 中声明的固定字节数/SHA-256；
- 原子临时文件 + fsync + rename；
- 只更新或删除能从 JAR 内 `fabric.mod.json` 证明属于 WhiteLily 的文件。

未知同名文件、链接、路径逃逸、运行时 manifest 不匹配、非 Fabric 实例或不支持版本全部 fail closed。安装后如果 JAR 的 mtime 晚于当前 Java 进程启动时间，状态为 `restart_required`，WhiteLily 不替用户关闭或重启 PCL2/Minecraft。

### 3.4 Avatar 可选组件

现有 `whitelily-avatar` 保持独立视觉职责。安装“白百合外观”时，组件管理器同时部署固定版本的 Avatar、Fabric API 和 GeckoLib；安装 Bridge 时不强制安装视觉依赖。

Bridge 在内存中维护本次证明成功登录的 Profile UUID；Avatar 通过只读 Bridge API 判断该玩家是否是当前集成服已批准的 WhiteLily。这样不需要向世界写 scoreboard/team，也不会仅凭远程玩家名称替换外观。服务器停止或玩家退出后，批准记录立即撤销。

## 4. 用户流程

1. Windows 安装器显示“启用 Minecraft Bridge 支持”选项，默认勾选。它只控制 WhiteLily 是否启用实例组件管理，不会在尚未识别实例时扫描或修改 Minecraft。
2. 用户照常用 PCL2 启动 Minecraft 1.21.5 并开放 LAN。
3. WhiteLily 自动检测并显示精确候选。若当前 Java 进程没有有效 Bridge presence，LAN 卡片显示“此 Fabric 实例需要 WhiteLily Bridge”。
4. 用户在同一卡片或设置页勾选：
   - `WhiteLily Bridge`（功能必需，默认勾选）；
   - `白百合外观`（可选，默认勾选；包含固定 Fabric API/GeckoLib 依赖）。
5. 用户点击“安装到此 PCL2 实例”。WhiteLily 只修改已验证 gameDir 的 `mods`；成功后明确要求用户自行重启游戏。
6. 重启并重新开放 LAN 后，presence 必须精确匹配当前 Java 进程。用户仍需显式确认候选；WhiteLily 不自动确认或加入。
7. 显式确认后，每次连接尝试使用新的短时证明。Bridge 只授权该次本机连接。

候选确认处理器在向 desktop child 下发连接 authority 之前，必须再次验证当前 candidate 对应的 Bridge presence。缺少或过期 presence 时直接返回稳定组件状态，不进入 `start_runtime`。

设置页始终可以查看组件状态、更新或移除 WhiteLily 自己管理的文件。移除 Bridge 只影响下一次游戏启动；不在 Minecraft 运行时声称已经卸载生效。

## 5. 状态与错误

公开状态采用固定枚举，不包含路径、端口、nonce、PID 或原始 Mineflayer/Java 错误：

- `bridge_not_installed`
- `bridge_restart_required`
- `bridge_not_active`
- `bridge_version_unsupported`
- `bridge_file_conflict`
- `bridge_install_failed`
- `bridge_proof_rejected`
- `avatar_not_installed`
- `avatar_restart_required`
- `ready`

Bridge 缺失或未加载时，WhiteLily 在启动 Mineflayer 前停止；握手证明被拒绝时，连接层执行物理 transport fence 并返回稳定错误。任何路径都不能无限保持 `starting`。子进程换代时，main 会发布一次权威失效事件，renderer 清除旧“运行中”状态，不重放上代 runtime。

## 6. 打包与安装包

构建链产出并固定校验：

- `whitelily-bridge-fabric-1.21.5-<version>.jar`
- `whitelily-avatar-fabric-1.21.5-<version>.jar`
- 允许再分发的固定 Fabric API 与 GeckoLib JAR
- 各组件许可证与 NOTICE

这些文件进入 Electron `extraResources/minecraft-components` 和 runtime manifest 的精确 allowlist；build/inspect 必须重哈每个文件。NSIS 选项写入当前用户的 WhiteLily 组件偏好，不获取管理员权限，也不在安装器阶段猜测 PCL2/gameDir。

Windows Sandbox 生命周期继续验证清洁安装、beta.1 升级、保留/删除数据、重装与卸载零残留，并新增组件资源字节与卸载结果检查；Sandbox 不运行 Minecraft。真实 Fabric/游戏行为由可丢弃世界人工门禁验证。

## 7. 测试策略

### 7.1 自动化

- Java 纯单元测试：证明格式、TTL、端口、loopback、用户名、原子单次消费、并发消费、链接/重解析点、超限 JSON、UTF-8 与清理。
- Mixin 边界测试：只有完整条件矩阵通过时才选择 per-listener offline profile；其他条件严格走原版分支。
- Node 测试：每次重试新 nonce、fakeHost 精确格式、失败清理、raw secret 不出日志/诊断、停止/超时无残留。
- 组件管理器：真实临时目录安装/更新/移除、未知冲突、链接、路径逃逸、非 Fabric、进程身份变化、restart-required、renderer 不可控路径。
- UI：缺失→安装→要求重启→presence ready；Bridge/Avatar 选择可随时调整；不会自动确认 LAN。
- 打包：JAR 与许可证进入 manifest，inspect 重哈；installerScripts 与真实 Sandbox 生命周期全绿。

### 7.2 真实验收

仅使用新建可丢弃世界，且在开始/结束时验证其他世界未变：

1. 对当前 PCL2 Fabric 1.21.5 实例安装 Bridge 与 Avatar，重启 Minecraft；
2. 开放 LAN，验证自动发现、无手刷、无自动确认；
3. 显式确认后验证机器人稳定加入、Bridge 只放行 WhiteLily、MCP readiness 与工具目录正常；
4. 验证普通聊天不触发动作；位置询问调用 `get_state`；“走到我身边来”实际移动；
5. TNT 等危险动作必须等待确认，未确认时世界不变；
6. Terra/Luna 在同一 Minecraft session 热切换并在重启后保持；
7. 停止任务后工具权限与 MCP authority 撤销；
8. 移除/停用证明后新连接被拒绝，而其他正版 LAN 连接行为不变；
9. 正常退出 WhiteLily、Minecraft、PCL2，复核既有世界哈希/身份未变。

## 8. 非目标与后续

本版本不支持 Forge/NeoForge、远程 LAN 主机、专用服务器、跨设备安装、自动启动/点击 PCL2、自动进入世界或自动开放 LAN。Bridge 不提供通用离线登录能力，也不成为第三方模组下载器；组件来源只允许 WhiteLily 安装包内经过 manifest 固定的资源。

未来扩展其他 Minecraft/Fabric 版本时，每个版本必须有独立编译产物、映射审查、真实登录验收和固定 hash，不能把 `1.21.5` 的 mixin 当作宽泛兼容实现。
