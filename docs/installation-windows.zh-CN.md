# Windows 11 + PCL2 安装指南

本指南适用于 WhiteLily v0.1.1、Windows 11、Plain Craft Launcher 2（PCL2）和 Minecraft Java 版 1.21.5。

白百合不是 Minecraft 客户端模组。她会在 Windows 后台运行，以 Mineflayer 机器人身份加入你开放到局域网的世界；你仍然只需在 Minecraft 聊天框中和她交流。

## 1. 安装前须知

- 第一次安装和每次更新都只在可丢弃的测试世界中尝试。
- 不要先在重要存档、重要建筑或正式多人服务器中运行。
- 首版要求 Minecraft、PCL2、Codex 和白百合运行在同一台电脑上。
- `minecraft.host` 必须保持为 `127.0.0.1`。
- 白百合使用本机 `codex login` 的 ChatGPT/Codex 登录状态和适用额度。
- 保持 `allow_api_key_fallback = false`，避免意外切换到单独计费的 Platform API。

## 2. 准备软件

请先准备：

1. Windows 11 64 位。
2. PCL2。
3. Minecraft Java 版 1.21.5。
4. Node.js 24。
5. Codex CLI，并能在 PowerShell 中运行 `codex login`。

打开一个新的 PowerShell 窗口，检查 Node.js：

```powershell
node --version
npm --version
```

`node --version` 应显示 `v24` 开头的版本。然后登录 Codex：

```powershell
codex login
```

按浏览器提示用 ChatGPT 账户完成登录。白百合不需要也不应要求你把 API 密钥写入配置文件。

## 3. 下载并校验

推荐从 GitHub Releases 下载：

- `whitelily-0.1.1-windows-x64.zip`
- `whitelily-0.1.1-windows-x64.zip.sha256`

两个文件放在同一目录后，在该目录打开 PowerShell，计算 ZIP 的 SHA-256：

```powershell
(Get-FileHash -Algorithm SHA256 .\whitelily-0.1.1-windows-x64.zip).Hash.ToLowerInvariant()
Get-Content .\whitelily-0.1.1-windows-x64.zip.sha256
```

两处显示的 64 位十六进制哈希必须一致。如果不一致，不要运行压缩包中的脚本，请重新下载。

## 4. 解压

建议解压到不受系统保护、也不被网盘自动同步的目录，例如：

```text
C:\Games\WhiteLily
```

不要直接在 ZIP 压缩包预览窗口中运行脚本。

进入解压后的 WhiteLily 目录，在文件资源管理器地址栏输入 `powershell` 并回车，或右键选择“在终端中打开”。

## 5. 执行安装脚本

在 WhiteLily 目录运行：

```powershell
.\scripts\setup.ps1
```

如果 Windows 只在当前窗口阻止脚本执行，可先运行：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\setup.ps1
```

`-Scope Process` 只影响当前 PowerShell 窗口，关闭窗口后失效。

## 6. 创建配置

复制示例配置：

```powershell
Copy-Item .\config.example.toml .\config.toml
notepad .\config.toml
```

首次使用建议只修改下面两项：

```toml
[minecraft]
host = "127.0.0.1"
port = 25565
bot_username = "WhiteLily"
owner_username = "你的Minecraft游戏名"
```

- `owner_username` 必须与游戏内用户名完全一致，包括大小写。
- `port` 稍后改成 Minecraft 开放到局域网后显示的端口。
- `bot_username` 是机器人加入世界时显示的名称。

保留这些安全默认值：

```toml
[codex]
preferred_model = "gpt-5.6-terra"
reasoning_effort = "low"
allow_api_key_fallback = false

