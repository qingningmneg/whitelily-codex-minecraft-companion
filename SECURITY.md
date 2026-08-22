# Security policy

## 中文

不要在公开 issue 中发布凭据、ChatGPT/Codex 认证文件、API 密钥、PCL2 账户信息、Minecraft 存档、主人用户名、个人路径或可被利用的细节。公开的安装包哈希、签名状态和版本号不是秘密，但本机 `%LOCALAPPDATA%\WhiteLily` 数据不应作为附件上传。

在仓库配置公开的私密报告渠道后，请通过该渠道联系维护者。在此之前，请避免分享敏感细节，只创建一个不含复现秘密的最小 issue，请求私下沟通方式。发送日志或诊断包前必须人工检查并脱敏。

未签名的 `v0.2.0-beta.1` 安装包已在官方 GitHub Release 公开发布；`v0.2.0-beta.2` 仍是未发布的发布候选。只从官方 GitHub Release 下载 EXE 和 `.sha256`，验证 SHA-256 后再按 [SmartScreen 说明](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/smartscreen.zh-CN.md)操作。不要关闭系统安全保护，也不要运行来源不明或哈希不匹配的安装包。

WhiteLily 只连接同一台电脑上的 `127.0.0.1` Minecraft Java 1.21.5 LAN 会话。PCL2 由用户自行启动和操作；WhiteLily 不会启动、控制、点击或修改 PCL2。应用使用 ChatGPT 登录，不提供 Platform API 密钥回退。未来桌面安装包不要求系统 Node.js、npm、Git 或 Codex CLI。

官方认证 LAN 依赖 WhiteLily Bridge 的每次连接证明；它不是对已被攻陷的本机 Windows 账户的防御。Avatar 只在 Bridge 批准当前世界会话中的精确玩家身份后渲染。安装器仅携带经过固定哈希审核的 Fabric 1.21.5 组件并写入 WhiteLily 自己的按用户偏好；只有桌面应用在用户确认的当前实例中部署组件。任何流程都不得读取 PCL2/Microsoft/Minecraft 凭据，或更改全局认证、`online-mode`、白名单、计分板/队伍和世界数据。

## English

Do not publish credentials, ChatGPT/Codex authentication files, API keys, PCL2 account information, Minecraft saves, owner usernames, personal paths, or exploitable details in a public issue. Published installer hashes, signing status, and version numbers are not secret, but local `%LOCALAPPDATA%\WhiteLily` data must never be attached to a report.

Once a private public reporting channel is configured for the repository, contact the maintainers through that channel. Until then, avoid sharing sensitive details and open only a minimal issue requesting a private reporting path. Manually inspect and redact logs or diagnostic bundles before sending them.

The unsigned `v0.2.0-beta.1` installer is publicly available from the official GitHub Release. `v0.2.0-beta.2` remains an unpublished release candidate. Download the EXE and `.sha256` only from the official GitHub Release, verify SHA-256, then follow the [SmartScreen guide](https://github.com/qingningmneg/whitelily-codex-minecraft-companion/blob/main/docs/smartscreen.md). Do not disable system protection or run an installer from an unknown source or with a mismatched hash.

WhiteLily connects only to a same-machine `127.0.0.1` Minecraft Java Edition 1.21.5 LAN session. PCL2 remains under your control: you start and operate PCL2, and WhiteLily does not launch, control, click, or modify it. The app uses ChatGPT sign-in and has no Platform API-key fallback. The future desktop installer requires no system Node.js, npm, Git, or Codex CLI.

Official-auth LAN depends on a fresh per-attempt WhiteLily Bridge proof; this is not a defense against a compromised local Windows account. Avatar renders only after Bridge approves the exact player identity for the current world session. Setup carries only fixed-hash reviewed Fabric 1.21.5 components and writes a per-user WhiteLily preference; only the desktop app deploys components to the current user-confirmed instance. No flow may read PCL2/Microsoft/Minecraft credentials or alter global authentication, `online-mode`, the whitelist, scoreboards/teams, or world data.
