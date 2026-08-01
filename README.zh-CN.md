# WhiteLily Codex 我的世界伙伴

默认 [README.md](README.md) 已经中文在前，请阅读[中文部分](README.md#中文)。

## 下一版本 Windows 安装包

> `v0.2.0-beta.1` 安装包正在本分支构建与验证，尚未发布，也尚未完成隔离安装、升级和卸载验收。

通过验收并发布后，请只从官方 [GitHub Releases](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases) 下载 [`WhiteLily-0.2.0-beta.1-windows-x64-setup.exe`](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases/download/v0.2.0-beta.1/WhiteLily-0.2.0-beta.1-windows-x64-setup.exe) 和对应的 `.sha256` 文件。先核对 SHA-256，再按[未签名与 SmartScreen 说明](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/smartscreen.zh-CN.md)处理“未知发布者”提示。首个 Beta 是未签名构建。

安装包计划内置 Electron、WhiteLily 运行时和 Codex CLI，不需要系统 Node.js、npm、Git 或 Codex CLI。首次打开后使用 ChatGPT 登录；不提供 Platform API 密钥回退。用户自行启动和操作 PCL2，并手动用 PCL2 启动 Minecraft Java 1.21.5、开放可丢弃世界到 LAN。WhiteLily 不会启动、控制、点击或修改 PCL2。

当前版本仅支持同一台电脑上的 `127.0.0.1` 连接，不支持跨电脑部署。升级会保留本机设置、配置、记忆和数据；卸载时可选“保留 WhiteLily 数据（默认）”或“删除 WhiteLily 数据”。完整步骤见[中文 Windows 安装指南](docs/installation-windows.zh-CN.md)。

已发布的 `v0.1.1` ZIP 是需要开发工具的旧版开发者 CLI 预览，不是桌面安装包。

For English, see the [English section](README.md#english).