[companion]
start_mode = "friend"
persona_name = "白百合"
```

`config.toml` 包含你的本机设置，已被 Git 忽略；不要把它上传到公开仓库。

## 7. 用 PCL2 开放测试世界

1. 用 PCL2 启动 Minecraft Java 版 1.21.5。
2. 新建一个可以随时删除的测试世界。
3. 进入世界后按 `Esc`。
4. 选择“对局域网开放”。
5. 确认开放后，Minecraft 聊天区会显示本地游戏端口，例如 `52143`。
6. 把这个数字写入 `config.toml` 的 `minecraft.port`：

```toml
port = 52143
```

每次重新开放局域网时端口都可能变化。连接失败时，先检查这里。

如果 Windows 防火墙询问是否允许 Java，请只按你的实际网络环境授权；家庭网络通常只需“专用网络”，不必开放到公共网络。

## 8. 运行检查

保持 Minecraft 世界已经开放到局域网，然后在 WhiteLily 目录运行：

```powershell
.\scripts\doctor.ps1
```

重点检查：

- Node.js 版本正确。
- Codex 已登录。
- `config.toml` 存在且格式正确。
- 目标地址为 `127.0.0.1`。
- Minecraft 局域网端口可连接。
- 未启用 API 密钥回退。

如果 doctor 报错，先按错误提示修复，不要跳过。

## 9. 启动、聊天和停止

启动：

```powershell
.\scripts\start.ps1
```

机器人加入世界后，直接在 Minecraft 聊天框中说话即可，不需要给“白百合”加前缀。

常用命令：

```text
!status
!mode friend
!mode balanced
!mode autonomous
!pause
!resume
!stop
```

三种模式：

- `friend`：陪伴聊天为主，行动前确认。
- `balanced`：可以观察并提出有限行动建议。
- `autonomous`：只在明确配置的安全边界内自行执行。

任何时候都可以切换模式。永久拒绝规则始终优先，`!stop` 会立即取消当前行为。

在 Windows 中彻底停止后台服务：

```powershell
.\scripts\stop.ps1
```

不要只关闭 Minecraft 就认为后台已经停止。

## 10. 首次安装成功检查

满足以下条件后，才算首次安装基本成功：

1. `doctor.ps1` 没有阻止启动的错误。
2. `start.ps1` 成功运行。
3. WhiteLily 机器人出现在测试世界。
4. 你在聊天框发送普通消息后能收到回复。
5. `!status` 能显示当前状态。
6. 三种模式能够切换。
7. `!stop` 能立即停止行为。
8. `stop.ps1` 能结束后台进程。

之后再完成 [Windows 冒烟测试清单](windows-smoke-test.md)。

## 11. 常见问题

### 找不到 `node` 或版本不是 24

安装 Node.js 24 后关闭所有 PowerShell 窗口，再打开一个新窗口检查 `node --version`。

### 找不到 `codex` 或尚未登录

确认 Codex CLI 已安装并能从 PowerShell 启动，然后运行：

```powershell
codex login
.\scripts\doctor.ps1
```

### 机器人无法加入世界

依次检查：

1. Minecraft 是否仍在运行。
2. 世界是否已经“对局域网开放”。
3. `config.toml` 中的端口是否是本次开放后显示的新端口。
4. Minecraft 版本是否为 1.21.5。
5. `host` 是否仍是 `127.0.0.1`。
6. `bot_username` 是否与世界中已有玩家重名。

### 玩家消息没有触发回复

检查 `owner_username` 是否与游戏内用户名完全一致，然后运行 `!status`。如果服务已暂停，运行 `!resume`。

### Codex 额度暂停

等待账户的适用 ChatGPT/Codex 用量恢复，或降低使用频率。白百合不会自动切换到 Platform API 计费。

### 查看本地日志

运行期间的本地日志保存在安装目录下的 `logs\`。分享日志前先检查并删除不希望公开的信息。

## 12. 更新与卸载

更新前：

```powershell
.\scripts\stop.ps1
```

保留自己的 `config.toml`，替换其他程序文件，然后重新运行：

```powershell
.\scripts\setup.ps1
.\scripts\doctor.ps1
```

每次更新后都先在可丢弃世界中重新测试。

卸载时先运行 `stop.ps1`，再删除 WhiteLily 安装目录。`data\`、`logs\` 和 `config.toml` 都只保存在本机；若不需要保留记忆或设置，可以一并删除。
