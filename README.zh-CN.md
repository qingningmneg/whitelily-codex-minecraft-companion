# 白百合 Codex 我的世界伙伴

白百合是运行在 Windows 本机上的 Minecraft Java 版伙伴：它以 Mineflayer 机器人加入本地或局域网世界，你平时只需在 Minecraft 聊天框中和她交流；Codex 在后台本机运行。它不是客户端模组，也不替代 PCL2。

## 首个版本支持范围

- Windows 11
- Plain Craft Launcher 2（PCL2）
- Minecraft Java 版 1.21.5
- 先在可丢弃的本地或局域网测试世界中使用

请勿直接在珍贵存档中启动。每次更新后，先完成可丢弃世界的测试，再让白百合接触重要建筑、背包或多人玩家。

## 登录与额度边界

请在本机执行 `codex login` 并用 ChatGPT 登录。白百合刻意使用这个本地已登录的 Codex 会话，因此会消耗你的适用 ChatGPT/Codex 共享用量或额度。Platform API 密钥是单独计费的路径，白百合**不会**回退到 API 密钥。具体可用性和额度取决于你的账户与当前规则，不承诺无限或固定额度。参见官方 [Codex 定价](https://learn.chatgpt.com/docs/pricing.md) 与[认证说明](https://learn.chatgpt.com/docs/auth)。

## 安装、配置与运行

请优先阅读可直接照着操作的 [Windows 11 + PCL2 完整安装指南](docs/installation-windows.zh-CN.md)。

1. 安装 Node.js 24 和 Codex CLI，然后运行 `codex login`。
2. 克隆或解压本项目，在 PowerShell 中执行 `./scripts/setup.ps1`。
3. 将 `config.example.toml` 复制为 `config.toml`，填写 `minecraft.host`、`minecraft.port` 与 `owner_username`；保持 `allow_api_key_fallback = false`。
4. 在运行白百合的同一台 Windows 电脑上，用 PCL2 启动 Java 1.21.5，并将目标世界开放到局域网。首版只通过 `127.0.0.1` 连接，不支持跨电脑部署。
5. 运行 `./scripts/doctor.ps1`，再运行 `./scripts/start.ps1`；用 `./scripts/stop.ps1` 停止。

更新时，先停止白百合，替换或更新文件，重新执行 setup 与 doctor，并再次完成可丢弃世界测试。卸载时停止服务，删除整个安装目录及本地 `data/`、`logs/`；只有明确需要保留设置时才留存 `config.toml`。

真实游玩前请完成 [Windows 烟雾测试清单](docs/windows-smoke-test.md)。

架构：[运行时边界](docs/runtime-architecture.md)。

## 聊天命令与三种模式

在 Minecraft 聊天框正常说话即可。主人命令包括：`!mode friend`、`!mode balanced`、`!mode autonomous`、`!pause`、`!resume`、`!stop`、`!status`、`!allow <确认编号>`、`!deny <确认编号>`、`!memory show`、`!memory clear`、`!memory search <关键词>` 和 `!memory forget <编号>`。

- friend：以陪伴聊天为主，行动前确认。
- balanced：可观察并提出有限行动建议。
- autonomous：在明确配置的边界内自行执行；永久拒绝规则仍始终优先。

白百合不会执行永久拒绝的操作；重大操作或达到预算阈值时会请求确认。`!stop` 会立即取消当前行为。

## 记忆、隐私与安全

记忆、日志和崩溃状态均保留在本机的忽略目录中。只有有界、脱敏后的游戏上下文会发送给本地 ChatGPT 登录的 Codex 会话。`!memory clear` 会删除本地伙伴记忆。不要提交 `config.toml`、`data/`、`logs/`、认证文件、存档或启动器凭据。

## 排错

- **局域网端口不通：**确认世界已开放局域网，端口正确，并在 Windows 防火墙中允许 Java。
- **Codex 登录失败：**执行 `codex login` 后运行 `./scripts/doctor.ps1`；API 密钥登录会被设计性拒绝。
- **机器人无法连接：**检查 Minecraft 版本、主机、端口、机器人名和服务器是否允许机器人加入。
- **额度暂停：**等待账户适用的 ChatGPT/Codex 用量重置或降低使用频率；白百合不会改用 Platform API 计费。

报告漏洞前请阅读 [SECURITY.md](SECURITY.md)，参与开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
