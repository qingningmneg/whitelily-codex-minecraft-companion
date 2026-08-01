# Security policy

## 中文

不要在公开 issue 中发布凭据、ChatGPT/Codex 认证文件、API 密钥、PCL2 账户信息、Minecraft 存档、主人用户名、个人路径或可被利用的细节。公开的安装包哈希、签名状态和版本号不是秘密，但本机 `%LOCALAPPDATA%\WhiteLily` 数据不应作为附件上传。

在仓库配置公开的私密报告渠道后，请通过该渠道联系维护者。在此之前，请避免分享敏感细节，只创建一个不含复现秘密的最小 issue，请求私下沟通方式。发送日志或诊断包前必须人工检查并脱敏。

`v0.2.0-beta.1` 安装包正在构建和验证，尚未发布。首个 Beta 计划为未签名构建；只从官方 GitHub Release 下载 EXE 和 `.sha256`，验证 SHA-256 后再按 [SmartScreen 说明](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/smartscreen.zh-CN.md)操作。不要关闭系统安全保护，也不要运行来源不明或哈希不匹配的安装包。

WhiteLily 只连接同一台电脑上的 `127.0.0.1` Minecraft Java 1.21.5 LAN 会话。PCL2 由用户自行启动和操作；WhiteLily 不会启动、控制、点击或修改 PCL2。应用使用 ChatGPT 登录，不提供 Platform API 密钥回退。未来桌面安装包不要求系统 Node.js、npm、Git 或 Codex CLI。

## English

Do not publish credentials, ChatGPT/Codex authentication files, API keys, PCL2 account information, Minecraft saves, owner usernames, personal paths, or exploitable details in a public issue. Published installer hashes, signing status, and version numbers are not secret, but local `%LOCALAPPDATA%\WhiteLily` data must never be attached to a report.

Once a private public reporting channel is configured for the repository, contact the maintainers through that channel. Until then, avoid sharing sensitive details and open only a minimal issue requesting a private reporting path. Manually inspect and redact logs or diagnostic bundles before sending them.

The `v0.2.0-beta.1` installer is being built and verified and is not yet published. The first Beta is planned as unsigned. Download the EXE and `.sha256` only from the official GitHub Release, verify SHA-256, then follow the [SmartScreen guide](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/smartscreen.md). Do not disable system protection or run an installer from an unknown source or with a mismatched hash.

WhiteLily connects only to a same-machine `127.0.0.1` Minecraft Java Edition 1.21.5 LAN session. PCL2 remains under your control: you start and operate PCL2, and WhiteLily does not launch, control, click, or modify it. The app uses ChatGPT sign-in and has no Platform API-key fallback. The future desktop installer requires no system Node.js, npm, Git, or Codex CLI.
