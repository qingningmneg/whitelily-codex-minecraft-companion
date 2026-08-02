# 未签名安装包与 Windows SmartScreen

[English](smartscreen.md)

> `WhiteLily-0.2.0-beta.1-windows-x64-setup.exe` 已作为未签名 Public Beta 预发布。本文说明如何安全处理它的未签名提示。

## 为什么会出现警告

首个 WhiteLily 桌面 Beta 以**未签名** EXE 发布，没有 Authenticode 代码签名证书。Windows SmartScreen 因此可能显示“Windows 已保护你的电脑”或“未知发布者”。未签名是公开的发布限制，不应被描述为已签名或已建立信誉。

SmartScreen 警告不证明文件有害，也不证明文件安全。确认文件的依据是：只从官方 Release 获取，并且本机计算的 SHA-256 与同一 Release 的 `.sha256` 完全一致。

## 安全处理步骤

1. 确认下载页面位于官方仓库的 [GitHub Releases](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/releases)。
2. 同时下载 `WhiteLily-0.2.0-beta.1-windows-x64-setup.exe` 和对应的 `.sha256`。
3. 按[中文安装指南](installation-windows.zh-CN.md#3-安装前验证-sha-256)在 PowerShell 中验证 SHA-256。
4. 只有来源与哈希都正确时，才打开 EXE。
5. SmartScreen 出现后，核对文件名，选择“更多信息”，再选择“仍要运行”。

不要：

- 关闭 SmartScreen、Windows Defender 或其他全局安全保护。
- 忽略 SHA-256 不一致。
- 运行聊天附件、网盘、第三方镜像或源码目录中的同名 EXE。
- 因为曾经验证过旧版本，就跳过新版本的哈希验证。

任何一步无法确认时都停止安装，删除文件，并等待官方 Release 或重新下载。

## 当前限制

- 安装包未签名，发布者可能显示为未知。
- 第一个 Beta 不支持跨电脑部署，只连接同机 `127.0.0.1`。
- Minecraft Java 1.21.5 是首个 Beta 的验收目标；其他版本不在支持范围内。
- PCL2 由用户自行启动和操作；WhiteLily 不会启动、控制、点击或修改 PCL2。
- 安装后使用 ChatGPT 登录，不提供 Platform API 密钥回退。
- 安装包不需要系统 Node.js、npm、Git 或 Codex CLI。

将来加入代码签名时，发行说明会明确写出签名状态和验证方法；在那之前，每个 Release 都必须附带 `.sha256` 和未签名状态说明。
